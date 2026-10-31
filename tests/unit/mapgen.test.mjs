// Testy src/world/mapgen.js na UV Maze i mapach testowych: determinizm, bryły (rodzaje, obwód, scalanie runów),
// spawny/kamery poza bryłami, paint/trim z dozwolonych zbiorów, bryły obrócone (rot = π/3), SpatialGrid, walidacja.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld, querySolids } from '../../src/world/mapgen.js';
import uvmaze from '../../src/world/maps/uvmaze.js';
import { MAPS } from '../../src/world/maps/index.js';
import { CONFIG } from '../../src/config.js';

const P = CONFIG.player;
const PAINTS = new Set(['stripes', 'geo', 'splatter', 'grid', 'none']);
const TRIMS = new Set(['primary', 'secondary', 'accent', 'uv', 'none']);

function local(s, x, z) {
  const dx = x - s.cx; const dz = z - s.cz;
  return [dx * s.cos - dz * s.sin, dx * s.sin + dz * s.cos];
}
function circleHits(s, x, z, r) {
  const [lx, lz] = local(s, x, z);
  const qx = Math.max(-s.hx, Math.min(s.hx, lx));
  const qz = Math.max(-s.hz, Math.min(s.hz, lz));
  return (lx - qx) ** 2 + (lz - qz) ** 2 < r * r;
}
function pointIn(s, x, y, z) {
  const [lx, lz] = local(s, x, z);
  return Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz && y >= s.y0 && y <= s.y1;
}
function testMap(extra = {}) {
  return {
    id: 'test', name: 'Test', seed: 99,
    size: { w: 20, d: 20 }, ceiling: 4, perimeter: { h: 4 },
    palette: {}, walls: [], ramps: [], spawns: [{ x: 0, z: 0, team: 0 }], cams: [], lights: [], decor: [],
    ...extra,
  };
}

const world = buildWorld(uvmaze);

test('rejestr MAPS zawiera uvmaze pod jego id', () => {
  assert.equal(MAPS.uvmaze, uvmaze);
  assert.equal(uvmaze.id, 'uvmaze');
});

test('determinizm: dwa buildWorld dają identyczny świat; dane wejściowe niezmienione', () => {
  const snap = JSON.stringify(uvmaze);
  const a = buildWorld(uvmaze);
  const b = buildWorld(uvmaze);
  assert.deepEqual(a.solids, b.solids);
  assert.deepEqual(a.spawns, b.spawns);
  assert.deepEqual(a.cams, b.cams);
  assert.equal(JSON.stringify(uvmaze), snap, 'buildWorld nie może mutować MapData');
  // kopie, nie aliasy
  a.cams[0].pos[0] = 999;
  assert.notEqual(uvmaze.cams[0].pos[0], 999);
});

test('UV Maze: wymiary, sufit, bounds, 8 spawnów (2 na stronę), ≥ 4 kamery', () => {
  assert.deepEqual(world.bounds, { minX: -18, maxX: 18, minZ: -18, maxZ: 18 });
  assert.equal(world.ceiling, 4.5);
  assert.equal(world.spawns.length, 8);
  const perTeam = [0, 0, 0, 0];
  for (const s of world.spawns) perTeam[s.team]++;
  assert.deepEqual(perTeam, [2, 2, 2, 2]);
  assert.ok(world.cams.length >= 4);
});

test('UV Maze: liczby i rodzaje brył, wysokości wg legendy', () => {
  const byKind = {};
  for (const s of world.solids) byKind[s.kind] = (byKind[s.kind] || 0) + 1;
  const pillarsInGrid = uvmaze.grid.rows.join('').split('').filter((c) => c === 'o').length;
  assert.equal(byKind.pillar, pillarsInGrid);
  assert.deepEqual(Object.keys(byKind).sort(), ['door', 'half', 'net', 'pillar', 'wall']);
  const E = CONFIG.elements;
  for (const s of world.solids) {
    if (s.boundary) { assert.equal(s.y0, 0); assert.equal(s.y1, 4.5); continue; }
    if (s.lintel) { assert.equal(s.y0, E.window.lintel); assert.equal(s.y1, E.window.top); continue; }
    assert.equal(s.y0, 0);
    if (s.prop) { assert.equal(s.y1, E[s.prop].h); continue; }   // beczki/opony: 2 bryły pod 0°/45°
    if (s.kind === 'net') { assert.equal(s.y1, E.net.h); assert.equal(s.seeThrough, true); continue; }
    if (s.kind === 'door') { assert.equal(s.y1, E.door.h); assert.ok(s.mover >= 0); continue; }
    if (s.kind === 'wall') assert.equal(s.y1, 2.4);
    if (s.kind === 'half') assert.equal(s.y1, 1.1);
    if (s.kind === 'pillar') { assert.equal(s.y1, 4.5); assert.equal(s.hx, 0.3); assert.equal(s.hz, 0.3); }
    assert.ok(s.hx > 0 && s.hz > 0);
    assert.equal(s.rot, 0);
  }
  // 74 = układ „trzy linie” + elementy (2026-10-31): 4 obwodowe, z siatki 38 ścian, 6 połówek, 4 filary, 2 okna 'ww'
  // (parapet + nadproże = 4); z walls: 2 siatki, 2 stosy opon i 4 beczki (po 2 bryły kolizji = 12); 4 drzwi przesuwne (doors).
  // Zmiana mapy = świadoma aktualizacja.
  assert.equal(world.solids.filter((s) => s.prop).length, 12);
  assert.equal(world.solids.filter((s) => s.kind === 'net').length, 2);
  assert.equal(world.solids.filter((s) => s.window).length, 4);   // 2 okna 'ww' × (parapet + nadproże)
  assert.equal(world.solids.filter((s) => s.kind === 'door').length, 4);
  assert.equal(world.solids.length, 74);
});

test('obwód: dokładnie 4 bryły boundary, na zewnątrz bounds, szczelne narożniki, wysokość = sufit', () => {
  const b = world.solids.filter((s) => s.boundary);
  assert.equal(b.length, 4);
  const B = world.bounds;
  for (const s of b) {
    assert.equal(s.kind, 'wall');
    assert.equal(s.y1, world.ceiling);
    // wewnętrzna krawędź dokładnie na bounds, bryła cała na zewnątrz
    const inside = s.cx - s.hx >= B.minX - 1e-9 && s.cx + s.hx <= B.maxX + 1e-9 && s.cz - s.hz >= B.minZ - 1e-9 && s.cz + s.hz <= B.maxZ + 1e-9;
    assert.ok(!inside);
    const touches = [s.cx + s.hx, s.cx - s.hx, s.cz + s.hz, s.cz - s.hz].some((v) => [B.minX, B.maxX, B.minZ, B.maxZ].includes(v));
    assert.ok(touches, 'ściana obwodowa przylega do bounds');
  }
  // narożniki (na zewnątrz, po przekątnej) zakryte
  for (const [x, z] of [[-18.5, -18.5], [18.5, -18.5], [-18.5, 18.5], [18.5, 18.5]]) {
    assert.ok(b.some((s) => pointIn(s, x, 1, z)), `narożnik ${x},${z} odsłonięty`);
  }
  // każdy punkt tuż za bounds na obwodzie jest w ścianie
  for (let t = -18; t <= 18; t += 0.5) {
    for (const [x, z] of [[t, -18.2], [t, 18.2], [-18.2, t], [18.2, t]]) {
      assert.ok(b.some((s) => pointIn(s, x, 1, z)), `dziura w obwodzie przy ${x},${z}`);
    }
  }
});

test('siatka: każda komórka #/h pokryta dokładnie jedną bryłą właściwego rodzaju, puste komórki wolne', () => {
  const rows = uvmaze.grid.rows;
  const cell = uvmaze.grid.cell;
  const grid = world.solids.filter((s) => !s.boundary && s.kind !== 'pillar' && !s.prop && s.kind !== 'net');   // bez elementów z walls
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const x = -18 + (c + 0.5) * cell;
      const z = -18 + (r + 0.5) * cell;
      const covering = grid.filter((s) => pointIn(s, x, 0.5, z));
      const ch = rows[r][c];
      if (ch === '#' || ch === 'h' || ch === 'w') {
        assert.equal(covering.length, 1, `komórka (${r},${c}) '${ch}' pokryta ${covering.length}×`);   // y = 0.5: okno → sam parapet
        assert.equal(covering[0].kind, ch === '#' ? 'wall' : 'half');
        assert.equal(covering[0].window, ch === 'w');
      } else {
        assert.equal(covering.length, 0, `komórka (${r},${c}) '${ch}' zajęta przez bryłę`);
      }
    }
  }
});

test('scalanie runów: każdy poziomy run długości ≥ 2 to jedna bryła; bryły nie są pocięte', () => {
  const rows = uvmaze.grid.rows;
  const cell = uvmaze.grid.cell;
  const grid = world.solids.filter((s) => !s.boundary && s.kind !== 'pillar' && !s.prop && s.kind !== 'net' && !s.lintel);
  for (let r = 0; r < rows.length; r++) {
    let c = 0;
    while (c < rows[r].length) {
      const ch = rows[r][c];
      if (ch !== '#' && ch !== 'h' && ch !== 'w') { c++; continue; }
      let e = c;
      while (e + 1 < rows[r].length && rows[r][e + 1] === ch) e++;
      if (e > c) {
        const z = -18 + (r + 0.5) * cell;
        const x0 = -18 + c * cell;
        const x1 = -18 + (e + 1) * cell;
        const s = grid.find((q) => Math.abs(q.cx - (x0 + x1) / 2) < 1e-9 && Math.abs(q.cz - z) < 1e-9);
        assert.ok(s, `run wiersz ${r} kol ${c}..${e} nie jest jedną bryłą`);
        assert.ok(Math.abs(s.hx - (x1 - x0) / 2) < 1e-9 && Math.abs(s.hz - cell / 2) < 1e-9);
      }
      c = e + 1;
    }
  }
  // brak dwóch brył tego samego rodzaju stykających się bokiem w jednym wierszu (powinny być scalone)
  for (let i = 0; i < grid.length; i++) {
    for (let j = 0; j < grid.length; j++) {
      const a = grid[i]; const b = grid[j];
      if (i === j || a.kind !== b.kind) continue;
      const sameRow = Math.abs(a.cz - b.cz) < 1e-9 && Math.abs(a.hz - b.hz) < 1e-9 && a.hz === cell / 2;
      const touch = Math.abs(a.cx + a.hx - (b.cx - b.hx)) < 1e-9;
      assert.ok(!(sameRow && touch), `niescalone bryły ${i} i ${j} w wierszu z=${a.cz}`);
    }
  }
  // liczba brył siatki mniejsza niż liczba komórek (scalanie zadziałało)
  const cells = rows.join('').split('').filter((ch) => ch === '#' || ch === 'h').length;
  assert.ok(grid.length < cells * 0.7, `${grid.length} brył na ${cells} komórek`);
});

test('scalanie pionowe pojedynczych komórek i brak scalania różnych znaków', () => {
  const w = buildWorld(testMap({
    size: { w: 8, d: 8 },
    grid: { cell: 2, rows: ['#...', '#.h#', '#.#h', '....'] },
    spawns: [{ x: -1, z: 3, team: 0 }],
  }));
  const g = w.solids.filter((s) => !s.boundary);
  // kolumna 0, wiersze 0..2 → jedna bryła 2×6; 'h#' i '#h' — runy różnych znaków nie są scalane
  const col0 = g.find((s) => s.cx === -3 && s.hz === 3);
  assert.ok(col0, 'pionowy run kolumny 0 nie scalony');
  assert.equal(col0.kind, 'wall');
  assert.equal(g.length, 5);
  assert.equal(g.filter((s) => s.kind === 'half').length, 2);
});

test('walidacja siatki: zła długość wiersza / niezgodny rozmiar → wyjątek', () => {
  assert.throws(() => buildWorld(testMap({ size: { w: 8, d: 4 }, grid: { cell: 2, rows: ['....', '...'] } })), /wiersz 1/);
  assert.throws(() => buildWorld(testMap({ size: { w: 10, d: 4 }, grid: { cell: 2, rows: ['....', '....'] } })), /nie pasuje/);
});

test('spawny UV Maze: w bounds (z marginesem promienia), poza bryłami, na podłodze, yaw patrzy do środka', () => {
  const B = world.bounds;
  for (const sp of world.spawns) {
    assert.ok(sp.x >= B.minX + P.radius && sp.x <= B.maxX - P.radius && sp.z >= B.minZ + P.radius && sp.z <= B.maxZ - P.radius);
    assert.equal(sp.y, 0);
    for (const s of world.solids) {
      assert.ok(!circleHits(s, sp.x, sp.z, P.radius + 0.05), `spawn ${sp.x},${sp.z} w bryle ${s.kind}@${s.cx},${s.cz}`);
    }
    // przód (-sin yaw, -cos yaw) wskazuje w stronę (0,0)
    const fx = -Math.sin(sp.yaw); const fz = -Math.cos(sp.yaw);
    assert.ok(fx * -sp.x + fz * -sp.z > 0, 'spawn odwrócony od środka');
  }
  // spawny unikalne i rozsunięte
  for (let i = 0; i < world.spawns.length; i++) for (let j = i + 1; j < world.spawns.length; j++) {
    const a = world.spawns[i]; const b = world.spawns[j];
    assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 2 * P.radius);
  }
});

test('kamery debug: wewnątrz areny, pod sufitem, poza bryłami, look ≠ pos', () => {
  const B = world.bounds;
  for (const c of world.cams) {
    const [x, y, z] = c.pos;
    assert.ok(x > B.minX && x < B.maxX && z > B.minZ && z < B.maxZ, `${c.name} poza areną`);
    assert.ok(y > 0 && y < world.ceiling, `${c.name} y=${y}`);
    for (const s of world.solids) {
      assert.ok(!pointIn(s, x, y, z), `kamera ${c.name} w bryle ${s.kind}@${s.cx},${s.cz}`);
    }
    assert.ok(Math.hypot(c.look[0] - x, c.look[1] - y, c.look[2] - z) > 1);
    assert.equal(typeof c.name, 'string');
  }
  assert.equal(new Set(world.cams.map((c) => c.name)).size, world.cams.length, 'nazwy kamer unikalne');
});

test('paint/trim/trimBottom z dozwolonych zbiorów; filary trim uv; połówki bez trimBottom', () => {
  for (const s of world.solids) {
    assert.ok(PAINTS.has(s.paint), `paint ${s.paint}`);
    assert.ok(TRIMS.has(s.trim), `trim ${s.trim}`);
    assert.equal(typeof s.trimBottom, 'boolean');
    if (s.kind === 'pillar') assert.equal(s.trim, 'uv');
    if (s.kind === 'half') { assert.ok(['accent', 'secondary'].includes(s.trim)); assert.equal(s.trimBottom, false); }
    if (s.boundary) { assert.equal(s.paint, 'stripes'); assert.equal(s.trimBottom, true); }
  }
  // różnorodność: nie wszystkie ściany mają ten sam paint
  assert.ok(new Set(world.solids.map((s) => s.paint)).size >= 3);
});

test('wygląd zależy od seed; jawne nadpisanie jednej bryły nie zmienia pozostałych', () => {
  const walls = [];
  for (let i = 0; i < 12; i++) walls.push({ x: -8 + i * 1.4, z: 5, w: 1, d: 1, h: 2 });
  const a = buildWorld(testMap({ walls }));
  const b = buildWorld(testMap({ walls, seed: 100 }));
  const looks = (w) => w.solids.map((s) => `${s.paint}/${s.trim}/${s.trimBottom}`);
  assert.notDeepEqual(looks(a), looks(b));
  const walls2 = walls.map((w, i) => (i === 3 ? { ...w, paint: 'none', trim: 'none', trimBottom: true } : w));
  const c = buildWorld(testMap({ walls: walls2 }));
  const la = looks(a); const lc = looks(c);
  for (let i = 0; i < la.length; i++) if (i !== 3) assert.equal(lc[i], la[i], `bryła ${i} zmieniła wygląd`);
  assert.equal(c.solids[3].paint, 'none');
  assert.equal(c.solids[3].trim, 'none');
  assert.equal(c.solids[3].trimBottom, true);
});

test('jawne bryły: y, kind, rot π/3 → cos/sin, AABB w SpatialGrid', () => {
  const rot = Math.PI / 3;
  const w = buildWorld(testMap({
    walls: [{ x: 5, z: -4, w: 6, d: 0.4, h: 1.5, y: 0.5, rot, kind: 'platform' }],
    spawns: [{ x: 5, z: -1, team: 0 }],
  }));
  const s = w.solids[0];
  assert.equal(s.kind, 'platform');
  assert.equal(s.y0, 0.5);
  assert.equal(s.y1, 2.0);
  assert.equal(s.hx, 3);
  assert.equal(s.hz, 0.2);
  assert.ok(Math.abs(s.cos - 0.5) < 1e-12 && Math.abs(s.sin - Math.sqrt(3) / 2) < 1e-12);
  // koniec lokalnej osi X (lx=3) w świecie: (cx + 3cos, cz - 3sin)
  const ex = s.cx + 3 * s.cos; const ez = s.cz - 3 * s.sin;
  assert.ok(pointIn(s, ex - 0.01 * s.cos, 1, ez + 0.01 * s.sin));
  // zapytanie siatki w pobliżu końca obróconej bryły ją znajduje
  const n = querySolids(w.grid, ex - 0.1, ez - 0.1, ex + 0.1, ez + 0.1);
  const found = Array.from(w.grid.outSolids.subarray(0, n));
  assert.ok(found.includes(0), 'SpatialGrid nie zna końca obróconej bryły');
});

test('querySolids: zawsze zawiera każdą bryłę nachodzącą na zapytanie (brute force, losowe AABB)', () => {
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 2000; i++) {
    const x = -20 + rnd() * 40; const z = -20 + rnd() * 40; const r = rnd() * 3;
    const n = querySolids(world.grid, x - r, z - r, x + r, z + r);
    const got = new Set(world.grid.outSolids.subarray(0, n));
    assert.equal(got.size, n, 'duplikaty w wyniku zapytania');
    world.solids.forEach((s, k) => {
      if (circleHits(s, x, z, r)) assert.ok(got.has(k), `brak bryły ${k} w zapytaniu (${x},${z},${r})`);
    });
  }
});

test('walidacja: spawn w ścianie / w obróconej ścianie / poza areną → wyjątek; strict:false → warn', () => {
  assert.throws(() => buildWorld(testMap({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 2 }] })), /spawn #0.*w bryle/);
  // spawn dotyka ściany promieniem
  assert.throws(() => buildWorld(testMap({ walls: [{ x: 1.2, z: 0, w: 2, d: 2, h: 2 }] })), /w bryle/);
  // obrócona: punkt w AABB, ale poza OBB → OK; w OBB → wyjątek
  const rot = Math.PI / 3;
  const thin = { x: 0, z: 0, w: 8, d: 0.4, h: 2, rot };
  assert.throws(() => buildWorld(testMap({ walls: [thin], spawns: [{ x: 1, z: -Math.sqrt(3), team: 0 }] })), /w bryle/);
  assert.doesNotThrow(() => buildWorld(testMap({ walls: [thin], spawns: [{ x: 1.5, z: 1.5, team: 0 }] })));
  // spawn na niskim stopniu (≤ stepHeight) jest dozwolony, w połówce nie
  assert.doesNotThrow(() => buildWorld(testMap({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 0.3 }] })));
  assert.throws(() => buildWorld(testMap({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 1.1, kind: 'half' }] })));
  // poza areną
  assert.throws(() => buildWorld(testMap({ spawns: [{ x: 9.9, z: 0, team: 0 }] })), /poza areną/);
  assert.throws(() => buildWorld(testMap({ spawns: [{ x: 0, z: -30, team: 0 }] })), /poza areną/);
  // strict:false
  const orig = console.warn;
  const msgs = [];
  console.warn = (m) => msgs.push(m);
  try {
    const w = buildWorld(testMap({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 2 }] }), { strict: false });
    assert.equal(w.spawns.length, 1);
  } finally { console.warn = orig; }
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /w bryle/);
});

test('walidacja ramp: nachylenie > maxSlopeY → wyjątek; łagodna rampa OK', () => {
  assert.throws(() => buildWorld(testMap({ ramps: [{ x: 5, z: 5, w: 2, d: 2, y0: 0, y1: 2 }] })), /nachylenie/);
  const w = buildWorld(testMap({ ramps: [{ x: 5, z: 5, w: 2, d: 10, y0: 0, y1: 2, rot: Math.PI / 3 }] }));
  assert.equal(w.ramps.length, 1);
  assert.ok(Math.abs(w.ramps[0].sin - Math.sqrt(3) / 2) < 1e-12);
});

test('spawny: brakujące y/yaw/team uzupełnione', () => {
  const w = buildWorld(testMap({ spawns: [{ x: 1, z: 2 }] }));
  assert.deepEqual(w.spawns[0], { x: 1, y: 0, z: 2, yaw: 0, team: 0 });
});

test('mapa bez perimeter → brak brył boundary', () => {
  const w = buildWorld(testMap({ perimeter: undefined }));
  assert.equal(w.solids.filter((s) => s.boundary).length, 0);
});
