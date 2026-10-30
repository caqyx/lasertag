// Fizyka postaci i raycast (PLAN §3). Czysty JS, bez three, bez alokacji w funkcjach publicznych
// (wyniki pośrednie w zmiennych modułu).
//
// Model: postać = pionowy walec (radius, height), body.y = stopy. Bryły = OBB w XZ (obrót wokół Y) × [y0, y1].
// Konwencja obrotu jak w mapgen.js: lx = dx*cos - dz*sin, lz = dx*sin + dz*cos; świat: (lx*cos + lz*sin, -lx*sin + lz*cos).
//
// Rampy: powierzchnia wznosi się liniowo wzdłuż lokalnego +Z (y0 przy -hz, y1 przy +hz); bryła rampy = klin od y=0
// do powierzchni (blokuje z boku, gdy powierzchnia w punkcie styku jest wyżej niż stopy + stepHeight).

import { CONFIG } from '../config.js';
import { querySolids, queryRamps, nextStamp, cellCol, cellRow } from './mapgen.js';

const EPS = 1e-9;
const MAX_SUBSTEPS = 32;          // twardy limit podkroków przy ogromnym dt
const SUBSTEP_FRACTION = 0.5;     // maks. przesunięcie poziome na podkrok = radius * SUBSTEP_FRACTION

// --- scratch (Float64Array zamiast `let` na poziomie modułu: zapis double do slotu kontekstu alokuje HeapNumber w V8)
// wynik kolizji koło vs OBB: [nx, nz, depth]
const COL = new Float64Array(3);
const C_NX = 0;
const C_NZ = 1;
const C_DEPTH = 2;

/**
 * Koło (x,z,r) vs OBB (hx,hz w lokalnym XZ). Gdy się przecinają → true, normalna wypychania (świat) i głębokość w COL.
 * Wspólne dla brył i ramp (oba mają cx,cz,hx,hz,cos,sin).
 */
function circleObb(o, x, z, r) {
  const dx = x - o.cx;
  const dz = z - o.cz;
  const c = o.cos;
  const s = o.sin;
  const lx = dx * c - dz * s;
  const lz = dx * s + dz * c;
  const hx = o.hx;
  const hz = o.hz;
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  const ex = lx - qx;
  const ez = lz - qz;
  const d2 = ex * ex + ez * ez;
  if (d2 >= r * r) return false;
  let nlx;
  let nlz;
  if (d2 > EPS) {
    const dd = Math.sqrt(d2);
    nlx = ex / dd;
    nlz = ez / dd;
    COL[C_DEPTH] = r - dd;
  } else {
    // środek wewnątrz prostokąta: wypchnij najkrótszą drogą
    const px = hx - Math.abs(lx);
    const pz = hz - Math.abs(lz);
    if (px < pz) { nlx = lx >= 0 ? 1 : -1; nlz = 0; COL[C_DEPTH] = px + r; } else { nlx = 0; nlz = lz >= 0 ? 1 : -1; COL[C_DEPTH] = pz + r; }
  }
  COL[C_NX] = nlx * c + nlz * s;
  COL[C_NZ] = -nlx * s + nlz * c;
  return true;
}

/** Czy koło nachodzi na OBB (bez liczenia normalnej). */
function circleOverlaps(o, x, z, r) {
  const dx = x - o.cx;
  const dz = z - o.cz;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  const qx = lx < -o.hx ? -o.hx : lx > o.hx ? o.hx : lx;
  const qz = lz < -o.hz ? -o.hz : lz > o.hz ? o.hz : lz;
  const ex = lx - qx;
  const ez = lz - qz;
  return ex * ex + ez * ez < r * r;
}

/** Wysokość powierzchni rampy w punkcie lokalnym lz (przycięta do zakresu). */
function rampHeightAtLocalZ(rp, lz) {
  const t = (lz + rp.hz) / (2 * rp.hz);
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  return rp.y0 + (rp.y1 - rp.y0) * tc;
}

/** Wysokość rampy w punkcie świata, gdy punkt leży w jej obrysie; inaczej -Infinity. */
function rampHeightAt(rp, x, z) {
  const dx = x - rp.cx;
  const dz = z - rp.cz;
  const lx = dx * rp.cos - dz * rp.sin;
  const lz = dx * rp.sin + dz * rp.cos;
  if (lx < -rp.hx || lx > rp.hx || lz < -rp.hz || lz > rp.hz) return -Infinity;
  return rampHeightAtLocalZ(rp, lz);
}

/**
 * Najwyższa powierzchnia pod kołem (x,z,radius), nie wyższa niż feetY + stepHeight: podłoga 0, top bryły, rampa.
 * Bez alokacji.
 */
export function groundHeight(world, x, z, feetY, radius) {
  const limit = feetY + CONFIG.player.stepHeight;
  const g = world.grid;
  const solids = world.solids;
  let best = 0;
  const n = querySolids(g, x - radius, z - radius, x + radius, z + radius);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (s.y1 > limit || s.y1 <= best) continue;
    if (circleOverlaps(s, x, z, radius)) best = s.y1;
  }
  const nr = queryRamps(g, x, z, x, z);
  const ramps = world.ramps;
  const outR = g.outRamps;
  for (let k = 0; k < nr; k++) {
    const h = rampHeightAt(ramps[outR[k]], x, z);
    if (h <= limit && h > best) best = h;
  }
  return best;
}

/** Przesunięcie wzdłuż normalnej z COL + usunięcie składowej prędkości w głąb przeszkody. */
function pushOut(body, skin) {
  const nx = COL[C_NX];
  const nz = COL[C_NZ];
  const dd = COL[C_DEPTH] + skin;
  body.x += nx * dd;
  body.z += nz * dd;
  const vn = body.vx * nx + body.vz * nz;
  if (vn < 0) { body.vx -= vn * nx; body.vz -= vn * nz; }
}

/** Wypchnięcie poziome z brył/ramp blokujących w paśmie [feet+step, feet+height]. */
function resolveHorizontal(world, body) {
  const P = CONFIG.player;
  const PH = CONFIG.physics;
  const g = world.grid;
  const solids = world.solids;
  const ramps = world.ramps;
  const r = body.radius;
  const skin = PH.skin;
  for (let it = 0; it < PH.maxIterations; it++) {
    const feet = body.y;
    const lo = feet + P.stepHeight;
    const hi = feet + body.height;
    let any = false;
    const n = querySolids(g, body.x - r, body.z - r, body.x + r, body.z + r);
    const out = g.outSolids;
    for (let k = 0; k < n; k++) {
      const s = solids[out[k]];
      if (!(s.y1 > lo && s.y0 < hi)) continue;
      if (!circleObb(s, body.x, body.z, r)) continue;
      pushOut(body, skin);
      any = true;
    }
    const nr = queryRamps(g, body.x - r, body.z - r, body.x + r, body.z + r);
    const outR = g.outRamps;
    for (let k = 0; k < nr; k++) {
      const rp = ramps[outR[k]];
      if (!circleObb(rp, body.x, body.z, r)) continue;
      // wysokość powierzchni w najbliższym punkcie obrysu
      const dx = body.x - rp.cx;
      const dz = body.z - rp.cz;
      const lz = dx * rp.sin + dz * rp.cos;
      const hSurf = rampHeightAtLocalZ(rp, lz);
      if (hSurf <= lo) continue;
      // klin od 0 do powierzchni: blokuje, gdy postać nie jest całkiem nad powierzchnią
      pushOut(body, skin);
      any = true;
    }
    if (!any) break;
  }
  const b = world.bounds;
  if (body.x < b.minX + r) { body.x = b.minX + r; if (body.vx < 0) body.vx = 0; }
  if (body.x > b.maxX - r) { body.x = b.maxX - r; if (body.vx > 0) body.vx = 0; }
  if (body.z < b.minZ + r) { body.z = b.minZ + r; if (body.vz < 0) body.vz = 0; }
  if (body.z > b.maxZ - r) { body.z = b.maxZ - r; if (body.vz > 0) body.vz = 0; }
}

/** Najniższy spód bryły nad głową (bryły nachodzące na koło, których y0 > feet + step), min z world.ceiling. */
function ceilingAbove(world, body) {
  const g = world.grid;
  const solids = world.solids;
  const r = body.radius;
  const lo = body.y + CONFIG.player.stepHeight;
  let best = world.ceiling;
  const n = querySolids(g, body.x - r, body.z - r, body.x + r, body.z + r);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (s.y0 <= lo || s.y0 >= best) continue;
    if (circleOverlaps(s, body.x, body.z, r)) best = s.y0;
  }
  return best;
}

/**
 * Krok fizyki postaci: grawitacja, integracja (podkroki — brak tunelowania), kolizje poziome, stopnie, rampy,
 * sufit, granice areny. Ustawia body.onGround. Bez alokacji.
 */
export function moveBody(world, body, dt) {
  if (!(dt > 0)) return;
  const P = CONFIG.player;
  const PH = CONFIG.physics;
  body.vy -= P.gravity * dt;

  const maxMove = Math.max(Math.abs(body.vx), Math.abs(body.vz)) * dt;
  let n = Math.ceil(maxMove / (body.radius * SUBSTEP_FRACTION));
  if (n < 1) n = 1;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  const sdt = dt / n;

  let grounded = body.onGround;
  for (let i = 0; i < n; i++) {
    // poziomo
    body.x += body.vx * sdt;
    body.z += body.vz * sdt;
    resolveHorizontal(world, body);

    // pionowo
    const ceil = ceilingAbove(world, body);
    const prevY = body.y;
    body.y += body.vy * sdt;
    const ground = groundHeight(world, body.x, body.z, prevY > body.y ? prevY : body.y, body.radius);
    if (body.y <= ground) {
      body.y = ground;
      if (body.vy <= 0) { body.vy = 0; grounded = true; } else grounded = false;
    } else if (grounded && body.vy <= 0 && body.y - ground <= PH.groundSnap) {
      body.y = ground;
      body.vy = 0;
    } else {
      grounded = false;
    }
    if (body.y + body.height > ceil) {
      body.y = ceil - body.height;
      if (body.y < ground) body.y = ground;
      if (body.vy > 0) body.vy = 0;
    }
  }
  body.onGround = grounded;
}

// ---------------------------------------------------------------------------------------------
// Raycast

// stan raycastu: [best, nx, ny, nz, index, found]
const RAY = new Float64Array(6);
const R_BEST = 0;
const R_NX = 1;
const R_NY = 2;
const R_NZ = 3;
const R_IDX = 4;
const R_FOUND = 5;

function setFloorCeilHit(t, ny) {
  RAY[R_BEST] = t;
  RAY[R_FOUND] = 1;
  RAY[R_IDX] = -1;
  RAY[R_NX] = 0;
  RAY[R_NY] = ny;
  RAY[R_NZ] = 0;
}

/** Promień (o, d — d jednostkowy) vs OBB bryły (slab w lokalnym układzie). Aktualizuje RAY, gdy bliżej. */
function rayObb(s, idx, ox, oy, oz, dx, dy, dz) {
  const rx = ox - s.cx;
  const rz = oz - s.cz;
  const c = s.cos;
  const sn = s.sin;
  const lox = rx * c - rz * sn;
  const loz = rx * sn + rz * c;
  const ldx = dx * c - dz * sn;
  const ldz = dx * sn + dz * c;
  let tmin = -Infinity;
  let tmax = Infinity;
  let axis = -1;
  let sign = 0;
  // X
  if (ldx > -EPS && ldx < EPS) {
    if (lox < -s.hx || lox > s.hx) return;
  } else {
    let t1 = (-s.hx - lox) / ldx;
    let t2 = (s.hx - lox) / ldx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = ldx > 0 ? -1 : 1; }
    if (t2 < tmax) tmax = t2;
  }
  // Y
  if (dy > -EPS && dy < EPS) {
    if (oy < s.y0 || oy > s.y1) return;
  } else {
    let t1 = (s.y0 - oy) / dy;
    let t2 = (s.y1 - oy) / dy;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = dy > 0 ? -1 : 1; }
    if (t2 < tmax) tmax = t2;
  }
  // Z
  if (ldz > -EPS && ldz < EPS) {
    if (loz < -s.hz || loz > s.hz) return;
  } else {
    let t1 = (-s.hz - loz) / ldz;
    let t2 = (s.hz - loz) / ldz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = ldz > 0 ? -1 : 1; }
    if (t2 < tmax) tmax = t2;
  }
  if (tmax < tmin || tmin < 0 || tmin >= RAY[R_BEST]) return; // tmin < 0: start wewnątrz bryły → ignoruj
  RAY[R_BEST] = tmin;
  RAY[R_IDX] = idx;
  RAY[R_FOUND] = 1;
  if (axis === 0) { RAY[R_NX] = sign * c; RAY[R_NY] = 0; RAY[R_NZ] = -sign * sn; }
  else if (axis === 1) { RAY[R_NX] = 0; RAY[R_NY] = sign; RAY[R_NZ] = 0; }
  else { RAY[R_NX] = sign * sn; RAY[R_NY] = 0; RAY[R_NZ] = sign * c; }
}

/** Promień vs górna powierzchnia rampy (płaszczyzna w obrysie). Indeks trafienia = -2 - indeks rampy. */
function rayRamp(rp, idx, ox, oy, oz, dx, dy, dz) {
  const rx = ox - rp.cx;
  const rz = oz - rp.cz;
  const c = rp.cos;
  const sn = rp.sin;
  const lox = rx * c - rz * sn;
  const loz = rx * sn + rz * c;
  const ldx = dx * c - dz * sn;
  const ldz = dx * sn + dz * c;
  const k = (rp.y1 - rp.y0) / (2 * rp.hz);
  const denom = dy - ldz * k;
  if (denom > -EPS && denom < EPS) return;
  const t = (rp.y0 + (loz + rp.hz) * k - oy) / denom;
  if (t < 0 || t >= RAY[R_BEST]) return;
  const lx = lox + ldx * t;
  const lz = loz + ldz * t;
  if (lx < -rp.hx || lx > rp.hx || lz < -rp.hz || lz > rp.hz) return;
  // normalna lokalna (0, 1, -k) znormalizowana, zwrócona przeciw promieniowi
  const inv = 1 / Math.sqrt(1 + k * k);
  let ny = inv;
  let nlz = -k * inv;
  if (dy * ny + ldz * nlz > 0) { ny = -ny; nlz = -nlz; }
  RAY[R_BEST] = t;
  RAY[R_IDX] = -2 - idx;
  RAY[R_FOUND] = 1;
  RAY[R_NX] = nlz * sn;
  RAY[R_NY] = ny;
  RAY[R_NZ] = nlz * c;
}

/**
 * Promień od (ox,oy,oz) w kierunku (dx,dy,dz) (normalizowany wewnętrznie) do maxDist.
 * Bryły (slab OBB), rampy (powierzchnia), podłoga y=0, sufit world.ceiling. DDA po kubełkach SpatialGrid.
 * outHit = { hit, dist, x, y, z, nx, ny, nz, index } — index bryły, -1 podłoga/sufit, ≤ -2 rampa (-2 - i).
 * Bez alokacji.
 */
export function raycastWorld(world, ox, oy, oz, dx, dy, dz, maxDist, outHit) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  outHit.hit = false;
  if (len < EPS || !(maxDist > 0)) return false;
  dx /= len; dy /= len; dz /= len;
  RAY[R_BEST] = maxDist;
  RAY[R_FOUND] = 0;
  RAY[R_IDX] = -1;

  // podłoga / sufit
  if (dy < -EPS && oy >= 0) {
    const t = -oy / dy;
    if (t < RAY[R_BEST]) setFloorCeilHit(t, 1);
  } else if (dy > EPS && oy <= world.ceiling) {
    const t = (world.ceiling - oy) / dy;
    if (t < RAY[R_BEST]) setFloorCeilHit(t, -1);
  }

  // DDA po kubełkach w XZ
  const g = world.grid;
  const solids = world.solids;
  const ramps = world.ramps;
  const st = nextStamp(g);
  const sStamp = g.solidStamp;
  const rStamp = g.rampStamp;
  const cs = g.cell;
  let col = cellCol(g, ox);
  let row = cellRow(g, oz);
  const stepC = dx > 0 ? 1 : -1;
  const stepR = dz > 0 ? 1 : -1;
  const adx = dx < 0 ? -dx : dx;
  const adz = dz < 0 ? -dz : dz;
  const tDeltaX = adx > EPS ? cs / adx : Infinity;
  const tDeltaZ = adz > EPS ? cs / adz : Infinity;
  let tMaxX = Infinity;
  let tMaxZ = Infinity;
  if (adx > EPS) {
    const edge = g.minX + (dx > 0 ? col + 1 : col) * cs;
    tMaxX = (edge - ox) / dx;
    if (tMaxX < 0) tMaxX = 0;
  }
  if (adz > EPS) {
    const edge = g.minZ + (dz > 0 ? row + 1 : row) * cs;
    tMaxZ = (edge - oz) / dz;
    if (tMaxZ < 0) tMaxZ = 0;
  }
  let tEnter = 0;
  for (let guard = 0; guard < 4096; guard++) {
    const kCell = row * g.cols + col;
    for (let j = g.solidStart[kCell], e = g.solidStart[kCell + 1]; j < e; j++) {
      const i = g.solidItems[j];
      if (sStamp[i] === st) continue;
      sStamp[i] = st;
      rayObb(solids[i], i, ox, oy, oz, dx, dy, dz);
    }
    for (let j = g.rampStart[kCell], e = g.rampStart[kCell + 1]; j < e; j++) {
      const i = g.rampItems[j];
      if (rStamp[i] === st) continue;
      rStamp[i] = st;
      rayRamp(ramps[i], i, ox, oy, oz, dx, dy, dz);
    }
    // przejście do następnego kubełka
    if (tMaxX < tMaxZ) {
      tEnter = tMaxX;
      tMaxX += tDeltaX;
      col += stepC;
      if (col < 0 || col >= g.cols) break;
    } else {
      tEnter = tMaxZ;
      tMaxZ += tDeltaZ;
      row += stepR;
      if (row < 0 || row >= g.rows) break;
    }
    if (tEnter > RAY[R_BEST] || tEnter === Infinity) break;
  }

  if (RAY[R_FOUND] === 0) return false;
  const best = RAY[R_BEST];
  outHit.hit = true;
  outHit.dist = best;
  outHit.x = ox + dx * best;
  outHit.y = oy + dy * best;
  outHit.z = oz + dz * best;
  outHit.nx = RAY[R_NX];
  outHit.ny = RAY[R_NY];
  outHit.nz = RAY[R_NZ];
  outHit.index = RAY[R_IDX];
  return true;
}

const segHit = createHit();

/** Linia wzroku A→B (true = nic nie przesłania). Bez alokacji. */
export function segmentClear(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  return !raycastWorld(world, ax, ay, az, dx, dy, dz, len - 1e-4, segHit);
}

export function createHit() {
  return { hit: false, dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, index: -1 };
}
