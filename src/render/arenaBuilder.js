// Budowa areny z danych świata (PLAN §2/§5): bryły z farbą UV, neonowe listwy, podłoga, sufit z kratownicą i lampami,
// stożki światła w dymie (High/Ultra). Geometria scalona per materiał → kilka draw calli na całą mapę.
// buildArena(world, preset, textures, opts?) → { group, dispose(), update(time) }
//   opts.renderer — gdy podany i preset.envReflections: envMap podłogi z PMREMGenerator.fromScene (raz, przy budowie).
//
// Konwencja obrotu brył (jak Object3D.rotation.y = rot):
//   world.x = cx + lx·cos + lz·sin,   world.z = cz − lx·sin + lz·cos   (cos = cos(rot), sin = sin(rot))
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAINT_STYLES, makeRng } from './textures.js';

const A = CONFIG.render.arena;
const TX = CONFIG.render.textures;

// ---------------------------------------------------------------- bufor geometrii (bez Three do końca)

class GeoBuf {
  constructor(withColor = false, withUv = true) {
    this.pos = []; this.nrm = []; this.uv = withUv ? [] : null; this.col = withColor ? [] : null; this.idx = [];
  }
  get count() { return this.pos.length / 3; }
  vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    if (this.uv) this.uv.push(u, v);
    if (this.col) this.col.push(r, g, b);
  }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  toGeometry() {
    if (!this.idx.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// prostopadłościan wzdłuż odcinka a→b, przekrój t×t (listwy, belki); kolor per wierzchołek (HDR)
const _d = new THREE.Vector3(), _s = new THREE.Vector3(), _u = new THREE.Vector3(), _up = new THREE.Vector3();
const _c = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
function addBar(buf, ax, ay, az, bx, by, bz, tw, th, r, g, b) {
  _d.set(bx - ax, by - ay, bz - az).normalize();
  _up.set(0, 1, 0);
  if (Math.abs(_d.y) > 0.9) _up.set(1, 0, 0);
  _s.crossVectors(_d, _up).normalize().multiplyScalar(tw / 2);
  _u.crossVectors(_s, _d).normalize().multiplyScalar(th / 2);
  // 0..3 przy a, 4..7 przy b; kolejność wokół osi: -s-u, +s-u, +s+u, -s+u
  for (let e = 0; e < 2; e++) {
    const px = e ? bx : ax, py = e ? by : ay, pz = e ? bz : az;
    _c[e * 4 + 0].set(px - _s.x - _u.x, py - _s.y - _u.y, pz - _s.z - _u.z);
    _c[e * 4 + 1].set(px + _s.x - _u.x, py + _s.y - _u.y, pz + _s.z - _u.z);
    _c[e * 4 + 2].set(px + _s.x + _u.x, py + _s.y + _u.y, pz + _s.z + _u.z);
    _c[e * 4 + 3].set(px - _s.x + _u.x, py - _s.y + _u.y, pz - _s.z + _u.z);
  }
  const faces = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [3, 2, 1, 0], [4, 5, 6, 7]];
  for (const f of faces) {
    const p0 = _c[f[0]], p1 = _c[f[1]], p2 = _c[f[2]];
    const nx = (p1.y - p0.y) * (p2.z - p0.z) - (p1.z - p0.z) * (p2.y - p0.y);
    const ny = (p1.z - p0.z) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.z - p0.z);
    const nz = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
    const nl = Math.hypot(nx, ny, nz) || 1;
    const i0 = buf.count;
    for (let k = 0; k < 4; k++) {
      const p = _c[f[k]];
      buf.vert(p.x, p.y, p.z, nx / nl, ny / nl, nz / nl, k === 1 || k === 2 ? 1 : 0, k >= 2 ? 1 : 0, r, g, b);
    }
    buf.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }
}

// ---------------------------------------------------------------- bryły

// Ściana pionowa prostokąta: rogi lokalne (l0 → l1) na wysokości y0..y1, normalna lokalna (nlx, nlz).
// u w metrach wzdłuż ściany (rośnie w prawo patrząc z zewnątrz), v = y (metry) → skala do kafla farby.
function addSide(buf, s, lx0, lz0, lx1, lz1, nlx, nlz, y0, y1, uOff, tileW, tileH) {
  const c = s.cos, sn = s.sin;
  const wx0 = s.cx + lx0 * c + lz0 * sn, wz0 = s.cz - lx0 * sn + lz0 * c;
  const wx1 = s.cx + lx1 * c + lz1 * sn, wz1 = s.cz - lx1 * sn + lz1 * c;
  const nx = nlx * c + nlz * sn, nz = -nlx * sn + nlz * c;
  const len = Math.hypot(lx1 - lx0, lz1 - lz0);
  const u0 = uOff / tileW, u1 = (uOff + len) / tileW;
  const i = buf.count;
  buf.vert(wx0, y0, wz0, nx, 0, nz, u0, y0 / tileH);
  buf.vert(wx1, y0, wz1, nx, 0, nz, u1, y0 / tileH);
  buf.vert(wx1, y1, wz1, nx, 0, nz, u1, y1 / tileH);
  buf.vert(wx0, y1, wz0, nx, 0, nz, u0, y1 / tileH);
  buf.quad(i, i + 1, i + 2, i + 3);
}

function addCap(buf, s, y, up) {
  const c = s.cos, sn = s.sin;
  const i = buf.count;
  const ny = up ? 1 : -1;
  const corners = up ? [[-1, 1], [1, 1], [1, -1], [-1, -1]] : [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [ix, iz] of corners) {
    const lx = ix * s.hx, lz = iz * s.hz;
    const wx = s.cx + lx * c + lz * sn, wz = s.cz - lx * sn + lz * c;
    buf.vert(wx, y, wz, 0, ny, 0, wx / TX.paintMeters[0], wz / TX.paintMeters[0]);
  }
  buf.quad(i, i + 1, i + 2, i + 3);
}

function addSolid(paintBuf, plainBuf, s, rng) {
  const tileW = s.boundary ? TX.paintMeters[0] * A.boundaryPaintScale : TX.paintMeters[0];
  const tileH = s.boundary ? TX.paintMeters[1] * A.boundaryPaintScale : TX.paintMeters[1];
  const { hx, hz, y0, y1 } = s;
  // losowy offset u per ściana (anty-repetycja); każda strona inny
  const base = rng() * tileW * 4;
  const off = [base, base + 2 * hz + rng() * tileW, base + rng() * tileW * 2, base + rng() * tileW * 3];
  // patrząc z zewnątrz: +X → prawo = −Z;  −X → +Z;  +Z → +X;  −Z → −X
  addSide(paintBuf, s, hx, hz, hx, -hz, 1, 0, y0, y1, off[0], tileW, tileH);
  addSide(paintBuf, s, -hx, -hz, -hx, hz, -1, 0, y0, y1, off[1], tileW, tileH);
  addSide(paintBuf, s, -hx, hz, hx, hz, 0, 1, y0, y1, off[2], tileW, tileH);
  addSide(paintBuf, s, hx, -hz, -hx, -hz, 0, -1, y0, y1, off[3], tileW, tileH);
  addCap(plainBuf, s, y1, true);
  if (y0 > 0.001) addCap(plainBuf, s, y0, false);
}

// ---------------------------------------------------------------- rampa (klin)

function addRamp(paintBuf, plainBuf, trimBuf, r, accent) {
  const s = r; // ten sam układ (cx,cz,hx,hz,cos,sin)
  const { hx, hz, y0, y1 } = r;
  const c = r.cos, sn = r.sin;
  const W = (lx, lz) => [r.cx + lx * c + lz * sn, r.cz - lx * sn + lz * c];
  const tileW = TX.paintMeters[0], tileH = TX.paintMeters[1];
  // boki ±X: trapezy (dół 0, góra y0→y1 wzdłuż z)
  for (const side of [1, -1]) {
    const lx = side * hx;
    const za = side > 0 ? hz : -hz, zb = -za;
    const ya = side > 0 ? y1 : y0, yb = side > 0 ? y0 : y1;
    const [ax, az] = W(lx, za), [bx, bz] = W(lx, zb);
    const nx = side * c, nz = -side * sn;
    const i = paintBuf.count;
    paintBuf.vert(ax, 0, az, nx, 0, nz, 0, 0);
    paintBuf.vert(bx, 0, bz, nx, 0, nz, 2 * hz / tileW, 0);
    paintBuf.vert(bx, yb, bz, nx, 0, nz, 2 * hz / tileW, yb / tileH);
    paintBuf.vert(ax, ya, az, nx, 0, nz, 0, ya / tileH);
    paintBuf.quad(i, i + 1, i + 2, i + 3);
  }
  // tył (+Z, wysokość y1) i przód (−Z, wysokość y0)
  addSide(paintBuf, s, -hx, hz, hx, hz, 0, 1, 0, y1, 0, tileW, tileH);
  if (y0 > 0.001) addSide(paintBuf, s, hx, -hz, -hx, -hz, 0, -1, 0, y0, 0, tileW, tileH);
  // powierzchnia skośna
  const len = Math.hypot(2 * hz, y1 - y0);
  const ny = (2 * hz) / len, nzl = -(y1 - y0) / len;
  const nX = nzl * sn, nZ = nzl * c;
  const p = [W(-hx, -hz), W(hx, -hz), W(hx, hz), W(-hx, hz)];
  const ys = [y0, y0, y1, y1];
  const i = plainBuf.count;
  for (let k = 0; k < 4; k++) plainBuf.vert(p[k][0], ys[k], p[k][1], nX, ny, nZ, 0, 0);
  plainBuf.quad(i, i + 3, i + 2, i + 1);
  // listwy wzdłuż górnych krawędzi boków
  const t = A.trimSize;
  for (const side of [1, -1]) {
    const lx = side * (hx + t / 2 + A.trimGap);
    const [ax, az] = W(lx, -hz), [bx, bz] = W(lx, hz);
    addBar(trimBuf, ax, y0 - t / 2, az, bx, y1 - t / 2, bz, t, t, accent.r, accent.g, accent.b);
  }
}

// ---------------------------------------------------------------- listwy neonowe

function trimLoop(buf, s, y, col, inset = 0) {
  const t = A.trimSize, o = t / 2 + A.trimGap;
  const ex = s.hx + o, ez = s.hz + o;
  const c = s.cos, sn = s.sin;
  const W = (lx, lz, out) => { out[0] = s.cx + lx * c + lz * sn; out[1] = s.cz - lx * sn + lz * c; return out; };
  const a = [0, 0], b = [0, 0];
  const edges = [[-ex, ez, ex, ez], [ex, -ez, -ex, -ez], [ex, ez, ex, -ez], [-ex, -ez, -ex, ez]];
  for (const e of edges) {
    W(e[0], e[1], a); W(e[2], e[3], b);
    // wydłużenie o t/2 na końcach → domknięte narożniki
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
    const kx = dx / l * (t / 2 - inset), kz = dz / l * (t / 2 - inset);
    addBar(buf, a[0] - kx, y, a[1] - kz, b[0] + kx, y, b[1] + kz, t, t, col.r, col.g, col.b);
  }
}

function pillarTrims(buf, s, col) {
  const t = A.trimSize, o = t / 2 + A.trimGap;
  const c = s.cos, sn = s.sin;
  for (const [ix, iz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const lx = ix * (s.hx + o * 0.5), lz = iz * (s.hz + o * 0.5);
    const wx = s.cx + lx * c + lz * sn, wz = s.cz - lx * sn + lz * c;
    addBar(buf, wx, s.y0 + 0.02, wz, wx, Math.min(s.y1, A.pillarTrimTop) , wz, t, t, col.r, col.g, col.b);
  }
  // pierścienie: u podstawy i na wysokości ścian
  trimLoop(buf, s, s.y0 + t / 2 + 0.02, col);
  for (const h of A.pillarRings) if (h < s.y1 - t) trimLoop(buf, s, h, col);
}

function boundaryTrims(buf, s, col, world) {
  // tylko strona zwrócona do środka areny (długi bok)
  const t = A.trimSize, o = t / 2 + A.trimGap;
  const c = s.cos, sn = s.sin;
  const longX = s.hx >= s.hz;
  // kandydaci: ±hz (gdy długi bok wzdłuż X) lub ±hx
  let best = null, bestDot = -Infinity;
  for (const sign of [1, -1]) {
    const nlx = longX ? 0 : sign, nlz = longX ? sign : 0;
    const nx = nlx * c + nlz * sn, nz = -nlx * sn + nlz * c;
    const cx = (world.bounds.minX + world.bounds.maxX) / 2 - s.cx, cz = (world.bounds.minZ + world.bounds.maxZ) / 2 - s.cz;
    const dot = nx * cx + nz * cz;
    if (dot > bestDot) { bestDot = dot; best = sign; }
  }
  for (const h of A.boundaryTrimHeights) {
    if (h > s.y1 - t) continue;
    let ax, az, bx, bz;
    if (longX) { const lz = best * (s.hz + o); ax = -s.hx; az = lz; bx = s.hx; bz = lz; }
    else { const lx = best * (s.hx + o); ax = lx; az = -s.hz; bx = lx; bz = s.hz; }
    addBar(buf, s.cx + ax * c + az * sn, h, s.cz - ax * sn + az * c, s.cx + bx * c + bz * sn, h, s.cz - bx * sn + bz * c,
      t, t, col.r, col.g, col.b);
  }
}

// ---------------------------------------------------------------- shadery

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
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  float edge = pow(facing, 2.5);                    // krawędzie stożka znikają (fresnel)
  float fall = pow(vH, 1.6) * smoothstep(0.0, 0.35, vH); // jasno pod lampą, 0 przy podłodze
  float near = smoothstep(0.4, 2.2, vFogDepth);     // nie oślepia przy kamerze
  float fogF = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  float a = opacity * edge * fall * near * fogF * (0.92 + 0.08 * sin(time * 1.7 + vH * 6.0));
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

// ---------------------------------------------------------------- główna funkcja

export function buildArena(world, preset, textures, opts = {}) {
  const group = new THREE.Group();
  group.name = 'arena';
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  const rng = makeRng((world.seed ^ 0xa11ce) >>> 0);
  const pal = world.palette;
  const lin = (hex, k) => new THREE.Color(hex).multiplyScalar(k);
  const trimCol = {
    primary: lin(pal.primary, A.trimIntensity),
    secondary: lin(pal.secondary, A.trimIntensity),
    uv: lin(pal.uv, A.trimIntensity * A.trimUvBoost),
    accent: lin(pal.accent, A.trimIntensity * A.trimAccentScale),
  };

  // --- bufory
  const paintBufs = {};
  for (const st of PAINT_STYLES) paintBufs[st] = new GeoBuf();
  const plainBuf = new GeoBuf();
  const trimBuf = new GeoBuf(true, true);
  const trussBuf = new GeoBuf(false, true);

  for (const s of world.solids) {
    const style = PAINT_STYLES.includes(s.paint) ? s.paint : null;
    addSolid(style ? paintBufs[style] : plainBuf, plainBuf, s, rng);
    const col = trimCol[s.trim];
    if (!col) continue;
    if (s.boundary) { boundaryTrims(trimBuf, s, col, world); continue; }
    if (s.kind === 'pillar') { pillarTrims(trimBuf, s, col); continue; }
    trimLoop(trimBuf, s, s.y1 - A.trimSize / 2, col);
    if (s.trimBottom) trimLoop(trimBuf, s, s.y0 + A.trimSize / 2 + A.trimBottomLift, col);
  }
  for (const r of world.ramps || []) addRamp(paintBufs.stripes, plainBuf, trimBuf, r, trimCol.accent);

  const reflectables = []; // meshe odbijane w podłodze (lustrzana kopia pod przezroczystą podłogą)

  // --- materiały ścian
  const wallColor = new THREE.Color(A.wallColor);
  for (const st of PAINT_STYLES) {
    const geo = paintBufs[st].toGeometry();
    if (!geo) continue;
    const mat = own(new THREE.MeshStandardMaterial({
      color: wallColor, roughness: A.wallRoughness, metalness: 0,
      emissive: 0xffffff, emissiveIntensity: A.paintIntensity, emissiveMap: textures.paint(st),
    }));
    const m = new THREE.Mesh(own(geo), mat);
    m.name = 'walls:' + st;
    group.add(m);
    reflectables.push(m);
  }
  {
    const geo = plainBuf.toGeometry();
    if (geo) {
      const mat = own(new THREE.MeshStandardMaterial({ color: wallColor, roughness: A.wallRoughness, metalness: 0 }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'walls:plain';
      group.add(m);
      reflectables.push(m);
    }
  }

  // --- sufit: płaszczyzna + kratownica + lampy
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
    const mat = own(new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.95, metalness: 0 }));
    const m = new THREE.Mesh(geo, mat);
    m.name = 'ceiling';
    group.add(m);
  }
  // kratownica: główne dźwigary wzdłuż X (pas górny + dolny + krzyżulce), poprzeczki wzdłuż Z
  {
    const yTop = ceil - A.trussDrop, yBot = ceil - A.trussDrop - A.trussDepth;
    const tw = A.trussChord;
    for (let z = b.minZ + A.trussSpacing; z < b.maxZ - 0.5; z += A.trussSpacing) {
      for (const dz of [-A.trussWidth / 2, A.trussWidth / 2]) {
        addBar(trussBuf, b.minX, yTop, z + dz, b.maxX, yTop, z + dz, tw, tw, 1, 1, 1);
        addBar(trussBuf, b.minX, yBot, z + dz, b.maxX, yBot, z + dz, tw, tw, 1, 1, 1);
        let up = true;
        for (let x = b.minX; x < b.maxX - 0.01; x += A.trussBay) {
          const x2 = Math.min(b.maxX, x + A.trussBay);
          addBar(trussBuf, x, up ? yBot : yTop, z + dz, x2, up ? yTop : yBot, z + dz, tw * 0.6, tw * 0.6, 1, 1, 1);
          up = !up;
        }
      }
      // poprzeczne szczeble między płaszczyznami dźwigara
      for (let x = b.minX + A.trussBay; x < b.maxX; x += A.trussBay * 2) {
        addBar(trussBuf, x, yBot, z - A.trussWidth / 2, x, yBot, z + A.trussWidth / 2, tw * 0.6, tw * 0.6, 1, 1, 1);
      }
    }
    for (let x = b.minX + A.trussSpacing; x < b.maxX - 0.5; x += A.trussSpacing) {
      addBar(trussBuf, x, yTop + tw, b.minZ, x, yTop + tw, b.maxZ, tw * 1.2, tw * 1.6, 1, 1, 1);
    }
  }
  // lampy UV (emisyjne prostokąty w kolorze światła — w meshu listew) + oprawy (w kratownicy)
  for (const L of world.lights || []) {
    const y = Math.min(L.y, ceil - A.trussDrop - A.trussDepth - 0.05);
    const c = lin(L.color, A.lampIntensity);
    const hl = A.lampSize[0] / 2;
    addBar(trimBuf, L.x - hl, y, L.z, L.x + hl, y, L.z, A.lampSize[1], A.lampSize[2], c.r, c.g, c.b);
    addBar(trussBuf, L.x - hl - 0.06, y + A.lampSize[2], L.z, L.x + hl + 0.06, y + A.lampSize[2], L.z,
      A.lampSize[1] + 0.08, 0.1, 1, 1, 1);
    addBar(trussBuf, L.x, y + 0.05, L.z, L.x, ceil, L.z, 0.04, 0.04, 1, 1, 1); // zawiesie
  }
  {
    const geo = trussBuf.toGeometry();
    if (geo) {
      geo.deleteAttribute('uv');
      const mat = own(new THREE.MeshStandardMaterial({ color: A.trussColor, roughness: 0.5, metalness: 0.6 }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'truss';
      group.add(m);
    }
  }

  // --- listwy neonowe + lampy: jeden mesh, vertexColors HDR
  {
    const geo = trimBuf.toGeometry();
    if (geo) {
      geo.deleteAttribute('uv');
      geo.deleteAttribute('normal');
      const mat = own(new THREE.MeshBasicMaterial({ vertexColors: true, fog: true, toneMapped: true }));
      const m = new THREE.Mesh(own(geo), mat);
      m.name = 'neon';
      group.add(m);
      reflectables.push(m);
    }
  }

  // --- podłoga
  let floorMat;
  {
    const geo = own(new THREE.PlaneGeometry(W, D));
    geo.rotateX(-Math.PI / 2);
    geo.translate(cx, 0, cz);
    scaleUv(geo, W / TX.floorMeters, D / TX.floorMeters);
    floorMat = own(new THREE.MeshStandardMaterial({
      color: 0xffffff, map: textures.get('floor:color'),
      roughness: A.floorRoughness, roughnessMap: textures.get('floor:rough'),
      metalness: A.floorMetalness,
      emissive: 0xffffff, emissiveMap: textures.get('floor:emissive'), emissiveIntensity: A.floorEmissiveIntensity,
    }));
    const m = new THREE.Mesh(geo, floorMat);
    m.name = 'floor';
    m.renderOrder = 1;
    group.add(m);
  }

  // --- stożki światła w dymie (High/Ultra = gdy preset ma dym ≥ A.conesMinSmoke)
  let coneMat = null, coneMesh = null;
  if (preset.smoke >= A.conesMinSmoke && (world.lights || []).length) {
    const buf = [];
    for (const L of world.lights) {
      const top = Math.min(L.y, ceil - A.trussDrop - A.trussDepth - 0.05);
      const h = top - A.coneBottom;
      const g = new THREE.CylinderGeometry(A.coneTopRadius, A.coneBottomRadius, h, 24, 1, true);
      g.translate(L.x, A.coneBottom + h / 2, L.z);
      const c = new THREE.Color(L.color);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      buf.push(g);
    }
    const geo = own(mergeGeometries(buf));
    for (const g of buf) g.dispose();
    coneMat = own(new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        opacity: { value: A.coneOpacity }, time: { value: 0 },
      },
      fog: true,
      vertexShader: CONE_VERT, fragmentShader: CONE_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    coneMesh = new THREE.Mesh(geo, coneMat);
    coneMesh.name = 'lightCones';
    coneMesh.renderOrder = 2;
    group.add(coneMesh);
  }

  // --- envMap podłogi (raz): PMREM z samej areny, z punktu na wysokości oka blisko środka
  let envRT = null;
  if (preset.envReflections && opts.renderer) {
    const p = findBakePoint(world);
    const tmp = new THREE.Scene();
    tmp.add(group);
    group.position.set(-p.x, -A.envBakeHeight, -p.z);
    if (coneMesh) coneMesh.visible = false;
    floorMat.visible = false; // podłoga nie odbija samej siebie
    const pmrem = new THREE.PMREMGenerator(opts.renderer);
    envRT = pmrem.fromScene(tmp, A.envBlur, 0.05, Math.max(W, D) * 1.5);
    pmrem.dispose();
    floorMat.visible = true;
    if (coneMesh) coneMesh.visible = true;
    group.position.set(0, 0, 0);
    tmp.remove(group);
    floorMat.envMap = envRT.texture;
    floorMat.envMapIntensity = A.floorEnvIntensity;
    floorMat.needsUpdate = true;
  }

  // --- odbicia planarne (High/Ultra): lustrzane kopie (scale.y = −1, te same geometrie i materiały) pod półprzezroczystą
  // podłogą. Krycie podłogi zależy od połysku (roughnessMap) i kąta patrzenia (Fresnel) → miękkie, nierówne odbicia neonów.
  if (preset.envReflections) {
    const mirror = new THREE.Group();
    mirror.name = 'floorMirror';
    mirror.scale.y = -1;
    for (const src of reflectables) {
      const m = new THREE.Mesh(src.geometry, src.material);
      m.name = 'mirror:' + src.name;
      mirror.add(m);
    }
    group.add(mirror);
    const F = A.floorReflect;
    floorMat.transparent = true;
    floorMat.depthWrite = true;
    floorMat.alphaMap = textures.get('floor:rough');
    floorMat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <alphamap_fragment>', `
        float flRough = texture2D( alphaMap, vAlphaMapUv ).g;
        vec3 flN = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        float flNdV = clamp( abs( dot( flN, normalize( vViewPosition ) ) ), 0.0, 1.0 );
        float flFres = pow( 1.0 - flNdV, 3.0 );
        diffuseColor.a = clamp( mix( ${F.alphaGloss.toFixed(3)}, ${F.alphaRough.toFixed(3)}, smoothstep( 0.2, 0.8, flRough ) )
                                - flFres * ${F.fresnel.toFixed(3)}, ${F.alphaMin.toFixed(3)}, 1.0 );
      `);
    };
    floorMat.customProgramCacheKey = () => 'lt-floor-mirror';
    floorMat.needsUpdate = true;
  }

  return {
    group,
    update(time) {
      if (coneMat) coneMat.uniforms.time.value = time;
    },
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
      if (envRT) { envRT.dispose(); envRT = null; }
    },
  };
}

// ---------------------------------------------------------------- narzędzia

function scaleUv(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
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
  for (let r = 0; r < 12; r += 0.5) {
    const steps = Math.max(1, Math.round(r * 8));
    for (let k = 0; k < steps; k++) {
      const a = (k / steps) * Math.PI * 2;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!insideSolid(world, x, z, A.envBakeHeight, 0.6)) return { x, z };
    }
  }
  return { x: cx, z: cz };
}
