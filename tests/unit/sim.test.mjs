// Testy src/game/sim.js (PLAN §7.6): createSim/addParticipant/stepSim/findParticipant, kolejność kroku, zdarzenia
// (bez czyszczenia w stepSim), OVERHEAT, wyeliminowany nie strzela ani się nie rusza, manekin, determinizm przy tym samym seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { createSim, addParticipant, stepSim, findParticipant } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { createDummyInput } from '../../src/game/input/dummyInput.js';
import { EV } from '../../src/core/events.js';
import { CONFIG } from '../../src/config.js';
import uvmaze from '../../src/world/maps/uvmaze.js';

const C = CONFIG.combat;
const DT = 1 / CONFIG.sim.hz;
const uv = buildWorld(uvmaze);

function openWorld(spawns = [{ x: 0, z: 10, team: 0 }]) {
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w: 60, d: 60 }, ceiling: 6, perimeter: { h: 6 },
    walls: [], ramps: [], spawns, cams: [], lights: [], decor: [], palette: {},
  });
}
/** InputSource: celuje w najbliższego żywego wroga (yaw = atan2(−dx, −dz)), opcjonalnie strzela i chodzi bokiem. */
function aimInput({ fire = true, strafe = 0 } = {}) {
  return {
    fire,
    sample(P, sim, out) {
      out.moveX = 0; out.moveZ = 0; out.jump = false; out.sprint = false; out.fire = false; out.pitch = 0;
      out.yaw = P.body.yaw;
      let best = null, bd = Infinity;
      for (const Q of sim.participants) {
        if (Q === P || Q.state !== 'alive') continue;
        const d = (Q.body.x - P.body.x) ** 2 + (Q.body.z - P.body.z) ** 2;
        if (d < bd) { bd = d; best = Q; }
      }
      if (best) {
        out.yaw = Math.atan2(-(best.body.x - P.body.x), -(best.body.z - P.body.z));
        out.fire = this.fire;
      }
      if (strafe) out.moveX = Math.sin(sim.time * 2 + P.id) * strafe;
    },
  };
}
function count(sim, type) {
  let n = 0;
  for (let i = 0; i < sim.events.count; i++) if (sim.events.at(i).type === type) n++;
  return n;
}

test('createSim: pola kontraktu, rng z seed, kolejka pusta, teams', () => {
  const sim = createSim({ world: uv, seed: 5 });
  assert.equal(sim.world, uv);
  assert.equal(sim.time, 0);
  assert.equal(sim.events.count, 0);
  assert.equal(sim.events.capacity, C.eventCapacity);
  assert.deepEqual(sim.participants, []);
  assert.ok(sim.teams.length >= 4);
  assert.deepEqual(sim.teams[0], { score: 0, elims: 0, deaths: 0 });
  assert.equal(sim.teamCount, 0);
  assert.equal(createSim({ world: uv }).rng.seed, 1, 'domyślny seed');
});

test('addParticipant: stawia na spawnie, alive, pełne HP, bez ochrony; kolejni na różnych spawnach', () => {
  const sim = createSim({ world: uv, seed: 1 });
  const used = new Set();
  for (let i = 0; i < 8; i++) {
    const P = createParticipant({ id: i });
    P.hp = 1; P.state = 'eliminated'; P.protectTimer = 1; P.weapon.heat = 0.9;
    addParticipant(sim, P);
    assert.equal(P.state, 'alive');
    assert.equal(P.hp, C.maxHp);
    assert.equal(P.protectTimer, 0);
    assert.equal(P.weapon.heat, 0);
    const sp = uv.spawns.find((s) => s.x === P.body.x && s.z === P.body.z);
    assert.ok(sp, 'nie na spawnie');
    assert.equal(P.body.yaw, sp.yaw);
    used.add(`${sp.x},${sp.z}`);
  }
  assert.equal(used.size, 8, '8 uczestników na 8 spawnach — każdy na innym');
  assert.equal(findParticipant(sim, 5).id, 5);
  assert.equal(findParticipant(sim, 99), null);
});

test('stepSim: czas rośnie, prev = pozycja przed krokiem, inputSource null nie przeszkadza', () => {
  const sim = createSim({ world: openWorld(), seed: 1 });
  const P = addParticipant(sim, createParticipant({ id: 1 }));
  const Q = addParticipant(sim, createParticipant({ id: 2, inputSource: { sample(p, s, o) { o.moveZ = 1; o.yaw = 0; } } }));
  placeAt(Q, 10, 0, 0, 0);
  for (let i = 0; i < 30; i++) {
    const x = Q.body.x, z = Q.body.z;
    stepSim(sim, DT);
    assert.equal(Q.prevX, x);
    assert.equal(Q.prevZ, z);
  }
  assert.ok(Math.abs(sim.time - 30 * DT) < 1e-12);
  assert.ok(Q.body.z < -1, 'Q poszedł do przodu (−Z)');
  assert.equal(P.state, 'alive');
});

test('stepSim nie czyści kolejki zdarzeń (robi to właściciel pętli)', () => {
  const sim = createSim({ world: openWorld(), seed: 1 });
  const A = addParticipant(sim, createParticipant({ id: 1, inputSource: aimInput() }));
  const B = addParticipant(sim, createParticipant({ id: 2 }));
  placeAt(A, 0, 0, 10, 0); placeAt(B, 0, 0, 0, 0);
  stepSim(sim, DT);
  assert.equal(count(sim, EV.SHOT), 1);
  stepSim(sim, DT);
  assert.equal(count(sim, EV.SHOT), 1, 'zdarzenie zniknęło po kolejnym kroku');
});

test('ciągły ogień w sim: kadencja, HIT ×4 → ELIM, OVERHEAT dokładnie raz przy 10. strzale, respawn po 3 s', () => {
  const sim = createSim({ world: openWorld([{ x: 25, z: 25, team: 0 }]), seed: 1 });
  const A = addParticipant(sim, createParticipant({ id: 1, inputSource: aimInput() }));
  const B = addParticipant(sim, createParticipant({ id: 2, inputSource: createDummyInput({ strafe: false }) }));
  placeAt(A, 0, 0, 10, 0); placeAt(B, 0, 0, 0, 0);
  const shotTimes = [];
  let elimT = -1, respT = -1, overheats = 0, shotsAtOverheat = -1;
  for (let i = 0; i < 6 * 60; i++) {
    stepSim(sim, DT);
    for (let k = 0; k < sim.events.count; k++) {
      const e = sim.events.at(k);
      if (e.type === EV.SHOT && e.a === A.id) shotTimes.push(sim.time);
      if (e.type === EV.ELIM) elimT = sim.time;
      if (e.type === EV.RESPAWN && e.a === B.id) respT = sim.time;
      if (e.type === EV.OVERHEAT) { overheats++; if (shotsAtOverheat < 0) shotsAtOverheat = shotTimes.length; assert.equal(e.a, A.id); }
    }
    sim.events.clear();
  }
  assert.ok(elimT > 0, 'brak eliminacji');
  // 4 strzały: t0 + 3 × fireInterval (±dt)
  assert.ok(Math.abs(elimT - shotTimes[0] - 3 * CONFIG.weapon.fireInterval) <= DT + 1e-9, `eliminacja po ${elimT - shotTimes[0]} s`);
  assert.equal(A.stats.score, 4 * CONFIG.scoring.hit + CONFIG.scoring.elimination);
  assert.equal(B.stats.deaths, 1);
  assert.ok(Math.abs(respT - elimT - C.eliminatedTime) <= DT + 1e-9, `respawn ${respT - elimT} s po eliminacji`);
  assert.equal(B.body.x, 25);
  assert.equal(B.hp, C.maxHp);
  // aimInput nie strzela bez żywego celu → przez 3 s eliminacji broń stygnie do 0; B po respawnie (25,25) jest widoczny,
  // A strzela dalej (B chroniony 2 s) → przegrzanie przy 10. strzale serii po respawnie (4 + 10 łącznie)
  assert.equal(overheats, 1);
  assert.equal(shotsAtOverheat, 14);
});

test('wyeliminowany nie strzela i nie rusza się (input.fire = true, moveZ = 1)', () => {
  const sim = createSim({ world: openWorld([{ x: 25, z: 25, team: 0 }]), seed: 1 });
  const A = addParticipant(sim, createParticipant({ id: 1, inputSource: aimInput() }));
  const B = addParticipant(sim, createParticipant({
    id: 2, inputSource: { sample(P, s, o) { o.fire = true; o.moveZ = 1; o.yaw = P.body.yaw; o.pitch = 0; } },
  }));
  placeAt(A, 0, 0, 10, 0); placeAt(B, 0, 0, 0, Math.PI); // B patrzy w +Z na A? nie: yaw π → przód +Z → w stronę A
  B.weapon.cooldown = 100; // B nie strzela przed eliminacją
  B.body.x = 0; B.body.z = 0;
  A.inputSource.fire = true;
  // B idzie w stronę A, ale A go eliminuje
  let elim = false;
  for (let i = 0; i < 120 && !elim; i++) {
    stepSim(sim, DT);
    for (let k = 0; k < sim.events.count; k++) if (sim.events.at(k).type === EV.ELIM) elim = true;
    sim.events.clear();
  }
  assert.ok(elim);
  B.weapon.cooldown = 0;
  const x = B.body.x, z = B.body.z;
  A.inputSource.fire = false;
  for (let i = 0; i < 150; i++) {
    stepSim(sim, DT);
    for (let k = 0; k < sim.events.count; k++) {
      const e = sim.events.at(k);
      assert.ok(!(e.type === EV.SHOT && e.a === B.id), `wyeliminowany strzelił (t=${sim.time})`);
    }
    sim.events.clear();
    assert.equal(B.body.x, x);
    assert.equal(B.body.z, z);
    assert.equal(B.body.vx, 0);
  }
  assert.equal(B.stats.shots, 0);
});

test('manekin: nigdy nie strzela; strafe deterministyczny (okres strafePeriod), stojący stoi', () => {
  const sim = createSim({ world: uv, seed: 1 });
  const S = addParticipant(sim, createParticipant({ id: 1, inputSource: createDummyInput({ strafe: true }) }));
  const T = addParticipant(sim, createParticipant({ id: 2, inputSource: createDummyInput({ strafe: false }) }));
  const tx = T.body.x, tz = T.body.z, yaw = S.body.yaw;
  let minMX = 0, maxMX = 0;
  for (let i = 0; i < 4 * 60; i++) {
    stepSim(sim, DT);
    minMX = Math.min(minMX, S.input.moveX);
    maxMX = Math.max(maxMX, S.input.moveX);
    assert.equal(S.input.fire, false);
    assert.equal(T.input.fire, false);
  }
  assert.equal(minMX, -C.dummy.strafeMove);
  assert.equal(maxMX, C.dummy.strafeMove);
  assert.equal(count(sim, EV.SHOT), 0);
  assert.ok(Math.abs(T.body.x - tx) < 1e-9 && Math.abs(T.body.z - tz) < 1e-9, 'stojący manekin się ruszył');
  assert.equal(S.body.yaw, yaw, 'manekin zmienił kierunek patrzenia');
});

// arena z filarami i 8 spawnami (na uvmaze spawny są w korytarzu obwodowym — bez ruchu ku celowi brak walki)
const pillars = buildWorld({
  id: 'p', name: 'p', seed: 3, size: { w: 40, d: 40 }, ceiling: 6, perimeter: { h: 6 },
  walls: [
    { x: -6, z: -6, w: 2, d: 2, h: 3 }, { x: 6, z: -6, w: 2, d: 2, h: 3 },
    { x: -6, z: 6, w: 2, d: 2, h: 3 }, { x: 6, z: 6, w: 2, d: 2, h: 3 }, { x: 0, z: 0, w: 6, d: 0.4, h: 2.5 },
  ],
  ramps: [], cams: [], lights: [], decor: [], palette: {},
  spawns: [[-15, -15], [15, -15], [15, 15], [-15, 15], [0, -16], [0, 16], [-16, 0], [16, 0]]
    .map(([x, z], i) => ({ x, z, team: i % 4, yaw: Math.atan2(x, z) })),
});

function runMatch(seed, steps) {
  const sim = createSim({ world: pillars, seed });
  for (let i = 0; i < 4; i++) addParticipant(sim, createParticipant({ id: i, inputSource: aimInput({ strafe: 0.8 }) }));
  for (let i = 4; i < 7; i++) addParticipant(sim, createParticipant({ id: i, inputSource: createDummyInput({ strafe: i % 2 === 1 }) }));
  const log = [];
  for (let s = 0; s < steps; s++) {
    stepSim(sim, DT);
    for (let k = 0; k < sim.events.count; k++) {
      const e = sim.events.at(k);
      log.push(`${e.type}:${e.a}:${e.b}:${e.sensor}:${e.value}:${e.x.toFixed(9)}:${e.z2.toFixed(9)}`);
    }
    sim.events.clear();
  }
  const state = sim.participants.map((P) => [P.body.x, P.body.y, P.body.z, P.hp, P.state, P.stats.score, P.stats.deaths, P.weapon.heat]);
  return { log, state, sim };
}

test('determinizm: ten sam seed → identyczne zdarzenia i stan (uvmaze, 4 strzelców + 3 manekiny, 60 s)', () => {
  const a = runMatch(42, 60 * 60);
  const b = runMatch(42, 60 * 60);
  assert.ok(a.log.length > 50, `mało zdarzeń (${a.log.length}) — scenariusz nie testuje walki`);
  assert.ok(a.log.some((l) => l.startsWith(`${EV.ELIM}:`)), 'brak eliminacji w scenariuszu');
  assert.ok(a.log.some((l) => l.startsWith(`${EV.RESPAWN}:`)), 'brak respawnu w scenariuszu');
  assert.deepEqual(a.log, b.log);
  assert.deepEqual(a.state, b.state);
});

test('niezmienniki meczu: punkty = 10·hits + 50·elims, suma elims = suma deaths, HP ∈ [0,4], heat ∈ [0,1]', () => {
  const { sim } = runMatch(7, 90 * 60);
  let elims = 0, deaths = 0;
  for (const P of sim.participants) {
    assert.equal(P.stats.score, P.stats.hits * CONFIG.scoring.hit + P.stats.elims * CONFIG.scoring.elimination);
    assert.ok(P.stats.hits <= P.stats.shots);
    assert.ok(P.hp >= 0 && P.hp <= C.maxHp);
    assert.ok(P.weapon.heat >= 0 && P.weapon.heat <= 1);
    elims += P.stats.elims; deaths += P.stats.deaths;
  }
  assert.equal(elims, deaths);
  assert.ok(elims > 0);
});

// ------------------------------------------------------------------------------------------------ kolizje uczestników (D-017)

/** InputSource: idzie stale w zadanym kierunku świata (yaw). */
function walkInput(yaw) {
  return { sample(P, s, o) { o.moveX = 0; o.moveZ = 1; o.yaw = yaw; o.pitch = 0; o.fire = false; o.jump = false; o.sprint = true; } };
}

test('separacja: dwa ciała idące na siebie nie nachodzą (d ≥ 2r − ε), prędkość „w siebie" wyzerowana', () => {
  const sim = createSim({ world: openWorld(), seed: 1 });
  const A = addParticipant(sim, createParticipant({ id: 1, inputSource: walkInput(Math.PI / 2) }));  // −X
  const B = addParticipant(sim, createParticipant({ id: 2, inputSource: walkInput(-Math.PI / 2) })); // +X
  placeAt(A, 3, 0, 0, Math.PI / 2); placeAt(B, -3, 0, 0, -Math.PI / 2);
  let minD = Infinity;
  for (let i = 0; i < 120; i++) {
    stepSim(sim, DT);
    minD = Math.min(minD, Math.hypot(A.body.x - B.body.x, A.body.z - B.body.z));
  }
  const rr = A.body.radius + B.body.radius;
  assert.ok(minD >= rr - 1e-6, `nachodzą: d=${minD} < ${rr}`);
  assert.ok(Math.abs(A.body.x + B.body.x) < 1e-6, 'symetryczne rozepchnięcie po połowie');
});

test('separacja: ciało wypchnięte na ścianę nie wchodzi w nią; wyeliminowany stoi', () => {
  const w = buildWorld({
    id: 't', name: 't', seed: 1, size: { w: 30, d: 30 }, ceiling: 6, perimeter: { h: 6 },
    walls: [{ x: -2, z: 0, w: 1, d: 6, h: 3 }], ramps: [], spawns: [{ x: 10, z: 10, team: 0 }], cams: [], lights: [], decor: [], palette: {},
  });
  const sim = createSim({ world: w, seed: 1 });
  const A = addParticipant(sim, createParticipant({ id: 1, inputSource: walkInput(Math.PI / 2) })); // pcha w −X
  const B = addParticipant(sim, createParticipant({ id: 2 }));                                     // stoi przy ścianie
  placeAt(A, 1.5, 0, 0, Math.PI / 2); placeAt(B, -1.5 + B.body.radius + 0.01, 0, 0, 0);
  const wallFace = -1.5;
  for (let i = 0; i < 120; i++) {
    stepSim(sim, DT);
    assert.ok(B.body.x - B.body.radius >= wallFace - 2e-3, `B w ścianie: x=${B.body.x}`);
    assert.ok(A.body.x - B.body.x >= A.body.radius + B.body.radius - 2e-3, 'A nachodzi na B');
  }
  // wyeliminowany: nie przesuwa się, żywy się od niego odbija
  B.state = 'eliminated'; B.stateTimer = 100;
  const bx = B.body.x;
  placeAt(A, bx + 2, 0, 0, Math.PI / 2);
  for (let i = 0; i < 60; i++) stepSim(sim, DT);
  assert.equal(B.body.x, bx);
  assert.ok(A.body.x - bx >= A.body.radius + B.body.radius - 1e-6);
});
