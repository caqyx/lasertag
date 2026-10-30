// Test alokacji (SPEC §7 „zero alokacji w pętli gry”): moveBody / raycastWorld / segmentClear / stepMovement.
// Wymaga `node --expose-gc` (skrypt `npm test` to ustawia); bez global.gc testy są pomijane (t.skip).
// Metoda: rozgrzewka (JIT), gc, 100k wywołań; sprawdzane: (1) przyrost heapUsed BEZ gc po pętli (= śmieci; sam
// pomiar po gc wykrywa tylko wycieki, nie alokacje), (2) brak zdarzeń GC w trakcie pętli (v8.GCProfiler) — scavenge
// zaniżyłby (1), (3) przyrost po gc (wyciek). Próg 64 KB. Kontrola negatywna: funkcja alokująca {} musi oblać.
// Uwaga: kod pętli testowej nie może pisać doubli do `let` modułu (V8 alokuje HeapNumber) — stąd Float64Array.
import { test } from 'node:test';
import v8 from 'node:v8';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { moveBody, raycastWorld, segmentClear, groundHeight, createHit } from '../../src/world/physics.js';
import { createBody, stepMovement } from '../../src/game/movement.js';
import { createInputState } from '../../src/game/input/inputState.js';
import { createRng } from '../../src/core/rng.js';
import uvmaze from '../../src/world/maps/uvmaze.js';

const N = 100_000;
const LIMIT = 64 * 1024;
const world = buildWorld(uvmaze);

// Parametry promieni prealokowane przed pomiarem (żeby test sam nie alokował).
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

/** Zwraca { garbage, gcs, retained } dla N wywołań fn. */
function measure(fn) {
  for (let i = 0; i < 20_000; i++) fn(i); // rozgrzewka / optymalizacja
  global.gc(); global.gc();
  const prof = new v8.GCProfiler();
  const before = process.memoryUsage().heapUsed;
  prof.start();
  for (let i = 0; i < N; i++) fn(i);
  const stats = prof.stop();
  const garbage = process.memoryUsage().heapUsed - before;
  global.gc(); global.gc();
  const retained = process.memoryUsage().heapUsed - before;
  return { garbage, gcs: stats.statistics.length, retained };
}

function allocFree(fn) {
  // najlepszy z 3 pomiarów (szum JIT/deopt)
  let last;
  for (let k = 0; k < 3; k++) {
    last = measure(fn);
    if (last.garbage < LIMIT && last.gcs === 0 && last.retained < LIMIT) return { ok: true, ...last };
  }
  return { ok: false, ...last };
}

function check(t, name, fn) {
  if (typeof global.gc !== 'function') { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
  const r = allocFree(fn);
  assert.ok(r.ok, `${name}: ${N} wywołań → śmieci ${r.garbage} B, GC w pętli ${r.gcs}×, wyciek ${r.retained} B`);
}

test('kontrola negatywna: pomiar wykrywa alokację {} na wywołanie', (t) => {
  if (typeof global.gc !== 'function') { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
  const sink = [null];
  const r = allocFree((i) => { sink[0] = { i }; });
  assert.equal(r.ok, false, `alokacja niewykryta: ${JSON.stringify(r)}`);
});

test('moveBody nie alokuje', (t) => {
  const b = createBody();
  b.x = 0; b.z = -15; b.onGround = true;
  check(t, 'moveBody', (i) => {
    const a = (i % 360) * 0.0174533;
    b.vx = Math.cos(a) * 7.6; b.vz = Math.sin(a) * 7.6;
    if ((i & 255) === 0) b.vy = 5;
    moveBody(world, b, 1 / 60);
  });
});

test('raycastWorld nie alokuje', (t) => {
  const hit = createHit();
  check(t, 'raycastWorld', (i) => {
    const k = (i & (RAYS - 1)) * 6;
    raycastWorld(world, rp[k], rp[k + 1], rp[k + 2], rp[k + 3], rp[k + 4], rp[k + 5], 50, hit);
  });
});

test('segmentClear i groundHeight nie alokują', (t) => {
  check(t, 'segmentClear/groundHeight', (i) => {
    const k = (i & (RAYS - 1)) * 6;
    const j = ((i + 7) & (RAYS - 1)) * 6;
    segmentClear(world, rp[k], rp[k + 1], rp[k + 2], rp[j], rp[j + 1], rp[j + 2]);
    groundHeight(world, rp[k], rp[k + 2], 0, 0.35);
  });
});

test('rng next/range/int/pick nie alokują', (t) => {
  const rng = createRng(9);
  const arr = [1, 2, 3];
  const acc = new Float64Array(1);
  check(t, 'rng', () => { acc[0] += rng.next() + rng.range(-1, 1) + rng.int(0, 9) + rng.pick(arr); });
});

test('stepMovement nie alokuje', (t) => {
  const b = createBody();
  b.z = -15;
  const input = createInputState();
  check(t, 'stepMovement', (i) => {
    input.yaw = (i % 628) * 0.01;
    input.moveZ = (i & 64) ? 1 : 0;
    input.moveX = (i & 128) ? -1 : 0;
    input.sprint = (i & 32) !== 0;
    input.jump = (i & 511) === 0;
    stepMovement(b, input, 1 / 60, world);
  });
});
