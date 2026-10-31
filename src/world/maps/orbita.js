// Orbita — sala-obserwatorium z trzema koncentrycznymi ośmiokątami. Dane mapy (PLAN §1), przetwarzane przez mapgen.js.
//
// Ośmiokąty foremne „flat” (boki N/E/S/W + 4 przekątne), środek w (0,0). Bok i ma normalną pod kątem 45°·i w płaszczyźnie
// (x, z): i = 0 E (+x), 2 S (+z), 4 W, 6 N; nieparzyste = przekątne (1 SE, 3 SW, 5 NW, 7 NE).
//   • pierścień zewnętrzny (apotema 15 m): pełne boki N/E/S/W, przejścia 3.0 m na przekątnych → narożniki hali,
//   • pierścień środkowy (apotema 9.5 m): przejścia 3.0 m na bokach N/E/S/W, przekątne pełne,
//   • rdzeń (apotema 4.5 m): osłony połówkowe na bokach N/E/S/W, przekątne otwarte, filar-romb w środku.
// Przejścia kolejnych pierścieni są obrócone o 45° — do środka idzie się spiralą, bez linii wzroku na wylot.
// Pas spawnów między pierścieniem zewnętrznym a obwodem (4.8 m) przecina pośrodku osłona połówkowa każdej strony.
// Symetria obrotowa 180° (x, z) → (−x, −z); spawny team = strona (N 0, S 1, E 2, W 3).

const CEILING = 5;
const WALL_H = 2.4;
const HALF_H = 1.1;
const T = 0.4;                 // grubość ścian pierścieni
const DEG = Math.PI / 180;
const TAN = Math.tan(22.5 * DEG);
const EXT = T / 2 * TAN + 0.04; // wydłużenie segmentu na wierzchołku ośmiokąta (zachodzenie, brak szpar w narożu)

const R_OUT = 15;
const R_MID = 9.5;
const R_CORE = 4.5;
const GAP = 3.0;               // szerokość przejść w pierścieniach

/** Prostopadłościan; rot w radianach jak Object3D.rotation.y (lokalne X = świat (cos rot, −sin rot)). */
function box(x, z, w, d, h, kind, rot = 0, extra) {
  return { x, z, w, d, h, y: 0, rot, kind, ...extra };
}

/** Kawałek boku i ośmiokąta o apotemie a: od s0 do s1 [m] wzdłuż stycznej (0 = środek boku). */
function sidePiece(a, i, s0, s1, h, kind, extra) {
  const th = 45 * i * DEG;
  const nx = Math.cos(th); const nz = Math.sin(th);
  const tx = -nz; const tz = nx;               // styczna
  const mid = (s0 + s1) / 2;
  const rot = Math.atan2(-tz, tx);
  return box(a * nx + tx * mid, a * nz + tz * mid, s1 - s0, T, h, kind, rot, extra);
}

/** Pierścień: boki z listy open (indeksy) mają przejście GAP pośrodku; boki z listy skip pominięte. */
function ring(a, open, skip, h, kind, extra) {
  const half = a * TAN;
  const out = [];
  for (let i = 0; i < 8; i++) {
    if (skip.includes(i)) continue;
    if (open.includes(i)) {
      out.push(sidePiece(a, i, -half - EXT, -GAP / 2, h, kind, extra));
      out.push(sidePiece(a, i, GAP / 2, half + EXT, h, kind, extra));
    } else {
      out.push(sidePiece(a, i, -half - EXT, half + EXT, h, kind, extra));
    }
  }
  return out;
}

/** Punkt w odległości r od środka pod kątem 45°·i. */
const polar = (r, i) => [r * Math.cos(45 * i * DEG), r * Math.sin(45 * i * DEG)];

/** Dodaje bryły i ich obrazy w obrocie o 180°. */
function sym(list, items) {
  for (const b of items) {
    list.push(b);
    list.push({ ...b, x: -b.x, z: -b.z });
  }
}

function buildWalls() {
  const w = [];
  w.push(...ring(R_OUT, [1, 3, 5, 7], [], WALL_H, 'wall', { paint: 'stripes' }));
  w.push(...ring(R_MID, [0, 2, 4, 6], [], WALL_H, 'wall', { paint: 'geo' }));
  // rdzeń: tylko boki N/E/S/W jako osłony połówkowe (przekątne otwarte)
  for (const i of [0, 2, 4, 6]) {
    const half = R_CORE * TAN;
    w.push(sidePiece(R_CORE, i, -half, half, HALF_H, 'half', { trim: 'accent' }));
  }
  // filar-romb w środku (do sufitu)
  w.push(box(0, 0, 1.2, 1.2, CEILING, 'pillar', 45 * DEG));

  // korytarz zewnętrzny (r ≈ 12.25): osłona styczna za przejściami NE/SW, filar za przejściami NW/SE
  {
    const r = (R_OUT + R_MID) / 2;
    const [x1, z1] = polar(r, 7);                      // NE
    sym(w, [box(x1, z1, 2.0, 0.4, HALF_H, 'half', -45 * DEG)]);  // lokalne X wzdłuż stycznej do boku NE
    const [x2, z2] = polar(r, 5);                      // NW
    sym(w, [box(x2, z2, 0.8, 0.8, CEILING, 'pillar', 45 * DEG)]);
  }
  // korytarz wewnętrzny (r = 7.0): osłony styczne za przejściami N/E/S/W pierścienia środkowego
  {
    const r = (R_MID + R_CORE) / 2;
    sym(w, [box(0, -r, 2.0, 0.4, HALF_H, 'half', 0)]);            // N (obraz: S)
    sym(w, [box(r, 0, 0.4, 2.0, HALF_H, 'half', 0)]);             // E (obraz: W)
  }
  // pas spawnów: osłona pośrodku każdej strony (przecina linię wzdłuż obwodu)
  sym(w, [box(0, -17.6, 2.4, 0.4, HALF_H, 'half', 0)]);           // N (obraz: S)
  sym(w, [box(17.6, 0, 0.4, 2.4, HALF_H, 'half', 0)]);            // E (obraz: W)
  // narożniki: NE filar + osłona przed przejściem, NW osłona przed przejściem (równoległe do boków przekątnych)
  sym(w, [box(16.4, -16.4, 0.8, 0.8, CEILING, 'pillar', 45 * DEG)]);
  sym(w, [box(13.6, -13.6, 2.4, 0.4, HALF_H, 'half', -45 * DEG)]);  // styczna do boku NE (wzdłuż (1,1)/√2)
  sym(w, [box(-13.6, -13.6, 2.4, 0.4, HALF_H, 'half', 45 * DEG)]);  // styczna do boku NW (wzdłuż (1,−1)/√2)
  return w;
}

/** yaw 'auto': mapgen wybiera kierunek z najdłuższą linią wzroku (ku środkowi przy remisie). */
function spawn(x, z, team) {
  return { x, z, y: 0, yaw: 'auto', team };
}

export default {
  id: 'orbita',
  name: 'Orbita',
  seed: 4545,
  size: { w: 40, d: 40 },
  ceiling: CEILING,
  perimeter: { h: CEILING, paint: 'grid' },
  palette: {
    primary: '#6fd8ff',   // lodowy błękit
    secondary: '#b04bff', // fiolet
    uv: '#4b3cff',        // indygo UV
    accent: '#ff8a00',    // pomarańcz
    fog: '#05061a',
    ambient: '#120c2e',
  },
  walls: buildWalls(),
  ramps: [],
  decor: [],
  // kolejność = priorytet: 2 → rdzeń, 4 → + narożniki NE/SW, 6 → + NW/SE, 8 → + korytarz N/S.
  // Akcent (pomarańcz) tylko w farbie i listwach osłon rdzenia, nie w lampach (D-008: inaczej brązowe plamy na stropie).
  lights: [
    { x: 2.5, y: 4.7, z: -2.5, color: '#6fd8ff', intensity: 10, range: 12 },     // rdzeń NE
    { x: -2.5, y: 4.7, z: 2.5, color: '#b04bff', intensity: 10, range: 12 },     // rdzeń SW
    { x: 15, y: 4.7, z: -15, color: '#4b3cff', intensity: 12, range: 13 },      // narożnik NE
    { x: -15, y: 4.7, z: 15, color: '#4b3cff', intensity: 12, range: 13 },      // narożnik SW
    { x: -15, y: 4.7, z: -15, color: '#6fd8ff', intensity: 10, range: 13 },     // narożnik NW
    { x: 15, y: 4.7, z: 15, color: '#b04bff', intensity: 10, range: 13 },       // narożnik SE
    { x: 0, y: 4.7, z: -12.2, color: '#b04bff', intensity: 7, range: 10 },      // korytarz zewnętrzny N
    { x: 0, y: 4.7, z: 12.2, color: '#6fd8ff', intensity: 7, range: 10 },       // korytarz zewnętrzny S
  ],
  spawns: [
    spawn(-6, -18, 0), spawn(6, -18, 0),     // N
    spawn(6, 18, 1), spawn(-6, 18, 1),       // S
    spawn(18, -6, 2), spawn(18, 6, 2),       // E
    spawn(-18, 6, 3), spawn(-18, -6, 3),     // W
  ],
  cams: [
    // wysoko pod sufitem w narożniku NW, ukośnie nad pierścieniami
    { name: 'overview', pos: [-19.2, 4.8, -19.2], look: [3, 0, 3] },
    // korytarz zewnętrzny N na wysokości oka, wzdłuż łuku na wschód
    { name: 'corridor', pos: [-5, 1.65, -12.25], look: [8, 1.4, -11.5] },
    // rdzeń: od przejścia SW przez osłony i filar
    { name: 'plaza', pos: [-4.6, 1.65, 4.6], look: [2, 1.0, -1.5] },
    // spawn N, widok wzdłuż pasa spawnów w stronę narożnika NE
    { name: 'spawn', pos: [-6, 1.65, -18], look: [10, 1.4, -16] },
    // narożnik SE, widok przez przejście w pierścieniu zewnętrznym
    { name: 'corner', pos: [17.5, 1.65, 17.5], look: [6, 1.3, 6] },
  ],
};
