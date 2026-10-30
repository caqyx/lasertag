// Uczestnik meczu (PLAN §7.2): stan (ciało, HP, broń, drużyna, statystyki) + wymienne InputSource.
// Czysty JS, bez three. Alokacje tylko przy tworzeniu.

import { CONFIG } from '../config.js';
import { createBody } from './movement.js';
import { createInputState } from './input/inputState.js';
import { createWeapon } from './weapon.js';

export const SENSOR = Object.freeze({ FRONT: 0, BACK: 1, LEFT: 2, RIGHT: 3 });

const SENSOR_KEYS = ['front', 'back', 'left', 'right'];

/** Offsety sensorów (x prawo, y od stóp, z przód) w kolejności SENSOR — Float64Array(12). */
export const SENSOR_OFFSETS = (() => {
  const a = new Float64Array(12);
  for (let i = 0; i < 4; i++) {
    const o = CONFIG.combat.sensors[SENSOR_KEYS[i]];
    a[i * 3] = o[0];
    a[i * 3 + 1] = o[1];
    a[i * 3 + 2] = o[2];
  }
  return a;
})();

/** Kolejność gaśnięcia segmentów jako indeksy SENSOR (CONFIG.combat.loseOrder: tył, lewe, prawe, przód). */
export const LOSE_ORDER = Int8Array.from(CONFIG.combat.loseOrder.map((k) => SENSOR_KEYS.indexOf(k)));

/** Rangi gaśnięcia: LOSE_RANK[sensor] = pozycja w LOSE_ORDER. */
const LOSE_RANK = (() => {
  const r = new Int8Array(4);
  for (let i = 0; i < 4; i++) r[LOSE_ORDER[i]] = i;
  return r;
})();

/**
 * Czy segment kamizelki świeci przy danej liczbie zapalonych (sensorsLit = HP).
 * Gaśnie zawsze pierwszy jeszcze zapalony wg LOSE_ORDER, więc segment świeci, gdy rank ≥ 4 − lit.
 */
export function isSensorLit(P, sensor) {
  return LOSE_RANK[sensor] >= 4 - P.sensorsLit;
}

/**
 * @param {{ id:number, name?:string, team?:number, color?:string, isPlayer?:boolean, inputSource?:object }} o
 * team: indeks drużyny ≥ 0 w trybach drużynowych; w FFA -1 (lub unikalny indeks).
 */
export function createParticipant(o) {
  const C = CONFIG.combat;
  // pola liczbowe inicjowane ułamkiem (reprezentacja double od startu), potem resetowane
  const P = {
    id: o.id | 0,
    name: o.name || `P${o.id | 0}`,
    team: o.team === undefined ? -1 : o.team | 0,
    color: o.color || CONFIG.colors.ffa[(o.id | 0) % CONFIG.colors.ffa.length],
    isPlayer: !!o.isPlayer,
    inputSource: o.inputSource || null,
    body: createBody(),
    input: createInputState(),
    prevX: 0.5, prevY: 0.5, prevZ: 0.5,
    hp: C.maxHp,
    state: 'alive',
    stateTimer: 0.5,
    protectTimer: 0.5,
    stunTimer: 0.5,           // D-016: hit stun — broń nieaktywna (s)
    weapon: createWeapon(),
    sensorFlash: new Float32Array(4),
    sensorsLit: C.maxHp,
    stats: { score: 0, hits: 0, elims: 0, deaths: 0, shots: 0 },
    lastHitBy: -1,
    lastHitTime: -1e9 - 0.5,   // double od startu (−1e9 to Smi → późniejsza zmiana mapy)
    lastHitDirX: 0.5,
    lastHitDirZ: 0.5,
  };
  resetVitals(P);
  P.prevX = 0; P.prevY = 0; P.prevZ = 0;
  P.lastHitDirX = 0; P.lastHitDirZ = 0;
  P.lastHitTime = -1e9;
  return P;
}

/** Pełne zdrowie, stan alive, wyczyszczone timery (bez zmiany pozycji). Nie alokuje. */
export function resetVitals(P) {
  P.hp = CONFIG.combat.maxHp;
  P.sensorsLit = P.hp;
  P.state = 'alive';
  P.stateTimer = 0;
  P.protectTimer = 0;
  P.stunTimer = 0;
  const f = P.sensorFlash;
  f[0] = 0; f[1] = 0; f[2] = 0; f[3] = 0;
}

/** Ustawia ciało w punkcie (x,y,z) z kątem yaw, zeruje prędkości i interpolację. Nie alokuje. */
export function placeAt(P, x, y, z, yaw) {
  const b = P.body;
  b.x = x; b.y = y; b.z = z;
  b.vx = 0; b.vy = 0; b.vz = 0;
  b.yaw = yaw; b.pitch = 0;
  b.onGround = true;
  b.crouch = 0; b.height = CONFIG.player.height; b.eyeHeight = CONFIG.player.eyeHeight; // respawn na stojąco
  P.input.crouch = false;
  P.prevX = x; P.prevY = y; P.prevZ = z;
  P.input.yaw = yaw;
  P.input.pitch = 0;
}

export function isAlive(P) {
  return P.state === 'alive';
}
