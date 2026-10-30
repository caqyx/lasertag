// Symulacja meczu (PLAN §7.6). Czysty JS, bez three; stepSim i wszystko, co woła, bez alokacji.
// Kolejki zdarzeń stepSim NIE czyści — robi to właściciel pętli raz na klatkę renderu.

import { CONFIG } from '../config.js';
import { createRng } from '../core/rng.js';
import { createEventQueue, EV } from '../core/events.js';
import { stepMovement } from './movement.js';
import { stepWeapon, resetWeapon } from './weapon.js';
import { resetVitals, placeAt } from './participant.js';
import { resolveShot, stepParticipantState, pickSpawn } from './combat.js';

/**
 * @param {{ world:object, seed?:number, friendlyFire?:boolean, teamCount?:number }} o
 *   teamCount > 0 → spawny drużynowe (sp.team % teamCount === P.team); 0 (domyślnie) → wszystkie spawny.
 */
export function createSim(o) {
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

/** Faza 3: broń i strzał (hitscan po ruchu wszystkich). */
function fireOne(sim, P, dt) {
  if (P.state !== 'alive') return;
  const W = P.weapon;
  const wasOver = W.overheated;
  if (stepWeapon(W, P.input.fire, dt)) resolveShot(sim, P);
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
 *   1) wejście wszystkich (na stanie z poprzedniego kroku), 2) stan + ruch wszystkich, 3) broń/strzały wszystkich.
 * W fazie 3 uczestnik wyeliminowany strzałem wcześniejszego w tablicy nie strzela już w tym kroku.
 */
export function stepSim(sim, dt) {
  sim.time += dt;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) sampleOne(sim, ps[i]);
  for (let i = 0; i < ps.length; i++) moveOne(sim, ps[i], dt);
  for (let i = 0; i < ps.length; i++) fireOne(sim, ps[i], dt);
}
