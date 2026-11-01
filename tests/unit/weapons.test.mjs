// Testy broni D-037: pistolet dwustrzałowy (seria, semi-auto, zasięg, ciepło, obrażenia ułamkowe, punktacja),
// wyrzutnia odbijająca (lot, odbicie lustrzane, trafienie zza rogu, znikanie przy 2. kontakcie, pula, koniec życia),
// losowanie broni botów z rng sim, determinizm, boty używające każdej broni.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { segmentClear } from '../../src/world/physics.js';
import { buildNav } from '../../src/world/nav.js';
import { createSim, addParticipant, stepSim } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { createWeapon, stepWeapon, randomWeaponType, WEAPON_TYPES, weaponType } from '../../src/game/weapon.js';
import { resolveShot, applyHit } from '../../src/game/combat.js';
import { launchProjectile, stepProjectiles } from '../../src/game/projectiles.js';
import { createBotBrain } from '../../src/game/bots/ai.js';
import { createRng } from '../../src/core/rng.js';
import { EV } from '../../src/core/events.js';
import { CONFIG } from '../../src/config.js';
import uvmaze from '../../src/world/maps/uvmaze.js';

const DT = 1 / CONFIG.sim.hz;
const EYE = CONFIG.player.eyeHeight;
const PI = CONFIG.weapons.pistol;
const BO = CONFIG.weapons.bouncer;
const SP = CONFIG.combat.segmentPoints;

function mkWorld(walls = [], size = 60) {
  return buildWorld({
    id: 'w', name: 'w', seed: 1, size: { w: size, d: size }, ceiling: 6, perimeter: { h: 6 },
    walls, ramps: [], spawns: [{ x: -10, z: 12, team: 0 }], cams: [], lights: [], decor: [], palette: {},
  });
}
function put(sim, id, x, z, weapon = 'phaser', team = -1) {
  const P = createParticipant({ id, team, weapon });
  placeAt(P, x, 0, z, 0);
  sim.participants.push(P);
  return P;
}
function aimAt(P, x, y, z) {
  const b = P.body;
  const dx = x - b.x, dz = z - b.z;
  b.yaw = Math.atan2(-dx, -dz);
  b.pitch = Math.atan2(y - (b.y + EYE), Math.hypot(dx, dz));
}
function events(sim, type) {
  const out = [];
  for (let i = 0; i < sim.events.count; i++) {
    const e = sim.events.at(i);
    if (e.type === type) out.push({ ...e });
  }
  return out;
}

// ------------------------------------------------------------------ typy

test('typy broni: fazer domyślny, nieznany typ → domyślny, CONFIG.weapon to fazer', () => {
  assert.deepEqual([...WEAPON_TYPES], ['phaser', 'pistol', 'bouncer']);
  assert.equal(createWeapon().type, 'phaser');
  assert.equal(createWeapon('__proto__').type, 'phaser');
  assert.equal(weaponType('pistol'), 'pistol');
  assert.equal(CONFIG.weapon, CONFIG.weapons.phaser);
  assert.equal(CONFIG.weapons.phaser.damage, SP * CONFIG.combat.damage, 'fazer = 1 segment');
});

// ------------------------------------------------------------------ pistolet

test('pistolet: jedno naciśnięcie = seria 2 strzałów co burstGap; trzymanie spustu nie powtarza', () => {
  const W = createWeapon('pistol');
  const shots = [];
  for (let i = 1; i <= 120; i++) if (stepWeapon(W, true, DT)) shots.push(i * DT);
  assert.equal(shots.length, PI.burst, `strzały przy trzymaniu: ${shots}`);
  assert.ok(Math.abs(shots[1] - shots[0] - PI.burstGap) <= DT + 1e-9, `odstęp ${shots[1] - shots[0]}`);
});

test('pistolet: kolejna seria po zwolnieniu i ponownym naciśnięciu, nie wcześniej niż fireInterval', () => {
  const W = createWeapon('pistol');
  const shots = [];
  // klikanie co 2 kroki (naciśnij / puść) przez 2 s
  for (let i = 1; i <= 120; i++) if (stepWeapon(W, (i & 1) === 1, DT)) shots.push(i * DT);
  const starts = shots.filter((t, k) => k % PI.burst === 0);
  for (let k = 1; k < starts.length; k++) {
    assert.ok(starts[k] - starts[k - 1] >= PI.fireInterval - DT - 1e-9, `serie za często: ${starts[k] - starts[k - 1]}`);
  }
  const expected = Math.floor(2 / PI.fireInterval) * PI.burst;
  assert.ok(Math.abs(shots.length - expected) <= PI.burst, `strzałów ${shots.length}, oczekiwano ~${expected}`);
  assert.ok(PI.fireInterval < CONFIG.weapons.phaser.fireInterval * PI.burst, 'pistolet szybki');
});

test('pistolet: bardzo mało ciepła (seria = 2 × heatPerShot), dużo mniej niż fazer', () => {
  const W = createWeapon('pistol');
  for (let i = 0; i < 10; i++) stepWeapon(W, true, DT);
  assert.ok(Math.abs(W.heat - PI.burst * PI.heatPerShot) < 1e-9, `ciepło ${W.heat}`);
  assert.ok(PI.heatPerShot * PI.burst < CONFIG.weapons.phaser.heatPerShot);
});

test('pistolet: zasięg mały (cel w range − 1 trafiony, w range + 1 nie)', () => {
  const sim = createSim({ world: mkWorld(), seed: 1 });
  const A = put(sim, 0, 0, 20, 'pistol');
  const near = put(sim, 1, 0, 20 - (PI.range - 1));
  aimAt(A, 0, 1.3, near.body.z);
  resolveShot(sim, A);
  assert.equal(events(sim, EV.SHOT)[0].b, 1);
  sim.events.clear();
  near.body.z = 20 - (PI.range + 1);
  resolveShot(sim, A);
  const sh = events(sim, EV.SHOT)[0];
  assert.equal(sh.b, -1);
  assert.ok(Math.abs(Math.hypot(sh.x2 - 0, sh.y2 - (EYE), sh.z2 - 20) - PI.range) < 0.05, 'wiązka kończy się na zasięgu');
});

test('obrażenia ułamkowe: trafienie pistoletem = ½ segmentu, seria 2 trafień = 1 segment i 10 pkt (jak fazer)', () => {
  const sim = createSim({ world: mkWorld(), seed: 1 });
  const A = put(sim, 0, 0, 5, 'pistol');
  const T = put(sim, 1, 0, 0);
  applyHit(sim, A, T, 0, 0, 1.3, 0);
  assert.equal(T.hp, CONFIG.combat.maxHp, 'pierwsze trafienie nie gasi segmentu');
  assert.equal(T.dmg, PI.damage);
  assert.equal(T.sensorsLit, CONFIG.combat.maxHp);
  assert.ok(T.stunTimer > 0 && T.stunTimer < CONFIG.combat.hitStun, 'krótszy stun');
  applyHit(sim, A, T, 0, 0, 1.3, 0);
  assert.equal(T.hp, CONFIG.combat.maxHp - 1);
  assert.equal(T.dmg, 0);
  assert.equal(A.stats.score, CONFIG.scoring.hit, 'punkty proporcjonalne do obrażeń');
  assert.equal(A.stats.hits, 2);
  // 8 trafień pistoletem = eliminacja (4 segmenty)
  for (let k = 0; k < 6; k++) applyHit(sim, A, T, 0, 0, 1.3, 0);
  assert.equal(T.state, 'eliminated');
  assert.equal(A.stats.elims, 1);
});

test('pistolet w sim: seria 2 wiązek w jednym kliknięciu, oba trafienia zabierają razem 1 segment', () => {
  const sim = createSim({ world: mkWorld(), seed: 1 });
  const A = put(sim, 0, 0, 6, 'pistol');
  const T = put(sim, 1, 0, 0);
  let press = 3;
  A.inputSource = { sample(P, s, out) { out.yaw = 0; out.pitch = Math.atan2(1.3 - EYE, 6); out.fire = press-- > 0; } };
  const shots = [];
  for (let i = 0; i < 30; i++) {
    stepSim(sim, DT);
    shots.push(...events(sim, EV.SHOT));
    sim.events.clear();
  }
  assert.equal(shots.length, 2);
  assert.ok(shots.every((s) => s.b === 1));
  assert.equal(T.hp, CONFIG.combat.maxHp - 1);
});

// ------------------------------------------------------------------ wyrzutnia

/** Świat: ściana tylna z = -10 (lico z = -9.8), przegroda x = 0, z ∈ [-6, 6]. */
function cornerWorld() {
  return mkWorld([
    { x: 0, z: -10, w: 30, d: 0.4, h: 4 },
    { x: 0, z: 0, w: 0.4, d: 12, h: 3 },
  ]);
}

test('wyrzutnia: pocisk leci z prędkością speed (nie hitscan), widoczny w puli', () => {
  const sim = createSim({ world: mkWorld(), seed: 1 });
  const A = put(sim, 0, 0, 0, 'bouncer');
  aimAt(A, 0, EYE, -20);
  launchProjectile(sim, A);
  const pr = sim.proj;
  assert.equal(pr.count, 1);
  const i = events(sim, EV.LAUNCH)[0].value;
  const z0 = pr.z[i];
  for (let k = 0; k < 30; k++) stepProjectiles(sim, DT);
  assert.ok(Math.abs((z0 - pr.z[i]) - BO.speed * 30 * DT) < 0.05, `droga ${z0 - pr.z[i]}`);
  assert.equal(A.stats.shots, 1);
});

test('wyrzutnia: odbicie lustrzane od ściany (raz), trafienie celu zza rogu bez linii wzroku', () => {
  const world = cornerWorld();
  const sim = createSim({ world, seed: 1 });
  const A = put(sim, 0, -4, 0, 'bouncer');
  const T = put(sim, 1, 4, 0);
  assert.equal(segmentClear(world, -4, EYE, 0, 4, EYE, 0), false, 'brak linii wzroku');
  aimAt(A, 0, 1.2, -9.8);
  launchProjectile(sim, A);
  const bounces = [];
  const ends = [];
  for (let k = 0; k < 180 && sim.proj.count > 0; k++) {
    stepProjectiles(sim, DT);
    bounces.push(...events(sim, EV.BOUNCE));
    ends.push(...events(sim, EV.PROJ_END));
    sim.events.clear();
  }
  assert.equal(bounces.length, 1);
  const b = bounces[0];
  assert.ok(Math.abs(b.z + 9.8) < 0.05, `odbicie na licu ściany: z=${b.z}`);
  assert.ok(Math.abs(b.nz - 1) < 1e-9, 'normalna ściany +Z');
  assert.ok(b.z2 > 0 && b.x2 > 0, 'nowy kierunek: od ściany, dalej w +X (lustrzanie)');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].value, 1, 'trafienie');
  assert.equal(ends[0].b, 1);
  assert.equal(T.hp, CONFIG.combat.maxHp - 1);
  assert.equal(A.stats.hits, 1);
});

test('wyrzutnia: przy drugim kontakcie ze ścianą pocisk znika (PROJ_END value 0, slot wolny)', () => {
  // korytarz: dwie równoległe ściany x = ±3; strzał skośny → odbicie od jednej, koniec na drugiej
  const sim = createSim({ world: mkWorld([{ x: -3.2, z: 0, w: 0.4, d: 40, h: 4 }, { x: 3.2, z: 0, w: 0.4, d: 40, h: 4 }]), seed: 1 });
  const A = put(sim, 0, 0, 10, 'bouncer');
  aimAt(A, 3, EYE, 6);
  launchProjectile(sim, A);
  const seen = [];
  for (let k = 0; k < 240 && sim.proj.count > 0; k++) {
    stepProjectiles(sim, DT);
    for (let j = 0; j < sim.events.count; j++) seen.push({ ...sim.events.at(j) });
    sim.events.clear();
  }
  const types = seen.map((e) => e.type).filter((t) => t !== EV.LAUNCH);
  assert.deepEqual(types, [EV.BOUNCE, EV.PROJ_END]);
  const end = seen.find((e) => e.type === EV.PROJ_END);
  assert.equal(end.value, 0);
  assert.ok(Math.abs(Math.abs(end.x) - 3) < 0.05, `koniec na przeciwległej ścianie x=${end.x}`);
  assert.ok(Math.abs(end.nx) > 0.99, 'normalna w zdarzeniu (odłamki)');
  assert.equal(sim.proj.count, 0);
  assert.ok(sim.proj.active.every((a) => a === 0));
});

test('wyrzutnia: podłoga liczy się jako kontakt (odbicie od podłogi), koniec życia → PROJ_END value 3', () => {
  const sim = createSim({ world: mkWorld([], 200), seed: 1 });
  const A = put(sim, 0, 0, 0, 'bouncer');
  aimAt(A, 0, 0, -6);        // w podłogę
  launchProjectile(sim, A);
  const seen = [];
  for (let k = 0; k < Math.ceil(BO.life / DT) + 5 && sim.proj.count > 0; k++) {
    stepProjectiles(sim, DT);
    for (let j = 0; j < sim.events.count; j++) seen.push({ ...sim.events.at(j) });
    sim.events.clear();
  }
  const b = seen.find((e) => e.type === EV.BOUNCE);
  assert.ok(b && Math.abs(b.ny - 1) < 1e-9 && b.y2 > 0, 'odbicie od podłogi w górę');
  const end = seen.find((e) => e.type === EV.PROJ_END);
  assert.ok(end.value === 0 || end.value === 3, `koniec: ${end.value}`);
});

test('wyrzutnia: pula ograniczona (maxActive), pełna → nadpisuje najstarszy, licznik spójny', () => {
  const sim = createSim({ world: mkWorld([], 200), seed: 1 });
  const A = put(sim, 0, 0, 0, 'bouncer');
  aimAt(A, 0, EYE, -50);
  for (let k = 0; k < BO.maxActive + 5; k++) launchProjectile(sim, A);
  assert.equal(sim.proj.count, BO.maxActive);
  assert.equal(sim.proj.active.reduce((a, b) => a + b, 0), BO.maxActive);
});

test('wyrzutnia: sojusznik przepuszczany, chroniony cel zatrzymuje pocisk bez obrażeń (value 2)', () => {
  const sim = createSim({ world: mkWorld(), seed: 1, teamCount: 2 });
  const A = put(sim, 0, 0, 10, 'bouncer', 0);
  const F = put(sim, 1, 0, 5, 'phaser', 0);
  const T = put(sim, 2, 0, 0, 'phaser', 1);
  T.protectTimer = 5;
  aimAt(A, 0, 1.3, 0);
  launchProjectile(sim, A);
  let end = null;
  for (let k = 0; k < 120 && sim.proj.count > 0; k++) {
    stepProjectiles(sim, DT);
    end = events(sim, EV.PROJ_END)[0] || end;
    sim.events.clear();
  }
  assert.equal(end.b, 2);
  assert.equal(end.value, 2);
  assert.equal(F.hp, CONFIG.combat.maxHp);
  assert.equal(T.hp, CONFIG.combat.maxHp);
});

// ------------------------------------------------------------------ boty, rng, determinizm

test('randomWeaponType: deterministyczny z rng, pokrywa wszystkie typy', () => {
  const a = createRng(5), b = createRng(5);
  const xs = [], ys = [];
  for (let i = 0; i < 60; i++) { xs.push(randomWeaponType(a)); ys.push(randomWeaponType(b)); }
  assert.deepEqual(xs, ys);
  for (const t of WEAPON_TYPES) assert.ok(xs.includes(t), t);
});

function botMatch(seed, seconds) {
  const world = buildWorld(uvmaze);
  const nav = buildNav(world);
  const sim = createSim({ world, seed });
  for (let id = 0; id < 8; id++) {
    const weapon = WEAPON_TYPES[id % 3];
    addParticipant(sim, createParticipant({ id, weapon, inputSource: createBotBrain({ level: 'hard', nav, adapt: null }) }));
  }
  const stats = { hits: { phaser: 0, pistol: 0, bouncer: 0 }, bounces: 0, launches: 0 };
  for (let i = 0; i < seconds * 60; i++) {
    stepSim(sim, DT);
    for (let k = 0; k < sim.events.count; k++) {
      const e = sim.events.at(k);
      if (e.type === EV.HIT) stats.hits[sim.participants[e.a].weapon.type]++;
      if (e.type === EV.BOUNCE) stats.bounces++;
      if (e.type === EV.LAUNCH) stats.launches++;
    }
    sim.events.clear();
  }
  return { sim, stats };
}

test('boty używają każdej broni (trafienia z fazera, pistoletu i wyrzutni) i deterministycznie', () => {
  const a = botMatch(4, 90);
  for (const t of WEAPON_TYPES) assert.ok(a.stats.hits[t] > 0, `brak trafień z ${t}: ${JSON.stringify(a.stats)}`);
  assert.ok(a.stats.launches > 0);
  const b = botMatch(4, 90);
  const snap = (s) => s.participants.map((P) => [P.body.x, P.body.z, P.hp, P.dmg, P.stats.score, P.weapon.heat].join('|')).join('\n')
    + [...s.proj.x].join(',');
  assert.equal(snap(a.sim), snap(b.sim));
});
