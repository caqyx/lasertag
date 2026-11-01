// Broń z przegrzewaniem (PLAN §7.3, SPEC §2.3, D-037). Czysty JS, bez alokacji w stepWeapon.
//
// Typy: CONFIG.weapons.{phaser,pistol,bouncer}; W.C = konfiguracja typu (stała przez cały mecz).
// heat ∈ [0,1]. Strzał: +heatPerShot, sinceShot = 0. Chłodzenie startuje po coolDelay od ostatniego strzału:
// coolRate/s, a w stanie przegrzania overheatCoolRate/s (to samo opóźnienie). heat ≥ 1 → overheated (blokada)
// aż heat < overheatRecover. cooldown = czas do następnego możliwego naciśnięcia; przy ciągłym ogniu nadwyżka
// kroku przechodzi na kolejny strzał (średnio dokładnie 1 / fireInterval), bez gromadzenia „zapasu" strzałów.
// Seria (C.burst > 1): naciśnięcie oddaje 1. strzał, kolejne co burstGap niezależnie od spustu (przerywa je
// przegrzanie lub cancelBurst — hit stun / eliminacja). semiAuto: strzał tylko na zboczu spustu (W.held = poprzedni stan).

import { CONFIG } from '../config.js';

export const WEAPON_TYPES = Object.freeze(Object.keys(CONFIG.weapons));

/** Poprawny identyfikator broni lub domyślny (fazer). */
export function weaponType(type) {
  return Object.prototype.hasOwnProperty.call(CONFIG.weapons, type) ? type : CONFIG.defaults.weapon;
}

/** Losowy typ broni z deterministycznego rng symulacji (boty przy starcie meczu). */
export function randomWeaponType(rng) {
  return WEAPON_TYPES[rng.int(0, WEAPON_TYPES.length - 1)];
}

export function createWeapon(type) {
  const t = weaponType(type);
  // 0.5 → pola od początku w reprezentacji double (brak migracji kształtu obiektu w pętli)
  const W = {
    type: t, C: CONFIG.weapons[t],
    heat: 0.5, cooldown: 0.5, sinceShot: 1e3, overheated: false,
    burstLeft: 0, burstTimer: 0.5, held: false,
  };
  resetWeapon(W);
  return W;
}

/** Stan początkowy (respawn). Typ broni bez zmian. */
export function resetWeapon(W) {
  W.heat = 0;
  W.cooldown = 0;
  W.sinceShot = 1e3;
  W.overheated = false;
  W.burstLeft = 0;
  W.burstTimer = 0;
  W.held = false;
}

/** Przerywa trwającą serię (hit stun, eliminacja). */
export function cancelBurst(W) {
  W.burstLeft = 0;
}

function cool(W, C, dt) {
  if (W.sinceShot < C.coolDelay) return;
  if (W.overheated) {
    W.heat -= C.overheatCoolRate * dt;
    if (W.heat < C.overheatRecover) W.overheated = false;
  } else {
    W.heat -= C.coolRate * dt;
  }
  if (W.heat < 0) W.heat = 0;
}

function shoot(W, C) {
  W.sinceShot = 0;
  W.heat += C.heatPerShot;
  if (W.heat >= 1) {
    W.heat = 1;
    W.overheated = true;
    W.burstLeft = 0;
  }
}

/**
 * @returns {boolean} true gdy w tym kroku padł strzał (wtedy W.overheated mogło właśnie przejść na true).
 */
export function stepWeapon(W, wantFire, dt) {
  const C = W.C;
  const press = wantFire && !(C.semiAuto && W.held);
  W.held = wantFire;
  W.sinceShot += dt;
  W.cooldown -= dt;
  cool(W, C, dt);
  // kontynuacja serii
  if (W.burstLeft > 0) {
    W.burstTimer -= dt;
    if (W.cooldown < 0) W.cooldown = 0;
    if (W.overheated || W.burstTimer > 0) return false;
    W.burstLeft--;
    W.burstTimer += C.burstGap;
    shoot(W, C);
    return true;
  }
  if (!press || W.overheated || W.cooldown > 0) {
    if (W.cooldown < 0) W.cooldown = 0;
    return false;
  }
  W.cooldown += C.fireInterval;
  if (W.cooldown < 0) W.cooldown = 0;
  if (C.burst > 1) {
    W.burstLeft = C.burst - 1;
    W.burstTimer = C.burstGap;
  }
  shoot(W, C);
  return true;
}
