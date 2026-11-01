// Testy src/game/movement.js (+ inputState): przyspieszenie do walk/sprint (dokładnie, bez przekroczenia), przekątne,
// tarcie, skok tylko na ziemi, konwencja yaw (0 → −Z, π/2 → −X), sprint tylko do przodu, sterowanie w powietrzu,
// kucanie, stamina (D-023: drain/regen/exhausted/koszt skoku/respawn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { createBody, stepMovement } from '../../src/game/movement.js';
import { createInputState, resetInputState } from '../../src/game/input/inputState.js';
import { CONFIG } from '../../src/config.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';

const P = CONFIG.player;
const DT = 1 / CONFIG.sim.hz;
const world = buildWorld({
  id: 't', name: 't', seed: 1, size: { w: 200, d: 200 }, ceiling: 10, perimeter: { h: 10 }, walls: [], ramps: [], spawns: [], cams: [],
});

function setup(inp = {}) {
  const body = createBody();
  const input = Object.assign(createInputState(), inp);
  stepMovement(body, createInputState(), DT, world); // ustala onGround
  return { body, input };
}
const hspeed = (b) => Math.hypot(b.vx, b.vz);
function run(body, input, n) { const sp = []; for (let i = 0; i < n; i++) { stepMovement(body, input, DT, world); sp.push(hspeed(body)); } return sp; }

test('createBody / createInputState: pola wg kontraktu PLAN §4', () => {
  const b = createBody();
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'yaw', 'pitch']) assert.equal(b[k], 0);
  assert.equal(b.radius, P.radius);
  assert.equal(b.height, P.height);
  assert.equal(typeof b.onGround, 'boolean');
  const s = createInputState();
  assert.deepEqual(s, { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, jump: false, sprint: false, crouch: false, scoreboard: false });
  Object.assign(s, { moveX: 1, moveZ: -1, yaw: 2, pitch: 0.3, fire: true, jump: true, sprint: true, crouch: true, scoreboard: true });
  resetInputState(s);
  assert.deepEqual(s, { moveX: 0, moveZ: 0, yaw: 2, pitch: 0.3, fire: false, jump: false, sprint: false, crouch: false, scoreboard: false }, 'reset zachowuje yaw/pitch');
});

test('ciało na ziemi po pierwszym kroku; yaw/pitch przepisane z wejścia', () => {
  const { body, input } = setup({ yaw: 1.2, pitch: -0.4 });
  assert.equal(body.onGround, true);
  stepMovement(body, input, DT, world);
  assert.equal(body.yaw, 1.2);
  assert.equal(body.pitch, -0.4);
});

test('przyspieszenie do walkSpeed: monotoniczne, czas ≈ v/accel, dokładnie walkSpeed, nigdy ponad', () => {
  const { body, input } = setup({ moveZ: 1 });
  const sp = run(body, input, 60);
  for (let i = 1; i < sp.length; i++) assert.ok(sp[i] >= sp[i - 1] - 1e-12);
  for (const s of sp) assert.ok(s <= P.walkSpeed + 1e-12, `przekroczenie: ${s}`);
  assert.equal(sp.at(-1), P.walkSpeed);
  const reach = sp.findIndex((s) => s === P.walkSpeed) + 1;
  assert.equal(reach, Math.ceil(P.walkSpeed / (P.accelGround * DT) - 1e-9), `osiągnięte po ${reach} krokach`);
  // przemieszczenie po osiągnięciu prędkości = v·dt na krok
  const z0 = body.z;
  stepMovement(body, input, DT, world);
  assert.ok(Math.abs(z0 - body.z - P.walkSpeed * DT) < 1e-9);
});

test('sprint do przodu: dokładnie sprintSpeed, bez przekroczenia; puszczenie sprintu hamuje do walkSpeed', () => {
  const { body, input } = setup({ moveZ: 1, sprint: true });
  const sp = run(body, input, 60);
  for (const s of sp) assert.ok(s <= P.sprintSpeed + 1e-12);
  assert.equal(sp.at(-1), P.sprintSpeed);
  input.sprint = false;
  const sp2 = run(body, input, 30);
  for (let i = 1; i < sp2.length; i++) assert.ok(sp2[i] <= sp2[i - 1] + 1e-12);
  assert.equal(sp2.at(-1), P.walkSpeed);
  for (const s of sp2) assert.ok(s >= P.walkSpeed - 1e-12, 'przestrzelenie w dół przy hamowaniu');
});

test('sprint tylko do przodu: tył i czysty strafe → walkSpeed; przód-skos → sprintSpeed', () => {
  for (const [mx, mz, exp] of [[0, -1, P.walkSpeed], [1, 0, P.walkSpeed], [-1, 0, P.walkSpeed], [1, -1, P.walkSpeed], [1, 1, P.sprintSpeed], [0, 1, P.sprintSpeed]]) {
    const { body, input } = setup({ moveX: mx, moveZ: mz, sprint: true });
    const sp = run(body, input, 60);
    assert.ok(Math.abs(sp.at(-1) - exp) < 1e-9, `(${mx},${mz}): ${sp.at(-1)} ≠ ${exp}`);
  }
});

test('WĄTPLIWE: sprint przy niemal czystym strafe (moveZ=0.05) daje pełne sprintSpeed bokiem', () => {
  const { body, input } = setup({ moveX: 1, moveZ: 0.05, sprint: true });
  const sp = run(body, input, 60);
  assert.ok(sp.at(-1) < P.sprintSpeed - 0.5, `sprint bokiem: ${sp.at(-1)}`);
});

test('normalizacja przekątnych: (1,1) i (−1,1) → walkSpeed; wejście < 1 skaluje prędkość', () => {
  for (const [mx, mz] of [[1, 1], [-1, 1], [1, -1], [-1, -1], [3, 4]]) {
    const { body, input } = setup({ moveX: mx, moveZ: mz });
    const sp = run(body, input, 60);
    for (const s of sp) assert.ok(s <= P.walkSpeed + 1e-9);
    assert.ok(Math.abs(sp.at(-1) - P.walkSpeed) < 1e-9, `(${mx},${mz}): ${sp.at(-1)}`);
  }
  const { body, input } = setup({ moveZ: 0.5 });
  const sp = run(body, input, 60);
  assert.ok(Math.abs(sp.at(-1) - P.walkSpeed * 0.5) < 1e-9);
});

test('kierunek wg konwencji yaw: yaw=0 → przód −Z, prawo +X; yaw=π/2 → przód −X, prawo −Z; yaw=π → przód +Z', () => {
  const cases = [
    [0, 0, 1, 0, -1], [0, 1, 0, 1, 0], [0, 0, -1, 0, 1],
    [Math.PI / 2, 0, 1, -1, 0], [Math.PI / 2, 1, 0, 0, -1],
    [Math.PI, 0, 1, 0, 1], [-Math.PI / 2, 0, 1, 1, 0],
  ];
  for (const [yaw, mx, mz, ex, ez] of cases) {
    const { body, input } = setup({ yaw, moveX: mx, moveZ: mz });
    run(body, input, 30);
    const s = hspeed(body);
    assert.ok(Math.abs(body.vx / s - ex) < 1e-9 && Math.abs(body.vz / s - ez) < 1e-9,
      `yaw=${yaw} m=(${mx},${mz}): v=(${body.vx.toFixed(3)},${body.vz.toFixed(3)}) oczekiwane (${ex},${ez})`);
  }
  // zgodność z wektorem patrzenia z PLAN §0 (pitch=0): (-sin yaw, 0, -cos yaw)
  for (const yaw of [0.3, 1.7, -2.4]) {
    const { body, input } = setup({ yaw, moveZ: 1 });
    run(body, input, 30);
    const s = hspeed(body);
    assert.ok(Math.abs(body.vx / s + Math.sin(yaw)) < 1e-9 && Math.abs(body.vz / s + Math.cos(yaw)) < 1e-9);
  }
});

test('tarcie: bez wejścia prędkość maleje wykładniczo do zera (dokładnie 0), pozycja się zatrzymuje', () => {
  const { body, input } = setup({ moveZ: 1, sprint: true });
  run(body, input, 60);
  input.moveZ = 0; input.sprint = false;
  const sp = run(body, input, 120);
  const k = 1 - P.friction * DT;
  assert.ok(Math.abs(sp[0] - P.sprintSpeed * k) < 1e-9);
  for (let i = 1; i < sp.length; i++) assert.ok(sp[i] <= sp[i - 1]);
  assert.equal(sp.at(-1), 0);
  assert.equal(body.vx, 0);
  assert.equal(body.vz, 0);
  const z = body.z;
  run(body, input, 10);
  assert.equal(body.z, z);
});

test('tarcie przy dużym dt (k < 0) nie odwraca prędkości', () => {
  const { body, input } = setup({ moveZ: 1 });
  run(body, input, 30);
  input.moveZ = 0;
  stepMovement(body, input, 0.2, world); // 1 − 12·0.2 < 0
  assert.equal(body.vx, 0);
  assert.equal(body.vz, 0);
});

test('skok tylko na ziemi: wysokość ≈ v²/2g, brak podwójnego skoku, po lądowaniu znów można', () => {
  const { body, input } = setup({ jump: true });
  stepMovement(body, input, DT, world);
  assert.equal(body.onGround, false);
  assert.ok(body.vy > 0);
  let maxY = body.y;
  let landed = -1;
  for (let i = 0; i < 90; i++) {
    const vyBefore = body.vy;
    const onG = body.onGround;
    stepMovement(body, input, DT, world); // jump trzymany
    if (!onG && !body.onGround) assert.ok(body.vy <= vyBefore, 'skok w powietrzu dodał prędkość');
    maxY = Math.max(maxY, body.y);
    if (body.onGround && landed < 0) landed = i;
    if (landed >= 0) break;
  }
  const h = P.jumpSpeed ** 2 / (2 * P.gravity);
  assert.ok(Math.abs(maxY - h) < 0.06, `apex ${maxY} vs ${h}`);
  assert.ok(landed > 0, 'nie wylądował');
  input.jump = false;
  stepMovement(body, input, DT, world);
  input.jump = true;
  stepMovement(body, input, DT, world);
  assert.ok(body.vy > 0 && !body.onGround, 'brak ponownego skoku po lądowaniu');
});

test('skok niemożliwy, gdy body.onGround=false (np. świeży createBody w powietrzu)', () => {
  const body = createBody();
  body.y = 2;
  const input = Object.assign(createInputState(), { jump: true });
  stepMovement(body, input, DT, world);
  assert.ok(body.vy < 0);
});

test('w powietrzu: bez wejścia brak tarcia; z wejściem przyspieszenie accelAir (wolniejsze niż na ziemi)', () => {
  const { body, input } = setup({ moveZ: 1 });
  run(body, input, 60);
  input.jump = true;
  stepMovement(body, input, DT, world);
  input.jump = false; input.moveZ = 0;
  const v0 = hspeed(body);
  stepMovement(body, input, DT, world);
  assert.equal(body.onGround, false);
  assert.equal(hspeed(body), v0, 'tarcie w powietrzu');
  // zmiana kierunku w powietrzu: Δv na krok = accelAir·dt
  input.moveX = 1;
  const vx0 = body.vx; const vz0 = body.vz;
  stepMovement(body, input, DT, world);
  const dv = Math.hypot(body.vx - vx0, body.vz - vz0);
  assert.ok(Math.abs(dv - P.accelAir * DT) < 1e-9, `dv=${dv}`);
});

test('pusty / brakujący moveX/moveZ (undefined) traktowany jak 0', () => {
  const { body } = setup();
  stepMovement(body, { yaw: 0, pitch: 0 }, DT, world);
  assert.equal(hspeed(body), 0);
  assert.ok(Number.isFinite(body.x) && Number.isFinite(body.z));
});

// ------------------------------------------------------------------------------------------------ kucanie (§9, CONFIG.player.crouch*)

test('kuc: płynne przejście (crouchTime), wysokość/oko, prędkość × crouchSpeedMul, bez sprintu i skoku', () => {
  const { body, input } = setup({ crouch: true, moveZ: 1, sprint: true, jump: true });
  const n = Math.ceil(P.crouchTime / DT);
  stepMovement(body, input, DT, world);
  assert.ok(body.crouch > 0 && body.crouch < 1, `crouch po 1 kroku: ${body.crouch}`);
  for (let i = 0; i < n + 60; i++) stepMovement(body, input, DT, world);
  assert.equal(body.crouch, 1);
  assert.ok(Math.abs(body.height - P.crouchHeight) < 1e-12);
  assert.ok(Math.abs(body.eyeHeight - P.crouchEyeHeight) < 1e-12);
  assert.ok(Math.abs(hspeed(body) - P.walkSpeed * P.crouchSpeedMul) < 1e-9, `prędkość w kucu ${hspeed(body)}`);
  assert.equal(body.y, 0, 'skok w kucu');
  input.crouch = false;
  for (let i = 0; i < n + 1; i++) stepMovement(body, input, DT, world);
  assert.equal(body.crouch, 0);
  assert.equal(body.height, P.height);
});

test('kuc: nie można wstać pod przeszkodą (spód bryły nad głową); po wyjściu wstaje', () => {
  const w = buildWorld({
    id: 't', name: 't', seed: 1, size: { w: 30, d: 30 }, ceiling: 10, perimeter: { h: 10 }, ramps: [], spawns: [], cams: [],
    walls: [{ x: 0, z: -4, w: 4, d: 4, h: 0.3, y: 1.3, kind: 'platform' }], // spód 1.3: kuc (1.15) przejdzie, stojący (1.8) nie
  });
  const body = createBody();
  const input = Object.assign(createInputState(), { crouch: true, moveZ: 1 });
  for (let i = 0; i < 150; i++) stepMovement(body, input, DT, w); // ≈ 4.3 m w kucu → z ≈ −4.3 (pod platformą z∈[−6,−2])
  assert.ok(body.z < -3 && body.z > -5.5, `pod platformą: z=${body.z}`);
  input.moveZ = 0; input.crouch = false;
  for (let i = 0; i < 30; i++) stepMovement(body, input, DT, w);
  assert.ok(body.y + body.height <= 1.3 + 1e-9, `wstał pod platformą: głowa ${body.y + body.height}`);
  assert.ok(body.crouch > 0);
  input.moveZ = -1;
  for (let i = 0; i < 200; i++) stepMovement(body, input, DT, w);
  assert.equal(body.crouch, 0);
  assert.equal(body.height, P.height);
});

// ------------------------------------------------------------------------------------------------ stamina (D-023, CONFIG.player.stamina)

const S = P.stamina;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** Sprint do przodu aż do wyczerpania; zwraca liczbę kroków. */
function sprintToEmpty(body, input) {
  input.moveZ = 1; input.moveX = 0; input.sprint = true; input.crouch = false; input.jump = false;
  let n = 0;
  while (!body.exhausted && n < 10000) { stepMovement(body, input, DT, world); n++; }
  return n;
}

test('stamina: kontrakt pól — pełna na starcie, double 0..1, sprinting/exhausted boolean', () => {
  const b = createBody();
  assert.equal(b.stamina, 1);
  assert.equal(b.sprinting, false);
  assert.equal(b.exhausted, false);
  assert.ok(S.drain > 0 && S.regen > 0 && S.exhaustedRecover > 0 && S.exhaustedRecover < 1 && S.jumpCost > 0 && S.jumpCost < S.exhaustedRecover);
});

test('stamina: sprint zużywa drain/s (pełny pasek ≈ 1/drain s), potem exhausted i chód', () => {
  const { body, input } = setup({ moveZ: 1, sprint: true });
  run(body, input, 60);
  assert.equal(body.sprinting, true);
  assert.ok(near(body.stamina, 1 - S.drain * 60 * DT), `po 1 s: ${body.stamina}`);
  const n = 60 + sprintToEmpty(body, input);
  assert.ok(Math.abs(n * DT - 1 / S.drain) <= 2 * DT, `sprint trwał ${n * DT} s`);
  assert.equal(body.stamina, 0);
  assert.equal(body.exhausted, true);
  const sp = run(body, input, 30); // sprint wciśnięty, ale zablokowany
  assert.equal(body.sprinting, false);
  assert.equal(sp.at(-1), P.walkSpeed);
});

test('stamina: brak sprintu (tył/strafe/kuc/bez ruchu) nie zużywa staminy', () => {
  for (const inp of [{ moveZ: -1 }, { moveX: 1 }, { moveZ: 1, crouch: true }, {}]) {
    const { body, input } = setup({ ...inp, sprint: true });
    run(body, input, 120);
    assert.equal(body.sprinting, false, JSON.stringify(inp));
    assert.equal(body.stamina, 1, JSON.stringify(inp));
  }
});

test('stamina: exhausted — regeneracja po regenDelay (regen/s w ruchu), sprint wraca dopiero przy exhaustedRecover', () => {
  const { body, input } = setup();
  sprintToEmpty(body, input);
  // dalej idzie z wciśniętym sprintem
  assert.equal(body.sprinting, true, 'krok wyczerpania jeszcze sprintem');
  let n = 0;
  do { stepMovement(body, input, DT, world); n++; } while (!body.sprinting && n < 10000);
  n--; // kroki bez sprintu
  const expect = S.regenDelay + S.exhaustedRecover / S.regen;
  assert.ok(Math.abs(n * DT - expect) <= 2 * DT, `blokada ${n * DT} s, oczekiwane ${expect} s`);
  assert.equal(body.exhausted, false);
  assert.ok(body.stamina > S.exhaustedRecover - S.drain * DT - 1e-9 && body.stamina <= S.exhaustedRecover + S.regen * DT + 1e-9);
  // w trakcie opóźnienia stamina stoi na 0
  const b2 = setup().body; sprintToEmpty(b2, input);
  input.sprint = false;
  run(b2, input, Math.floor(S.regenDelay / DT) - 1);
  assert.equal(b2.stamina, 0, 'regeneracja przed regenDelay');
});

test('stamina: stojąc i w kucu regeneracja × regenIdleMul; puszczenie sprintu przed 0 nie blokuje', () => {
  const rate = (inp) => {
    const { body, input } = setup({ moveZ: 1, sprint: true });
    run(body, input, 120); // 2 s sprintu → 0.5
    assert.equal(body.exhausted, false);
    Object.assign(input, { moveZ: 0, moveX: 0, sprint: false, crouch: false }, inp);
    run(body, input, Math.ceil(S.regenDelay / DT) + 1);
    const s0 = body.stamina;
    run(body, input, 30);
    return (body.stamina - s0) / (30 * DT);
  };
  assert.ok(near(rate({ moveZ: 1 }), S.regen, 1e-6), 'w ruchu');
  assert.ok(near(rate({}), S.regen * S.regenIdleMul, 1e-6), 'stojąc');
  assert.ok(near(rate({ crouch: true }), S.regen * S.regenIdleMul, 1e-6), 'w kucu');
  assert.ok(near(rate({ crouch: true, moveZ: 1 }), S.regen * S.regenIdleMul, 1e-6), 'w kucu w ruchu');
  // pełna regeneracja kończy się dokładnie na 1
  const { body, input } = setup({ moveZ: 1, sprint: true });
  run(body, input, 60);
  input.sprint = false; input.moveZ = 0;
  run(body, input, 600);
  assert.equal(body.stamina, 1);
});

test('stamina: skok kosztuje jumpCost i resetuje opóźnienie regeneracji; poniżej jumpCost skok niedostępny', () => {
  const { body, input } = setup({ jump: true });
  stepMovement(body, input, DT, world);
  assert.ok(body.vy > 0, 'skok przy pełnej staminie');
  assert.ok(near(body.stamina, 1 - S.jumpCost));
  // niski poziom: sprint do stamina < jumpCost (bez wyczerpania)
  const b = setup({ moveZ: 1, sprint: true }).body;
  const inp = Object.assign(createInputState(), { moveZ: 1, sprint: true });
  while (b.stamina >= S.jumpCost * 0.5) stepMovement(b, inp, DT, world);
  assert.equal(b.exhausted, false);
  inp.sprint = false; inp.moveZ = 0; inp.jump = true;
  const s0 = b.stamina;
  stepMovement(b, inp, DT, world);
  assert.equal(b.onGround, true, 'skok przy stamina < jumpCost');
  assert.equal(b.y, 0);
  assert.equal(b.stamina, s0, 'nieudany skok nie zmienia staminy');
  // skok w trakcie regeneracji: opóźnienie liczone od nowa
  const { body: c, input: ci } = setup({ moveZ: 1, sprint: true });
  run(c, ci, 120);
  ci.sprint = false; ci.moveZ = 0;
  run(c, ci, Math.ceil(S.regenDelay / DT) + 30);
  ci.jump = true; stepMovement(c, ci, DT, world); ci.jump = false;
  const s1 = c.stamina;
  run(c, ci, Math.floor(S.regenDelay / DT) - 2);
  assert.equal(c.stamina, s1, 'regeneracja zaraz po skoku');
});

test('stamina: placeAt (respawn) przywraca pełną staminę i zdejmuje exhausted', () => {
  const Pp = createParticipant({ id: 1 });
  const input = createInputState();
  stepMovement(Pp.body, input, DT, world);
  sprintToEmpty(Pp.body, input);
  assert.equal(Pp.body.exhausted, true);
  placeAt(Pp, 1, 0, 1, 0);
  assert.equal(Pp.body.stamina, 1);
  assert.equal(Pp.body.exhausted, false);
  assert.equal(Pp.body.sprinting, false);
  stepMovement(Pp.body, Object.assign(input, { moveZ: 1, sprint: true }), DT, world);
  assert.equal(Pp.body.sprinting, true, 'sprint od razu po respawnie');
});
