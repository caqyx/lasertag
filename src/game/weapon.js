// Fazer z przegrzewaniem (PLAN §7.3, SPEC §2.3). Czysty JS, bez alokacji w stepWeapon.
//
// heat ∈ [0,1]. Strzał: +heatPerShot, sinceShot = 0. Chłodzenie startuje po coolDelay od ostatniego strzału:
// coolRate/s, a w stanie przegrzania overheatCoolRate/s (to samo opóźnienie). heat ≥ 1 → overheated (blokada)
// aż heat < overheatRecover. cooldown = czas do następnego możliwego strzału; przy ciągłym ogniu nadwyżka
// kroku przechodzi na kolejny strzał (średnio dokładnie 1 / fireInterval), bez gromadzenia „zapasu" strzałów.

import { CONFIG } from '../config.js';

export function createWeapon() {
  // 0.5 → pola od początku w reprezentacji double (brak migracji kształtu obiektu w pętli)
  const W = { heat: 0.5, cooldown: 0.5, sinceShot: 1e3, overheated: false };
  resetWeapon(W);
  return W;
}

/** Stan początkowy (respawn). */
export function resetWeapon(W) {
  W.heat = 0;
  W.cooldown = 0;
  W.sinceShot = 1e3;
  W.overheated = false;
}

function cool(W, dt) {
  const C = CONFIG.weapon;
  if (W.sinceShot < C.coolDelay) return;
  if (W.overheated) {
    W.heat -= C.overheatCoolRate * dt;
    if (W.heat < C.overheatRecover) W.overheated = false;
  } else {
    W.heat -= C.coolRate * dt;
  }
  if (W.heat < 0) W.heat = 0;
}

/**
 * @returns {boolean} true gdy w tym kroku padł strzał (wtedy W.overheated mogło właśnie przejść na true).
 */
export function stepWeapon(W, wantFire, dt) {
  const C = CONFIG.weapon;
  W.sinceShot += dt;
  W.cooldown -= dt;
  cool(W, dt);
  if (!wantFire || W.overheated || W.cooldown > 0) {
    if (W.cooldown < 0) W.cooldown = 0;
    return false;
  }
  W.cooldown += C.fireInterval;
  if (W.cooldown < 0) W.cooldown = 0;
  W.sinceShot = 0;
  W.heat += C.heatPerShot;
  if (W.heat >= 1) {
    W.heat = 1;
    W.overheated = true;
  }
  return true;
}
