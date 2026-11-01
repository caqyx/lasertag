// Testy src/game/scoring.js (SPEC §2.4, PLAN §7.5): hit +10, eliminacja +50 (trafienie eliminujące = oba), deaths,
// sumy drużynowe sim.teams i teamScores (suma wyników członków).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { awardHit, awardElim, teamScores } from '../../src/game/scoring.js';
import { createSim } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { resolveShot } from '../../src/game/combat.js';
import { buildWorld } from '../../src/world/mapgen.js';
import { CONFIG } from '../../src/config.js';

const S = CONFIG.scoring;
const world = buildWorld({
  id: 't', name: 't', seed: 1, size: { w: 40, d: 40 }, ceiling: 6, perimeter: { h: 6 },
  walls: [], ramps: [], spawns: [{ x: 0, z: 15, team: 0 }], cams: [], lights: [], decor: [], palette: {},
});

function setup(teams) {
  const sim = createSim({ world, seed: 1 });
  const ps = teams.map((t, i) => {
    const P = createParticipant({ id: i, team: t });
    sim.participants.push(P);
    return P;
  });
  return { sim, ps };
}

test('awardHit: +hit dla strzelca, hits++, cel bez zmian', () => {
  const { sim, ps: [A, B] } = setup([-1, -1]);
  awardHit(sim, A, B);
  assert.equal(A.stats.score, S.hit);
  assert.equal(A.stats.hits, 1);
  assert.deepEqual(B.stats, { score: 0, hits: 0, elims: 0, deaths: 0, shots: 0 });
});

test('awardElim: +elimination dla strzelca, elims++, cel deaths++ i 0 pkt', () => {
  const { sim, ps: [A, B] } = setup([-1, -1]);
  awardElim(sim, A, B);
  assert.equal(A.stats.score, S.elimination);
  assert.equal(A.stats.elims, 1);
  assert.equal(B.stats.deaths, 1);
  assert.equal(B.stats.score, 0);
});

test('FFA (team −1): sumy drużynowe nietknięte', () => {
  const { sim, ps: [A, B] } = setup([-1, -1]);
  awardHit(sim, A, B);
  awardElim(sim, A, B);
  for (const T of sim.teams) assert.deepEqual(T, { score: 0, elims: 0, deaths: 0 });
});

test('drużyny: sim.teams przyrostowo (score, elims, deaths) zgodne z teamScores', () => {
  const { sim, ps: [A0, B0, A1, B1] } = setup([0, 0, 1, 1]);
  awardHit(sim, A0, A1);
  awardHit(sim, B0, A1);
  awardElim(sim, B0, A1);
  awardHit(sim, A1, A0);
  assert.deepEqual(sim.teams[0], { score: 2 * S.hit + S.elimination, elims: 1, deaths: 0 });
  assert.deepEqual(sim.teams[1], { score: S.hit, elims: 0, deaths: 1 });
  const out = new Float64Array(4);
  assert.equal(teamScores(sim, out), out);
  assert.deepEqual([...out], [2 * S.hit + S.elimination, S.hit, 0, 0]);
  assert.equal(out[0], A0.stats.score + B0.stats.score);
  assert.equal(out[1], A1.stats.score + B1.stats.score);
});

test('teamScores: zeruje out, pomija team −1 i team ≥ out.length', () => {
  const { sim, ps } = setup([0, 3, -1]);
  ps[0].stats.score = 10; ps[1].stats.score = 70; ps[2].stats.score = 500;
  const out = [99, 99, 99];
  teamScores(sim, out);
  assert.deepEqual(out, [10, 0, 0]);
});

test('przez resolveShot: 4 trafienia = 4·hit + elimination = 90 dla strzelca, 1 death dla celu', () => {
  const sim = createSim({ world, seed: 1 });
  const A = createParticipant({ id: 1, team: 0 });
  const B = createParticipant({ id: 2, team: 1 });
  sim.participants.push(A, B);
  placeAt(A, 0, 0, 6, 0);
  placeAt(B, 0, 0, 0, 0);
  for (let k = 0; k < 4; k++) resolveShot(sim, A);
  assert.equal(A.stats.score, 4 * S.hit + S.elimination);
  assert.equal(A.stats.score, 90);
  assert.equal(B.stats.deaths, 1);
  assert.equal(sim.teams[0].score, 90);
  assert.equal(sim.teams[0].elims, 1);
  assert.equal(sim.teams[1].deaths, 1);
  // strzał w wyeliminowanego nie daje punktów
  resolveShot(sim, A);
  assert.equal(A.stats.score, 90);
  assert.equal(A.stats.shots, 5);
});
