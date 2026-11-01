// Testy src/core/events.js (PLAN §7.1): pierścień prealokowanych rekordów — kolejność, reset pól, przepełnienie
// (nadpisuje najstarszy, dropped++), clear, ponowne użycie tych samych obiektów (brak alokacji).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue, EV } from '../../src/core/events.js';

test('EV: stałe typów zgodne z kontraktem, zamrożone', () => {
  assert.deepEqual({ ...EV }, { SHOT: 1, HIT: 2, ELIM: 3, RESPAWN: 4, OVERHEAT: 5, PROTECT_END: 6, LAUNCH: 7, BOUNCE: 8, PROJ_END: 9 });
  assert.ok(Object.isFrozen(EV));
});

test('push/at: kolejność od najstarszego, pola wyzerowane (a/b/team/sensor = −1)', () => {
  const Q = createEventQueue(8);
  for (let i = 0; i < 5; i++) {
    const r = Q.push(EV.SHOT);
    r.a = i; r.value = i * 1.5; r.x = 7; r.sensor = 2;
  }
  assert.equal(Q.count, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(Q.at(i).a, i);
    assert.equal(Q.at(i).value, i * 1.5);
  }
  Q.clear();
  const r = Q.push(EV.HIT);
  assert.deepEqual({ ...r }, {
    type: EV.HIT, time: 0, a: -1, b: -1, team: -1, sensor: -1, x: 0, y: 0, z: 0, x2: 0, y2: 0, z2: 0, nx: 0, ny: 0, nz: 0, value: 0,
  });
});

test('przepełnienie: nadpisuje najstarszy, count = capacity, dropped liczy nadpisane, kolejność zachowana', () => {
  const Q = createEventQueue(4);
  for (let i = 0; i < 11; i++) Q.push(EV.SHOT).a = i;
  assert.equal(Q.count, 4);
  assert.equal(Q.dropped, 7);
  assert.deepEqual([0, 1, 2, 3].map((i) => Q.at(i).a), [7, 8, 9, 10]);
  // dalsze push po przepełnieniu i częściowym zawinięciu
  Q.push(EV.ELIM).a = 11;
  assert.deepEqual([0, 1, 2, 3].map((i) => Q.at(i).a), [8, 9, 10, 11]);
  assert.equal(Q.at(3).type, EV.ELIM);
});

test('clear: count = 0, kolejne push od początku; przeplot push/clear jak w pętli (wiele kroków na klatkę)', () => {
  const Q = createEventQueue(5);
  let id = 0;
  for (let frame = 0; frame < 20; frame++) {
    const n = frame % 7; // czasem > capacity
    for (let k = 0; k < n; k++) Q.push(EV.HIT).a = id++;
    assert.equal(Q.count, Math.min(n, 5));
    for (let i = 0; i < Q.count; i++) assert.equal(Q.at(i).a, id - Q.count + i, `klatka ${frame}`);
    Q.clear();
    assert.equal(Q.count, 0);
  }
});

test('rekordy są prealokowane i używane ponownie (ten sam obiekt po zawinięciu)', () => {
  const Q = createEventQueue(3);
  const seen = new Set();
  for (let i = 0; i < 30; i++) seen.add(Q.push(EV.SHOT));
  assert.equal(seen.size, 3);
  Q.clear();
  for (let i = 0; i < 30; i++) seen.add(Q.push(EV.SHOT));
  assert.equal(seen.size, 3);
});

test('capacity: min 1, zaokrąglenie w dół', () => {
  assert.equal(createEventQueue(0).capacity, 1);
  assert.equal(createEventQueue(3.9).capacity, 3);
  const Q = createEventQueue(1);
  Q.push(EV.SHOT).a = 1;
  Q.push(EV.HIT).a = 2;
  assert.equal(Q.count, 1);
  assert.equal(Q.at(0).a, 2);
  assert.equal(Q.dropped, 1);
});
