// Testy src/game/bots/ai.js (PLAN §8.2, SPEC §2.5) w kontrolowanych scenach: czas reakcji per poziom, brak ognia
// przy przegrzaniu / do sojusznika / gdy sojusznik na linii, osłona przy HP ≤ coverHp (koniec w węźle bez linii wzroku
// do napastnika), pościg → patrol po chaseTime, brak utknięcia (8 botów × 90 s na każdej mapie), ranking poziomów
// (hard > normal > easy eliminacji, 3 seedy), determinizm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { buildNav } from '../../src/world/nav.js';
import { segmentClear } from '../../src/world/physics.js';
import { createSim, addParticipant, stepSim } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { createBotBrain, BOT_STATE } from '../../src/game/bots/ai.js';
import { CONFIG } from '../../src/config.js';
import { MAPS } from '../../src/world/maps/index.js';

const DT = 1 / CONFIG.sim.hz;
const LV = CONFIG.bots.levels;
const EYE = CONFIG.player.eyeHeight;

/** Arena testowa: otwarta hala w × d, opcjonalne bryły (format MapData.walls). */
function arena({ w = 60, d = 60, walls = [], spawns } = {}) {
  const e = Math.min(w, d) / 2 - 3;
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w, d }, ceiling: 6, perimeter: { h: 6 },
    walls, ramps: [],
    spawns: spawns || [{ x: 0, z: e, team: 0 }, { x: 0, z: -e, team: 1 }, { x: e, z: 0, team: 0 }, { x: -e, z: 0, team: 1 }],
    cams: [], lights: [], decor: [], palette: {},
  });
}
const wall = (x, z, w, d, h = 3, kind = 'wall') => ({ x, z, w, d, h, y: 0, rot: 0, kind });

/** Sim z uczestnikami: [{ id, team, level?, x, z, yaw, bot? }] (bot = mózg; inaczej stoi). */
function scene(world, nav, list, o = {}) {
  const sim = createSim({ world, seed: o.seed ?? 1, teamCount: o.teamCount ?? 0 });
  const brains = {};
  for (const e of list) {
    const brain = e.level ? createBotBrain({ level: e.level, nav, adapt: e.adapt || null }) : null;
    const P = addParticipant(sim, createParticipant({ id: e.id, team: e.team ?? -1, isPlayer: !!e.isPlayer, inputSource: brain }));
    placeAt(P, e.x, 0, e.z, e.yaw ?? 0);
    if (brain) brains[e.id] = brain;
  }
  return { sim, brains, P: (id) => sim.participants.find((p) => p.id === id) };
}
/** yaw patrzenia z (x,z) na (tx,tz). */
const yawTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/** Owija mózg: rejestruje (czas, stan, fire, przegrzanie) w każdym kroku. */
function spy(P, hook) {
  const src = P.inputSource;
  P.inputSource = { sample(p, s, out) { src.sample(p, s, out); hook(p, s, out); } };
}
function run(sim, seconds, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    stepSim(sim, DT);
    sim.events.clear();
    if (each && each(i) === false) break;
  }
}

const OPEN = arena();
const OPEN_NAV = buildNav(OPEN);

// ---------------------------------------------------------------------------------------------

test('czas reakcji: pierwszy strzał nie wcześniej niż reaction po zauważeniu; hard < normal < easy', () => {
  const first = {};
  for (const level of ['easy', 'normal', 'hard']) {
    const S = scene(OPEN, OPEN_NAV, [
      { id: 0, team: 0, level, x: 0, z: 10, yaw: 0 },
      { id: 1, team: 1, x: 0, z: 0, yaw: Math.PI },
    ], { teamCount: 2 });
    const B = S.brains[0];
    const T = S.P(1);
    T.protectTimer = 0;
    let seenAt = -1, shotAt = -1;
    spy(S.P(0), (p, s, out) => {
      if (seenAt < 0 && B.targetVisible) seenAt = s.time;
      if (shotAt < 0 && out.fire) shotAt = s.time;
    });
    run(S.sim, 3, () => shotAt < 0);
    assert.ok(seenAt >= 0, `${level}: bot nie zauważył celu`);
    assert.ok(seenAt <= CONFIG.bots.thinkInterval + DT + 1e-9, `${level}: zauważył po ${seenAt} s (> thinkInterval)`);
    assert.ok(shotAt > 0, `${level}: bot nie strzelił`);
    const r = LV[level].reaction;
    assert.ok(shotAt - seenAt >= r - DT - 1e-9, `${level}: strzał ${(shotAt - seenAt).toFixed(3)} s po zauważeniu < reaction ${r}`);
    assert.ok(shotAt - seenAt <= r + 0.35, `${level}: strzał dopiero po ${(shotAt - seenAt).toFixed(3)} s`);
    first[level] = shotAt - seenAt;
  }
  assert.ok(first.hard < first.normal && first.normal < first.easy, JSON.stringify(first));
});

test('brak ognia przy przegrzaniu (wymuszone i naturalne)', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const S = scene(OPEN, OPEN_NAV, [
      { id: 0, team: 0, level, x: 0, z: 10, yaw: 0 },
      { id: 1, team: 1, x: 0, z: 0, yaw: Math.PI },
    ], { teamCount: 2 });
    const P = S.P(0); const T = S.P(1);
    let bad = 0, fired = 0, overSteps = 0;
    spy(P, (p, s, out) => {
      if (out.fire) fired++;
      if (p.weapon.overheated) { overSteps++; if (out.fire) bad++; }
    });
    // cel nieśmiertelny (HP odnawiane), żeby walka trwała; co 2 s wymuszone przegrzanie na 0.5 s
    run(S.sim, 12, (i) => {
      T.hp = 4; T.sensorsLit = 4; T.state = 'alive';
      if (i % 120 === 60) { P.weapon.heat = 1; P.weapon.overheated = true; }
    });
    assert.ok(fired > 10, `${level}: bot prawie nie strzelał (${fired})`);
    assert.ok(overSteps > 30, `${level}: brak kroków z przegrzaniem`);
    assert.equal(bad, 0, `${level}: fire=true przy przegrzaniu w ${bad} krokach`);
  }
});

test('nie strzela do sojusznika (sam sojusznik w polu widzenia) ani gdy sojusznik stoi na linii do wroga', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    // a) tylko sojusznik przed botem
    let S = scene(OPEN, OPEN_NAV, [
      { id: 0, team: 0, level, x: 0, z: 10, yaw: 0 },
      { id: 2, team: 0, x: 0, z: 5, yaw: 0 },
    ], { teamCount: 2 });
    let fire = 0;
    spy(S.P(0), (p, s, out) => { if (out.fire) fire++; });
    run(S.sim, 3);
    assert.equal(fire, 0, `${level}: strzelał do sojusznika`);
    assert.notEqual(S.brains[0].target && S.brains[0].target.team, 0);

    // b) sojusznik na linii bot → wróg (bot stoi: ruch wyłączony przez przytrzymanie pozycji)
    S = scene(OPEN, OPEN_NAV, [
      { id: 0, team: 0, level, x: 0, z: 10, yaw: 0 },
      { id: 1, team: 1, x: 0, z: 0, yaw: Math.PI },
      { id: 2, team: 0, x: 0, z: 5, yaw: 0 },
    ], { teamCount: 2 });
    const P = S.P(0); const A = S.P(2);
    let blocked = 0, total = 0;
    spy(P, (p, s, out) => {
      // geometria: czy sojusznik zasłania linię oko → klatka wroga (walec r = hitCapsuleRadius)
      const T = S.P(1).body;
      const ox = p.body.x, oz = p.body.z, vx = T.x - ox, vz = T.z - oz;
      const t = ((A.body.x - ox) * vx + (A.body.z - oz) * vz) / (vx * vx + vz * vz);
      const px = ox + vx * t - A.body.x, pz = oz + vz * t - A.body.z;
      const inLine = t > 0 && t < 1 && Math.hypot(px, pz) < CONFIG.combat.hitCapsuleRadius;
      if (inLine) { total++; if (out.fire) blocked++; }
    });
    run(S.sim, 4, () => {
      const b = P.body; b.x = 0; b.z = 10; b.vx = 0; b.vz = 0;   // bot nie obchodzi sojusznika
      const a = A.body; a.x = 0; a.z = 5; a.vx = 0; a.vz = 0;
    });
    assert.ok(total > 60, `${level}: scena nie ustawiła sojusznika na linii (${total})`);
    assert.equal(blocked, 0, `${level}: strzał przez sojusznika w ${blocked}/${total} krokach`);

    // c) kontrola: bez sojusznika ten sam układ → strzela
    S = scene(OPEN, OPEN_NAV, [
      { id: 0, team: 0, level, x: 0, z: 10, yaw: 0 },
      { id: 1, team: 1, x: 0, z: 0, yaw: Math.PI },
    ], { teamCount: 2 });
    run(S.sim, 2);
    assert.ok(S.P(0).stats.shots > 0, `${level}: kontrola — bot nie strzela`);
  }
});

// Scena osłony: hala z kilkoma ścianami-osłonami; napastnik (chroniony, nie strzela) widoczny dla bota.
const COVER_WORLD = arena({
  w: 40, d: 40,
  walls: [wall(-6, 2, 4, 1, 2.4), wall(6, 2, 4, 1, 2.4), wall(0, 6, 1, 4, 2.4), wall(-10, 8, 1, 4, 2.4), wall(10, 8, 1, 4, 2.4),
    wall(-3, 12, 3, 1, 2.4), wall(3, 12, 3, 1, 2.4)],
});
const COVER_NAV = buildNav(COVER_WORLD);

test('osłona przy HP ≤ coverHp: stan cover, koniec w węźle bez linii wzroku do napastnika', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    for (const seed of [1, 2, 3]) {
      const S = scene(COVER_WORLD, COVER_NAV, [
        { id: 0, team: 0, level, x: 0, z: 0, yaw: 0 },
        { id: 1, team: 1, x: 0, z: -12, yaw: 0 },
      ], { teamCount: 2, seed });
      const P = S.P(0); const T = S.P(1); const B = S.brains[0];
      T.protectTimer = 1e9; // bot nie zestrzeli napastnika (nie strzela do chronionych)
      P.hp = LV[level].coverHp; P.sensorsLit = P.hp;
      let coverAt = -1, arrived = -1, los = null;
      run(S.sim, 8, () => {
        if (coverAt < 0 && B.state === BOT_STATE.COVER) coverAt = S.sim.time;
        if (coverAt >= 0 && arrived < 0 && B.state === BOT_STATE.COVER && B.pathIdx >= B.pathLen) arrived = S.sim.time;
        // ocena po wyhamowaniu (0.5 s po dojściu; coverHold = 2 s, więc bot wciąż trzyma osłonę)
        if (arrived > 0 && S.sim.time - arrived >= 0.5) {
          const n = B.coverNode;
          los = {
            state: B.state,
            node: segmentClear(COVER_WORLD, T.body.x, T.body.y + EYE, T.body.z, COVER_NAV.x[n], COVER_NAV.y[n] + EYE, COVER_NAV.z[n]),
            body: segmentClear(COVER_WORLD, T.body.x, T.body.y + EYE, T.body.z, P.body.x, P.body.y + EYE, P.body.z),
            speed: Math.hypot(P.body.vx, P.body.vz),
          };
          return false;
        }
      });
      const tag = `${level}/seed ${seed}`;
      assert.ok(coverAt >= 0 && coverAt < 1, `${tag}: brak przejścia w cover (stan ${B.state})`);
      assert.ok(arrived > 0 && los, `${tag}: nie dotarł do osłony w 8 s`);
      assert.equal(los.state, BOT_STATE.COVER, `${tag}: 0.5 s po dojściu już nie w osłonie`);
      assert.equal(B.threat, T, `${tag}: threat`);
      assert.equal(los.node, false, `${tag}: węzeł osłony widoczny dla napastnika`);
      assert.equal(los.body, false, `${tag}: bot w osłonie widoczny dla napastnika (oko→oko)`);
    }
  }
  // HP > coverHp → bez osłony (easy: coverHp 1 → przy HP 2 walczy)
  const S = scene(COVER_WORLD, COVER_NAV, [
    { id: 0, team: 0, level: 'easy', x: 0, z: 0, yaw: 0 },
    { id: 1, team: 1, x: 0, z: -12, yaw: 0 },
  ], { teamCount: 2 });
  S.P(1).protectTimer = 1e9; S.P(0).hp = 2;
  let cover = false;
  run(S.sim, 3, () => { if (S.brains[0].state === BOT_STATE.COVER) cover = true; });
  assert.equal(cover, false, 'easy przy HP 2 nie powinien szukać osłony (coverHp 1)');
});

test('hard: osłona także przy przegrzaniu (coverOnOverheat), normal nie', () => {
  for (const [level, expect] of [['hard', true], ['normal', false]]) {
    const S = scene(COVER_WORLD, COVER_NAV, [
      { id: 0, team: 0, level, x: 0, z: 0, yaw: 0 },
      { id: 1, team: 1, x: 0, z: -12, yaw: 0 },
    ], { teamCount: 2 });
    const P = S.P(0); S.P(1).protectTimer = 1e9;
    let cover = false;
    run(S.sim, 1.5, () => {
      P.weapon.heat = 1; P.weapon.overheated = true;
      if (S.brains[0].state === BOT_STATE.COVER) cover = true;
    });
    assert.equal(cover, expect, `${level}: cover przy przegrzaniu = ${cover}`);
  }
});

// Pościg: wróg znika z widoku (teleport do zamkniętego pomieszczenia) → chase przez ≤ chaseTime → patrol.
const ROOM = [wall(-24, -27, 6, 0.5), wall(-24, -21, 6, 0.5), wall(-27, -24, 0.5, 6), wall(-21, -24, 0.5, 6)];
const CHASE_WORLD = arena({ walls: ROOM });
const CHASE_NAV = buildNav(CHASE_WORLD);

test('pościg kończy się patrolem po chaseTime (lub po dojściu do ostatniej znanej pozycji)', () => {
  for (const level of ['easy', 'normal', 'hard']) {
    const dist = LV[level].viewDist - 4;
    const S = scene(CHASE_WORLD, CHASE_NAV, [
      { id: 0, team: 0, level, x: 0, z: 25, yaw: 0 },
      { id: 1, team: 1, x: 0, z: 25 - dist, yaw: Math.PI },
    ], { teamCount: 2 });
    const B = S.brains[0]; const T = S.P(1);
    T.protectTimer = 1e9;
    const states = [];
    let engageAt = -1, chaseAt = -1, patrolAt = -1;
    run(S.sim, 12, () => {
      const t = S.sim.time;
      if (states[states.length - 1] !== B.state) states.push(B.state);
      if (engageAt < 0 && B.state === BOT_STATE.ENGAGE) engageAt = t;
      if (engageAt >= 0 && chaseAt < 0 && t - engageAt > 0.8) {
        placeAt(T, -24, 0, -24, 0); // zamknięte pomieszczenie — bez linii wzroku
      }
      if (chaseAt < 0 && B.state === BOT_STATE.CHASE) chaseAt = t;
      if (chaseAt >= 0 && patrolAt < 0 && B.state === BOT_STATE.PATROL) { patrolAt = t; return false; }
    });
    assert.ok(engageAt >= 0, `${level}: brak engage (${states})`);
    assert.ok(chaseAt >= 0, `${level}: brak chase (${states})`);
    assert.ok(patrolAt >= 0, `${level}: chase nie przeszedł w patrol (${states})`);
    const dur = patrolAt - chaseAt;
    assert.ok(dur <= CONFIG.bots.chaseTime + CONFIG.bots.thinkInterval + 2 * DT, `${level}: pościg ${dur.toFixed(2)} s > chaseTime`);
    // przy dystansie > chaseTime × sprint pościg kończy limit czasu (nie dojście)
    if (dist > CONFIG.bots.chaseTime * CONFIG.player.sprintSpeed + 2) {
      assert.ok(dur >= CONFIG.bots.chaseTime - CONFIG.bots.thinkInterval - 2 * DT, `${level}: pościg za krótki ${dur.toFixed(2)} s`);
    }
    assert.equal(B.target, null, `${level}: cel nie wyczyszczony po pościgu`);
  }
});

// ---------------------------------------------------------------------------------------------
// Mecze botów na mapach (wspólne dla testów utknięcia/rankingu/determinizmu)

const WORLDS = {}; const NAVS = {};
for (const id of Object.keys(MAPS)) { WORLDS[id] = buildWorld(MAPS[id]); NAVS[id] = buildNav(WORLDS[id]); }

/** FFA botów: levels[i] dla id i. Śledzi „czas bez postępu" (bot chce iść, a przesunięcie < stuckMinMove). */
function botMatch(mapId, levels, seed, seconds) {
  const w = WORLDS[mapId]; const nav = NAVS[mapId];
  const sim = createSim({ world: w, seed });
  const brains = [];
  for (let id = 0; id < levels.length; id++) {
    const brain = createBotBrain({ level: levels[id], nav, adapt: null });
    brains.push(brain);
    addParticipant(sim, createParticipant({ id, inputSource: brain }));
  }
  const n = levels.length;
  const ax = new Float64Array(n), az = new Float64Array(n), since = new Float64Array(n);
  const level = new Int8Array(n).fill(-1); // -1 nieznany, 0 parter, 1 galeria (y > 3)
  const climbs = { up: 0, down: 0 };
  const worst = { t: 0, id: -1, x: 0, z: 0, state: '' };
  const min = CONFIG.bots.stuckMinMove;
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    stepSim(sim, DT);
    sim.events.clear();
    for (let i = 0; i < n; i++) {
      const P = sim.participants[i]; const B = brains[i]; const b = P.body;
      if (P.state === 'alive') {
        const lv = b.y < 0.1 ? 0 : b.y > 3.0 ? 1 : -2;
        if (lv >= 0) {
          if (level[i] === 0 && lv === 1) climbs.up++;
          if (level[i] === 1 && lv === 0) climbs.down++;
          level[i] = lv;
        }
      } else level[i] = -1; // respawn nie liczy się jako przejście
      const moved = Math.hypot(b.x - ax[i], b.z - az[i]) >= min;
      if (P.state !== 'alive' || !B.moving || moved) { ax[i] = b.x; az[i] = b.z; since[i] = 0; continue; }
      since[i] += DT;
      if (since[i] > worst.t) Object.assign(worst, { t: since[i], id: i, x: b.x, z: b.z, state: B.state, time: sim.time });
    }
  }
  return { sim, brains, worst, climbs };
}

for (const id of Object.keys(MAPS)) {
  test(`${id}: 8 botów × 90 s — brak utknięcia (max czas bez postępu < 3·stuckTime), patrol pokrywa mapę`, (t) => {
    const levels = ['easy', 'normal', 'hard', 'easy', 'normal', 'hard', 'normal', 'hard'];
    const { sim, brains, worst, climbs } = botMatch(id, levels, 4, 90);
    if (id === 'reactor') {
      // M4: boty nawigują na obu poziomach (wejście rampą na galerię i zejście)
      t.diagnostic(`reactor: wejść na galerię ${climbs.up}, zejść ${climbs.down}`);
      assert.ok(climbs.up >= 2 && climbs.down >= 2, `reactor: przejścia między poziomami ${JSON.stringify(climbs)}`);
    }
    const lim = 3 * CONFIG.bots.stuckTime;
    assert.ok(worst.t < lim,
      `bot #${worst.id} bez postępu ${worst.t.toFixed(2)} s (≥ ${lim} s) w (${worst.x.toFixed(2)}, ${worst.z.toFixed(2)}) stan ${worst.state} t=${worst.time?.toFixed(1)}`);
    let elims = 0;
    for (const P of sim.participants) elims += P.stats.elims;
    t.diagnostic(`max bez postępu ${worst.t.toFixed(2)} s (bot #${worst.id}), eliminacji ${elims}, odwiedzone węzły min ${Math.min(...brains.map((B) => B.visitedCount))}`);
    assert.ok(elims >= 8, `za mało walki: ${elims} eliminacji w 90 s`);
    for (const B of brains) assert.ok(B.visitedCount > 30, `bot odwiedził tylko ${B.visitedCount} węzłów`);
    // nikt nie wypadł poza mapę / pod podłogę
    for (const P of sim.participants) {
      const b = P.body; const bd = WORLDS[id].bounds;
      assert.ok(b.x > bd.minX && b.x < bd.maxX && b.z > bd.minZ && b.z < bd.maxZ && b.y > -0.01, `#${P.id} poza mapą`);
    }
  });
}

test('ranking poziomów: hard > normal > easy eliminacji (FFA 3×3 botów, 3 seedy, 120 s)', (t) => {
  const levels = ['easy', 'normal', 'hard', 'easy', 'normal', 'hard', 'easy', 'normal', 'hard'];
  const tot = { easy: 0, normal: 0, hard: 0 };
  const per = [];
  let seedsOk = 0;
  for (const [seed, map] of [[1, 'uvmaze'], [2, 'neonhive'], [3, 'reactor']]) {
    const { sim } = botMatch(map, levels, seed, 120);
    const e = { easy: 0, normal: 0, hard: 0 };
    for (const P of sim.participants) e[levels[P.id]] += P.stats.elims;
    per.push(`${map}/s${seed}: E${e.easy} N${e.normal} H${e.hard}`);
    for (const k in e) tot[k] += e[k];
    if (e.hard >= e.normal && e.normal >= e.easy) seedsOk++;
    assert.ok(e.hard > e.easy, `seed ${seed}: hard ≤ easy (${per.at(-1)})`);
  }
  const msg = per.join('; ');
  t.diagnostic(`${msg}; suma ${JSON.stringify(tot)}`);
  assert.ok(tot.hard > tot.normal && tot.normal > tot.easy, `suma: ${JSON.stringify(tot)} — ${msg}`);
  // tolerancja: pojedynczy seed może zamienić sąsiednie poziomy, ale nie więcej niż jeden
  assert.ok(seedsOk >= 2, `ranking zachowany tylko w ${seedsOk}/3 seedach — ${msg}`);
});

test('determinizm: ten sam seed → identyczny przebieg (pozycje, statystyki, stany); inny seed → inny', () => {
  const levels = ['easy', 'normal', 'hard', 'hard', 'normal', 'easy'];
  const snap = (r) => r.sim.participants.map((P, i) =>
    [P.body.x, P.body.y, P.body.z, P.body.yaw, P.hp, P.state, P.stats.score, P.stats.elims, P.stats.deaths, P.stats.shots, r.brains[i].state].join('|')).join('\n');
  for (const map of ['uvmaze', 'reactor']) {
    const a = botMatch(map, levels, 9, 30);
    const b = botMatch(map, levels, 9, 30);
    assert.equal(snap(a), snap(b), `${map}: różne przebiegi przy tym samym seed`);
    const c = botMatch(map, levels, 10, 30);
    assert.notEqual(snap(a), snap(c), `${map}: seed nie wpływa na przebieg`);
  }
});

test('stan bota po eliminacji: reset do patrolu, brak ognia gdy wyeliminowany', () => {
  const S = scene(OPEN, OPEN_NAV, [
    { id: 0, team: 0, level: 'hard', x: 0, z: 10, yaw: 0 },
    { id: 1, team: 1, x: 0, z: 0, yaw: Math.PI },
  ], { teamCount: 2 });
  const P = S.P(0); const B = S.brains[0];
  S.P(1).protectTimer = 1e9; // cel przeżywa → bot zostaje w engage
  let badFire = 0;
  spy(P, (p, s, out) => { if (p.state !== 'alive' && out.fire) badFire++; });
  run(S.sim, 1.5);
  assert.equal(B.state, BOT_STATE.ENGAGE);
  P.state = 'eliminated'; P.stateTimer = 1;
  run(S.sim, 0.5);
  assert.equal(B.state, BOT_STATE.PATROL); assert.equal(B.target, null);
  assert.equal(badFire, 0);
});
