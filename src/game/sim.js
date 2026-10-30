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

function stepOne(sim, P, dt) {
  const b = P.body;
  P.prevX = b.x; P.prevY = b.y; P.prevZ = b.z;
  if (P.inputSource !== null) P.inputSource.sample(P, sim, P.input);
  stepParticipantState(sim, P, dt);
  if (P.state !== 'alive') return;
  stepMovement(b, P.input, dt, sim.world);
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

/** Jeden stały krok: dla każdego uczestnika input → stan/timery → ruch → broń → strzał. */
export function stepSim(sim, dt) {
  sim.time += dt;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) stepOne(sim, ps[i], dt);
}
