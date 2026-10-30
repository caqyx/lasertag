// Reactor (M4) — SPEC §3.3. Dane mapy (PLAN §1), przetwarzane przez src/world/mapgen.js.
//
// Hala 40×32 m, sufit 8 m, 2 poziomy:
//  - parter: lanes z osłonami, przejścia pod galerią (prześwit 2.9 m),
//  - galeria na 3.2 m (pierścień 18×14 m wokół otworu z rdzeniem) + kładki E/W do balkonów przy ścianach E/W,
//  - centralny rdzeń reaktora: bryła 'prop' (ośmiokąt = 2 kwadraty, drugi obrócony o 45°) + decor reactorCore,
//  - 4 rampy (2.6 × 6.4 m, nachylenie 0.5) z parteru na galerię, barierki 1.0 m (kind 'half') z przerwami do zeskoku.
// Symetria obrotowa 180° (x,z) → (−x,−z). Rampy wznoszą się wzdłuż lokalnego +Z; lokalne +Z = świat (sin rot, cos rot).

const CEILING = 8;
const DECK = 3.2;          // poziom galerii
const DECK_T = 0.3;        // grubość platform (spód 2.9 → prześwit pod spodem 2.9 m)
const WALL_H = 2.4;
const HALF_H = 1.1;
const RAIL_H = 1.0;        // barierka nad galerią
const RAIL_T = 0.3;
const CORE_HALF = 2.2;     // pół-bok kwadratów rdzenia (ośmiokąt o promieniu ~2.4–3.1)

function box(x, z, w, d, h, kind, extra) {
  return { x, z, w, d, h, y: 0, rot: 0, kind, ...extra };
}

function deck(x0, x1, z0, z1, extra) {
  return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, h: DECK_T, y: DECK - DECK_T, rot: 0, kind: 'platform', ...extra };
}

/** Barierka wzdłuż X (z stałe) od x0 do x1 albo wzdłuż Z (x stałe) od z0 do z1. */
function railX(z, x0, x1) {
  return { x: (x0 + x1) / 2, z, w: x1 - x0, d: RAIL_T, h: RAIL_H, y: DECK, rot: 0, kind: 'half', trim: 'accent' };
}
function railZ(x, z0, z1) {
  return { x, z: (z0 + z1) / 2, w: RAIL_T, d: z1 - z0, h: RAIL_H, y: DECK, rot: 0, kind: 'half', trim: 'accent' };
}

/** Dodaje bryłę i jej obraz w obrocie o 180°. */
function sym(list, b) {
  list.push(b);
  list.push({ ...b, x: -b.x, z: -b.z, rot: b.rot });
}

// Galeria: pierścień zewnętrzny x∈[-9,9], z∈[-7,7]; otwór x∈[-5,5], z∈[-3.5,3.5].
const GX = 9;
const GZ = 7;
const HX = 5;
const HZ = 3.5;
// Kładki E/W: z∈[-1.2,1.2] od x=9 do balkonu x=16.5; balkony x∈[16.5,20], z∈[-8,8].
const CW = 1.2;
const BX = 16.5;
const BZ = 8;

function buildWalls() {
  const w = [];
  // rdzeń reaktora (do sufitu)
  w.push(box(0, 0, 2 * CORE_HALF, 2 * CORE_HALF, CEILING, 'prop', { paint: 'none', trim: 'uv' }));
  w.push({ ...box(0, 0, 2 * CORE_HALF, 2 * CORE_HALF, CEILING, 'prop', { paint: 'none', trim: 'uv' }), rot: Math.PI / 4 });

  // galeria (lekkie zachodzenie pasów — bez szczelin)
  sym(w, deck(-GX, GX, -GZ, -HZ));                  // pas N (i S)
  sym(w, deck(HX - 0.05, GX, -HZ - 0.05, HZ + 0.05)); // pas E (i W)
  // kładki i balkony
  sym(w, deck(GX - 0.05, BX + 0.05, -CW, CW));
  sym(w, deck(BX, 20, -BZ, BZ));

  // barierki zewnętrzne galerii — krawędź E (x = 8.85): przerwy na kładkę (|z| < 1.2) i rampę (z 3.2..5.8)
  sym(w, railZ(GX - RAIL_T / 2, -GZ, -CW - 0.05));
  sym(w, railZ(GX - RAIL_T / 2, CW + 0.05, 3.15));
  sym(w, railZ(GX - RAIL_T / 2, 5.85, GZ));
  // krawędź N (z = -6.85): rampa N x∈[-6.8,-4.2], przerwa do zeskoku x∈[1,3]
  sym(w, railX(-GZ + RAIL_T / 2, -GX, -6.85));
  sym(w, railX(-GZ + RAIL_T / 2, -4.15, 1.0));
  sym(w, railX(-GZ + RAIL_T / 2, 3.0, GX));
  // krawędzie otworu N/S: przerwa 3 m pośrodku (widok i zeskok przy rdzeniu)
  sym(w, railX(-HZ - RAIL_T / 2, -HX, -1.5));
  sym(w, railX(-HZ - RAIL_T / 2, 1.5, HX));
  // balkon E: barierka na krawędzi wewnętrznej (x = 16.65), przerwa na kładkę i do zeskoku z∈[-4.4,-2.4]
  sym(w, railZ(BX + RAIL_T / 2, -BZ, -4.4));
  sym(w, railZ(BX + RAIL_T / 2, -2.4, -CW - 0.05));
  sym(w, railZ(BX + RAIL_T / 2, CW + 0.05, BZ));

  // podpory galerii (filary pod platformą, parter)
  sym(w, { ...box(5.6, -4.1, 0.6, 0.6, DECK - DECK_T, 'pillar') });
  sym(w, { ...box(-5.6, -4.1, 0.6, 0.6, DECK - DECK_T, 'pillar') });

  // ścianki nośne pod pasami N/S galerii (do spodu platformy) — przecinają długie przekątne na parterze
  sym(w, box(3.0, -5.25, 0.5, 1.8, DECK - DECK_T, 'wall'));
  sym(w, box(-3.0, -5.25, 0.5, 1.8, DECK - DECK_T, 'wall'));

  // parter: osłony i ściany tworzące „lanes"
  sym(w, box(0, -11.0, 5.0, 0.5, WALL_H, 'wall'));          // ściana przed galerią N (zasłania spawn N od rdzenia)
  sym(w, box(-14.5, -10.0, 2.4, 0.5, HALF_H, 'half'));      // osłona przy spawnie NW
  sym(w, box(13.0, -11.5, 0.5, 3.0, WALL_H, 'wall'));       // ściana NE (lane E)
  sym(w, box(14.2, -5.0, 0.5, 2.6, HALF_H, 'half'));        // osłona pod balkonem E
  sym(w, box(-1.5, -14.5, 2.0, 0.5, HALF_H, 'half'));       // osłona w pasie N
  sym(w, box(4.0, -14.6, 0.5, 2.8, WALL_H, 'wall'));        // ściana w pasie N (przecina linię wzdłuż ściany)
  sym(w, box(7.0, -13.5, 1.2, 1.2, HALF_H, 'half'));        // skrzynia NE
  sym(w, box(-17.5, -1.8, 1.2, 1.2, HALF_H, 'half'));       // skrzynia pod balkonem W
  return w;
}

function ramps() {
  const r = [];
  // E: x 9..15.4, z 3.2..5.8, wznosi się w stronę −X (rot −π/2); W = obraz 180°
  r.push({ x: GX + 3.2, z: 4.5, w: 2.6, d: 6.4, rot: -Math.PI / 2, y0: 0, y1: DECK });
  r.push({ x: -(GX + 3.2), z: -4.5, w: 2.6, d: 6.4, rot: Math.PI / 2, y0: 0, y1: DECK });
  // N: x -6.8..-4.2, z -13.4..-7, wznosi się w stronę +Z (rot 0); S = obraz 180°
  r.push({ x: -5.5, z: -(GZ + 3.2), w: 2.6, d: 6.4, rot: 0, y0: 0, y1: DECK });
  r.push({ x: 5.5, z: GZ + 3.2, w: 2.6, d: 6.4, rot: Math.PI, y0: 0, y1: DECK });
  return r;
}

/** yaw 'auto': mapgen wybiera kierunek z najdłuższą linią wzroku (ku środkowi przy remisie). */
function spawn(x, z, team, y = 0) {
  return { x, z, y, yaw: 'auto', team };
}

export default {
  id: 'reactor',
  name: 'Reactor',
  seed: 9001,
  size: { w: 40, d: 32 },
  ceiling: CEILING,
  perimeter: { h: CEILING, paint: 'grid' },
  palette: {
    primary: '#39ff14',   // toksyczna zieleń
    secondary: '#00e5ff', // cyjan
    uv: '#5a2bff',        // fiolet UV (lampy sufitowe)
    accent: '#ff2a2a',    // czerwień ostrzegawcza (barierki)
    fog: '#04100a',
    ambient: '#0b1f16',
  },
  walls: buildWalls(),
  ramps: ramps(),
  decor: [
    { type: 'reactorCore', x: 0, z: 0, r: 2.6, h: CEILING },
  ],
  // kolejność = priorytet: 2 → rdzeń N/S (nad galerią), 4 → + ćwiartki NE/SW, 6 → + NW/SE, 8 → + balkony
  lights: [
    { x: 0, y: 7.4, z: -5.2, color: '#39ff14', intensity: 12, range: 16 },
    { x: 0, y: 7.4, z: 5.2, color: '#39ff14', intensity: 12, range: 16 },
    { x: 13, y: 7.4, z: -11, color: '#00e5ff', intensity: 11, range: 15 },
    { x: -13, y: 7.4, z: 11, color: '#00e5ff', intensity: 11, range: 15 },
    { x: -13, y: 7.4, z: -11, color: '#5a2bff', intensity: 11, range: 15 },
    { x: 13, y: 7.4, z: 11, color: '#5a2bff', intensity: 11, range: 15 },
    { x: 18.2, y: 7.4, z: 0, color: '#ff2a2a', intensity: 8, range: 12 },
    { x: -18.2, y: 7.4, z: 0, color: '#ff2a2a', intensity: 8, range: 12 },
  ],
  // team = strona (N 0, S 1 na parterze; E 2, W 3 na balkonach 3.2 m). tdm2 (team % 2): N+E vs S+W.
  spawns: [
    spawn(-12, -14.5, 0), spawn(10, -14.5, 0),
    spawn(12, 14.5, 1), spawn(-10, 14.5, 1),
    spawn(18.5, -5.5, 2, DECK), spawn(18.5, 5.5, 2, DECK),
    spawn(-18.5, 5.5, 3, DECK), spawn(-18.5, -5.5, 3, DECK),
  ],
  cams: [
    { name: 'overview', pos: [-19.3, 7.4, -15.3], look: [3, 1, 2] },
    // przejście pod balkonem W, kładką i galerią W, widok wzdłuż osi na rdzeń
    { name: 'corridor', pos: [-19.0, 1.65, 0.4], look: [0, 1.6, 0.4] },
    // parter od strony N, widok na rdzeń nad osłonami
    { name: 'plaza', pos: [-3.5, 1.65, -9.5], look: [0, 2.0, 0] },
    { name: 'spawn', pos: [-12, 1.65, -14.5], look: [0, 1.6, -3] },
    { name: 'corner', pos: [19.3, 1.65, 15.3], look: [-10, 1.5, 15] },
    // galeria (pas S), widok przez otwór na rdzeń i galerię N
    { name: 'upper', pos: [-7.5, DECK + 1.65, 5.6], look: [6, DECK + 0.8, -5] },
    // rdzeń z kładki W
    { name: 'core', pos: [-14.5, DECK + 1.65, 0.3], look: [0, 3.5, 0] },
  ],
};
