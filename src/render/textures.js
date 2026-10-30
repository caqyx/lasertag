// Proceduralne tekstury (CanvasTexture) — farba UV ×4 style, podłoga, sufit, dym (SPEC §4/§5).
// Wszystko rysowane na canvasie z ziarna (seed) — zero zewnętrznych zasobów.
// createTextures({ size, anisotropy, palette, seed }) → { get(name), paint(style), disposeAll(), size }
// Nazwy: 'paint:stripes' | 'paint:geo' | 'paint:splatter' | 'paint:grid' | 'wall:color' |
//        'floor:color' | 'floor:rough' | 'floor:emissive' | 'ceiling' | 'smoke'
// Farba UV to MASKI kanałów (liniowe): R = kolor A ściany, G = kolor B ściany, B = akcent (drobne elementy, ~8%).
// Kolory przypisuje shader ścian per bryła (arenaBuilder) → 1–2 kolory przewodnie na ścianę, akcent rzadko.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createRng } from '../core/rng.js';

export const PAINT_STYLES = ['stripes', 'geo', 'splatter', 'grid'];

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
    const rng = createRng((seed ^ hashString(name)) >>> 0).next;
    if (name.startsWith('paint:')) tex = finish(drawPaint(name.slice(6), S, palette, rng), { srgb: false });
    else if (name === 'wall:color') tex = finish(drawWallColor(S, rng));
    else if (name === 'steel:grate') tex = finish(drawGrate(Math.min(S, 512), rng));
    else if (name === 'signs') tex = finish(drawSigns(Math.min(S, CONFIG.render.arena.signs.texSize), palette, rng), { repeat: false });
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

// maski kanałów: A (R) częściej niż B (G); akcent (B) tylko w drobnych elementach
const MASK_A = '#ff0000', MASK_B = '#00ff00', MASK_ACC = '#0000ff';
function paletteColors() { return [MASK_A, MASK_A, MASK_A, MASK_B, MASK_B]; }
// kolor drobnego detalu: ~8% akcent
function pickD(rng, cols) { return rng() < T.accentShare ? MASK_ACC : pick(rng, cols); }

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function rr(rng, a, b) { return a + (b - a) * rng(); }

// rysuje fn z przesunięciami ±W (bezszwowe w poziomie)
function wrapX(W, fn) { fn(-W); fn(0); fn(W); }

// ---------------------------------------------------------------- farba UV
// Kafel = T.paintMeters[0] × T.paintMeters[1] m (domyślnie 6 × 2.4).

function drawPaint(style, S, palette, rng) {
  // szerokość kafla: 2.5×S przy dużych teksturach (ostrzejsze krawędzie z bliska), 2×S poniżej
  const W = Math.round(S * (S >= T.paintWideFrom ? T.paintWide : 2));
  const H = Math.round(W * T.paintMeters[1] / T.paintMeters[0]);
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const ppm = W / T.paintMeters[0]; // pikseli na metr
  const cols = paletteColors();
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
  const bands = 3 + Math.floor(rng() * 3);
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
  const groups = 6 + Math.floor(rng() * 4);
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
  // mural skupiony w ~1/2 kafla (różna gęstość na różnych ścianach dzięki losowemu offsetowi u), reszta rzadko
  const muralX = rng() * W, muralW = rr(rng, 2.6, 3.6) * ppm;
  const shapes = 30 + Math.floor(rng() * 10);
  for (let i = 0; i < shapes; i++) {
    const x = rng() < 0.6 ? muralX + (rng() - 0.5) * muralW : rng() * W;
    const y = rr(rng, 0.12, 0.88) * H;
    const r = (rng() < 0.15 ? rr(rng, 0.55, 0.9) : rr(rng, 0.1, 0.45)) * ppm;
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
  // kilka pełnych, małych trójkątów — kontrast grubości (akcenty)
  for (let i = 0; i < 10; i++) {
    const x = muralX + (rng() - 0.5) * muralW * 1.3, y = rr(rng, 0.1, 0.9) * H, r = rr(rng, 0.03, 0.08) * ppm;
    const col = pickD(rng, cols);
    wrapX(W, (dx) => {
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(x + dx, y - r); g.lineTo(x + dx + r, y + r); g.lineTo(x + dx - r, y + r);
      g.closePath(); g.fill();
    });
  }
}

function paintSplatter(g, W, H, ppm, cols, rng) {
  // 1–2 duże kleksy z zaciekami na kafel (kontrast skali z drobnymi skupiskami)
  const bigs = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < bigs; i++) {
    const x = rng() * W, y = rr(rng, 0.25, 0.55) * H, r = rr(rng, 0.1, 0.17) * ppm;
    const col = pick(rng, cols);
    const lobes = [], drips = [];
    for (let k = 0; k < 9; k++) { const a = rng() * Math.PI * 2; lobes.push(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.6, r * rr(rng, 0.3, 0.6)); }
    for (let k = 0; k < 3 + Math.floor(rng() * 3); k++) drips.push(rr(rng, -0.8, 0.8) * r, Math.max(1, r * rr(rng, 0.1, 0.2)), rr(rng, 0.25, 0.8) * ppm);
    wrapX(W, (dx) => {
      g.fillStyle = col;
      g.beginPath(); g.arc(x + dx, y, r, 0, Math.PI * 2); g.fill();
      for (let k = 0; k < lobes.length; k += 3) { g.beginPath(); g.arc(x + dx + lobes[k], y + lobes[k + 1], lobes[k + 2], 0, Math.PI * 2); g.fill(); }
      for (let k = 0; k < drips.length; k += 3) {
        const px = x + dx + drips[k], w = drips[k + 1], len = drips[k + 2];
        g.fillRect(px - w / 2, y, w, len);
        g.beginPath(); g.arc(px, y + len, w * 0.9, 0, Math.PI * 2); g.fill();
      }
    });
  }
  // 2–3 skupiska małych rozbryzgów (różne kształty, obroty, kilka kropel), pył tylko wokół plam; reszta kafla czysta
  const clusters = 5 + Math.floor(rng() * 3);
  for (let c = 0; c < clusters; c++) {
    const cx = (c + rng() * 0.6) / clusters * W, cy = rr(rng, 0.2, 0.75) * H;
    const spread = rr(rng, 0.5, 1.1) * ppm;
    const colA = pick(rng, cols);
    const n = 5 + Math.floor(rng() * 7);
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * spread * 2;
      const y = Math.min(H * 0.85, Math.max(H * 0.1, cy + (rng() - 0.5) * spread));
      const r = rr(rng, 0.02, 0.06) * ppm * (rng() < 0.15 ? 1.8 : 1);
      const col = rng() < 0.7 ? colA : pickD(rng, cols);
      const kind = Math.floor(rng() * 3); // 0 kleks z kroplami, 1 gwiazda (uderzenie), 2 smuga (rozbryzg pod kątem)
      const rot = rng() * Math.PI * 2;
      const stretch = kind === 2 ? rr(rng, 1.4, 2.2) : rr(rng, 0.8, 1.3);
      const spikes = [];
      const ns = kind === 1 ? 7 + Math.floor(rng() * 6) : 3 + Math.floor(rng() * 3);
      for (let k = 0; k < ns; k++) {
        const a = rng() * Math.PI * 2;
        spikes.push(a, r * rr(rng, kind === 1 ? 1.3 : 0.9, kind === 1 ? 2.4 : 1.4), r * rr(rng, 0.12, 0.3));
      }
      const dust = [];
      for (let k = 0; k < 10 + Math.floor(rng() * 14); k++) {
        const a = rng() * Math.PI * 2, d = r * rr(rng, 1.3, 4.0);
        dust.push(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.6, r * rr(rng, 0.04, 0.16)));
      }
      const drips = kind === 0 ? Math.floor(rng() * 3) : 0;
      const dripP = [];
      for (let k = 0; k < drips; k++) dripP.push(rr(rng, -0.6, 0.6) * r, Math.max(1, r * rr(rng, 0.12, 0.22)), rr(rng, 0.08, 0.45) * ppm);
      wrapX(W, (dx) => {
        g.fillStyle = col;
        g.save();
        g.translate(x + dx, y);
        g.rotate(rot);
        g.scale(stretch, 1 / Math.sqrt(stretch));
        g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
        for (let k = 0; k < spikes.length; k += 3) {
          const a = spikes[k], L = spikes[k + 1], w = spikes[k + 2];
          g.beginPath();
          g.moveTo(Math.cos(a + 0.35) * r * 0.6, Math.sin(a + 0.35) * r * 0.6);
          g.lineTo(Math.cos(a) * L, Math.sin(a) * L);
          g.lineTo(Math.cos(a - 0.35) * r * 0.6, Math.sin(a - 0.35) * r * 0.6);
          g.closePath(); g.fill();
          g.beginPath(); g.arc(Math.cos(a) * L, Math.sin(a) * L, w, 0, Math.PI * 2); g.fill();
        }
        g.restore();
        for (let k = 0; k < dust.length; k += 3) {
          g.beginPath(); g.arc(x + dx + dust[k], y + dust[k + 1], dust[k + 2], 0, Math.PI * 2); g.fill();
        }
        for (let k = 0; k < dripP.length; k += 3) {
          const px = x + dx + dripP[k], w = dripP[k + 1], len = dripP[k + 2];
          g.fillRect(px - w / 2, y, w, len);
          g.beginPath(); g.arc(px, y + len, w * 0.9, 0, Math.PI * 2); g.fill();
        }
      });
    }
  }
}

function paintGrid(g, W, H, ppm, cols, rng) {
  // ścieżki PCB na siatce 10 cm, zakręty 45°, pady i przelotki
  const step = 0.1 * ppm;
  const nx = Math.round(W / step);
  const traces = 55 + Math.floor(rng() * 20);
  for (let i = 0; i < traces; i++) {
    const col = pickD(rng, cols);
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

// ---------------------------------------------------------------- ściana (malowana sklejka; kafel = T.wallMeters)

function drawWallColor(S, rng) {
  // ciemny granat, matowe ziarno farby, szwy płyt 1.22 × 2.44 m, przetarcia — albedo ×(≈0.6–1.0) koloru ściany
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    const v = 205 + rng() * 50;
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // pionowe smugi wałka (bardzo subtelne)
  for (let i = 0; i < 30; i++) {
    const x = rng() * S, w = rr(rng, 0.01, 0.04) * S;
    g.fillStyle = `rgba(${rng() < 0.5 ? '0,0,0' : '255,255,255'},${rr(rng, 0.015, 0.04)})`;
    wrapX(S, (dx) => g.fillRect(x + dx, 0, w, S));
  }
  // przetarcia / odbicia butów nisko
  for (let i = 0; i < 18; i++) {
    const x = rng() * S, y = rr(rng, 0.8, 0.98) * S, r = rr(rng, 0.01, 0.04) * S;
    g.fillStyle = 'rgba(255,255,255,0.12)';
    wrapX(S, (dx) => { g.beginPath(); g.ellipse(x + dx, y, r * 2, r * 0.6, 0, 0, Math.PI * 2); g.fill(); });
  }
  // szwy płyt: pion co pół kafla (1.22 m), poziom na krawędzi (2.44 m)
  const seam = Math.max(1, Math.round(S / 400));
  g.fillStyle = 'rgba(0,0,0,0.75)';
  g.fillRect(0, 0, seam, S); g.fillRect(S / 2, 0, seam, S); g.fillRect(0, 0, S, seam);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(seam, 0, seam, S); g.fillRect(S / 2 + seam, 0, seam, S); g.fillRect(0, seam, S, seam);
  return c;
}

// ---------------------------------------------------------------- kratka stalowa (kafel = CONFIG.render.arena.steel.tile)

function drawGrate(S, rng) {
  // krata pomostowa: płaskowniki nośne co ~3 cm, poprzeczki co ~10 cm, otwory ciemne; lekkie przetarcia
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(28,28,34)';
  g.fillRect(0, 0, S, S);
  const n = 16, m = 6;                      // przy kaflu 1.0 m: oczka 6 × 16 cm (bez mory)
  const bw = Math.max(1, S / n * 0.3), cw = Math.max(1, S / m * 0.1);
  for (let i = 0; i < n; i++) {
    const v = 78 + Math.floor(rng() * 16);
    g.fillStyle = `rgb(${v},${v},${v + 8})`;
    g.fillRect(i * S / n, 0, bw, S);
  }
  for (let j = 0; j < m; j++) {
    const v = 70 + Math.floor(rng() * 14);
    g.fillStyle = `rgb(${v},${v},${v + 8})`;
    g.fillRect(0, j * S / m, S, cw);
  }
  for (let k = 0; k < 30; k++) {
    const x = rng() * S, y = rng() * S, r = rr(rng, 0.03, 0.12) * S;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(0,0,0,0.35)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

// ---------------------------------------------------------------- tablice (atlas 4 × 2): litery sektorów A–D, symbol
// promieniowania, strzałka, pasy ostrzegawcze, numer; kolory palety (sRGB), tło przezroczyste (alfa)

export const SIGN_CELLS = { sector: [0, 1, 2, 3], trefoil: 4, arrow: 5, hazard: 6, number: 7 };

function drawSigns(S, palette, rng) {
  const cw = S, ch = S;                       // komórka S × S, atlas 4S × 2S
  const c = makeCanvas(cw * 4, ch * 2);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  const lw = S * 0.035;
  const frame = (x0, y0, col) => {
    g.fillStyle = 'rgba(3,3,8,0.92)';          // ciemne tło tablicy (zasłania farbę ściany pod spodem)
    g.fillRect(x0 + S * 0.06, y0 + S * 0.06, S * 0.88, S * 0.88);
    g.strokeStyle = col; g.lineWidth = lw;
    g.strokeRect(x0 + S * 0.06, y0 + S * 0.06, S * 0.88, S * 0.88);
    g.lineWidth = lw * 0.4;
    g.strokeRect(x0 + S * 0.11, y0 + S * 0.11, S * 0.78, S * 0.78);
  };
  const cols = [palette.primary, palette.secondary, palette.primary, palette.secondary];
  // litery sektorów
  for (let i = 0; i < 4; i++) {
    const x0 = i * cw;
    frame(x0, 0, cols[i]);
    g.fillStyle = cols[(i + 1) % 4];
    g.font = `bold ${Math.round(S * 0.62)}px sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String.fromCharCode(65 + i), x0 + S / 2, S * 0.52);
    // skośne pasy u dołu
    g.fillStyle = palette.accent;
    for (let k = 0; k < 6; k++) {
      const px = x0 + S * (0.16 + k * 0.12);
      g.beginPath(); g.moveTo(px, S * 0.86); g.lineTo(px + S * 0.05, S * 0.86); g.lineTo(px + S * 0.1, S * 0.8); g.lineTo(px + S * 0.05, S * 0.8); g.fill();
    }
  }
  // symbol promieniowania
  {
    const x0 = 0, y0 = ch, cx = x0 + S / 2, cy = y0 + S / 2;
    frame(x0, y0, palette.accent);
    g.fillStyle = palette.accent;
    for (let k = 0; k < 3; k++) {
      const a = -Math.PI / 2 + k * 2 * Math.PI / 3;
      g.beginPath(); g.moveTo(cx, cy);
      g.arc(cx, cy, S * 0.34, a - Math.PI / 6, a + Math.PI / 6); g.closePath(); g.fill();
    }
    g.fillStyle = 'rgba(0,0,0,1)';
    g.beginPath(); g.arc(cx, cy, S * 0.1, 0, Math.PI * 2); g.fill();
    g.fillStyle = palette.accent;
    g.beginPath(); g.arc(cx, cy, S * 0.06, 0, Math.PI * 2); g.fill();
  }
  // strzałka
  {
    const x0 = cw, y0 = ch;
    frame(x0, y0, palette.secondary);
    g.fillStyle = palette.secondary;
    g.beginPath();
    g.moveTo(x0 + S * 0.2, y0 + S * 0.42); g.lineTo(x0 + S * 0.55, y0 + S * 0.42); g.lineTo(x0 + S * 0.55, y0 + S * 0.28);
    g.lineTo(x0 + S * 0.82, y0 + S * 0.5); g.lineTo(x0 + S * 0.55, y0 + S * 0.72); g.lineTo(x0 + S * 0.55, y0 + S * 0.58);
    g.lineTo(x0 + S * 0.2, y0 + S * 0.58); g.closePath(); g.fill();
  }
  // pasy ostrzegawcze (pełny panel)
  {
    const x0 = cw * 2, y0 = ch;
    g.fillStyle = 'rgba(3,3,8,0.92)';
    g.fillRect(x0 + S * 0.06, y0 + S * 0.3, S * 0.88, S * 0.4);
    g.save(); g.beginPath(); g.rect(x0 + S * 0.06, y0 + S * 0.3, S * 0.88, S * 0.4); g.clip();
    g.fillStyle = palette.accent;
    for (let k = -4; k < 12; k++) {
      const px = x0 + k * S * 0.12;
      g.beginPath(); g.moveTo(px, y0 + S * 0.7); g.lineTo(px + S * 0.06, y0 + S * 0.7); g.lineTo(px + S * 0.46, y0 + S * 0.3); g.lineTo(px + S * 0.4, y0 + S * 0.3); g.fill();
    }
    g.restore();
    g.strokeStyle = palette.accent; g.lineWidth = lw * 0.5;
    g.strokeRect(x0 + S * 0.06, y0 + S * 0.3, S * 0.88, S * 0.4);
  }
  // numer sektora / oznaczenie techniczne
  {
    const x0 = cw * 3, y0 = ch;
    frame(x0, y0, palette.primary);
    g.fillStyle = palette.primary;
    g.font = `bold ${Math.round(S * 0.3)}px monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('R-' + String(10 + Math.floor(rng() * 89)), x0 + S / 2, y0 + S * 0.42);
    g.font = `${Math.round(S * 0.11)}px monospace`;
    g.fillText('CORE ACCESS', x0 + S / 2, y0 + S * 0.7);
  }
  return c;
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
  // gumowe kafle: drobne „monety" (wypustki) co ~4 cm, lekko jaśniejsze
  const studs = Math.round(T.floorMeters / 0.04);
  const sp = S / studs, sr = Math.max(0.8, sp * 0.28);
  g.fillStyle = 'rgba(70,64,90,0.55)';
  for (let y = 0; y < studs; y++) {
    for (let x = 0; x < studs; x++) { g.beginPath(); g.arc((x + 0.5) * sp, (y + 0.5) * sp, sr, 0, Math.PI * 2); g.fill(); }
  }
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
