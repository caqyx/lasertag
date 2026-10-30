// UV Maze (M0) — SPEC §3.1. Dane mapy (PLAN §1), przetwarzane przez src/world/mapgen.js.
//
// Siatka 18×18 komórek po 2 m (arena 36×36 m, środek w (0,0)). Wiersz 0 = z min („północ"), kolumna 0 = x min („zachód").
// Środek komórki (r, c): x = -18 + 2c + 1, z = -18 + 2r + 1.
// Legenda: '#' ściana pełna 2.4 m, 'h' osłona połówkowa 1.1 m, 'o' filar 0.6×0.6 do sufitu, '.' pusto.
//
// Układ (symetria obrotowa 180° wokół środka — uczciwe strony N↔S i E↔W):
//  - pierścień zewnętrzny (wiersze/kolumny 0 i 17) = korytarz spawnów, podzielony krótkimi „ostrogami" na połowy,
//  - centralny plac ~20×12 m z osłonami 'h' i filarami 'o'; ściany placu mają „okna" 'h' (strzał nad osłoną),
//  - dwa małe place: NE (z filarem) i SW (z filarem),
//  - brak ślepych zaułków dłuższych niż 1 komórka (kieszenie przy osłonach), wszystko połączone pętlami.

const ROWS = [
  '........##........', //  0  N (spawny drużyny 0)
  '.##.###.##.###.#..', //  1
  '.#...........#....', //  2
  '...##h###.#..#.o..', //  3  plac NE (filar)
  '.#........#.......', //  4
  '.#.##.#hh.##.##.#.', //  5  północna ściana placu z oknem 'hh'
  '...#........o.#...', //  6
  '.#h#.h.o..h...#.#.', //  7
  '##....#.o..##.....', //  8
  '.....##..o.#....##', //  9
  '.#.#...h..o.h.#h#.', // 10
  '...#.o........#...', // 11
  '.#.##.##.hh#.##.#.', // 12  południowa ściana placu z oknem 'hh'
  '.......#........#.', // 13
  '..o.#..#.###h##...', // 14  plac SW (filar)
  '....#...........#.', // 15
  '..#.###.##.###.##.', // 16
  '........##........', // 17  S (spawny drużyny 1)
];

const CEILING = 4.5;

/** yaw 'auto': mapgen wybiera kierunek z najdłuższą linią wzroku (ku środkowi przy remisie). */
function spawn(x, z, team) {
  return { x, z, y: 0, yaw: 'auto', team };
}

export default {
  id: 'uvmaze',
  name: 'UV Maze',
  seed: 1337,
  size: { w: 36, d: 36 },
  ceiling: CEILING,
  perimeter: { h: CEILING, paint: 'stripes' },
  palette: {
    primary: '#ff2bd6',   // magenta
    secondary: '#22e8ff', // cyjan
    uv: '#7a3cff',        // fiolet UV
    accent: '#a6ff00',    // kwaśna zieleń
    fog: '#0b0618',
    ambient: '#1a0f33',
  },
  grid: {
    cell: 2,
    rows: ROWS,
    heights: { wall: 2.4, half: 1.1, pillar: CEILING }, // wysokości brył z siatki
    pillarSize: 0.6,
  },
  walls: [],
  ramps: [],
  decor: [],
  // Kolejność = priorytet (preset bierze pierwsze N): 2 → przekątna NE/SW, 4 → cztery ćwiartki, 6 → + plac, 8 → + pierścień N/S.
  lights: [
    { x: 13, y: 4.2, z: -11, color: '#22e8ff', intensity: 10, range: 13 }, // plac NE
    { x: -13, y: 4.2, z: 11, color: '#ff2bd6', intensity: 10, range: 13 }, // plac SW
    { x: -11, y: 4.2, z: -11, color: '#7a3cff', intensity: 12, range: 13 }, // ćwiartka NW
    { x: 11, y: 4.2, z: 11, color: '#7a3cff', intensity: 12, range: 13 },  // ćwiartka SE
    { x: -4, y: 4.2, z: 0, color: '#ff2bd6', intensity: 9, range: 12 },    // plac centralny W
    { x: 4, y: 4.2, z: 0, color: '#22e8ff', intensity: 9, range: 12 },     // plac centralny E
    { x: 0, y: 4.2, z: -16, color: '#a6ff00', intensity: 6, range: 10 },   // pierścień N (akcent)
    { x: 0, y: 4.2, z: 16, color: '#a6ff00', intensity: 6, range: 10 },    // pierścień S (akcent)
  ],
  // 2 spawny na stronę, w korytarzu obwodowym; team = strona (N 0, S 1, E 2, W 3). Tryb tdm2 mapuje team % 2.
  spawns: [
    spawn(-9, -17, 0), spawn(9, -17, 0),   // północ (z min)
    spawn(9, 17, 1), spawn(-9, 17, 1),     // południe (z max)
    spawn(17, -9, 2), spawn(17, 9, 2),     // wschód (x max)
    spawn(-17, 9, 3), spawn(-17, -9, 3),   // zachód (x min)
  ],
  // Kamery debug (pozycje sprawdzone skryptem: poza bryłami, widok na ≥ 12 m sceny).
  cams: [
    // wysoko pod sufitem w rogu NW, ukośnie nad szczytami ścian przez całą arenę
    { name: 'overview', pos: [-17.2, 4.3, -17.2], look: [4, 0, 4] },
    // długi korytarz północny (wiersz 2) na wysokości oka, patrzy na zachód
    { name: 'corridor', pos: [7, 1.65, -13], look: [-15, 1.4, -13] },
    // róg NW placu centralnego, widok po przekątnej na osłony i filary
    { name: 'plaza', pos: [-5, 1.65, -5], look: [6, 1.0, -1] },
    // spawn zachodni (plac SW), widok wzdłuż wiersza 13 na wschód
    { name: 'spawn', pos: [-17, 1.65, 9], look: [-3, 1.4, 9] },
    // róg korytarza SE, długa perspektywa na północ (kolumna 15, przecięta osłoną) w mgłę
    { name: 'corner', pos: [13, 1.65, 13], look: [13, 1.5, -9] },
  ],
};
