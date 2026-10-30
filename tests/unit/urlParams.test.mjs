// Testy src/core/urlParams.js: wartości poprawne, błędne i brzegowe; domyślne z CONFIG.defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseParams } from '../../src/core/urlParams.js';
import { CONFIG } from '../../src/config.js';

const D = CONFIG.defaults;

test('brak parametrów → domyślne z CONFIG.defaults, flagi false, seed/cam null', () => {
  for (const s of ['', '?', undefined]) {
    const p = parseParams(s);
    assert.deepEqual(p, {
      preset: D.preset, map: D.map, mode: D.mode, bots: CONFIG.defaults.bots ?? null, diff: D.diff,
      cam: null, nohud: false, stats: false, seed: null, autostart: false,
    });
  }
});

test('parametr nie-string (np. obiekt) → domyślne, bez wyjątku', () => {
  assert.equal(parseParams(null).preset, D.preset);
  assert.equal(parseParams({ preset: 'low' }).preset, D.preset);
});

test('poprawne wartości są przyjmowane (z ? i bez)', () => {
  const p = parseParams('?preset=low&map=uvmaze&mode=tdm4&bots=7&diff=hard&cam=2&nohud=1&stats=true&seed=42&autostart=1');
  assert.deepEqual(p, {
    preset: 'low', map: 'uvmaze', mode: 'tdm4', bots: 7, diff: 'hard', cam: 2,
    nohud: true, stats: true, seed: 42, autostart: true,
  });
  assert.equal(parseParams('preset=ultra').preset, 'ultra');
  for (const k of Object.keys(CONFIG.presets)) assert.equal(parseParams(`?preset=${k}`).preset, k);
  for (const k of Object.keys(CONFIG.modes)) assert.equal(parseParams(`?mode=${k}`).mode, k);
  for (const k of Object.keys(CONFIG.bots.levels)) assert.equal(parseParams(`?diff=${k}`).diff, k);
});

test('nieznane / wrogie wartości preset/mode/diff → domyślne (w tym klucze prototypu)', () => {
  for (const v of ['nope', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'HIGH ']) {
    const p = parseParams(`?preset=${encodeURIComponent(v)}&mode=${encodeURIComponent(v)}&diff=${encodeURIComponent(v)}`);
    assert.equal(p.preset, D.preset, v);
    assert.equal(p.mode, D.mode, v);
    assert.equal(p.diff, D.diff, v);
  }
});

test('preset/mode/diff są wrażliwe na wielkość liter (inaczej niż map) — zachowanie udokumentowane', () => {
  assert.equal(parseParams('?map=UVMaze').map, 'uvmaze');
  assert.equal(parseParams('?preset=LOW').preset, D.preset); // nie 'low'
});

test('map: format identyfikatora; nieznana, ale poprawna nazwa przechodzi (walidacja w main.js)', () => {
  assert.equal(parseParams('?map=neonhive').map, 'neonhive');
  assert.equal(parseParams('?map=a_b-9').map, 'a_b-9');
  for (const v of ['', '../etc', 'a b', 'x'.repeat(33), '<script>', 'ąę']) {
    assert.equal(parseParams(`?map=${encodeURIComponent(v)}`).map, D.map, JSON.stringify(v));
  }
  assert.equal(parseParams(`?map=${'x'.repeat(32)}`).map, 'x'.repeat(32));
});

test('bots: 0..15 (maxParticipants-1) przyjmowane, reszta → domyślne', () => {
  const def = CONFIG.defaults.bots ?? null;
  assert.equal(parseParams('?bots=0').bots, 0);
  assert.equal(parseParams('?bots=15').bots, 15);
  assert.equal(parseParams('?bots=07').bots, 7);
  for (const v of ['16', '31', '32', '99', '100', '-1', '1.5', 'abc', '', ' 3', '1e1', '0x3']) {
    assert.equal(parseParams(`?bots=${encodeURIComponent(v)}`).bots, def, JSON.stringify(v));
  }
});

test('seed: liczba całkowita → uint32; śmieci → null', () => {
  assert.equal(parseParams('?seed=0').seed, 0);
  assert.equal(parseParams('?seed=4294967295').seed, 4294967295);
  assert.equal(parseParams('?seed=-1').seed, 4294967295);
  assert.equal(parseParams('?seed=4294967296').seed, 0); // zawinięcie modulo 2^32
  for (const v of ['', 'abc', '1.5', '1e3', '+5', ' 5', '12345678901', '0x10']) {
    assert.equal(parseParams(`?seed=${encodeURIComponent(v)}`).seed, null, JSON.stringify(v));
  }
  const s = parseParams('?seed=-2147483648').seed;
  assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff);
});

test('cam: indeks 0..999 → liczba, nazwa → string (trim), puste/za długie → null', () => {
  assert.equal(parseParams('?cam=0').cam, 0);
  assert.equal(parseParams('?cam=%202%20').cam, 2);
  assert.equal(parseParams('?cam=007').cam, 7);
  assert.equal(parseParams('?cam=plaza').cam, 'plaza');
  assert.equal(parseParams('?cam=%20plaza%20').cam, 'plaza');
  assert.equal(parseParams('?cam=').cam, null);
  assert.equal(parseParams('?cam=%20%20').cam, null);
  assert.equal(parseParams(`?cam=${'a'.repeat(64)}`).cam, 'a'.repeat(64));
  assert.equal(parseParams(`?cam=${'a'.repeat(65)}`).cam, null);
  assert.equal(parseParams('?cam=1000').cam, '1000'); // > 3 cyfry → traktowane jak nazwa
});

test('flagi: tylko "1" i "true" włączają', () => {
  for (const [v, exp] of [['1', true], ['true', true], ['0', false], ['false', false], ['TRUE', false], ['yes', false], ['', false]]) {
    const p = parseParams(`?nohud=${v}&stats=${v}&autostart=${v}`);
    assert.equal(p.nohud, exp, v);
    assert.equal(p.stats, exp, v);
    assert.equal(p.autostart, exp, v);
  }
  assert.equal(parseParams('?nohud').nohud, false);
});

test('powtórzony parametr → pierwsze wystąpienie; nieznane parametry ignorowane', () => {
  assert.equal(parseParams('?preset=low&preset=ultra').preset, 'low');
  const p = parseParams('?foo=bar&preset=medium');
  assert.equal(p.preset, 'medium');
  assert.ok(!('foo' in p));
});
