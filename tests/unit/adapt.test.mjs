// Testy src/game/bots/adapt.js (PLAN §8.3, SPEC §2.5): okno 60 s, ocena co 30 s, progi 1.5 / 0.67, krok 0.05,
// decay 0.025, clamp ±0.25, skillScale; integracja z mózgiem bota — skala tylko dla przeciwników gracza
// (w tdm sojusznicy gracza bez zmian, bot bez adapt bez zmian).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapt, resetAdapt, recordEvent, recordFromEvents, stepAdapt, skillScale } from '../../src/game/bots/adapt.js';
import { createEventQueue, EV } from '../../src/core/events.js';
import { buildWorld } from '../../src/world/mapgen.js';
import { buildNav } from '../../src/world/nav.js';
import { createSim, addParticipant, stepSim } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { createBotBrain } from '../../src/game/bots/ai.js';
import { CONFIG } from '../../src/config.js';

const C = CONFIG.bots.adapt;
const DEG = Math.PI / 180;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≠ ${b}`);

test('CONFIG.bots.adapt = liczby SPEC §2.5', () => {
  assert.equal(C.evalInterval, 30); assert.equal(C.window, 60);
  assert.equal(C.highRatio, 1.5); assert.equal(C.lowRatio, 0.67);
  assert.equal(C.step, 0.05); assert.equal(C.decay, 0.025); assert.equal(C.maxOffset, 0.25);
});

test('stan początkowy i ocena dopiero co 30 s (idempotentna w obrębie okresu)', () => {
  const A = createAdapt();
  assert.equal(A.offset, 0); assert.equal(A.evals, 0);
  recordEvent(A, 1, 'kill'); recordEvent(A, 2, 'kill');
  stepAdapt(A, 29.999);
  assert.equal(A.evals, 0); assert.equal(A.offset, 0);
  stepAdapt(A, 30);
  assert.equal(A.evals, 1); near(A.offset, 0.05);
  near(A.lastRatio, 3);
  stepAdapt(A, 30); stepAdapt(A, 45); stepAdapt(A, 59.9);
  assert.equal(A.evals, 1, 'wielokrotne wywołanie w okresie');
  stepAdapt(A, 60);
  assert.equal(A.evals, 2);
});

test('nadrabianie: skok czasu o kilka okresów → kolejne oceny w chwilach 30, 60, 90 (każda z własnym oknem)', () => {
  const A = createAdapt();
  recordEvent(A, 5, 'kill');                 // w oknach ocen 30 i 60, nie 90
  stepAdapt(A, 95);
  assert.equal(A.evals, 3);
  // 30: r=2 → +0.05; 60: r=2 → 0.10; 90: okno [30,90] puste → r=1 → decay → 0.075
  near(A.offset, 0.075);
});

test('okno 60 s: zdarzenia starsze niż 60 s nie liczą się; zdarzenia „z przyszłości" (po chwili oceny) też nie', () => {
  const A = createAdapt();
  for (let i = 0; i < 5; i++) recordEvent(A, 1 + i, 'death');
  stepAdapt(A, 30); near(A.offset, -0.05);     // r = 1/6
  stepAdapt(A, 60); near(A.offset, -0.10);     // nadal w oknie [0,60]
  stepAdapt(A, 90); near(A.offset, -0.075);    // okno [30,90] puste → decay
  // zdarzenie dopisane z czasem 125 przy ocenie 120 — pomijane w ocenie 120
  recordEvent(A, 125, 'kill'); recordEvent(A, 126, 'kill');
  stepAdapt(A, 120); near(A.offset, -0.05, 'ocena 120');
  stepAdapt(A, 150); near(A.offset, 0, 'ocena 150: r=3 → +0.05');
});

test('progi: r > 1.5 → +step, r < 0.67 → −step, pomiędzy (w tym dokładnie 1.5 i 0.75) → decay', () => {
  const cases = [
    // [E, D, oczekiwany offset z s0 = 0.1]
    [1, 0, 0.15],        // r = 2
    [2, 1, 0.075],       // r = 1.5 (nie > 1.5) → decay
    [3, 1, 0.15],        // r = 2
    [0, 0, 0.075],       // r = 1
    [2, 3, 0.075],       // r = 0.75
    [1, 2, 0.05],        // r = 2/3 ≈ 0.667 < 0.67 → −step
    [0, 1, 0.05],        // r = 0.5
  ];
  for (const [e, d, exp] of cases) {
    const A = createAdapt();
    A.offset = 0.1;
    for (let i = 0; i < e; i++) recordEvent(A, 10 + i, 'kill');
    for (let i = 0; i < d; i++) recordEvent(A, 20 + i, 'death');
    stepAdapt(A, 30);
    near(A.offset, exp, `E${e} D${d}:`);
    near(A.lastRatio, (e + 1) / (d + 1));
  }
});

test('decay 0.025 do zera bez przestrzelenia (z obu stron); offset = wielokrotność 0.025 (bez dryfu)', () => {
  for (const s0 of [0.1, -0.1, 0.25, -0.25, 0.04, -0.01]) {
    const A = createAdapt();
    A.offset = s0;
    let prev = Math.abs(s0);
    for (let k = 1; k <= 12; k++) {
      stepAdapt(A, 30 * k);
      const a = Math.abs(A.offset);
      assert.ok(a <= prev + 1e-12, `${s0}: |s| rośnie`);
      assert.ok(Math.sign(A.offset) === Math.sign(s0) || A.offset === 0, `${s0}: przestrzelenie zera → ${A.offset}`);
      if (prev > 0) near(prev - a, Math.min(prev, C.decay), `${s0} krok ${k}:`);
      prev = a;
    }
    assert.equal(A.offset, 0);
  }
});

test('clamp ±0.25: długa dominacja / długa porażka', () => {
  const A = createAdapt();
  const B = createAdapt();
  for (let k = 1; k <= 10; k++) {
    for (let i = 0; i < 3; i++) { recordEvent(A, 30 * k - 10 + i, 'kill'); recordEvent(B, 30 * k - 10 + i, 'death'); }
    stepAdapt(A, 30 * k); stepAdapt(B, 30 * k);
    near(A.offset, Math.min(0.25, 0.05 * k), `A k=${k}`);
    near(B.offset, -Math.min(0.25, 0.05 * k), `B k=${k}`);
  }
  assert.equal(A.offset, C.maxOffset); assert.equal(B.offset, -C.maxOffset);
});

test('pierścień zdarzeń: pojemność, najnowsze zdarzenia wygrywają; resetAdapt', () => {
  const A = createAdapt({ capacity: 4 });
  for (let i = 0; i < 10; i++) recordEvent(A, i, 'death');
  for (let i = 0; i < 4; i++) recordEvent(A, 20 + i, 'kill'); // nadpisuje śmierci
  assert.equal(A.count, 4);
  stepAdapt(A, 30);
  near(A.lastRatio, 5, 'w pierścieniu tylko 4 kille');
  resetAdapt(A);
  assert.equal(A.offset, 0); assert.equal(A.count, 0); assert.equal(A.evals, 0); assert.equal(A.nextEval, C.evalInterval);
});

test('recordFromEvents: ELIM gracza → kill/death, inne zdarzenia i cudze eliminacje ignorowane', () => {
  const q = createEventQueue(16);
  const push = (type, a, b, time) => { const r = q.push(type); r.a = a; r.b = b; r.time = time; };
  push(EV.ELIM, 0, 3, 10);  // gracz wyeliminował
  push(EV.ELIM, 4, 0, 11);  // gracz wyeliminowany
  push(EV.ELIM, 4, 5, 12);  // cudze
  push(EV.HIT, 0, 3, 13);   // nie ELIM
  push(EV.ELIM, 0, 6, 14);
  const A = createAdapt();
  recordFromEvents(A, q, 0);
  assert.equal(A.count, 3);
  stepAdapt(A, 30);
  near(A.lastRatio, (2 + 1) / (1 + 1));
});

test('skillScale: rozrzut × (1 − s), reakcja × (1 − s), obrót × (1 + s); nazwa lub obiekt poziomu; prealokowany wynik', () => {
  const A = createAdapt();
  for (const s of [0, 0.25, -0.25, 0.1]) {
    A.offset = s;
    for (const name of Object.keys(CONFIG.bots.levels)) {
      const L = CONFIG.bots.levels[name];
      const r = skillScale(A, name);
      near(r.aimSigma, L.aimSigmaDeg * (1 - s)); near(r.reaction, L.reaction * (1 - s)); near(r.turn, L.turnDegPerSec * (1 + s));
      const r2 = skillScale(A, L);
      assert.equal(r2, r, 'ten sam obiekt wyniku');
      near(r2.aimSigma, L.aimSigmaDeg * (1 - s));
    }
  }
});

// --- integracja z mózgiem bota

const world = buildWorld({
  id: 't', name: 't', seed: 1, size: { w: 40, d: 40 }, ceiling: 6, perimeter: { h: 6 },
  walls: [], ramps: [], spawns: [{ x: 0, z: 15, team: 0 }, { x: 0, z: -15, team: 1 }], cams: [], lights: [], decor: [], palette: {},
});
const nav = buildNav(world);

function adaptScene(modeTeams, offset, level = 'normal') {
  const sim = createSim({ world, seed: 1, teamCount: modeTeams });
  const A = createAdapt();
  A.offset = offset;
  A.nextEval = 1e9; // bez ocen w trakcie testu
  const list = modeTeams > 0
    ? [{ id: 0, team: 0, player: true }, { id: 1, team: 0 }, { id: 2, team: 1 }, { id: 3, team: 1 }, { id: 4, team: 0, noAdapt: true }]
    : [{ id: 0, team: -1, player: true }, { id: 1, team: -1 }, { id: 2, team: -1 }, { id: 4, team: -1, noAdapt: true }];
  const brains = {};
  for (const e of list) {
    const brain = e.player ? null : createBotBrain({ level, nav, adapt: e.noAdapt ? null : A });
    const P = addParticipant(sim, createParticipant({ id: e.id, team: e.team, isPlayer: !!e.player, inputSource: brain }));
    placeAt(P, (e.id - 2) * 3, 0, 15 * (e.team === 1 ? -1 : 1), 0);
    if (brain) brains[e.id] = brain;
  }
  for (let i = 0; i < 5; i++) { stepSim(sim, 1 / 60); sim.events.clear(); }
  return { brains, A };
}

function expectSkill(B, level, s, tag) {
  const L = CONFIG.bots.levels[level];
  near(B.sigma, L.aimSigmaDeg * (1 - s) * DEG, `${tag} sigma`);
  near(B.reaction, L.reaction * (1 - s), `${tag} reaction`);
  near(B.turn, L.turnDegPerSec * (1 + s) * DEG, `${tag} turn`);
}

test('integracja: w tdm skala tylko dla botów-przeciwników gracza; sojusznicy i bot bez adapt bez zmian', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    for (const s of [0.25, -0.25]) {
      const { brains } = adaptScene(2, s, level);
      expectSkill(brains[1], level, 0, `${level} s=${s} sojusznik #1`);
      expectSkill(brains[4], level, 0, `${level} s=${s} bez adapt #4`);
      expectSkill(brains[2], level, s, `${level} s=${s} wróg #2`);
      expectSkill(brains[3], level, s, `${level} s=${s} wróg #3`);
    }
  }
});

test('integracja: w ffa wszystkie boty z adapt są przeciwnikami gracza → skalowane', () => {
  const { brains } = adaptScene(0, 0.2, 'hard');
  expectSkill(brains[1], 'hard', 0.2, '#1');
  expectSkill(brains[2], 'hard', 0.2, '#2');
  expectSkill(brains[4], 'hard', 0, '#4 bez adapt');
});

test('integracja: bot woła stepAdapt — ocena następuje w czasie symulacji (co 30 s)', () => {
  const sim = createSim({ world, seed: 1, teamCount: 2 });
  const A = createAdapt();
  const P0 = addParticipant(sim, createParticipant({ id: 0, team: 0, isPlayer: true }));
  placeAt(P0, -15, 0, 15, 0);
  const P1 = addParticipant(sim, createParticipant({ id: 1, team: 1, inputSource: createBotBrain({ level: 'normal', nav, adapt: A }) }));
  placeAt(P1, 15, 0, -15, 0);
  recordEvent(A, 1, 'kill'); recordEvent(A, 2, 'kill');
  for (let i = 0; i < 60 * 31; i++) {
    stepSim(sim, 1 / 60); sim.events.clear();
    if (i === 60 * 29) assert.equal(A.evals, 0);
  }
  assert.equal(A.evals, 1);
  near(A.offset, 0.05);
});
