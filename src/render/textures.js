// Proceduralne tekstury (CanvasTexture) — farba UV ×4 style, podłoga, sufit, dym (SPEC §4/§5).
// Wszystko rysowane na canvasie z ziarna (seed) — zero zewnętrznych zasobów.
// createTextures({ size, anisotropy, palette, seed }) → { get(name), paint(style), disposeAll(), size }
// Nazwy: 'paint:stripes' | 'paint:geo' | 'paint:splatter' | 'paint:grid' |
//        'floor:color' | 'floor:rough' | 'floor:emissive' | 'ceiling' | 'smoke'
import * as THREE from 'three';
import { CONFIG } from '../config.js';

export const PAINT_STYLES = ['stripes', 'geo', 'splatter', 'grid'];

// Lokalny mulberry32 (deterministyczny; orkiestrator może podmienić na src/core/rng.js).
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const T = CONFIG.render.textures;

export function createTextures({ size, anisotropy, palette, seed }) {
  const cache = new Map();
  const S = size;

  function finish(canvas, { srgb = true, repeat = true, mips = true } = {}) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    tex.anisotropy = anisotropy;
    tex.generateMipmaps = mips;
    tex.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  function get(name) {
    let tex = cache.get(name);
    if (tex) return tex;
    const rng = makeRng((seed ^ hashString(name)) >>> 0);
    if (name.startsWith('paint:')) tex = finish(drawPaint(name.slice(6), S, palette, rng));
    else if (name === 'floor:color') tex = finish(drawFloorColor(S, rng));
    else if (name === 'floor:rough') tex = finish(drawFloorRough(S, rng), { srgb: false });
    else if (name === 'floor:emissive') tex = finish(drawFloorEmissive(S, palette));
    else if (name === 'ceiling') tex = finish(drawCeiling(S, rng));
    else if (name === 'smoke') tex = finish(drawSmoke(Math.min(S, T.smokeSize), rng), { srgb: false, repeat: false });
    else throw new Error(`textures: nieznana tekstura '${name}'`);
    tex.name = name;
    cache.set(name, tex);
    return tex;
  }

  return {
    size: S,
    get,
    paint: (style) => get('paint:' + style),
    disposeAll() {
      for (const tex of cache.values()) tex.dispose();
      cache.clear();
    },
  };
}

// ---------------------------------------------------------------- pomocnicze

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function paletteColors(palette) {
  // wagi: primary/secondary/uv przewodnie, accent rzadko
  return [palette.primary, palette.secondary, palette.uv, palette.primary, palette.secondary, palette.uv, palette.accent];
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function rr(rng, a, b) { return a + (b - a) * rng(); }

// rysuje fn z przesunięciami ±W (bezszwowe w poziomie)
function wrapX(W, fn) { fn(-W); fn(0); fn(W); }

// ---------------------------------------------------------------- farba UV
// Kafel = T.paintMeters[0] × T.paintMeters[1] m (domyślnie 6 × 2.4).

function drawPaint(style, S, palette, rng) {
  const W = S * 2;
  const H = Math.round(S * 0.8);
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const ppm = W / T.paintMeters[0]; // pikseli na metr
  const cols = paletteColors(palette);
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  if (style === 'stripes') paintStripes(g, W, H, ppm, cols, rng);
  else if (style === 'geo') paintGeo(g, W, H, ppm, cols, rng);
  else if (style === 'splatter') paintSplatter(g, W, H, ppm, cols, rng);
  else if (style === 'grid') paintGrid(g, W, H, ppm, cols, rng);
  else throw new Error(`textures: nieznany styl farby '${style}'`);
  return c;
}

function paintStripes(g, W, H, ppm, cols, rng) {
  // 1) poziome pakiety taśm (grube + cienkie), pełna szerokość — bezszwowe
  const bands = 2 + Math.floor(rng() * 2);
  for (let b = 0; b < bands; b++) {
    let y = rr(rng, 0.1, 0.9) * H;
    const col = pick(rng, cols);
    const n = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) {
      const th = (i === 0 ? rr(rng, 0.05, 0.14) : rr(rng, 0.008, 0.035)) * ppm;
      g.fillStyle = i % 2 && rng() < 0.4 ? pick(rng, cols) : col;
      g.fillRect(0, y, W, th);
      y += th + rr(rng, 0.015, 0.06) * ppm;
    }
  }
  // 2) ukośne segmenty taśmy (szewrony / „chevron"), w kilku miejscach kafla
  const groups = 3 + Math.floor(rng() * 3);
  for (let k = 0; k < groups; k++) {
    const x0 = rng() * W;
    const yC = rr(rng, 0.2, 0.8) * H;
    const len = rr(rng, 0.5, 1.6) * ppm;
    const hgt = rr(rng, 0.4, 1.2) * ppm;
    const dir = rng() < 0.5 ? 1 : -1;
    const count = 2 + Math.floor(rng() * 5);
    const th = rr(rng, 0.03, 0.09) * ppm;
    const gap = th + rr(rng, 0.03, 0.12) * ppm;
    const col = pick(rng, cols);
    const chevron = rng() < 0.5;
    wrapX(W, (dx) => {
      g.fillStyle = col;
      for (let i = 0; i < count; i++) {
        const ox = x0 + dx + i * gap * 1.6;
        g.beginPath();
        if (chevron) {
          g.moveTo(ox, yC - hgt / 2);
          g.lineTo(ox + hgt / 2 * dir, yC);
          g.lineTo(ox, yC + hgt / 2);
          g.lineTo(ox + th, yC + hgt / 2);
          g.lineTo(ox + th + hgt / 2 * dir, yC);
          g.lineTo(ox + th, yC - hgt / 2);
        } else {
          g.moveTo(ox, yC - hgt / 2);
          g.lineTo(ox + len * 0.3 * dir, yC + hgt / 2);
          g.lineTo(ox + len * 0.3 * dir + th, yC + hgt / 2);
          g.lineTo(ox + th, yC - hgt / 2);
        }
        g.closePath();
        g.fill();
      }
    });
  }
  // 3) cienkie linie-detal (Ultra)
  const thin = 6 + Math.floor(rng() * 6);
  for (let i = 0; i < thin; i++) {
    const y = rng() * H;
    const x = rng() * W;
    const l = rr(rng, 0.4, 2.5) * ppm;
    g.fillStyle = pick(rng, cols);
    wrapX(W, (dx) => g.fillRect(x + dx, y, l, Math.max(1, 0.006 * ppm)));
  }
}

function paintGeo(g, W, H, ppm, cols, rng) {
  const shapes = 16 + Math.floor(rng() * 8);
  for (let i = 0; i < shapes; i++) {
    const x = rng() * W;
    const y = rr(rng, 0.12, 0.88) * H;
    const r = rr(rng, 0.12, 0.6) * ppm;
    const lw = (rng() < 0.35 ? rr(rng, 0.006, 0.014) : rr(rng, 0.025, 0.06)) * ppm;
    const col = pick(rng, cols);
    const type = Math.floor(rng() * 5);
    const rot = rng() < 0.6 ? 0 : rng() * Math.PI;
    const rings = rng() < 0.3 ? 2 + Math.floor(rng() * 2) : 1;
    wrapX(W, (dx) => {
      g.save();
      g.translate(x + dx, y);
      g.rotate(rot);
      g.strokeStyle = col;
      g.lineWidth = Math.max(1, lw);
      for (let k = 0; k < rings; k++) {
        const rk = r * (1 - k * 0.28);
        g.beginPath();
        if (type === 0) { // trójkąt
          for (let j = 0; j < 3; j++) {
            const a = -Math.PI / 2 + j * 2 * Math.PI / 3;
            j ? g.lineTo(Math.cos(a) * rk, Math.sin(a) * rk) : g.moveTo(Math.cos(a) * rk, Math.sin(a) * rk);
          }
          g.closePath();
        } else if (type === 1) { // romb
          g.moveTo(0, -rk); g.lineTo(rk * 0.7, 0); g.lineTo(0, rk); g.lineTo(-rk * 0.7, 0); g.closePath();
        } else if (type === 2) { // okrąg
          g.arc(0, 0, rk, 0, Math.PI * 2);
        } else if (type === 3) { // sześciokąt
          for (let j = 0; j < 6; j++) {
            const a = j * Math.PI / 3;
            j ? g.lineTo(Math.cos(a) * rk, Math.sin(a) * rk) : g.moveTo(Math.cos(a) * rk, Math.sin(a) * rk);
          }
          g.closePath();
        } else { // kwadrat
          g.rect(-rk * 0.75, -rk * 0.75, rk * 1.5, rk * 1.5);
        }
        g.stroke();
      }
      // czasem wypełniony mały element w środku
      if (rng() < 0.25) {
        g.fillStyle = col;
        g.beginPath();
        g.arc(0, 0, r * 0.12, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    });
  }
  // kilka pełnych, małych trójkątów — kontrast grubości
  for (let i = 0; i < 10; i++) {
    const x = rng() * W, y = rr(rng, 0.1, 0.9) * H, r = rr(rng, 0.04, 0.12) * ppm;
    const col = pick(rng, cols);
    wrapX(W, (dx) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x + dx, y - r); g.lineTo(x + dx + r, y + r); g.lineTo(x + dx - r, y + r);
      g.closePath(); g.fill();
    });
  }
}

function paintSplatter(g, W, H, ppm, cols, rng) {
  const splats = 6 + Math.floor(rng() * 4);
  for (let i = 0; i < splats; i++) {
    const x = rng() * W;
    const y = rr(rng, 0.15, 0.75) * H;
    const r = rr(rng, 0.06, 0.2) * ppm;
    const col = pick(rng, cols);
    const sat = 14 + Math.floor(rng() * 20);
    const drips = 2 + Math.floor(rng() * 5);
    // parametry losowane z góry (wrapX rysuje 3×)
    const satP = [];
    for (let k = 0; k < sat; k++) {
      const a = rng() * Math.PI * 2;
      const d = r * rr(rng, 0.7, 2.6);
      satP.push(Math.cos(a) * d, Math.sin(a) * d * 0.85, r * rr(rng, 0.03, 0.22) * (1.6 - d / (r * 2.6)));
    }
    const dripP = [];
    for (let k = 0; k < drips; k++) {
      dripP.push(rr(rng, -0.8, 0.8) * r, rr(rng, 0.04, 0.12) * r + 0.004 * ppm, rr(rng, 0.2, 0.9) * ppm);
    }
    const lobes = [];
    for (let k = 0; k < 7; k++) {
      const a = rng() * Math.PI * 2;
      lobes.push(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * rr(rng, 0.35, 0.65));
    }
    wrapX(W, (dx) => {
      g.fillStyle = col;
      g.beginPath(); g.arc(x + dx, y, r, 0, Math.PI * 2); g.fill();
      for (let k = 0; k < lobes.length; k += 3) {
        g.beginPath(); g.arc(x + dx + lobes[k], y + lobes[k + 1], lobes[k + 2], 0, Math.PI * 2); g.fill();
      }
      for (let k = 0; k < satP.length; k += 3) {
        g.beginPath(); g.arc(x + dx + satP[k], y + satP[k + 1], Math.max(1, satP[k + 2]), 0, Math.PI * 2); g.fill();
      }
      for (let k = 0; k < dripP.length; k += 3) {
        const dxk = x + dx + dripP[k], w = dripP[k + 1], len = dripP[k + 2];
        g.fillRect(dxk - w / 2, y, w, len);
        g.beginPath(); g.arc(dxk, y + len, w * 0.9, 0, Math.PI * 2); g.fill();
      }
    });
  }
  // drobny pył farby
  for (let i = 0; i < 260; i++) {
    const x = rng() * W, y = rng() * H, r = rr(rng, 0.002, 0.012) * ppm;
    g.fillStyle = pick(rng, cols);
    g.beginPath(); g.arc(x, y, Math.max(0.7, r), 0, Math.PI * 2); g.fill();
  }
}

function paintGrid(g, W, H, ppm, cols, rng) {
  // ścieżki PCB na siatce 10 cm, zakręty 45°, pady i przelotki
  const step = 0.1 * ppm;
  const nx = Math.round(W / step);
  const traces = 34 + Math.floor(rng() * 16);
  for (let i = 0; i < traces; i++) {
    const col = pick(rng, cols);
    const lw = (rng() < 0.6 ? rr(rng, 0.008, 0.016) : rr(rng, 0.02, 0.035)) * ppm;
    const pts = [];
    let x = Math.floor(rng() * nx) * step;
    let y = Math.floor(rr(rng, 0.08, 0.92) * H / step) * step;
    pts.push(x, y);
    const segs = 2 + Math.floor(rng() * 4);
    for (let s = 0; s < segs; s++) {
      const len = (2 + Math.floor(rng() * 9)) * step;
      const dir = Math.floor(rng() * 4);
      if (dir === 0) x += len;
      else if (dir === 1) x -= len;
      else if (dir === 2) { x += len * 0.7; y += (rng() < 0.5 ? 1 : -1) * len * 0.7; }
      else { y += (rng() < 0.5 ? 1 : -1) * len * 0.5; }
      y = Math.min(H * 0.95, Math.max(H * 0.05, y));
      pts.push(x, y);
    }
    const padEnd = rng() < 0.7;
    wrapX(W, (dx) => {
      g.strokeStyle = col;
      g.fillStyle = col;
      g.lineWidth = Math.max(1, lw);
      g.beginPath();
      g.moveTo(pts[0] + dx, pts[1]);
      for (let k = 2; k < pts.length; k += 2) g.lineTo(pts[k] + dx, pts[k + 1]);
      g.stroke();
      // pad na początku, przelotka (pierścień) na końcu
      const pr = Math.max(2, lw * 2.2);
      g.beginPath(); g.arc(pts[0] + dx, pts[1], pr, 0, Math.PI * 2); g.fill();
      const ex = pts[pts.length - 2] + dx, ey = pts[pts.length - 1];
      g.beginPath();
      if (padEnd) { g.arc(ex, ey, pr * 1.4, 0, Math.PI * 2); g.lineWidth = Math.max(1, lw * 0.8); g.stroke(); }
      else { g.rect(ex - pr * 1.5, ey - pr * 1.5, pr * 3, pr * 3); g.fill(); }
    });
  }
  // „układy scalone" — prostokąty konturowe z nóżkami
  const chips = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < chips; i++) {
    const w = rr(rng, 0.25, 0.6) * ppm, h = rr(rng, 0.18, 0.4) * ppm;
    const x = rng() * W, y = rr(rng, 0.2, 0.8) * H - h / 2;
    const col = pick(rng, cols);
    const pins = Math.floor(w / (0.05 * ppm));
    wrapX(W, (dx) => {
      g.strokeStyle = col; g.fillStyle = col;
      g.lineWidth = Math.max(1, 0.012 * ppm);
      g.strokeRect(x + dx, y, w, h);
      for (let p = 0; p < pins; p++) {
        const px = x + dx + (p + 0.5) * (w / pins) - 0.008 * ppm;
        g.fillRect(px, y - 0.05 * ppm, 0.016 * ppm, 0.04 * ppm);
        g.fillRect(px, y + h + 0.01 * ppm, 0.016 * ppm, 0.04 * ppm);
      }
    });
  }
}

// ---------------------------------------------------------------- podłoga (kafel = T.floorMeters)

function drawFloorColor(S, rng) {
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const n = rng();
    const v = 7 + n * n * 14; // czarna guma z drobnym ziarnem
    d[i * 4] = v; d[i * 4 + 1] = v * 0.95; d[i * 4 + 2] = v * 1.15; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // szwy mat co 1 m (ciemniejsze)
  g.fillStyle = 'rgba(0,0,0,0.85)';
  const seam = Math.max(1, S / 512);
  for (let k = 0; k < T.floorMeters; k++) {
    const p = (k / T.floorMeters) * S;
    g.fillRect(p, 0, seam, S);
    g.fillRect(0, p, S, seam);
  }
  return c;
}

function drawFloorRough(S, rng) {
  // roughnessMap (kanał G): ziarno + łaty wytarcia (gładsze = bardziej błyszczące)
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(150,150,150)';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 40; i++) {
    const x = rng() * S, y = rng() * S, r = rr(rng, 0.05, 0.25) * S;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(70,70,70,0.6)');
    grd.addColorStop(1, 'rgba(70,70,70,0)');
    g.fillStyle = grd;
    wrapX(S, (dx) => g.fillRect(x + dx - r, y - r, r * 2, r * 2));
  }
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const v = Math.max(0, Math.min(255, d[i * 4 + 1] + (rng() - 0.5) * 90));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawFloorEmissive(S, palette) {
  // bardzo subtelna emisyjna siatka (kolor uv) na krawędzi kafla → linie co T.floorMeters m
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  const lw = Math.max(1, Math.round(S * T.floorLine / T.floorMeters));
  g.fillStyle = palette.uv;
  g.fillRect(0, 0, lw, S);
  g.fillRect(0, 0, S, lw);
  // znaczniki krzyżowe w środku kafla (bardzo drobne)
  const m = S / 2, k = S * 0.03;
  g.globalAlpha = 0.5;
  g.fillRect(m - k, m - lw / 2, k * 2, lw);
  g.fillRect(m - lw / 2, m - k, lw, k * 2);
  g.globalAlpha = 1;
  return c;
}

// ---------------------------------------------------------------- sufit

function drawCeiling(S, rng) {
  // ciemne panele akustyczne 1.2 m z perforacją, jasność bliska zeru (widoczne tylko w świetle lamp)
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(16,15,22)';
  g.fillRect(0, 0, S, S);
  const n = 4;
  const p = S / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const v = 14 + Math.floor(rng() * 10);
      g.fillStyle = `rgb(${v},${v - 1},${v + 6})`;
      g.fillRect(i * p + 2, j * p + 2, p - 4, p - 4);
    }
  }
  g.fillStyle = 'rgba(0,0,0,0.6)';
  const hole = Math.max(1, S / 256);
  for (let y = p / 16; y < S; y += p / 8) {
    for (let x = p / 16; x < S; x += p / 8) g.fillRect(x, y, hole, hole);
  }
  return c;
}

// ---------------------------------------------------------------- dym

function drawSmoke(S, rng) {
  // miękki „puch": nałożone radialne gradienty + drobny szum, maska radialna → alfa 0 na brzegach
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * 0.22 * S;
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const r = rr(rng, 0.12, 0.3) * S;
    const k = rr(rng, 0.05, 0.14);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(255,255,255,${k})`);
    grd.addColorStop(0.5, `rgba(255,255,255,${k * 0.45})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.globalCompositeOperation = 'source-over';
  const img = g.getImageData(0, 0, S, S);
  const d = img.data;
  // szum wartościowy niskiej częstotliwości (bilinear z siatki 8×8) — nieregularność kłębów
  const N = 8;
  const grid = new Float32Array((N + 1) * (N + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const vals = new Float32Array(S * S);
  let vmax = 1e-6;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const fx = (x / S) * N, fy = (y / S) * N;
      const ix = Math.floor(fx), iy = Math.floor(fy);
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = grid[iy * (N + 1) + ix], b = grid[iy * (N + 1) + ix + 1];
      const cc = grid[(iy + 1) * (N + 1) + ix], dd = grid[(iy + 1) * (N + 1) + ix + 1];
      const nval = (a + (b - a) * sx) * (1 - sy) + (cc + (dd - cc) * sx) * sy;
      const dx = x / S - 0.5, dy = y / S - 0.5;
      const rad = Math.sqrt(dx * dx + dy * dy) * 2; // 0 środek, 1 brzeg
      const mask = Math.max(0, 1 - rad);
      const m = mask * mask * (3 - 2 * mask);
      const i = (y * S + x) * 4;
      const v = (d[i] / 255) * (0.55 + 0.9 * nval) * m;
      vals[y * S + x] = v;
      if (v > vmax) vmax = v;
    }
  }
  // normalizacja: szczyt gęstości = 1 (jasność steruje CONFIG.smoke)
  for (let k = 0; k < S * S; k++) {
    const o = Math.round((vals[k] / vmax) * 255);
    d[k * 4] = d[k * 4 + 1] = d[k * 4 + 2] = o;
    d[k * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}
