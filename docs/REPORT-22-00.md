# Raport 22:00 — Laser Tag Arena

Sesja od 20:25. Branch `claude/sleepy-tesla-cuvpjr`. Wszystkie moduły etapów M0–M4 istnieją, ale **żaden etap nie jest jeszcze formalnie zamknięty**.
- **M0:** blokuje go pętla wizualna (iteracja 3 w toku).
- **M2 i M3:** czekają na integrację w `main.js` (w toku).
- **M4:** brakuje renderu dekoracji i oceny wizualnej.

## 0. Zastrzeżenie na start

W repo **nie było `docs/SPEC.md` ani `reference/ref1–4.png`** (ani na Google Drive).
- Specyfikację odtworzyłem z briefu: sekcje 1–14, liczby, budżety, checklista §6 (decyzja D-001).
- Pętla wizualna ocenia zrzuty względem **opisu słownego** referencji (SPEC §4), a nie zdjęć.
- Jeśli masz oryginały, wrzuć je — dopasuję SPEC i ocenę.

## 1. Zrobione — etapy vs „Gotowe gdy"

| Etap | Moduły | Gotowe gdy | Stan |
|---|---|---|---|
| **M0 Arena** | `index.html` (importmap → vendor three 0.170.0), `config.js`, `mapgen`, `physics`, `movement`, mapa UV Maze, `graphics` (bloom, MSAA/FXAA, Neutral tone mapping, mgła), `textures`, `arenaBuilder`, `smoke`, `debugCams`, `loop`, `urlParams`, `keyboardMouse`, `statsOverlay` | Checklista §6 na Ultra; brak przenikania ścian; 0 błędów konsoli; budżet | Ruch i kolizje: ✅ (0 przenikań w 208 próbach × 600 kroków; szczeliny < 2r nieprzechodnie)<br>Konsola: ✅<br>Budżet: ✅<br>**Checklista: ❌** (iteracja 2: 4/12, iteracja 3 w toku) |
| **M1 Strzelanie** | `events`, `participant`, `weapon`, `combat`, `scoring`, `sim`, `beams`, `avatars`, `viewModel`, `hud` | Testy walki zielone; można wyeliminować manekina; HUD z HP i ciepłem; zero alokacji | ✅ (73 testy M1, smoke eliminuje cel na 3 mapach, noalloc 0 GC) |
| **M2 Boty** | `nav` (graf z danych, A* bez alokacji), `bots/ai` (FSM patrol, namierzanie, osłona, pościg), `bots/adapt` | Boty patrolują bez utykania, walczą, szukają osłon; testy adaptacji | Logika: ✅ (mecz 7 botów: hard > normal > easy w każdym seedzie, maks. utknięcie 1.75 s, adaptacja ±0.25)<br>**W grze: ⏳** (integracja w toku) |
| **M3 Tryby** | `modes`, `match`, `menu`, `scoreboard`, `matchBar`, `endScreen`, `menu.css` | Pełny mecz od menu do ekranu końca w każdym trybie | Moduły i testy: ✅ (9)<br>**Integracja: ⏳** |
| **M4 Mapy** | `maps/neonhive.js`, `maps/reactor.js` (2 poziomy, galeria 3.2 m, 4 rampy, rdzeń) | Pętla wizualna dla obu map; boty nawigują na obu poziomach | Dane i nawigacja: ✅ (100% osiągalności, 2000/2000 ścieżek, 623 międzypoziomowe)<br>**Render dekoracji i pętla wizualna: ⏳** |

Testy: `npm test` daje **192 testy, 191 pass, 0 fail, 1 todo** (tunelowanie przy dt = 1 s — świadomie pominięte). `npm run smoke` daje **3 mapy × 4 presety: 0 błędów i ostrzeżeń konsoli, wszystko w budżecie, wycieki 0**.

## 2. Pętla wizualna (SPEC §6)

| Mapa | Iteracja | Recenzent | Wynik | Zrzuty |
|---|---|---|---|---|
| UV Maze | 1 | ux-reviewer #1 | 4/12 (ciemność, listwy, sufit, skala) | `screenshots/m0-iter1/` |
| UV Maze | 2 | ux-reviewer #2 (niezależny, świeży) | 4/12 (listwy, podłoga, skala + …) | `screenshots/m0-iter2/` |
| UV Maze | 3 | — | w toku | `screenshots/m0-iter3/` (po zakończeniu) |
| Neon Hive, Reactor | 1 | — | czeka na render dekoracji | `screenshots/m4-iter1/` |

**Iteracja 2, tak/nie:**

| Punkt | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Wynik | nie | tak | nie | nie | nie | tak | nie | nie | tak | nie | nie | nie |

**Główne zarzuty w iteracji 3:**
- twarde krawędzie mgły i stożków światła;
- ściany w kolorze teal zamiast niemal czarnego granatu;
- za mało farby UV (cel: 40–60% powierzchni);
- pusty strop w ujęciu overview;
- pojedyncze artefakty (pływająca belka, ciemny trójkąt na ścianie);
- styk ściany z podłogą.

Broń FPP była przepalona — poprawione.

## 3. Wydajność (`renderer.info`, cała klatka; pełne dane w `docs/PERF.md`)

| Mapa | Low | Medium | High | Ultra | Budżet (Low / Med / High / Ultra, calls / tris) |
|---|---|---|---|---|---|
| UV Maze | 16 / 53k | 31 / 56k | 43 / 111k | 43 / 111k | 60/120k · 90/200k · 120/350k · 160/600k |
| Neon Hive | 16 / 64k | 31 / 67k | 43 / 134k | 43 / 134k | jw. |
| Reactor | 16 / 48k | 31 / 49k | 43 / 98k | 43 / 98k | jw. |

- **Tekstury:** 11 / 23 / 25 / 25, przy limitach 20 / 28 / 36 / 44.
- **Geometrie:** 16–17 przy limicie ≥ 80.
- **Symulacja:** 8 botów to 8–11 µs na krok. `stepSim` z ciągłym ogniem: 0 GC na 100k kroków.

## 4. Decyzje podjęte samodzielnie (pełny dziennik: SPEC §14)

| # | Decyzja |
|---|---|
| D-001 | SPEC odtworzony z briefu; referencje jako opis słowny. |
| D-002 | Three.js 0.170.0 skopiowany do `vendor/three`, bo CDN jest zablokowany w sandboxie. |
| D-003 | Bez cieni. Oświetlenie emisyjne + bloom + ograniczona liczba PointLight. |
| D-004 | Trafienie liczone na kapsule ciała; trafiony segment = najbliższy sensor. |
| D-005 | Własna fizyka (OBB w płaszczyźnie XZ + zakres Y, rampy jako pełny klin). |
| D-006 | Zdefiniowani subagenci nie istnieją — używam `general-purpose` z rolą opisaną w prompcie. |
| D-007 | Tone mapping Neutral zamiast ACES (ACES wybielał rdzenie cyjanowych listew). |
| D-008 | Limonka (accent) zmapowana w rendererze na kolory główne; jako akcent tylko ok. 8% farby. |
| D-009 | Ochrona: wiązka zatrzymuje się na chronionym celu (SHOT value = 2), bez HIT. |
| D-010 | Pauza (Esc lub utrata pointer locka) zatrzymuje symulację — gra single-player. |
| D-011 | Odbicia podłogi z kamery lustrzanej (High/Ultra, ½ rozdzielczości, rozmyte) zamiast samej env mapy. |
| D-012 | Hot path przekazuje współrzędne przez bufory Float64Array (`SEG`, `RAYARG`, `NEAR`), bo V8 opakowuje liczby double w nie-inline'owanych wywołaniach. |

## 5. Problemy i ryzyka

1. **Jakość wizualna M0.** Dwie iteracje dały 4/12, a recenzenci są surowi i niezależni. Bez zdjęć referencyjnych kryterium „nastroju" (pkt 12) jest subiektywne. Plan: maksymalnie 2–3 kolejne iteracje, a jeśli punkt utknie, zapisuję to w raporcie.
2. **Zrzuty w SwiftShader są wolne** (~30 s na kadr), co spowalnia pętlę wizualną.
3. **Odbicie planarne a drugi poziom.** Lustro y = 0 nie działa z drugim poziomem (Reactor) — coder grafiki to obsługuje.
4. **Ustalenia QA w toku:**
   - obsługa `webglcontextlost` i braku WebGL;
   - gubione krótkie kliknięcia (fire jako zbocze);
   - sanityzacja wejścia pod M5;
   - fazy kroku symulacji;
   - duplikaty helperów;
   - liczby poza CONFIG.
5. **Przy 16 uczestnikach** (pod M5) Neon Hive na Low zbliża się do limitu trójkątów — w toku redukcja siatki awatara.

## 6. Następne kroki

1. Iteracja 3 UV Maze, potem ponowna niezależna ocena; powtarzać aż 12/12 (lub opisać, co blokuje).
2. Integracja M2+M3 w `main.js` (menu → mecz → ekran końca, boty, adaptacja), potem testy smoke dla 3 trybów × 3 map.
3. Render M4 (rdzeń reaktora, galerie, heksy) i pętla wizualna obu map.
4. Poprawki QA, drugi przegląd qa-security na koniec etapów.
5. `REPORT-FINAL.md`, zrzuty `screenshots/final/`, aktualizacja SPEC.

## 7. Jak uruchomić i co sprawdzić ręcznie

```bash
node tools/serve.mjs 8080
```
Otwórz `http://localhost:8080/?preset=ultra&stats=1` (testy: `npm test`, `npm run smoke`).

1. **FPS na Ultra i Low** (panel `?stats=1`). Headless tego nie mierzy, a odbicia planarne to największy koszt GPU.
2. **Ruch:** ślizganie po ścianach, wejście na rampy na `?map=reactor`, brak zaczepiania w przejściach Neon Hive.
3. **Strzelanie:** feeling broni (kadencja 0.22 s, przegrzanie po 10 strzałach) i czytelność wiązek oraz kamizelek przeciwników w ciemności.
4. **Wygląd UV Maze z perspektywy gracza:** czy ściany, mgła i dym oddają halę laser tag (`?cam=0..4&nohud=1` dają kadry z pętli wizualnej).
5. **Po integracji M3:** menu, pełny mecz, Tab i ekran końca.
