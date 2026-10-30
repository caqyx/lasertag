// Mózg bota (PLAN §8.2, SPEC §2.5) — InputSource: sample(P, sim, out). Czysty JS, bez three.
// FSM: patrol → engage (namierzanie) → cover (osłona) → chase (pościg). Decyzje i percepcja co CONFIG.bots.thinkInterval
// (faza przesunięta per bot), sterowanie celowaniem/ruchem/ogniem w każdym kroku.
// Zero alokacji w sample(): stan w polach obiektu bota i w prealokowanych buforach; skalary pośrednie w polach (nie
// jako argumenty/wyniki double funkcji pomocniczych — V8 pakuje je w HeapNumber, gdy nie są inline'owane).
// Determinizm: losowość wyłącznie przez sim.rng.

import { CONFIG } from '../../config.js';
import { segmentClear } from '../../world/physics.js';
import { nearestNode, findPath, randomNode, smoothPath } from '../../world/nav.js';
import { isEnemy, sameTeam } from '../combat.js';
import { skillScale, stepAdapt } from './adapt.js';

export const BOT_STATE = Object.freeze({ PATROL: 'patrol', ENGAGE: 'engage', COVER: 'cover', CHASE: 'chase' });

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/**
 * @param {{ level?: 'easy'|'normal'|'hard', nav: object, adapt?: object|null }} o
 *   adapt — wspólny obiekt createAdapt(); stosowany tylko, gdy bot jest przeciwnikiem gracza (isPlayer).
 */
export function createBotBrain(o) {
  const level = o.level && CONFIG.bots.levels[o.level] ? o.level : 'normal';
  const nav = o.nav;
  const B = {
    level,
    L: CONFIG.bots.levels[level],
    nav,
    adapt: o.adapt || null,
    state: BOT_STATE.PATROL,
    target: null,           // aktualnie namierzany uczestnik
    threat: null,           // ostatni znany napastnik (osłona)
    player: null,           // gracz (dla adaptacji), wyszukiwany leniwie
    started: false,
    // czas
    lastTime: 0.5, dt: 0.5, thinkTimer: 0.5,
    // percepcja
    targetVisible: false, lastSeenTime: -1e9 + 0.5, lostTime: 0.5,
    lastKnownX: 0.5, lastKnownY: 0.5, lastKnownZ: 0.5,
    reactTimer: 0.5, chaseTimer: 0.5,
    // celowanie
    yaw: 0.5, pitch: 0.5, desYaw: 0.5, desPitch: 0.5, errYaw: 0.5, errPitch: 0.5,
    sigma: 0.5, reaction: 0.5, turn: 0.5,
    // ogień
    shotsLeft: 0, pauseTimer: 0.5, lastShots: 0,
    // ruch
    path: new Int32Array(CONFIG.bots.pathCapacity), pathLen: 0, pathIdx: 0, goal: -1,
    moving: false, strafeDir: 0, strafeTimer: 0.5, repathTimer: 0.5,
    stuckX: 0.5, stuckZ: 0.5, stuckTimer: 0.5, stuckCount: 0, jumpNow: false,
    moveWX: 0.5, moveWZ: 0.5, onRamp: false,
    // osłona
    coverHold: 0.5, coverCooldown: 0.5, coverNode: -1,
    // patrol: odwiedzone węzły
    visited: new Uint8Array(nav ? nav.count : 0), visitedCount: 0,
    rng: null, resampleAim: false, needErr: false, pauseNeeded: false,
    sample: null,
  };
  resetBrain(B);
  B.sample = function sample(P, sim, out) { sampleBot(B, P, sim, out); };
  return B;
}

function resetBrain(B) {
  B.state = BOT_STATE.PATROL;
  B.target = null;
  B.threat = null;
  B.targetVisible = false;
  B.lastSeenTime = -1e9;
  B.lostTime = 0;
  B.reactTimer = 0;
  B.chaseTimer = 0;
  B.errYaw = 0; B.errPitch = 0;
  B.shotsLeft = 0;
  B.pauseTimer = 0;
  B.pathLen = 0; B.pathIdx = 0; B.goal = -1;
  B.moving = false;
  B.strafeDir = 0; B.strafeTimer = 0; B.repathTimer = 0;
  B.stuckTimer = 0;
  B.jumpNow = false;
  B.moveWX = 0; B.moveWZ = 0;
  B.coverHold = 0; B.coverNode = -1;
}

// ---------------------------------------------------------------------------------------------
// sample

function sampleBot(B, P, sim, out) {
  out.moveX = 0; out.moveZ = 0;
  out.fire = false; out.jump = false; out.sprint = false; out.scoreboard = false;

  if (!B.started) startBrain(B, P, sim);
  B.dt = sim.time - B.lastTime;
  if (!(B.dt > 0) || B.dt > 0.25) B.dt = 1 / CONFIG.sim.hz;
  B.lastTime = sim.time;

  if (P.state !== 'alive') {
    if (B.state !== BOT_STATE.PATROL || B.pathLen > 0) resetBrain(B);
    B.yaw = P.body.yaw; B.pitch = P.body.pitch;
    out.yaw = B.yaw; out.pitch = B.pitch;
    B.lastShots = P.stats.shots;
    return;
  }
  // po respawnie ciało ma nowy yaw (spawn) — przejmij go, gdy bot był wyłączony
  if (B.state === BOT_STATE.PATROL && B.pathLen === 0) { B.yaw = P.body.yaw; }

  updateSkill(B, P, sim);
  trackShots(B, P);

  timers(B);
  B.thinkTimer -= B.dt;
  if (B.thinkTimer <= 0) {
    B.thinkTimer += CONFIG.bots.thinkInterval;
    if (B.thinkTimer < 0) B.thinkTimer = 0;
    think(B, P, sim);
  }

  steerAim(B, P);
  steerMove(B, P, sim);
  steerFire(B, P, sim, out);

  out.yaw = B.yaw;
  out.pitch = B.pitch;
  localMove(B, out);
  if ((B.state === BOT_STATE.CHASE || B.state === BOT_STATE.COVER) && !B.onRamp) out.sprint = true;
  if (B.jumpNow) { out.jump = true; B.jumpNow = false; }
}

function startBrain(B, P, sim) {
  B.started = true;
  B.rng = sim.rng;
  B.lastTime = sim.time - 1 / CONFIG.sim.hz;
  // rozłożenie myślenia botów w czasie (złoty podział po id)
  const ph = (P.id * 0.6180339887) % 1;
  B.thinkTimer = CONFIG.bots.thinkInterval * ph;
  B.yaw = P.body.yaw;
  B.pitch = 0;
  B.lastShots = P.stats.shots;
  B.stuckX = P.body.x; B.stuckZ = P.body.z;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) if (ps[i].isPlayer) { B.player = ps[i]; break; }
}

/** Parametry poziomu (z adaptacją dla przeciwników gracza) → B.sigma [rad], B.reaction [s], B.turn [rad/s]. */
function updateSkill(B, P, sim) {
  const L = B.L;
  if (B.adapt !== null && B.player !== null && isEnemy(P, B.player)) {
    stepAdapt(B.adapt, sim.time);
    const s = skillScale(B.adapt, L);
    B.sigma = s.aimSigma * DEG;
    B.reaction = s.reaction;
    B.turn = s.turn * DEG;
  } else {
    B.sigma = L.aimSigmaDeg * DEG;
    B.reaction = L.reaction;
    B.turn = L.turnDegPerSec * DEG;
  }
}

/** Wykrycie oddanego strzału (licznik stats.shots) → seria, nowy rozrzut. */
function trackShots(B, P) {
  const n = P.stats.shots;
  if (n === B.lastShots) return;
  B.lastShots = n;
  B.shotsLeft--;
  B.resampleAim = true;
  if (B.shotsLeft <= 0) {
    B.shotsLeft = 0;
    B.pauseNeeded = true;
  }
}

function timers(B) {
  const dt = B.dt;
  if (B.reactTimer > 0) B.reactTimer -= dt;
  if (B.pauseTimer > 0) B.pauseTimer -= dt;
  if (B.strafeTimer > 0) B.strafeTimer -= dt;
  if (B.repathTimer > 0) B.repathTimer -= dt;
  if (B.coverCooldown > 0) B.coverCooldown -= dt;
  if (B.chaseTimer > 0) B.chaseTimer -= dt;
}

// ---------------------------------------------------------------------------------------------
// percepcja + FSM (co thinkInterval)

function think(B, P, sim) {
  perceive(B, P, sim);
  const L = B.L;
  const W = P.weapon;
  const st = B.state;

  // osłona
  if (st !== BOT_STATE.COVER && B.coverCooldown <= 0 && B.threat !== null &&
      (P.hp <= L.coverHp || (L.coverOnOverheat && W.overheated))) {
    if (enterCover(B, P, sim)) return;
  }

  if (st === BOT_STATE.COVER) {
    if (B.pathIdx >= B.pathLen) {
      // w osłonie: trzymaj, potem wróć do walki/patrolu
      if (B.coverHold <= 0 && !W.overheated) {
        B.coverCooldown = CONFIG.bots.coverCooldown;
        if (B.targetVisible) setEngage(B);
        else if (B.target !== null) startChase(B, P, sim);
        else startPatrol(B, P, sim);
      }
    }
    return;
  }

  if (B.targetVisible) {
    if (st !== BOT_STATE.ENGAGE) setEngage(B);
    if (B.repathTimer <= 0) {
      B.repathTimer = CONFIG.bots.engageRepath;
      pathTo(B, P, B.lastKnownX, B.lastKnownY, B.lastKnownZ);
    }
    return;
  }

  if (st === BOT_STATE.ENGAGE) {
    startChase(B, P, sim);
    return;
  }
  if (st === BOT_STATE.CHASE) {
    if (B.chaseTimer <= 0 || B.pathIdx >= B.pathLen) { B.target = null; startPatrol(B, P, sim); }
    return;
  }
  // patrol
  if (B.pathIdx >= B.pathLen) startPatrol(B, P, sim);
}

/** Najbliższy widoczny wróg (dystans, FOV, linia wzroku oko→oko); napastnik z ostatniej chwili bez FOV. */
function perceive(B, P, sim) {
  const L = B.L;
  const C = CONFIG.bots;
  const eye = CONFIG.player.eyeHeight;
  const b = P.body;
  const ps = sim.participants;
  const cosHalf = Math.cos(L.fovDeg * 0.5 * DEG);
  const fx = -Math.sin(B.yaw), fz = -Math.cos(B.yaw);
  const view2 = L.viewDist * L.viewDist;
  const hitAware = P.lastHitTime > sim.time - C.hitAwareTime;

  let best = null;
  let bestD = Infinity;
  let bestProt = true;
  for (let i = 0; i < ps.length; i++) {
    const Q = ps[i];
    if (Q === P || Q.state !== 'alive' || !isEnemy(P, Q)) continue;
    const q = Q.body;
    const dx = q.x - b.x, dy = q.y - b.y, dz = q.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > view2) continue;
    const prot = Q.protectTimer > 0;
    // nie chroniony wygrywa z chronionym; potem bliższy
    if (best !== null && (prot && !bestProt || (prot === bestProt && d2 >= bestD))) continue;
    const attacker = hitAware && Q.id === P.lastHitBy;
    if (!attacker && Q !== B.target) {
      const hl = Math.sqrt(dx * dx + dz * dz);
      if (hl > 1e-3 && (dx * fx + dz * fz) / hl < cosHalf) continue;
    }
    if (!segmentClear(sim.world, b.x, b.y + eye, b.z, q.x, q.y + eye, q.z)) continue;
    best = Q; bestD = d2; bestProt = prot;
  }

  if (hitAware && P.lastHitBy >= 0) {
    for (let i = 0; i < ps.length; i++) if (ps[i].id === P.lastHitBy) { B.threat = ps[i]; break; }
  }

  if (best !== null) {
    if (best !== B.target || sim.time - B.lastSeenTime > C.reacquireTime) { B.reactTimer = B.reaction; B.needErr = true; }
    B.target = best;
    B.threat = B.threat === null ? best : B.threat;
    B.targetVisible = true;
    B.lastSeenTime = sim.time;
    B.lastKnownX = best.body.x; B.lastKnownY = best.body.y; B.lastKnownZ = best.body.z;
  } else {
    B.targetVisible = false;
    if (B.target !== null && B.target.state !== 'alive') B.target = null;
  }
  if (B.threat !== null && B.threat.state !== 'alive') B.threat = null;
}

function setEngage(B) {
  B.state = BOT_STATE.ENGAGE;
  B.repathTimer = 0;
}

function startChase(B, P, sim) {
  B.state = BOT_STATE.CHASE;
  B.chaseTimer = CONFIG.bots.chaseTime;
  if (!pathTo(B, P, B.lastKnownX, B.lastKnownY, B.lastKnownZ)) { B.target = null; startPatrol(B, P, sim); }
}

/** Cel patrolu: losowe węzły, preferencja nieodwiedzonych i odległych ≥ patrolMinDist. */
function startPatrol(B, P, sim) {
  B.state = BOT_STATE.PATROL;
  const nav = B.nav;
  const C = CONFIG.bots;
  const b = P.body;
  if (B.visitedCount > nav.count * 0.8) { B.visited.fill(0); B.visitedCount = 0; }
  let pick = -1;
  let pickScore = -1;
  const min2 = C.patrolMinDist * C.patrolMinDist;
  for (let k = 0; k < C.patrolSamples; k++) {
    const n = randomNode(nav, sim.rng);
    if (n < 0) continue;
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    const d2 = dx * dx + dz * dz;
    let score = d2 >= min2 ? 2 : 0;
    if (B.visited[n] === 0) score += 1;
    if (score > pickScore) { pickScore = score; pick = n; }
  }
  B.goal = pick;
  B.pathLen = 0; B.pathIdx = 0;
  if (pick < 0) return;
  const from = nearestNode(nav, b.x, b.y, b.z);
  setPath(B, P, findPath(nav, from, pick, B.path));
}

/** Ścieżka do punktu (najbliższy węzeł). false = brak. */
function pathTo(B, P, x, y, z) {
  const nav = B.nav;
  const b = P.body;
  const to = nearestNode(nav, x, y, z);
  const from = nearestNode(nav, b.x, b.y, b.z);
  if (to < 0 || from < 0) { B.pathLen = 0; B.pathIdx = 0; return false; }
  B.goal = to;
  setPath(B, P, findPath(nav, from, to, B.path));
  return B.pathLen > 0;
}

function setPath(B, P, len) {
  if (len > 2) len = smoothPath(B.nav, B.path, len);
  B.pathLen = len;
  B.pathIdx = 0;
  // pomiń pierwszy węzeł, jeśli jesteśmy już bliżej drugiego
  if (len > 1) {
    const nav = B.nav;
    const b = P.body;
    const a = B.path[0], c = B.path[1];
    const ax = nav.x[c] - nav.x[a], az = nav.z[c] - nav.z[a];
    const bx = nav.x[c] - b.x, bz = nav.z[c] - b.z;
    if (bx * bx + bz * bz <= ax * ax + az * az) B.pathIdx = 1;
  }
  B.stuckTimer = 0;
  B.stuckX = P.body.x; B.stuckZ = P.body.z;
}

/** Osłona: losowe węzły w promieniu coverRadius bez linii wzroku od napastnika; najbliższy (preferuj nav.cover). */
function enterCover(B, P, sim) {
  const nav = B.nav;
  const C = CONFIG.bots;
  const T = B.threat;
  const b = P.body;
  const eye = CONFIG.player.eyeHeight;
  const r2 = C.coverRadius * C.coverRadius;
  let best = -1;
  let bestD = Infinity;
  let checks = 0;
  for (let k = 0; k < C.coverChecks * 8 && checks < C.coverChecks; k++) {
    const n = randomNode(nav, sim.rng);
    if (n < 0) continue;
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    let d2 = dx * dx + dz * dz;
    if (d2 > r2 || d2 >= bestD) continue;
    checks++;
    if (segmentClear(sim.world, T.body.x, T.body.y + eye, T.body.z, nav.x[n], nav.y[n] + eye, nav.z[n])) continue;
    if (nav.cover && nav.cover[n]) d2 *= 0.5;
    best = n; bestD = d2;
  }
  if (best < 0) { B.coverCooldown = C.coverCooldown * 0.5; return false; }
  const from = nearestNode(nav, b.x, b.y, b.z);
  const len = findPath(nav, from, best, B.path);
  if (len === 0) { B.coverCooldown = C.coverCooldown * 0.5; return false; }
  B.state = BOT_STATE.COVER;
  B.coverNode = best;
  B.goal = best;
  B.coverHold = C.coverHold;
  setPath(B, P, len);
  return true;
}

// ---------------------------------------------------------------------------------------------
// sterowanie (każdy krok)

/** Docelowe kąty: na cel (z rozrzutem) w walce, inaczej w kierunku ruchu. Obrót z limitem B.turn. */
function steerAim(B, P) {
  const b = P.body;
  if (B.resampleAim) { B.resampleAim = false; B.needErr = true; }
  const T = B.target;
  if ((B.state === BOT_STATE.ENGAGE || B.state === BOT_STATE.COVER) && T !== null && B.targetVisible) {
    const ex = b.x, ey = b.y + CONFIG.player.eyeHeight, ez = b.z;
    const dx = T.body.x - ex, dy = T.body.y + CONFIG.bots.aimHeight - ey, dz = T.body.z - ez;
    B.desYaw = Math.atan2(-dx, -dz) + B.errYaw;
    B.desPitch = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) + B.errPitch;
  } else if (B.state === BOT_STATE.CHASE && B.pathIdx >= B.pathLen) {
    const dx = B.lastKnownX - b.x, dz = B.lastKnownZ - b.z;
    if (dx * dx + dz * dz > 0.01) B.desYaw = Math.atan2(-dx, -dz);
    B.desPitch = 0;
  } else if (B.pathIdx < B.pathLen) {
    const n = B.path[B.pathIdx];
    const dx = B.nav.x[n] - b.x, dz = B.nav.z[n] - b.z;
    if (dx * dx + dz * dz > 0.04) B.desYaw = Math.atan2(-dx, -dz);
    B.desPitch = 0;
  } else {
    B.desYaw = B.yaw;
    B.desPitch = 0;
  }
  if (B.needErr) sampleAimError(B);
  const maxStep = B.turn * B.dt;
  let d = B.desYaw - B.yaw;
  d -= TWO_PI * Math.round(d / TWO_PI);
  if (d > maxStep) d = maxStep; else if (d < -maxStep) d = -maxStep;
  B.yaw += d;
  if (B.yaw > Math.PI) B.yaw -= TWO_PI; else if (B.yaw < -Math.PI) B.yaw += TWO_PI;
  let dp = B.desPitch - B.pitch;
  if (dp > maxStep) dp = maxStep; else if (dp < -maxStep) dp = -maxStep;
  B.pitch += dp;
  const lim = CONFIG.player.pitchLimit;
  if (B.pitch > lim) B.pitch = lim; else if (B.pitch < -lim) B.pitch = -lim;
}

/** Gaussowski rozrzut (Box–Muller, sim.rng) → errYaw/errPitch [rad]. */
function sampleAimError(B) {
  B.needErr = false;
  const rng = B.rng;
  const u1 = rng.next() || 1e-9;
  const u2 = rng.next();
  const m = Math.sqrt(-2 * Math.log(u1)) * B.sigma;
  B.errYaw = m * Math.cos(TWO_PI * u2);
  B.errPitch = m * Math.sin(TWO_PI * u2) * 0.6;   // mniejszy rozrzut w pionie
}

/** Kierunek ruchu w świecie (B.moveWX/WZ): ścieżka, walka (dystans + strafe), utknięcie. */
function steerMove(B, P, sim) {
  const C = CONFIG.bots;
  const b = P.body;
  const nav = B.nav;
  B.moveWX = 0; B.moveWZ = 0;

  // przejście przez kolejne węzły ścieżki
  B.onRamp = false;
  while (B.pathIdx < B.pathLen) {
    const n = B.path[B.pathIdx];
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    // odcinek ze zmianą wysokości (rampa): dojście bliżej, bez sprintu (inaczej spadnie z boku wąskiej rampy)
    const py = B.pathIdx > 0 ? nav.y[B.path[B.pathIdx - 1]] : b.y;
    const dyN = nav.y[n] - py;
    const dyB = nav.y[n] - b.y;
    const ramp = dyN > C.rampDy || dyN < -C.rampDy || dyB > C.rampDy || dyB < -C.rampDy;
    const ad = ramp ? C.rampArriveDist : C.arriveDist;
    if (ramp) B.onRamp = true;
    if (dx * dx + dz * dz > ad * ad) break;
    if (B.visited[n] === 0) { B.visited[n] = 1; B.visitedCount++; }
    B.pathIdx++;
  }
  if (B.state === BOT_STATE.COVER && B.pathIdx >= B.pathLen && B.coverHold > 0) B.coverHold -= B.dt;

  let followPath = B.pathIdx < B.pathLen;
  if (B.state === BOT_STATE.ENGAGE && B.target !== null) {
    const T = B.target.body;
    const dx = T.x - b.x, dz = T.z - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const R = C.engageRange;
    if (d > 1e-3 && B.targetVisible) {
      if (d < R[0]) { B.moveWX = -dx / d; B.moveWZ = -dz / d; followPath = false; }
      else if (d <= R[1]) followPath = false;
    }
    if (B.L.strafe > 0) {
      if (B.strafeTimer <= 0) {
        B.strafeTimer = sim.rng.range(C.strafeSwitch[0], C.strafeSwitch[1]);
        B.strafeDir = sim.rng.next() < B.L.strafe ? (sim.rng.next() < 0.5 ? -1 : 1) : 0;
      }
      if (B.strafeDir !== 0 && d > 1e-3) {
        // prostopadle do kierunku na cel
        B.moveWX += (-dz / d) * B.strafeDir;
        B.moveWZ += (dx / d) * B.strafeDir;
      }
    }
  }
  if (followPath) {
    const n = B.path[B.pathIdx];
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-4) { B.moveWX += dx / d; B.moveWZ += dz / d; }
  }

  // utknięcie: brak postępu przy chęci ruchu
  B.moving = B.moveWX * B.moveWX + B.moveWZ * B.moveWZ > 0.01;
  if (!B.moving) {
    B.stuckTimer = 0; B.stuckX = b.x; B.stuckZ = b.z;
    return;
  }
  B.stuckTimer += B.dt;
  if (B.stuckTimer < C.stuckTime) return;
  const mx = b.x - B.stuckX, mz = b.z - B.stuckZ;
  if (mx * mx + mz * mz < C.stuckMinMove * C.stuckMinMove) onStuck(B, P, sim);
  B.stuckTimer = 0; B.stuckX = b.x; B.stuckZ = b.z;
}

function onStuck(B, P, sim) {
  B.stuckCount++;
  B.jumpNow = true;
  B.strafeDir = -B.strafeDir;
  if (B.state === BOT_STATE.PATROL) startPatrol(B, P, sim);
  else if (B.state === BOT_STATE.COVER) { B.coverCooldown = CONFIG.bots.coverCooldown; startPatrol(B, P, sim); }
  else if (B.state === BOT_STATE.CHASE) { B.target = null; startPatrol(B, P, sim); }
  else pathTo(B, P, B.lastKnownX, B.lastKnownY, B.lastKnownZ);
}

/** Świat → lokalne moveX/moveZ względem B.yaw (to samo yaw trafia do ciała w tym kroku). */
function localMove(B, out) {
  const wx = B.moveWX, wz = B.moveWZ;
  const l2 = wx * wx + wz * wz;
  if (l2 < 1e-6) return;
  const inv = l2 > 1 ? 1 / Math.sqrt(l2) : 1;
  const sy = Math.sin(B.yaw), cy = Math.cos(B.yaw);
  out.moveX = (wx * cy - wz * sy) * inv;
  out.moveZ = (-wx * sy - wz * cy) * inv;
}

/** Ogień seriami: reakcja minęła, celownik na punkcie, nie przegrzany, nie chroniony cel, brak sojusznika na linii. */
function steerFire(B, P, sim, out) {
  const C = CONFIG.bots;
  const T = B.target;
  const W = P.weapon;
  if (B.pauseNeeded) {
    B.pauseNeeded = false;
    B.pauseTimer = sim.rng.range(C.burstPause[0], C.burstPause[1]);
  }
  if (T === null || !B.targetVisible || T.state !== 'alive' || T.protectTimer > 0) return;
  if (B.state !== BOT_STATE.ENGAGE && !(B.state === BOT_STATE.COVER && B.pathIdx >= B.pathLen)) return;
  if (B.reactTimer > 0 || W.overheated || B.pauseTimer > 0) return;
  if (B.shotsLeft <= 0) {
    // nowa seria tylko przy rozsądnym cieple
    if (W.heat > B.L.heatLimit - CONFIG.weapon.heatPerShot) return;
    B.shotsLeft = sim.rng.int(C.burstShots[0], C.burstShots[1]);
  }
  let dy = B.desYaw - B.yaw;
  dy -= TWO_PI * Math.round(dy / TWO_PI);
  const dp = B.desPitch - B.pitch;
  const tol = C.fireTolDeg * DEG;
  if (dy > tol || dy < -tol || dp > tol || dp < -tol) return;
  if (allyInLine(B, P, sim)) return;
  out.fire = true;
}

/** Czy sojusznik stoi na linii oko → cel (przybliżenie: pionowy walec kapsuły trafień). */
function allyInLine(B, P, sim) {
  const ps = sim.participants;
  const b = P.body;
  const T = B.target.body;
  const eye = CONFIG.player.eyeHeight;
  const ox = b.x, oy = b.y + eye, oz = b.z;
  const vx = T.x - ox, vy = T.y + CONFIG.bots.aimHeight - oy, vz = T.z - oz;
  const len2 = vx * vx + vy * vy + vz * vz;
  if (len2 < 1e-6) return false;
  const R = CONFIG.combat.hitCapsuleRadius + 0.15;
  for (let i = 0; i < ps.length; i++) {
    const Q = ps[i];
    if (Q === P || Q.state !== 'alive' || !sameTeam(P, Q)) continue;
    const q = Q.body;
    const t = ((q.x - ox) * vx + (q.y + 1 - oy) * vy + (q.z - oz) * vz) / len2;
    if (t <= 0 || t >= 1) continue;
    const px = ox + vx * t - q.x, pz = oz + vz * t - q.z, py = oy + vy * t - q.y;
    if (px * px + pz * pz < R * R && py > 0 && py < CONFIG.combat.hitCapsuleTop + 0.1) return true;
  }
  return false;
}
