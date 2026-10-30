// Fizyka postaci i raycast (PLAN §3). Czysty JS, bez three, bez alokacji w funkcjach publicznych
// (argumenty i wyniki pośrednie w prealokowanych Float64Array na poziomie modułu).
//
// Model: postać = pionowy walec (radius, height), body.y = stopy. Bryły = OBB w XZ (obrót wokół Y) × [y0, y1].
// Konwencja obrotu jak w mapgen.js: lx = dx*cos - dz*sin, lz = dx*sin + dz*cos; świat: (lx*cos + lz*sin, -lx*sin + lz*cos).
//
// Rampy: powierzchnia wznosi się liniowo wzdłuż lokalnego +Z (y0 przy -hz, y1 przy +hz); bryła rampy = klin od y=0
// do powierzchni (blokuje z boku, gdy powierzchnia w punkcie styku jest wyżej niż stopy + stepHeight).

import { CONFIG } from '../config.js';
import { querySolidsBox, queryRampsBox, nextStamp } from './mapgen.js';

const EPS = 1e-9;
const MAX_SUBSTEPS = 32;          // twardy limit podkroków przy ogromnym dt
const SUBSTEP_FRACTION = 0.5;     // maks. przesunięcie poziome na podkrok = radius * SUBSTEP_FRACTION

// --- Zero alokacji a V8: double zapisany do `let` modułu albo przekazany jako świeży argument / wynik
// nie-inline'owanej funkcji jest pakowany w HeapNumber (alokacja). Dlatego gorąca ścieżka przekazuje liczby
// wyłącznie przez prealokowane Float64Array (poniżej), a funkcje wewnętrzne dostają tylko referencje i małe int-y.
// Publiczne funkcje z PLAN §3 to cienkie nakładki: zapisują argumenty do scratch i wołają wersję wewnętrzną.

// AABB zapytania SpatialGrid: [minX, minZ, maxX, maxZ]
const BOX = new Float64Array(4);
// koło zapytania: [x, z, r]
const CIRC = new Float64Array(3);
const CI_X = 0;
const CI_Z = 1;
const CI_R = 2;
// wynik kolizji koło vs OBB: [nx, nz, depth]
const COL = new Float64Array(3);
const C_NX = 0;
const C_NZ = 1;
const C_DEPTH = 2;
// wyniki pomocnicze: [ground, ceiling]
const OUT = new Float64Array(2);
const O_GROUND = 0;
const O_CEIL = 1;

/** Ustawia CIRC i BOX (AABB koła). */
function setCircle(x, z, r) {
  CIRC[CI_X] = x; CIRC[CI_Z] = z; CIRC[CI_R] = r;
  BOX[0] = x - r; BOX[1] = z - r; BOX[2] = x + r; BOX[3] = z + r;
}

/** Jak setCircle, ale z pól body (bez przekazywania doubli). */
function setCircleBody(body) {
  const x = body.x;
  const z = body.z;
  const r = body.radius;
  CIRC[CI_X] = x; CIRC[CI_Z] = z; CIRC[CI_R] = r;
  BOX[0] = x - r; BOX[1] = z - r; BOX[2] = x + r; BOX[3] = z + r;
}

/**
 * Koło CIRC vs OBB o (hx,hz w lokalnym XZ). Gdy się przecinają → true, normalna wypychania (świat) i głębokość w COL.
 * Wspólne dla brył i ramp (oba mają cx,cz,hx,hz,cos,sin).
 */
function circleObb(o) {
  const r = CIRC[CI_R];
  const dx = CIRC[CI_X] - o.cx;
  const dz = CIRC[CI_Z] - o.cz;
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

/** Czy koło CIRC nachodzi na OBB o (bez liczenia normalnej). */
function circleOverlaps(o) {
  const r = CIRC[CI_R];
  const dx = CIRC[CI_X] - o.cx;
  const dz = CIRC[CI_Z] - o.cz;
  const lx = dx * o.cos - dz * o.sin;
  const lz = dx * o.sin + dz * o.cos;
  const qx = lx < -o.hx ? -o.hx : lx > o.hx ? o.hx : lx;
  const qz = lz < -o.hz ? -o.hz : lz > o.hz ? o.hz : lz;
  const ex = lx - qx;
  const ez = lz - qz;
  return ex * ex + ez * ez < r * r;
}

/**
 * Wewnętrzne groundHeight: koło z CIRC/BOX (ustawione wcześniej), feet z feetSrc[feetIdx]. Wynik → OUT[O_GROUND].
 * Rampa liczy się, gdy środek koła leży w jej obrysie (wysokość liniowa wzdłuż lokalnego Z).
 */
function groundInternal(world, feetSrc, feetIdx) {
  const limit = feetSrc[feetIdx] + CONFIG.player.stepHeight;
  const g = world.grid;
  const solids = world.solids;
  let best = 0;
  const n = querySolidsBox(g, BOX);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (s.y1 > limit || s.y1 <= best) continue;
    if (circleOverlaps(s)) best = s.y1;
  }
  const ramps = world.ramps;
  if (ramps.length > 0) {
    const nr = queryRampsBox(g, BOX);
    const outR = g.outRamps;
    const x = CIRC[CI_X];
    const z = CIRC[CI_Z];
    for (let k = 0; k < nr; k++) {
      const rp = ramps[outR[k]];
      const dx = x - rp.cx;
      const dz = z - rp.cz;
      const lx = dx * rp.cos - dz * rp.sin;
      const lz = dx * rp.sin + dz * rp.cos;
      if (lx < -rp.hx || lx > rp.hx || lz < -rp.hz || lz > rp.hz) continue;
      const h = rp.y0 + (rp.y1 - rp.y0) * ((lz + rp.hz) / (2 * rp.hz));
      if (h <= limit && h > best) best = h;
    }
  }
  OUT[O_GROUND] = best;
}

// argumenty nakładki groundHeight: [feetY]
const GARG = new Float64Array(1);

/**
 * Najwyższa powierzchnia pod kołem (x,z,radius), nie wyższa niż feetY + stepHeight: podłoga 0, top bryły, rampa.
 * Bez alokacji (nakładka nad groundInternal).
 */
export function groundHeight(world, x, z, feetY, radius) {
  setCircle(x, z, radius);
  GARG[0] = feetY;
  groundInternal(world, GARG, 0);
  return OUT[O_GROUND];
}

/** Przesunięcie wzdłuż normalnej z COL + usunięcie składowej prędkości w głąb przeszkody. */
function pushOut(body) {
  const nx = COL[C_NX];
  const nz = COL[C_NZ];
  const dd = COL[C_DEPTH] + CONFIG.physics.skin;
  body.x += nx * dd;
  body.z += nz * dd;
  const vn = body.vx * nx + body.vz * nz;
  if (vn < 0) { body.vx -= vn * nx; body.vz -= vn * nz; }
}

/**
 * Jedno przejście kolizji poziomych z bryłami/rampami blokującymi w paśmie [feet+step, feet+height].
 * push=true → wypycha (sekwencyjnie) i zwraca, czy była jakakolwiek penetracja; push=false → tylko wykrywa.
 */
function horizontalPass(world, body, push) {
  const P = CONFIG.player;
  const g = world.grid;
  const solids = world.solids;
  const ramps = world.ramps;
  const feet = body.y;
  const lo = feet + P.stepHeight;
  const hi = feet + body.height;
  let any = false;
  setCircleBody(body);
  const n = querySolidsBox(g, BOX);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (!(s.y1 > lo && s.y0 < hi)) continue;
    if (!circleObb(s)) continue;
    any = true;
    if (!push) return true;
    pushOut(body);
    setCircleBody(body);
  }
  if (ramps.length > 0) {
    const nr = queryRampsBox(g, BOX);
    const outR = g.outRamps;
    for (let k = 0; k < nr; k++) {
      const rp = ramps[outR[k]];
      if (!circleObb(rp)) continue;
      // wysokość powierzchni w najbliższym punkcie obrysu (lz przycięte do zakresu)
      const dx = body.x - rp.cx;
      const dz = body.z - rp.cz;
      let t = ((dx * rp.sin + dz * rp.cos) + rp.hz) / (2 * rp.hz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const hSurf = rp.y0 + (rp.y1 - rp.y0) * t;
      if (hSurf <= lo) continue;
      // klin od 0 do powierzchni: blokuje, gdy postać nie jest całkiem nad powierzchnią
      any = true;
      if (!push) return true;
      pushOut(body);
      setCircleBody(body);
    }
  }
  return any;
}

/**
 * Wypchnięcie poziome (do CONFIG.physics.maxIterations przejść). Zwraca true, gdy końcowa pozycja jest wolna
 * od penetracji; false, gdy wypchnięcia się nie zbiegły (np. szczelina węższa niż 2·radius — przeciwne ściany).
 */
function resolveHorizontal(world, body) {
  const iters = CONFIG.physics.maxIterations;
  for (let it = 0; it < iters; it++) {
    if (!horizontalPass(world, body, true)) return true;
  }
  return !horizontalPass(world, body, false);
}

/** Granice areny. */
function clampBounds(world, body) {
  const b = world.bounds;
  const r = body.radius;
  if (body.x < b.minX + r) { body.x = b.minX + r; if (body.vx < 0) body.vx = 0; }
  if (body.x > b.maxX - r) { body.x = b.maxX - r; if (body.vx > 0) body.vx = 0; }
  if (body.z < b.minZ + r) { body.z = b.minZ + r; if (body.vz < 0) body.vz = 0; }
  if (body.z > b.maxZ - r) { body.z = b.maxZ - r; if (body.vz > 0) body.vz = 0; }
}

/**
 * Przesunięcie poziome o (vx, vz)·sdt z rozwiązaniem kolizji. Gdy pełny ruch nie daje się rozwiązać bez penetracji
 * (przeciwległe ściany), próbuje ruchu tylko wzdłuż X, potem tylko wzdłuż Z; w ostateczności zostaje w poprzedniej
 * (poprawnej) pozycji. Dzięki temu szczeliny < 2·radius są nieprzechodnie. Argument sdt czytany z MB[1].
 */
function moveHorizontal(world, body) {
  const sdt = MB[1];
  const px = body.x;
  const pz = body.z;
  const vx = body.vx;
  const vz = body.vz;
  body.x = px + vx * sdt;
  body.z = pz + vz * sdt;
  if (!resolveHorizontal(world, body)) {
    let ok = false;
    if (vx !== 0) {
      body.x = px + vx * sdt; body.z = pz; body.vx = vx; body.vz = vz;
      if (resolveHorizontal(world, body)) { body.vz = 0; ok = true; }
    }
    if (!ok && vz !== 0) {
      body.x = px; body.z = pz + vz * sdt; body.vx = vx; body.vz = vz;
      if (resolveHorizontal(world, body)) { body.vx = 0; ok = true; }
    }
    if (!ok) {
      body.x = px; body.z = pz;
      body.vx = 0; body.vz = 0;
      // pozycja startowa też w penetracji (np. teleport w bryłę) — wypchnij najlepiej, jak się da
      resolveHorizontal(world, body);
    }
  }
  clampBounds(world, body);
}

/**
 * Najniższy spód bryły nad głową (bryły nachodzące na koło CIRC, których y0 > feet + step), min z world.ceiling.
 * Wynik → OUT[O_CEIL]. Wymaga wcześniejszego setCircleBody(body).
 */
function ceilingInternal(world, body) {
  const g = world.grid;
  const solids = world.solids;
  const lo = body.y + CONFIG.player.stepHeight;
  let best = world.ceiling;
  const n = querySolidsBox(g, BOX);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (s.y0 <= lo || s.y0 >= best) continue;
    if (circleOverlaps(s)) best = s.y0;
  }
  OUT[O_CEIL] = best;
}

// stan kroku moveBody: [feetQuery, sdt]
const MB = new Float64Array(2);

/**
 * Krok fizyki postaci: grawitacja, integracja (podkroki — brak tunelowania), kolizje poziome, stopnie, rampy,
 * sufit, granice areny. Ustawia body.onGround. Bez alokacji.
 */
export function moveBody(world, body, dt) {
  if (!(dt > 0)) return;
  const P = CONFIG.player;
  const PH = CONFIG.physics;
  body.vy -= P.gravity * dt;

  const avx = body.vx < 0 ? -body.vx : body.vx;
  const avz = body.vz < 0 ? -body.vz : body.vz;
  const maxMove = (avx > avz ? avx : avz) * dt;
  let n = Math.ceil(maxMove / (body.radius * SUBSTEP_FRACTION));
  if (n < 1) n = 1;
  if (n > MAX_SUBSTEPS) n = MAX_SUBSTEPS;
  const sdt = dt / n;

  let grounded = body.onGround;
  for (let i = 0; i < n; i++) {
    // poziomo
    MB[1] = sdt;
    moveHorizontal(world, body);

    // pionowo (resolveHorizontal mogło przesunąć — odśwież koło zapytania)
    setCircleBody(body);
    ceilingInternal(world, body);
    const ceil = OUT[O_CEIL];
    const prevY = body.y;
    body.y += body.vy * sdt;
    const newY = body.y;
    MB[0] = prevY > newY ? prevY : newY;
    groundInternal(world, MB, 0);
    const ground = OUT[O_GROUND];
    if (newY <= ground) {
      body.y = ground;
      if (body.vy <= 0) { body.vy = 0; grounded = true; } else grounded = false;
    } else if (grounded && body.vy <= 0 && newY - ground <= PH.groundSnap) {
      body.y = ground;
      body.vy = 0;
    } else {
      grounded = false;
    }
    if (body.y + body.height > ceil) {
      const yc = ceil - body.height;
      body.y = yc < ground ? ground : yc;
      if (body.vy > 0) body.vy = 0;
    }
  }
  body.onGround = grounded;
}

// ---------------------------------------------------------------------------------------------
// Raycast

// argumenty promienia: [ox, oy, oz, dx, dy, dz, maxDist]
const RI = new Float64Array(7);
// stan raycastu: [best, nx, ny, nz, index, found]
const RAY = new Float64Array(6);
const R_BEST = 0;
const R_NX = 1;
const R_NY = 2;
const R_NZ = 3;
const R_IDX = 4;
const R_FOUND = 5;

function setFloorCeilHit(ny) {
  RAY[R_FOUND] = 1;
  RAY[R_IDX] = -1;
  RAY[R_NX] = 0;
  RAY[R_NY] = ny;
  RAY[R_NZ] = 0;
}

/** Promień RI (d jednostkowy) vs OBB bryły (slab w lokalnym układzie). Aktualizuje RAY, gdy bliżej. */
function rayObb(s, idx) {
  const ox = RI[0]; const oy = RI[1]; const oz = RI[2];
  const dx = RI[3]; const dy = RI[4]; const dz = RI[5];
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

// półprzestrzenie klina rampy w układzie lokalnym: n·p ≤ d; [nx, ny, nz] (d liczone per rampa)
const WEDGE_N = new Float64Array([1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, -1, 0, -1, 0, 0, 1, 0]);
// scratch klina: d per płaszczyzna (6) + pochylenie k
const WEDGE_D = new Float64Array(7);

/**
 * Promień RI vs pełny klin rampy (wypukły: slab X, slab Z, y ≥ 0, y ≤ y0 + (lz+hz)·k) — Cyrus–Beck.
 * Start wewnątrz klina → ignoruj (jak dla brył). Indeks trafienia = -2 - indeks rampy.
 */
function rayRamp(rp, idx) {
  const ox = RI[0]; const oy = RI[1]; const oz = RI[2];
  const dx = RI[3]; const dy = RI[4]; const dz = RI[5];
  const rx = ox - rp.cx;
  const rz = oz - rp.cz;
  const c = rp.cos;
  const sn = rp.sin;
  const lox = rx * c - rz * sn;
  const loz = rx * sn + rz * c;
  const ldx = dx * c - dz * sn;
  const ldz = dx * sn + dz * c;
  const k = (rp.y1 - rp.y0) / (2 * rp.hz);
  WEDGE_D[0] = rp.hx; WEDGE_D[1] = rp.hx; WEDGE_D[2] = rp.hz; WEDGE_D[3] = rp.hz; WEDGE_D[4] = 0;
  WEDGE_D[5] = rp.y0 + rp.hz * k;
  let tIn = -Infinity;
  let tOut = Infinity;
  let plane = -1;
  for (let p = 0; p < 6; p++) {
    const nx = WEDGE_N[p * 3];
    const ny = WEDGE_N[p * 3 + 1];
    const nz = p === 5 ? -k : WEDGE_N[p * 3 + 2];
    const denom = nx * ldx + ny * dy + nz * ldz;
    const num = WEDGE_D[p] - (nx * lox + ny * oy + nz * loz);
    if (denom > -EPS && denom < EPS) {
      if (num < 0) return;
      continue;
    }
    const t = num / denom;
    if (denom < 0) { if (t > tIn) { tIn = t; plane = p; } } else if (t < tOut) tOut = t;
  }
  if (tIn > tOut || tIn < 0 || tIn >= RAY[R_BEST] || plane < 0) return;
  let nlx = WEDGE_N[plane * 3];
  let nly = WEDGE_N[plane * 3 + 1];
  let nlz = plane === 5 ? -k : WEDGE_N[plane * 3 + 2];
  if (plane === 5) {
    const inv = 1 / Math.sqrt(1 + k * k);
    nly *= inv; nlz *= inv;
  }
  RAY[R_BEST] = tIn;
  RAY[R_IDX] = -2 - idx;
  RAY[R_FOUND] = 1;
  RAY[R_NX] = nlx * c + nlz * sn;
  RAY[R_NY] = nly;
  RAY[R_NZ] = -nlx * sn + nlz * c;
}

/** Czy punkt PT leży w bryle (OBB × [y0,y1], brzegi włącznie). Bez alokacji. */
const PT = new Float64Array(3);
function pointInSolid(world) {
  const x = PT[0]; const y = PT[1]; const z = PT[2];
  BOX[0] = x; BOX[1] = z; BOX[2] = x; BOX[3] = z;
  const g = world.grid;
  const solids = world.solids;
  const n = querySolidsBox(g, BOX);
  const out = g.outSolids;
  for (let k = 0; k < n; k++) {
    const s = solids[out[k]];
    if (y < s.y0 || y > s.y1) continue;
    const dx = x - s.cx;
    const dz = z - s.cz;
    const lx = dx * s.cos - dz * s.sin;
    const lz = dx * s.sin + dz * s.cos;
    if (lx >= -s.hx && lx <= s.hx && lz >= -s.hz && lz <= s.hz) return true;
  }
  return false;
}

/**
 * Promień od (ox,oy,oz) w kierunku (dx,dy,dz) (normalizowany wewnętrznie) do maxDist.
 * Bryły (slab OBB), rampy (powierzchnia), podłoga y=0, sufit world.ceiling. DDA po kubełkach SpatialGrid.
 * outHit = { hit, dist, x, y, z, nx, ny, nz, index } — index bryły, -1 podłoga/sufit, ≤ -2 rampa (-2 - i).
 * Bez alokacji.
 */
export function raycastWorld(world, ox, oy, oz, dx, dy, dz, maxDist, outHit) {
  RI[0] = ox; RI[1] = oy; RI[2] = oz; RI[3] = dx; RI[4] = dy; RI[5] = dz; RI[6] = maxDist;
  return raycastInternal(world, outHit);
}

/** Wewnętrzny raycast: argumenty w RI (kierunek normalizowany tutaj, w miejscu). */
function raycastInternal(world, outHit) {
  outHit.hit = false;
  const ox = RI[0];
  const oy = RI[1];
  const oz = RI[2];
  let dx = RI[3];
  let dy = RI[4];
  let dz = RI[5];
  const maxDist = RI[6];
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < EPS || !(maxDist > 0)) return false;
  dx /= len; dy /= len; dz /= len;
  RI[3] = dx; RI[4] = dy; RI[5] = dz;
  RAY[R_BEST] = maxDist;
  RAY[R_FOUND] = 0;
  RAY[R_IDX] = -1;

  // podłoga / sufit
  if (dy < -EPS && oy >= 0) {
    const t = -oy / dy;
    if (t < RAY[R_BEST]) { RAY[R_BEST] = t; setFloorCeilHit(1); }
  } else if (dy > EPS && oy <= world.ceiling) {
    const t = (world.ceiling - oy) / dy;
    if (t < RAY[R_BEST]) { RAY[R_BEST] = t; setFloorCeilHit(-1); }
  }

  // DDA po kubełkach w XZ
  const g = world.grid;
  const solids = world.solids;
  const ramps = world.ramps;
  const st = nextStamp(g);
  const sStamp = g.solidStamp;
  const rStamp = g.rampStamp;
  const cs = g.cell;
  let col = Math.floor((ox - g.minX) * g.inv);
  let row = Math.floor((oz - g.minZ) * g.inv);
  col = col < 0 ? 0 : col >= g.cols ? g.cols - 1 : col;
  row = row < 0 ? 0 : row >= g.rows ? g.rows - 1 : row;
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
      rayObb(solids[i], i);
    }
    for (let j = g.rampStart[kCell], e = g.rampStart[kCell + 1]; j < e; j++) {
      const i = g.rampItems[j];
      if (rStamp[i] === st) continue;
      rStamp[i] = st;
      rayRamp(ramps[i], i);
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

/**
 * Linia wzroku A→B (true = nic nie przesłania). Symetryczna: odcinek, którego którykolwiek koniec leży w bryle,
 * jest zasłonięty (A w bryle → false wprost; B w bryle → promień z A trafia w tę bryłę). Bez alokacji.
 */
export function segmentClear(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  PT[0] = ax; PT[1] = ay; PT[2] = az;
  if (pointInSolid(world)) return false;
  RI[0] = ax; RI[1] = ay; RI[2] = az; RI[3] = dx; RI[4] = dy; RI[5] = dz; RI[6] = len - 1e-4;
  return !raycastInternal(world, segHit);
}

export function createHit() {
  return { hit: false, dist: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, index: -1 };
}
