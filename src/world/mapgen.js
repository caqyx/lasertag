// Generator świata: MapData (PLAN §1) → World (PLAN §2). Czysty JS, bez three, działa w Node.
//
// Konwencja obrotu brył (zgodna z Three.js, mesh.rotation.y = rot):
//   świat ← lokalny:  wx = cx + lx*cos + lz*sin,   wz = cz - lx*sin + lz*cos
//   lokalny ← świat:  lx = dx*cos - dz*sin,        lz = dx*sin + dz*cos      (dx = wx-cx, dz = wz-cz)

import { CONFIG } from '../config.js';
import { createRng } from '../core/rng.js';

// Domyślne wymiary brył z siatki (dane mapy mogą nadpisać w grid.heights / grid.pillarSize).
const DEFAULT_WALL_H = 2.4;
const DEFAULT_HALF_H = 1.1;
const DEFAULT_PILLAR_SIZE = 0.6;
const PERIMETER_THICKNESS = 1.0;   // ściany obwodowe leżą na zewnątrz bounds
const GRID_CELL = 4;               // rozmiar kubełka SpatialGrid (m), niezależny od CONFIG
const GRID_MARGIN = 2;             // margines siatki poza bounds (ściany obwodowe)
const MAX_QUERY = 1024;            // pojemność buforów wyników zapytań
// yaw: 'auto' spawnów — kierunek z najdłuższą wolną linią wzroku na wysokości oka
const AUTO_YAW_DIRS = 32;          // liczba badanych kierunków
const AUTO_YAW_TIE = 0.8;          // remis: kierunki z linią ≥ 80% najdłuższej → wybierz najbardziej ku środkowi
const AUTO_YAW_MIN_DOT = 0.1;      // tylko półprzestrzeń zwrócona ku środkowi mapy (cos kąta do środka)
const AUTO_YAW_MAX = 60;           // m — zasięg badania
const MIN_SPAWN_VIEW = 6;          // m — minimalna wymagana linia wzroku spawnu 'auto'

const PAINTS = ['stripes', 'geo', 'splatter', 'grid'];
const TRIM_PS = ['primary', 'secondary'];
const TRIM_HALF = ['accent', 'secondary'];

const KIND_OF = { '#': 'wall', h: 'half', o: 'pillar', w: 'window' };
const RUN_CHARS = '#hw';   // znaki scalane w runy (prostokąty)

/**
 * @param {object} mapData  MapData (PLAN §1)
 * @param {{ strict?: boolean }} [opts]  strict (domyślnie true) → błędy walidacji rzucają wyjątek; false → console.warn
 * @returns {object} World (PLAN §2)
 */
export function buildWorld(mapData, opts) {
  const strict = !opts || opts.strict !== false;
  const w = mapData.size.w;
  const d = mapData.size.d;
  const ceiling = mapData.ceiling;
  const bounds = { minX: -w / 2, maxX: w / 2, minZ: -d / 2, maxZ: d / 2 };

  const solids = [];
  if (mapData.grid) addGridSolids(mapData, bounds, solids);
  for (const wall of mapData.walls || []) expandWall(wall, solids);
  addPerimeter(mapData, bounds, solids);

  const ramps = (mapData.ramps || []).map(rampFromData);

  assignLooks(solids, mapData.seed >>> 0);

  const world = {
    id: mapData.id,
    name: mapData.name,
    seed: mapData.seed,
    palette: mapData.palette,
    ceiling,
    size: { w, d },
    bounds,
    solids,
    ramps,
    grid: null,
    spawns: (mapData.spawns || []).map((s) => ({ x: s.x, y: s.y || 0, z: s.z, yaw: s.yaw === 'auto' ? 'auto' : s.yaw || 0, team: s.team | 0 })),
    lights: (mapData.lights || []).map((l) => ({ ...l })),
    cams: (mapData.cams || []).map((c) => ({ name: c.name, pos: c.pos.slice(), look: c.look.slice() })),
    decor: (mapData.decor || []).map((x) => ({ ...x })),
  };
  world.grid = createSpatialGrid(bounds, solids, ramps);
  const autoYawProblems = [];
  for (let i = 0; i < world.spawns.length; i++) {
    const sp = world.spawns[i];
    if (sp.yaw !== 'auto') continue;
    const dist = autoSpawnYaw(world, sp);
    if (dist < MIN_SPAWN_VIEW) autoYawProblems.push(`spawn #${i} (${sp.x}, ${sp.z}): najdłuższa linia wzroku ${dist.toFixed(1)} m < ${MIN_SPAWN_VIEW} m`);
  }

  validate(world, strict, autoYawProblems);
  return world;
}

// ---------------------------------------------------------------------------------------------
// Siatka znakowa → bryły

function addGridSolids(mapData, bounds, out) {
  const g = mapData.grid;
  const cell = g.cell;
  const rows = g.rows;
  const nr = rows.length;
  const nc = nr ? rows[0].length : 0;
  for (let r = 0; r < nr; r++) {
    if (rows[r].length !== nc) throw new Error(`mapgen(${mapData.id}): wiersz ${r} ma długość ${rows[r].length}, oczekiwano ${nc}`);
  }
  if (Math.abs(nc * cell - mapData.size.w) > 1e-6 || Math.abs(nr * cell - mapData.size.d) > 1e-6) {
    throw new Error(`mapgen(${mapData.id}): siatka ${nc}×${nr}×${cell} m nie pasuje do size ${mapData.size.w}×${mapData.size.d}`);
  }
  const heights = g.heights || {};
  const hWall = heights.wall ?? DEFAULT_WALL_H;
  const hHalf = heights.half ?? DEFAULT_HALF_H;
  const hPillar = heights.pillar ?? mapData.ceiling;
  const pillar = g.pillarSize ?? DEFAULT_PILLAR_SIZE;
  const heightOf = (ch) => (ch === '#' ? hWall : hHalf);

  const used = new Uint8Array(nr * nc);
  const x0 = bounds.minX;
  const z0 = bounds.minZ;

  const box = (kind, c0, c1, r0, r1, h) => {
    // komórki [c0..c1] × [r0..r1] włącznie
    const cx = x0 + (c0 + c1 + 1) * cell / 2, cz = z0 + (r0 + r1 + 1) * cell / 2;
    const hx = (c1 - c0 + 1) * cell / 2, hz = (r1 - r0 + 1) * cell / 2;
    if (kind === 'window') { pushWindow(out, cx, cz, hx, hz, 0, null); return; }
    out.push(makeSolid(kind, cx, cz, hx, hz, 0, h, 0));
  };

  // 1) runy poziome tego samego znaku, długość ≥ 2
  for (let r = 0; r < nr; r++) {
    let c = 0;
    while (c < nc) {
      const ch = rows[r][c];
      if (!RUN_CHARS.includes(ch)) { c++; continue; }
      let e = c;
      while (e + 1 < nc && rows[r][e + 1] === ch) e++;
      if (e > c) {
        box(KIND_OF[ch], c, e, r, r, heightOf(ch));
        for (let k = c; k <= e; k++) used[r * nc + k] = 1;
      }
      c = e + 1;
    }
  }
  // 2) pozostałe pojedyncze komórki — scalane w pionie
  for (let c = 0; c < nc; c++) {
    let r = 0;
    while (r < nr) {
      const ch = rows[r][c];
      if (!RUN_CHARS.includes(ch) || used[r * nc + c]) { r++; continue; }
      let e = r;
      while (e + 1 < nr && rows[e + 1][c] === ch && !used[(e + 1) * nc + c]) e++;
      box(KIND_OF[ch], c, c, r, e, heightOf(ch));
      for (let k = r; k <= e; k++) used[k * nc + c] = 1;
      r = e + 1;
    }
  }
  // 3) filary
  for (let r = 0; r < nr; r++) {
    for (let c = 0; c < nc; c++) {
      if (rows[r][c] !== 'o') continue;
      out.push(makeSolid('pillar', x0 + (c + 0.5) * cell, z0 + (r + 0.5) * cell, pillar / 2, pillar / 2, 0, hPillar, 0));
    }
  }
}

function solidFromWall(wl) {
  const y0 = wl.y || 0;
  const s = makeSolid(wl.kind || 'wall', wl.x, wl.z, wl.w / 2, wl.d / 2, y0, y0 + wl.h, wl.rot || 0);
  if (wl.paint !== undefined) s.paint = wl.paint;
  if (wl.trim !== undefined) s.trim = wl.trim;
  if (wl.trimBottom !== undefined) s.trimBottom = !!wl.trimBottom;
  return s;
}

/**
 * Bryła z MapData.walls → 1+ bryły. Makra (CONFIG.elements):
 *   window — parapet (half, 0..sill) + nadproże (wall, lintel..top, flaga lintel); otwór sill..lintel przepuszcza wzrok i strzał,
 *   barrel / tires — okrągła osłona: 2 kwadraty (0° i 45°) o połowie boku r·k (gwiazda ≈ koło r), flaga prop, wspólna grupa,
 *   net — siatka maskująca: blokuje ruch, flaga seeThrough (raycast i linia wzroku ją pomijają).
 */
function expandWall(wl, out) {
  const E = CONFIG.elements;
  const kind = wl.kind || 'wall';
  if (kind === 'window') {
    pushWindow(out, wl.x, wl.z, wl.w / 2, wl.d / 2, wl.rot || 0, wl);
    return;
  }
  if (kind === 'barrel' || kind === 'tires') {
    const P = E[kind];
    const r = wl.r ?? P.r;
    const h = wl.h ?? P.h;
    const a = r * P.k;
    const rot = wl.rot || 0;
    const group = out.length;
    for (let k = 0; k < 2; k++) {
      const s = makeSolid('half', wl.x, wl.z, a, a, 0, h, rot + k * Math.PI / 4);
      s.prop = kind; s.group = group; s.radius = r;
      s.paint = 'none';
      if (wl.trim !== undefined) s.trim = wl.trim;
      out.push(s);
    }
    return;
  }
  if (kind === 'net') {
    const s = makeSolid('net', wl.x, wl.z, wl.w / 2, (wl.d ?? E.net.t) / 2, wl.y || 0, (wl.y || 0) + (wl.h ?? E.net.h), wl.rot || 0);
    s.seeThrough = true;
    s.paint = 'none';
    s.trim = wl.trim ?? 'uv';
    s.trimBottom = false;
    out.push(s);
    return;
  }
  out.push(solidFromWall(wl));
}

/** Okno strzeleckie: parapet + nadproże o wspólnym obrysie (cx, cz, hx, hz, rot). ext = pola paint/trim z danych. */
function pushWindow(out, cx, cz, hx, hz, rot, ext) {
  const W = CONFIG.elements.window;
  const sill = makeSolid('half', cx, cz, hx, hz, 0, W.sill, rot);
  const lintel = makeSolid('wall', cx, cz, hx, hz, W.lintel, W.top, rot);
  sill.window = true; lintel.window = true; lintel.lintel = true;
  if (ext) {
    for (const s of [sill, lintel]) {
      if (ext.paint !== undefined) s.paint = ext.paint;
      if (ext.trim !== undefined) s.trim = ext.trim;
    }
  }
  out.push(sill, lintel);
}

function addPerimeter(mapData, b, out) {
  const p = mapData.perimeter;
  if (!p) return;
  const t = PERIMETER_THICKNESS;
  const h = p.h ?? mapData.ceiling;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const mk = (cx, cz, hx, hz) => {
    const s = makeSolid('wall', cx, cz, hx, hz, 0, h, 0);
    s.boundary = true;
    if (p.paint !== undefined) s.paint = p.paint;
    s.trim = p.trim ?? 'primary';
    s.trimBottom = true;
    out.push(s);
  };
  // N i S obejmują narożniki
  mk(0, b.minZ - t / 2, w / 2 + t, t / 2);
  mk(0, b.maxZ + t / 2, w / 2 + t, t / 2);
  mk(b.minX - t / 2, 0, t / 2, d / 2);
  mk(b.maxX + t / 2, 0, t / 2, d / 2);
}

function makeSolid(kind, cx, cz, hx, hz, y0, y1, rot) {
  return {
    kind, cx, cz, hx, hz, y0, y1, rot,
    cos: Math.cos(rot), sin: Math.sin(rot),
    paint: undefined, trim: undefined, trimBottom: undefined, boundary: false,
    // elementy (CONFIG.elements): stały kształt obiektu dla V8 (te same pola w każdej bryle)
    seeThrough: false,   // siatka: blokuje ruch, nie wzrok/strzał
    window: false,       // część okna strzeleckiego (parapet / nadproże)
    lintel: false,       // nadproże okna (wisi nad otworem — render jak ściana, nie stal)
    prop: '',            // 'barrel' | 'tires' — okrągła osłona renderowana raz na grupę
    group: -1,           // indeks pierwszej bryły grupy (prop)
    radius: 0,           // promień wizualny propa
    mover: -1,           // indeks drzwi przesuwnych (MapData.doors) lub -1
  };
}

function rampFromData(r) {
  const rot = r.rot || 0;
  return { cx: r.x, cz: r.z, hx: r.w / 2, hz: r.d / 2, rot, cos: Math.cos(rot), sin: Math.sin(rot), y0: r.y0, y1: r.y1 };
}

// Deterministyczne paint/trim z seed. Każda bryła zużywa stałą liczbę losowań (niezależnie od nadpisań),
// więc jawne nadpisanie jednej ściany nie zmienia wyglądu pozostałych.
function assignLooks(solids, seed) {
  const rng = createRng(seed);
  for (const s of solids) {
    const rPaint = rng.next();
    const rTrim = rng.next();
    const rPick = rng.next();
    const rBottom = rng.next();
    const paint = PAINTS[Math.floor(rPaint * PAINTS.length)];
    let trim;
    let trimBottom = false;
    if (s.kind === 'half') {
      trim = TRIM_HALF[Math.floor(rPick * TRIM_HALF.length)];
    } else if (s.kind === 'pillar') {
      trim = 'uv';
    } else {
      trim = rTrim < 0.1 ? 'accent' : TRIM_PS[Math.floor(rPick * TRIM_PS.length)];
      trimBottom = s.kind === 'wall' && rBottom < 0.3;
    }
    if (s.paint === undefined) s.paint = paint;
    if (s.trim === undefined) s.trim = trim;
    if (s.trimBottom === undefined) s.trimBottom = trimBottom;
  }
}

// ---------------------------------------------------------------------------------------------
// SpatialGrid — kubełki indeksów (CSR). Zapytania bez alokacji: wyniki do prealokowanych Int32Array.

/** AABB w XZ bryły/rampy (OBB) — zapis do out[0..3] = minX, minZ, maxX, maxZ. */
function obbAabb(o, out) {
  const c = Math.abs(o.cos);
  const s = Math.abs(o.sin);
  const ex = c * o.hx + s * o.hz;
  const ez = s * o.hx + c * o.hz;
  out[0] = o.cx - ex; out[1] = o.cz - ez; out[2] = o.cx + ex; out[3] = o.cz + ez;
}

function buildBuckets(g, list) {
  const n = g.cols * g.rows;
  const counts = new Int32Array(n + 1);
  const ab = [0, 0, 0, 0];
  const ranges = [];
  for (let i = 0; i < list.length; i++) {
    obbAabb(list[i], ab);
    const c0 = cellCol(g, ab[0]); const c1 = cellCol(g, ab[2]);
    const r0 = cellRow(g, ab[1]); const r1 = cellRow(g, ab[3]);
    ranges.push(c0, c1, r0, r1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) counts[r * g.cols + c + 1]++;
  }
  for (let k = 1; k <= n; k++) counts[k] += counts[k - 1];
  const start = counts;
  const fill = new Int32Array(n);
  const items = new Int32Array(start[n]);
  for (let i = 0; i < list.length; i++) {
    const c0 = ranges[i * 4]; const c1 = ranges[i * 4 + 1]; const r0 = ranges[i * 4 + 2]; const r1 = ranges[i * 4 + 3];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * g.cols + c;
      items[start[k] + fill[k]++] = i;
    }
  }
  return { start, items };
}

export function createSpatialGrid(bounds, solids, ramps) {
  const minX = bounds.minX - GRID_MARGIN;
  const minZ = bounds.minZ - GRID_MARGIN;
  const maxX = bounds.maxX + GRID_MARGIN;
  const maxZ = bounds.maxZ + GRID_MARGIN;
  const g = {
    cell: GRID_CELL,
    inv: 1 / GRID_CELL,
    minX, minZ, maxX, maxZ,
    cols: Math.max(1, Math.ceil((maxX - minX) / GRID_CELL)),
    rows: Math.max(1, Math.ceil((maxZ - minZ) / GRID_CELL)),
    solidStart: null, solidItems: null,
    rampStart: null, rampItems: null,
    // deduplikacja zapytań: znacznik per bryła/rampa
    stamp: 0,
    solidStamp: new Uint32Array(solids.length),
    rampStamp: new Uint32Array(ramps.length),
    // bufory wyników (nadpisywane przy każdym zapytaniu — nie zagnieżdżać zapytań)
    outSolids: new Int32Array(Math.max(MAX_QUERY, solids.length)),
    outRamps: new Int32Array(Math.max(16, ramps.length)),
  };
  const bs = buildBuckets(g, solids);
  g.solidStart = bs.start; g.solidItems = bs.items;
  const br = buildBuckets(g, ramps);
  g.rampStart = br.start; g.rampItems = br.items;
  return g;
}

export function cellCol(g, x) {
  const c = Math.floor((x - g.minX) * g.inv);
  return c < 0 ? 0 : c >= g.cols ? g.cols - 1 : c;
}

export function cellRow(g, z) {
  const r = Math.floor((z - g.minZ) * g.inv);
  return r < 0 ? 0 : r >= g.rows ? g.rows - 1 : r;
}

/** Nowy znacznik zapytania (dedupe). Bez alokacji. */
export function nextStamp(g) {
  g.stamp = (g.stamp + 1) >>> 0;
  if (g.stamp === 0) { g.solidStamp.fill(0); g.rampStamp.fill(0); g.stamp = 1; }
  return g.stamp;
}

// Wewnętrzny bufor AABB dla nakładek querySolids/queryRamps.
const QBOX = new Float64Array(4);

/**
 * Wspólne: indeksy z kubełków przecinających AABB box = [minX, minZ, maxX, maxZ] → out[0..n). Zwraca n.
 * Argumenty geometryczne czytane z Float64Array — przekazywanie świeżych doubli do nie-inline'owanej funkcji
 * alokuje w V8 HeapNumber; tu przekazujemy tylko referencje.
 */
function queryBuckets(g, box, start, items, stamps, out) {
  if (items.length === 0) return 0;
  const st = nextStamp(g);
  const inv = g.inv;
  const cMax = g.cols - 1;
  const rMax = g.rows - 1;
  let c0 = Math.floor((box[0] - g.minX) * inv);
  let r0 = Math.floor((box[1] - g.minZ) * inv);
  let c1 = Math.floor((box[2] - g.minX) * inv);
  let r1 = Math.floor((box[3] - g.minZ) * inv);
  c0 = c0 < 0 ? 0 : c0 > cMax ? cMax : c0;
  c1 = c1 < 0 ? 0 : c1 > cMax ? cMax : c1;
  r0 = r0 < 0 ? 0 : r0 > rMax ? rMax : r0;
  r1 = r1 < 0 ? 0 : r1 > rMax ? rMax : r1;
  const cap = out.length;
  let n = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const k = r * g.cols + c;
      for (let j = start[k], e = start[k + 1]; j < e; j++) {
        const i = items[j];
        if (stamps[i] === st) continue;
        stamps[i] = st;
        if (n < cap) out[n++] = i;
      }
    }
  }
  return n;
}

/** Bryły w AABB box (Float64Array(4): minX, minZ, maxX, maxZ) → g.outSolids[0..n). Zwraca n. Bez alokacji. */
export function querySolidsBox(g, box) {
  return queryBuckets(g, box, g.solidStart, g.solidItems, g.solidStamp, g.outSolids);
}

/** Rampy w AABB box → g.outRamps[0..n). Zwraca n. Bez alokacji. */
export function queryRampsBox(g, box) {
  return queryBuckets(g, box, g.rampStart, g.rampItems, g.rampStamp, g.outRamps);
}

/** Nakładka: indeksy brył, których kubełki przecinają AABB → g.outSolids[0..n). Zwraca n. Nie zagnieżdżać zapytań. */
export function querySolids(g, minX, minZ, maxX, maxZ) {
  QBOX[0] = minX; QBOX[1] = minZ; QBOX[2] = maxX; QBOX[3] = maxZ;
  return querySolidsBox(g, QBOX);
}

/** Nakładka: jak querySolids, dla ramp → g.outRamps. */
export function queryRamps(g, minX, minZ, maxX, maxZ) {
  QBOX[0] = minX; QBOX[1] = minZ; QBOX[2] = maxX; QBOX[3] = maxZ;
  return queryRampsBox(g, QBOX);
}

// ---------------------------------------------------------------------------------------------
// yaw spawnów 'auto' (build — alokacje dozwolone)

/** Długość wolnej linii (poziomej, na wysokości y) z (x,z) w kierunku (dx,dz) — bryły (OBB×[y0,y1]), rampy, bounds. */
function freeLine(world, x, y, z, dx, dz) {
  let best = AUTO_YAW_MAX;
  const b = world.bounds;
  if (dx > 1e-9) best = Math.min(best, (b.maxX - x) / dx); else if (dx < -1e-9) best = Math.min(best, (b.minX - x) / dx);
  if (dz > 1e-9) best = Math.min(best, (b.maxZ - z) / dz); else if (dz < -1e-9) best = Math.min(best, (b.minZ - z) / dz);
  const test = (o, y0, y1) => {
    if (y < y0 || y > y1) return;
    const rx = x - o.cx; const rz = z - o.cz;
    const lox = rx * o.cos - rz * o.sin; const loz = rx * o.sin + rz * o.cos;
    const ldx = dx * o.cos - dz * o.sin; const ldz = dx * o.sin + dz * o.cos;
    let t0 = -Infinity; let t1 = Infinity;
    for (const [p, d, h] of [[lox, ldx, o.hx], [loz, ldz, o.hz]]) {
      if (Math.abs(d) < 1e-12) { if (p < -h || p > h) return; continue; }
      let u = (-h - p) / d; let v = (h - p) / d;
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
    }
    if (t0 <= t1 && t0 >= 0 && t0 < best) best = t0;
  };
  for (const s of world.solids) if (!s.seeThrough) test(s, s.y0, s.y1);   // siatka nie zasłania widoku
  for (const r of world.ramps) test(r, 0, Math.max(r.y0, r.y1)); // rampa zachowawczo jako prostopadłościan
  return best;
}

/** Ustawia sp.yaw: najdłuższa linia wzroku (oko) w półprzestrzeni ku środkowi; remis ±20% → najbliżej środka. Zwraca długość. */
function autoSpawnYaw(world, sp) {
  const eyeY = sp.y + CONFIG.player.eyeHeight;
  let cx = -sp.x; let cz = -sp.z;
  const cl = Math.hypot(cx, cz);
  if (cl > 1e-9) { cx /= cl; cz /= cl; } else { cx = 0; cz = -1; }
  const cand = [];
  for (let k = 0; k < AUTO_YAW_DIRS; k++) {
    const yaw = -Math.PI + (k / AUTO_YAW_DIRS) * 2 * Math.PI;
    const fx = -Math.sin(yaw); const fz = -Math.cos(yaw);
    const dot = fx * cx + fz * cz;
    if (cl > 1e-9 && dot < AUTO_YAW_MIN_DOT) continue;
    cand.push({ yaw, dot, d: freeLine(world, sp.x, eyeY, sp.z, fx, fz) });
  }
  let maxD = 0;
  for (const c of cand) if (c.d > maxD) maxD = c.d;
  let pick = null;
  for (const c of cand) if (c.d >= maxD * AUTO_YAW_TIE && (!pick || c.dot > pick.dot)) pick = c;
  sp.yaw = pick ? pick.yaw : Math.atan2(sp.x, sp.z);
  return pick ? pick.d : 0;
}

// ---------------------------------------------------------------------------------------------
// Walidacja

function circleHitsObb(s, x, z, r) {
  const dx = x - s.cx; const dz = z - s.cz;
  const lx = dx * s.cos - dz * s.sin;
  const lz = dx * s.sin + dz * s.cos;
  const qx = lx < -s.hx ? -s.hx : lx > s.hx ? s.hx : lx;
  const qz = lz < -s.hz ? -s.hz : lz > s.hz ? s.hz : lz;
  const ex = lx - qx; const ez = lz - qz;
  return ex * ex + ez * ez < r * r;
}

function validate(world, strict, extra) {
  const P = CONFIG.player;
  const problems = extra ? extra.slice() : [];
  world.spawns.forEach((sp, i) => {
    const b = world.bounds;
    if (sp.x < b.minX + P.radius || sp.x > b.maxX - P.radius || sp.z < b.minZ + P.radius || sp.z > b.maxZ - P.radius) {
      problems.push(`spawn #${i} (${sp.x}, ${sp.z}) poza areną`);
    }
    world.solids.forEach((s, j) => {
      const blocks = s.y1 > sp.y + P.stepHeight && s.y0 < sp.y + P.height;
      if (blocks && circleHitsObb(s, sp.x, sp.z, P.radius)) problems.push(`spawn #${i} (${sp.x}, ${sp.z}) w bryle #${j} (${s.kind})`);
    });
  });
  world.ramps.forEach((r, i) => {
    const slope = Math.abs(r.y1 - r.y0) / (2 * r.hz);
    if (slope > P.maxSlopeY) problems.push(`rampa #${i}: nachylenie ${slope.toFixed(2)} > maxSlopeY ${P.maxSlopeY}`);
  });
  if (problems.length) {
    const msg = `mapgen(${world.id}): ` + problems.join('; ');
    if (strict) throw new Error(msg);
    console.warn(msg);
  }
}
