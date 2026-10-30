// Ruch FPP (PLAN §4). Czysty JS, bez three, bez alokacji w stepMovement.
// Konwencja: yaw=0 patrzy w −Z; przód = (-sin yaw, 0, -cos yaw), prawo = (cos yaw, 0, -sin yaw).

import { CONFIG } from '../config.js';
import { moveBody, headroomOk, HEAD } from '../world/physics.js';

export function createBody() {
  const P = CONFIG.player;
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    onGround: false,
    radius: P.radius,
    height: P.height,
    crouch: 0,              // 0 = stoi, 1 = pełny kuc (płynnie, CONFIG.player.crouchTime)
    eyeHeight: P.eyeHeight, // bieżąca wysokość oka nad stopami (zależna od crouch)
  };
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
  if (hasInput) {
    // sprint tylko do przodu (przewaga składowej przód nad bokiem)
    let speed = !crouching && input.sprint && mz > 0 && mz >= (mx < 0 ? -mx : mx) ? P.sprintSpeed : P.walkSpeed;
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

  if (input.jump && onGround && !crouching) {
    body.vy = P.jumpSpeed;
    body.onGround = false;
  }

  moveBody(world, body, dt);
}
