// Testy src/core/loop.js: stały krok (akumulator), clamp maxSubSteps, alpha ∈ [0,1), start/stop z shimem rAF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoop } from '../../src/core/loop.js';
import { CONFIG } from '../../src/config.js';

const HZ = CONFIG.sim.hz;
const DT = 1 / HZ;
const MAXS = CONFIG.sim.maxSubSteps;

function make(opts = {}) {
  const rec = { steps: 0, dts: [], alphas: [], frameDts: [] };
  const loop = createLoop({
    step(dt) { rec.steps++; rec.dts.push(dt); },
    frame(a, fdt) { rec.alphas.push(a); rec.frameDts.push(fdt); },
    raf: () => 1, caf: () => {},
    ...opts,
  });
  return { loop, rec };
}

test('pierwszy tick nie wykonuje kroków (brak poprzedniego czasu)', () => {
  const { loop, rec } = make();
  assert.equal(loop.tick(123456), 0);
  assert.equal(rec.steps, 0);
  assert.equal(rec.alphas.length, 1);
  assert.equal(rec.alphas[0], 0);
});

test('step zawsze dostaje stałe dt = 1/hz', () => {
  const { loop, rec } = make();
  let t = 0;
  loop.tick(t);
  for (let i = 0; i < 200; i++) { t += 3 + (i % 7) * 9.1; loop.tick(t); }
  assert.ok(rec.dts.length > 0);
  for (const d of rec.dts) assert.equal(d, DT);
});

test('łączna liczba kroków = floor(czas · hz) dla różnych frameDt (bez clampu)', () => {
  // okresy niepodzielne „ładnie” przez 1/60 — brak problemów z dokładnością granic
  for (const per of [1, 4, 7, 10, 16, 17, 23, 33, 50, 83]) {
    const { loop } = make();
    let total = 0;
    const t0 = 1000;
    loop.tick(t0);
    const frames = 600;
    for (let i = 1; i <= frames; i++) total += loop.tick(t0 + i * per);
    const expected = Math.floor(frames * per / 1000 * HZ + 1e-9);
    assert.ok(Math.abs(total - expected) <= 1, `per=${per}ms: ${total} vs ${expected}`);
  }
});

test('długa klatka przycięta do maxSubSteps; czas ponad limit jest gubiony', () => {
  const { loop, rec } = make();
  loop.tick(0);
  assert.equal(loop.tick(5000), MAXS);
  assert.ok(Math.abs(rec.frameDts.at(-1) - DT * MAXS) < 1e-12, 'frameDt przekazany do frame() jest przycięty');
  // kolejna normalna klatka nie „nadrabia” zgubionego czasu
  const n = loop.tick(5000 + 1000 / HZ + 0.5);
  assert.ok(n <= 2, `nadrabianie po clampie: ${n}`);
});

test('nigdy więcej niż maxSubSteps kroków na klatkę (także przy nietypowym hz/maxSubSteps)', () => {
  for (const [hz, ms] of [[60, 5], [120, 3], [30, 1], [240, 8]]) {
    const { loop } = make({ hz, maxSubSteps: ms });
    let t = 0;
    loop.tick(t);
    for (let i = 0; i < 300; i++) {
      t += (i * 37) % 400; // od 0 do ~400 ms
      const n = loop.tick(t);
      assert.ok(n >= 0 && n <= ms, `hz=${hz} ms=${ms}: ${n}`);
    }
  }
});

test('alpha ∈ [0,1) dla każdej klatki (losowe frameDt, także 0 i ogromne)', () => {
  const { loop, rec } = make();
  let t = 0;
  let s = 12345;
  loop.tick(t);
  for (let i = 0; i < 5000; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const r = s / 2 ** 32;
    t += r < 0.05 ? 0 : r < 0.1 ? 500 : r * 40;
    loop.tick(t);
  }
  for (const a of rec.alphas) assert.ok(a >= 0 && a < 1, `alpha=${a}`);
});

test('alpha rośnie liniowo w obrębie kroku', () => {
  const { loop, rec } = make();
  loop.tick(0);
  loop.tick(1000 * DT * 0.25);
  loop.tick(1000 * DT * 0.5);
  assert.ok(Math.abs(rec.alphas[1] - 0.25) < 1e-9);
  assert.ok(Math.abs(rec.alphas[2] - 0.5) < 1e-9);
});

test('czas cofający się (t maleje) → 0 kroków, brak ujemnego akumulatora', () => {
  const { loop, rec } = make();
  loop.tick(1000);
  assert.equal(loop.tick(500), 0);
  assert.ok(rec.alphas.at(-1) >= 0);
  assert.equal(rec.frameDts.at(-1), 0);
});

test('stepOnce: dokładnie jeden krok i jeden frame(0, dt)', () => {
  const { loop, rec } = make();
  loop.stepOnce();
  assert.equal(rec.steps, 1);
  assert.deepEqual(rec.alphas, [0]);
  assert.deepEqual(rec.frameDts, [DT]);
});

test('start/stop z shimem requestAnimationFrame; restart nie nadrabia przerwy', () => {
  const queue = [];
  let cancelled = 0;
  const g = globalThis;
  const prevRaf = g.requestAnimationFrame;
  const prevCaf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  g.cancelAnimationFrame = () => { cancelled++; };
  try {
    let steps = 0;
    const loop = createLoop({ step() { steps++; }, frame() {} });
    assert.equal(loop.running, false);
    loop.start();
    loop.start(); // idempotentne
    assert.equal(queue.length, 1);
    assert.equal(loop.running, true);
    let t = 0;
    for (let i = 0; i < 60; i++) { t += 17; queue.shift()(t); }
    assert.ok(steps >= 58 && steps <= 62, `steps=${steps}`);
    loop.stop();
    assert.equal(loop.running, false);
    assert.equal(cancelled, 1);
    // rAF wywołany po stop (już w kolejce) nic nie robi
    while (queue.length) queue.shift()(t + 5);
    const before = steps;
    loop.start();
    t += 10_000; // 10 s przerwy
    queue.shift()(t); // pierwszy tick po restarcie
    queue.shift()(t + 17);
    assert.ok(steps - before <= 1, `restart nadrabia przerwę: ${steps - before}`);
    loop.stop();
  } finally {
    g.requestAnimationFrame = prevRaf;
    g.cancelAnimationFrame = prevCaf;
  }
});

test('BUG: przy idealnym 60 Hz (t = i·1000/60) każda klatka powinna dać dokładnie 1 krok', () => {
  const { loop } = make();
  const t0 = 1234.5;
  loop.tick(t0);
  const hist = { 0: 0, 1: 0, 2: 0 };
  for (let i = 1; i <= 600; i++) hist[loop.tick(t0 + i * (1000 / 60))]++;
  assert.deepEqual(hist, { 0: 0, 1: 600, 2: 0 });
});

test('BUG: wyjątek w step() zostawia running=true bez zaplanowanej klatki — start() nie wznawia pętli', () => {
  const queue = [];
  let boom = true;
  const loop = createLoop({
    step() { if (boom) throw new Error('boom'); },
    frame() {},
    raf: (cb) => { queue.push(cb); return queue.length; },
    caf: () => {},
  });
  loop.start();
  queue.shift()(0);
  assert.throws(() => queue.shift()(100));
  assert.equal(queue.length, 0, 'pętla zatrzymana (zgodnie z komentarzem)');
  boom = false;
  // oczekiwanie: albo running=false, albo start() ponownie planuje klatkę
  loop.start();
  assert.ok(!loop.running || queue.length === 1, `running=${loop.running}, zaplanowane klatki=${queue.length}`);
});
