// Multiplayer → Custom (SPEC §2.6, D-039): konfiguracja (drużyny × osoby), limit 16, sloty pod M5,
// przydział spawnów (2 drużyny: sp.team % 2; 3–4: sp.team === team), punktacja i zwycięzca dla 3–4 drużyn.
import test from 'node:test';
import assert from 'node:assert/strict';
const R = new URL('../../src/', import.meta.url).href;
const { CONFIG } = await import(R + 'config.js');
const {
  setupRoster, spawnTeamCount, getMode, customMode, clampCustom, customMaxPerTeam, customTeamRange,
  buildCustomSlots, isModeId, MODES, MP_MODES,
} = await import(R + 'game/modes.js');
const { createMatch, stepMatch, standings, createStandings, outcomeFor } = await import(R + 'game/match.js');
const { buildWorld } = await import(R + 'world/mapgen.js');
const { MAPS } = await import(R + 'world/maps/index.js');
const { createSim, addParticipant, stepSim } = await import(R + 'game/sim.js');
const { createParticipant } = await import(R + 'game/participant.js');
const { awardHit, awardElim } = await import(R + 'game/scoring.js');
const { createBotBrain } = await import(R + 'game/bots/ai.js');
const { buildNav } = await import(R + 'world/nav.js');
const { EV } = await import(R + 'core/events.js');

const C = CONFIG.modes.custom;
const MAX = CONFIG.combat.maxParticipants;
const COMBOS = [];
for (let t = C.minTeams; t <= C.maxTeams; t++) for (let p = C.minPerTeam; p <= customMaxPerTeam(t); p++) COMBOS.push([t, p]);

test('CONFIG.modes.custom: klucze i spójność z limitem uczestników / kolorami drużyn', () => {
  for (const k of ['minTeams', 'maxTeams', 'minPerTeam', 'defaultTeams', 'defaultPerTeam', 'timeLimit', 'elimPerMember']) {
    assert.ok(Number.isFinite(C[k]), `brak CONFIG.modes.custom.${k}`);
  }
  assert.equal(C.minTeams, 2); assert.equal(C.maxTeams, 4); assert.equal(C.minPerTeam, 1);
  assert.ok(C.maxTeams <= CONFIG.colors.teams.length);
  assert.ok(C.defaultTeams * C.defaultPerTeam <= MAX);
  assert.deepEqual(customTeamRange(), { min: 2, max: 4 });
  assert.equal(customMaxPerTeam(2), 8); assert.equal(customMaxPerTeam(3), 5); assert.equal(customMaxPerTeam(4), 4);
  assert.ok(isModeId('custom')); assert.ok(!isModeId('xyz'));
  assert.ok(!('custom' in MODES), 'Custom nie jest trybem SOLO');
  assert.equal(MP_MODES.custom.teams, C.defaultTeams);
});

test('clampCustom: limit 16 łącznie, zakresy, wartości niepoprawne → domyślne', () => {
  assert.deepEqual(clampCustom(3, 6), { teams: 3, perTeam: 5 });
  assert.deepEqual(clampCustom(4, 5), { teams: 4, perTeam: 4 });
  assert.deepEqual(clampCustom(2, 9), { teams: 2, perTeam: 8 });
  assert.deepEqual(clampCustom(7, 0), { teams: 4, perTeam: 1 });
  assert.deepEqual(clampCustom(undefined, null), { teams: C.defaultTeams, perTeam: C.defaultPerTeam });
  assert.deepEqual(clampCustom(2.5, 'x'), { teams: C.defaultTeams, perTeam: C.defaultPerTeam });
  for (const [t, p] of COMBOS) assert.ok(t * p <= MAX);
});

test('setupRoster custom: N drużyn × osoby, gracz w drużynie 0, reszta boty, równe składy, ≤ 16', () => {
  for (const [t, p] of COMBOS) {
    const r = setupRoster('custom', { teams: t, perTeam: p, diff: 'hard', bots: 1 }); // bots ignorowane
    assert.equal(r.length, t * p, `${t}×${p}`);
    assert.ok(r.length <= MAX);
    assert.equal(r[0].id, 0); assert.ok(r[0].isPlayer); assert.equal(r[0].team, 0); assert.equal(r[0].kind, 'local');
    assert.equal(r.filter((x) => x.isPlayer).length, 1);
    assert.ok(r.slice(1).every((x) => x.kind === 'bot' && !x.isPlayer && x.level === 'hard'));
    assert.equal(new Set(r.map((x) => x.id)).size, r.length);
    for (let k = 0; k < t; k++) {
      const m = r.filter((x) => x.team === k);
      assert.equal(m.length, p, `${t}×${p}: drużyna ${k}`);
      assert.ok(m.every((x) => x.color === CONFIG.colors.teams[k]));
    }
    assert.equal(spawnTeamCount('custom', { teams: t, perTeam: p }), t);
  }
  // ponad limit → przycięte
  assert.equal(setupRoster('custom', { teams: 4, perTeam: 9 }).length, 16);
  assert.equal(setupRoster('custom', { teams: 3, perTeam: 9 }).length, 15);
  // inne tryby: kind 'local' / 'bot'
  const f = setupRoster('ffa', {});
  assert.equal(f[0].kind, 'local'); assert.ok(f.slice(1).every((x) => x.kind === 'bot'));
});

test('sloty Custom: { team, kind } — remote (M5) jako typ danych; niepoprawne sloty → z teams × perTeam', () => {
  const slots = buildCustomSlots(3, 2);
  assert.deepEqual(slots.map((s) => s.team), [0, 1, 2, 0, 1, 2]);
  assert.deepEqual(slots.map((s) => s.kind), ['local', 'bot', 'bot', 'bot', 'bot', 'bot']);
  slots[4].kind = 'remote';
  const r = setupRoster('custom', { teams: 3, perTeam: 2, slots });
  assert.equal(r[4].kind, 'remote'); assert.equal(r[4].isPlayer, false); assert.equal(r[4].team, 1);
  assert.equal(r[4].level, CONFIG.defaults.diff, 'remote do czasu sieci sterowany botem');
  // brak 'local', team poza zakresem, nieznany kind → fallback
  for (const bad of [
    [{ team: 0, kind: 'bot' }, { team: 1, kind: 'bot' }],
    [{ team: 0, kind: 'local' }, { team: 5, kind: 'bot' }],
    [{ team: 0, kind: 'local' }, { team: 1, kind: 'alien' }],
  ]) {
    const x = setupRoster('custom', { teams: 2, perTeam: 3, slots: bad });
    assert.equal(x.length, 6); assert.equal(x[0].kind, 'local');
  }
});

test('createMatch custom: N drużyn, limit eliminacji = elimPerMember × perTeam, deskryptor w M.mode', () => {
  for (const [t, p] of [[2, 4], [3, 5], [4, 4], [4, 1]]) {
    const sim = fakeSim(setupRoster('custom', { teams: t, perTeam: p }));
    const M = createMatch(sim, 'custom', { teams: t, perTeam: p, countdown: 0 });
    assert.equal(M.modeId, 'custom'); assert.equal(M.teams, t);
    assert.equal(M.elimLimit, C.elimPerMember * p); assert.equal(M.timeLimit, C.timeLimit);
    assert.equal(M.mode, getMode('custom', { teams: t, perTeam: p }));
    assert.equal(M.mode, customMode(t, p), 'deskryptor z pamięci podręcznej');
  }
  // spójność z trybami SOLO (4v4 jak tdm2, 4×2 jak tdm4)
  assert.equal(customMode(2, 4).elimLimit, CONFIG.modes.tdm2.elimLimit);
  assert.equal(customMode(4, 2).elimLimit, CONFIG.modes.tdm4.elimLimit);
});

function fakeSim(roster) {
  return { participants: roster.map((r) => ({ ...r, state: 'alive', stats: { score: 0, hits: 0, elims: 0, deaths: 0, shots: 0 } })) };
}
const elim = (sim, a, b) => { const A = sim.participants[a], B = sim.participants[b]; A.stats.elims++; A.stats.score += 60; B.stats.deaths++; };

test('punktacja 3 drużyn: standings, lider, limit eliminacji drużyny 2, zwycięzca', () => {
  const sim = fakeSim(setupRoster('custom', { teams: 3, perTeam: 2 })); // id: 0..5 → team id % 3
  const M = createMatch(sim, 'custom', { teams: 3, perTeam: 2, countdown: 0 });
  elim(sim, 2, 0); elim(sim, 5, 1); elim(sim, 1, 3);   // team 2: 2 elim., team 1: 1
  stepMatch(M, sim, 0.1);
  assert.equal(M.state, 'playing');
  assert.equal(M.teamElims[2], 2); assert.equal(M.teamElims[1], 1); assert.equal(M.teamElims[0], 0);
  assert.equal(M.teamScore[2], 120); assert.equal(M.teamScore[3], 0);
  const S = standings(M, sim, createStandings());
  assert.equal(S.teamCount, 3);
  assert.deepEqual(S.teams.slice(0, 3).map((x) => x.team), [2, 1, 0]);
  assert.deepEqual(S.rows.slice(0, 2).map((r) => r.team), [2, 2]);
  assert.equal(S.teams[0].size, 2);
  // limit: elimPerMember × 2 eliminacji drużyny 2
  for (let k = M.teamElims[2]; k < M.elimLimit; k++) elim(sim, 5, 4);
  stepMatch(M, sim, 0.1);
  assert.equal(M.state, 'ended'); assert.equal(M.endReason, 'limit');
  assert.equal(M.winnerKind, 'team'); assert.equal(M.winner, 2);
  assert.equal(outcomeFor(M, sim.participants[0]), 'lose');
  assert.equal(outcomeFor(M, sim.participants[2]), 'win');
});

test('punktacja 4 drużyn: sim.teams przyrostowo (awardHit/awardElim), remis na szczycie, czas', () => {
  const roster = setupRoster('custom', { teams: 4, perTeam: 4 });
  const sim = createSim({ world: buildWorld(MAPS.uvmaze), teamCount: 4 });
  for (const r of roster) addParticipant(sim, createParticipant({ id: r.id, team: r.team, isPlayer: r.isPlayer }));
  const P = sim.participants;
  awardHit(sim, P[3], P[0]); awardElim(sim, P[3], P[0]);   // team 3 → team 0
  awardElim(sim, P[2], P[1]);                              // team 2 → team 1
  assert.equal(sim.teams[3].score, CONFIG.scoring.hit + CONFIG.scoring.elimination);
  assert.equal(sim.teams[3].elims, 1); assert.equal(sim.teams[0].deaths, 1);
  assert.equal(sim.teams[2].score, CONFIG.scoring.elimination); assert.equal(sim.teams[1].deaths, 1);
  const M = createMatch(sim, 'custom', { teams: 4, perTeam: 4, countdown: 0 });
  stepMatch(M, sim, 0.01);
  assert.equal(M.teamScore[3], sim.teams[3].score);
  // zrównaj team 2 z team 3 (wynik i eliminacje) → remis po czasie
  awardHit(sim, P[6], P[5]);
  M.timeLeft = 0.005;
  stepMatch(M, sim, 0.01);
  assert.equal(M.state, 'ended'); assert.equal(M.endReason, 'time');
  assert.equal(M.winnerKind, 'draw'); assert.equal(outcomeFor(M, P[0]), 'draw');
});

// Spawny na prawdziwych mapach: start meczu jak main.js (createSim teamCount + addParticipant w kolejności rosteru).
function startCustom(mapId, teams, perTeam) {
  const w = buildWorld(MAPS[mapId]);
  const sim = createSim({ world: w, seed: w.seed, teamCount: spawnTeamCount('custom', { teams }) });
  for (const r of setupRoster('custom', { teams, perTeam })) {
    addParticipant(sim, createParticipant({ id: r.id, team: r.team, isPlayer: r.isPlayer }));
  }
  return { w, sim };
}
const sideOk = (teams, spTeam, team) => (teams >= 3 ? spTeam === team : spTeam % teams === team);

for (const mapId of Object.keys(MAPS)) {
  test(`${mapId}: Custom — spawny drużyn po stronach (2: % 2, 3–4: sp.team), maks. składy bez nakładania`, () => {
    const reach = CONFIG.combat.spawnOffset + 1e-6;
    for (const [teams, per] of [[2, 1], [3, 1], [4, 1], [3, 2], [4, 2], [2, 8], [3, 5], [4, 4]]) {
      const { w, sim } = startCustom(mapId, teams, per);
      assert.equal(sim.participants.length, teams * per);
      for (const P of sim.participants) {
        const b = P.body;
        // na spawnie swojej drużyny lub przesunięty o spawnOffset od niego (spawn zajęty)
        const own = w.spawns.filter((s) => sideOk(teams, s.team, P.team));
        assert.ok(own.length > 0);
        const near = own.some((s) => Math.hypot(s.x - b.x, s.z - b.z) <= reach && Math.abs(s.y - b.y) < 0.06);
        assert.ok(near, `${teams}×${per} #${P.id} (team ${P.team}) poza spawnami drużyny: ${b.x.toFixed(2)}, ${b.z.toFixed(2)}`);
      }
      // ≥ 2 spawny na drużynę → do 2 osób każda na własnym spawnie; zawsze: żadne dwa ciała w tym samym punkcie
      const pos = sim.participants.map((P) => `${P.body.x.toFixed(3)},${P.body.z.toFixed(3)}`);
      if (per <= 2) assert.equal(new Set(pos).size, pos.length, `${teams}×${per}: wspólny spawn`);
      const ps = sim.participants;
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const d = Math.hypot(ps[i].body.x - ps[j].body.x, ps[i].body.z - ps[j].body.z);
          assert.ok(d >= 2 * CONFIG.player.radius, `${teams}×${per}: #${i} i #${j} nachodzą na siebie (${d.toFixed(2)} m)`);
        }
      }
      // 3 drużyny: strona W (team 3) wolna
      if (teams === 3) {
        for (const P of sim.participants) {
          const sp = w.spawns.find((s) => s.x === P.body.x && s.z === P.body.z);
          if (sp) assert.notEqual(sp.team, 3);
        }
      }
    }
  });
}

test('mecz Custom 4×4 z botami (uvmaze, 40 s): boty strzelają tylko do wrogów, bez friendly fire, wyniki drużyn', () => {
  const w = buildWorld(MAPS.uvmaze);
  const nav = buildNav(w);
  const sim = createSim({ world: w, seed: 5, teamCount: 4 });
  for (const r of setupRoster('custom', { teams: 4, perTeam: 4, diff: 'hard' })) {
    addParticipant(sim, createParticipant({
      id: r.id, team: r.team, isPlayer: r.isPlayer, inputSource: createBotBrain({ level: 'hard', nav, adapt: null }),
    }));
  }
  const M = createMatch(sim, 'custom', { teams: 4, perTeam: 4, countdown: 0 });
  const teamOf = (id) => sim.participants[id].team;
  let hits = 0, elims = 0;
  for (let i = 0; i < 60 * 40 && M.state !== 'ended'; i++) {
    stepSim(sim, 1 / 60);
    stepMatch(M, sim, 1 / 60);
    const q = sim.events;
    for (let k = 0; k < q.count; k++) {
      const e = q.at(k);
      if (e.type === EV.HIT || e.type === EV.ELIM) {
        assert.notEqual(teamOf(e.a), teamOf(e.b), `trafienie sojusznika ${e.a} → ${e.b}`);
        if (e.type === EV.HIT) hits++; else elims++;
      }
    }
    q.clear();
  }
  assert.ok(hits > 0 && elims > 0, `brak walki: trafień ${hits}, eliminacji ${elims}`);
  let sum = 0;
  for (let t = 0; t < 4; t++) sum += M.teamScore[t];
  assert.equal(sum, sim.participants.reduce((a, P) => a + P.stats.score, 0));
});
