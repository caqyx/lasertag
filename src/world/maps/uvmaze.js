// UV Maze (M0) — SPEC §3.1. Dane mapy (PLAN §1), przetwarzane przez src/world/mapgen.js.
//
// Siatka 18×18 komórek po 2 m (arena 36×36 m, środek w (0,0)). Wiersz 0 = z min („północ"), kolumna 0 = x min („zachód").
// Środek komórki (r, c): x = -18 + 2c + 1, z = -18 + 2r + 1.
// Legenda: '#' ściana pełna 2.4 m, 'h' osłona połówkowa 1.1 m, 'o' filar 0.6×0.6 do sufitu, 'w' okno strzeleckie
// (parapet 1.1 m + nadproże od 1.85 m — CONFIG.elements.window), '.' pusto. Elementy poza siatką: walls (opony, beczki, siatki).
//
// Układ „trzy linie" (symetria obrotowa 180° wokół środka — (r, c) ↔ (17−r, 17−c); uczciwe strony N↔S i E↔W).
// Od D-038 otwarty: 20 komórek ścian mniej (78 → 58), z czego 2 → osłony 'h', 4 → okna 'w', reszta wolna:
//  - pierścień zewnętrzny (wiersze/kolumny 0 i 17) = korytarz spawnów; siatki N/S (x = 0) dzielą go na połowy,
//    ściany pierścienia (wiersze 1/16, kolumny 1/16) mają szerokie bramy (4 m przy narożnikach, 4–6 m w kolumnach 1/16),
//  - 3 linie N–S: lane W (kolumny 2–3, okno 'ww' w c3 przy placu), lane środkowy (c8–9: okno 'ww' → plac → okno 'ww'),
//    lane E (kolumny 14–15, okno 'ww' w c14); długa linia wzdłuż lane W/E przecięta ścianą r3 c3 (r14 c14),
//  - drzwi przesuwne w bramach c7/c10 przy ostrogach (doors) — naprzemiennie otwarte,
//  - pasma poprzeczne N/S (wiersze 2–4 i 13–15) szerokie na 4–6 m, z wysepkami ścian '##' i osłoną,
//  - plac centralny ~20×12 m (wiersze 6–11, kolumny 4–13): 2 filary, osłony 'h' (środek + boki W/E), 2 stosy opon,
//    okna 'ww' w ścianach N/S i W/E (lane W/E widzi plac, kucający za parapetem schowany),
//  - 2 małe place w parze obrotowej: NE (filar, otwarty na pierścień E przy spawnie E) i SW (filar, przy spawnie W),
//  - zero ślepych zaułków (każda wolna komórka ma ≥ 2 wolnych sąsiadów), filary bez brył w sąsiedztwie 8 komórek
//    (inaczej szczelina 0.7 m — PLAN §3, strefa zahaczania 0.7–1.25 m).

const ROWS = [
  '..................', //  0  N (spawny drużyny 0; siatka maskująca w osi x = 0 zamiast ostrogi)
  '.#..###.##.###..#.', //  1  ściana pierścienia N, bramy c2–3 / c7 (drzwi) / c10 (drzwi) / c14–15
  '.#.......h......#.', //  2  pasmo N (osłona r2 c9 styka się z drzwiami c10)
  '...#..##..##......', //  3  pasmo N: wysepki ścian, r3 c3 przecina linię lane W; plac NE (otwarty na pierścień E)
  '.#.............o..', //  4  pasmo N / plac NE — filar
  '.#..##.#ww#.##....', //  5  północna ściana placu z oknem strzeleckim 'ww', lane W 4 m
  '....h........#..#.', //  6  plac centralny (brama pierścienia W r6–7, osłona W)
  '....h.o.........#.', //  7  plac centralny: filar W (stos opon na E — walls)
  '.#.w.....h....w...', //  8  plac: osłona środkowa; okna 'w' lane W / lane E (pionowe 'ww' c3 i c14, r8–9)
  '...w....h.....w.#.', //  9  plac: osłona środkowa; okna lane W / lane E
  '.#.........o.h....', // 10  plac centralny: filar E (stos opon na W — walls)
  '.#..#........h....', // 11  plac centralny (brama pierścienia E r10–11, osłona E)
  '....##.#ww#.##..#.', // 12  południowa ściana placu z oknem strzeleckim 'ww', lane E 4 m
  '..o.............#.', // 13  pasmo S / plac SW — filar
  '......##..##..#...', // 14  pasmo S: wysepki ścian, r14 c14 przecina linię lane E; plac SW (otwarty na pierścień W)
  '.#......h.......#.', // 15  pasmo S
  '.#..###.##.###..#.', // 16  ściana pierścienia S
  '..................', // 17  S (spawny drużyny 1; siatka maskująca w osi x = 0)
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
  // Elementy (CONFIG.elements), każdy z obrazem 180°: siatki zamiast ostróg N/S (połowy pasa spawnów widzą się, nie przejdą),
  // stosy opon na placu centralnym (zamiast osłon 'h') i w lane W/E przy bramie pierścienia (r6–7 / r10–11, D-038),
  // para beczek na placu NE (i SW).
  walls: [
    { kind: 'net', x: 0, z: -17, w: 0.08, d: 2, rot: 0 }, { kind: 'net', x: 0, z: 17, w: 0.08, d: 2, rot: 0 },
    { kind: 'tires', x: 5, z: -3 }, { kind: 'tires', x: -5, z: 3 },
    { kind: 'tires', x: -12.5, z: -4.25 }, { kind: 'tires', x: 12.5, z: 4.25 },
    { kind: 'barrel', x: 10.7, z: -11.2 }, { kind: 'barrel', x: 11.2, z: -10.95 },
    { kind: 'barrel', x: -10.7, z: 11.2 }, { kind: 'barrel', x: -11.2, z: 10.95 },
  ],
  // Drzwi przesuwne (CONFIG.elements.door) w bramach c7 i c10 pierścienia N (obraz 180°: S), chowane w ścianę c8–9.
  // Bramy przy ostrodze otwierają się naprzemiennie (faza ½ okresu); bramy c3/c14 zawsze otwarte. Skrzydło przy licu
  // wewnętrznym ściany (z = ±14.15): styka się z narożnikiem osłony r2 c9 (bez szczeliny 0.85 m po przekątnej).
  doors: [
    { x: -3, z: -14.15, w: 2, slide: [2, 0], cycle: [6, 1.2, 6], phase: 0 },
    { x: 3, z: -14.15, w: 2, slide: [-2, 0], cycle: [6, 1.2, 6], phase: 7.2 },
    { x: 3, z: 14.15, w: 2, slide: [-2, 0], cycle: [6, 1.2, 6], phase: 0 },
    { x: -3, z: 14.15, w: 2, slide: [2, 0], cycle: [6, 1.2, 6], phase: 7.2 },
  ],
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
    // spawn zachodni przy placu SW: filar z boku kadru, widok ukośnie przez plac SW na wschód
    { name: 'spawn', pos: [-17, 1.65, 7], look: [-3, 1.4, 11] },
    // róg korytarza SE, długa perspektywa na północ (kolumna 15, przecięta osłoną) w mgłę
    { name: 'corner', pos: [13, 1.65, 13], look: [13, 1.5, -9] },
    // elementy: okno strzeleckie N placu (widok przez otwór na plac z oponami) i bramy z drzwiami przy ostrodze N
    { name: 'window', pos: [0.5, 1.65, -10.5], look: [0, 1.35, 0] },
    { name: 'door', pos: [4.6, 1.65, -12.4], look: [1.8, 1.2, -14.6] },
  ],
};
