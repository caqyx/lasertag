// Walka (PLAN §7.4, SPEC §2.1–§2.2): hitscan, kapsuła trafień, sensory kamizelki, HP, eliminacja, respawn, ochrona.
// Czysty JS, bez three, bez alokacji (scratch na poziomie modułu).
//
// Kapsuła trafień: pionowa, promień hitCapsuleRadius, zajmuje wysokości [body.y + hitCapsuleBottom, body.y + hitCapsuleTop]
// (całkowity zasięg łącznie z półsferami; odcinek osi = [bottom + r, top − r]).
// Sojusznicy (ten sam team ≥ 0) przy !sim.friendlyFire: wiązka przez nich przelatuje. Wyeliminowani: nie trafiani, nie blokują.
// Ochrona celu: wiązka zatrzymuje się na nim, SHOT.value = 2, brak HIT i brak zmian HP/punktów.

import { CONFIG } from '../config.js';
import { raycastWorld, segmentClear, createHit } from '../world/physics.js';
import { EV } from '../core/events.js';
import { SENSOR_OFFSETS, resetVitals, placeAt } from './participant.js';
import { resetWeapon } from './weapon.js';
import { awardHit, awardElim } from './scoring.js';

const EPS = 1e-9;

// --- scratch
const ER = { ox: 0.5, oy: 0.5, oz: 0.5, dx: 0.5, dy: 0.5, dz: 0.5 };
const MZ = { x: 0.5, y: 0.5, z: 0.5 };
const WHIT = createHit();

// --- relacje

/** a i b w tej samej drużynie (team ≥ 0). FFA: team = -1 lub unikalny → nigdy. */
export function sameTeam(a, b) {
  return a !== b && a.team >= 0 && a.team === b.team;
}

/** Wróg = inny uczestnik spoza drużyny. */
export function isEnemy(a, b) {
  return a !== b && !sameTeam(a, b);
}

function passesThrough(sim, shooter, P) {
  return !sim.friendlyFire && sameTeam(shooter, P);
}

function emit(sim, type, a, b, team) {
  const r = sim.events.push(type);
  r.time = sim.time;
  r.a = a;
  r.b = b;
  r.team = team;
  return r;
}

// --- geometria

/** Promień z oka (body.y + eyeHeight) w kierunku yaw/pitch (PLAN §0). out = { ox,oy,oz, dx,dy,dz }, d znormalizowany. */
export function eyeRay(P, out) {
  const b = P.body;
  const cp = Math.cos(b.pitch);
  out.ox = b.x;
  out.oy = b.y + CONFIG.player.eyeHeight;
  out.oz = b.z;
  out.dx = -Math.sin(b.yaw) * cp;
  out.dy = Math.sin(b.pitch);
  out.dz = -Math.cos(b.yaw) * cp;
  return out;
}

/**
 * Wylot lufy: oko + CONFIG.weapon.muzzleOffset w układzie kamery (x prawo, y góra, z = −przód; Euler YXZ yaw→pitch).
 * out = { x, y, z }.
 */
export function muzzlePoint(P, out) {
  const b = P.body;
  const o = CONFIG.weapon.muzzleOffset;
  const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw);
  const sp = Math.sin(b.pitch), cp = Math.cos(b.pitch);
  // prawo r, góra u, przód f
  const rx = cy, rz = -sy;
  const ux = sy * sp, uy = cp, uz = cy * sp;
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const ox = o[0], oy = o[1], of = -o[2];
  out.x = b.x + rx * ox + ux * oy + fx * of;
  out.y = b.y + CONFIG.player.eyeHeight + uy * oy + fy * of;
  out.z = b.z + rz * ox + uz * oy + fz * of;
  return out;
}

// Skalary przekazywane między funkcjami przez Float64Array (argumenty/wyniki double w nie-inline'owanych
// wywołaniach V8 pakuje w HeapNumber = alokacja). Eksportowane funkcje z kontraktu PLAN §7.4 to cienkie nakładki.
const S = new Float64Array(8);
const S_OX = 0, S_OY = 1, S_OZ = 2, S_DX = 3, S_DY = 4, S_DZ = 5, S_MAX = 6, S_T = 7;
const HP3 = new Float64Array(3); // punkt trafienia

/** Promień z S[ox..dz] (d znormalizowany) vs kapsuła P, do S[S_MAX]. true → S[S_T] = odległość wejścia. */
function capsuleHitS(P) {
  const C = CONFIG.combat;
  const R = C.hitCapsuleRadius;
  const R2 = R * R;
  const b = P.body;
  const ox = S[S_OX], oy = S[S_OY], oz = S[S_OZ];
  const dx = S[S_DX], dy = S[S_DY], dz = S[S_DZ];
  let ya = b.y + C.hitCapsuleBottom + R;
  let yb = b.y + C.hitCapsuleTop - R;
  if (yb < ya) { const m = (ya + yb) * 0.5; ya = m; yb = m; }
  const mx = ox - b.x;
  const mz = oz - b.z;
  const cyc = oy < ya ? ya : oy > yb ? yb : oy;
  const myc = oy - cyc;
  if (mx * mx + myc * myc + mz * mz <= R2) { S[S_T] = 0; return true; }

  const aa = dx * dx + dy * dy + dz * dz;
  let best = Infinity;
  // walec (nieskończony w Y), wejście w zakresie osi
  const a = dx * dx + dz * dz;
  if (a > EPS) {
    const hb = mx * dx + mz * dz;
    const c = mx * mx + mz * mz - R2;
    const disc = hb * hb - a * c;
    if (disc >= 0) {
      const t = (-hb - Math.sqrt(disc)) / a;
      if (t >= 0) {
        const y = oy + dy * t;
        if (y >= ya && y <= yb) best = t;
      }
    }
  }
  // półsfery
  for (let k = 0; k < 2; k++) {
    const my = oy - (k === 0 ? ya : yb);
    const hb = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - R2;
    if (c > 0 && hb > 0) continue;
    const disc = hb * hb - aa * c;
    if (disc < 0) continue;
    const t = (-hb - Math.sqrt(disc)) / aa;
    if (t >= 0 && t < best) best = t;
  }
  if (best > S[S_MAX]) return false;
  S[S_T] = best;
  return true;
}

/**
 * Promień (d znormalizowany) vs pionowa kapsuła uczestnika. Zwraca odległość wejścia ≤ maxDist lub -1.
 * Początek promienia wewnątrz kapsuły → 0.
 */
export function rayVsParticipant(P, ox, oy, oz, dx, dy, dz, maxDist) {
  S[S_OX] = ox; S[S_OY] = oy; S[S_OZ] = oz;
  S[S_DX] = dx; S[S_DY] = dy; S[S_DZ] = dz;
  S[S_MAX] = maxDist;
  return capsuleHitS(P) ? S[S_T] : -1;
}

/** Najbliższy sensor do punktu HP3. */
function nearestSensorS(P) {
  const b = P.body;
  const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw);
  const lx = HP3[0] - b.x, ly = HP3[1] - b.y, lz = HP3[2] - b.z;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < 4; i++) {
    const sx = SENSOR_OFFSETS[i * 3];
    const syo = SENSOR_OFFSETS[i * 3 + 1];
    const sz = SENSOR_OFFSETS[i * 3 + 2];
    // świat = prawo*sx + przód*sz; prawo = (cy,0,-sy), przód = (-sy,0,-cy)
    const wx = cy * sx - sy * sz;
    const wz = -sy * sx - cy * sz;
    const ex = lx - wx, ey = ly - syo, ez = lz - wz;
    const d = ex * ex + ey * ey + ez * ez;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return bestI;
}

/** Najbliższy segment kamizelki (SENSOR) do punktu; offsety sensorów obrócone o body.yaw. */
export function nearestSensor(P, x, y, z) {
  HP3[0] = x; HP3[1] = y; HP3[2] = z;
  return nearestSensorS(P);
}

// --- strzał

/**
 * Hitscan strzelca: świat ogranicza zasięg, potem najbliższy trafiony uczestnik (pomija siebie, wyeliminowanych,
 * sojuszników przy !friendlyFire). Zawsze emituje SHOT; przy trafieniu applyHit (HIT/ELIM). Strzał kończy ochronę strzelca.
 */
export function resolveShot(sim, shooter) {
  if (shooter.protectTimer > 0) {
    shooter.protectTimer = 0;
    const pe = emit(sim, EV.PROTECT_END, shooter.id, -1, shooter.team);
    pe.value = 1;
  }
  shooter.stats.shots++;

  eyeRay(shooter, ER);
  S[S_OX] = ER.ox; S[S_OY] = ER.oy; S[S_OZ] = ER.oz;
  S[S_DX] = ER.dx; S[S_DY] = ER.dy; S[S_DZ] = ER.dz;
  S[S_MAX] = CONFIG.weapon.range;
  if (raycastWorld(sim.world, ER.ox, ER.oy, ER.oz, ER.dx, ER.dy, ER.dz, S[S_MAX], WHIT)) S[S_MAX] = WHIT.dist;

  let target = null;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) {
    const P = ps[i];
    if (P === shooter || P.state !== 'alive' || passesThrough(sim, shooter, P)) continue;
    if (capsuleHitS(P) && S[S_T] < S[S_MAX]) { S[S_MAX] = S[S_T]; target = P; }
  }

  HP3[0] = S[S_OX] + S[S_DX] * S[S_MAX];
  HP3[1] = S[S_OY] + S[S_DY] * S[S_MAX];
  HP3[2] = S[S_OZ] + S[S_DZ] * S[S_MAX];
  muzzlePoint(shooter, MZ);

  const r = emit(sim, EV.SHOT, shooter.id, target === null ? -1 : target.id, shooter.team);
  r.x = MZ.x; r.y = MZ.y; r.z = MZ.z;
  r.x2 = HP3[0]; r.y2 = HP3[1]; r.z2 = HP3[2];
  if (target === null) return;
  const sensor = nearestSensorS(target);
  r.sensor = sensor;
  if (target.protectTimer > 0) {
    r.value = 2;
    return;
  }
  r.value = 1;
  applyHitS(sim, shooter, target, sensor);
}

/**
 * Trafienie: chroniony/wyeliminowany cel → brak efektu (false). Inaczej hp − damage, błysk sensora, punkty,
 * HIT (+ ELIM przy 0 HP). lastHitDirX/Z = jednostkowy kierunek XZ od celu do strzelca (wskaźnik trafienia).
 */
export function applyHit(sim, shooter, target, sensor, hx, hy, hz) {
  HP3[0] = hx; HP3[1] = hy; HP3[2] = hz;
  return applyHitS(sim, shooter, target, sensor);
}

/** applyHit z punktem trafienia w HP3. */
function applyHitS(sim, shooter, target, sensor) {
  const C = CONFIG.combat;
  if (target.state !== 'alive' || target.protectTimer > 0) return false;
  target.hp -= C.damage;
  if (target.hp < 0) target.hp = 0;
  target.sensorsLit = target.hp;
  target.sensorFlash[sensor] = C.hitFlashTime;
  target.lastHitBy = shooter.id;
  target.lastHitTime = sim.time;
  const ddx = shooter.body.x - target.body.x;
  const ddz = shooter.body.z - target.body.z;
  const dl = Math.sqrt(ddx * ddx + ddz * ddz);
  if (dl > 1e-6) {
    target.lastHitDirX = ddx / dl;
    target.lastHitDirZ = ddz / dl;
  } else {
    target.lastHitDirX = 0;
    target.lastHitDirZ = 0;
  }
  awardHit(sim, shooter, target);

  const r = emit(sim, EV.HIT, shooter.id, target.id, shooter.team);
  r.sensor = sensor;
  r.x = HP3[0]; r.y = HP3[1]; r.z = HP3[2];
  muzzlePoint(shooter, MZ);
  r.x2 = MZ.x; r.y2 = MZ.y; r.z2 = MZ.z;
  r.value = target.hp;

  if (target.hp <= 0) eliminate(sim, shooter, target);
  return true;
}

/** 0 HP → stan eliminated na eliminatedTime; ciało zatrzymane; punkty; ELIM. */
export function eliminate(sim, shooter, target) {
  target.state = 'eliminated';
  target.stateTimer = CONFIG.combat.eliminatedTime;
  target.hp = 0;
  target.sensorsLit = 0;
  target.protectTimer = 0;
  stopBody(target.body);
  awardElim(sim, shooter, target);
  const r = emit(sim, EV.ELIM, shooter.id, target.id, shooter.team);
  r.x = target.body.x; r.y = target.body.y; r.z = target.body.z;
}

function stopBody(b) {
  b.vx = 0; b.vy = 0; b.vz = 0;
}

// --- stan / respawn

/** Timery: błyski sensorów, eliminacja → respawn, ochrona → PROTECT_END(value 0). */
export function stepParticipantState(sim, P, dt) {
  const f = P.sensorFlash;
  for (let i = 0; i < 4; i++) {
    if (f[i] > 0) { f[i] -= dt; if (f[i] < 0) f[i] = 0; }
  }
  if (P.state !== 'alive') {
    stopBody(P.body);
    P.stateTimer -= dt;
    if (P.stateTimer <= 0) respawn(sim, P);
    return;
  }
  if (P.protectTimer > 0) {
    P.protectTimer -= dt;
    if (P.protectTimer <= 0) {
      P.protectTimer = 0;
      const r = emit(sim, EV.PROTECT_END, P.id, -1, P.team);
      r.value = 0;
    }
  }
}

/** Respawn na pickSpawn: pełne HP, 4 sensory, ochrona protectionTime, broń wyzerowana, RESPAWN. */
export function respawn(sim, P) {
  const sp = pickSpawn(sim, P);
  if (sp !== null) placeAt(P, sp.x, sp.y, sp.z, sp.yaw);
  resetVitals(P);
  P.protectTimer = CONFIG.combat.protectionTime;
  resetWeapon(P.weapon);
  const r = emit(sim, EV.RESPAWN, P.id, -1, P.team);
  r.x = P.body.x; r.y = P.body.y; r.z = P.body.z;
}

function spawnAllowed(sim, P, sp) {
  return sim.teamCount <= 0 || P.team < 0 || sp.team % sim.teamCount === P.team;
}

// scratch pickSpawn: [bestVis, bestAny, ties]
const PS = new Float64Array(3);

/**
 * Punkt startowy najdalszy od żywych wrogów, którzy go widzą (linia wzroku oko→oko); remis/brak widzących →
 * najdalszy od wszystkich żywych uczestników; dalszy remis → losowo przez sim.rng.
 * Tryb drużynowy (sim.teamCount > 0, team ≥ 0): tylko spawny z sp.team % teamCount === P.team (brak → wszystkie).
 * Zwraca element world.spawns (lub null, gdy mapa nie ma spawnów).
 */
export function pickSpawn(sim, P) {
  const spawns = sim.world.spawns;
  if (spawns.length === 0) return null;
  let anyAllowed = false;
  for (let i = 0; i < spawns.length; i++) {
    if (spawnAllowed(sim, P, spawns[i])) { anyAllowed = true; break; }
  }
  const eye = CONFIG.player.eyeHeight;
  const ps = sim.participants;
  let best = null;
  PS[0] = -1; PS[1] = -1; PS[2] = 0;
  for (let i = 0; i < spawns.length; i++) {
    const sp = spawns[i];
    if (anyAllowed && !spawnAllowed(sim, P, sp)) continue;
    let vis = Infinity;
    let any = Infinity;
    for (let j = 0; j < ps.length; j++) {
      const Q = ps[j];
      if (Q === P || Q.state !== 'alive') continue;
      const qb = Q.body;
      const dx = qb.x - sp.x, dy = qb.y - sp.y, dz = qb.z - sp.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < any) any = d2;
      if (d2 < vis && isEnemy(P, Q) &&
          segmentClear(sim.world, qb.x, qb.y + eye, qb.z, sp.x, sp.y + eye, sp.z)) vis = d2;
    }
    if (best === null || vis > PS[0] || (vis === PS[0] && any > PS[1])) {
      best = sp; PS[0] = vis; PS[1] = any; PS[2] = 1;
    } else if (vis === PS[0] && any === PS[1]) {
      PS[2] += 1;
      if (sim.rng.int(1, PS[2] | 0) === 1) best = sp; // reservoir: równomiernie wśród remisów (int → bez HeapNumber)
    }
  }
  return best;
}
