# Prompt dla nowego czatu Claude: edycja UV Maze, nowe mapy, nowe elementy

Skopiuj wszystko poniżej linii do nowej sesji Claude Code z dostępem do repo `caqyx/lasertag`.

---

Pracujesz nad grą **Laser Tag Arena**. To neonowa gra laser tag FPP w przeglądarce, napisana w HTML, Three.js 0.170.0 (skopiowany do `vendor/`) i modułach ES, bez bundlera i bez `npm install`.

Repo: `caqyx/lasertag`. Pracuj na branchu `claude/sleepy-tesla-cuvpjr` albo na nowym branchu odgałęzionym od niego. Commit i push rób po każdym zakończonym kroku.

## Cel (wykonuj po kolei i pytaj mnie tylko o decyzje projektowe, których nie da się wywnioskować)
1. **Zmiana mapy UV Maze** (`src/world/maps/uvmaze.js`). Zapytaj mnie, co dokładnie chcę zmienić (układ, rozmiar, nowe strefy), zanim zaczniesz. Zmiana ma zachować balans: symetrię obrotową 180°, 8 spawnów i brak długich ślepych zaułków.
2. **Nowe mapy.** Najpierw zaproponuj mi 2–3 koncepcje: nazwę, motyw, paletę 3+1 kolorów, wymiary, poziomy i szkic ASCII. Po mojej akceptacji zrób dane mapy, rejestrację i weryfikację.
3. **Nowe elementy.** Propozycje do rozbudowy, np. beczki i opony jako osłony, siatki maskujące (przepuszczają wzrok, blokują ruch), bramy baz drużyn, ruchome przeszkody, schody, okna strzeleckie. Każdy element ma mieć kolizję (fizyka), poprawną nawigację botów i render. Zaproponuj listę, ja wybiorę.

## Przeczytaj najpierw (obowiązkowo)
- **`docs/SPEC.md`:** zasady gry (§2), mapy (§3), wygląd (§4), presety (§5), pętla wizualna z checklistą 12 punktów (§6), budżet wydajności (§7), architektura (§8), zasady pracy (§12) i dziennik decyzji (§14). Nowe decyzje dopisuj do §14.
- **`docs/PLAN.md`:** kontrakty modułów. Najważniejsze: §1 (format danych mapy), §2 (World i Solid), §3 (fizyka) i §8.1 (nawigacja).
- **`docs/REPORT-FINAL.md`:** stan projektu i otwarte problemy wizualne.
- **Istniejące mapy jako wzór:**
  - `src/world/maps/uvmaze.js` — siatka ASCII `grid` co 2 m;
  - `src/world/maps/neonhive.js` — jawne bryły pod kątem 0/60/120°, plaster miodu na siatce trójkątnej;
  - `src/world/maps/reactor.js` — 2 poziomy: platformy, rampy, barierki i `decor` z rdzeniem reaktora.

## Jak zbudowane są mapy (skrót, szczegóły w PLAN §1–§3)
- **Mapa to czyste dane** (`export default MapData`) zarejestrowane w `src/world/maps/index.js` (`MAPS`). Klucz to `id` i zarazem parametr URL `?map=`. Menu bierze mapy z `MAPS`.
- **Pola MapData:**
  - `id`, `name`, `seed`;
  - `size {w, d}` — arena wycentrowana w (0,0);
  - `ceiling`;
  - `perimeter`;
  - `palette {primary, secondary, uv, accent, fog, ambient}`;
  - `grid` (opcjonalnie; ASCII: `#` ściana 2.4 m, `h` osłona 1.1 m, `o` filar, `.` pusto);
  - `walls[]` (`{x, z, w, d, h, y, rot, kind: wall|half|pillar|platform|prop, paint?, trim?}`; `rot` w radianach jak `Object3D.rotation.y`);
  - `ramps[]` (`{x, z, w, d, rot, y0, y1}`, wznosi się wzdłuż lokalnego +Z);
  - `decor[]` (tylko wizualne; renderer zna `reactorCore`, inne typy ignoruje);
  - `lights[]` (6–8, kolejność = priorytet, preset bierze pierwsze N);
  - `spawns[]` (`{x, z, y, yaw: 'auto', team: 0..3}`; team to strona N0/S1/E2/W3, a tryb tdm2 używa `team % 2`);
  - `cams[]` (min. 5 kamer debug: overview, corridor, plaza, spawn, corner).
- **Generator i fizyka:**
  - `src/world/mapgen.js` — dane → `World`, walidacja (spawn w bryle, auto-yaw ≥ 6 m, nachylenie rampy);
  - `src/world/physics.js` — kolizje OBB w XZ plus zakres Y; szczelina < 0.7 m jest nieprzechodnia; **unikaj szczelin 0.7–1.25 m**, bo postać o nie zahacza;
  - `src/world/nav.js` — graf nawigacji botów budowany automatycznie z danych.
- **Render:**
  - `src/render/arenaBuilder.js` — scalona geometria, farba UV, listwy neonowe, podłoga z odbiciami, sufit, stożki;
  - `src/render/decor.js` — elementy dekoracyjne;
  - `src/render/textures.js` — proceduralne tekstury.
  - Parametry per mapa leżą w `src/config.js` jako klucze `*Map` (np. `fogDensityMap`, `coneOpacityMap`, `lampRemap`).
  - **Wszystkie liczby trzymaj w `CONFIG`.**
- **Nowy element z kolizją:** nowy `kind` albo bryły w `walls[]`, plus obsługa w `mapgen.js` i `physics.js`, render w `arenaBuilder.js` lub `decor.js`. Sprawdź też, czy `nav.js` poprawnie go omija. Element tylko wizualny dodaj jako nowy typ `decor` w `decor.js`.

## Zasady jakości (bramki, każda zmiana musi je przejść)
- `npm test` na zielono (testy unit w Node). Jeśli test zależy od starego układu mapy (np. liczba brył UV Maze w `tests/unit/mapgen.test.mjs`), zaktualizuj go i opisz dlaczego.
- **Weryfikacja nowej lub zmienionej mapy** — skrypt w katalogu tymczasowym, nie w repo:
  - `buildWorld` bez ostrzeżeń;
  - brak szczelin 0.02–1.25 m poza celowymi przejściami ≥ 2.0 m;
  - symetria 180°;
  - `buildNav`: osiągalność ≥ 98% z każdego spawnu;
  - 1000 losowych ścieżek przejechanych `stepMovement` bez utknięcia;
  - mecz 8 botów przez 90 s (`stepSim` + `createBotBrain`): maksymalny czas bez postępu < 3.6 s i eliminacje > 0;
  - kamery poza bryłami.
- **Zero alokacji w pętli gry.** Liczby na gorącej ścieżce idą przez scratch `Float64Array` (decyzja D-012 w SPEC). Każda dynamicznie tworzona geometria, materiał i tekstura musi mieć `dispose()`.
- **Budżet `renderer.info`** (SPEC §7): Ultra ≤ 160 draw calli, ≤ 600k trójkątów, ≤ 44 tekstury. Statyczna geometria jest scalana per materiał.
- **Konsola przeglądarki bez błędów i ostrzeżeń:**
  - smoke: `npm run smoke` (Playwright, Chromium headless, wszystkie mapy × presety i pełny przepływ meczu);
  - zrzuty: `npm run screens -- --map <id> --preset ultra --out screenshots/<katalog>`.
- **Pętla wizualna (SPEC §6):**
  - zrzuty Ultra ze wszystkich kamer mapy;
  - ocenę robi osobny subagent-recenzent, który widzi **tylko zrzuty**, słowny opis referencji (SPEC §4 + paleta mapy) i checklistę 12 punktów, a nie kod;
  - poprawiaj do 12/12, maksymalnie ok. 3 rundy na problem, potem opisz, co zostało.
- **Środowisko headless:**
  - Playwright jest zainstalowany globalnie; ładuj go przez `createRequire(import.meta.url)('playwright')` z `NODE_PATH=$(npm root -g)`, nie instaluj ponownie;
  - Chromium uruchamiaj z `args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader']`;
  - FPS w headless nic nie znaczy.
- **Serwer deweloperski:** `node tools/serve.mjs 8080`, potem `http://localhost:8080/?map=<id>&preset=ultra&stats=1`. Kamery debug: `?cam=0..N&nohud=1`.

## Czego NIE robić
- Nie zmieniaj zasad gry (HP, broń, punktacja) bez mojej zgody.
- Nie psuj innych map. Zmiany w rendererze ograniczaj per mapa (klucze `*Map` w CONFIG albo flagi) i sprawdzaj UV Maze na zrzutach kontrolnych.
- Nie dodawaj zależności npm ani zasobów z CDN. Wszystko ma być proceduralne.
- Nie twórz pull requestu bez mojej prośby.

## Raport po każdym etapie
- Co zmieniono.
- Rzut ASCII mapy.
- Liczby: bryły i węzły nawigacji.
- Wyniki weryfikacji i testów.
- `renderer.info` per preset.
- Ścieżki do zrzutów.
- Ocena 12 punktów z pętli wizualnej.
