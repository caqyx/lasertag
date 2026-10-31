// Neon Hive (M4) — SPEC §3.2. Dane mapy (PLAN §1), przetwarzane przez src/world/mapgen.js.
//
// Plaster miodu w prostokątnej hali 42×42 m: duża heksagonalna komora centralna (R = 6.5 m) otoczona korytarzem
// pierścieniowym, wokół 6 komór satelitarnych (R = 4.5 m) w odstępie 11.6 m; między satelitami korytarze
// promieniowe (~3.4 m), na zewnątrz pas obwodowy ze spawnami. Ściany heksów pod kątami 0/60/120°.
// Heks „flat-top": wierzchołki pod kątami 0°, 60°, …; bok k ma normalną pod kątem 30° + 60°·k
// (kąt mierzony od +X w stronę +Z). Przejścia (doorways) 2.0–2.4 m w środku boku.
// Symetria obrotowa 180° (a dla heksów nawet 60°) — strony N↔S, E↔W są uczciwe.

const CEILING = 4.5;
const WALL_H = 2.4;
const HALF_H = 1.1;
const T = 0.4;            // grubość ścian heksów
const EXT = 0.26;         // wydłużenie segmentu na wierzchołku (zachodzenie brył — brak dziur w narożnikach)

const R_CENTER = 6.5;
const R_SAT = 4.5;
const D_SAT = 11.6;       // odległość środków satelitów od środka

const DEG = Math.PI / 180;

/** Ściana-segment wzdłuż boku k heksa (cx,cz,R): parametr wzdłuż boku s0..s1 ∈ [-R/2, R/2]. */
function sideSegment(cx, cz, R, k, s0, s1, extra) {
  const th = (30 + 60 * k) * DEG;
  const a = R * Math.cos(30 * DEG);              // apotema
  const nx = Math.cos(th); const nz = Math.sin(th);
  const tx = -nz; const tz = nx;                 // kierunek boku
  const mid = (s0 + s1) / 2;
  const x = cx + nx * a + tx * mid;
  const z = cz + nz * a + tz * mid;
  // oś lokalna X bryły ma iść wzdłuż (tx, tz): świat(lokalne X) = (cos rot, -sin rot)
  const rot = Math.atan2(-tz, tx);
  return { x, z, w: s1 - s0, d: T, h: WALL_H, y: 0, rot, kind: 'wall', ...extra };
}

/** Heks ze ścian; doors: { [k]: szerokość przejścia } (przejście w środku boku). */
function hexWalls(cx, cz, R, doors, extra) {
  const out = [];
  const half = R / 2 + EXT;
  for (let k = 0; k < 6; k++) {
    const g = doors[k];
    if (!g) {
      out.push(sideSegment(cx, cz, R, k, -half, half, extra));
    } else {
      out.push(sideSegment(cx, cz, R, k, -half, -g / 2, extra));
      out.push(sideSegment(cx, cz, R, k, g / 2, half, extra));
    }
  }
  return out;
}

/** Osłona połówkowa / bryła prostokątna. */
function box(x, z, w, d, h, kind, rot = 0, extra) {
  return { x, z, w, d, h, y: 0, rot, kind, ...extra };
}

/** Dodaje bryłę i jej obraz w obrocie o 180° (symetria). */
function sym(list, b) {
  list.push(b);
  list.push({ ...b, x: -b.x, z: -b.z });
}

function buildWalls() {
  const walls = [];

  // komora centralna: przejścia na bokach 0,1,3,4 (pary przeciwległe → symetria 180°)
  walls.push(...hexWalls(0, 0, R_CENTER, { 0: 2.4, 1: 2.4, 3: 2.4, 4: 2.4 }, { paint: 'geo' }));
  // wnętrze komory centralnej: filar (heks-kolumna przybliżona kwadratem) + dwie osłony po bokach
  walls.push(box(0, 0, 1.0, 1.0, CEILING, 'pillar', 0));
  sym(walls, box(3.1, 0, 0.5, 2.4, HALF_H, 'half', 0));

  // 6 satelitów pod kątami 30° + 60°·j; przejścia: wewnętrzne (j+3), zewnętrzne (j), boczne (j+2)
  for (let j = 0; j < 6; j++) {
    const phi = (30 + 60 * j) * DEG;
    const cx = Math.cos(phi) * D_SAT;
    const cz = Math.sin(phi) * D_SAT;
    const doors = {};
    doors[(j + 3) % 6] = 2.0;
    doors[j] = 2.0;
    doors[(j + 2) % 6] = 2.0;
    walls.push(...hexWalls(cx, cz, R_SAT, doors));
    // wnętrze satelity (wzór zależny od j % 3 → symetria 180°)
    const v = j % 3;
    if (v === 0) {
      walls.push(box(cx, cz, 0.7, 0.7, CEILING, 'pillar'));
    } else {
      // osłona połówkowa promieniowo (v=1) lub stycznie (v=2) do środka mapy
      const rot = v === 1 ? -phi : -phi + Math.PI / 2;
      walls.push(box(cx, cz, 2.2, 0.5, HALF_H, 'half', rot));
    }
  }

  // pas obwodowy: bloki narożne (ściany pełne, L), osłony przy spawnach, filary w pasach bocznych
  for (const [sx, sz] of [[1, 1], [-1, 1]]) {
    // narożnik (sx, sz) i jego obraz 180°
    sym(walls, box(sx * 17.225, sz * 15.4, 4.15, 0.5, WALL_H, 'wall'));
    sym(walls, box(sx * 15.4, sz * 17.225, 0.5, 4.15, WALL_H, 'wall'));
  }
  // osłony przed spawnami N/S (z = ∓19.5, x = ±7) i E/W (x = ±19.5, z = ±7)
  sym(walls, box(0, -18.2, 2.6, 0.5, HALF_H, 'half'));
  sym(walls, box(-18.2, 0, 0.5, 2.6, HALF_H, 'half'));
  // osłony w pasie przy satelitach bocznych
  sym(walls, box(11.5, -16.0, 1.8, 0.5, HALF_H, 'half', 60 * DEG));
  sym(walls, box(-11.5, -16.0, 1.8, 0.5, HALF_H, 'half', -60 * DEG));
  sym(walls, box(17.5, -12.5, 0.6, 0.6, CEILING, 'pillar'));
  sym(walls, box(17.5, 12.5, 0.6, 0.6, CEILING, 'pillar'));
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
  size: { w: 42, d: 42 },
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
  // kolejność = priorytet: 2 → przekątna, 4 → + druga przekątna, 6 → + środek ×2, 8 → + pas N/S
  lights: [
    { x: 10.05, y: 4.2, z: -5.8, color: '#ffb000', intensity: 10, range: 13 },  // satelita 330°
    { x: -10.05, y: 4.2, z: 5.8, color: '#ffb000', intensity: 10, range: 13 },  // satelita 150°
    { x: -10.05, y: 4.2, z: -5.8, color: '#18e0ff', intensity: 10, range: 13 }, // satelita 210°
    { x: 10.05, y: 4.2, z: 5.8, color: '#18e0ff', intensity: 10, range: 13 },   // satelita 30°
    { x: -2.5, y: 4.2, z: 0, color: '#ff5a1f', intensity: 9, range: 12 },      // komora centralna W
    { x: 2.5, y: 4.2, z: 0, color: '#ff5a1f', intensity: 9, range: 12 },       // komora centralna E
    { x: 0, y: 4.2, z: -17.5, color: '#ff3d9a', intensity: 7, range: 11 },     // pas N (akcent)
    { x: 0, y: 4.2, z: 17.5, color: '#ff3d9a', intensity: 7, range: 11 },      // pas S (akcent)
  ],
  // team = strona: N (z min) 0, S 1, E (x max) 2, W 3 (przeciwne strony: 0↔1, 2↔3).
  // tdm2 (team % 2): N+E = 0, S+W = 1 — przy symetrii 180° dokładne lustro.
  spawns: [
    spawn(-7, -19.5, 0), spawn(7, -19.5, 0),
    spawn(7, 19.5, 1), spawn(-7, 19.5, 1),
    spawn(19.5, -7, 2), spawn(19.5, 7, 2),
    spawn(-19.5, 7, 3), spawn(-19.5, -7, 3),
  ],
  cams: [
    // między dźwigarami (z −13 / −9), tuż nad ich dolnym pasem, ~45° w dół: plaster miodu z góry (komora centralna + satelity)
    { name: 'overview', pos: [-1, 4.2, -11], look: [-0.6, 0, -6.8] },
    // korytarz promieniowy między satelitami (kierunek 0°), patrzy do środka
    { name: 'corridor', pos: [17.5, 1.65, 0.6], look: [0, 1.4, 0.6] },
    // korytarz pierścieniowy przy wejściu do komory centralnej (bok 4), widok na filar i osłony
    { name: 'plaza', pos: [0, 1.65, -6.8], look: [2.5, 1.0, 2.5] },
    // spawn W, widok w głąb pasu między satelitami
    { name: 'spawn', pos: [-19.5, 1.65, 7], look: [-10.8, 1.4, 12] },
    // narożnik SE, długa perspektywa wzdłuż pasu wschodniego w mgłę
    { name: 'corner', pos: [19.8, 1.65, 19.8], look: [19.0, 1.5, -8] },
  ],
};
