// Mózg bota (PLAN §8.2, SPEC §2.5) — InputSource: sample(P, sim, out). Czysty JS, bez three.
// FSM: patrol → hold (zasadzka) → engage (namierzanie) → cover (osłona/wycofanie) → chase (pościg / podejście do dźwięku).
// Styl zasadzkowy (D-016): patrol chodem, zasadzki przy osłonach z widokiem na przejście (kucanie za połówką),
// wycofanie po przegranej wymianie, podejście z flanki do usłyszanego strzału, brak ognia na duży dystans. Decyzje i percepcja co CONFIG.bots.thinkInterval
// (faza przesunięta per bot), sterowanie celowaniem/ruchem/ogniem w każdym kroku.
// Zero alokacji w sample(): stan w polach obiektu bota i w prealokowanych buforach; skalary pośrednie w polach (nie
// jako argumenty/wyniki double funkcji pomocniczych — V8 pakuje je w HeapNumber, gdy nie są inline'owane).
// Determinizm: losowość wyłącznie przez sim.rng.

import { CONFIG } from '../../config.js';
import { segmentClearSeg, SEG } from '../../world/physics.js';
import { nearestNodeBuf, NEAR, findPath, randomNode, smoothPath } from '../../world/nav.js';
import { isEnemy, sameTeam, eyeOf, heightScale } from '../combat.js';
import { skillScale, stepAdapt } from './adapt.js';

export const BOT_STATE = Object.freeze({ PATROL: 'patrol', HOLD: 'hold', ENGAGE: 'engage', COVER: 'cover', CHASE: 'chase' });

const DEG = Math.PI / 180;
const TWO_PI = Math.PI * 2;
// Losowe ułamki liczone tu z rng.int (wynik Smi) — double zwracany przez rng.next/range z nie-inline'owanego
// wywołania V8 pakuje w HeapNumber (alokacja na gorącej ścieżce).
const U = 1 << 20;
const INV_U = 1 / U;

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
    // zasadzka
    holdNode: -1, holdYaw: 0.5, holdTimer: 0.5, holdCooldown: 0.5, holdCrouch: false, fromHold: false, crouch: false,
    // wymiana ognia (wycofanie po przegranej)
    engageTime: 0.5, hitsAtEngage: 0,
    // słuch
    heardX: 0.5, heardZ: 0.5, heardTime: -1e9 + 0.5, heardHandled: -1e9 + 0.5,
    path2: new Int32Array(CONFIG.bots.pathCapacity), investigating: false,
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
  B.holdNode = -1; B.holdTimer = 0; B.holdCrouch = false; B.fromHold = false; B.crouch = false;
  B.heardTime = -1e9; B.heardHandled = -1e9; B.investigating = false;
}

// ---------------------------------------------------------------------------------------------
// sample

function sampleBot(B, P, sim, out) {
  out.moveX = 0; out.moveZ = 0;
  out.fire = false; out.jump = false; out.sprint = false; out.scoreboard = false; out.crouch = false;

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
  listen(B, P, sim);

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
  // sprint tylko do osłony (wycofanie) i w pościgu na hard; patrol/zasadzka/podejście do dźwięku — chodem
  if (!B.onRamp && B.moving && (B.state === BOT_STATE.COVER ||
      (B.state === BOT_STATE.CHASE && B.L.sprintChase && !B.investigating))) out.sprint = true;
  out.crouch = B.crouch;
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
  if (B.holdCooldown > 0) B.holdCooldown -= dt;
}

/**
 * Słuch: wróg, który właśnie strzelił (weapon.sinceShot < 1.5 kroku), w promieniu hearRadius → B.heard*.
 * Z broni uczestników, nie z kolejki zdarzeń — ta jest czyszczona raz na klatkę renderu, często zanim bot ją przeczyta.
 */
function listen(B, P, sim) {
  const b = P.body;
  const r2 = CONFIG.bots.hearRadius * CONFIG.bots.hearRadius;
  const fresh = B.dt * 1.5;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) {
    const Q = ps[i];
    if (Q === P || Q.state !== 'alive' || Q.weapon.sinceShot >= fresh || !isEnemy(P, Q)) continue;
    const q = Q.body;
    const dx = q.x - b.x, dz = q.z - b.z;
    if (dx * dx + dz * dz > r2) continue;
    B.heardX = q.x; B.heardZ = q.z; B.heardTime = sim.time;
  }
}

// ---------------------------------------------------------------------------------------------
// percepcja + FSM (co thinkInterval)

function think(B, P, sim) {
  perceive(B, P, sim);
  const L = B.L;
  const W = P.weapon;
  const st = B.state;

  // osłona / wycofanie: niskie HP, przegrzanie (hard) albo przegrana wymiana (trafiony, zanim sam trafił)
  const lostExchange = L.retreatFirstHit && st === BOT_STATE.ENGAGE && P.lastHitTime >= B.engageTime &&
    P.stats.hits === B.hitsAtEngage;
  if (st !== BOT_STATE.COVER && B.coverCooldown <= 0 && B.threat !== null &&
      (P.hp <= L.coverHp || lostExchange || (L.coverOnOverheat && W.overheated))) {
    if (enterCover(B, P, sim)) return;
  }

  if (st === BOT_STATE.COVER) {
    if (B.pathIdx >= B.pathLen) {
      // w osłonie: trzymaj, potem wróć do walki/patrolu
      if (B.coverHold <= 0 && !W.overheated) {
        B.coverCooldown = CONFIG.bots.coverCooldown;
        if (B.targetVisible) setEngage(B, P, sim);
        else if (B.target !== null) startChase(B, P, sim);
        else startPatrol(B, P, sim);
      }
    }
    return;
  }

  if (B.targetVisible) {
    if (st !== BOT_STATE.ENGAGE) { B.fromHold = st === BOT_STATE.HOLD; setEngage(B, P, sim); }
    if (B.repathTimer <= 0) {
      B.repathTimer = CONFIG.bots.engageRepath;
      pathToLastKnown(B, P);
    }
    return;
  }

  if (st === BOT_STATE.ENGAGE) {
    // cel zniknął: zamiast zawsze gonić — czasem zasadzka przy najbliższej osłonie, z widokiem na miejsce kontaktu
    if (sim.rng.int(0, U - 1) * INV_U < B.L.holdChance && startHoldNear(B, P, sim)) return;
    startChase(B, P, sim);
    return;
  }
  if (st === BOT_STATE.CHASE) {
    if (B.chaseTimer <= 0 || B.pathIdx >= B.pathLen) { B.target = null; startPatrol(B, P, sim); }
    return;
  }
  // usłyszany strzał: w zasadzce — obrót w stronę dźwięku i dalsze czekanie; w patrolu — podejście (z flanki)
  if (B.heardTime > sim.time - CONFIG.bots.hearMemory && B.heardTime > B.heardHandled) {
    B.heardHandled = B.heardTime;
    if (st === BOT_STATE.HOLD && B.pathIdx >= B.pathLen) {
      B.holdYaw = Math.atan2(-(B.heardX - P.body.x), -(B.heardZ - P.body.z));
    } else if (startInvestigate(B, P, sim)) return;
  }
  if (st === BOT_STATE.HOLD) {
    if (B.pathIdx >= B.pathLen && B.holdTimer <= 0) { B.holdCooldown = CONFIG.bots.holdCooldown; startPatrol(B, P, sim); }
    return;
  }
  // patrol
  if (B.pathIdx >= B.pathLen) startPatrol(B, P, sim);
}

/** Najbliższy widoczny wróg (dystans, FOV, linia wzroku oko→oko); napastnik z ostatniej chwili bez FOV. */
function perceive(B, P, sim) {
  const L = B.L;
  const C = CONFIG.bots;
  const eye = CONFIG.player.eyeHeight;   // obserwator „wygląda" z wysokości stojącej (zza osłony połówkowej)
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
    SEG[0] = b.x; SEG[1] = b.y + eye; SEG[2] = b.z; SEG[3] = q.x; SEG[4] = q.y + eyeOf(q); SEG[5] = q.z;
    if (!segmentClearSeg(sim.world)) continue;   // kucający cel za połówką jest niewidoczny
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

function setEngage(B, P, sim) {
  B.state = BOT_STATE.ENGAGE;
  B.repathTimer = 0;
  B.crouch = false;
  B.engageTime = sim.time;
  B.hitsAtEngage = P.stats.hits;
  B.investigating = false;
}

function startChase(B, P, sim) {
  B.state = BOT_STATE.CHASE;
  B.investigating = false;
  B.chaseTimer = CONFIG.bots.chaseTime;
  if (!pathToLastKnown(B, P)) { B.target = null; startPatrol(B, P, sim); }
}

/** Cel patrolu: losowe węzły, preferencja nieodwiedzonych i odległych ≥ patrolMinDist. */
function startPatrol(B, P, sim) {
  B.state = BOT_STATE.PATROL;
  B.crouch = false;
  B.fromHold = false;
  B.investigating = false;
  if (B.holdCooldown <= 0 && sim.rng.int(0, U - 1) * INV_U < B.L.holdChance && startHold(B, P, sim)) return;
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
  const from = nearestBody(nav, b);
  setPath(B, P, findPath(nav, from, pick, B.path));
}

/** Ścieżka do ostatniej znanej pozycji celu (najbliższy węzeł). false = brak. Współrzędne przez NEAR (bez boxingu). */
function pathToLastKnown(B, P) {
  const nav = B.nav;
  NEAR[0] = B.lastKnownX; NEAR[1] = B.lastKnownY; NEAR[2] = B.lastKnownZ;
  const to = nearestNodeBuf(nav);
  const from = nearestBody(nav, P.body);
  if (to < 0 || from < 0) { B.pathLen = 0; B.pathIdx = 0; return false; }
  B.goal = to;
  setPath(B, P, findPath(nav, from, to, B.path));
  return B.pathLen > 0;
}

/** Najbliższy węzeł do ciała (współrzędne przez NEAR — bez boxingu argumentów). */
function nearestBody(nav, b) {
  NEAR[0] = b.x; NEAR[1] = b.y; NEAR[2] = b.z;
  return nearestNodeBuf(nav);
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
    SEG[0] = T.body.x; SEG[1] = T.body.y + eye; SEG[2] = T.body.z; SEG[3] = nav.x[n]; SEG[4] = nav.y[n] + eye; SEG[5] = nav.z[n];
    if (segmentClearSeg(sim.world)) continue;
    if (nav.cover && nav.cover[n]) d2 *= 0.5;
    best = n; bestD = d2;
  }
  if (best < 0) { B.coverCooldown = C.coverCooldown * 0.5; return false; }
  const from = nearestBody(nav, b);
  const len = findPath(nav, from, best, B.path);
  if (len === 0) { B.coverCooldown = C.coverCooldown * 0.5; return false; }
  B.state = BOT_STATE.COVER;
  B.coverNode = best;
  B.goal = best;
  B.coverHold = C.coverHold;
  setPath(B, P, len);
  return true;
}

/**
 * Zasadzka: kandydaci z nav.cover w zasięgu holdRange, ocena widoku (linie wzroku do losowych węzłów w holdView).
 * Najlepszy → ścieżka (chodem), potem czekanie holdTime [s] zwrócony w stronę widoku; kuca, gdy obok osłona połówkowa.
 */
function startHold(B, P, sim) {
  const nav = B.nav;
  if (!nav.cover) return false;
  const C = CONFIG.bots;
  const b = P.body;
  const eye = CONFIG.player.eyeHeight;
  const rMin2 = C.holdRange[0] * C.holdRange[0], rMax2 = C.holdRange[1] * C.holdRange[1];
  const vMin2 = C.holdView[0] * C.holdView[0], vMax2 = C.holdView[1] * C.holdView[1];
  let best = -1;
  let bestScore = 1;               // ≥ 2 widoczne węzły
  let tries = 0;
  for (let k = 0; k < C.holdCandidates * 12 && tries < C.holdCandidates; k++) {
    const n = randomNode(nav, sim.rng);
    if (n < 0 || nav.cover[n] === 0) continue;
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < rMin2 || d2 > rMax2) continue;
    tries++;
    let score = 0;
    let vx = 0, vz = 0;
    for (let j = 0; j < C.holdViewSamples; j++) {
      const m = randomNode(nav, sim.rng);
      if (m < 0) continue;
      const ex = nav.x[m] - nav.x[n], ez = nav.z[m] - nav.z[n];
      const e2 = ex * ex + ez * ez;
      if (e2 < vMin2 || e2 > vMax2) continue;
      SEG[0] = nav.x[n]; SEG[1] = nav.y[n] + eye; SEG[2] = nav.z[n];
      SEG[3] = nav.x[m]; SEG[4] = nav.y[m] + eye; SEG[5] = nav.z[m];
      if (!segmentClearSeg(sim.world)) continue;
      score++;
      const inv = 1 / Math.sqrt(e2);
      vx += ex * inv; vz += ez * inv;
    }
    if (score >= 2 && halfCoverNear(sim.world, nav.x[n], nav.z[n])) score += 2;   // preferuj połówkę (kucanie)
    if (score > bestScore) { bestScore = score; best = n; B.holdYaw = Math.atan2(-vx, -vz); }
  }
  if (best < 0) return false;
  const len = findPath(nav, nearestBody(nav, b), best, B.path);
  if (len === 0) return false;
  B.state = BOT_STATE.HOLD;
  B.holdNode = best;
  B.goal = best;
  const ht = B.L.holdTime;
  B.holdTimer = ht[0] + (ht[1] - ht[0]) * (sim.rng.int(0, U - 1) * INV_U);
  B.holdCrouch = halfCoverNear(sim.world, nav.x[best], nav.z[best]);
  setPath(B, P, len);
  return true;
}

/** Zasadzka po utracie kontaktu: najbliższy węzeł nav.cover w promieniu holdRange[0], zwrot do ostatniej znanej pozycji. */
function startHoldNear(B, P, sim) {
  const nav = B.nav;
  if (!nav.cover) return false;
  const C = CONFIG.bots;
  const b = P.body;
  const r2 = C.holdRange[0] * C.holdRange[0];
  let best = -1;
  let bestD = r2;
  for (let k = 0; k < C.holdCandidates * 4; k++) {
    const n = randomNode(nav, sim.rng);
    if (n < 0 || nav.cover[n] === 0) continue;
    const dx = nav.x[n] - b.x, dz = nav.z[n] - b.z;
    let d2 = dx * dx + dz * dz;
    if (d2 >= bestD) continue;
    if (halfCoverNear(sim.world, nav.x[n], nav.z[n])) d2 *= 0.25;   // preferuj połówkę (kucanie)
    if (d2 < bestD) { bestD = d2; best = n; }
  }
  if (best < 0) return false;
  const len = findPath(nav, nearestBody(nav, b), best, B.path);
  if (len === 0) return false;
  B.state = BOT_STATE.HOLD;
  B.holdNode = best;
  B.goal = best;
  B.holdYaw = Math.atan2(-(B.lastKnownX - nav.x[best]), -(B.lastKnownZ - nav.z[best]));
  const ht = B.L.holdTime;
  B.holdTimer = ht[0] + (ht[1] - ht[0]) * (sim.rng.int(0, U - 1) * INV_U);
  B.holdCrouch = halfCoverNear(sim.world, nav.x[best], nav.z[best]);
  setPath(B, P, len);
  return true;
}

// scratch: punkt (x, z) dla halfCoverNear
const HC = new Float64Array(2);

/** Czy przy węźle stoi osłona połówkowa (top w CONFIG.bots.halfCover) — wtedy kucanie ma sens. */
function halfCoverNear(world, x, z) {
  HC[0] = x; HC[1] = z;
  const C = CONFIG.bots;
  const solids = world.solids;
  const lim2 = C.halfCoverDist * C.halfCoverDist;
  for (let i = 0; i < solids.length; i++) {
    const so = solids[i];
    if (so.y1 < C.halfCover[0] || so.y1 > C.halfCover[1] || so.y0 > 0.2) continue;
    const dx = HC[0] - so.cx, dz = HC[1] - so.cz;
    const lx = dx * so.cos - dz * so.sin, lz = dx * so.sin + dz * so.cos;
    const qx = lx < -so.hx ? lx + so.hx : lx > so.hx ? lx - so.hx : 0;
    const qz = lz < -so.hz ? lz + so.hz : lz > so.hz ? lz - so.hz : 0;
    if (qx * qx + qz * qz <= lim2) return true;
  }
  return false;
}

/**
 * Podejście do usłyszanego strzału: z prawdopodobieństwem level.flankChance przez węzeł pośredni przesunięty
 * w bok o flankOffset (inna ścieżka niż wprost pod lufę), chodem, limit investigateTime.
 */
function startInvestigate(B, P, sim) {
  const nav = B.nav;
  const C = CONFIG.bots;
  const b = P.body;
  B.lastKnownX = B.heardX; B.lastKnownY = b.y; B.lastKnownZ = B.heardZ;
  NEAR[0] = B.heardX; NEAR[1] = b.y; NEAR[2] = B.heardZ;
  const to = nearestNodeBuf(nav);
  const from = nearestBody(nav, b);
  if (to < 0 || from < 0) return false;
  let len = 0;
  if (sim.rng.int(0, U - 1) * INV_U < B.L.flankChance) {
    const dx = B.heardX - b.x, dz = B.heardZ - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-3) {
      const side = sim.rng.int(0, 1) === 0 ? -1 : 1;
      // punkt w połowie drogi, przesunięty prostopadle
      NEAR[0] = b.x + dx * 0.5 + (-dz / d) * C.flankOffset * side;
      NEAR[2] = b.z + dz * 0.5 + (dx / d) * C.flankOffset * side;
      const mid = nearestNodeBuf(nav);
      if (mid >= 0 && mid !== from && mid !== to) {
        const l1 = findPath(nav, from, mid, B.path);
        const l2 = l1 > 0 ? findPath(nav, mid, to, B.path2) : 0;
        if (l1 > 0 && l2 > 0 && l1 + l2 - 1 <= B.path.length) {
          for (let i = 1; i < l2; i++) B.path[l1 - 1 + i] = B.path2[i];
          len = l1 + l2 - 1;
        }
      }
    }
  }
  if (len === 0) len = findPath(nav, from, to, B.path);
  if (len === 0) return false;
  B.state = BOT_STATE.CHASE;
  B.investigating = true;
  B.crouch = false;
  B.goal = to;
  B.chaseTimer = C.investigateTime;
  setPathRaw(B, P, len);
  return true;
}

/** Jak setPath, bez wygładzania (ścieżka flankująca ma zostać okrężna). */
function setPathRaw(B, P, len) {
  B.pathLen = len;
  B.pathIdx = len > 1 ? 1 : 0;
  B.stuckTimer = 0;
  B.stuckX = P.body.x; B.stuckZ = P.body.z;
}

// ---------------------------------------------------------------------------------------------
// sterowanie (każdy krok)

/** Docelowe kąty: na cel (z rozrzutem) w walce, inaczej w kierunku ruchu. Obrót z limitem B.turn. */
function steerAim(B, P) {
  const b = P.body;
  if (B.resampleAim) { B.resampleAim = false; B.needErr = true; }
  const T = B.target;
  if ((B.state === BOT_STATE.ENGAGE || B.state === BOT_STATE.COVER || B.state === BOT_STATE.HOLD) && T !== null && B.targetVisible) {
    const ex = b.x, ey = b.y + eyeOf(b), ez = b.z;
    const dx = T.body.x - ex, dy = T.body.y + CONFIG.bots.aimHeight * heightScale(T.body) - ey, dz = T.body.z - ez;
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
  } else if (B.state === BOT_STATE.HOLD) {
    // w zasadzce: obserwacja przejścia z lekkim rozglądaniem się
    B.desYaw = B.holdYaw + CONFIG.bots.holdSweep * Math.sin(B.holdTimer * 0.9);
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
  const u1 = rng.int(1, U) * INV_U;          // (0, 1]
  const u2 = rng.int(0, U - 1) * INV_U;      // [0, 1)
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
    // ostatni węzeł osłony/zasadzki: dojście dokładne (inaczej bot staje 0.6 m przed węzłem — często na widoku)
    const final = B.pathIdx === B.pathLen - 1 && (B.state === BOT_STATE.COVER || B.state === BOT_STATE.HOLD);
    const ad = ramp || final ? C.rampArriveDist : C.arriveDist;
    if (ramp) B.onRamp = true;
    if (dx * dx + dz * dz > ad * ad) break;
    if (B.visited[n] === 0) { B.visited[n] = 1; B.visitedCount++; }
    B.pathIdx++;
  }
  if (B.state === BOT_STATE.COVER && B.pathIdx >= B.pathLen && B.coverHold > 0) B.coverHold -= B.dt;
  if (B.state === BOT_STATE.HOLD) {
    const arrived = B.pathIdx >= B.pathLen;
    if (arrived && B.holdTimer > 0) B.holdTimer -= B.dt;
    B.crouch = arrived && B.holdCrouch && !B.targetVisible;   // wstaje do strzału
  }

  let followPath = B.pathIdx < B.pathLen;
  if (B.state === BOT_STATE.ENGAGE && B.target !== null) {
    const T = B.target.body;
    const dx = T.x - b.x, dz = T.z - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const R = C.engageRange;
    if (d > 1e-3 && B.targetVisible) {
      if (d < R[0]) { B.moveWX = -dx / d; B.moveWZ = -dz / d; followPath = false; }
      else if (d <= R[1] || (B.fromHold && d <= B.L.maxFireDist)) followPath = false;   // z zasadzki: trzyma pozycję
    }
    if (B.L.strafe > 0 && !B.fromHold) {
      if (B.strafeTimer <= 0) {
        const sw = C.strafeSwitch;
        B.strafeTimer = sw[0] + (sw[1] - sw[0]) * (sim.rng.int(0, U - 1) * INV_U);
        B.strafeDir = sim.rng.int(0, U - 1) * INV_U < B.L.strafe ? (sim.rng.int(0, 1) === 0 ? -1 : 1) : 0;
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
  if (B.strafeDir !== 0) B.strafeDir = -B.strafeDir;   // bez -0 (double → zmiana mapy obiektu → deopt wszystkich funkcji bota)
  if (B.state === BOT_STATE.PATROL) startPatrol(B, P, sim);
  else if (B.state === BOT_STATE.COVER) { B.coverCooldown = CONFIG.bots.coverCooldown; startPatrol(B, P, sim); }
  else if (B.state === BOT_STATE.CHASE || B.state === BOT_STATE.HOLD) { B.target = null; B.holdCooldown = CONFIG.bots.holdCooldown; startPatrol(B, P, sim); }
  else pathToLastKnown(B, P);
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
    const bp = C.burstPause;
    B.pauseTimer = bp[0] + (bp[1] - bp[0]) * (sim.rng.int(0, U - 1) * INV_U);
  }
  if (T === null || !B.targetVisible || T.state !== 'alive' || T.protectTimer > 0) return;
  if (B.state !== BOT_STATE.ENGAGE && !(B.state === BOT_STATE.COVER && B.pathIdx >= B.pathLen)) return;
  if (B.reactTimer > 0 || W.overheated || B.pauseTimer > 0 || P.stunTimer > 0) return;
  // brak „nawalania" na dystans
  const tdx = T.body.x - P.body.x, tdz = T.body.z - P.body.z;
  if (tdx * tdx + tdz * tdz > B.L.maxFireDist * B.L.maxFireDist) return;
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
  const ox = b.x, oy = b.y + eyeOf(b), oz = b.z;
  const vx = T.x - ox, vy = T.y + CONFIG.bots.aimHeight * heightScale(T) - oy, vz = T.z - oz;
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
    if (px * px + pz * pz < R * R && py > 0 && py < CONFIG.combat.hitCapsuleTop * heightScale(q) + 0.1) return true;
  }
  return false;
}
