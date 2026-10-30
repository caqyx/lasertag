// Testy src/game/combat.js (SPEC §2.1–§2.2, PLAN §7.4): kapsuła trafień, sensory kamizelki (kierunki × yaw, kolejność
// gaśnięcia), HP/eliminacja/respawn/ochrona, wyeliminowani i sojusznicy w linii strzału, ściany, najbliższy cel, pickSpawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { createSim } from '../../src/game/sim.js';
import { createParticipant, placeAt, isSensorLit, SENSOR, LOSE_ORDER } from '../../src/game/participant.js';
import {
  rayVsParticipant, nearestSensor, resolveShot, applyHit, stepParticipantState, pickSpawn, respawn,
  eyeRay, sameTeam, isEnemy,
} from '../../src/game/combat.js';
import { EV } from '../../src/core/events.js';
import { CONFIG } from '../../src/config.js';

const C = CONFIG.combat;
const EYE = CONFIG.player.eyeHeight;
const DT = 1 / CONFIG.sim.hz;
const R = C.hitCapsuleRadius;

function mkWorld({ walls = [], spawns = [{ x: 0, z: 0, team: 0 }], size = 130, ceiling = 6 } = {}) {
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w: size, d: size }, ceiling,
    perimeter: { h: ceiling }, walls, ramps: [], spawns, cams: [], lights: [], decor: [], palette: {},
  });
}
function mkSim(o = {}) {
  return createSim({ world: o.world || mkWorld(o), seed: 7, friendlyFire: o.friendlyFire, teamCount: o.teamCount });
}
/** Uczestnik wstawiony bezpośrednio (bez pickSpawn) w (x,z) z yaw. */
function put(sim, id, x, z, yaw = 0, team = -1) {
  const P = createParticipant({ id, team });
  placeAt(P, x, 0, z, yaw);
  sim.participants.push(P);
  return P;
}
/** Kierunek patrzenia z P na (x,z) (PLAN §0: yaw = atan2(−dx, −dz)). */
function aimAt(P, x, z, y) {
  const b = P.body;
  const dx = x - b.x, dz = z - b.z;
  b.yaw = Math.atan2(-dx, -dz);
  b.pitch = y === undefined ? 0 : Math.atan2(y - (b.y + EYE), Math.hypot(dx, dz));
}
function events(sim, type) {
  const out = [];
  for (let i = 0; i < sim.events.count; i++) {
    const e = sim.events.at(i);
    if (type === undefined || e.type === type) out.push({ ...e });
  }
  return out;
}
function shoot(sim, A, B) {
  aimAt(A, B.body.x, B.body.z);
  resolveShot(sim, A);
}

// ------------------------------------------------------------------ kapsuła

test('kapsuła: korpus, głowa, stopy, bok — trafienia i pudła (granice wg hitCapsule*)', () => {
  const sim = mkSim();
  const T = put(sim, 1, 0, 0);
  const ray = (x, y, z, dx, dy, dz, max = 50) => rayVsParticipant(T, x, y, z, dx, dy, dz, max);
  // korpus: wejście na promieniu R
  assert.ok(Math.abs(ray(0, 1.0, 10, 0, 0, -1) - (10 - R)) < 1e-9);
  // głowa (górna półsfera): y = 1.80 trafia, 1.90 nie
  const yTopC = C.hitCapsuleTop - R;
  assert.ok(Math.abs(ray(0, 1.80, 10, 0, 0, -1) - (10 - Math.sqrt(R * R - (1.80 - yTopC) ** 2))) < 1e-9, 'głowa');
  assert.ok(ray(0, C.hitCapsuleTop - 0.01, 10, 0, 0, -1) > 0, 'czubek głowy');
  assert.equal(ray(0, C.hitCapsuleTop + 0.05, 10, 0, 0, -1), -1, 'nad głową');
  // stopy (dolna półsfera)
  assert.ok(ray(0, C.hitCapsuleBottom + 0.05, 10, 0, 0, -1) > 0, 'stopy');
  assert.equal(ray(0, C.hitCapsuleBottom - 0.05, 10, 0, 0, -1), -1, 'pod kapsułą');
  // bok
  assert.ok(ray(R - 0.01, 1.0, 10, 0, 0, -1) > 0, 'bok wewnątrz');
  assert.equal(ray(R + 0.01, 1.0, 10, 0, 0, -1), -1, 'obok');
  assert.equal(ray(-(R + 0.01), 1.0, 10, 0, 0, -1), -1, 'obok (lewo)');
  // kierunek przeciwny, zasięg
  assert.equal(ray(0, 1.0, 10, 0, 0, 1), -1, 'promień od celu');
  assert.equal(ray(0, 1.0, 10, 0, 0, -1, 9), -1, 'za krótki maxDist');
  assert.ok(ray(0, 1.0, 10, 0, 0, -1, 9.6) > 0);
  // początek wewnątrz → 0
  assert.equal(ray(0, 1.0, 0.1, 0, 0, -1), 0);
  // pionowo z góry: wejście w czubek
  assert.ok(Math.abs(ray(0, 5, 0, 0, -1, 0) - (5 - C.hitCapsuleTop)) < 1e-9, 'z góry');
  // ukośnie (pitch) w środek
  const d = Math.hypot(10, 1);
  assert.ok(ray(0, 2.0, 10, 0, -1 / d, -10 / d) > 0, 'ukośnie');
});

test('kapsuła: przesuwa się z body.y (cel na platformie)', () => {
  const sim = mkSim();
  const T = put(sim, 1, 0, 0);
  T.body.y = 1.0;
  assert.equal(rayVsParticipant(T, 0, 1.0, 10, 0, 0, -1, 50), -1, 'pod stopami celu na platformie');
  assert.ok(rayVsParticipant(T, 0, 2.8, 10, 0, 0, -1, 50) > 0);
});

// ------------------------------------------------------------------ sensory

const LOCAL_DIRS = { [SENSOR.FRONT]: [0, 1], [SENSOR.BACK]: [0, -1], [SENSOR.LEFT]: [-1, 0], [SENSOR.RIGHT]: [1, 0] };
const NAMES = ['front', 'back', 'left', 'right'];

for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.7, -2.3]) {
  test(`nearestSensor / resolveShot: strzał z 4 stron trafia właściwy sensor (yaw celu ${yaw.toFixed(2)})`, () => {
    for (const s of [SENSOR.FRONT, SENSOR.BACK, SENSOR.LEFT, SENSOR.RIGHT]) {
      const sim = mkSim();
      const T = put(sim, 1, 0, 0, yaw);
      // lokalne (prawo, przód) → świat: prawo = (cos, -sin), przód = (-sin, -cos)
      const [lr, lf] = LOCAL_DIRS[s];
      const wx = Math.cos(yaw) * lr - Math.sin(yaw) * lf;
      const wz = -Math.sin(yaw) * lr - Math.cos(yaw) * lf;
      const A = put(sim, 2, wx * 6, wz * 6);
      shoot(sim, A, T);
      const hits = events(sim, EV.HIT);
      assert.equal(hits.length, 1, `brak trafienia z kierunku ${NAMES[s]}`);
      assert.equal(hits[0].sensor, s, `z kierunku ${NAMES[s]} trafiono ${NAMES[hits[0].sensor]}`);
      assert.equal(T.sensorFlash[s], Math.fround(C.hitFlashTime));
      // punkt dokładnie na pozycji sensora (świat) → ten sensor
      const o = C.sensors[NAMES[s]];
      const px = Math.cos(yaw) * o[0] - Math.sin(yaw) * o[2];
      const pz = -Math.sin(yaw) * o[0] - Math.cos(yaw) * o[2];
      assert.equal(nearestSensor(T, px, o[1], pz), s);
    }
  });
}

test('sensory gasną w kolejności loseOrder (tył → lewe → prawe → przód) niezależnie od trafionego segmentu', () => {
  assert.deepEqual([...LOSE_ORDER], C.loseOrder.map((k) => NAMES.indexOf(k)));
  const sim = mkSim();
  const T = put(sim, 1, 0, 0, 0);
  const A = put(sim, 2, 0, -6); // przed celem (yaw 0 patrzy w −Z) → trafia front
  const expectOff = [];
  for (let k = 0; k < 3; k++) {
    shoot(sim, A, T);
    expectOff.push(LOSE_ORDER[k]);
    for (let s = 0; s < 4; s++) {
      assert.equal(isSensorLit(T, s), !expectOff.includes(s), `po ${k + 1} trafieniach sensor ${NAMES[s]}`);
    }
    assert.equal(T.sensorsLit, T.hp);
  }
  shoot(sim, A, T);
  for (let s = 0; s < 4; s++) assert.equal(isSensorLit(T, s), false);
});

// ------------------------------------------------------------------ HP / eliminacja / punkty

test('4 trafienia = eliminacja: HIT ×4 (value = HP), ELIM, stan eliminated na eliminatedTime, deaths', () => {
  const sim = mkSim();
  const T = put(sim, 1, 0, 0);
  const A = put(sim, 2, 0, -6);
  for (let k = 1; k <= 3; k++) {
    shoot(sim, A, T);
    assert.equal(T.hp, C.maxHp - k);
    assert.equal(T.state, 'alive');
  }
  shoot(sim, A, T);
  assert.equal(T.hp, 0);
  assert.equal(T.state, 'eliminated');
  assert.equal(T.stateTimer, C.eliminatedTime);
  assert.equal(T.stats.deaths, 1);
  assert.deepEqual(events(sim, EV.HIT).map((e) => e.value), [3, 2, 1, 0]);
  const el = events(sim, EV.ELIM);
  assert.equal(el.length, 1);
  assert.equal(el[0].a, A.id);
  assert.equal(el[0].b, T.id);
  assert.equal(A.stats.hits, 4);
  assert.equal(A.stats.elims, 1);
  assert.equal(A.stats.shots, 4);
  assert.equal(A.stats.score, 4 * CONFIG.scoring.hit + CONFIG.scoring.elimination);
  assert.equal(T.lastHitBy, A.id);
  // kierunek do strzelca (XZ, jednostkowy)
  assert.ok(Math.abs(T.lastHitDirX) < 1e-9 && Math.abs(T.lastHitDirZ + 1) < 1e-9);
});

test('wyeliminowany: nie jest trafiany, nie blokuje wiązki, nie dostaje punktów/obrażeń', () => {
  const sim = mkSim();
  const A = put(sim, 1, 0, -10);
  const D = put(sim, 2, 0, -5); // pomiędzy
  const B = put(sim, 3, 0, 0);
  for (let k = 0; k < 4; k++) shoot(sim, A, D);
  assert.equal(D.state, 'eliminated');
  sim.events.clear();
  const scoreA = A.stats.score;
  shoot(sim, A, B);
  const shots = events(sim, EV.SHOT);
  assert.equal(shots[0].b, B.id, 'wiązka zatrzymała się na wyeliminowanym');
  assert.equal(B.hp, C.maxHp - 1);
  assert.equal(D.hp, 0);
  assert.equal(D.stats.deaths, 1);
  assert.equal(A.stats.score, scoreA + CONFIG.scoring.hit);
  // bezpośrednie applyHit na wyeliminowanym → false, bez zmian
  assert.equal(applyHit(sim, A, D, SENSOR.FRONT, 0, 1, -5), false);
  assert.equal(D.stats.deaths, 1);
  assert.equal(A.stats.score, scoreA + CONFIG.scoring.hit);
});

test('respawn po eliminatedTime: pełne HP, 4 sensory, ochrona protectionTime, broń wyzerowana, RESPAWN', () => {
  const sim = mkSim({ spawns: [{ x: 20, z: 20, yaw: 1, team: 0 }] });
  const T = put(sim, 1, 0, 0);
  const A = put(sim, 2, 0, -6);
  T.weapon.heat = 0.8; T.weapon.overheated = true;
  for (let k = 0; k < 4; k++) shoot(sim, A, T);
  sim.events.clear();
  let steps = 0;
  while (T.state !== 'alive' && steps < 1000) { stepParticipantState(sim, T, DT); steps++; }
  assert.ok(Math.abs(steps * DT - C.eliminatedTime) <= DT + 1e-9, `respawn po ${steps * DT} s`);
  assert.equal(T.hp, C.maxHp);
  assert.equal(T.sensorsLit, C.maxHp);
  assert.equal(T.protectTimer, C.protectionTime);
  assert.equal(T.weapon.heat, 0);
  assert.equal(T.weapon.overheated, false);
  assert.equal(T.body.x, 20);
  assert.equal(T.body.z, 20);
  assert.equal(T.body.yaw, 1);
  const rs = events(sim, EV.RESPAWN);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].a, T.id);
  assert.deepEqual([rs[0].x, rs[0].z], [20, 20]);
});

test('ochrona blokuje obrażenia (SHOT value 2, brak HIT/punktów), wygasa po protectionTime (PROTECT_END value 0)', () => {
  const sim = mkSim();
  const T = put(sim, 1, 0, 0);
  const A = put(sim, 2, 0, -6);
  T.protectTimer = C.protectionTime;
  shoot(sim, A, T);
  const sh = events(sim, EV.SHOT);
  assert.equal(sh[0].b, T.id, 'wiązka zatrzymuje się na chronionym');
  assert.equal(sh[0].value, 2);
  assert.equal(events(sim, EV.HIT).length, 0);
  assert.equal(T.hp, C.maxHp);
  assert.equal(A.stats.score, 0);
  assert.equal(applyHit(sim, A, T, SENSOR.FRONT, 0, 1, 0), false);
  sim.events.clear();
  let steps = 0;
  while (T.protectTimer > 0 && steps < 1000) { stepParticipantState(sim, T, DT); steps++; }
  assert.ok(Math.abs(steps * DT - C.protectionTime) <= DT + 1e-9, `ochrona trwała ${steps * DT} s`);
  const pe = events(sim, EV.PROTECT_END);
  assert.equal(pe.length, 1);
  assert.equal(pe[0].value, 0);
  shoot(sim, A, T);
  assert.equal(T.hp, C.maxHp - 1);
});

test('strzał chronionego kończy ochronę natychmiast (PROTECT_END value 1), strzał nadal działa', () => {
  const sim = mkSim();
  const P = put(sim, 1, 0, 0);
  const E = put(sim, 2, 0, -6);
  P.protectTimer = 1.5;
  shoot(sim, P, E);
  assert.equal(P.protectTimer, 0);
  const pe = events(sim, EV.PROTECT_END);
  assert.equal(pe.length, 1);
  assert.equal(pe[0].a, P.id);
  assert.equal(pe[0].value, 1);
  assert.equal(E.hp, C.maxHp - 1);
  // po przerwaniu jest trafialny
  shoot(sim, E, P);
  assert.equal(P.hp, C.maxHp - 1);
});

test('respawn w trakcie: chroniony po respawnie nie traci HP, ale po własnym strzale już tak', () => {
  const sim = mkSim({ spawns: [{ x: 0, z: 0, team: 0 }] });
  const T = put(sim, 1, 0, 0);
  const A = put(sim, 2, 0, -6);
  respawn(sim, T);
  shoot(sim, A, T);
  assert.equal(T.hp, C.maxHp);
  shoot(sim, T, A);
  shoot(sim, A, T);
  assert.equal(T.hp, C.maxHp - 1);
});

// ------------------------------------------------------------------ drużyny

test('sameTeam / isEnemy: FFA (team −1) zawsze wrogowie, ta sama drużyna ≥ 0 = sojusznicy', () => {
  const a = createParticipant({ id: 1 }), b = createParticipant({ id: 2 });
  assert.equal(isEnemy(a, b), true);
  assert.equal(sameTeam(a, a), false);
  const c = createParticipant({ id: 3, team: 1 }), d = createParticipant({ id: 4, team: 1 }), e = createParticipant({ id: 5, team: 0 });
  assert.equal(sameTeam(c, d), true);
  assert.equal(isEnemy(c, d), false);
  assert.equal(isEnemy(c, e), true);
  assert.equal(isEnemy(c, c), false);
});

test('friendlyFire = false: wiązka przelatuje przez sojusznika i trafia wroga za nim', () => {
  const sim = mkSim({ friendlyFire: false });
  const A = put(sim, 1, 0, -10, 0, 0);
  const F = put(sim, 2, 0, -5, 0, 0);
  const B = put(sim, 3, 0, 0, 0, 1);
  shoot(sim, A, B);
  assert.equal(F.hp, C.maxHp);
  assert.equal(B.hp, C.maxHp - 1);
  // sam sojusznik (bez wroga za nim): pudło, bez punktów
  sim.events.clear();
  B.state = 'eliminated';
  shoot(sim, A, F);
  assert.equal(F.hp, C.maxHp);
  assert.equal(events(sim, EV.SHOT)[0].b, -1);
});

test('friendlyFire = true: sojusznik w linii jest trafiany (i zatrzymuje wiązkę)', () => {
  const sim = mkSim({ friendlyFire: true });
  const A = put(sim, 1, 0, -10, 0, 0);
  const F = put(sim, 2, 0, -5, 0, 0);
  const B = put(sim, 3, 0, 0, 0, 1);
  shoot(sim, A, B);
  assert.equal(F.hp, C.maxHp - 1);
  assert.equal(B.hp, C.maxHp);
});

test('createSim: friendlyFire domyślnie z CONFIG (false)', () => {
  assert.equal(mkSim().friendlyFire, C.friendlyFire);
});

// ------------------------------------------------------------------ geometria strzału

test('ściana zatrzymuje wiązkę: brak trafienia, koniec wiązki na ścianie', () => {
  const sim = mkSim({ walls: [{ x: 0, z: -3, w: 4, d: 0.4, h: 3 }] });
  const A = put(sim, 1, 0, -10);
  const B = put(sim, 2, 0, 0);
  shoot(sim, A, B);
  const sh = events(sim, EV.SHOT)[0];
  assert.equal(sh.b, -1);
  assert.equal(sh.value, 0);
  assert.equal(B.hp, C.maxHp);
  assert.ok(Math.abs(sh.z2 - (-3.2)) < 1e-6, `koniec wiązki z = ${sh.z2}`);
  assert.equal(A.stats.shots, 1);
});

test('wiązka zatrzymuje się na najbliższym celu (niezależnie od kolejności w participants)', () => {
  for (const order of [0, 1]) {
    const sim = mkSim();
    const A = put(sim, 1, 0, -10);
    let near, far;
    if (order === 0) { near = put(sim, 2, 0, -4); far = put(sim, 3, 0, 0); }
    else { far = put(sim, 3, 0, 0); near = put(sim, 2, 0, -4); }
    shoot(sim, A, far);
    assert.equal(near.hp, C.maxHp - 1, `kolejność ${order}`);
    assert.equal(far.hp, C.maxHp);
    const sh = events(sim, EV.SHOT)[0];
    assert.equal(sh.b, near.id);
    // oko (y = eyeHeight) trafia górną półsferę: promień przekroju sqrt(R² − (eye − yTopC)²)
    const rr = Math.sqrt(R * R - (EYE - (C.hitCapsuleTop - R)) ** 2);
    assert.ok(Math.abs(sh.z2 - (-4 - rr)) < 1e-9, `koniec wiązki na celu (${sh.z2})`);
  }
});

test('zasięg: cel dalej niż weapon.range nie jest trafiany', () => {
  const sim = mkSim();
  const A = put(sim, 1, 0, -30);
  const B = put(sim, 2, 0, CONFIG.weapon.range - 30 + 1); // 51 m
  shoot(sim, A, B);
  assert.equal(B.hp, C.maxHp);
  const sh = events(sim, EV.SHOT)[0];
  assert.ok(Math.abs(Math.hypot(sh.x2 - 0, sh.z2 + 30) - CONFIG.weapon.range) < 1e-6);
  const B2 = put(sim, 3, 0.0, CONFIG.weapon.range - 30 - 2); // 48 m
  B.state = 'eliminated';
  shoot(sim, A, B2);
  assert.equal(B2.hp, C.maxHp - 1);
});

test('strzelec nie trafia sam siebie; eyeRay zgodny z konwencją yaw (0 → −Z)', () => {
  const sim = mkSim();
  const A = put(sim, 1, 0, 0);
  const o = {};
  eyeRay(A, o);
  assert.ok(Math.abs(o.dz + 1) < 1e-12 && Math.abs(o.dx) < 1e-12);
  assert.equal(o.oy, EYE);
  resolveShot(sim, A);
  assert.equal(events(sim, EV.SHOT)[0].b, -1);
  assert.equal(A.hp, C.maxHp);
});

// ------------------------------------------------------------------ pickSpawn

test('pickSpawn omija spawn widziany przez wroga (nawet gdy dalszy) na rzecz zasłoniętego', () => {
  const sim = mkSim({
    walls: [{ x: -3, z: 0, w: 0.4, d: 6, h: 4 }],
    spawns: [{ x: 15, z: 0, team: 0 }, { x: -6, z: 0, team: 0 }],
  });
  put(sim, 1, 0, 0);
  const P = createParticipant({ id: 9 });
  const sp = pickSpawn(sim, P);
  assert.equal(sp.x, -6, 'wybrano widziany spawn');
});

test('pickSpawn: wszystkie widziane → najdalszy od widzących; nikt nie widzi → najdalszy od wszystkich', () => {
  const sim = mkSim({ spawns: [{ x: 5, z: 0, team: 0 }, { x: 25, z: 0, team: 0 }, { x: -12, z: 0, team: 0 }] });
  put(sim, 1, 0, 0);
  const P = createParticipant({ id: 9 });
  assert.equal(pickSpawn(sim, P).x, 25);
  // wyeliminowani nie liczą się
  const sim2 = mkSim({ spawns: [{ x: 5, z: 0, team: 0 }, { x: 25, z: 0, team: 0 }] });
  put(sim2, 1, 0, 0);
  const D = put(sim2, 2, 25, 1);
  D.state = 'eliminated';
  assert.equal(pickSpawn(sim2, P).x, 25);
  // sojusznik nie „widzi" jako wróg, ale liczy się do „najdalszy od wszystkich"
  const sim3 = mkSim({ teamCount: 0, spawns: [{ x: 5, z: 0, team: 0 }, { x: 25, z: 0, team: 0 }] });
  put(sim3, 1, 26, 0, 0, 1); // sojusznik P przy spawnie 25
  const P1 = createParticipant({ id: 9, team: 1 });
  assert.equal(pickSpawn(sim3, P1).x, 5);
});

test('pickSpawn: spawny drużynowe (teamCount 2: sp.team % 2 === P.team), teamCount 0 → wszystkie', () => {
  const spawns = [
    { x: -20, z: -20, team: 0 }, { x: 20, z: 20, team: 1 }, { x: 20, z: -20, team: 2 }, { x: -20, z: 20, team: 3 },
  ];
  const world = mkWorld({ spawns });
  for (let k = 0; k < 20; k++) {
    const sim = createSim({ world, seed: k + 1, teamCount: 2 });
    const P0 = createParticipant({ id: 1, team: 0 });
    const P1 = createParticipant({ id: 2, team: 1 });
    assert.equal(pickSpawn(sim, P0).team % 2, 0);
    assert.equal(pickSpawn(sim, P1).team % 2, 1);
  }
  const sim4 = createSim({ world, seed: 3, teamCount: 4 });
  assert.equal(pickSpawn(sim4, createParticipant({ id: 1, team: 3 })).team, 3);
  // brak drużyny (FFA) przy teamCount 0 → dowolny; wszystkie 4 spawny osiągalne (remis → rng)
  const seen = new Set();
  for (let k = 0; k < 50; k++) {
    const sim = createSim({ world, seed: k + 1 });
    seen.add(pickSpawn(sim, createParticipant({ id: 1, team: 0 })).team);
  }
  assert.equal(seen.size, 4, `remis rozstrzygany losowo, osiągnięto ${[...seen]}`);
});

test('pickSpawn: mapa bez spawnów → null; respawn zostaje w miejscu', () => {
  const world = mkWorld();
  world.spawns.length = 0;
  const sim = createSim({ world, seed: 1 });
  const P = put(sim, 1, 3, 4);
  assert.equal(pickSpawn(sim, P), null);
  respawn(sim, P);
  assert.equal(P.body.x, 3);
  assert.equal(P.hp, C.maxHp);
});
