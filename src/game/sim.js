// Symulacja meczu (PLAN §7.6). Czysty JS, bez three; stepSim i wszystko, co woła, bez alokacji.
// Kolejki zdarzeń stepSim NIE czyści — robi to właściciel pętli raz na klatkę renderu.

import { CONFIG } from '../config.js';
import { createRng } from '../core/rng.js';
import { createEventQueue, EV } from '../core/events.js';
import { stepMovement } from './movement.js';
import { resolveBodyWalls } from '../world/physics.js';
import { stepWeapon, resetWeapon } from './weapon.js';
import { resetVitals, placeAt } from './participant.js';
import { resolveShot, stepParticipantState, pickSpawn } from './combat.js';
import { resetDoors, stepDoors } from './doors.js';

/**
 * @param {{ world:object, seed?:number, friendlyFire?:boolean, teamCount?:number }} o
 *   teamCount > 0 → spawny drużynowe (sp.team % teamCount === P.team); 0 (domyślnie) → wszystkie spawny.
 */
export function createSim(o) {
  resetDoors(o.world, 0);   // drzwi przesuwne: poza z czasu 0 (świat współdzielony między meczami)
  const nTeams = CONFIG.colors.ffa.length;
  const teams = [];
  for (let t = 0; t < nTeams; t++) teams.push({ score: 0, elims: 0, deaths: 0 });
  return {
    world: o.world,
    rng: createRng(o.seed === undefined ? 1 : o.seed),
    participants: [],
    events: createEventQueue(CONFIG.combat.eventCapacity),
    time: 0,
    teams,
    friendlyFire: o.friendlyFire === undefined ? CONFIG.combat.friendlyFire : !!o.friendlyFire,
    teamCount: o.teamCount | 0,
  };
}

/** Dodaje uczestnika i stawia go na spawnie (pickSpawn): alive, pełne HP, bez ochrony, broń wyzerowana. */
export function addParticipant(sim, P) {
  resetVitals(P);
  resetWeapon(P.weapon);
  const sp = pickSpawn(sim, P);
  if (sp !== null) placeAt(P, sp.x, sp.y, sp.z, sp.yaw);
  sim.participants.push(P);
  return P;
}

/** Id → uczestnik (lub null). Bez alokacji. */
export function findParticipant(sim, id) {
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i];
  return null;
}

const TWO_PI = Math.PI * 2;

/**
 * Sanityzacja wejścia (fundament pod M5 — wejście z sieci jest niezaufane). W miejscu, bez alokacji:
 * moveX/moveZ: nie-skończone → 0, clamp [-1, 1]; pitch: nie-skończone → poprzedni body.pitch, clamp ±pitchLimit;
 * yaw: nie-skończone → poprzedni body.yaw, poza [-π, π] zawijany do [-π, π); flagi → boolean.
 */
export function sanitizeInput(P) {
  const inp = P.input;
  const b = P.body;
  let v = inp.moveX;
  inp.moveX = !(v === v && v !== Infinity && v !== -Infinity) ? 0 : v > 1 ? 1 : v < -1 ? -1 : v;
  v = inp.moveZ;
  inp.moveZ = !(v === v && v !== Infinity && v !== -Infinity) ? 0 : v > 1 ? 1 : v < -1 ? -1 : v;
  const lim = CONFIG.player.pitchLimit;
  v = inp.pitch;
  if (!(v === v && v !== Infinity && v !== -Infinity)) v = b.pitch;
  inp.pitch = v > lim ? lim : v < -lim ? -lim : v;
  v = inp.yaw;
  if (!(v === v && v !== Infinity && v !== -Infinity)) v = b.yaw;
  if (v > Math.PI || v < -Math.PI) v -= TWO_PI * Math.floor((v + Math.PI) / TWO_PI);
  inp.yaw = v;
  inp.fire = inp.fire === true;
  inp.jump = inp.jump === true;
  inp.sprint = inp.sprint === true;
  inp.crouch = inp.crouch === true;
}

/** Faza 1: zapamiętaj pozycję sprzed kroku, pobierz i zsanityzuj wejście. */
function sampleOne(sim, P) {
  const b = P.body;
  P.prevX = b.x; P.prevY = b.y; P.prevZ = b.z;
  if (P.inputSource !== null) P.inputSource.sample(P, sim, P.input);
  sanitizeInput(P);
}

/** Faza 2: stan/timery (eliminacja, respawn, ochrona) i ruch. */
function moveOne(sim, P, dt) {
  stepParticipantState(sim, P, dt);
  if (P.state !== 'alive') return;
  stepMovement(P.body, P.input, dt, sim.world);
}

const SEPARATION_PASSES = 3;   // iteracje rozpychania (n ≤ 16 → O(n²) tanio)
const SEP_EPS = 1e-4;          // m — zapas po rozepchnięciu

/**
 * Separacja ciał żywych uczestników: koło vs koło w XZ, gdy zakresy Y [y, y+height] się nakładają; rozpychani po połowie.
 * Ciała wyeliminowanych nie blokują (D-018). Składowa prędkości „w siebie" usuwana, potem ponowne
 * rozwiązanie kolizji ze ścianami (żeby nie wepchnąć w ścianę). Bez alokacji.
 */
function separateParticipants(sim) {
  const ps = sim.participants;
  const n = ps.length;
  for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
    let any = false;
    for (let i = 0; i < n; i++) {
      const A = ps[i];
      const a = A.body;
      if (A.state !== 'alive') continue;   // D-018: wyeliminowani nie blokują żywych
      for (let j = i + 1; j < n; j++) {
        const B = ps[j];
        if (B.state !== 'alive') continue;
        const b = B.body;
        if (a.y >= b.y + b.height || b.y >= a.y + a.height) continue;
        let dx = a.x - b.x;
        let dz = a.z - b.z;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-9) { dx = A.id < B.id ? 1 : -1; dz = 0; d = 1; } // pokrywające się środki: deterministyczny kierunek
        const nx = dx / d;
        const nz = dz / d;
        const pen = rr - (d2 < 1e-18 ? 0 : d) + SEP_EPS;
        const wa = 0.5, wb = 0.5;
        if (wa > 0) {
          a.x += nx * pen * wa; a.z += nz * pen * wa;
          const vn = a.vx * nx + a.vz * nz;
          if (vn < 0) { a.vx -= vn * nx; a.vz -= vn * nz; }
          resolveBodyWalls(sim.world, a);
        }
        if (wb > 0) {
          b.x -= nx * pen * wb; b.z -= nz * pen * wb;
          const vn = b.vx * nx + b.vz * nz;
          if (vn > 0) { b.vx -= vn * nx; b.vz -= vn * nz; }
          resolveBodyWalls(sim.world, b);
        }
        // ściana cofnęła któreś ciało → resztę nachodzenia przejmuje drugie (żywe), znów z rozwiązaniem ścian
        if (wa > 0 && wb > 0) {
          const ex = a.x - b.x, ez = a.z - b.z;
          const e2 = ex * ex + ez * ez;
          if (e2 < rr * rr) {
            const e = Math.sqrt(e2);
            const res = rr - e + SEP_EPS;
            const mx = e > 1e-9 ? ex / e : nx, mz = e > 1e-9 ? ez / e : nz;
            // przesuń to ciało, które ściana mniej zablokowała (sprawdzamy oba kierunki po kolei)
            const ax0 = a.x, az0 = a.z;
            a.x += mx * res; a.z += mz * res;
            resolveBodyWalls(sim.world, a);
            const fx = a.x - b.x, fz = a.z - b.z;
            if (fx * fx + fz * fz < rr * rr - 1e-9) {
              a.x = ax0; a.z = az0;
              b.x -= mx * res; b.z -= mz * res;
              resolveBodyWalls(sim.world, b);
            }
          }
        }
        any = true;
      }
    }
    if (!any) break;
  }
}

/** Faza 3: broń i strzał (hitscan po ruchu wszystkich). */
function fireOne(sim, P, dt) {
  if (P.state !== 'alive') return;
  const W = P.weapon;
  const wasOver = W.overheated;
  // hit stun (D-016): trafiony ma fazer nieaktywny, dopóki P.stunTimer > 0 (brak pola = 0)
  if (stepWeapon(W, P.input.fire && !(P.stunTimer > 0), dt)) resolveShot(sim, P);
  if (!wasOver && W.overheated) {
    const r = sim.events.push(EV.OVERHEAT);
    r.time = sim.time;
    r.a = P.id;
    r.team = P.team;
    r.value = W.heat;
  }
}

/**
 * Jeden stały krok w trzech fazach (bez przewagi kolejności uczestników w ruchu/celowaniu):
 *   1) wejście wszystkich (na stanie z poprzedniego kroku), 2) stan + ruch wszystkich + rozepchnięcie ciał,
 *   3) broń/strzały wszystkich.
 * W fazie 3 uczestnik wyeliminowany strzałem wcześniejszego w tablicy nie strzela już w tym kroku.
 */
export function stepSim(sim, dt) {
  sim.time += dt;
  stepDoors(sim, dt);   // drzwi przesuwne przed ruchem (czujnik widzi pozycje z poprzedniego kroku)
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) sampleOne(sim, ps[i]);
  for (let i = 0; i < ps.length; i++) moveOne(sim, ps[i], dt);
  separateParticipants(sim);
  for (let i = 0; i < ps.length; i++) fireOne(sim, ps[i], dt);
}
