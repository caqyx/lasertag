// Testy src/core/rng.js (mulberry32): determinizm, niezależność instancji, zakresy range/int, pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRng } from '../../src/core/rng.js';

const seq = (rng, n) => Array.from({ length: n }, () => rng.next());

test('ten sam seed → identyczna sekwencja; różne instancje niezależne', () => {
  const a = createRng(1337);
  const b = createRng(1337);
  const sa = seq(a, 1000);
  assert.deepEqual(sa, seq(b, 1000));
  // przeplatanie wywołań nie wpływa na drugą instancję
  const c = createRng(1337);
  const d = createRng(1337);
  c.next(); c.next();
  assert.equal(d.next(), sa[0]);
});

test('różne seedy → różne sekwencje; seed rzutowany na uint32', () => {
  assert.notDeepEqual(seq(createRng(1), 10), seq(createRng(2), 10));
  assert.deepEqual(seq(createRng(-1), 10), seq(createRng(0xffffffff), 10));
  assert.deepEqual(seq(createRng(2 ** 32 + 5), 10), seq(createRng(5), 10));
  assert.equal(createRng(-1).seed, 0xffffffff);
  assert.equal(createRng(7.9).seed, 7);
});

test('seed 0 i undefined dają poprawne (nie stałe) liczby', () => {
  for (const s of [0, undefined, NaN]) {
    const v = seq(createRng(s), 50);
    assert.ok(new Set(v).size > 45, `seed ${s}: sekwencja zdegenerowana`);
  }
});

test('next() ∈ [0,1), rozkład z grubsza równomierny', () => {
  const r = createRng(42);
  const bins = new Array(10).fill(0);
  const N = 100000;
  for (let i = 0; i < N; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1, `poza [0,1): ${v}`);
    bins[Math.floor(v * 10)]++;
  }
  for (const b of bins) assert.ok(Math.abs(b - N / 10) < N / 10 * 0.05, `kubełek ${b}`);
});

test('range(a,b) ∈ [a,b), także dla a > b i ujemnych', () => {
  const r = createRng(3);
  for (let i = 0; i < 20000; i++) {
    const v = r.range(-2.5, 7.25);
    assert.ok(v >= -2.5 && v < 7.25);
  }
  for (let i = 0; i < 1000; i++) {
    const v = r.range(5, 1); // odwrócony: (1, 5]
    assert.ok(v > 1 && v <= 5);
  }
  assert.equal(r.range(3, 3), 3);
});

test('int(a,b) — obustronnie domknięty, trafia w każdy element', () => {
  const r = createRng(11);
  const seen = new Map();
  for (let i = 0; i < 20000; i++) {
    const v = r.int(-3, 4);
    assert.ok(Number.isInteger(v) && v >= -3 && v <= 4, `int poza zakresem: ${v}`);
    seen.set(v, (seen.get(v) || 0) + 1);
  }
  assert.equal(seen.size, 8);
  for (const c of seen.values()) assert.ok(c > 2000 && c < 3000, `nierówny rozkład int: ${c}`);
  assert.equal(r.int(5, 5), 5);
});

test('pick — każdy element osiągalny, pusta tablica → undefined', () => {
  const r = createRng(5);
  const arr = ['a', 'b', 'c'];
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const v = r.pick(arr);
    assert.ok(arr.includes(v));
    seen.add(v);
  }
  assert.equal(seen.size, 3);
  assert.equal(r.pick([]), undefined);
  assert.equal(r.pick([9]), 9);
});

test('regresja: znane pierwsze wartości mulberry32 (seed 1337) są stabilne', () => {
  // wartości referencyjne liczone niezależną implementacją (poniżej) — chroni przed cichą zmianą algorytmu
  function ref(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const f = ref(1337);
  const r = createRng(1337);
  for (let i = 0; i < 100; i++) assert.equal(r.next(), f());
});
