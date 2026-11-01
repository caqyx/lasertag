// Testy drzwi przesuwnych (MapData.doors → world.doors, src/game/doors.js): cykl, ruch, czujnik bezpieczeństwa,
// kolizja i raycast w każdej pozie (kubełki SpatialGrid po całym torze), nawigacja (węzły strefy drzwi), determinizm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { moveBody, raycastWorld, createHit } from '../../src/world/physics.js';
import { buildNav, nearestNode, findPath } from '../../src/world/nav.js';
import { createSim, addParticipant, stepSim } from '../../src/game/sim.js';
import { createParticipant, placeAt } from '../../src/game/participant.js';
import { doorTarget, resetDoors, stepDoors } from '../../src/game/doors.js';
import { CONFIG } from '../../src/config.js';

const P = CONFIG.player;
const DT = 1 / CONFIG.sim.hz;
const CYCLE = [2, 1, 2];   // otwarte, ruch, zamknięte → okres 6 s

/** Hala 20×20 przecięta ścianą z = 0 z przejściem 2 m (x ∈ [-1, 1]); drzwi chowają się w ścianę w stronę +x. */
function hall(phase = 0) {
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w: 20, d: 20 }, ceiling: 5, perimeter: { h: 5 },
    walls: [
      { x: -5.5, z: 0, w: 9, d: 0.4, h: 2.4, kind: 'wall' },
      { x: 5.5, z: 0, w: 9, d: 0.4, h: 2.4, kind: 'wall' },
    ],
    doors: [{ x: 0, z: 0, w: 2, slide: [2, 0], cycle: CYCLE, phase }],
    ramps: [], spawns: [], cams: [],
  });
}
const door = (w) => w.solids[w.doors[0].solid];

test('doorTarget: cykl otwarte → zamykanie → zamknięte → otwieranie, faza przesuwa cykl', () => {
  const w = hall();
  const D = w.doors[0];
  assert.equal(D.period, 6);
  assert.equal(doorTarget(D, 0), 1);
  assert.equal(doorTarget(D, 1.99), 1);
  assert.ok(Math.abs(doorTarget(D, 2.5) - 0.5) < 1e-9);
  assert.equal(doorTarget(D, 3.5), 0);
  assert.ok(Math.abs(doorTarget(D, 5.5) - 0.5) < 1e-9);
  assert.equal(doorTarget(D, 6), 1);
  assert.equal(doorTarget(hall(3).doors[0], 0.5), 0);
});

test('mapgen: bryła drzwi startuje otwarta (w kieszeni), kubełki obejmują cały tor — raycast trafia drzwi zamknięte', () => {
  const w = hall();
  const s = door(w);
  assert.equal(s.kind, 'door'); assert.equal(s.mover, 0);
  assert.equal(s.cx, 2); assert.equal(s.cz, 0);
  const hit = createHit();
  resetDoors(w, 3.5);   // zamknięte
  assert.equal(s.cx, 0);
  assert.equal(raycastWorld(w, 0, 1.5, -5, 0, 0, 1, 10, hit), true);
  assert.equal(hit.index, w.doors[0].solid);
  resetDoors(w, 0);     // otwarte
  assert.equal(raycastWorld(w, 0, 1.5, -5, 0, 0, 1, 10, hit), false);
});

test('stepDoors: ruch z prędkością 1/tMove, poza bryły = poza zamknięta + slide × otwarcie', () => {
  const w = hall();
  const sim = createSim({ world: w, seed: 1 });
  for (let i = 0; i < Math.round(2.5 / DT); i++) stepSim(sim, DT);
  const o = w.doorOpen[0];
  assert.ok(Math.abs(o - 0.5) < 0.02, `otwarcie w połowie zamykania: ${o}`);
  assert.ok(Math.abs(door(w).cx - 2 * o) < 1e-9);
  for (let i = 0; i < Math.round(1 / DT); i++) stepSim(sim, DT);
  assert.equal(w.doorOpen[0], 0);
});

test('czujnik: drzwi nie zamykają się na żywym ciele w przejściu; po wyjściu zamykają się; ciało nigdy w skrzydle', () => {
  const w = hall();
  const sim = createSim({ world: w, seed: 1 });
  const p = addParticipant(sim, createParticipant({ id: 0, inputSource: { sample(P0, s, out) { out.moveX = 0; out.moveZ = 0; } } }));
  placeAt(p, 0, 0, 0, 0);
  let maxPen = 0;
  const pen = () => {
    const s = door(w), b = p.body;
    const qx = Math.max(s.cx - s.hx, Math.min(s.cx + s.hx, b.x)), qz = Math.max(s.cz - s.hz, Math.min(s.cz + s.hz, b.z));
    return b.radius - Math.hypot(b.x - qx, b.z - qz);
  };
  for (let i = 0; i < Math.round(4 / DT); i++) { stepSim(sim, DT); maxPen = Math.max(maxPen, pen()); sim.events.clear(); }
  assert.ok(w.doorOpen[0] > 0.3, `drzwi zamknęły się na ciele: ${w.doorOpen[0]}`);
  assert.ok(maxPen < 1e-9, `ciało w skrzydle: ${maxPen}`);
  placeAt(p, 0, 0, -4, 0);   // wyjście z przejścia (t = 4 s, cel 0): domknięcie z prędkością 1/tMove przed otwieraniem od t = 5 s
  for (let i = 0; i < Math.round(0.8 / DT); i++) { stepSim(sim, DT); sim.events.clear(); }
  assert.equal(w.doorOpen[0], 0);
});

test('wyeliminowany w przejściu nie blokuje drzwi', () => {
  const w = hall();
  const sim = createSim({ world: w, seed: 1 });
  const p = addParticipant(sim, createParticipant({ id: 0, inputSource: { sample(P0, s, out) { out.moveX = 0; out.moveZ = 0; } } }));
  placeAt(p, 0, 0, 0, 0);
  p.state = 'eliminated'; p.stateTimer = 100;
  for (let i = 0; i < Math.round(3.2 / DT); i++) { stepSim(sim, DT); sim.events.clear(); }
  assert.equal(w.doorOpen[0], 0);
});

test('kolizja: przez drzwi zamknięte nie da się przejść, przez otwarte — tak', () => {
  for (const [time, pass] of [[3.5, false], [0, true]]) {
    const w = hall();
    resetDoors(w, time);
    const b = { x: 0, y: 0, z: -3, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, radius: P.radius, height: P.height };
    for (let i = 0; i < 180; i++) { b.vx = 0; b.vz = P.walkSpeed; moveBody(w, b, DT); }
    assert.equal(b.z > 0.5, pass, `t=${time}: z=${b.z}`);
  }
});

test('nav: węzły strefy drzwi oznaczone; findPath omija drzwi zamknięte (objazd lub brak), przechodzi przy otwartych', () => {
  const w = hall();
  const nav = buildNav(w);
  let marked = 0;
  for (let i = 0; i < nav.count; i++) if (nav.nodeDoor[i] === 0) marked++;
  assert.ok(marked >= 4, `za mało węzłów strefy drzwi: ${marked}`);
  const a = nearestNode(nav, 0, 0, -3), c = nearestNode(nav, 0, 0, 3);
  const path = new Int32Array(nav.count);
  resetDoors(w, 0);
  assert.ok(findPath(nav, a, c, path) > 0, 'otwarte: ścieżka przez przejście');
  resetDoors(w, 3.5);
  assert.equal(findPath(nav, a, c, path), 0, 'zamknięte: jedyne przejście — brak ścieżki');
  resetDoors(w, 2.5);   // w ruchu (otwarcie 0.5 < pass)
  assert.equal(findPath(nav, a, c, path), 0);
});

test('graf budowany przy otwartych drzwiach niezależnie od bieżącej pozy (węzły w przejściu istnieją)', () => {
  const w = hall();
  resetDoors(w, 3.5);
  const nav = buildNav(w);
  assert.equal(door(w).cx, 0, 'buildNav przywraca pozę');
  let inGap = 0;
  for (let i = 0; i < nav.count; i++) if (Math.abs(nav.x[i]) < 1 && Math.abs(nav.z[i]) < 0.6) inGap++;
  assert.ok(inGap > 0);
});

test('determinizm: ten sam przebieg drzwi przy tym samym czasie; createSim resetuje pozę', () => {
  const w = hall();
  const run = () => {
    const sim = createSim({ world: w, seed: 3 });
    const out = [];
    for (let i = 0; i < 600; i++) { stepSim(sim, DT); if (i % 50 === 0) out.push(w.doorOpen[0]); }
    return out.join(',');
  };
  assert.equal(run(), run());
  stepDoors({ world: w, time: 0, participants: [] }, DT);
});
