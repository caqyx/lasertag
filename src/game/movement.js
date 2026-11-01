// Ruch FPP (PLAN §4). Czysty JS, bez three, bez alokacji w stepMovement.
// Konwencja: yaw=0 patrzy w −Z; przód = (-sin yaw, 0, -cos yaw), prawo = (cos yaw, 0, -sin yaw).

import { CONFIG } from '../config.js';
import { moveBody, headroomOk, HEAD } from '../world/physics.js';

export function createBody() {
  const P = CONFIG.player;
  const b = {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    onGround: false,
    radius: P.radius,
    height: P.height,
    crouch: 0,              // 0 = stoi, 1 = pełny kuc (płynnie, CONFIG.player.crouchTime)
    eyeHeight: P.eyeHeight, // bieżąca wysokość oka nad stopami (zależna od crouch)
    // stamina (D-023, CONFIG.player.stamina). Literały 0.5 → pola od startu w reprezentacji double (bez przejść mapy);
    // właściwe wartości ustawia resetStamina.
    stamina: 0.5,           // 0..1
    staminaWait: 0.5,       // s do startu regeneracji (odliczane; ustawiane na regenDelay po sprincie/skoku)
    sprinting: false,       // czy w tym kroku faktycznie sprintuje
    exhausted: false,       // sprint zablokowany do odnowienia (stamina ≥ exhaustedRecover)
  };
  resetStamina(b);
  return b;
}

/** Pełna stamina (start, respawn, placeAt). Nie alokuje. */
export function resetStamina(body) {
  body.stamina = 1;
  body.staminaWait = 0;
  body.sprinting = false;
  body.exhausted = false;
}

// dt dla helperów staminy: przekazanie doubla do nie-inline'owanej funkcji = HeapNumber (D-012); trzymanie logiki
// staminy wprost w stepMovement powiększało funkcję tak, że V8 przestawał inline'ować moveBody (boxing dt).
const STEP = new Float64Array(1);

/**
 * Krok staminy (D-023). want — warunki sprintu z D-013 spełnione; idle — stoi lub kuca (regeneracja × regenIdleMul).
 * Zwraca, czy w tym kroku faktycznie sprintuje (i ustawia body.sprinting). dt w STEP[0].
 */
function stepStamina(body, want, idle) {
  const S = CONFIG.player.stamina;
  const dt = STEP[0];
  const sprinting = want && body.stamina > 0 && !body.exhausted;
  body.sprinting = sprinting;
  if (sprinting) {
    let st = body.stamina - S.drain * dt;
    if (st <= 0) { st = 0; body.exhausted = true; }
    body.stamina = st;
    body.staminaWait = S.regenDelay;
  } else if (body.staminaWait > 0) {
    let w = body.staminaWait - dt;
    if (w < 0) w = 0;
    body.staminaWait = w;
  } else if (body.stamina < 1) {
    let st = body.stamina + S.regen * (idle ? S.regenIdleMul : 1) * dt;
    if (st > 1) st = 1;
    body.stamina = st;
    if (body.exhausted && st >= S.exhaustedRecover) body.exhausted = false;
  }
  return sprinting;
}

/** Skok kosztuje jumpCost (D-023): false (bez zmian), gdy stamina < jumpCost. */
function payJump(body) {
  const S = CONFIG.player.stamina;
  if (body.stamina < S.jumpCost) return false;
  let st = body.stamina - S.jumpCost;
  if (st <= 0) { st = 0; body.exhausted = true; }
  body.stamina = st;
  body.staminaWait = S.regenDelay;
  return true;
}

/**
 * Wysokość oka nad stopami (zależna od kucu). Na gorącej ścieżce czytaj pole body.eyeHeight wprost (wynik double
 * z nie-inline'owanej funkcji V8 pakuje w HeapNumber); ta funkcja — dla wygody (kamera, UI, testy).
 */
export function eyeHeightOf(body) {
  return body.eyeHeight;
}

/**
 * input (InputState) → kuc (wysokość/oko), przyspieszenie poziome do walk/sprintSpeed (accelGround / accelAir; w kucu
 * × crouchSpeedMul, bez sprintu), tarcie na ziemi bez wejścia, skok gdy onGround i nie w kucu, potem physics.moveBody.
 * Stamina (D-023): sprint (warunki D-013) tylko gdy stamina > 0 i !exhausted, zużywa drain/s; przy 0 → exhausted do
 * stamina ≥ exhaustedRecover. Skok kosztuje jumpCost (niedostępny poniżej). Regeneracja po regenDelay bez sprintu/skoku,
 * × regenIdleMul stojąc lub w kucu.
 */
export function stepMovement(body, input, dt, world) {
  const P = CONFIG.player;
  body.yaw = input.yaw;
  body.pitch = input.pitch;
  // kuc (wpisany tutaj, nie w funkcji pomocniczej: przekazanie dt do nie-inline'owanej funkcji = HeapNumber):
  // body.crouch dąży do input.crouch z prędkością 1/crouchTime; wstawanie tylko, gdy nad głową jest miejsce
  {
    const rate = P.crouchTime > 0 ? dt / P.crouchTime : 1;
    let c = body.crouch;
    if (input.crouch === true) {
      c += rate;
      if (c > 1) c = 1;
    } else if (c > 0) {
      let n = c - rate;
      if (n < 0) n = 0;
      HEAD[0] = P.height + (P.crouchHeight - P.height) * n;
      if (headroomOk(world, body)) c = n;
    }
    body.crouch = c;
    body.height = P.height + (P.crouchHeight - P.height) * c;
    body.eyeHeight = P.eyeHeight + (P.crouchEyeHeight - P.eyeHeight) * c;
  }
  const crouching = body.crouch > 0;

  let mx = input.moveX || 0;
  let mz = input.moveZ || 0;
  const m2 = mx * mx + mz * mz;
  if (m2 > 1) {
    const inv = 1 / Math.sqrt(m2);
    mx *= inv;
    mz *= inv;
  }
  const hasInput = m2 > 1e-6;

  const sy = Math.sin(body.yaw);
  const cy = Math.cos(body.yaw);
  // kierunek w świecie: prawo * moveX + przód * moveZ
  const wx = cy * mx - sy * mz;
  const wz = -sy * mx - cy * mz;

  const onGround = body.onGround;
  // sprint tylko do przodu (przewaga składowej przód nad bokiem, D-013) i gdy stamina pozwala (D-023)
  STEP[0] = dt;
  const sprinting = stepStamina(body,
    hasInput && !crouching && input.sprint === true && mz > 0 && mz >= (mx < 0 ? -mx : mx), !hasInput || crouching);
  if (hasInput) {
    let speed = sprinting ? P.sprintSpeed : P.walkSpeed;
    // kuc: mnożnik prędkości liniowo z body.crouch
    if (crouching) speed *= 1 + (P.crouchSpeedMul - 1) * body.crouch;
    const tx = wx * speed;
    const tz = wz * speed;
    const ddx = tx - body.vx;
    const ddz = tz - body.vz;
    const dl = Math.sqrt(ddx * ddx + ddz * ddz);
    const maxDv = (onGround ? P.accelGround : P.accelAir) * dt;
    if (dl <= maxDv || dl < 1e-9) {
      body.vx = tx;
      body.vz = tz;
    } else {
      const f = maxDv / dl;
      body.vx += ddx * f;
      body.vz += ddz * f;
    }
  } else if (onGround) {
    const k = 1 - P.friction * dt;
    const f = k > 0 ? k : 0;
    body.vx *= f;
    body.vz *= f;
    if (body.vx * body.vx + body.vz * body.vz < 1e-6) { body.vx = 0; body.vz = 0; }
  }

  if (input.jump && onGround && !crouching && payJump(body)) {
    body.vy = P.jumpSpeed;
    body.onGround = false;
  }

  moveBody(world, body, dt);
}
