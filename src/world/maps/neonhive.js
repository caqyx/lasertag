// Neon Hive (M4) — SPEC §3.2. Dane mapy (PLAN §1), przetwarzane przez src/world/mapgen.js.
//
// Prawdziwy plaster miodu: komory stykają się bokami (wspólna ściana z przejściem), bez korytarzy.
// Wszystkie wierzchołki leżą na siatce trójkątnej o kroku U = 1.5 m, więc każda ściana biegnie pod 0/60/120°.
//   • komora centralna: heks foremny R = 6.0 m (flat-top: wierzchołki pod 0°, 60°, …),
//   • 6 komór pierścienia: heksy równokątne (wszystkie kąty 120°) o bokach 6.0/3.0/4.5/4.5/4.5/3.0 m —
//     wewnętrzny bok = cały bok komory centralnej, boki 3.0 m to wspólne ściany „szprych” z sąsiadami,
//   • reszta hali: foremne heksy R = 4.5 m (siatka plastra), na obwodzie przycięte prostokątem hali
//     (połówki przy ścianach N/S — spawny N/S; dwie połówki przy ścianie E (W) scalone w komorę spawnu E (W);
//     ćwiartki w narożnikach scalone z komorą narożną).
// Komórki indeksowane (a, r): środek x = 6.75·a, z = 3.897·r (a + r parzyste); sąsiedzi (a, r±2), (a±1, r±1).
// Przejścia (doorways) 2.4 m (komora centralna, pierścień) / 2.2 m (pas zewnętrzny) w środku wspólnego boku
// (kilka przesuniętych, by nie tworzyły długich linii wzroku wzdłuż obwodu); tabela DOORS (każde z obrazem 180°).
// Każda komora ma 2–4 przejścia, więc z wnętrza widać 2–4 pełne skośne ściany + krótkie węgary pozostałych boków.
// Symetria obrotowa 180° — strony N↔S, E↔W są uczciwe.

const CEILING = 4.5;
const WALL_H = 2.4;
const HALF_H = 1.1;
const T = 0.4;            // grubość ścian
const EXT = 0.24;         // wydłużenie segmentu na wierzchołku (zachodzenie brył — brak dziur w narożnikach)
const EXT_BOUND = 0.45;   // wydłużenie segmentu przyciętego obwodem (wchodzi w ścianę obwodową)
const MIN_PIECE = 0.3;    // krótsze kawałki ściany przy przejściu są pomijane

const U = 1.5;            // krok siatki trójkątnej
const SQ3 = Math.sqrt(3);
const W = 27 * U;         // 40.5 m  (x ∈ ±20.25 — oś połówek E/W)
const D = 15 * SQ3 * U;   // ≈ 38.97 m (z ∈ ±19.49 — oś połówek N/S)
const HW = W / 2;
const HD = D / 2;

const DEG = Math.PI / 180;

/** Siatka trójkątna (i, j) → metry. */
const lx = (i, j) => U * (i + j / 2);
const lz = (i, j) => U * j * SQ3 / 2;
/** Obrót o 60° (CCW w układzie x→z) na siatce osiowej. */
const rot60 = ([i, j]) => [-j, i + j];

const HEX3 = [[3, 0], [0, 3], [-3, 3], [-3, 0], [0, -3], [3, -3]];
const HEX4 = [[4, 0], [0, 4], [-4, 4], [-4, 0], [0, -4], [4, -4]];
// komora pierścienia k = 0 (normalna 30°): bok wewnętrzny (0,4)→(4,0), szprycha (4,0)→(6,0), …, szprycha (0,6)→(0,4)
const RING0 = [[0, 4], [4, 0], [6, 0], [6, 3], [3, 6], [0, 6]];
// komórka (a, r) pierścienia → k (normalna 30° + 60°·k)
const RING_K = { '1,1': 0, '0,2': 1, '-1,1': 2, '-1,-1': 3, '0,-2': 4, '1,-1': 5 };

const key = (a, r) => `${a},${r}`;
const cx = (a) => 4.5 * U * a;          // środek komórki (a, r) w metrach
const cz = (r) => 1.5 * SQ3 * U * r;

/** Wierzchołki komórki (a, r) w metrach (CCW). */
function cellPoly(a, r) {
  let pts;
  const k = RING_K[key(a, r)];
  if (a === 0 && r === 0) pts = HEX4;
  else if (k !== undefined) {
    pts = RING0;
    for (let n = 0; n < k; n++) pts = pts.map(rot60);
  } else {
    const ci = (9 * a - 3 * r) / 2; const cj = 3 * r;
    pts = HEX3.map(([i, j]) => [ci + i, cj + j]);
  }
  return pts.map(([i, j]) => [lx(i, j), lz(i, j)]);
}

/** Wszystkie komórki, których środek leży w (domkniętej) hali. */
function cells() {
  const out = [];
  for (let a = -3; a <= 3; a++) {
    for (let r = -5; r <= 5; r++) {
      if ((a + r) & 1) continue;
      if (Math.abs(cx(a)) > HW + 1e-6 || Math.abs(cz(r)) > HD + 1e-6) continue;
      out.push([a, r]);
    }
  }
  return out;
}

// Przejścia między komórkami: [a1, r1, a2, r2, szerokość, przesunięcie wzdłuż boku (m od środka, + ku końcowi o większym x)].
// Każde dodawane razem z obrazem 180°. Para bez wpisu = pełna ściana. OPEN = bez ściany (scalenie komórek).
const DOORS = [
  // komora centralna ↔ pierścień: 4 z 6 boków (oś N–S i przekątna NW–SE); boki ku (1,−1)/(−1,1) pełne
  [0, 0, 0, -2, 2.4, 0],
  [0, 0, -1, -1, 2.4, 0],
  // pierścień ↔ pas zewnętrzny (szprychy między komorami pierścienia — pełne)
  [0, -2, 0, -4, 2.4, 0],     // R N ↔ komora N (oś spawnów N)
  [0, -2, -1, -3, 2.4, 0],
  [-1, -1, -2, 0, 2.4, 0],    // R NW ↔ V W (wejście drużyny W)
  [-1, -1, -2, -2, 2.4, 0],
  [1, -1, 2, 0, 2.4, 0],      // R ENE (bez przejścia do centrum) — flanka N/E
  [1, -1, 1, -3, 2.4, 0],
  [1, -1, 2, -2, 2.4, 0],
  // pas zewnętrzny E / narożniki
  [2, 0, 3, -1, 2.2, -0.8],   // V E ↔ komora spawnu E (przejścia przesunięte — bez linii wzroku wzdłuż ściany E)
  [2, 0, 3, 1, 2.2, -0.8],
  [2, -2, 3, -1, 2.2, 0.8],
  [2, -2, 3, -3, 2.2, 0],
  [-2, -2, -3, -1, 2.2, 0],
  [-2, -2, -3, -3, 2.2, 0],
  [3, -3, 2, -4, 2.2, 0],
  [-3, -3, -2, -4, 2.2, 0],
  [2, -4, 1, -5, 2.2, 0],
  [2, -4, 1, -3, 2.2, 0],
  [-2, -4, -1, -3, 2.2, 0],
  // pas N (spawny)
  [0, -4, 1, -5, 2.2, 0.8],   // komora N ↔ połówki spawnów: przejścia przesunięte od ściany obwodowej (heks-osłona blokuje linię wzdłuż N)
  [0, -4, -1, -5, 2.2, -0.8],
  [-1, -3, -1, -5, 2.2, 0],
];
// Okna strzeleckie (CONFIG.elements.window: parapet 1.1 m + nadproże od 1.85 m) w środku pełnego boku:
// [a1, r1, a2, r2, szerokość okna, przesunięcie od środka boku (m, + ku końcowi o większym x)]; reszta boku = ściana. Każde z obrazem 180°. Okna leżą na liniach ruchu między
// sąsiednimi komorami pierścienia/centrum — dają wgląd i strzał, ale nie skracają drogi (bez linii spawn ↔ spawn).
const WINDOWS = [
  // komora centralna ↔ R ENE (bok 6 m pod 60°): wgląd z centrum na flankę E bez wejścia; okno przesunięte ku narożnikowi
  // przy szewronie E — w środku boku tworzyło linię spawn E ↔ spawn W przez całą mapę (przejście centrum ↔ R NW)
  [0, 0, 1, -1, 1.6, 1.3],
  [0, -2, 1, -3, 1.8, 0],  // R N ↔ V NE (bok 4.5 m pod 60°): krzyżowy ogień na wyjściu drużyny N ku centrum
  [1, -1, 1, 1, 1.6, 0.25],   // szprycha R ENE ↔ R ESE (3 m, 0°): pierścień E widzi się przez okno, przejście tylko przez centrum
];
const OPEN = [
  [2, -4, 3, -5],   // ćwiartki w narożnikach scalone z komorami narożnymi
  [-2, -4, -3, -5],
  [3, -1, 3, 1],    // połówki przy ścianie E scalone w jedną komorę spawnu (obraz: W)
];

function pairKey(a1, r1, a2, r2) {
  const A = key(a1, r1); const B = key(a2, r2);
  return A < B ? `${A}|${B}` : `${B}|${A}`;
}

function doorTable() {
  const doors = new Map();
  for (const [a1, r1, a2, r2, w, off] of DOORS) {
    doors.set(pairKey(a1, r1, a2, r2), { w, off });
    doors.set(pairKey(-a1, -r1, -a2, -r2), { w, off: -off }); // obraz 180° odwraca kierunek „ku większemu x”
  }
  const open = new Set();
  for (const [a1, r1, a2, r2] of OPEN) {
    open.add(pairKey(a1, r1, a2, r2));
    open.add(pairKey(-a1, -r1, -a2, -r2));
  }
  const windows = new Map();
  for (const [a1, r1, a2, r2, w, off] of WINDOWS) {
    windows.set(pairKey(a1, r1, a2, r2), { w, off });
    windows.set(pairKey(-a1, -r1, -a2, -r2), { w, off: -off });
  }
  return { doors, open, windows };
}

/** Odcinek przycięty do hali (Liang–Barsky); null gdy poza / leży na obwodzie. */
function clip(x0, z0, x1, z1) {
  const dx = x1 - x0; const dz = z1 - z0;
  let t0 = 0; let t1 = 1;
  for (const [p, q] of [[-dx, x0 + HW], [dx, HW - x0], [-dz, z0 + HD], [dz, HD - z0]]) {
    if (Math.abs(p) < 1e-9) { if (q < -1e-6) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; } else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  if (t1 - t0 < 1e-6) return null;
  const ax = x0 + dx * t0; const az = z0 + dz * t0; const bx = x0 + dx * t1; const bz = z0 + dz * t1;
  // leży na obwodzie (bok komórki = ściana obwodowa)
  if (Math.abs(az - bz) < 1e-6 && Math.abs(Math.abs(az) - HD) < 0.01) return null;
  if (Math.abs(ax - bx) < 1e-6 && Math.abs(Math.abs(ax) - HW) < 0.01) return null;
  return { ax, az, bx, bz, cutA: t0 > 1e-6, cutB: t1 < 1 - 1e-6 };
}

/** Prostopadłościan wzdłuż odcinka (s0..s1 w metrach od A) na linii A→B. */
function seg(e, s0, s1, extra) {
  const len = Math.hypot(e.bx - e.ax, e.bz - e.az);
  const tx = (e.bx - e.ax) / len; const tz = (e.bz - e.az) / len;
  const mid = (s0 + s1) / 2;
  // oś lokalna X bryły ma iść wzdłuż (tx, tz): świat(lokalne X) = (cos rot, -sin rot)
  const rot = Math.atan2(-tz, tx);
  return { x: e.ax + tx * mid, z: e.az + tz * mid, w: s1 - s0, d: T, h: WALL_H, y: 0, rot, kind: 'wall', ...extra };
}

/** Ściany plastra: unikalne krawędzie komórek, przycięte do hali, z przejściami z DOORS. */
function hiveWalls() {
  const { doors, open, windows } = doorTable();
  const edges = new Map();
  const rk = (v) => Math.round(v * 1000);
  for (const [a, r] of cells()) {
    const p = cellPoly(a, r);
    for (let n = 0; n < 6; n++) {
      const [x0, z0] = p[n]; const [x1, z1] = p[(n + 1) % 6];
      const k1 = `${rk(x0)},${rk(z0)}`; const k2 = `${rk(x1)},${rk(z1)}`;
      const ek = k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
      let e = edges.get(ek);
      if (!e) { e = { x0, z0, x1, z1, cells: [] }; edges.set(ek, e); }
      e.cells.push([a, r]);
    }
  }
  const out = [];
  // kolejność deterministyczna (wygląd z seed zależy od kolejności brył)
  const list = [...edges.values()].sort((A, B) => (A.z0 + A.z1) - (B.z0 + B.z1) || (A.x0 + A.x1) - (B.x0 + B.x1));
  for (const E of list) {
    const c = clip(E.x0, E.z0, E.x1, E.z1);
    if (!c) continue;
    let door = null;
    let win = null;
    if (E.cells.length === 2) {
      const pk = pairKey(...E.cells[0], ...E.cells[1]);
      if (open.has(pk)) continue;
      door = doors.get(pk) || null;
      win = windows.get(pk) || null;
    }
    const central = E.cells.some(([a, r]) => a === 0 && r === 0);
    const extra = central ? { paint: 'geo' } : undefined;
    const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
    const s0 = c.cutA ? -EXT_BOUND : -EXT;
    const s1 = len + (c.cutB ? EXT_BOUND : EXT);
    if (win) {
      // okno w boku (boki z oknami nie są przycinane obwodem): ściana | okno | ściana, styk bez szczeliny
      const dir = c.bx - c.ax > 1e-6 || (Math.abs(c.bx - c.ax) <= 1e-6 && c.bz > c.az) ? 1 : -1;
      const m = len / 2 + win.off * dir;
      const g0 = m - win.w / 2; const g1 = m + win.w / 2;
      out.push(seg(c, s0, g0, extra));
      out.push({ ...seg(c, g0, g1, extra), kind: 'window', h: undefined });
      out.push(seg(c, g1, s1, extra));
      continue;
    }
    if (!door) { out.push(seg(c, s0, s1, extra)); continue; }
    // środek przejścia: środek pełnego boku (przed przycięciem) + przesunięcie
    const fullMidX = (E.x0 + E.x1) / 2; const fullMidZ = (E.z0 + E.z1) / 2;
    const tx = (c.bx - c.ax) / len; const tz = (c.bz - c.az) / len;
    const dir = c.bx - c.ax > 1e-6 || (Math.abs(c.bx - c.ax) <= 1e-6 && c.bz > c.az) ? 1 : -1;
    const m = (fullMidX - c.ax) * tx + (fullMidZ - c.az) * tz + door.off * dir;
    const g0 = m - door.w / 2; const g1 = m + door.w / 2;
    if (g0 - s0 >= MIN_PIECE) out.push(seg(c, s0, g0, extra));
    if (s1 - g1 >= MIN_PIECE) out.push(seg(c, g1, s1, extra));
  }
  return out;
}

/** Bryła prostokątna. */
function box(x, z, w, d, h, kind, rot = 0, extra) {
  return { x, z, w, d, h, y: 0, rot, kind, ...extra };
}

/** Heksagonalny graniastosłup (flat-top, promień r) jako 3 nachodzące prostokąty r × 2·apotema pod 0/60/120°. */
function hexPrism(x, z, r, h, kind) {
  const ap = r * SQ3 / 2;
  return [0, 60, 120].map((deg) => box(x, z, r, 2 * ap, h, kind, deg * DEG));
}

/** Dodaje bryły i ich obrazy w obrocie o 180° (symetria). */
function sym(list, items) {
  for (const b of items) {
    list.push(b);
    list.push({ ...b, x: -b.x, z: -b.z });
  }
}

function buildWalls() {
  const walls = hiveWalls();

  // komora centralna: heksagonalny filar do sufitu + dwa szewrony (osłony połówkowe) w narożnikach E/W —
  // ramiona równoległe do ścian komory (pod ±60°), 1.6 m od nich: mniejszy heks „wpisany” w narożnik
  walls.push(...hexPrism(0, 0, 1.3, CEILING, 'pillar'));
  {
    const vx = 3.2 / Math.cos(30 * DEG); // wierzchołek szewronu na osi X (apotema linii ramion 3.2 m)
    const t = [0.5, SQ3 / 2];            // kierunek ramienia (bok o normalnej −30°)
    sym(walls, [
      box(vx - 0.8 * t[0], -0.8 * t[1], 2.0, 0.4, HALF_H, 'half', -60 * DEG),
      box(vx - 0.8 * t[0], 0.8 * t[1], 2.0, 0.4, HALF_H, 'half', 60 * DEG),
    ]);
  }

  // komory pierścienia: heksagonalna osłona połówkowa w środku (R N/S i R NW/SE) lub filar (R ENE/WSW — bez wejścia do centrum)
  const ringCentroid = (a, r) => {
    const c = cellPoly(a, r);
    return [c.reduce((sx, q) => sx + q[0], 0) / 6, c.reduce((sz, q) => sz + q[1], 0) / 6];
  };
  for (const [a, r] of [[0, -2], [-1, -1]]) sym(walls, hexPrism(...ringCentroid(a, r), 0.75, HALF_H, 'half'));
  { const [x, z] = ringCentroid(1, -1); sym(walls, [box(x, z, 0.8, 0.8, CEILING, 'pillar', 30 * DEG)]); }

  // komory zewnętrzne: heks-osłona połówkowa / filar / osłona pod 60°
  sym(walls, hexPrism(cx(2), cz(0), 0.7, HALF_H, 'half'));                 // V E (przed spawnami E)
  sym(walls, hexPrism(cx(0), cz(-4) - 1.3, 0.8, HALF_H, 'half'));          // komora N (między spawnami N, przy ścianie obwodowej)
  sym(walls, hexPrism(cx(1), cz(-3), 0.7, HALF_H, 'half'));                // V NE
  sym(walls, [box(cx(-1), cz(-3), 0.7, 0.7, CEILING, 'pillar', 30 * DEG)]); // V NW
  sym(walls, [box(cx(2), cz(-2), 2.0, 0.45, HALF_H, 'half', 60 * DEG)]);   // ENE
  sym(walls, [box(cx(-2), cz(-2), 2.0, 0.45, HALF_H, 'half', -60 * DEG)]); // WNW
  sym(walls, [box(cx(2) + 0.4, cz(-4), 0.7, 0.7, CEILING, 'pillar', 30 * DEG)]);  // narożnik NE
  sym(walls, [box(cx(-2), cz(-4) + 0.3, 2.0, 0.45, HALF_H, 'half', 0)]);   // narożnik NW

  // stosy opon (CONFIG.elements.tires) w miejscach bez osłon: oś N–S komory centralnej przed przejściem z R N
  // (szewrony osłaniają tylko E/W) i otwarty narożnik NE (sam filar); ≥ 1.4 m od innych brył (bez strefy zahaczania)
  sym(walls, [{ kind: 'tires', x: 0, z: -3.25 }, { kind: 'tires', x: 16, z: -17.25 }]);
  return walls;
}

/** yaw 'auto': mapgen wybiera kierunek z najdłuższą linią wzroku (ku środkowi przy remisie). */
function spawn(x, z, team) {
  return { x, z, y: 0, yaw: 'auto', team };
}

export default {
  id: 'neonhive',
  name: 'Neon Hive',
  seed: 4242,
  size: { w: W, d: D },
  ceiling: CEILING,
  perimeter: { h: CEILING, paint: 'geo' },
  palette: {
    primary: '#ffb000',   // bursztyn
    secondary: '#ff5a1f', // pomarańcz
    uv: '#18e0ff',        // cyjan
    accent: '#ff3d9a',    // róż
    fog: '#05080b',     // prawie czarna, lekko chłodna (wcześniej #120806 dawał czerwono-brązową zupę pod sufitem)
    ambient: '#26140a',
  },
  walls: buildWalls(),
  ramps: [],
  decor: [],
  // kolejność = priorytet: 2 → przekątna NE/SW, 4 → + oś E/W, 6 → + środek ×2, 8 → + komory N/S
  lights: [
    { x: 6.75, y: 4.2, z: -11.69, color: '#ffb000', intensity: 10, range: 13 },  // V NE
    { x: -6.75, y: 4.2, z: 11.69, color: '#ffb000', intensity: 10, range: 13 },  // V SW
    { x: 13.5, y: 4.2, z: 0, color: '#18e0ff', intensity: 10, range: 13 },       // V E
    { x: -13.5, y: 4.2, z: 0, color: '#18e0ff', intensity: 10, range: 13 },      // V W
    { x: 2.6, y: 4.2, z: 0, color: '#ff5a1f', intensity: 9, range: 12 },         // komora centralna E
    { x: -2.6, y: 4.2, z: 0, color: '#ff5a1f', intensity: 9, range: 12 },        // komora centralna W
    { x: 0, y: 4.2, z: -15.59, color: '#ff3d9a', intensity: 7, range: 11 },      // komora N (akcent)
    { x: 0, y: 4.2, z: 15.59, color: '#ff3d9a', intensity: 7, range: 11 },       // komora S (akcent)
  ],
  // team = strona: N (z min) 0, S 1, E (x max) 2, W 3 (przeciwne strony: 0↔1, 2↔3); spawny w połówkach heksów przy obwodzie.
  // tdm2 (team % 2): N+E = 0, S+W = 1 — przy symetrii 180° dokładne lustro.
  spawns: [
    spawn(-6.75, -17.9, 0), spawn(6.75, -17.9, 0),
    spawn(6.75, 17.9, 1), spawn(-6.75, 17.9, 1),
    spawn(18.9, -3.9, 2), spawn(18.9, 3.9, 2),
    spawn(-18.9, 3.9, 3), spawn(-18.9, -3.9, 3),
  ],
  cams: [
    { name: 'overview', pos: [-2.5, 4.2, -11], look: [0, 0, -3.7] },
    { name: 'corridor', pos: [16.9, 1.65, -2.4], look: [9.6, 1.3, 1.2] },
    { name: 'plaza', pos: [1.6, 1.65, -3.6], look: [4.5, 1.3, 2.6] },
    { name: 'spawn', pos: [-18.9, 1.65, 3.9], look: [-13.5, 1.4, 0] },
    { name: 'corner', pos: [19.4, 1.65, -18.7], look: [11, 1.3, -12.5] },
    // okno strzeleckie komora centralna ↔ R ENE (widok z centrum przez otwór na filar R ENE i okno szprychy)
    { name: 'window', pos: [2.4, 1.65, 0.1], look: [8.5, 1.3, -3.6] },
  ],
};

