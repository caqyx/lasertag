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
import { createSim, addParticipant, stepSim } from '../../src/game/sim.js';
import { createParticipant } from '../../src/game/participant.js';
import { createDummyInput } from '../../src/game/input/dummyInput.js';
import { EV } from '../../src/core/events.js';
import { pickSpawn } from '../../src/game/combat.js';
import { buildNav } from '../../src/world/nav.js';
import { createBotBrain } from '../../src/game/bots/ai.js';
import neonhive from '../../src/world/maps/neonhive.js';
import reactor from '../../src/world/maps/reactor.js';
import { createAdapt, recordFromEvents } from '../../src/game/bots/adapt.js';
import { createMatch, stepMatch } from '../../src/game/match.js';

const N = 100_000;
const LIMIT = 64 * 1024;
const HAS_GC = typeof global.gc === 'function';
const world = buildWorld(uvmaze);

/**
 * { garbage, gcs, retained } dla N wywołań fn (najlepszy z 3 prób — szum JIT/deopt).
 * warmup: kroki rozgrzewki przed każdą próbą. stepSim potrzebuje dłuższej: rzadkie ścieżki (eliminacja, respawn, pickSpawn)
 * wykonują się raz na kilkaset kroków i do czasu optymalizacji JIT działają w interpreterze (HeapNumber na każdym doublu).
 */
function measure(fn, warmup = 20_000) {
  let best = null;
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < warmup; i++) fn(i);
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

// --- stepSim: kilku uczestników w ciągłym ogniu (strzały, trafienia, eliminacje, respawn/pickSpawn, ochrona, przegrzanie)
/** InputSource bez alokacji: celuje w najbliższego żywego wroga, ciągły ogień, chód bokiem/do przodu. */
function createShooterInput() {
  return {
    sample(P, sim, out) {
      const ps = sim.participants;
      const b = P.body;
      let best = -1;
      let bd = 1e18;
      for (let i = 0; i < ps.length; i++) {
        const Q = ps[i];
        if (Q === P || Q.state !== 'alive' || (Q.team >= 0 && Q.team === P.team)) continue;
        const dx = Q.body.x - b.x, dz = Q.body.z - b.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = i; }
      }
      out.fire = true;
      out.jump = false;
      out.sprint = false;
      out.pitch = 0;
      out.moveZ = 0.6;
      out.moveX = Math.sin(sim.time * 1.7 + P.id) * 0.8;
      out.yaw = best < 0 ? b.yaw : Math.atan2(-(ps[best].body.x - b.x), -(ps[best].body.z - b.z));
    },
  };
}
const arena = buildWorld({
  id: 'na', name: 'na', seed: 3, size: { w: 40, d: 40 }, ceiling: 6, perimeter: { h: 6 },
  walls: [
    { x: -6, z: -6, w: 2, d: 2, h: 3 }, { x: 6, z: -6, w: 2, d: 2, h: 3 },
    { x: -6, z: 6, w: 2, d: 2, h: 3 }, { x: 6, z: 6, w: 2, d: 2, h: 3 }, { x: 0, z: 0, w: 6, d: 0.4, h: 2.5 },
  ],
  ramps: [], cams: [], lights: [], decor: [], palette: {},
  spawns: [[-15, -15], [15, -15], [15, 15], [-15, 15], [0, -16], [0, 16], [-16, 0], [16, 0]]
    .map(([x, z], i) => ({ x, z, team: i % 4, yaw: Math.atan2(x, z) })),
});
/** Mecz: `shooters` strzelców + `dummies` manekinów; opts → createSim. */
function makeMatch(w, shooters, dummies, opts = {}, teamOf = () => -1) {
  const sim = createSim({ world: w, seed: 11, ...opts });
  let id = 0;
  for (let i = 0; i < shooters; i++, id++) addParticipant(sim, createParticipant({ id, team: teamOf(id), inputSource: createShooterInput() }));
  for (let i = 0; i < dummies; i++, id++) addParticipant(sim, createParticipant({ id, team: teamOf(id), inputSource: createDummyInput({ strafe: (i & 1) === 1 }) }));
  return sim;
}
const ffaSim = makeMatch(arena, 4, 2);
const teamSim = makeMatch(arena, 6, 0, { teamCount: 2, friendlyFire: false }, (id) => id & 1);
const ffSim = makeMatch(arena, 4, 0, { teamCount: 2, friendlyFire: true }, (id) => id & 1);
const uvSim = makeMatch(world, 4, 3);
const SUB = 4; // kroki symulacji na „klatkę" (kolejkę czyści właściciel pętli raz na klatkę)
/** Jeden krok + czyszczenie kolejki co SUB kroków (jak main.js). */
function simStep(sim, i) {
  stepSim(sim, 1 / 60);
  if ((i % SUB) === SUB - 1) sim.events.clear();
}

const WARMUP = { };
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
  'stepSim (FFA, 4 strzelców + 2 manekiny)': (i) => simStep(ffaSim, i),
  'stepSim (TDM 3v3, teamCount 2)': (i) => simStep(teamSim, i),
  'stepSim (friendlyFire, 2v2)': (i) => simStep(ffSim, i),
  'stepSim (uvmaze, 4 strzelców + 3 manekiny)': (i) => simStep(uvSim, i),
};
// stepSim z 8 botami (createBotBrain: patrol/engage/cover/chase, nav, widzenie) na każdej mapie
const LEVELS = ['easy', 'normal', 'hard'];
for (const [mapName, data] of [['uvmaze', uvmaze], ['neonhive', neonhive], ['reactor', reactor]]) {
  const w = mapName === 'uvmaze' ? world : buildWorld(data);
  const nav = buildNav(w);
  const sim = createSim({ world: w, seed: 21 });
  for (let id = 0; id < 8; id++) {
    addParticipant(sim, createParticipant({ id, inputSource: createBotBrain({ level: LEVELS[id % 3], nav, adapt: null }) }));
  }
  SCENARIOS[`stepSim (${mapName}, 8 botów)`] = (i) => simStep(sim, i);
}
// Pełna pętla meczu jak main.js: gracz (isPlayer) + 8 botów z adaptacją, stepMatch i recordFromEvents co krok.
{
  const nav = buildNav(world);
  const sim = createSim({ world, seed: 33 });
  const adapt = createAdapt();
  addParticipant(sim, createParticipant({ id: 0, isPlayer: true, inputSource: createDummyInput({ strafe: true }) }));
  for (let id = 1; id <= 8; id++) {
    addParticipant(sim, createParticipant({ id, inputSource: createBotBrain({ level: LEVELS[id % 3], nav, adapt }) }));
  }
  const M = createMatch(sim, 'ffa', { countdown: 0 });
  const ps = sim.participants;
  SCENARIOS['stepSim + stepMatch + adapt (uvmaze, gracz + 8 botów)'] = () => {
    stepSim(sim, 1 / 60);
    stepMatch(M, sim, 1 / 60);
    recordFromEvents(adapt, sim.events, 0);
    sim.events.clear();
    if (M.state === 'ended') {   // nowy „mecz" bez alokacji: zeruj wyniki i czas
      for (let k = 0; k < ps.length; k++) { const st = ps[k].stats; st.score = 0; st.elims = 0; st.deaths = 0; st.hits = 0; st.shots = 0; }
      M.state = 'playing'; M.timeLeft = M.timeLimit; M.elapsed = 0; M.sinceStart = 0;
    }
  };
}
for (const k of Object.keys(SCENARIOS)) if (k.startsWith('stepSim')) WARMUP[k] = 200_000;

// pickSpawn z „żywymi" (zmiennymi) pozycjami uczestników — jak przy respawnie w meczu. Uczestnicy przesuwani po okręgu.
const psSim = makeMatch(arena, 6, 0);
const psAng = new Float64Array(1);
SCENARIOS['pickSpawn (ruchomi uczestnicy)'] = () => {
  const ps = psSim.participants;
  psAng[0] += 0.01;
  for (let k = 1; k < ps.length; k++) {
    const b = ps[k].body;
    b.x = Math.cos(psAng[0] + k) * 12;
    b.z = Math.sin(psAng[0] + k) * 12;
  }
  pickSpawn(psSim, ps[0]);
};

// Wcześniej (wariant ostry) todo: combat.pickSpawn / stepSim pakowały argumenty double w segmentClear (boxing V8).
// Naprawione: combat.js i bots/ai.js używają segmentClearSeg/SEG, raycastWorldBuf/RAYARG, nearestNodeBuf/NEAR.
const TODO = {};

test('stepSim scenariusze alokacji faktycznie walczą (strzały, trafienia, eliminacje, respawny, przegrzania)', () => {
  const sim = makeMatch(arena, 4, 2);
  const seen = new Set();
  for (let i = 0; i < 60 * 60; i++) {
    stepSim(sim, 1 / 60);
    for (let k = 0; k < sim.events.count; k++) seen.add(sim.events.at(k).type);
    sim.events.clear();
  }
  for (const t of [EV.SHOT, EV.HIT, EV.ELIM, EV.RESPAWN, EV.OVERHEAT, EV.PROTECT_END]) {
    assert.ok(seen.has(t), `scenariusz nie generuje zdarzenia ${t}`);
  }
});

test('kontrola negatywna: pomiar wykrywa alokację {} na wywołanie', (t) => {
  if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
  const sink = [null];
  const r = measure((i) => { sink[0] = { i }; });
  assert.equal(r.clean, false, `alokacja niewykryta: ${fmt(r)}`);
});

for (const [name, fn] of Object.entries(SCENARIOS)) {
  test(`${name}: brak wycieku (heapUsed po gc)`, (t) => {
    if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
    const r = measure(fn, WARMUP[name]);
    assert.ok(r.retained < LIMIT, `${name}: ${fmt(r)}`);
  });
}

// Wariant ostry. Historia: przed refaktorem physics.js (argumenty/wyniki przez Float64Array scratch) moveBody alokował
// ~200 B/wywołanie, raycastWorld ~96 B, segmentClear ~112 B, stepMovement ~115 B (boxing doubli na granicach
// nie-inline'owanych funkcji). Ten test pilnuje, żeby to nie wróciło.
for (const [name, fn] of Object.entries(SCENARIOS)) {
  test(`${name}: zero śmieci w pętli (bez gc, 0 zdarzeń GC)`, { todo: TODO[name] }, (t) => {
    if (!HAS_GC) { t.skip('brak global.gc — uruchom z node --expose-gc'); return; }
    const r = measure(fn, WARMUP[name]);
    assert.ok(r.clean, `${name}: ${fmt(r)}`);
  });
}
