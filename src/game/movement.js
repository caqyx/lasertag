// Ruch FPP (PLAN §4). Czysty JS, bez three, bez alokacji w stepMovement.
// Konwencja: yaw=0 patrzy w −Z; przód = (-sin yaw, 0, -cos yaw), prawo = (cos yaw, 0, -sin yaw).

import { CONFIG } from '../config.js';
import { moveBody } from '../world/physics.js';

export function createBody() {
  const P = CONFIG.player;
  return {
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0,
    onGround: false,
    radius: P.radius,
    height: P.height,
  };
}

/**
 * input (InputState) → przyspieszenie poziome do walk/sprintSpeed (accelGround / accelAir), tarcie na ziemi bez wejścia,
 * skok gdy onGround, potem physics.moveBody.
 */
export function stepMovement(body, input, dt, world) {
  const P = CONFIG.player;
  body.yaw = input.yaw;
  body.pitch = input.pitch;

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
    const speed = input.sprint && mz > 0 ? P.sprintSpeed : P.walkSpeed;
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

  if (input.jump && onGround) {
    body.vy = P.jumpSpeed;
    body.onGround = false;
  }

  moveBody(world, body, dt);
}
