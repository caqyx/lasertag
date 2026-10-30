// Graf nawigacji (PLAN §8.1). Czysty JS, bez three.
// buildNav alokuje (raz, przy ładowaniu mapy); nearestNode / findPath / randomNode / smoothPath — bez alokacji.
//
// Węzły: próbkowanie co CONFIG.nav.cell (środki komórek) na powierzchniach chodliwych: podłoga, topy brył, rampy.
// Węzeł istnieje, gdy kapsuła gracza stoi tam z odstępem CONFIG.nav.clearance od brył blokujących (pasmo
// [h+stepHeight, h+height]) i ma miejsce na wysokość gracza (sufit/spód brył).
// Krawędzie (8-kierunkowo przy linkDiagonal): odcinek próbkowany co EDGE_STEP; w każdej próbce powierzchnia
// (physics.groundHeight) zmienia się o ≤ maxClimb i koło (radius + margines) nie koliduje. Koszt = długość 3D.
//
// Zero alokacji a V8: funkcje wewnętrzne gorącej ścieżki dostają tylko referencje/int-y; liczby idą przez
// prealokowane Float64Array (świeży double jako argument / wynik nie-inline'owanej funkcji = HeapNumber).

import { CONFIG } from '../config.js';
import { querySolids, querySolidsBox, queryRamps } from './mapgen.js';
import { groundHeight } from './physics.js';

const EDGE_STEP = 0.2;        // m — gęstość próbkowania krawędzi
const EDGE_MARGIN = 0.03;     // m — margines koła przy teście krawędzi (ponad radius gracza)
const SUPPORT_EPS = 0.05;     // m — tolerancja zgodności wysokości węzła z groundHeight
const SAME_LEVEL_DY = 1.0;    // m — nearestNode: „ten sam poziom"
const NEAR_RING = 2;          // komórki — promień pierwszego przeszukiwania nearestNode
const COVER_HEIGHT = 1.0;     // m — bryła o y1 ≥ tej wysokości (nad węzłem) daje osłonę
const COVER_DIST = 1.1;       // m — maks. odległość krawędzi bryły od węzła dla flagi cover
const SMOOTH_SAMPLE = 0.5;    // m — próbkowanie korytarza przy smoothPath
const FLAT_DY = 0.05;         // m — smoothPath wygładza tylko odcinki płaskie
const SMOOTH_MARGIN = 0.1;    // m — zapas ponad radius przy smoothPath (bot ścina narożniki; węzły leżą ≥ clearance od ścian)

// ---------------------------------------------------------------------------------------------
// Pomocnicze (build — mogą alokować; tu wygoda > wydajność)

/** Czy koło (x,z,r) na wysokości stóp h koliduje z bryłą/klinem rampy blokującym w paśmie [h+step, h+height]. */
function blockedAt(world, x, z, h, r) {
  const P = CONFIG.player;
  const lo = h + P.stepHeight;
  const hi = h + P.height;
  if (hi > world.ceiling + 1e-6) return true;
  const g = world.grid;
  const n = querySolids(g, x - r, z - r, x + r, z + r);
  for (let k = 0; k < n; k++) {
    const s = world.solids[g.outSolids[k]];
    if (!(s.y1 > lo && s.y0 < hi)) continue;
    if (circleDist2(s, x, z) < r * r) return true;
  }
  const nr = queryRamps(g, x - r, z - r, x + r, z + r);
  for (let k = 0; k < nr; k++) {
    const rp = world.ramps[g.outRamps[k]];
    if (circleDist2(rp, x, z) >= r * r) continue;
    const dx = x - rp.cx; const dz = z - rp.cz;
    let t = ((dx * rp.sin + dz * rp.cos) + rp.hz) / (2 * rp.hz);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    if (rp.y0 + (rp.y1 - rp.y0) * t > lo) return true;
  }
  return false;
}

/** Kwadrat odległości punktu (x,z) od prostokąta OBB w XZ. */
function circleDist2(o, x, z) {
  const dx = x - o.cx; const dz = z - o.cz;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  const qx = lx < -o.hx ? -o.hx : lx > o.hx ? o.hx : lx;
  const qz = lz < -o.hz ? -o.hz : lz > o.hz ? o.hz : lz;
  const ex = lx - qx; const ez = lz - qz;
  return ex * ex + ez * ez;
}

function insideObb(o, x, z) {
  const dx = x - o.cx; const dz = z - o.cz;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  return lx >= -o.hx && lx <= o.hx && lz >= -o.hz && lz <= o.hz;
}

/** Kandydujące wysokości powierzchni w punkcie: podłoga, topy brył nad punktem, rampy. */
function surfaceCandidates(world, x, z, out) {
  out.length = 0;
  out.push(0);
  const g = world.grid;
  const n = querySolids(g, x, z, x, z);
  for (let k = 0; k < n; k++) {
    const s = world.solids[g.outSolids[k]];
    if (s.boundary) continue;
    if (insideObb(s, x, z)) out.push(s.y1);
  }
  const nr = queryRamps(g, x, z, x, z);
  for (let k = 0; k < nr; k++) {
    const rp = world.ramps[g.outRamps[k]];
    if (!insideObb(rp, x, z)) continue;
    const dx = x - rp.cx; const dz = z - rp.cz;
    const lz = dx * rp.sin + dz * rp.cos;
    out.push(rp.y0 + (rp.y1 - rp.y0) * ((lz + rp.hz) / (2 * rp.hz)));
  }
  out.sort((a, b) => a - b);
}

/** Czy kapsuła przejdzie z (ax,ah,az) do (bx,bh,bz) bez skoku (próbkowanie co EDGE_STEP). */
function edgeWalkable(world, ax, ah, az, bx, bh, bz) {
  const P = CONFIG.player;
  const maxClimb = CONFIG.nav.maxClimb;
  const r = P.radius + EDGE_MARGIN;
  const dx = bx - ax; const dz = bz - az;
  const len = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(len / EDGE_STEP));
  let h = ah;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = ax + dx * t; const z = az + dz * t;
    const gh = groundHeight(world, x, z, h, P.radius);
    if (Math.abs(gh - h) > maxClimb) return false;
    h = gh;
    if (blockedAt(world, x, z, h, r)) return false;
  }
  return Math.abs(h - bh) < SUPPORT_EPS + 1e-6;
}

// ---------------------------------------------------------------------------------------------
// Budowa

/**
 * @param {object} world  World z mapgen.buildWorld
 * @returns {object} Nav (PLAN §8.1) + pola wewnętrzne (siatka komórek, bufory A*)
 */
export function buildNav(world) {
  const C = CONFIG.nav;
  const P = CONFIG.player;
  const cell = C.cell;
  const b = world.bounds;
  const cols = Math.max(1, Math.floor((b.maxX - b.minX) / cell));
  const rows = Math.max(1, Math.floor((b.maxZ - b.minZ) / cell));

  // 1) węzły
  const xs = []; const ys = []; const zs = []; const cellOf = [];
  const perCell = new Array(cols * rows);
  const cand = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = b.minX + (c + 0.5) * cell;
      const z = b.minZ + (r + 0.5) * cell;
      surfaceCandidates(world, x, z, cand);
      let lastH = -Infinity;
      for (const h of cand) {
        if (h - lastH < SUPPORT_EPS) continue; // duplikat poziomu
        if (Math.abs(groundHeight(world, x, z, h, P.radius) - h) > SUPPORT_EPS) continue;
        if (blockedAt(world, x, z, h, C.clearance)) continue;
        lastH = h;
        const id = xs.length;
        xs.push(x); ys.push(h); zs.push(z); cellOf.push(r * cols + c);
        (perCell[r * cols + c] ||= []).push(id);
      }
    }
  }
  const count = xs.length;

  // 2) krawędzie (CSR)
  const dirs = C.linkDiagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const edgeStart = new Int32Array(count + 1);
  const eList = []; const cList = [];
  for (let i = 0; i < count; i++) {
    edgeStart[i] = eList.length;
    const ci = cellOf[i] % cols; const ri = (cellOf[i] / cols) | 0;
    for (const [dc, dr] of dirs) {
      const c2 = ci + dc; const r2 = ri + dr;
      if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows) continue;
      const list = perCell[r2 * cols + c2];
      if (!list) continue;
      for (const j of list) {
        // szybkie odrzucenie: różnica wysokości większa niż stopień + najbardziej strome dopuszczalne nachylenie
        if (Math.abs(ys[j] - ys[i]) > C.maxClimb + P.maxSlopeY * Math.hypot(dc, dr) * cell) continue;
        if (!edgeWalkable(world, xs[i], ys[i], zs[i], xs[j], ys[j], zs[j])) continue;
        eList.push(j);
        cList.push(Math.hypot(xs[j] - xs[i], ys[j] - ys[i], zs[j] - zs[i]));
      }
    }
  }
  edgeStart[count] = eList.length;

  // 2b) przycięcie do węzłów osiągalnych ze spawnów (bez spawnów: największa spójna składowa) —
  //     usuwa np. topy ścian/osłon, na które nie da się wejść bez skoku
  const pr = pruneUnreachable(world, count, xs, ys, zs, edgeStart, eList, cList);
  return finishNav(world, pr, cellOf, cols, rows, cell);
}

function pruneUnreachable(world, count, xs, ys, zs, edgeStart, eList, cList) {
  const comp = new Int32Array(count).fill(-1);
  const sizes = [];
  const stack = [];
  for (let s = 0; s < count; s++) {
    if (comp[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    comp[s] = id; stack.push(s);
    while (stack.length) {
      const c = stack.pop(); n++;
      for (let j = edgeStart[c]; j < edgeStart[c + 1]; j++) {
        const b = eList[j];
        if (comp[b] < 0) { comp[b] = id; stack.push(b); }
      }
    }
    sizes.push(n);
  }
  const keepComp = new Uint8Array(sizes.length);
  let anySpawn = false;
  for (const sp of world.spawns || []) {
    let best = -1; let bd = Infinity;
    for (let i = 0; i < count; i++) {
      const dy = ys[i] - sp.y;
      if (Math.abs(dy) >= SAME_LEVEL_DY) continue;
      const d = (xs[i] - sp.x) ** 2 + (zs[i] - sp.z) ** 2 + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { keepComp[comp[best]] = 1; anySpawn = true; }
  }
  if (!anySpawn && sizes.length) {
    let m = 0;
    for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[m]) m = k;
    keepComp[m] = 1;
  }
  const remap = new Int32Array(count).fill(-1);
  const keep = [];
  for (let i = 0; i < count; i++) if (keepComp[comp[i]]) { remap[i] = keep.length; keep.push(i); }
  const n2 = keep.length;
  const es2 = new Int32Array(n2 + 1);
  const e2 = []; const c2 = [];
  for (let k = 0; k < n2; k++) {
    const i = keep[k];
    es2[k] = e2.length;
    for (let j = edgeStart[i]; j < edgeStart[i + 1]; j++) {
      const t = remap[eList[j]];
      if (t >= 0) { e2.push(t); c2.push(cList[j]); }
    }
  }
  es2[n2] = e2.length;
  return {
    keep, count: n2,
    xs: keep.map((i) => xs[i]), ys: keep.map((i) => ys[i]), zs: keep.map((i) => zs[i]),
    edgeStart: es2, eList: e2, cList: c2,
  };
}

function finishNav(world, pr, cellOfRaw, cols, rows, cell) {
  const P = CONFIG.player;
  const b = world.bounds;
  const { count, xs, ys, zs, edgeStart, eList, cList } = pr;
  const cellOf = pr.keep.map((i) => cellOfRaw[i]);
  const perCell = new Array(cols * rows);
  for (let i = 0; i < count; i++) (perCell[cellOf[i]] ||= []).push(i);

  // 3) osłony: bryła o y1 ≥ h + COVER_HEIGHT w odległości ≤ COVER_DIST
  const cover = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const g = world.grid;
    const n = querySolids(g, xs[i] - COVER_DIST, zs[i] - COVER_DIST, xs[i] + COVER_DIST, zs[i] + COVER_DIST);
    for (let k = 0; k < n; k++) {
      const s = world.solids[g.outSolids[k]];
      if (s.boundary || s.y1 < ys[i] + COVER_HEIGHT || s.y0 > ys[i] + P.stepHeight) continue;
      if (circleDist2(s, xs[i], zs[i]) <= COVER_DIST * COVER_DIST) { cover[i] = 1; break; }
    }
  }

  // 4) indeks komórek (CSR) do nearestNode / smoothPath
  const cellStart = new Int32Array(cols * rows + 1);
  for (let k = 0; k < cols * rows; k++) cellStart[k + 1] = cellStart[k] + (perCell[k] ? perCell[k].length : 0);
  const cellNodes = new Int32Array(count);
  for (let k = 0; k < cols * rows; k++) if (perCell[k]) cellNodes.set(perCell[k], cellStart[k]);

  return {
    count,
    x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
    edgeStart, edges: Int32Array.from(eList), cost: Float32Array.from(cList),
    cover,
    // wewnętrzne
    world,
    cell, cols, rows, minX: b.minX, minZ: b.minZ, cellStart, cellNodes,
    // bufory A* (indeksowany kopiec binarny)
    aG: new Float64Array(count), aF: new Float64Array(count), aParent: new Int32Array(count),
    aSeen: new Uint32Array(count), aClosed: new Uint32Array(count), aStamp: 0,
    heap: new Int32Array(count), heapPos: new Int32Array(count), heapSize: 0,
    tmpPath: new Int32Array(count),
  };
}

// ---------------------------------------------------------------------------------------------
// Scratch (bez alokacji)

const Q = new Float64Array(8);     // argumenty: [x, y, z, ...]
const BOXQ = new Float64Array(4);  // AABB zapytań SpatialGrid
const SEG = new Float64Array(6);   // odcinek 2D: [ax, az, bx, bz, h, r]

/**
 * Odcinek 2D SEG vs bryły blokujące na poziomie stóp SEG[4], prostokąty poszerzone o SEG[5] (Minkowski, zachowawczo).
 * true = wolne. Bez alokacji.
 */
function segFree(world) {
  const ax = SEG[0]; const az = SEG[1]; const bx = SEG[2]; const bz = SEG[3];
  const h = SEG[4]; const r = SEG[5];
  const P = CONFIG.player;
  const lo = h + P.stepHeight;
  const hi = h + P.height;
  BOXQ[0] = (ax < bx ? ax : bx) - r; BOXQ[1] = (az < bz ? az : bz) - r;
  BOXQ[2] = (ax > bx ? ax : bx) + r; BOXQ[3] = (az > bz ? az : bz) + r;
  const g = world.grid;
  const n = querySolidsBox(g, BOXQ);
  const out = g.outSolids;
  const solids = world.solids;
  const dx = bx - ax; const dz = bz - az;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (!(s.y1 > lo && s.y0 < hi)) continue;
    const c = s.cos; const sn = s.sin;
    const rx = ax - s.cx; const rz = az - s.cz;
    const ox = rx * c - rz * sn; const oz = rx * sn + rz * c;
    const ldx = dx * c - dz * sn; const ldz = dx * sn + dz * c;
    const hx = s.hx + r; const hz = s.hz + r;
    let t0 = 0; let t1 = 1;
    if (ldx > -1e-12 && ldx < 1e-12) { if (ox < -hx || ox > hx) continue; } else {
      let u = (-hx - ox) / ldx; let v = (hx - ox) / ldx;
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
      if (t0 > t1) continue;
    }
    if (ldz > -1e-12 && ldz < 1e-12) { if (oz < -hz || oz > hz) continue; } else {
      let u = (-hz - oz) / ldz; let v = (hz - oz) / ldz;
      if (u > v) { const w = u; u = v; v = w; }
      if (u > t0) t0 = u; if (v < t1) t1 = v;
      if (t0 > t1) continue;
    }
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Zapytania

/** Szuka w kwadracie komórek o promieniu ring wokół Q[0..2]; zapisuje najlepszy do Q[3] (idx), Q[4] (d²), Q[5] (idx z wolną linią), Q[6] (d²). */
function scanNear(nav, ring) {
  const x = Q[0]; const y = Q[1]; const z = Q[2];
  const cell = nav.cell;
  let c0 = Math.floor((x - nav.minX) / cell) - ring;
  let r0 = Math.floor((z - nav.minZ) / cell) - ring;
  let c1 = c0 + 2 * ring;
  let r1 = r0 + 2 * ring;
  if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
  if (c1 >= nav.cols) c1 = nav.cols - 1; if (r1 >= nav.rows) r1 = nav.rows - 1;
  const nx = nav.x; const ny = nav.y; const nz = nav.z;
  const r = CONFIG.player.radius;
  let best = -1; let bestD = Infinity; let bestC = -1; let bestCD = Infinity;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) {
      const k = rr * nav.cols + cc;
      for (let j = nav.cellStart[k], e = nav.cellStart[k + 1]; j < e; j++) {
        const i = nav.cellNodes[j];
        const dy = ny[i] - y;
        if (dy >= SAME_LEVEL_DY || dy <= -SAME_LEVEL_DY) continue;
        const ddx = nx[i] - x; const ddz = nz[i] - z;
        const d2 = ddx * ddx + ddz * ddz + dy * dy;
        if (d2 < bestD) { bestD = d2; best = i; }
        if (d2 < bestCD) {
          SEG[0] = x; SEG[1] = z; SEG[2] = nx[i]; SEG[3] = nz[i]; SEG[4] = ny[i]; SEG[5] = r * 0.5;
          if (segFree(nav.world)) { bestCD = d2; bestC = i; }
        }
      }
    }
  }
  Q[3] = best; Q[4] = bestD; Q[5] = bestC; Q[6] = bestCD;
}

/**
 * Najbliższy węzeł na tym samym poziomie (|dy| < 1 m), z preferencją węzła z wolną linią przejścia.
 * Zwraca indeks lub -1. Bez alokacji.
 */
export function nearestNode(nav, x, y, z) {
  if (nav.count === 0) return -1;
  Q[0] = x; Q[1] = y; Q[2] = z;
  scanNear(nav, NEAR_RING);
  if (Q[5] >= 0) return Q[5] | 0;
  const near = Q[3];
  scanNear(nav, NEAR_RING * 3);
  if (Q[5] >= 0) return Q[5] | 0;
  if (Q[3] >= 0) return Q[3] | 0;
  if (near >= 0) return near | 0;
  // ostatecznie: przegląd całości
  scanNear(nav, nav.cols > nav.rows ? nav.cols : nav.rows);
  return Q[5] >= 0 ? Q[5] | 0 : Q[3] | 0;
}

/** Losowy węzeł (rng z core/rng.js). Bez alokacji. */
export function randomNode(nav, rng) {
  if (nav.count === 0) return -1;
  const i = Math.floor(rng.next() * nav.count);
  return i >= nav.count ? nav.count - 1 : i;
}

// --- indeksowany kopiec binarny po aF (min)
function heapUp(nav, pos) {
  const heap = nav.heap; const hp = nav.heapPos; const f = nav.aF;
  const node = heap[pos];
  const fv = f[node];
  while (pos > 0) {
    const par = (pos - 1) >> 1;
    const pn = heap[par];
    if (f[pn] <= fv) break;
    heap[pos] = pn; hp[pn] = pos;
    pos = par;
  }
  heap[pos] = node; hp[node] = pos;
}

function heapDown(nav, pos) {
  const heap = nav.heap; const hp = nav.heapPos; const f = nav.aF;
  const size = nav.heapSize;
  const node = heap[pos];
  const fv = f[node];
  for (;;) {
    const l = pos * 2 + 1;
    if (l >= size) break;
    const rgt = l + 1;
    const m = rgt < size && f[heap[rgt]] < f[heap[l]] ? rgt : l;
    if (f[heap[m]] >= fv) break;
    heap[pos] = heap[m]; hp[heap[pos]] = pos;
    pos = m;
  }
  heap[pos] = node; hp[node] = pos;
}

function heapPop(nav) {
  const heap = nav.heap;
  const top = heap[0];
  nav.heapSize--;
  if (nav.heapSize > 0) {
    heap[0] = heap[nav.heapSize];
    nav.heapPos[heap[0]] = 0;
    heapDown(nav, 0);
  }
  return top;
}

/**
 * A* od węzła from do to. Ścieżka (indeksy węzłów, od from do to włącznie) → outPath. Zwraca długość (0 = brak).
 * Gdy outPath jest krótszy niż ścieżka — zapisuje jej początek (outPath.length węzłów).
 * Bez alokacji (bufory w nav).
 */
export function findPath(nav, from, to, outPath) {
  const count = nav.count;
  if (from < 0 || to < 0 || from >= count || to >= count || outPath.length === 0) return 0;
  if (from === to) { outPath[0] = from; return 1; }
  nav.aStamp = (nav.aStamp + 1) >>> 0;
  if (nav.aStamp === 0) { nav.aSeen.fill(0); nav.aClosed.fill(0); nav.aStamp = 1; }
  const st = nav.aStamp;
  const seen = nav.aSeen; const closed = nav.aClosed;
  const G = nav.aG; const F = nav.aF; const par = nav.aParent;
  const X = nav.x; const Y = nav.y; const Z = nav.z;
  const es = nav.edgeStart; const ed = nav.edges; const ec = nav.cost;
  const tx = X[to]; const ty = Y[to]; const tz = Z[to];

  seen[from] = st;
  G[from] = 0;
  {
    const dx = X[from] - tx; const dy = Y[from] - ty; const dz = Z[from] - tz;
    F[from] = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  par[from] = -1;
  nav.heap[0] = from; nav.heapPos[from] = 0; nav.heapSize = 1;

  let found = false;
  while (nav.heapSize > 0) {
    const cur = heapPop(nav);
    if (cur === to) { found = true; break; }
    closed[cur] = st;
    const gc = G[cur];
    for (let j = es[cur], e = es[cur + 1]; j < e; j++) {
      const nb = ed[j];
      if (closed[nb] === st) continue;
      const ng = gc + ec[j];
      if (seen[nb] === st) {
        if (ng >= G[nb]) continue;
        F[nb] -= G[nb] - ng;
        G[nb] = ng;
        par[nb] = cur;
        heapUp(nav, nav.heapPos[nb]);
      } else {
        seen[nb] = st;
        G[nb] = ng;
        const dx = X[nb] - tx; const dy = Y[nb] - ty; const dz = Z[nb] - tz;
        F[nb] = ng + Math.sqrt(dx * dx + dy * dy + dz * dz);
        par[nb] = cur;
        const pos = nav.heapSize++;
        nav.heap[pos] = nb; nav.heapPos[nb] = pos;
        heapUp(nav, pos);
      }
    }
  }
  if (!found) return 0;
  // odtworzenie (od końca) i zapis od początku
  const tmp = nav.tmpPath;
  let n = 0;
  for (let k = to; k !== -1; k = par[k]) tmp[n++] = k;
  const cap = outPath.length;
  const len = n < cap ? n : cap;
  for (let i = 0; i < len; i++) outPath[i] = tmp[n - 1 - i];
  return len;
}

/** Czy korytarz A→B (płaski, wysokość h) jest pokryty węzłami: w każdej próbce komórka ma węzeł na wysokości h. */
function corridorCovered(nav) {
  const ax = SEG[0]; const az = SEG[1]; const bx = SEG[2]; const bz = SEG[3]; const h = SEG[4];
  const dx = bx - ax; const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.ceil(len / SMOOTH_SAMPLE);
  const cell = nav.cell;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const c = Math.floor((ax + dx * t - nav.minX) / cell);
    const r = Math.floor((az + dz * t - nav.minZ) / cell);
    if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return false;
    const k = r * nav.cols + c;
    let ok = false;
    for (let j = nav.cellStart[k], e = nav.cellStart[k + 1]; j < e; j++) {
      const d = nav.y[nav.cellNodes[j]] - h;
      if (d < FLAT_DY && d > -FLAT_DY) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

/** Czy można iść prosto z węzła a do b (ten sam płaski poziom, wolny korytarz kapsuły). */
function straightOk(nav, a, b) {
  const ha = nav.y[a];
  const d = nav.y[b] - ha;
  if (d >= FLAT_DY || d <= -FLAT_DY) return false;
  SEG[0] = nav.x[a]; SEG[1] = nav.z[a]; SEG[2] = nav.x[b]; SEG[3] = nav.z[b]; SEG[4] = ha;
  SEG[5] = CONFIG.player.radius + SMOOTH_MARGIN;
  if (!segFree(nav.world)) return false;
  return corridorCovered(nav);
}

/**
 * String pulling w miejscu: usuwa węzły pośrednie, gdy można iść prosto (płaskie odcinki, wolny korytarz
 * kapsuły pokryty węzłami; odcinki z różnicą wysokości — rampy, stopnie — zostają). Zwraca nową długość. Bez alokacji.
 */
export function smoothPath(nav, path, len) {
  if (len <= 2) return len;
  let out = 1;
  let anchor = path[0];
  for (let k = 2; k < len; k++) {
    const prev = path[k - 1];
    // każdy węzeł pomiędzy anchor a k musi być na tym samym poziomie (płasko)
    const d = nav.y[prev] - nav.y[anchor];
    if (d >= FLAT_DY || d <= -FLAT_DY || !straightOk(nav, anchor, path[k])) {
      path[out++] = prev;
      anchor = prev;
    }
  }
  path[out++] = path[len - 1];
  return out;
}
