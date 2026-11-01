// Testy src/game/weapon.js (SPEC §2.3): kadencja przy różnych dt, przegrzanie przy 10. strzale ciągłego ognia,
// blokada do heat < overheatRecover, chłodzenie z opóźnieniem coolDelay, brak strzału w przegrzaniu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeapon, resetWeapon, stepWeapon } from '../../src/game/weapon.js';
import { CONFIG } from '../../src/config.js';

const C = CONFIG.weapon;

/** Ciągły ogień przez `seconds`; zwraca czasy strzałów (czas końca kroku, w którym padł strzał). */
function holdFire(W, dt, seconds, stopOnOverheat = true) {
  const times = [];
  const n = Math.round(seconds / dt);
  for (let i = 1; i <= n; i++) {
    if (stepWeapon(W, true, dt)) times.push(i * dt);
    if (stopOnOverheat && W.overheated) break;
  }
  return times;
}

test('stan początkowy: zimna broń, gotowa do strzału', () => {
  const W = createWeapon();
  assert.equal(W.heat, 0);
  assert.equal(W.cooldown, 0);
  assert.equal(W.overheated, false);
  assert.equal(stepWeapon(W, true, 1 / 60), true, 'pierwszy strzał od razu');
  assert.ok(Math.abs(W.heat - C.heatPerShot) < 1e-12);
});

test('brak spustu → brak strzału, cooldown nie schodzi poniżej 0', () => {
  const W = createWeapon();
  for (let i = 0; i < 100; i++) assert.equal(stepWeapon(W, false, 1 / 60), false);
  assert.equal(W.cooldown, 0);
  assert.equal(W.heat, 0);
});

for (const hz of [60, 30, 144]) {
  const dt = 1 / hz;
  test(`kadencja ciągłego ognia = fireInterval przy dt = 1/${hz}`, () => {
    const W = createWeapon();
    // bez przegrzania: wyłączamy ciepło przez zerowanie po każdym kroku (testujemy wyłącznie kadencję)
    const times = [];
    const n = Math.round(20 / dt);
    for (let i = 1; i <= n; i++) {
      if (stepWeapon(W, true, dt)) times.push(i * dt);
      W.heat = 0;
    }
    const intervals = times.slice(1).map((t, k) => t - times[k]);
    const mean = (times[times.length - 1] - times[0]) / (times.length - 1);
    assert.ok(Math.abs(mean - C.fireInterval) < dt / times.length + 1e-9,
      `średni odstęp ${mean} ≠ ${C.fireInterval}`);
    // pojedynczy odstęp to fireInterval zaokrąglony w górę/dół do siatki dt — nigdy krótszy niż fireInterval − dt
    for (const iv of intervals) {
      assert.ok(iv > C.fireInterval - dt - 1e-9 && iv < C.fireInterval + dt + 1e-9, `odstęp ${iv}`);
    }
    // liczba strzałów w 20 s: 1 + floor(20 / 0.22) (±1 na brzegach)
    const expected = 1 + Math.floor(20 / C.fireInterval);
    assert.ok(Math.abs(times.length - expected) <= 1, `strzałów ${times.length}, oczekiwano ~${expected}`);
  });
}

test('kadencja: puszczenie spustu nie gromadzi „zapasu" strzałów', () => {
  const W = createWeapon();
  const dt = 1 / 60;
  stepWeapon(W, true, dt);
  for (let i = 0; i < 120; i++) stepWeapon(W, false, dt); // 2 s przerwy
  assert.equal(stepWeapon(W, true, dt), true);
  // drugi strzał po fireInterval skwantowanym do siatki dt (strzał liczony od początku kroku → ≥ fireInterval − dt),
  // nie natychmiast (brak „zapasu" z przerwy)
  let k = 0;
  while (!stepWeapon(W, true, dt)) k++;
  const iv = (k + 1) * dt;
  assert.ok(iv > C.fireInterval - dt - 1e-9 && iv < C.fireInterval + dt, `drugi strzał po ${iv} s`);
});

for (const hz of [60, 30, 144]) {
  const dt = 1 / hz;
  test(`przegrzanie dokładnie przy 10. strzale ciągłego ognia (dt = 1/${hz})`, () => {
    const W = createWeapon();
    const times = holdFire(W, dt, 10);
    assert.equal(W.overheated, true, 'brak przegrzania');
    assert.equal(times.length, 10, `przegrzanie po ${times.length} strzałach`);
    assert.equal(W.heat, 1);
  });
}

test('w przegrzaniu brak strzału aż heat < overheatRecover; potem strzał możliwy', () => {
  const W = createWeapon();
  const dt = 1 / 60;
  holdFire(W, dt, 10);
  assert.equal(W.overheated, true);
  let t = 0;
  let firedAt = -1;
  for (let i = 1; i <= 600; i++) {
    const wasOver = W.overheated;
    const heatBefore = W.heat;
    const f = stepWeapon(W, true, dt);
    t = i * dt;
    if (wasOver && W.overheated) assert.equal(f, false, `strzał w przegrzaniu (t=${t}, heat ${heatBefore})`);
    if (f) { firedAt = t; break; }
  }
  assert.ok(firedAt > 0, 'broń nie odblokowała się w 10 s');
  // czas odblokowania: coolDelay + (1 − overheatRecover) / overheatCoolRate
  const expect = C.coolDelay + (1 - C.overheatRecover) / C.overheatCoolRate;
  assert.ok(Math.abs(firedAt - expect) <= 2 * dt + 1e-9, `odblokowanie po ${firedAt} s, oczekiwano ~${expect}`);
  // ciepło po wznowionym strzale = (< recover) + heatPerShot
  assert.ok(W.heat < C.overheatRecover + C.heatPerShot + 1e-9);
});

test('przegrzanie: chłodzenie startuje po coolDelay i ma tempo overheatCoolRate', () => {
  const W = createWeapon();
  const dt = 1 / 60;
  holdFire(W, dt, 10);
  for (let i = 0; i < 12; i++) stepWeapon(W, false, dt); // 0.2 s < coolDelay
  assert.equal(W.heat, 1, 'chłodzenie przed coolDelay');
  for (let i = 0; i < 30; i++) stepWeapon(W, false, dt); // łącznie 0.7 s
  const expect = 1 - C.overheatCoolRate * (0.7 - C.coolDelay);
  assert.ok(Math.abs(W.heat - expect) <= C.overheatCoolRate * dt + 1e-9, `heat ${W.heat}, oczekiwano ~${expect}`);
  assert.equal(W.overheated, true);
});

test('chłodzenie normalne: opóźnienie coolDelay, tempo coolRate, nie schodzi poniżej 0', () => {
  const W = createWeapon();
  const dt = 1 / 60;
  stepWeapon(W, true, dt);
  stepWeapon(W, false, dt);
  const h0 = W.heat;
  for (let i = 0; i < 12; i++) stepWeapon(W, false, dt); // ~0.23 s od strzału
  assert.equal(W.heat, h0, 'ciepło spadło przed coolDelay');
  for (let i = 0; i < 6; i++) stepWeapon(W, false, dt); // ~0.33 s od strzału
  const cooled = h0 - W.heat;
  assert.ok(cooled > 0, 'brak chłodzenia po coolDelay');
  const sinceDelay = 19 * dt - C.coolDelay;
  assert.ok(Math.abs(cooled - C.coolRate * sinceDelay) <= C.coolRate * dt + 1e-9, `schłodzono ${cooled}`);
  for (let i = 0; i < 600; i++) stepWeapon(W, false, dt);
  assert.equal(W.heat, 0);
});

test('każdy strzał zeruje opóźnienie chłodzenia (seria z przerwami 0.24 s nie chłodzi)', () => {
  const W = createWeapon();
  const dt = 1 / 60;
  let shots = 0;
  for (let i = 0; i < 600 && !W.overheated; i++) {
    const want = (i % 14) === 0; // co 0.233 s < coolDelay
    if (stepWeapon(W, want, dt)) shots++;
  }
  assert.equal(shots, 10, 'bez chłodzenia 10. strzał przegrzewa');
});

test('resetWeapon przywraca stan początkowy', () => {
  const W = createWeapon();
  holdFire(W, 1 / 60, 10);
  resetWeapon(W);
  assert.deepEqual({ ...W }, {
    type: 'phaser', C: CONFIG.weapons.phaser,
    heat: 0, cooldown: 0, sinceShot: 1e3, overheated: false, burstLeft: 0, burstTimer: 0, held: false,
  });
});
