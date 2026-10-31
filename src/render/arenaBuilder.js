// Budowa areny z danych świata (PLAN §2/§5): bryły z farbą UV, neonowe listwy, podłoga z odbiciem planarnym,
// sufit z kratownicą i lampami, gumowe odboje/listwy przypodłogowe, panele baz przy spawnach, stożki światła (High/Ultra).
// Geometria scalona per materiał → kilka draw calli na całą mapę.
//
// buildArena(world, preset, textures, opts?) → {
//   group, dispose(), update(time),
//   renderReflection(renderer, scene, camera),  // High/Ultra: odbicie podłogi (wołać przed composerem; no-op gdy brak)
//   setSize(w, h),                              // rozmiar bufora rysowania (px) — dla odbicia
// }
//   opts.renderer — gdy podany i preset.envReflections: envMap podłogi z PMREMGenerator.fromScene (raz, przy budowie).
//
// Konwencja obrotu brył (jak Object3D.rotation.y = rot):
//   world.x = cx + lx·cos + lz·sin,   world.z = cz − lx·sin + lz·cos   (cos = cos(rot), sin = sin(rot))
//
// Kolory: 'accent' palety (limonka) NIE trafia na listwy ani światła — tylko drobne elementy farby (SPEC §6 p.10).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { PAINT_STYLES, SIGN_CELLS } from './textures.js';
import { createRng } from '../core/rng.js';

const A = CONFIG.render.arena;
const TX = CONFIG.render.textures;

/** warstwa obiektów pomijanych w renderze odbicia (podłoga, dym, stożki) */
export const LAYER_NO_REFLECT = 1;

const MAIN_KEYS = ['primary', 'secondary', 'uv'];

// ---------------------------------------------------------------- bufor geometrii

class GeoBuf {
  constructor({ color = false, uv = true, wall = false } = {}) {
    this.pos = []; this.nrm = []; this.uv = uv ? [] : null; this.col = color ? [] : null; this.idx = [];
    this.wall = wall ? { uv1: [], pa: [], pb: [], wash: [], w: [] } : null;
    // stan bieżącej bryły (dla wall): kolory farby A/B, kolor poświaty, top, y listwy dolnej
    this.cur = { pa: [0, 0, 0], pb: [0, 0, 0], wash: [0, 0, 0], top: 0, bot: -1 };
  }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (this.uv) this.uv.push(u, v);
    if (this.col) this.col.push(r, g, b);
  }
  // wierzchołek ściany: + metry wzdłuż ściany (along), długość ściany (len), uv1 (sklejka)
  wvert(x, y, z, nx, ny, nz, u, v, along, len, u1, v1) {
    this.vert(x, y, z, nx, ny, nz, u, v);
    const w = this.wall, c = this.cur;
    w.uv1.push(u1, v1);
    w.pa.push(c.pa[0], c.pa[1], c.pa[2]);
    w.pb.push(c.pb[0], c.pb[1], c.pb[2]);
    w.wash.push(c.wash[0], c.wash[1], c.wash[2]);
    w.w.push(along, len, c.top, c.bot);
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  toGeometry() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.wall) {
      g.setAttribute('uv1', new THREE.Float32BufferAttribute(this.wall.uv1, 2));
      g.setAttribute('aPaintA', new THREE.Float32BufferAttribute(this.wall.pa, 3));
      g.setAttribute('aPaintB', new THREE.Float32BufferAttribute(this.wall.pb, 3));
      g.setAttribute('aWash', new THREE.Float32BufferAttribute(this.wall.wash, 3));
      g.setAttribute('aWall', new THREE.Float32BufferAttribute(this.wall.w, 4));
    }
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// prostopadłościan wzdłuż odcinka a→b, przekrój tw (poziomo) × th (pion); kolor per wierzchołek (HDR)
const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _u = new THREE.Vector3(), _up = new THREE.Vector3();
const _c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const BAR_FACES = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [3, 2, 1, 0], [4, 5, 6, 7]];
function addBar(buf, ax, ay, az, bx, by, bz, tw, th, r = 1, g = 1, b = 1) {
  _d.set(bx - ax, by - ay, bz - az).normalize();
  _up.set(0, 1, 0);
  if (Math.abs(_d.y) > 0.9) _up.set(1, 0, 0);
  _s.crossVectors(_d, _up).normalize().multiplyScalar(tw / 2);
  _u.crossVectors(_s, _d).normalize().multiplyScalar(th / 2);
  for (let e = 0; e < 2; e++) {
    const px = e ? bx : ax, py = e ? by : ay, pz = e ? bz : az;
    _c[e * 4 + 0].set(px - _s.x - _u.x, py - _s.y - _u.y, pz - _s.z - _u.z);
    _c[e * 4 + 1].set(px + _s.x - _u.x, py + _s.y - _u.y, pz + _s.z - _u.z);
    _c[e * 4 + 2].set(px + _s.x + _u.x, py + _s.y + _u.y, pz + _s.z + _u.z);
    _c[e * 4 + 3].set(px - _s.x + _u.x, py - _s.y + _u.y, pz - _s.z + _u.z);
  }
  for (const f of BAR_FACES) {
    const p0 = _c[f[0]], p1 = _c[f[1]], p2 = _c[f[2]];
    const nx = (p1.y - p0.y) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.y - p0.y);
    const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
    const nz = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    // kolejność rogów w BAR_FACES daje normalną do środka → odwracamy (ściany zewnętrzne = front)
    const nl = -(Math.hypot(nx, ny, nz) || 1);
    const i0 = buf.count;
    for (let k = 0; k < 4; k++) {
      const p = _c[f[k]];
      buf.vert(p.x, p.y, p.z, nx / nl, ny / nl, nz / nl, k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0, r, g, b);
    }
    buf.quad(i0, i0 + 3, i0 + 2, i0 + 1);
  }
}

// ---------------------------------------------------------------- bryły

function toWorld(s, lx, lz, out) {
  out[0] = s.cx + lx * s.cos + lz * s.sin;
  out[1] = s.cz - lx * s.sin + lz * s.cos;
  return out;
}
const _wa = [0, 0], _wb = [0, 0];

// Ściana pionowa prostokąta: rogi lokalne (l0 → l1), wysokość y0..y1, normalna lokalna (nlx, nlz).
// u w metrach wzdłuż ściany (rośnie w prawo patrząc z zewnątrz), v = y (metry) → skala do kafla farby.
function addSide(buf, s, lx0, lz0, lx1, lz1, nlx, nlz, y0, y1, uOff, tileW, tileH, mirror = false) {
  toWorld(s, lx0, lz0, _wa); toWorld(s, lx1, lz1, _wb);
  const nx = nlx * s.cos + nlz * s.sin, nz = -nlx * s.sin + nlz * s.cos;
  const len = Math.hypot(lx1 - lx0, lz1 - lz0);
  // mirror: farba odbita w poziomie (ta sama tekstura wygląda inaczej na sąsiednich ścianach)
  const u0 = (mirror ? uOff + len : uOff) / tileW, u1 = (mirror ? uOff : uOff + len) / tileW;
  const P = TX.wallMeters;
  const p0 = uOff / P, p1 = (uOff + len) / P;
  const i = buf.count;
  buf.wvert(_wa[0], y0, _wa[1], nx, 0, nz, u0, y0 / tileH, 0, len, p0, y0 / P);
  buf.wvert(_wb[0], y0, _wb[1], nx, 0, nz, u1, y0 / tileH, len, len, p1, y0 / P);
  buf.wvert(_wb[0], y1, _wb[1], nx, 0, nz, u1, y1 / tileH, len, len, p1, y1 / P);
  buf.wvert(_wa[0], y1, _wa[1], nx, 0, nz, u0, y1 / tileH, 0, len, p0, y1 / P);
  buf.quad(i, i + 1, i + 2, i + 3);
}

function addCap(buf, s, y, up) {
  const i = buf.count;
  const ny = up ? 1 : -1;
  const corners = up ? [[-1, 1], [1, 1], [1, -1], [-1, -1]] : [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [ix, iz] of corners) {
    toWorld(s, ix * s.hx, iz * s.hz, _wa);
    // along/len = 1/2 → brak podświetlenia krawędzi; top = y → równomierna, słaba poświata
    buf.wvert(_wa[0], y, _wa[1], 0, ny, 0, 0, 0, 1, 2, _wa[0] / TX.wallMeters, _wa[1] / TX.wallMeters);
  }
  buf.quad(i, i + 1, i + 2, i + 3);
}

function addSolid(paintBuf, plainBuf, s, rng) {
  const uScale = A.wallUScale[0] + (A.wallUScale[1] - A.wallUScale[0]) * rng();
  const tileW = s.boundary ? TX.paintMeters[0] * A.boundaryPaintScale : TX.paintMeters[0] * uScale;
  const tileH = s.boundary ? TX.paintMeters[1] * A.boundaryPaintScale : TX.paintMeters[1];
  const { hx, hz, y0, y1 } = s;
  const base = rng() * tileW * 4;
  const off = [base, base + 2 * hz + rng() * tileW, base + rng() * tileW * 2, base + rng() * tileW * 3];
  addSide(paintBuf, s, hx, hz, hx, -hz, 1, 0, y0, y1, off[0], tileW, tileH, rng() < 0.5);
  addSide(paintBuf, s, -hx, -hz, -hx, hz, -1, 0, y0, y1, off[1], tileW, tileH, rng() < 0.5);
  addSide(paintBuf, s, -hx, hz, hx, hz, 0, 1, y0, y1, off[2], tileW, tileH, rng() < 0.5);
  addSide(paintBuf, s, hx, -hz, -hx, -hz, 0, -1, y0, y1, off[3], tileW, tileH, rng() < 0.5);
  const w = plainBuf.cur.wash, sw = A.capWash;
  const saved = [w[0], w[1], w[2]];
  w[0] *= sw; w[1] *= sw; w[2] *= sw;
  plainBuf.cur.top = y1;
  addCap(plainBuf, s, y1, true);
  if (y0 > 0.001) addCap(plainBuf, s, y0, false);
  w[0] = saved[0]; w[1] = saved[1]; w[2] = saved[2];
}

// ---------------------------------------------------------------- listwy, odboje

// pętla wokół bryły na wysokości y: pręty o przekroju tw × th, odsunięte o off od ściany
function loop(buf, s, y, tw, th, off, col, ext = tw / 2) {
  const ex = s.hx + off, ez = s.hz + off;
  const edges = [[-ex, ez, ex, ez], [ex, -ez, -ex, -ez], [ex, ez, ex, -ez], [-ex, -ez, -ex, ez]];
  for (const e of edges) {
    toWorld(s, e[0], e[1], _wa); toWorld(s, e[2], e[3], _wb);
    const dx = _wb[0] - _wa[0], dz = _wb[1] - _wa[1], l = Math.hypot(dx, dz) || 1;
    const kx = dx / l * ext, kz = dz / l * ext;
    addBar(buf, _wa[0] - kx, y, _wa[1] - kz, _wb[0] + kx, y, _wb[1] + kz, tw, th, col.r, col.g, col.b);
  }
}

function trimLoop(buf, s, y, col) {
  const t = A.trimSize;
  loop(buf, s, y, t, t, t / 2 + A.trimGap, col);
}

// filar: tylko pionowe listwy na narożnikach (cieńsze) na całą wysokość + obrys u góry;
// u dołu zamknięte gumowym cokołem (rubberFor), u góry wchodzą w strop (bez „ramki" w połowie słupa)
function pillarTrims(buf, s, col) {
  const P = A.pillar;
  const t = A.trimSize * P.trimScale, o = t / 2 + A.trimGap;
  const y0 = s.y0 + A.rubber.baseHeight, top = s.y1 - P.topGap;
  for (const [ix, iz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    toWorld(s, ix * (s.hx + o * 0.5), iz * (s.hz + o * 0.5), _wa);
    addBar(buf, _wa[0], y0, _wa[1], _wa[0], top, _wa[1], t, t, col.r, col.g, col.b);
  }
  loop(buf, s, top - t / 2, t, t, o, col);
}

// strona bryły obwodowej zwrócona do środka areny: { longX, sign }
function innerSide(s, world) {
  const longX = s.hx >= s.hz;
  let best = 1, bestDot = -Infinity;
  for (const sign of [1, -1]) {
    const nlx = longX ? 0 : sign, nlz = longX ? sign : 0;
    const nx = nlx * s.cos + nlz * s.sin, nz = -nlx * s.sin + nlz * s.cos;
    const cx = (world.bounds.minX + world.bounds.maxX) / 2 - s.cx, cz = (world.bounds.minZ + world.bounds.maxZ) / 2 - s.cz;
    const dot = nx * cx + nz * cz;
    if (dot > bestDot) { bestDot = dot; best = sign; }
  }
  return { longX, sign: best };
}

function innerLine(buf, s, world, h, tw, th, off, col) {
  const { longX, sign } = innerSide(s, world);
  if (longX) { toWorld(s, -s.hx, sign * (s.hz + off), _wa); toWorld(s, s.hx, sign * (s.hz + off), _wb); }
  else { toWorld(s, sign * (s.hx + off), -s.hz, _wa); toWorld(s, sign * (s.hx + off), s.hz, _wb); }
  addBar(buf, _wa[0], h, _wa[1], _wb[0], h, _wb[1], tw, th, col.r, col.g, col.b);
}

function boundaryTrims(buf, s, col, world) {
  const t = A.trimSize;
  for (const h of A.boundaryTrimHeights) if (h <= s.y1 - t) innerLine(buf, s, world, h, t, t, t / 2 + A.trimGap, col);
}

// gumowe odboje: listwa przypodłogowa (pętla) + narożniki pionowe
// narożnik wolny = tuż za nim (wzdłuż obu ścian) nie ma innej bryły; przy łączeniu ścian odbój tworzyłby czarną szczelinę
function freeCorner(world, s, ix, iz) {
  const e = A.rubber.junctionProbe;
  for (const [px, pz] of [[ix * (s.hx + e), iz * (s.hz - e)], [ix * (s.hx - e), iz * (s.hz + e)], [ix * (s.hx + e), iz * (s.hz + e)]]) {
    toWorld(s, px, pz, _wb);
    for (const o of world.solids) {
      if (o === s || o.y0 > A.rubber.baseHeight || o.y1 < 1.0) continue;
      const dx = _wb[0] - o.cx, dz = _wb[1] - o.cz;
      const lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;
      if (Math.abs(lx) <= o.hx + e && Math.abs(lz) <= o.hz + e) return false;
    }
  }
  return true;
}

function rubberFor(buf, trimBuf, s, world, dim) {
  if (s.y0 > 0.001) return;
  const R = A.rubber;
  // przygaszona linia na listwie przypodłogowej (styk ściana/podłoga czytelny), gdy brak jasnej listwy dolnej
  const lineY = R.baseHeight + R.lineSize / 2;
  if (s.boundary) {
    innerLine(buf, s, world, R.baseHeight / 2, R.baseDepth, R.baseHeight, R.baseDepth / 2, WHITE);
    return;
  }
  loop(buf, s, R.baseHeight / 2, R.baseDepth, R.baseHeight, R.baseDepth / 2, WHITE, R.baseDepth / 2);
  if (dim && !s.trimBottom) loop(trimBuf, s, lineY, R.lineSize, R.lineSize, R.baseDepth - R.lineSize / 2, dim, R.lineSize / 2);
  if (s.kind === 'pillar') return;
  const top = s.y1 - A.trimSize - R.topGap;
  const o = R.cornerSize / 2 - R.cornerInset;
  for (const [ix, iz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    if (!freeCorner(world, s, ix, iz)) continue;
    toWorld(s, ix * (s.hx + o), iz * (s.hz + o), _wa);
    addBar(buf, _wa[0], R.baseHeight, _wa[1], _wa[0], top, _wa[1], R.cornerSize, R.cornerSize);
  }
}
const WHITE = { r: 1, g: 1, b: 1 };

// panel bazy drużyny na ścianie obwodowej za spawnem: ciemna płyta + rama w kolorze drużyny
function spawnPanel(rubberBuf, trimBuf, world, sp, frameColor, teamColor) {
  const bx = Math.sin(sp.yaw), bz = Math.cos(sp.yaw); // „za plecami" (przód = (−sin, −cos))
  const b = world.bounds;
  let px, pz, nx = 0, nz = 0;
  if (Math.abs(bx) > Math.abs(bz)) { px = bx > 0 ? b.maxX : b.minX; pz = sp.z; nx = bx > 0 ? -1 : 1; }
  else { pz = bz > 0 ? b.maxZ : b.minZ; px = sp.x; nz = bz > 0 ? -1 : 1; }
  // tył panelu: lico ściany obwodowej (najbliższa bryła boundary w tym kierunku)
  let face = null;
  for (const s of world.solids) {
    if (!s.boundary) continue;
    const { longX, sign } = innerSide(s, world);
    const lx = longX ? 0 : sign * s.hx, lz = longX ? sign * s.hz : 0;
    toWorld(s, lx, lz, _wa);
    const d = (_wa[0] - sp.x) * -nx + (_wa[1] - sp.z) * -nz;
    if (d > 0 && (face === null || d < face)) {
      // czy spawn mieści się w zasięgu tej ściany
      const along = nx !== 0 ? Math.abs(sp.z - s.cz) : Math.abs(sp.x - s.cx);
      if (along < Math.max(s.hx, s.hz)) face = d;
    }
  }
  if (face !== null) { px = sp.x - nx * face; pz = sp.z - nz * face; }
  const P = A.spawnPanel;
  const tx = -nz, tz = nx; // styczna do ściany
  const cx = px + nx * P.depth / 2, cz = pz + nz * P.depth / 2;
  addBar(rubberBuf, cx - tx * P.width / 2, P.y, cz - tz * P.width / 2, cx + tx * P.width / 2, P.y, cz + tz * P.width / 2,
    P.depth, P.height);
  const t = A.trimSize * A.spawnPanel.trimScale, fx = cx + nx * (P.depth / 2 + t / 2), fz = cz + nz * (P.depth / 2 + t / 2);
  const hw = P.width / 2, hh = P.height / 2;
  const c = frameColor;
  addBar(trimBuf, fx - tx * hw, P.y + hh, fz - tz * hw, fx + tx * hw, P.y + hh, fz + tz * hw, t, t, c.r, c.g, c.b);
  addBar(trimBuf, fx - tx * hw, P.y - hh, fz - tz * hw, fx + tx * hw, P.y - hh, fz + tz * hw, t, t, c.r, c.g, c.b);
  addBar(trimBuf, fx - tx * hw, P.y - hh, fz - tz * hw, fx - tx * hw, P.y + hh, fz - tz * hw, t, t, c.r, c.g, c.b);
  addBar(trimBuf, fx + tx * hw, P.y - hh, fz + tz * hw, fx + tx * hw, P.y + hh, fz + tz * hw, t, t, c.r, c.g, c.b);
  // znacznik drużyny: mały kwadrat w środku panelu (kolor drużyny tylko tu)
  const m = P.marker / 2, tcol = teamColor;
  addBar(trimBuf, fx - tx * m, P.y, fz - tz * m, fx + tx * m, P.y, fz + tz * m, t, P.marker, tcol.r, tcol.g, tcol.b);
}

// ---------------------------------------------------------------- stal (galerie, kładki, barierki, rampy)

/** bryła wyniesiona (platforma lub barierka na galerii) → wygląd stalowej konstrukcji zamiast ściany z farbą */
function isSteel(s) {
  return !s.boundary && s.y0 > A.steelMinY && (s.kind === 'platform' || s.kind === 'half' || s.kind === 'wall');
}

// prostopadłościan bryły do bufora stali; UV w metrach / kafel kratki (góra: x/z, boki: wzdłuż/wysokość)
const PLATE_U = 0.04, PLATE_V = 0.1;
function steelBox(buf, s) {
  const G = A.steel.tile;
  const sides = [
    [s.hx, s.hz, s.hx, -s.hz, 1, 0], [-s.hx, -s.hz, -s.hx, s.hz, -1, 0],
    [-s.hx, s.hz, s.hx, s.hz, 0, 1], [s.hx, -s.hz, -s.hx, -s.hz, 0, -1],
  ];
  for (const [lx0, lz0, lx1, lz1, nlx, nlz] of sides) {
    toWorld(s, lx0, lz0, _wa); toWorld(s, lx1, lz1, _wb);
    const nx = nlx * s.cos + nlz * s.sin, nz = -nlx * s.sin + nlz * s.cos;
    const len = Math.hypot(lx1 - lx0, lz1 - lz0);
    // boki = pełna blacha: UV w jednym punkcie otworu kratki (ciemna, gładka płyta zamiast kratki)
    const i = buf.count;
    buf.vert(_wa[0], s.y0, _wa[1], nx, 0, nz, PLATE_U, PLATE_V);
    buf.vert(_wb[0], s.y0, _wb[1], nx, 0, nz, PLATE_U, PLATE_V);
    buf.vert(_wb[0], s.y1, _wb[1], nx, 0, nz, PLATE_U, PLATE_V);
    buf.vert(_wa[0], s.y1, _wa[1], nx, 0, nz, PLATE_U, PLATE_V);
    buf.quad(i, i + 1, i + 2, i + 3);
  }
  for (const up of [true, false]) {
    const y = up ? s.y1 : s.y0, ny = up ? 1 : -1;
    const corners = up ? [[-1, 1], [1, 1], [1, -1], [-1, -1]] : [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const i = buf.count;
    for (const [ix, iz] of corners) {
      toWorld(s, ix * s.hx, iz * s.hz, _wa);
      buf.vert(_wa[0], y, _wa[1], 0, ny, 0, (ix * s.hx) / G, (iz * s.hz) / G);
    }
    buf.quad(i, i + 1, i + 2, i + 3);
  }
}

function addSteelSolid(steelBuf, beamBuf, trimBuf, railBuf, s, col, warnCol, dimCol) {
  const t = A.trimSize;
  if (s.kind !== 'platform') { addRail(steelBuf, trimBuf, railBuf, s, col, warnCol); return; }
  steelBox(steelBuf, s);
  {
    // krawędź galerii: listwa w kolorze przewodnim u góry, przygaszona u dołu, krótkie pasy ostrzegawcze na czołach
    loop(trimBuf, s, s.y1 - t / 2, t, t, t / 2 + A.trimGap, col);
    const PW = A.platformWarn;
    const edges = [[s.hx, 0, s.hz, 1, 0], [-s.hx, 0, s.hz, -1, 0], [0, s.hz, s.hx, 0, 1], [0, -s.hz, s.hx, 0, -1]];
    for (const [ox, oz, half, nlx, nlz] of edges) {
      for (let u = -half + PW.spacing / 2; u <= half - PW.length; u += PW.spacing) {
        const lx0 = nlx ? ox + nlx * (A.trimGap * 2) : u, lz0 = nlz ? oz + nlz * (A.trimGap * 2) : u;
        const lx1 = nlx ? lx0 : u + PW.length, lz1 = nlz ? lz0 : u + PW.length;
        toWorld(s, lx0, lz0, _wa); toWorld(s, nlx ? lx0 : lx1, nlz ? lz0 : lz1, _wb);
        // skośny pasek przez czoło platformy
        addBar(trimBuf, _wa[0], s.y0 + t * 1.2, _wa[1], _wb[0], s.y1 - t * 1.6, _wb[1], t * 0.5, t * 0.5,
          warnCol.r * PW.k, warnCol.g * PW.k, warnCol.b * PW.k);
      }
    }
    loop(trimBuf, s, s.y0 + t / 2, t * 0.6, t * 0.6, t * 0.3 + A.trimGap, dimCol, t * 0.3);
    // dźwigary pod spodem (poprzecznie do dłuższego boku), co A.steel.beamSpacing
    const longX = s.hx >= s.hz;
    const L = longX ? s.hx : s.hz, Wd = longX ? s.hz : s.hx;
    const B = A.steel.beam;
    for (let u = -L + B.spacing / 2; u <= L - B.spacing / 4; u += B.spacing) {
      if (longX) { toWorld(s, u, -Wd, _wa); toWorld(s, u, Wd, _wb); } else { toWorld(s, -Wd, u, _wa); toWorld(s, Wd, u, _wb); }
      addBar(beamBuf, _wa[0], s.y0 - B.depth / 2, _wa[1], _wb[0], s.y0 - B.depth / 2, _wb[1], B.width, B.depth);
    }
    // podłużnice po brzegach
    for (const side of [-1, 1]) {
      if (longX) { toWorld(s, -s.hx, side * (Wd - B.width), _wa); toWorld(s, s.hx, side * (Wd - B.width), _wb); }
      else { toWorld(s, side * (Wd - B.width), -s.hz, _wa); toWorld(s, side * (Wd - B.width), s.hz, _wb); }
      addBar(beamBuf, _wa[0], s.y0 - B.depth / 2, _wa[1], _wb[0], s.y0 - B.depth / 2, _wb[1], B.width, B.depth);
    }
  }
}

// tablice na licu ściany obwodowej: litera sektora w środku, znaki po bokach (komórki atlasu 4 × 2)
function addSigns(buf, s, world, idx) {
  const Sg = A.signs;
  const { longX, sign } = innerSide(s, world);
  const L = longX ? s.hx : s.hz;
  if (2 * L < Sg.size * 1.5) return;
  const off = (longX ? s.hz : s.hx) + A.trimGap * 2;
  const nlx = longX ? 0 : sign, nlz = longX ? sign : 0;
  const nx = nlx * s.cos + nlz * s.sin, nz = -nlx * s.sin + nlz * s.cos;
  const reactor = world.id === 'reactor';
  const cells = [[0.5, SIGN_CELLS.sector[idx % 4]]];
  if (2 * L > Sg.size * 4) {
    cells.push([0.2, reactor ? SIGN_CELLS.trefoil : SIGN_CELLS.number]);
    cells.push([0.8, reactor ? SIGN_CELLS.hazard : SIGN_CELLS.arrow]);
  }
  const h = Sg.size / 2;
  for (const [f, cell] of cells) {
    const u = -L + 2 * L * f;
    const cu = (cell % 4) / 4, cv = cell < 4 ? 0.5 : 0;
    // wierzchołki w lokalnym układzie: wzdłuż długiego boku, na licu wewnętrznym
    const pts = longX ? [[u - h, sign * off], [u + h, sign * off]] : [[sign * off, u - h], [sign * off, u + h]];
    toWorld(s, pts[0][0], pts[0][1], _wa); toWorld(s, pts[1][0], pts[1][1], _wb);
    // kolejność tak, by tekst nie był lustrzany patrząc od środka (prawo = kierunek zgodny z normalną × góra)
    const rx = nz, rz = -nx; // „prawo" patrząc na ścianę od środka areny (przód = −n)
    const flip = (_wb[0] - _wa[0]) * rx + (_wb[1] - _wa[1]) * rz < 0;
    const A0 = flip ? _wb : _wa, B0 = flip ? _wa : _wb;
    const y0 = Sg.y - h, y1 = Sg.y + h;
    const i = buf.count;
    buf.vert(A0[0], y0, A0[1], nx, 0, nz, cu, cv);
    buf.vert(B0[0], y0, B0[1], nx, 0, nz, cu + 0.25, cv);
    buf.vert(B0[0], y1, B0[1], nx, 0, nz, cu + 0.25, cv + 0.5);
    buf.vert(A0[0], y1, A0[1], nx, 0, nz, cu, cv + 0.5);
    buf.quad(i, i + 1, i + 2, i + 3);
  }
}

// podział bryły obwodowej wzdłuż dłuższego boku na panele ~A.boundaryPanel m (tylko wizual farby)
function splitPanels(s) {
  const longX = s.hx >= s.hz;
  const L = 2 * (longX ? s.hx : s.hz);
  const n = Math.max(1, Math.round(L / A.boundaryPanel));
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = -L / 2 + (i + 0.5) * (L / n);
    const lx = longX ? u : 0, lz = longX ? 0 : u;
    toWorld(s, lx, lz, _wa);
    out.push({ ...s, cx: _wa[0], cz: _wa[1], hx: longX ? L / n / 2 : s.hx, hz: longX ? s.hz : L / n / 2 });
  }
  return out;
}

// barierka ażurowa: niska blacha (cokół), słupki, pochwyt + poprzeczka, siatka (alphaTest); neon na pochwycie
function addRail(steelBuf, trimBuf, railBuf, s, col, warnCol) {
  const RL = A.rail;
  const kick = { ...s, y1: s.y0 + RL.kick };
  steelBox(steelBuf, kick);
  const longX = s.hx >= s.hz;
  const L = longX ? s.hx : s.hz;
  const n = Math.max(1, Math.round((2 * L) / RL.postSpacing));
  for (let i = 0; i <= n; i++) {
    const u = -L + (2 * L * i) / n;
    if (longX) toWorld(s, u, 0, _wa); else toWorld(s, 0, u, _wa);
    addBar(steelBuf, _wa[0], s.y0, _wa[1], _wa[0], s.y1, _wa[1], RL.post, RL.post, 1, 1, 1);
  }
  for (const y of [s.y0 + RL.midY, s.y1 - RL.rail / 2]) {
    if (longX) { toWorld(s, -s.hx, 0, _wa); toWorld(s, s.hx, 0, _wb); } else { toWorld(s, 0, -s.hz, _wa); toWorld(s, 0, s.hz, _wb); }
    addBar(steelBuf, _wa[0], y, _wa[1], _wb[0], y, _wb[1], RL.rail, RL.rail, 1, 1, 1);
  }
  // siatka: jedna płaszczyzna wzdłuż osi barierki (obustronna)
  if (longX) { toWorld(s, -s.hx, 0, _wa); toWorld(s, s.hx, 0, _wb); } else { toWorld(s, 0, -s.hz, _wa); toWorld(s, 0, s.hz, _wb); }
  const len = 2 * L, G = A.steel.tile * 0.5;
  const nx = longX ? -s.sin : s.cos, nz = longX ? -s.cos : -s.sin;
  const yA = s.y0 + RL.kick, yB = s.y1 - RL.rail;
  const i = railBuf.count;
  railBuf.vert(_wa[0], yA, _wa[1], nx, 0, nz, 0, 0);
  railBuf.vert(_wb[0], yA, _wb[1], nx, 0, nz, len / G, 0);
  railBuf.vert(_wb[0], yB, _wb[1], nx, 0, nz, len / G, (yB - yA) / G);
  railBuf.vert(_wa[0], yB, _wa[1], nx, 0, nz, 0, (yB - yA) / G);
  railBuf.quad(i, i + 1, i + 2, i + 3);
  // neon na pochwycie (po obu stronach) + pasy ostrzegawcze na końcach
  const t = A.trimSize;
  loop(trimBuf, s, s.y1 - t / 2, t, t, t / 2 + A.trimGap, col);
  for (const end of [-1, 1]) {
    if (longX) toWorld(s, end * (s.hx + A.trimGap), 0, _wa); else toWorld(s, 0, end * (s.hz + A.trimGap), _wa);
    addBar(trimBuf, _wa[0], s.y0 + RL.kick * 0.3, _wa[1], _wa[0], s.y1 - t * 1.5, _wa[1], t * 0.6, t * 0.6, warnCol.r, warnCol.g, warnCol.b);
  }
}

function addSteelRamp(steelBuf, paintBuf, trimBuf, r, warnCol, sideCol) {
  const { hx, hz, y0, y1 } = r;
  const G = A.steel.tile;
  const tileW = TX.paintMeters[0], tileH = TX.paintMeters[1], P = TX.wallMeters;
  // boki (trapezy) i czoła: ściany z farbą UV (shader ścian: farba + poświata od listwy)
  for (const side of [1, -1]) {
    const lx = side * hx;
    const za = side > 0 ? hz : -hz, zb = -za;
    const ya = side > 0 ? y1 : y0, yb = side > 0 ? y0 : y1;
    toWorld(r, lx, za, _wa); toWorld(r, lx, zb, _wb);
    const nx = side * r.cos, nz = -side * r.sin;
    const L = 2 * hz;
    const i = paintBuf.count;
    paintBuf.wvert(_wa[0], 0, _wa[1], nx, 0, nz, 0, 0, 0, L, 0, 0);
    paintBuf.wvert(_wb[0], 0, _wb[1], nx, 0, nz, L / tileW, 0, L, L, L / P, 0);
    paintBuf.wvert(_wb[0], yb, _wb[1], nx, 0, nz, L / tileW, yb / tileH, L, L, L / P, yb / P);
    paintBuf.wvert(_wa[0], ya, _wa[1], nx, 0, nz, 0, ya / tileH, 0, L, 0, ya / P);
    paintBuf.quad(i, i + 1, i + 2, i + 3);
  }
  addSide(paintBuf, r, -hx, hz, hx, hz, 0, 1, 0, y1, 0, tileW, tileH);
  if (y0 > 0.001) addSide(paintBuf, r, hx, -hz, -hx, -hz, 0, -1, 0, y0, 0, tileW, tileH);
  // skos: kratka stalowa
  const len = Math.hypot(2 * hz, y1 - y0);
  const ny = (2 * hz) / len, nzl = -(y1 - y0) / len;
  const nX = nzl * r.sin, nZ = nzl * r.cos;
  const ys = [y0, y0, y1, y1], lzs = [-hz, -hz, hz, hz], lxs = [-hx, hx, hx, -hx];
  const vs = [0, 0, len, len];
  const i = steelBuf.count;
  for (let k = 0; k < 4; k++) {
    toWorld(r, lxs[k], lzs[k], _wa);
    steelBuf.vert(_wa[0], ys[k], _wa[1], nX, ny, nZ, lxs[k] / G, vs[k] / G);
  }
  steelBuf.quad(i, i + 3, i + 2, i + 1);
  // listwy boczne skosu (kolor przewodni) + pionowe narożniki przy wysokim końcu
  const t = A.trimSize;
  for (const side of [1, -1]) {
    const lx = side * (hx + t / 2 + A.trimGap);
    toWorld(r, lx, -hz, _wa); toWorld(r, lx, hz, _wb);
    addBar(trimBuf, _wa[0], y0 - t / 2, _wa[1], _wb[0], y1 - t / 2, _wb[1], t, t, sideCol.r, sideCol.g, sideCol.b);
    toWorld(r, side * (hx + t / 2 + A.trimGap), hz + t / 2 + A.trimGap, _wa);
    addBar(trimBuf, _wa[0], A.rubber.baseHeight, _wa[1], _wa[0], y1 - t, _wa[1], t * 0.6, t * 0.6, sideCol.r, sideCol.g, sideCol.b);
  }
  // pasy ostrzegawcze w poprzek na początku i końcu rampy (czerwień tylko tu)
  const RW = A.rampWarn;
  for (const [lz, y] of [[-hz + RW.inset, y0 + RW.lift], [hz - RW.inset, y1 + RW.lift]]) {
    const yy = y + (lz < 0 ? 0 : -RW.lift * 2);
    toWorld(r, -hx, lz, _wa); toWorld(r, hx, lz, _wb);
    addBar(trimBuf, _wa[0], yy, _wa[1], _wb[0], yy, _wb[1], RW.width, RW.height, warnCol.r * RW.k, warnCol.g * RW.k, warnCol.b * RW.k);
  }
}

// ---------------------------------------------------------------- shadery

// ściany: maski farby (R/G/B) → kolory per bryła; poświata UV od listwy gasnąca w dół; delikatne krawędzie pionowe
function patchWallMaterial(mat, accentLin, reflPass) {
  const TS = TX.paintSharpen;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uAccent = { value: accentLin };
    sh.uniforms.uPaintK = reflPass;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aPaintA;
attribute vec3 aPaintB;
attribute vec3 aWash;
attribute vec4 aWall;
varying vec3 vPaintA;
varying vec3 vPaintB;
varying vec3 vWash;
varying vec4 vWall;
varying float vWY;`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
vPaintA = aPaintA; vPaintB = aPaintB; vWash = aWash; vWall = aWall;
vWY = (modelMatrix * vec4(transformed, 1.0)).y;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uAccent;
uniform float uPaintK;
varying vec3 vPaintA;
varying vec3 vPaintB;
varying vec3 vWash;
varying vec4 vWall;
varying float vWY;`)
      .replace('#include <emissivemap_fragment>', `
#ifdef USE_EMISSIVEMAP
  vec3 pm = texture2D( emissiveMap, vEmissiveMapUv ).rgb;
  {
    // maska rozmyta w teksturze → próg 0.5 o szerokości ~1 px ekranu (ostre, gładkie krawędzie z bliska);
    // gdy teksel < piksel (z daleka), wraca surowa maska z mipmap — cienkie linie nie znikają
    vec2 tx = fwidth( vEmissiveMapUv * vec2( textureSize( emissiveMap, 0 ) ) );
    float texelPx = max( tx.x, tx.y );   // teksele na piksel ekranu (> 1: pomniejszenie)
    vec3 w = max( fwidth( pm ) * ${TS.k.toFixed(3)}, vec3( ${TS.min.toFixed(4)} ) );
    vec3 sharp = smoothstep( 0.5 - w, 0.5 + w, pm );
    pm = mix( sharp, pm, smoothstep( ${TS.rawFrom.toFixed(3)}, ${TS.rawTo.toFixed(3)}, texelPx ) );
  }
  // farba w „panelu": margines od pionowych krawędzi, nad listwą przypodłogową i przy listwach (nie ucina się przypadkiem)
  float pe = min( vWall.x, vWall.y - vWall.x );
  float pmask = smoothstep( ${A.paintMargin.edge.toFixed(3)}, ${(A.paintMargin.edge + 0.012).toFixed(3)}, pe );
  pmask *= smoothstep( ${A.paintMargin.bottom.toFixed(3)}, ${(A.paintMargin.bottom + 0.012).toFixed(3)}, vWY );
  pmask *= 1.0 - smoothstep( ${A.paintMargin.maxY.toFixed(2)}, ${(A.paintMargin.maxY + 0.012).toFixed(3)}, vWY );
  pmask *= smoothstep( ${A.paintMargin.strip.toFixed(3)}, ${(A.paintMargin.strip + 0.012).toFixed(3)}, abs( vWY - vWall.z ) );
  if ( vWall.w > -0.5 ) pmask *= smoothstep( ${A.paintMargin.strip.toFixed(3)}, ${(A.paintMargin.strip + 0.012).toFixed(3)}, abs( vWY - vWall.w ) );
  totalEmissiveRadiance = ( pm.r * vPaintA + pm.g * vPaintB + pm.b * uAccent ) * emissive * pmask * uPaintK;
#else
  totalEmissiveRadiance = vec3( 0.0 );
#endif
  {
    float dTop = vWall.z - vWY;
    dTop = dTop >= 0.0 ? dTop : -dTop * 2.5;   // nad listwą (ściany obwodowe) poświata gaśnie szybciej
    float wash = ${A.wash.top.toFixed(4)} * exp( -dTop / ${A.wash.fall.toFixed(3)} ) + ${A.wash.base.toFixed(4)};
    if ( vWall.w > -0.5 ) wash += ${A.wash.bottom.toFixed(4)} * exp( -max( vWY - vWall.w, 0.0 ) / ${(A.wash.fall * 0.5).toFixed(3)} );
    float e = min( vWall.x, vWall.y - vWall.x );
    wash += ${A.wash.edge.toFixed(4)} * ( 1.0 - smoothstep( 0.0, ${A.wash.edgeWidth.toFixed(3)}, e ) ) * smoothstep( 0.0, 0.6, vWY );
#ifdef USE_MAP
    vec3 wtex = texture2D( map, vMapUv ).rgb;   // faktura płyty moduluje poświatę
#else
    vec3 wtex = vec3( 0.8 );
#endif
    totalEmissiveRadiance += vWash * wash * wtex;
  }
`);
  };
  mat.customProgramCacheKey = () => 'lt-wall';
}

// podłoga: odbicie planarne (RT z kamerą odbitą, mipmapy + smuga pionowa) × połysk × Fresnel; bez odbicia gdy brak RT
function patchFloorMaterial(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFW;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n  vFW = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tReflect;
uniform sampler2D tReflectDepth;
uniform float camNear;
uniform float camFar;
uniform vec2 reflRes;
uniform float reflOn;
uniform vec4 maskRect[ ${MAX_MASK} ];   // cx, cz, hx, hz
uniform vec2 maskRot[ ${MAX_MASK} ];    // cos, sin
varying vec2 vFW;
// 1 pod platformą (z miękkim brzegiem) — tam lustro y=0 dawałoby błędne odbicia
float floorMask() {
  float m = 0.0;
  for ( int i = 0; i < ${MAX_MASK}; i ++ ) {
    vec2 d = vFW - maskRect[ i ].xy;
    vec2 l = vec2( d.x * maskRot[ i ].x - d.y * maskRot[ i ].y, d.x * maskRot[ i ].y + d.y * maskRot[ i ].x );
    vec2 q = abs( l ) - maskRect[ i ].zw;
    float sd = max( q.x, q.y );
    m = max( m, 1.0 - smoothstep( -${A.reflect.maskSoft.toFixed(2)}, ${A.reflect.maskSoft.toFixed(2)}, sd ) );
  }
  return m;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if ( reflOn > 0.5 ) {
    vec2 ruv = gl_FragCoord.xy / reflRes;
    ruv.y = 1.0 - ruv.y;
    vec2 px = 1.0 / reflRes;
    vec3 rc = vec3( 0.0 );
    // smuga pionowa: ${A.reflect.taps} próbek wzdłuż pionu ekranu (bez zależności od roughness → zero falowania)
    float wsum = 0.0;
    for ( int k = 0; k < ${A.reflect.taps}; k ++ ) {
      float t = float( k ) / float( ${A.reflect.taps - 1} ) * 2.0 - 1.0;
      float w = 1.0 - abs( t ) * 0.7;
      rc += texture2D( tReflect, ruv + vec2( 0.0, t * ${A.reflect.streak.toFixed(1)} ) * px * 2.0, ${A.reflect.mipBias.toFixed(2)} ).rgb * w;
      wsum += w;
    }
    rc /= wsum;
    if ( any( isnan( rc ) ) || any( isinf( rc ) ) ) rc = vec3( 0.0 );   // odbicie nie przenosi NaN/Inf na podłogę
    rc = min( rc, vec3( ${A.reflect.maxValue.toFixed(1)} ) );
    // zanik z odległością od podłogi: głębia punktu odbitego − głębia podłogi ≈ droga za lustrem
    float rDepth = texture2D( tReflectDepth, ruv ).x;
    float rViewZ = perspectiveDepthToViewZ( rDepth, camNear, camFar );
    float behind = max( -rViewZ - vViewPosition.z, 0.0 );   // vViewPosition.z = głębia podłogi (dodatnia)
    float hFade = exp( -behind / ${A.reflect.fadeLen.toFixed(2)} );
    vec3 fN = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    float ndv = clamp( abs( dot( fN, vViewPosition ) ) * inversesqrt( max( dot( vViewPosition, vViewPosition ), 1e-12 ) ), 0.0, 1.0 );
    float fres = ${A.reflect.f0.toFixed(3)} + ( 1.0 - ${A.reflect.f0.toFixed(3)} ) * pow( 1.0 - ndv, 5.0 );
    totalEmissiveRadiance += rc * ${A.reflect.strength.toFixed(3)} * fres * hFade * ( 1.0 - floorMask() );
  }
`);
  };
  mat.customProgramCacheKey = () => 'lt-floor';
}

// neon: bliskie listwy przygaszone (bez płaskiej, grubej plamy bloomu), mgła działa częściowo (zarys w oddali)
function patchNeonMaterial(mat) {
  const N = A.neon;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vNearK;\nvarying float vNDepth;\nvarying vec3 vTubeN;\nvarying vec3 vTubeV;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  vNDepth = -mvPosition.z;
  vTubeN = normalize( normalMatrix * normal );
  vTubeV = -mvPosition.xyz;
  vNearK = mix( ${N.nearMin.toFixed(3)}, 1.0, smoothstep( ${N.near[0].toFixed(2)}, ${N.near[1].toFixed(2)}, vNDepth ) );`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vNearK;\nvarying float vNDepth;\nvarying vec3 vTubeN;\nvarying vec3 vTubeV;')
      .replace('#include <color_fragment>', `#include <color_fragment>
  // „rurka": ściany zwrócone do kamery jasne, boczne ciemniejsze → gradient rdzeń → brzeg zamiast płaskiej taśmy
  float tubeF = clamp( abs( dot( vTubeN, vTubeV ) ) * inversesqrt( max( dot( vTubeN, vTubeN ) * dot( vTubeV, vTubeV ), 1e-12 ) ), 0.0, 1.0 );
  diffuseColor.rgb *= vNearK * mix( ${N.tubeEdge.toFixed(3)}, 1.0, pow( tubeF, ${N.tubePow.toFixed(2)} ) );`)
      .replace('#include <fog_fragment>', `
#ifdef USE_FOG
#ifdef FOG_EXP2
  float nFog = 1.0 - exp( - fogDensity * fogDensity * vNDepth * vNDepth );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, nFog * ${N.fog.toFixed(3)} );
#endif
#endif`);
  };
  mat.customProgramCacheKey = () => 'lt-neon';
}

// sufit: plamy światła od lamp na panelach (strop ledwo widoczny, ale nie czarna pustka)
function patchCeilingMaterial(mat, lamps) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.lampPos = { value: lamps.pos };
    sh.uniforms.lampCol = { value: lamps.col };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCWPos;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n  vCWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vCWPos;
uniform vec3 lampPos[ ${MAX_LAMPS} ];
uniform vec3 lampCol[ ${MAX_LAMPS} ];`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  {
    vec3 pool = vec3( 0.0 );
    for ( int i = 0; i < ${MAX_LAMPS}; i ++ ) {
      vec2 d = vCWPos.xz - lampPos[ i ].xz;
      float k = 1.0 / ( 1.0 + dot( d, d ) / ${(A.ceilingPool.radius * A.ceilingPool.radius).toFixed(3)} );
      pool += lampCol[ i ] * k * k;
    }
    // panel (tekstura) moduluje plamę; normalizacja do średniej jasności paneli
    totalEmissiveRadiance += pool * ( diffuseColor.rgb / ${A.ceilingPool.panelRef.toFixed(4)} ) * ${A.ceilingPool.strength.toFixed(4)};
  }`);
  };
  mat.customProgramCacheKey = () => 'lt-ceiling';
}
const MAX_LAMPS = 8;
const MAX_MASK = 16;

const CONE_VERT = /* glsl */`
attribute vec3 color;
varying vec3 vColor;
varying vec3 vNormalV;
varying vec3 vViewV;
varying float vH;
varying float vFogDepth;
void main() {
  vColor = color;
  vH = uv.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewV = normalize(-mv.xyz);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const CONE_FRAG = /* glsl */`
uniform float opacity;
uniform float time;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec3 vColor;
varying vec3 vNormalV;
varying vec3 vViewV;
varying float vH;
varying float vFogDepth;
void main() {
  float facing = clamp(abs(dot(vNormalV, vViewV)) * inversesqrt(max(dot(vNormalV, vNormalV) * dot(vViewV, vViewV), 1e-12)), 0.0, 1.0);
  float edge = smoothstep(0.15, 0.9, facing); edge *= edge;  // krawędzie stożka znikają miękko (fresnel)
  float fall = pow(clamp(vH, 0.0, 1.0), 2.2) * smoothstep(0.0, 0.45, vH);  // jasno pod lampą, wygasa długo przed podłogą
  float near = smoothstep(0.4, 2.2, vFogDepth);          // nie oślepia przy kamerze
  float fogF = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.6);
  float a = opacity * edge * fall * near * fogF * (0.92 + 0.08 * sin(time * 1.7 + vH * 6.0));
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

// ---------------------------------------------------------------- kolory

/** kolor światła/lampy: akcent palety mapowany na fiolet UV (akcent tylko w farbie) */
export function lightColorHex(world, hex) {
  const p = world.palette;
  if (hex && A.uvRemap[world.id] && hex.toLowerCase() === p.uv.toLowerCase()) return paletteFor(world).uv;
  if (accentMode(world) === 'full') return hex;
  return hex && p.accent && hex.toLowerCase() === p.accent.toLowerCase() ? p.uv : hex;
}

/** paleta efektywna: dla map z A.uvRemap kolor 'uv' zastąpiony kluczem z palety (np. Reactor: fiolet → cyjan) */
export function paletteFor(world) {
  const p = world.palette;
  const k = A.uvRemap[world.id];
  return k ? { ...p, uv: p[k] } : p;
}

/** mnożnik emisji „tła" w kolorze uv: jasny uv (cyjan) → ciemniej */
export function darkNormFor(world) {
  const c = new THREE.Color(paletteFor(world).uv);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return Math.min(1, Math.max(A.darkNormMin, A.darkNormRef / Math.max(l, 1e-3)));
}

/** 'full' — akcent dozwolony na listwach/światłach (np. czerwień ostrzegawcza); 'paint' — tylko w farbie */
export function accentMode(world) {
  const P = A.accentPolicy;
  return (P[world.id] !== undefined ? P[world.id] : P.default);
}

/**
 * Pozycja oprawy lampy: dane światła, ale odsunięta od bryły sięgającej sufitu (filar), żeby oprawa i stożek
 * nie wchodziły w słup. out = { x, y, z, color } (bez alokacji przy ponownym użyciu out).
 */
export function lampPosition(world, L, out = { x: 0, y: 0, z: 0, color: '' }) {
  out.x = L.x; out.y = L.y; out.z = L.z; out.color = L.color;
  for (const s of world.solids) {
    if (s.y1 < L.y - A.lampClearance) continue;
    const dx = L.x - s.cx, dz = L.z - s.cz;
    const lx = dx * s.cos - dz * s.sin, lz = dx * s.sin + dz * s.cos;
    const m = A.lampClearance;
    if (Math.abs(lx) < s.hx + m && Math.abs(lz) < s.hz + m) {
      // przesuń wzdłuż lokalnej osi X na zewnątrz bryły
      const nlx = (lx >= 0 ? 1 : -1) * (s.hx + m) ;
      out.x = s.cx + nlx * s.cos + lz * s.sin;
      out.z = s.cz - nlx * s.sin + lz * s.cos;
    }
  }
  return out;
}
const _lamp = { x: 0, y: 0, z: 0, color: '' };

// ---------------------------------------------------------------- główna funkcja

export function buildArena(world, preset, textures, opts = {}) {
  const group = new THREE.Group();
  group.name = 'arena';
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  const rng = createRng((world.seed ^ A.seedSalt) >>> 0).next;
  const pal = paletteFor(world);
  const lin = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
  const palLin = { primary: lin(pal.primary), secondary: lin(pal.secondary), uv: lin(pal.uv), accent: lin(pal.accent) };
  const fullAccent = accentMode(world) === 'full';
  // jasne kolory (cyjan, bursztyn) przygaszone, ciemne (fiolet) podbite — wspólny poziom percepcyjny
  const boost = (key) => (key ? lumNorm(pal[key]) : 1);
  // dla emisji „tła" (sufit, siatka podłogi, świetlówki) w kolorze uv: jasny uv → mocno przygaszony
  const lumOf = (hex) => { const c = lin(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
  const darkNorm = darkNormFor(world);
  // listwy: kolor nasycony (ACES przy HDR wybiela — podbijamy nasycenie, rdzeń zostaje kolorowy)
  const saturate = (c, k) => {
    const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    c.r = Math.max(0, l + (c.r - l) * k); c.g = Math.max(0, l + (c.g - l) * k); c.b = Math.max(0, l + (c.b - l) * k);
    return c;
  };
  const trimCol = {};
  // wyrównanie jasności percepcyjnej: jasny cyjan nie wybiela się, ciemny fiolet nie ginie
  const lumNorm = (hex) => {
    const c = lin(hex);
    const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return Math.min(A.lumNormRange[1], Math.max(A.lumNormRange[0], Math.sqrt(A.trimLumRef / Math.max(l, 1e-3))));
  };
  for (const k of MAIN_KEYS) trimCol[k] = saturate(lin(pal[k], A.trimIntensity * lumNorm(pal[k])), A.trimSaturation);
  trimCol.accent = saturate(lin(pal.accent, A.trimIntensity * lumNorm(pal.accent)), A.trimSaturation);
  const pillarCol = {};
  for (const k of MAIN_KEYS) pillarCol[k] = saturate(lin(pal[k], A.trimIntensity * A.pillar.intensity * Math.min(lumNorm(pal[k]), A.pillar.lumMax)), A.pillar.saturation);
  const dimCol = {};
  for (const k of MAIN_KEYS) dimCol[k] = lin(pal[k], A.rubber.lineIntensity * lumNorm(pal[k]));
  const accentLin = lin(pal.accent, A.paintIntensity * A.accentPaintScale);
  // akcent z danych → kolor główny (deterministycznie per bryła)
  const mainKey = (key, i) => (MAIN_KEYS.includes(key) ? key
    : (key === 'accent' ? (fullAccent ? 'accent' : (i % 2 ? 'secondary' : 'primary')) : null));

  const paintBufs = {};
  for (const st of PAINT_STYLES) paintBufs[st] = new GeoBuf({ wall: true });
  const plainBuf = new GeoBuf({ wall: true });
  const trimBuf = new GeoBuf({ color: true });
  const trussBuf = new GeoBuf();
  const rubberBuf = new GeoBuf();
  const steelBuf = new GeoBuf();   // galerie/kładki/barierki/rampy: stal z kratką
  const railBuf = new GeoBuf();    // siatka barierek (ażur, alphaTest)
  const covers = opts.covers || (() => false);
  const reflPassU = { value: 1 };   // 1 = normalny render; < 1 podczas renderu odbicia (wspólny uniform ścian)
  const cycle = A.boundaryCycle.includes(world.id);
  const topLine = A.topLine.maps.includes(world.id);
  let boundaryIdx = 0;
  let signIdx = 0;
  const signBuf = new GeoBuf();
  const warnKey = fullAccent ? 'accent' : 'secondary';

  const setCur = (buf, aKey, bKey, washKey, top, bot) => {
    const c = buf.cur;
    const pk = A.paintIntensity * (buf.curBoundary ? A.boundaryPaintIntensity : 1);
    const ka = pk * boost(aKey), kb = pk * boost(bKey);
    c.pa[0] = palLin[aKey].r * ka; c.pa[1] = palLin[aKey].g * ka; c.pa[2] = palLin[aKey].b * ka;
    c.pb[0] = palLin[bKey].r * kb; c.pb[1] = palLin[bKey].g * kb; c.pb[2] = palLin[bKey].b * kb;
    const w = washKey ? palLin[washKey] : null, kw = boost(washKey);
    c.wash[0] = w ? w.r * kw : 0; c.wash[1] = w ? w.g * kw : 0; c.wash[2] = w ? w.b * kw : 0;
    c.top = top; c.bot = bot;
  };

  world.solids.forEach((s, i) => {
    if (covers(s)) return; // wizual dekoracji (np. rdzeń reaktora) zastępuje bryłę
    const tk = mainKey(s.trim, i);
    if (isSteel(s)) {
      // obrysy galerii/barierek w kolorach przewodnich; czerwień (akcent) tylko jako krótkie pasy ostrzegawcze
      const ek = tk && tk !== 'accent' ? tk : (s.kind === 'platform' ? 'secondary' : 'primary');
      addSteelSolid(steelBuf, trussBuf, trimBuf, railBuf, s, trimCol[ek], trimCol[warnKey], dimCol.uv);
      return;
    }
    let style = PAINT_STYLES.includes(s.paint) ? s.paint : null;
    if (s.boundary && cycle) style = PAINT_STYLES[(boundaryIdx++) % PAINT_STYLES.length];
    // farba: kolor A = kolor listwy (lub losowy główny), B = inny główny
    const aKey = (tk && tk !== 'accent') ? tk : MAIN_KEYS[Math.floor(rng() * 3)];
    const others = MAIN_KEYS.filter((k) => k !== aKey);
    const bKey = others[Math.floor(rng() * 2)];
    const hasBottom = !!(tk && s.trimBottom) || (s.boundary && !!tk);
    const bot = hasBottom ? s.y0 + A.trimSize / 2 + A.trimBottomLift : -1;
    const top = s.boundary ? Math.min(s.y1, A.boundaryTrimHeights[A.boundaryTrimHeights.length - 1]) : s.y1;
    if (s.boundary && cycle) {
      // ściana obwodowa → kilka paneli (różne style i pary kolorów), granice paneli = pionowe fugi
      for (const sub of splitPanels(s)) {
        const st = PAINT_STYLES[(boundaryIdx++) % PAINT_STYLES.length];
        const pa = MAIN_KEYS[boundaryIdx % 2], pb = pa === 'primary' ? 'secondary' : 'primary';
        const pbuf = paintBufs[st];
        pbuf.curBoundary = true;
        setCur(pbuf, pa, pb, tk, top, bot);
        setCur(plainBuf, pa, pb, tk, top, bot);
        addSolid(pbuf, plainBuf, sub, rng);
      }
    } else {
      const buf = style ? paintBufs[style] : plainBuf;
      buf.curBoundary = !!s.boundary;
      setCur(buf, aKey, bKey, tk, top, bot);
      setCur(plainBuf, aKey, bKey, tk, top, bot);
      addSolid(buf, plainBuf, s, rng);
    }
    rubberFor(rubberBuf, trimBuf, s, world, tk && dimCol[tk] ? dimCol[tk] : dimCol.uv);
    if (!tk) return;
    const col = trimCol[tk];
    if (s.boundary) {
      boundaryTrims(trimBuf, s, col, world);
      if (A.signs.maps.includes(world.id)) addSigns(signBuf, s, world, signIdx++);
      return;
    }
    if (s.kind === 'pillar') { pillarTrims(trimBuf, s, pillarCol[tk] || col); return; }
    trimLoop(trimBuf, s, s.y1 - A.trimSize / 2, col);
    if (topLine && s.kind === 'wall') {
      // linia na wierzchu ściany (wzdłuż osi) — kontur komór czytelny z góry
      const TL = A.topLine, longX = s.hx >= s.hz;
      if (longX) { toWorld(s, -s.hx, 0, _wa); toWorld(s, s.hx, 0, _wb); } else { toWorld(s, 0, -s.hz, _wa); toWorld(s, 0, s.hz, _wb); }
      addBar(trimBuf, _wa[0], s.y1 + TL.height / 2, _wa[1], _wb[0], s.y1 + TL.height / 2, _wb[1], TL.width, TL.height,
        col.r * TL.k, col.g * TL.k, col.b * TL.k);
    }
    if (s.trimBottom) trimLoop(trimBuf, s, s.y0 + A.trimSize / 2 + A.trimBottomLift, col);
  });
  (world.ramps || []).forEach((r) => {
    setCur(paintBufs.stripes, 'secondary', 'primary', 'secondary', r.y1, -1);
    addSteelRamp(steelBuf, paintBufs.stripes, trimBuf, r, trimCol[warnKey], trimCol.secondary);
  });

  // panele baz przy spawnach (kolory drużyn, przygaszone)
  const teams = CONFIG.colors.teams;
  for (const sp of world.spawns || []) {
    const tc = lin(teams[(sp.team || 0) % teams.length], A.spawnPanel.intensity);
    spawnPanel(rubberBuf, trimBuf, world, sp, trimCol[MAIN_KEYS[(sp.team || 0) % 2]], tc);
  }

  // --- materiały ścian
  const wallColor = new THREE.Color(A.wallColor);
  const wallMap = textures.get('wall:color');
  wallMap.channel = 1;
  const reflectables = [];
  const makeWallMat = (emap) => {
    const mat = own(new THREE.MeshStandardMaterial({
      color: wallColor, map: wallMap, roughness: A.wallRoughness, metalness: 0,
      emissive: 0xffffff, emissiveIntensity: 1, emissiveMap: emap || null,
    }));
    patchWallMaterial(mat, accentLin, reflPassU);
    return mat;
  };
  for (const st of PAINT_STYLES) {
    const geo = paintBufs[st].toGeometry();
    if (!geo) continue;
    const m = new THREE.Mesh(own(geo), makeWallMat(textures.paint(st)));
    m.name = 'walls:' + st;
    group.add(m);
  }
  {
    const geo = plainBuf.toGeometry();
    if (geo) {
      const m = new THREE.Mesh(own(geo), makeWallMat(null));
      m.name = 'walls:plain';
      group.add(m);
    }
  }

  // --- sufit: płaszczyzna + kratownica + oprawy
  const b = world.bounds;
  const W = b.maxX - b.minX, D = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const ceil = world.ceiling;
  {
    const geo = own(new THREE.PlaneGeometry(W, D));
    geo.rotateX(Math.PI / 2);
    geo.translate(cx, ceil, cz);
    scaleUv(geo, W / A.ceilingTile, D / A.ceilingTile);
    const tex = textures.get('ceiling');
    const mat = own(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: tex, roughness: A.ceilingRoughness, metalness: 0,
      emissive: new THREE.Color(pal.uv), emissiveMap: tex, emissiveIntensity: A.ceilingGlow * darkNorm,
    }));
    const lamps = { pos: [], col: [] };
    for (let i = 0; i < MAX_LAMPS; i++) {
      const L0 = (world.lights || [])[i];
      if (L0) {
        const L = lampPosition(world, L0, _lamp);
        lamps.pos.push(new THREE.Vector3(L.x, ceil, L.z));
        lamps.col.push(lin(lightColorHex(world, L0.color), darkNorm));
      } else { lamps.pos.push(new THREE.Vector3(0, -1000, 0)); lamps.col.push(new THREE.Color(0, 0, 0)); }
    }
    patchCeilingMaterial(mat, lamps);
    const m = new THREE.Mesh(geo, mat);
    m.name = 'ceiling';
    m.layers.set(LAYER_NO_REFLECT);
    group.add(m);
  }
  const yTop = ceil - A.trussDrop, yBot = ceil - A.trussDrop - A.trussDepth;
  const trussZ = [];
  {
    const tw = A.trussChord;
    for (let z = b.minZ + A.trussSpacing; z < b.maxZ - A.trussEdge; z += A.trussSpacing) {
      trussZ.push(z);
      for (const dz of [-A.trussWidth / 2, A.trussWidth / 2]) {
        addBar(trussBuf, b.minX, yTop, z + dz, b.maxX, yTop, z + dz, tw, tw);
        addBar(trussBuf, b.minX, yBot, z + dz, b.maxX, yBot, z + dz, tw, tw);
        let up = true;
        for (let x = b.minX; x < b.maxX - 0.01; x += A.trussBay) {
          const x2 = Math.min(b.maxX, x + A.trussBay);
          addBar(trussBuf, x, up ? yBot : yTop, z + dz, x2, up ? yTop : yBot, z + dz, tw * A.trussBrace, tw * A.trussBrace);
          up = !up;
        }
      }
      for (let x = b.minX + A.trussBay; x < b.maxX; x += A.trussBay * 2) {
        addBar(trussBuf, x, yBot, z - A.trussWidth / 2, x, yBot, z + A.trussWidth / 2, tw * A.trussBrace, tw * A.trussBrace);
      }
    }
    for (let x = b.minX + A.trussSpacing; x < b.maxX - A.trussEdge; x += A.trussSpacing) {
      addBar(trussBuf, x, yTop + tw, b.minZ, x, yTop + tw, b.maxZ, tw * A.trussCross[0], tw * A.trussCross[1]);
      // zawiesia dźwigarów do stropu (kratownica nie „pływa")
      for (const z of trussZ) addBar(trussBuf, x, yTop, z, x, ceil, z, A.trussHanger, A.trussHanger);
    }
  }
  // świetlówki UV: w oprawach przykręconych pod pasem dolnym dźwigara
  {
    const U = A.uvTube;
    const hy = yBot - A.trussChord / 2 - U.housing / 2 - U.drop;  // oprawa pod pasem dolnym (na wspornikach)
    const yT = hy - U.housing / 2 - U.thickness / 2;
    const c = lin(pal.uv, U.intensity * Math.sqrt(darkNorm));
    const hl = U.length / 2;
    // regularny rytm: ten sam układ w każdym rzędzie, oprawa pod osią dźwigara na wspornikach do obu pasów dolnych
    trussZ.forEach((z) => {
      for (let x = b.minX + U.spacing / 2; x < b.maxX - hl; x += U.spacing) {
        let nearLamp = false;
        for (const L of world.lights || []) if (Math.abs(L.x - x) < U.lampClear[0] && Math.abs(L.z - z) < U.lampClear[1]) nearLamp = true;
        if (nearLamp) continue;
        for (const ex of [-hl + U.bracketInset, hl - U.bracketInset]) {
          addBar(trussBuf, x + ex, yBot, z - A.trussWidth / 2, x + ex, yBot, z + A.trussWidth / 2, U.bracket, U.bracket);
          addBar(trussBuf, x + ex, yBot, z, x + ex, hy, z, U.bracket, U.bracket);
        }
        addBar(trussBuf, x - hl - U.housingPad, hy, z, x + hl + U.housingPad, hy, z, U.housingWidth, U.housing); // oprawa
        addBar(trimBuf, x - hl, yT, z, x + hl, yT, z, U.thickness, U.thickness, c.r, c.g, c.b);
      }
    });
  }
  // lampy: poprzeczka między sąsiednimi dźwigarami + oprawa + emisyjny prostokąt (kolor światła, akcent → UV)
  const lampY = [];
  for (const L0 of world.lights || []) {
    const L = lampPosition(world, L0, _lamp);
    let z0 = -Infinity, z1 = Infinity;
    for (const z of trussZ) { if (z <= L.z && z > z0) z0 = z; if (z >= L.z && z < z1) z1 = z; }
    if (!isFinite(z0)) z0 = b.minZ; if (!isFinite(z1)) z1 = b.maxZ;
    const LM = A.lampMount;
    if (z1 - z0 < LM.minSpan) { z0 -= A.trussSpacing / 2; z1 += A.trussSpacing / 2; }
    const yb = yBot - A.trussChord;
    addBar(trussBuf, L.x, yb, z0 - A.trussWidth / 2, L.x, yb, z1 + A.trussWidth / 2, LM.crossbar, LM.crossbar);
    const hl = A.lampSize[0] / 2;
    const yh = yb - LM.crossbar / 2 - LM.housingHeight / 2;
    addBar(trussBuf, L.x - hl - LM.housingPad, yh, L.z, L.x + hl + LM.housingPad, yh, L.z, A.lampSize[1] + 2 * LM.housingPad, LM.housingHeight);
    const y = yh - LM.housingHeight / 2 - A.lampSize[2] / 2;
    lampY.push(y);
    const c = saturate(lin(lightColorHex(world, L.color), A.lampIntensity), A.trimSaturation);
    addBar(trimBuf, L.x - hl, y, L.z, L.x + hl, y, L.z, A.lampSize[1], A.lampSize[2], c.r, c.g, c.b);
  }
  {
    const geo = trussBuf.toGeometry();
    if (geo) {
      geo.deleteAttribute('uv');
      const mat = own(new THREE.MeshStandardMaterial({
        color: A.trussColor, roughness: A.trussRoughness, metalness: A.trussMetalness,
        emissive: new THREE.Color(pal.uv), emissiveIntensity: A.trussGlow * darkNorm,
      }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'truss';
      m.layers.set(LAYER_NO_REFLECT);
      group.add(m);
    }
  }
  // gumowe odboje, listwy przypodłogowe, płyty baz
  {
    const geo = rubberBuf.toGeometry();
    if (geo) {
      geo.deleteAttribute('uv');
      const mat = own(new THREE.MeshStandardMaterial({
        color: A.rubber.color, roughness: A.rubber.roughness, metalness: 0,
        emissive: new THREE.Color(pal.uv), emissiveIntensity: A.rubber.glow * darkNorm,
      }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'rubber';
      group.add(m);
    }
  }
  // stal galerii: kratka (mapa + słaba emisja w kolorze uv), półpołysk
  {
    const geo = steelBuf.toGeometry();
    if (geo) {
      const grate = textures.get('steel:grate');
      const mat = own(new THREE.MeshStandardMaterial({
        color: A.steel.color, map: grate, metalness: A.steel.metalness, roughness: A.steel.roughness,
        emissive: new THREE.Color(pal.uv), emissiveMap: grate, emissiveIntensity: A.steel.glow * darkNorm,
      }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'steel';
      group.add(m);
    }
  }

  // tablice na ścianach obwodowych (atlas): litera sektora + znaki
  {
    const geo = signBuf.toGeometry();
    if (geo) {
      const mat = own(new THREE.MeshBasicMaterial({
        map: textures.get('signs'), transparent: true, depthWrite: false, fog: true,
        color: new THREE.Color(1, 1, 1).multiplyScalar(A.signs.intensity),
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'signs';
      m.renderOrder = 1;
      group.add(m);
    }
  }

  // siatka barierek (ażur): kratka jako alphaMap, obustronna
  {
    const geo = railBuf.toGeometry();
    if (geo) {
      const grate = textures.get('steel:grate');
      const mat = own(new THREE.MeshStandardMaterial({
        color: A.steel.color, map: grate, alphaMap: grate, alphaTest: A.rail.meshAlphaTest,
        metalness: A.steel.metalness, roughness: A.steel.roughness, side: THREE.DoubleSide,
        emissive: new THREE.Color(pal.uv), emissiveMap: grate, emissiveIntensity: A.steel.glow * darkNorm,
      }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'railMesh';
      group.add(m);
    }
  }

  // listwy neonowe + lampy: jeden mesh, vertexColors HDR
  {
    const geo = trimBuf.toGeometry();
    if (geo) {
      geo.deleteAttribute('uv');
      const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true, fog: true }));
      patchNeonMaterial(mat);
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'neon';
      group.add(m);
    }
  }

  // --- podłoga
  const reflOn = !!preset.envReflections;
  const floorUniforms = {
    tReflect: { value: null }, tReflectDepth: { value: null }, camNear: { value: 0.1 }, camFar: { value: 100 },
    reflRes: { value: new THREE.Vector2(1, 1) }, reflOn: { value: 0 },
    maskRect: { value: [] }, maskRot: { value: [] },
  };
  {
    const plats = world.solids.filter((sd) => sd.y0 > A.steelMinY && sd.kind === 'platform');
    for (let i = 0; i < MAX_MASK; i++) {
      const p = plats[i];
      floorUniforms.maskRect.value.push(p ? new THREE.Vector4(p.cx, p.cz, p.hx, p.hz) : new THREE.Vector4(1e5, 1e5, 0, 0));
      floorUniforms.maskRot.value.push(p ? new THREE.Vector2(p.cos, p.sin) : new THREE.Vector2(1, 0));
    }
  }
  let floorMat, floorMesh;
  {
    const geo = own(new THREE.PlaneGeometry(W, D));
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);
    scaleUv(geo, W / TX.floorMeters, D / TX.floorMeters);
    floorMat = own(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: textures.get('floor:color'),
      roughness: A.floorRoughness, roughnessMap: textures.get('floor:rough'),
      metalness: A.floorMetalness,
      emissive: 0xffffff, emissiveMap: textures.get('floor:emissive'), emissiveIntensity: A.floorEmissiveIntensity * darkNorm,
    }));
    patchFloorMaterial(floorMat, floorUniforms);
    floorMesh = new THREE.Mesh(geo, floorMat);
    floorMesh.name = 'floor';
    floorMesh.layers.set(LAYER_NO_REFLECT);
    group.add(floorMesh);
  }

  // --- stożki światła w dymie (High/Ultra)
  let coneMat = null, coneMesh = null;
  if (preset.smoke >= A.conesMinSmoke && (world.lights || []).length) {
    const list = [];
    world.lights.forEach((L0, i) => {
      const L = lampPosition(world, L0, _lamp);
      const top = lampY[i];
      // stożek nie może przecinać brył (twarda linia przecięcia): kończy się nad najwyższą bryłą w jego zasięgu
      let bottomY = A.coneBottom;
      for (const sd of world.solids) {
        if (sd.y1 + A.coneMargin <= bottomY || sd.y0 > top) continue;
        const dx = L.x - sd.cx, dz = L.z - sd.cz;
        const lx = Math.abs(dx * sd.cos - dz * sd.sin) - sd.hx, lz = Math.abs(dx * sd.sin + dz * sd.cos) - sd.hz;
        if (Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < A.coneCheckRadius + A.coneMargin) bottomY = sd.y1 + A.coneMargin;
      }
      const h = top - bottomY;
      if (h < A.coneMinHeight) return;
      const rb = Math.min(A.coneCheckRadius, A.coneTopRadius + (A.coneBottomRadius - A.coneTopRadius) * h / (top - A.coneBottom));
      const g = new THREE.CylinderGeometry(A.coneTopRadius, rb, h, A.coneSegments, 1, true);
      g.translate(L.x, bottomY + h / 2, L.z);
      const c = new THREE.Color(lightColorHex(world, L.color));
      const ct = A.coneTint[world.id];
      if (ct) c.lerp(new THREE.Color(pal[ct.key]), ct.mix);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      list.push(g);
    });
    const geo = list.length ? own(mergeGeometries(list)) : null;
    for (const g of list) g.dispose();
    coneMat = own(new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        opacity: { value: A.coneOpacity }, time: { value: 0 },
      },
      fog: true,
      vertexShader: CONE_VERT, fragmentShader: CONE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    coneMesh = geo ? new THREE.Mesh(geo, coneMat) : null;
    if (coneMesh) {
    coneMesh.name = 'lightCones';
    coneMesh.renderOrder = 2;
    coneMesh.layers.set(LAYER_NO_REFLECT);
    group.add(coneMesh);
    }
  }

  // --- envMap podłogi (raz): PMREM z samej areny — słaby połysk ogólny (główne odbicia robi RT)
  let envRT = null;
  if (preset.envReflections && opts.renderer) {
    const p = findBakePoint(world);
    const tmp = new THREE.Scene();
    tmp.add(group);
    group.position.set(-p.x, -A.envBakeHeight, -p.z);
    if (coneMesh) coneMesh.visible = false;
    floorMesh.visible = false;
    const pmrem = new THREE.PMREMGenerator(opts.renderer);
    envRT = pmrem.fromScene(tmp, A.envBlur, A.envNear, Math.max(W, D) * A.envFarScale);
    pmrem.dispose();
    floorMesh.visible = true;
    if (coneMesh) coneMesh.visible = true;
    group.position.set(0, 0, 0);
    tmp.remove(group);
    floorMat.envMap = envRT.texture;
    floorMat.envMapIntensity = A.floorEnvIntensity;
    floorMat.needsUpdate = true;
  }

  // --- odbicie planarne: render sceny kamerą odbitą względem y=0 do RT (½ rozdz., mipmapy) — High/Ultra
  let reflRT = null;
  const reflCam = new THREE.PerspectiveCamera();
  reflCam.matrixAutoUpdate = false;
  reflCam.matrixWorldAutoUpdate = false;
  reflCam.layers.set(0);
  const MIRROR = new THREE.Matrix4().makeScale(1, -1, 1);
  const FLIP_Y = new THREE.Matrix4().makeScale(1, -1, 1);
  if (reflOn) {
    reflRT = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true,
    });
    reflRT.depthTexture = new THREE.DepthTexture(1, 1);
    floorUniforms.tReflect.value = reflRT.texture;
    floorUniforms.tReflectDepth.value = reflRT.depthTexture;
    floorUniforms.reflOn.value = 1;
  }

  return {
    group,
    update(time) {
      if (coneMat) coneMat.uniforms.time.value = time;
    },
    setSize(w, h) {
      floorUniforms.reflRes.value.set(w, h);
      if (reflRT) reflRT.setSize(Math.max(1, Math.round(w * A.reflect.scale)), Math.max(1, Math.round(h * A.reflect.scale)));
    },
    renderReflection(renderer, scene, camera) {
      if (!reflRT) return;
      camera.updateMatrixWorld();
      // właściwa kamera (det > 0): M·C·Sy → obraz odbity pionowo (shader podłogi odwraca v)
      reflCam.matrixWorld.multiplyMatrices(MIRROR, camera.matrixWorld).multiply(FLIP_Y);
      reflCam.matrixWorldInverse.copy(reflCam.matrixWorld).invert();
      reflCam.projectionMatrix.copy(camera.projectionMatrix);
      reflCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      floorUniforms.camNear.value = camera.near;
      floorUniforms.camFar.value = camera.far;
      reflPassU.value = A.reflect.paintInReflection; // farba przygaszona w odbiciu → odbijają się głównie listwy
      const vis = camera.visible;
      camera.visible = false; // broń FPP (dziecko kamery) nie odbija się
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(reflRT);
      renderer.clear();
      renderer.render(scene, reflCam);
      renderer.setRenderTarget(prev);
      reflPassU.value = 1;
      camera.visible = vis;
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      if (envRT) { envRT.dispose(); envRT = null; }
      if (reflRT) { if (reflRT.depthTexture) reflRT.depthTexture.dispose(); reflRT.dispose(); reflRT = null; }
    },
  };
}

// ---------------------------------------------------------------- narzędzia

function scaleUv(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
}

// odległość w XZ od (x,z) do najbliższej bryły sięgającej poniżej y (i do granic areny)
function clearanceXZ(world, x, z, y) {
  const b = world.bounds;
  let best = Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z);
  for (const s of world.solids) {
    if (s.y0 > y) continue;
    const dx = x - s.cx, dz = z - s.cz;
    const lx = Math.abs(dx * s.cos - dz * s.sin) - s.hx, lz = Math.abs(dx * s.sin + dz * s.cos) - s.hz;
    const d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
    if (d < best) best = d;
  }
  return best;
}

function insideSolid(world, x, z, y, m) {
  for (const s of world.solids) {
    if (y < s.y0 || y > s.y1) continue;
    const dx = x - s.cx, dz = z - s.cz;
    const lx = dx * s.cos - dz * s.sin, lz = dx * s.sin + dz * s.cos;
    if (Math.abs(lx) < s.hx + m && Math.abs(lz) < s.hz + m) return true;
  }
  return false;
}

function findBakePoint(world) {
  const b = world.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const S = A.bakeSearch;
  for (let r = 0; r < S.maxRadius; r += S.step) {
    const steps = Math.max(1, Math.round(r * 8));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!insideSolid(world, x, z, A.envBakeHeight, S.margin)) return { x, z };
    }
  }
  return { x: cx, z: cz };
}
