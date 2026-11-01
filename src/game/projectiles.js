// Pociski wyrzutni odbijającej (D-037). Czysty JS, bez three, deterministyczne (stan tylko w sim), bez alokacji.
//
// Pula w sim.proj (typed arrays, pojemność CONFIG.weapons.bouncer.maxActive; brak wolnego slotu → nadpisany najstarszy).
// Lot prostoliniowy ze stałą prędkością (bez grawitacji — impuls lasera). Na krok: odcinek pozycja → pozycja + v·dt
// testowany względem uczestników (kapsuły jak hitscan: pomija strzelca, wyeliminowanych, sojuszników przy !friendlyFire)
// i świata (raycast: bryły OBB, rampy, podłoga, sufit — każda powierzchnia liczy się jako kontakt).
// 1. kontakt z powierzchnią → odbicie lustrzane v' = v − 2(v·n)n (BOUNCE), reszta drogi kroku po odbiciu;
// 2. kontakt → znika (PROJ_END value 0). Trafienie uczestnika → applyHit (HIT/ELIM), PROJ_END value 1 (2 = ochrona).
// Koniec życia (life) → PROJ_END value 3. Start: wylot lufy awatara (muzzlePoint), kierunek na punkt celowania
// z oka (raycast świata do zasięgu) — pocisk leci tam, gdzie patrzy strzelec; lufa w ścianie → start z oka.

import { CONFIG } from '../config.js';
import { raycastWorldBuf, RAYARG, segmentClearSeg, SEG, createHit } from '../world/physics.js';
import { EV } from '../core/events.js';
import { eyeRay, muzzlePoint, onFire, PROJ_RAY, projRayParticipant, projHit, HIT_SENSOR } from './combat.js';

const BC = CONFIG.weapons.bouncer;
const MAX_ITER = 3;           // segmenty drogi na krok (odbicie dzieli odcinek)
const MIN_AIM = 0.6;          // m — punkt celowania bliżej niż to od startu → kierunek z oka

export function createProjectiles(capacity = BC.maxActive) {
  const n = Math.max(1, capacity | 0);
  return {
    capacity: n,
    active: new Uint8Array(n),
    owner: new Int16Array(n),       // indeks w sim.participants
    bounces: new Int8Array(n),
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
    vx: new Float64Array(n), vy: new Float64Array(n), vz: new Float64Array(n),
    px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n),   // pozycja z poprzedniego kroku (render)
    sx: new Float64Array(n), sy: new Float64Array(n), sz: new Float64Array(n),   // początek bieżącego odcinka (start / odbicie)
    age: new Float64Array(n),
    birth: new Float64Array(n),     // sim.time wystrzału (render: identyfikacja / wygładzenie startu)
    next: 0,                        // pierścień: następny slot do sprawdzenia
    count: 0,                       // liczba aktywnych
  };
}

// --- scratch
const ER = { ox: 0.5, oy: 0.5, oz: 0.5, dx: 0.5, dy: 0.5, dz: 0.5 };
const MZ = { x: 0.5, y: 0.5, z: 0.5 };
const WH = createHit();
const V = new Float64Array(6);      // start xyz, kierunek xyz
const DIST = new Float64Array(1);   // droga na krok (double przez bufor, nie argument — D-012)

function emitP(sim, type, P) {
  const r = sim.events.push(type);
  r.time = sim.time;
  r.a = P.id;
  r.team = P.team;
  return r;
}

function findSlot(pr) {
  const n = pr.capacity;
  for (let k = 0; k < n; k++) {
    const i = (pr.next + k) % n;
    if (pr.active[i] === 0) { pr.next = (i + 1) % n; return i; }
  }
  const i = pr.next;          // pełna pula: nadpisz najstarszy w kolejności pierścienia
  pr.next = (i + 1) % n;
  pr.active[i] = 0;
  pr.count--;
  return i;
}

/** Start i kierunek pocisku → V. */
function aim(sim, P) {
  eyeRay(P, ER);
  RAYARG[0] = ER.ox; RAYARG[1] = ER.oy; RAYARG[2] = ER.oz;
  RAYARG[3] = ER.dx; RAYARG[4] = ER.dy; RAYARG[5] = ER.dz; RAYARG[6] = BC.range;
  const d = raycastWorldBuf(sim.world, WH) ? WH.dist : BC.range;
  const ax = ER.ox + ER.dx * d, ay = ER.oy + ER.dy * d, az = ER.oz + ER.dz * d;
  muzzlePoint(P, MZ);
  SEG[0] = ER.ox; SEG[1] = ER.oy; SEG[2] = ER.oz; SEG[3] = MZ.x; SEG[4] = MZ.y; SEG[5] = MZ.z;
  if (segmentClearSeg(sim.world)) { V[0] = MZ.x; V[1] = MZ.y; V[2] = MZ.z; }
  else { V[0] = ER.ox; V[1] = ER.oy; V[2] = ER.oz; }
  let dx = ax - V[0], dy = ay - V[1], dz = az - V[2];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < MIN_AIM) { dx = ER.dx; dy = ER.dy; dz = ER.dz; }
  else { dx /= len; dy /= len; dz /= len; }
  V[3] = dx; V[4] = dy; V[5] = dz;
}

/** Wystrzał pocisku przez uczestnika P (koniec ochrony, LAUNCH). */
export function launchProjectile(sim, P) {
  onFire(sim, P);
  const pr = sim.proj;
  const i = findSlot(pr);
  aim(sim, P);
  const sp = BC.speed;
  pr.active[i] = 1;
  pr.count++;
  pr.owner[i] = sim.participants.indexOf(P);
  pr.bounces[i] = 0;
  pr.x[i] = V[0]; pr.y[i] = V[1]; pr.z[i] = V[2];
  pr.px[i] = V[0]; pr.py[i] = V[1]; pr.pz[i] = V[2];
  pr.sx[i] = V[0]; pr.sy[i] = V[1]; pr.sz[i] = V[2];
  pr.vx[i] = V[3] * sp; pr.vy[i] = V[4] * sp; pr.vz[i] = V[5] * sp;
  pr.age[i] = 0;
  pr.birth[i] = sim.time;
  const r = emitP(sim, EV.LAUNCH, P);
  r.x = V[0]; r.y = V[1]; r.z = V[2];
  r.x2 = V[3]; r.y2 = V[4]; r.z2 = V[5];
  r.value = i;
}

function kill(pr, i) {
  pr.active[i] = 0;
  pr.count--;
}

function endEvent(sim, pr, i, P, value) {
  const r = emitP(sim, EV.PROJ_END, P);
  r.x = pr.x[i]; r.y = pr.y[i]; r.z = pr.z[i];
  const sp = BC.speed;
  r.x2 = pr.vx[i] / sp; r.y2 = pr.vy[i] / sp; r.z2 = pr.vz[i] / sp;
  r.value = value;
  return r;
}

/** Jeden krok wszystkich aktywnych pocisków. */
export function stepProjectiles(sim, dt) {
  const pr = sim.proj;
  if (pr.count === 0) return;
  const n = pr.capacity;
  for (let i = 0; i < n; i++) {
    if (pr.active[i] === 0) continue;
    pr.px[i] = pr.x[i]; pr.py[i] = pr.y[i]; pr.pz[i] = pr.z[i];
    pr.age[i] += dt;
    const P = sim.participants[pr.owner[i]];
    if (pr.age[i] > BC.life) {
      endEvent(sim, pr, i, P, 3);
      kill(pr, i);
      continue;
    }
    DIST[0] = BC.speed * dt;
    stepOne(sim, pr, i, P);
  }
}

function stepOne(sim, pr, i, P) {
  const sp = BC.speed;
  let rem = DIST[0];
  for (let it = 0; it < MAX_ITER && rem > 1e-9; it++) {
    const dx = pr.vx[i] / sp, dy = pr.vy[i] / sp, dz = pr.vz[i] / sp;
    const ox = pr.x[i], oy = pr.y[i], oz = pr.z[i];
    RAYARG[0] = ox; RAYARG[1] = oy; RAYARG[2] = oz; RAYARG[3] = dx; RAYARG[4] = dy; RAYARG[5] = dz; RAYARG[6] = rem;
    const wall = raycastWorldBuf(sim.world, WH);
    PROJ_RAY[0] = ox; PROJ_RAY[1] = oy; PROJ_RAY[2] = oz; PROJ_RAY[3] = dx; PROJ_RAY[4] = dy; PROJ_RAY[5] = dz;
    PROJ_RAY[6] = wall ? WH.dist : rem;
    const T = projRayParticipant(sim, P);
    if (T !== null) {
      const t = PROJ_RAY[6];
      pr.x[i] = ox + dx * t; pr.y[i] = oy + dy * t; pr.z[i] = oz + dz * t;
      const res = projHit(sim, P, T);
      const r = endEvent(sim, pr, i, P, res);
      r.b = T.id;
      r.sensor = HIT_SENSOR[0];
      kill(pr, i);
      return;
    }
    if (!wall) {
      pr.x[i] = ox + dx * rem; pr.y[i] = oy + dy * rem; pr.z[i] = oz + dz * rem;
      return;
    }
    // kontakt z powierzchnią: normalna zwrócona przeciw kierunkowi lotu
    let nx = WH.nx, ny = WH.ny, nz = WH.nz;
    if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
    const e = BC.surfaceEps;
    pr.x[i] = WH.x + nx * e; pr.y[i] = WH.y + ny * e; pr.z[i] = WH.z + nz * e;
    rem -= WH.dist;
    if (pr.bounces[i] >= BC.maxBounces) {
      const r = endEvent(sim, pr, i, P, 0);
      r.nx = nx; r.ny = ny; r.nz = nz;
      kill(pr, i);
      return;
    }
    const vn = pr.vx[i] * nx + pr.vy[i] * ny + pr.vz[i] * nz;
    pr.vx[i] -= 2 * vn * nx; pr.vy[i] -= 2 * vn * ny; pr.vz[i] -= 2 * vn * nz;
    pr.bounces[i]++;
    pr.sx[i] = pr.x[i]; pr.sy[i] = pr.y[i]; pr.sz[i] = pr.z[i];
    const r = emitP(sim, EV.BOUNCE, P);
    r.x = pr.x[i]; r.y = pr.y[i]; r.z = pr.z[i];
    r.nx = nx; r.ny = ny; r.nz = nz;
    r.x2 = pr.vx[i] / sp; r.y2 = pr.vy[i] / sp; r.z2 = pr.vz[i] / sp;
    r.value = i;
  }
}
