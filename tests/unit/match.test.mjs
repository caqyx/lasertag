import test from 'node:test';
import assert from 'node:assert/strict';
const R = new URL('../../src/', import.meta.url).href;
const { CONFIG } = await import(R + 'config.js');
const { setupRoster, spawnTeamCount, MODES } = await import(R + 'game/modes.js');
const { createMatch, stepMatch, standings, createStandings, matchRunning, outcomeFor } = await import(R + 'game/match.js');

function fakeSim(roster) {
  return { participants: roster.map(r => ({ ...r, state: 'alive', stats: { score: 0, hits: 0, elims: 0, deaths: 0, shots: 0 } })) };
}
const elim = (sim, a, b) => { const A = sim.participants[a], B = sim.participants[b]; A.stats.elims++; A.stats.score += 60; B.stats.deaths++; };

test('roster ffa', () => {
  const r = setupRoster('ffa', { diff: 'hard' });
  assert.equal(r.length, 8); assert.equal(r[0].id, 0); assert.ok(r[0].isPlayer); assert.equal(r[0].level, null);
  assert.ok(r.every(x => x.team === -1)); assert.equal(new Set(r.map(x => x.color)).size, 8);
  assert.ok(r.slice(1).every(x => x.level === 'hard' && CONFIG.colors.ffa.includes(x.color)));
  assert.equal(spawnTeamCount('ffa'), 0);
  assert.equal(setupRoster('ffa', { bots: 3 }).length, 4);
  assert.equal(setupRoster('ffa', { bots: 99 }).length, CONFIG.combat.maxParticipants);
  assert.equal(setupRoster('ffa', { diff: 'xx' })[1].level, 'normal');
});
test('roster tdm2/tdm4', () => {
  for (const [id, n, per] of [['tdm2', 2, 4], ['tdm4', 4, 2]]) {
    const r = setupRoster(id, {});
    assert.equal(r.length, n * per); assert.equal(spawnTeamCount(id), n); assert.equal(r[0].team, 0);
    for (let t = 0; t < n; t++) {
      const m = r.filter(x => x.team === t);
      assert.equal(m.length, per); assert.ok(m.every(x => x.color === CONFIG.colors.teams[t]));
    }
    assert.equal(new Set(r.map(x => x.id)).size, r.length);
  }
});
test('countdown freezes, then timer', () => {
  const sim = fakeSim(setupRoster('ffa', {}));
  const M = createMatch(sim, 'ffa');
  assert.equal(M.state, 'countdown'); assert.equal(matchRunning(M), false);
  for (let i = 0; i < 179; i++) stepMatch(M, sim, 1 / 60);
  assert.equal(M.state, 'countdown'); assert.equal(M.timeLeft, 300);
  stepMatch(M, sim, 1 / 60); stepMatch(M, sim, 1 / 60);
  assert.equal(M.state, 'playing');
  stepMatch(M, sim, 1);
  assert.ok(Math.abs(M.timeLeft - 299) < 1e-9);
});
test('time limit → winner by score, then elims, else draw', () => {
  const sim = fakeSim(setupRoster('ffa', {}));
  const M = createMatch(sim, 'ffa', { countdown: 0 });
  sim.participants[3].stats.score = 100; sim.participants[3].stats.elims = 1;
  sim.participants[5].stats.score = 100; sim.participants[5].stats.elims = 2;
  for (let t = 0; t < 301 && M.state !== 'ended'; t++) stepMatch(M, sim, 1);
  assert.equal(M.state, 'ended'); assert.equal(M.endReason, 'time'); assert.equal(M.timeLeft, 0);
  assert.equal(M.winnerKind, 'player'); assert.equal(M.winner, 5);
  assert.equal(outcomeFor(M, sim.participants[0]), 'lose'); assert.equal(outcomeFor(M, sim.participants[5]), 'win');
  const s2 = fakeSim(setupRoster('ffa', {})); const M2 = createMatch(s2, 'ffa', { countdown: 0 });
  s2.participants[1].stats.score = 50; s2.participants[2].stats.score = 50;
  M2.timeLeft = 0.5; stepMatch(M2, s2, 1);
  assert.equal(M2.winnerKind, 'draw'); assert.equal(outcomeFor(M2, s2.participants[1]), 'draw');
  const before = M2.timeLeft; stepMatch(M2, s2, 1); assert.equal(M2.timeLeft, before);
});
test('ffa elim limit', () => {
  const sim = fakeSim(setupRoster('ffa', {}));
  const M = createMatch(sim, 'ffa', { countdown: 0 });
  for (let i = 0; i < 24; i++) elim(sim, 0, 1 + (i % 7));
  stepMatch(M, sim, 1 / 60); assert.equal(M.state, 'playing');
  elim(sim, 0, 1); stepMatch(M, sim, 1 / 60);
  assert.equal(M.state, 'ended'); assert.equal(M.endReason, 'limit'); assert.equal(M.winner, 0);
});
test('tdm2 team elim limit and team winner', () => {
  const sim = fakeSim(setupRoster('tdm2', {}));
  const M = createMatch(sim, 'tdm2', { countdown: 0 });
  // team 1 = odd ids
  for (let i = 0; i < 59; i++) elim(sim, 1 + 2 * (i % 4), 2 * (i % 4));
  stepMatch(M, sim, 1 / 60); assert.equal(M.state, 'playing'); assert.equal(M.teamElims[1], 59);
  elim(sim, 3, 0); stepMatch(M, sim, 1 / 60);
  assert.equal(M.state, 'ended'); assert.equal(M.winnerKind, 'team'); assert.equal(M.winner, 1);
  assert.equal(outcomeFor(M, sim.participants[0]), 'lose');
});
test('tdm4 team draw', () => {
  const sim = fakeSim(setupRoster('tdm4', {}));
  const M = createMatch(sim, 'tdm4', { countdown: 0 });
  sim.participants[0].stats.score = 30; sim.participants[1].stats.score = 30; sim.participants[2].stats.score = 10;
  M.timeLeft = 0.01; stepMatch(M, sim, 1 / 60);
  assert.equal(M.winnerKind, 'draw');
});
test('standings sort ffa and tdm grouping', () => {
  const sim = fakeSim(setupRoster('ffa', {}));
  const M = createMatch(sim, 'ffa', { countdown: 0 });
  const p = sim.participants;
  p[2].stats.score = 50; p[6].stats.score = 80; p[4].stats.score = 50; p[4].stats.elims = 1; p[1].stats.score = 50; p[1].stats.deaths = 3;
  const out = createStandings();
  standings(M, sim, out);
  assert.equal(out.count, 8);
  assert.deepEqual(out.rows.slice(0, 4).map(x => x.id), [6, 4, 2, 1]);
  assert.equal(out.rows[8], null);

  const st = fakeSim(setupRoster('tdm2', {})); const Mt = createMatch(st, 'tdm2', { countdown: 0 });
  st.participants[3].stats.score = 70; st.participants[1].stats.score = 10; st.participants[0].stats.score = 40;
  standings(Mt, st, out);
  assert.equal(out.teamCount, 2); assert.equal(out.teams[0].team, 1); assert.equal(out.teams[0].score, 80); assert.equal(out.teams[1].score, 40);
  assert.deepEqual(out.rows.slice(0, 8).map(x => x.team), [1, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal(out.rows[0].id, 3); assert.equal(out.rows[1].id, 1); assert.equal(out.rows[4].id, 0);
});
test('MODES from CONFIG', () => {
  assert.equal(MODES.tdm4.elimLimit, CONFIG.modes.tdm4.elimLimit); assert.equal(MODES.ffa.participants, 8);
});
