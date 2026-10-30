// Test alokacji (SPEC §7 „zero alokacji w pętli gry”): moveBody / raycastWorld / segmentClear / groundHeight /
// stepMovement / rng. Wymaga `node --expose-gc` (skrypt `npm test` to ustawia); bez global.gc testy są pomijane (t.skip).
//
// Metoda: rozgrzewka (JIT), gc, 100k wywołań, potem:
//   • wyciek    — przyrost heapUsed PO gc < 64 KB (wymaganie minimalne),
//   • śmieci    — przyrost heapUsed BEZ gc < 64 KB i 0 zdarzeń GC w pętli (v8.GCProfiler; scavenge zaniżyłby pomiar).
//                 Sam pomiar po gc nie wykrywa alokacji krótkotrwałych — stąd ten drugi, ostrzejszy wariant.
// Kontrola negatywna: funkcja alokująca {} musi oblać wariant „śmieci”.
// Uwaga: pętle testowe nie piszą doubli do `let` z domknięcia (V8 alokuje HeapNumber) — akumulatory w Float64Array.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { buildWorld } from '../../src/world/mapgen.js';
import { moveBody, raycastWorld, segmentClear, groundHeight, createHit } from '../../src/world/physics.js';
import { createBody, stepMovement } from '../../src/game/movement.js';
import { createInputState } from '../../src/game/input/inputState.js';
import { createRng } from '../../src/core/rng.js';
import uvmaze from '../../src/world/maps/uvmaze.js';

const N = 100_000;
const LIMIT = 64 * 1024;
const HAS_GC = typeof global.gc === 'function';
const world = buildWorld(uvmaze);

/** { garbage, gcs, retained } dla N wywołań fn (najlepszy z 3 prób — szum JIT/deopt). */
function measure(fn) {
  let best = null;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < 20_000; i++) fn(i);
    global.gc(); global.gc();
    const prof = new v8.GCProfiler();
    const before = process.memoryUsage().heapUsed;
    prof.start();
    for (let i = 0; i < N; i++) fn(i);
    const gcs = prof.stop().statistics.length;
    const garbage = process.memoryUsage().heapUsed - before;
    global.gc(); global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    const r = { garbage, gcs, retained, clean: garbage < LIMIT && gcs === 0 };
    if (!best || (r.clean && !best.clean) || r.retained < best.retained) best = r;
    if (r.clean && r.retained < LIMIT) break;
  }
  return best;
}
const fmt = (r) => `śmieci ${r.garbage} B, GC w pętli ${r.gcs}×, wyciek ${r.retained} B (na ${N} wywołań)`;

// --- scenariusze (prealokowane dane, bez alokacji w samych pętlach) ---
const RAYS = 1024;
const rp = new Float64Array(RAYS * 6);
{
  const rng = createRng(3);
  for (let i = 0; i < RAYS; i++) {
    rp[i * 6] = rng.range(-17, 17); rp[i * 6 + 1] = rng.range(0.2, 4.3); rp[i * 6 + 2] = rng.range(-17, 17);
    const th = rng.range(0, 6.283); const ph = rng.range(-0.6, 0.6);
    rp[i * 6 + 3] = Math.cos(th) * Math.cos(ph); rp[i * 6 + 4] = Math.sin(ph); rp[i * 6 + 5] = Math.sin(th) * Math.cos(ph);
  }
}
const mvBody = createBody();
mvBody.z = -15; mvBody.onGround = true;
const hit = createHit();
const smBody = createBody();
smBody.z = -15;
const input = createInputState();
const rng = createRng(9);
const arr = [1, 2, 3];
const acc = new Float64Array(1);

const SCENARIOS = {
  moveBody: (i) => {
    const a = (i % 360) * 0.0174533;
    mvBody.vx = Math.cos(a) * 7.6; mvBody.vz = Math.sin(a) * 7.6;
    if ((i & 255) === 0) mvBody.vy = 5;
    moveBody(world, mvBody, 1 / 60);
  },
  // stałe argumenty: mierzy wyłącznie alokacje wewnątrz raycastWorld/segmentClear (nie boxing argumentów testu)
  raycastWorld: () => { raycastWorld(world, 0.5, 1.5, -15.5, 0.6, 0.1, 0.8, 50, hit); },
  segmentClear: () => { segmentClear(world, 0.5, 1.5, -15.5, 5.5, 1.2, -12.5); },
  groundHeight: () => { acc[0] += groundHeight(world, 0.5, -15.5, 0, 0.35); },
  'raycastWorld (losowe promienie)': (i) => {
    const k = (i & (RAYS - 1)) * 6;
    raycastWorld(world, rp[k], rp[k + 1], rp[k + 2], rp[k + 3], rp[k + 4], rp[k + 5], 50, hit);
  },
  stepMovement: (i) => {
    input.yaw = (i % 628) * 0.01;
    input.moveZ = (i & 64) ? 1 : 0;
    input.moveX = (i & 128) ? -1 : 0;
    input.sprint = (i & 32) !== 0;
    input.jump = (i & 511) === 0;
    stepMovement(smBody, input, 1 / 60, world);
  },
  rng: () => { acc[0] += rng.next() + rng.range(-1, 1) + rng.int(0, 9) + rng.pick(arr); },
};

test('kontrola negatywna: pomiar wykrywa alokację {} na wywołanie', (t) => {
  if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
  const sink = [null];
  const r = measure((i) => { sink[0] = { i }; });
  assert.equal(r.clean, false, `alokacja niewykryta: ${fmt(r)}`);
});

for (const [name, fn] of Object.entries(SCENARIOS)) {
  test(`${name}: brak wycieku (heapUsed po gc)`, (t) => {
    if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
    const r = measure(fn);
    assert.ok(r.retained < LIMIT, `${name}: ${fmt(r)}`);
  });
}

// Wariant ostry. Historia: przed refaktorem physics.js (argumenty/wyniki przez Float64Array scratch) moveBody alokował
// ~200 B/wywołanie, raycastWorld ~96 B, segmentClear ~112 B, stepMovement ~115 B (boxing doubli na granicach
// nie-inline'owanych funkcji). Ten test pilnuje, żeby to nie wróciło.
for (const [name, fn] of Object.entries(SCENARIOS)) {
  test(`${name}: zero śmieci w pętli (bez gc, 0 zdarzeń GC)`, (t) => {
    if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
    const r = measure(fn);
    assert.ok(r.clean, `${name}: ${fmt(r)}`);
  });
}
