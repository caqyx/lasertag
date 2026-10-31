// Testy elementów map (CONFIG.elements, mapgen.expandWall): okna strzeleckie, beczki i opony, siatki maskujące.
// Każdy element: kolizja (moveBody), wzrok/strzał (segmentClear, raycastWorld), nawigacja (buildNav: cover, krawędzie).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { moveBody, raycastWorld, segmentClear, createHit } from '../../src/world/physics.js';
import { buildNav, nearestNode, findPath } from '../../src/world/nav.js';
import { CONFIG } from '../../src/config.js';

const P = CONFIG.player;
const E = CONFIG.elements;
const DT = 1 / CONFIG.sim.hz;

function mk(walls, grid) {
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w: 20, d: 20 }, ceiling: 5, perimeter: { h: 5 },
    walls, grid, ramps: [], spawns: [], cams: [],
  });
}
function body(x, z) {
  return { x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, radius: P.radius, height: P.height };
}
/** Pcha ciało z (x, z0) w stronę z1 przez n kroków; zwraca końcowe z. */
function push(w, x, z0, z1, n = 240) {
  const b = body(x, z0);
  const v = Math.sign(z1 - z0) * P.walkSpeed;
  for (let i = 0; i < n; i++) { b.vx = 0; b.vz = v; moveBody(w, b, DT); }
  return b;
}
const hit = createHit();
const shot = (w, x, y, z0, z1) => raycastWorld(w, x, y, z0, 0, 0, Math.sign(z1 - z0), Math.abs(z1 - z0), hit);

// ------------------------------------------------------------------------------------------------ okno

test('okno: parapet + nadproże o wspólnym obrysie, flagi window/lintel', () => {
  const w = mk([{ kind: 'window', x: 0, z: 0, w: 2, d: 0.4 }]);
  const parts = w.solids.filter((s) => s.window);
  assert.equal(parts.length, 2);
  const sill = parts.find((s) => !s.lintel), lintel = parts.find((s) => s.lintel);
  assert.equal(sill.kind, 'half'); assert.equal(sill.y0, 0); assert.equal(sill.y1, E.window.sill);
  assert.equal(lintel.kind, 'wall'); assert.equal(lintel.y0, E.window.lintel); assert.equal(lintel.y1, E.window.top);
  assert.ok(E.window.sill < P.eyeHeight && P.eyeHeight < E.window.lintel, 'oko stojącego w otworze');
  assert.ok(E.window.sill > P.crouchEyeHeight, 'oko kucającego za parapetem');
});

test('okno: wzrok i strzał przez otwór na wysokości oka, zasłonięte pod parapetem i w nadprożu; ciało nie przejdzie', () => {
  const w = mk([{ kind: 'window', x: 0, z: 0, w: 2, d: 0.4 }]);
  assert.equal(segmentClear(w, 0, P.eyeHeight, -4, 0, P.eyeHeight, 4), true);
  assert.equal(segmentClear(w, 0, P.crouchEyeHeight, -4, 0, P.crouchEyeHeight, 4), false);
  assert.equal(segmentClear(w, 0, 2.1, -4, 0, 2.1, 4), false);
  assert.equal(shot(w, 0, P.eyeHeight, -4, 4), false);
  assert.equal(shot(w, 0, 0.6, -4, 4), true);
  const b = push(w, 0, -3, 3);
  assert.ok(b.z < -0.2 - P.radius + 0.01, `ciało przeszło przez okno: z=${b.z}`);
});

test('okno w siatce ASCII (znak w): run scalony w jedną parę parapet/nadproże', () => {
  const rows = ['..........', '..........', '..........', '..........', '..#ww#....', '..........', '..........', '..........', '..........', '..........'];
  const w = mk([], { cell: 2, rows });
  const parts = w.solids.filter((s) => s.window);
  assert.equal(parts.length, 2);
  for (const s of parts) { assert.equal(s.hx, 2); assert.equal(s.hz, 1); }
});

// ------------------------------------------------------------------------------------------------ beczki, opony

for (const kind of ['barrel', 'tires']) {
  test(`${kind}: 2 bryły (0°/45°) jednej grupy, okrągła osłona — blokuje ruch i niski strzał, wysoki strzał przechodzi`, () => {
    const w = mk([{ kind, x: 0, z: 0 }]);
    const parts = w.solids.filter((s) => s.prop === kind);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].group, parts[1].group);
    assert.ok(Math.abs(Math.abs(parts[1].rot - parts[0].rot) - Math.PI / 4) < 1e-9);
    const h = E[kind].h, r = E[kind].r;
    for (const s of parts) { assert.equal(s.y1, h); assert.ok(s.hx * Math.SQRT2 <= r * 1.25 && s.hx >= r * 0.8); }
    assert.equal(shot(w, 0, h * 0.5, -4, 4), true);
    assert.equal(shot(w, 0, h + 0.2, -4, 4), false);
    const b = push(w, 0, -3, 3);
    assert.ok(b.z < 0, `ciało przeszło przez ${kind}: z=${b.z}`);
  });
}

test('beczka: węzły nav obok mają flagę cover (osłona połówkowa)', () => {
  const w = mk([{ kind: 'barrel', x: 0, z: 0 }]);
  const nav = buildNav(w);
  let near = 0, cov = 0;
  for (let i = 0; i < nav.count; i++) {
    if (Math.hypot(nav.x[i], nav.z[i]) > 1.6) continue;   // pierścień najbliższych węzłów (siatka nav co 1 m)
    near++; cov += nav.cover[i];
  }
  assert.ok(near >= 4, `za mało węzłów przy beczce: ${near}`);
  assert.equal(cov, near, 'każdy węzeł przy beczce (≤ 1.6 m od środka) ma flagę cover');
});

// ------------------------------------------------------------------------------------------------ siatka

test('siatka: blokuje ruch, przepuszcza wzrok i strzał (raycast, segmentClear z końcem w siatce)', () => {
  const w = mk([{ kind: 'net', x: 0, z: 0, w: 20, rot: 0 }]);   // przez całą halę: brak obejścia
  const net = w.solids.find((s) => s.kind === 'net');
  assert.equal(net.seeThrough, true);
  assert.equal(net.y1, E.net.h);
  assert.equal(segmentClear(w, 0, P.eyeHeight, -4, 0, P.eyeHeight, 4), true);
  assert.equal(segmentClear(w, 0, 1, 0, 0, 1, 4), true, 'początek w siatce nie zasłania');
  assert.equal(shot(w, 0, 1, -4, 4), false);
  const b = push(w, 2, -3, 3);
  assert.ok(b.z < 0, `ciało przeszło przez siatkę: z=${b.z}`);
});

test('siatka: nav — żadna krawędź grafu nie przecina siatki, brak flagi cover przy siatce', () => {
  const w = mk([{ kind: 'net', x: 0, z: 0, w: 12, rot: 0 }]);
  const nav = buildNav(w);
  let crossing = 0;
  for (let a = 0; a < nav.count; a++) {
    for (let e = nav.edgeStart[a]; e < nav.edgeStart[a + 1]; e++) {
      const b = nav.edges[e];
      const za = nav.z[a], zb = nav.z[b];
      if ((za < 0) === (zb < 0)) continue;
      const t = za / (za - zb), x = nav.x[a] + (nav.x[b] - nav.x[a]) * t;
      if (Math.abs(x) <= 6 + P.radius) crossing++;
    }
  }
  assert.equal(crossing, 0, 'krawędź nav przez siatkę');
  const n = nearestNode(nav, 3, 0, -0.9);
  assert.equal(nav.cover[n], 0);
});

test('beczka i opony zasłaniają kucającego (top > oko w kucu)', () => {
  for (const kind of ['barrel', 'tires']) {
    const w = mk([{ kind, x: 0, z: 0 }]);
    assert.equal(segmentClear(w, 0, P.crouchEyeHeight, -0.8, 0, P.eyeHeight, -6), true, 'start przed beczką');
    assert.equal(segmentClear(w, 0, P.crouchEyeHeight, 0.8, 0, P.crouchEyeHeight, -6), false, `${kind}: kucający za osłoną widoczny`);
  }
});

test('siatka krótsza niż hala: nav obchodzi ją bokiem', () => {
  const w = mk([{ kind: 'net', x: 0, z: 0, w: 6, rot: 0 }]);
  const nav = buildNav(w);
  const path = new Int32Array(nav.count);
  const len = findPath(nav, nearestNode(nav, 0, 0, -3), nearestNode(nav, 0, 0, 3), path);
  assert.ok(len > 0);
  let maxAbsX = 0;
  for (let i = 0; i < len; i++) maxAbsX = Math.max(maxAbsX, Math.abs(nav.x[path[i]]));
  assert.ok(maxAbsX > 3, 'ścieżka musi obejść siatkę');
});
