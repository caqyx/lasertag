# Laser Tag Arena — Specyfikacja

> **Status:** wersja 1.0 zrekonstruowana przez orkiestratora 2026-10-30. Oryginalny `docs/SPEC.md`
> i `reference/ref1..4.png` nie istniały w repo w chwili startu sesji (patrz dziennik decyzji D-001).
> Treść zbudowana na podstawie briefu zadania (nazwy sekcji, map, trybów, parametrów URL, etapów).
> Jeśli autor ma oryginał — wgraj go; rozbieżności rozstrzygamy na korzyść oryginału.

## 1. Wizja

Neonowa gra laser tag FPP w przeglądarce (HTML + Three.js, moduły ES, bez bundlera).
Klimat: prawdziwa hala laser tag — ciemność, farba fluorescencyjna świecąca w UV, neonowe listwy,
dym z wytwornicy, w którym widać światło, błyszcząca czarna podłoga. Rozgrywka szybka, czytelna,
mecze 5-minutowe z botami. Architektura gotowa na tryb online (M5, poza tą sesją).

## 2. Zasady gry

### 2.1 Uczestnik i kamizelka
- Każdy uczestnik (gracz lub bot) ma **4 HP**.
- Kamizelka ma **4 segmenty-sensory**: przód (klatka), tył, lewe ramię, prawe ramię.
  Segmenty świecą kolorem drużyny/gracza. Liczba świecących segmentów = aktualne HP
  (traci się zawsze „najwyższy" zapalony segment wg kolejności: tył → lewe → prawe → przód).
- Trafienie liczy się, gdy wiązka trafi w hitbox ciała (kapsuła). Segment, w który „trafiono"
  (najbliższy sensor do punktu trafienia), błyska na biało 0.15 s.
- Trafienie = **−1 HP**. Brak friendly fire w trybach drużynowych.

### 2.2 Eliminacja, respawn, ochrona
- 0 HP → **eliminacja**: uczestnik wyłączony na **3 s** (kamizelka miga, nie może strzelać ani się ruszać,
  gracz widzi kamerę „death cam" uniesioną nad ciałem).
- **Respawn** w punkcie startowym najdalszym od widocznych przeciwników (w TDM — tylko spawny drużyny).
- **Hit stun:** trafienie (bez eliminacji) wyłącza fazer celu na **0.45 s** — kto trafi pierwszy, wygrywa wymianę (nagradza zasadzki, nie „nawalanie się”).
- **Ochrona** po respawnie: **2 s** nietykalności (kamizelka pulsuje). Oddanie strzału kończy ochronę natychmiast.

### 2.3 Broń (fazer)
- Hitscan, zasięg **50 m**. Wiązka widoczna 0.12 s, kolor drużyny.
- Szybkostrzelność: 1 strzał / **0.22 s** (trzymanie spustu = ogień ciągły).
- **Przegrzewanie:** każdy strzał +0.11 ciepła (0..1). Chłodzenie 0.45/s, start po 0.25 s od strzału.
  Przy 1.0 → **przegrzanie**: blokada do spadku ciepła < 0.35 (chłodzenie w przegrzaniu 0.6/s).
- **Wybór broni (D-037)** — przed meczem w menu (sekcja BROŃ) lub `?weapon=phaser|pistol|bouncer`; jedna broń na mecz.
  Boty losują broń z deterministycznego rng symulacji przy starcie meczu. Liczby w `CONFIG.weapons`.
  - **Fazer** — jak wyżej (domyślny), trafienie = 1 segment.
  - **Pistolet dwustrzałowy** — kliknięcie = seria 2 hitscanów co 0.07 s (półautomat: trzymanie spustu nie powtarza),
    seria co ≥ 0.3 s, zasięg 16 m, +0.025 ciepła/strzał, trafienie = ½ segmentu (seria = 1 segment), stun × 0.5.
  - **Wyrzutnia odbijająca** — wolny impuls-pocisk 14 m/s (życie 2.5 s), odbija się lustrzanie dokładnie raz od dowolnej
    powierzchni (ściana, przeszkoda, rampa, podłoga, sufit), może trafić zza rogu; drugi kontakt z powierzchnią = znika.
    Co 0.55 s, +0.2 ciepła, trafienie = 1 segment. Pula pocisków w symulacji (maks. 48 aktywnych).

### 2.4 Punktacja
- Trafienie +10, eliminacja +50 (dla strzelającego). Bycie wyeliminowanym 0 (licznik śmierci).
- Drużyny: wynik drużyny = suma wyników członków; tablica pokazuje E/D (eliminacje/śmierci).

### 2.5 Boty
- Stany AI: **patrol** (losowe cele z grafu nawigacji, preferencja nieodwiedzonych), **namierzanie**
  (widzi wroga → obrót z ograniczoną prędkością + czas reakcji → ogień seriami z rozrzutem),
  **osłona** (HP ≤ 2 lub przegrzanie → najbliższy węzeł bez linii wzroku do napastnika), **pościg**
  (ostatnia znana pozycja wroga przez 4 s).
- 3 poziomy:

| Parametr | easy | normal | hard |
|---|---|---|---|
| Czas reakcji | 0.65 s | 0.40 s | 0.24 s |
| Rozrzut celowania (σ, stopnie) | 5.5 | 3.0 | 1.6 |
| Prędkość obrotu (°/s) | 160 | 260 | 400 |
| Zasięg widzenia | 28 m | 38 m | 48 m |
| Pole widzenia | 100° | 120° | 140° |
| Strafe w walce | nie | tak | tak, częściej |
| Szukanie osłony | rzadko (HP≤1) | HP≤2 | HP≤2 lub przegrzanie |

- **Adaptacja do gracza:** co 30 s liczony wskaźnik r = (E_gracza + 1) / (D_gracza + 1) w oknie ostatnich 60 s.
  Offset umiejętności `s` ∈ [−0.25, +0.25]: r > 1.5 → s += 0.05; r < 0.67 → s −= 0.05; inaczej s dąży do 0 o 0.025.
  Offset skaluje: rozrzut × (1 − s), reakcja × (1 − s), obrót × (1 + s). Dotyczy tylko botów-przeciwników gracza.

### 2.6 Tryby
- **ffa** — każdy na każdego, 8 uczestników (gracz + 7 botów), 5 min, limit 25 eliminacji.
- **tdm2** — 2 drużyny 4v4 (czerwoni / niebiescy), 5 min, limit 60 eliminacji drużyny.
- **tdm4** — 4 drużyny 2-osobowe (czerwoni / niebiescy / zieloni / żółci), 5 min, limit 30 eliminacji drużyny.
- Wygrywa najwyższy wynik punktowy (remis → więcej eliminacji → remis ogłoszony).
- **Multiplayer → Custom** (menu: zakładka MULTIPLAYER; D-039) — lokalnie, bez sieci, przygotowanie pod M5:
  gracz wybiera liczbę drużyn (2–4) i liczbę osób w drużynie (1…⌊16 / drużyny⌋: 2 → 8, 3 → 5, 4 → 4; wszystkie drużyny
  równe). Gracz w drużynie 0, pozostałe sloty zajmują boty (poziom z wyboru BOTY). Drużynowy deathmatch na zasadach tdm
  (bez friendly fire, wynik drużyny = suma wyników), 5 min, limit eliminacji drużyny = 15 × osób w drużynie
  (4v4 → 60 jak tdm2, 4×2 → 30 jak tdm4). Spawny: 2 drużyny jak tdm2 (strona % 2), 3–4 drużyny wg strony
  (N 0, S 1, E 2, W 3; przy 3 drużynach strona W wolna). Slot = `{ team, kind: 'local' | 'bot' | 'remote' }` —
  w M5 bot w slocie zostanie podmieniony na gracza sieciowego (wymienny InputSource); `remote` na razie tylko w danych
  (sterowany botem). URL: `?mode=custom&teams=3&per=4`.

### 2.7 Ruch i stamina
- Chód 3.8 m/s, sprint 5.6 m/s tylko do przodu (D-013/D-015). **Stamina** (0..1, wspólna mechanika gracza i botów, D-023):
  sprint zużywa 0.25/s (pełny pasek ≈ 4 s), skok kosztuje 0.12 (niedostępny poniżej); regeneracja 0.2/s po 1 s bez
  sprintu/skoku, stojąc lub w kucu ×1.5. Przy 0 → **wyczerpanie**: sprint zablokowany, dopóki stamina < 0.35. Respawn = pełna.

## 3. Mapy

Wszystkie mapy są **danymi** (`src/world/maps/*.js`) przetwarzanymi przez generator (`mapgen.js`).
Jednostka = 1 m. Oś Y w górę. Oko gracza 1.65 m.

### 3.1 UV Maze (M0)
- 36 × 36 m, jeden poziom, sufit 4.5 m (kratownica techniczna).
- Labirynt na siatce 2 m: ściany pełne 2.4 m, osłony połówkowe 1.1 m, filary.
- Układ „trzy linie” (od 2026-10-31, D-025; otwarty 2026-11-01, D-038): lane W, lane środkowy (przez okna 'ww' i plac),
  lane E; szerokie pasma poprzeczne N/S z wysepkami ścian.
- Lane W/E i bramy pierścienia 4 m, plac centralny ~20×12 m (osłony, 2 filary, 2 stosy opon, okna 'ww' w ścianach N/S
  oraz od lane W/E), 2 małe place (NE/SW, z filarem i beczkami) przy spawnach E/W.
- 76 brył (z siatki 32 ściany, 6 osłon, 4 filary, 4 okna; 2 siatki, 4 stosy opon, 4 beczki, 4 drzwi, 4 obwodowe), 960 węzłów nav.
- Zero ślepych zaułków; filary bez brył w sąsiedztwie 8 komórek (inaczej szczelina 0.7 m).
- 8 spawnów po obwodzie (2 na stronę), drużynowe wg stron świata.
- Paleta: magenta `#ff2bd6`, cyjan `#22e8ff`, fiolet UV `#7a3cff`, akcent kwaśna zieleń `#a6ff00`.

### 3.2 Neon Hive (M4)
- ~40 m średnicy, plaster miodu: heksagonalne komory (promień ~4.5 m) połączone przejściami,
  większa komora centralna. Ściany pod kątami 0/60/120°.
- Elementy (D-038): 3 pary okien strzeleckich w pełnych bokach (centrum ↔ R ENE/WSW, R N/S ↔ V NE/SW, szprychy
  R ENE↔ESE / WSW↔WNW) i 2 pary stosów opon (oś N–S komory centralnej, narożniki NE/SW). 211 brył, 1065 węzłów nav.
- Paleta: bursztyn `#ffb000`, pomarańcz `#ff5a1f`, cyjan `#18e0ff`, akcent róż `#ff3d9a`.

### 3.3 Reactor (M4)
- 40 × 32 m, **2 poziomy**: parter + galeria/kładki na 3.2 m wokół centralnego rdzenia reaktora
  (świecący walec), 4 rampy, sufit 8 m.
- Elementy (D-038, parter): okna strzeleckie w ścianie przed galerią N/S (2.4 m) i w ścianach lane E/W (1.6 m),
  2 pary stosów opon (przy podstawie ramp N/S, przy galerii W/E). 80 brył, 1354 węzły nav.
- Paleta: toksyczna zieleń `#39ff14`, cyjan `#00e5ff`, akcent czerwony ostrzegawczy `#ff2a2a`.

### 3.4 Orbita
- 40 × 40 m, jeden poziom, sufit 5 m. Trzy koncentryczne ośmiokąty (apotemy 15 / 9.5 / 4.5 m), ściany pod 0/45°.
- Przejścia 3 m obrócone o 45° między pierścieniami (zewnętrzny: przekątne, środkowy: N/E/S/W, rdzeń: otwarte przekątne)
  — do środka idzie się spiralą, bez linii wzroku na wylot. Rdzeń: 4 osłony połówkowe + filar-romb.
- 8 spawnów w pasie między pierścieniem zewnętrznym a obwodem (osłona pośrodku każdej strony).
- Paleta: lodowy błękit `#6fd8ff`, fiolet `#b04bff`, indygo UV `#4b3cff`, akcent pomarańcz `#ff8a00` (tylko farba/listwy osłon rdzenia).

### 3.5 Elementy map (od 2026-10-31, D-028…D-031)
- **Okno strzeleckie** — parapet 1.1 m + nadproże od 1.85 m: stojący widzi i strzela przez otwór, kucający schowany.
- **Beczka / stos opon** — okrągła osłona 1.05 m (zasłania kucającego), kolizja 2 kwadraty 0°/45°.
- **Siatka maskująca** — blokuje ruch, przepuszcza wzrok i strzał; nie jest osłoną.
- **Drzwi przesuwne** — cykl z czasu meczu (deterministyczny), czujnik: nie zamykają się na żywym uczestniku; boty omijają
  zamknięte przejścia. UV Maze: bramy przy ostrogach N/S naprzemiennie; Orbita: pary N/S i E/W pierścienia w przeciwfazie.

## 4. Wygląd

- Ciemność dominuje: ściany czarne/granatowe, matowe, z **farbą UV** (proceduralne wzory: pasy, geometria,
  rozbryzgi, siatki) świecącą emisyjnie w kolorach palety.
- **Neonowe listwy** na górnych krawędziach ścian (i u podstawy części ścian) — emisyjne, łapią bloom.
- **Podłoga**: czarna, półbłyszcząca (odbicia neonów przez env map), subtelny wzór (gumowa mata / siatka).
- **Sufit**: ciemna kratownica z punktowymi lampami UV.
- **Mgła** wykładnicza w kolorze ciemnego fioletu + **dym** (miękkie, wolno dryfujące, warstwowe kłęby)
  — daleki plan zanika, światło „wisi" w powietrzu.
- **Bloom** mocny na neonach i wiązkach, bez przepaleń.
- Wiązki lasera: jasny rdzeń + kolorowa poświata, krótkie, z błyskiem przy lufie i iskrą w punkcie trafienia.
- Uczestnicy: ciemna sylwetka (kapsuła/stylizowany korpus) z kamizelką o 4 świecących segmentach.

## 5. Presety grafiki

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Pixel ratio | 0.75 | 1.0 | min(dpr,1.5) | min(dpr,2) |
| AA | brak | FXAA | MSAA 4× | MSAA 4× |
| Bloom | off | ½ rozdz. | pełny | pełny, mocniejszy, 5 mipów |
| Dym (cząsteczki, D-040) | 0 | 40 | 104 | 192 (Reactor × 1.35) |
| Ruchome głowice pod sufitem (D-040) | 4, snop bez plam | 6 + plamy | 8 + plamy | 8 + plamy |
| Światła punktowe | 0 | 2 | 4 | 6 |
| Odbicia podłogi (env map) | nie | nie | tak | tak |
| Rozdz. tekstur proceduralnych | 256 | 512 | 1024 | 1024 |
| Anizotropia | 1 | 2 | 4 | 8 |

Preset wybierany `?preset=low|medium|high|ultra` (domyślnie high) lub w menu.

## 6. Pętla wizualna

1. Zrzuty z kamer debug: `?map=<id>&preset=ultra&cam=<n>&nohud=1&seed=1` dla każdej kamery mapy (min. 4).
2. **ux-reviewer** dostaje tylko zrzuty + opis referencji (sekcja 4) + checklistę; ocenia tak/nie per punkt
   i zwraca listę różnic od największej.
3. Poprawki → nowe zrzuty → ponowna ocena. Mapa przechodzi, gdy **wszystkie** punkty = tak.

**Checklista:**
1. **Ciemność** — > 60% kadru to ciemne tony (czerń/granat/fiolet); brak szarych, płasko oświetlonych ścian.
2. **Neonowe listwy** — krawędzie ścian świecą w ≥ 2 kolorach palety, ciągłe, bez przerw i migotania.
3. **Farba UV** — wzory na ścianach czytelne i ostre, różnorodne, brak oczywistego powtarzania kafla.
4. **Bloom** — miękka poświata wokół neonów; brak przepaleń (białe plamy) i ogólnego „mydła".
5. **Mgła i dym** — wyraźna głębia (daleko = ciemniej, kolorowo); dym miękki, warstwowy, bez widocznych krawędzi billboardów.
6. **Podłoga** — ciemna, z pobłyskami/odbiciami neonów i subtelnym wzorem.
7. **Sufit** — arena zamknięta (kratownica/lampy), nie czarna pustka ani niebo.
8. **Czytelność** — przejścia, ściany i osłony łatwo odróżnialne z perspektywy gracza.
9. **Skala** — wysokość ścian i szerokość korytarzy wiarygodne dla kamery na wysokości oka.
10. **Paleta** — spójna (2–3 kolory przewodnie + akcent), brak przypadkowej tęczy.
11. **Artefakty** — brak z-fightingu, bandingu w mgle, czarnych/brakujących tekstur, schodków na listwach (Ultra).
12. **Nastrój** — całość wygląda jak prawdziwa hala laser tag w świetle UV, nie jak abstrakcyjne demo.

## 7. Optymalizacja i budżet

Budżet `renderer.info` (na klatkę, po postprocessingu, scena w trakcie meczu z 8 uczestnikami):

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Draw calls | ≤ 60 | ≤ 90 | ≤ 120 | ≤ 160 |
| Trójkąty | ≤ 120k | ≤ 200k | ≤ 350k | ≤ 600k |
| Tekstury (memory.textures) | ≤ 20 | ≤ 28 | ≤ 36 | ≤ 44 |
| Geometrie | ≤ 80 | ≤ 80 | ≤ 90 | ≤ 100 |

Zasady:
- Statyczna geometria areny **scalona per materiał** (BufferGeometryUtils.mergeGeometries) — kilka draw calli na całą mapę.
- **Zero alokacji w pętli gry**: pule obiektów (wiązki, iskry, cząsteczki), prealokowane wektory scratch, brak `new`/literałów obiektów/tablic/domknięć w `update`.
- Każda geometria/tekstura/materiał tworzona dynamicznie ma ścieżkę `dispose()`; zmiana mapy/presetu nie przecieka (stabilne `renderer.info.memory`).
- Brak cieni (oświetlenie emisyjne + bloom). Liczba świateł punktowych ograniczona presetem.
- Logika symulacji (fizyka, walka, AI) w czystym JS bez Three.js — testowalna w Node.
- Symulacja w stałym kroku 60 Hz, render co klatkę.

## 8. Architektura

```
index.html            importmap: three → vendor/three (przypięta wersja 0.170.0)
src/
  main.js             bootstrap (URL → Game)
  config.js           CONFIG — wszystkie liczby; PRESETS
  core/               loop (stały krok), rng (seed), pool, events, url params, vec3 bez alokacji
  world/              maps/*.js (dane), mapgen.js (dane → World), physics.js (kolizje, raycast), nav.js (graf + A*)
  game/               participant.js, weapon.js, combat.js, scoring.js, modes.js, match.js
  game/input/         InputSource: keyboardMouse.js, botBrain.js (w M5: networkInput.js)
  game/bots/          ai.js (FSM), adapt.js (adaptacja)
  render/             graphics.js (renderer+composer+presety), textures.js, arenaBuilder.js, smoke.js, ceilingLights.js,
                      beams.js, avatars.js, debugCams.js
  ui/                 hud.js, scoreboard.js, menu.js, endScreen.js (DOM + CSS)
tests/                unit/*.test.mjs (node --test), smoke/*.mjs (Playwright), tools/screens.mjs
```
- **Participant** = stan (pozycja, HP, broń, drużyna, wynik) + wymienne **InputSource**
  (`sample(participant, ctx, outInput)`) — gracz lokalny, bot, w przyszłości sieć.
- Symulacja nie zna Three.js; warstwa render czyta stan i rysuje.

## 9. Sterowanie i UI
- WASD ruch (chód 3.8 m/s, sprint 5.6 m/s), C kucanie (wysokość 1.15 m, oko 1.0 m, ×0.45 prędkości), mysz celowanie (pointer lock), LPM strzał, Shift sprint, Spacja skok, Tab tablica wyników, Esc pauza/menu.
- HUD (bez celownika — D-037): HP jako 4 segmenty (segment częściowo uszkodzony prążkowany), nazwa broni przy pasku ciepła, pasek ciepła, timer, wynik, feed eliminacji, wskaźnik trafienia, ekran eliminacji.
- Parametry URL: `?preset=&map=&mode=&bots=&diff=&cam=&nohud=1&stats=1&seed=&autostart=1&weapon=phaser|pistol|bouncer`; Custom: `&mode=custom&teams=2..4&per=1..⌊16/teams⌋` (za duże → przycięte, błędne → domyślne z `CONFIG.modes.custom`).

## 10. Roadmapa

| Etap | Zakres | Gotowe gdy |
|---|---|---|
| **M0 Arena** | szkielet, CONFIG, generator map, UV Maze, ruch FPP + kolizje, mgła + dym, bloom, presety, kamery debug | UV Maze przechodzi całą checklistę sekcji 6 na Ultra; ruch bez przenikania ścian; 0 błędów konsoli; budżet sekcji 7 |
| **M1 Strzelanie** | wiązka, hitboxy, 4 HP, kamizelka, eliminacja, respawn, ochrona, przegrzewanie, HUD | testy logiki walki zielone; można wyeliminować manekina; HUD pokazuje HP/ciepło; zero alokacji w pętli |
| **M2 Boty** | AI, graf nawigacji z danych mapy, 3 poziomy, adaptacja | boty patrolują bez utykania, walczą, szukają osłon; testy adaptacji zielone |
| **M3 Tryby** | ffa/tdm2/tdm4, spawny drużyn, timer, Tab, ekran końca, menu | pełny mecz od menu do ekranu końca w każdym trybie |
| **M4 Mapy** | Neon Hive, Reactor (2 poziomy) | obie mapy przechodzą pętlę wizualną; boty nawigują na obu poziomach |
| M5 Online | Supabase realtime | poza bieżącą sesją |

## 11. Testy
- Unit (Node, `node --test tests/unit`): kolizje, raycast, HP/eliminacja/respawn/ochrona, przegrzewanie, punktacja, nav/A*, adaptacja botów, mapgen.
- Smoke (Playwright, Chromium headless): każda mapa × preset ładuje się bez błędów/ostrzeżeń konsoli; `renderer.info` w budżecie.
- FPS w headless nie jest miarodajny.

## 12. Zasady pracy
- Wszystkie liczby w `CONFIG`. Funkcje małe, jednozadaniowe.
- Zero alokacji w pętli gry; `dispose()` dla wszystkiego, co tworzone dynamicznie.
- Każdy etap kończy commit z opisem: co, jak testować, `renderer.info` przed/po przy zmianach wizualnych.
- Liczby wydajności w `docs/PERF.md`. Decyzje w sekcji 14.

## 13. Otwarte kwestie
- Oryginalne zdjęcia referencyjne (`reference/ref1..4.png`) — brak; pętla wizualna opiera się na opisie z sekcji 4.
- M4: Neon Hive (snopy światła, czytelność heksów w bryle) i Reactor (pojedyncze elementy bez mocowań) nie mają 12/12 — patrz `docs/REPORT-FINAL.md` §2.
- FPS na prawdziwym GPU niezmierzony (headless = render programowy); odbicie planarne to największy koszt High/Ultra.
- Pod M5: walidacja nazw/kolorów z sieci, `window.__lt` tylko w trybie debug, wejście z numerem ticku, model server-authoritative.

## 14. Dziennik decyzji

| ID | Data | Decyzja | Uzasadnienie |
|---|---|---|---|
| D-001 | 2026-10-30 | SPEC zrekonstruowany z briefu; brak referencji PNG — używamy opisu słownego (sekcja 4). | Pliki nie istniały w repo ani na Drive; praca autonomiczna. |
| D-002 | 2026-10-30 | Three.js 0.170.0 vendorowany do `vendor/three` (importmap na ścieżki lokalne). | CDN zablokowany w środowisku; lokalna kopia = deterministyczne testy, przypięta wersja. |
| D-003 | 2026-10-30 | Brak cieni; oświetlenie emisyjne + bloom + ograniczona liczba point lights. | Estetyka UV hali + budżet draw calli. |
| D-004 | 2026-10-30 | Trafienie liczone na kapsule ciała, segment = najbliższy sensor. | Czytelne i uczciwe w FPP; sensory jako czysto wizualne/feedbackowe. |
| D-005 | 2026-10-30 | Fizyka własna (OBB w XZ + zakres Y, powierzchnie/rampy), bez silnika fizyki. | Prosta geometria aren, testowalność w Node, zero zależności. |
| D-006 | 2026-10-30 | Własne role subagentów (coder/tester/ux-reviewer/qa-security) niedostępne — `general-purpose` z rolą w prompcie. | Brak zdefiniowanych agentów w środowisku. |
| D-007 | 2026-10-30 | Tone mapping Neutral zamiast ACES (`CONFIG.render.toneMapping`). | ACES wybielał rdzenie cyjanowych listew i mieszał kanały. |
| D-008 | 2026-10-30 | Kolor `accent` (limonka) mapowany w rendererze na kolory główne dla listew/świateł; akcent tylko w ~8% farby. | Recenzja: limonka ważyła tyle co kolory przewodnie → „tęcza". |
| D-009 | 2026-10-30 | Strzał w chronionego: wiązka zatrzymuje się na nim (SHOT value=2), brak HIT i zmian HP. | Czytelny feedback, zgodny z §2.2. |
| D-010 | 2026-10-30 | Utrata pointer locka (Esc) w meczu = pauza symulacji (single-player); `?autostart=1` nie pauzuje. | Uczciwość wobec gracza; testy automatyczne. |
| D-011 | 2026-10-30 | Odbicia podłogi High/Ultra: render z lustrzanej kamery (½ rozdz., rozmyty) zamiast samej env mapy. | Env map dawała nietrafione, ledwo widoczne odbicia. |
| D-012 | 2026-10-30 | Gorąca ścieżka przekazuje współrzędne przez bufory Float64Array (SEG/RAYARG/NEAR/BOX). | V8 pakuje double w HeapNumber przy nie-inline'owanych wywołaniach → alokacje. |
| D-013 | 2026-10-30 | Sprint tylko gdy moveZ > 0 i moveZ ≥ |moveX|. | Brak sprintu bokiem przy wejściu analogowym/botach. |
| D-014 | 2026-10-30 | Obwód areny: ściany 1 m na zewnątrz bounds; spawny team = strona (N0,S1,E2,W3); tdm2 używa team%2. | Jedna konwencja danych dla wszystkich trybów. |
| D-015 | 2026-10-30 | Prędkości: chód 3.8 m/s, sprint 5.6 m/s (było 5.2/7.6). | Feedback z gry: „za szybko”; hala laser tag = tempo chodu. |
| D-016 | 2026-10-30 | Hit stun 0.45 s + boty w stylu zasadzkowym (HOLD przy osłonie, flankowanie na dźwięk, patrol chodem, krótszy dystans ognia). Percepcja bota w HOLD-kucu liczona z wysokości oka stojącego — celowo („wyglądanie” zza osłony połówkowej). | Feedback: „chodzi o atakowanie nagle zamiast nawalania się”. |
| D-017 | 2026-10-30 | Kolizje uczestnik–uczestnik (koło vs koło) + ukrywanie awatara przy kamerze; kucanie (C). | Feedback: „czarny klocek” = kamera w korpusie bota; brak kucania. |
| D-018 | 2026-10-31 | Ciała wyeliminowanych nie blokują żywych (separacja tylko żywy–żywy). | Unika blokowania przejść i rozpychania przy respawnie. |
| D-019 | 2026-10-31 | Kucanie tylko pod C (bez Ctrl); ekran końca ignoruje autorepeat i klawisze przez 0.5 s po pokazaniu. | QA: Ctrl+W zamyka kartę w trakcie gry (nie da się zablokować); trzymany skok/strafe restartował mecz. |
| D-020 | 2026-10-31 | NaN/Inf guard (ShaderPass) przed bloomem + clamp HDR 64 na High/Ultra. | Feedback: „czarne klocki" tylko na High/Ultra — pojedynczy NaN rozlewany przez mip-chain bloomu. |
| D-021 | 2026-10-31 | Farba UV: rozmyta maska + wyostrzanie smoothstep/fwidth w shaderze zamiast większych tekstur. | Feedback: pikseloza z bliska; bez wzrostu pamięci. |
| D-022 | 2026-10-31 | Pętla wizualna M4 zamknięta po 4 iteracjach (Hive 9–10/12, Reactor 10/12); otwarte punkty w REPORT-FINAL. | Brief: max ~3 próby na problem; oceny recenzentów oscylują ±1. |
| D-023 | 2026-10-31 | Stamina (`CONFIG.player.stamina`): drain 0.25/s, regen 0.2/s po 1 s (×1.5 stojąc/w kucu), wyczerpanie przy 0 → sprint dopiero od 0.35, skok −0.12 (niedostępny poniżej). Pola ciała `stamina`/`sprinting`/`exhausted` (kontrakt dla HUD); respawn = pełna. Boty: ta sama mechanika, sprint (odwrót/pościg) od stamina > 0.4 do < 0.15. Logika w małych helperach movement.js z dt przez Float64Array (D-012) — wpisana wprost w stepMovement powiększała funkcję tak, że V8 przestawał inline'ować moveBody (boxing dt). | Feedback: „nie można sprintować aż tyle”; sprint jako zasób zamiast stałego trybu. |
| D-024 | 2026-10-31 | Postać i broń FPP: animacja awatarów przez skinning w vertex shaderze (atrybut `aBone`, per-instancja `aAnim`/`aShape`), faza kroku z przebytego dystansu; ciało FPP (nogi/tors) jako ten sam model w osobnym InstancedMesh z ukrytą głową/ramionami, na warstwie bez odbicia; broń ×1.5 + ręce w jednym draw callu; pasek staminy w HUD. | Feedback: większa broń, widoczne ręce i nogi, animacja chodu; zero dodatkowych calli na awatary (odbicie podwaja koszt), zero alokacji. |
| D-025 | 2026-10-31 | UV Maze: przebudowa układu przy 36×36 m („trzy linie”, 58 brył, 904 węzły nav); test liczby brył 70 → 58. | Decyzja użytkownika: nowy układ, ten sam rozmiar; usunięcie 12 kieszeni, czytelny flow między placami. |
| D-026 | 2026-10-31 | `halfCoverNear` w ai.js dostaje punkt przez bufor `HC` (`halfCoverAt`), nie 3 double w argumentach. | Boxing V8 (jak D-012) ~0.6 B/krok w startHold/startHoldNear; test noalloc „gracz + 8 botów” był na granicy progu także na starej mapie. Resztkowe drobne alokacje (enterCover, headroomOk) poniżej progu — do zbadania. |
| D-027 | 2026-10-31 | Nowa mapa Orbita (koncepcja B z 3 propozycji); lampy bez koloru akcentu. | Wybór użytkownika; mechanika spiralnego dostępu do środka odrębna od UV Maze/Hive/Reactor; akcent w lampach dawał brązowe plamy na stropie (jak D-008). |
| D-028 | 2026-10-31 | Elementy map jako makra mapgen (walls: window/barrel/tires/net) na statycznych OBB; nowe pola Solid w makeSolid dla każdej bryły. | Fizyka/raycast/nav nie rozróżniają `kind` — elementy bez zmian w rdzeniu kolizji; stały kształt obiektu = brak deoptów V8. |
| D-029 | 2026-10-31 | Beczki/opony 1.05 m (nie 0.9) + zasięg cover/kucania +0.3 m dla propów. | 0.95 m nie zasłaniało oka kucającego (1.0 m); mały obrys → węzły nav 1.15–1.25 m od krawędzi, poza progiem cover 1.1 m. |
| D-030 | 2026-10-31 | Siatka maskująca: flaga `seeThrough` pomijana w raycast/segmentClear/cover; render przezroczysty z własną teksturą (+1 call, +1 tekstura). | Ażur z alphaTest znikał z odległości (mipmapy uśredniają alfę poniżej progu). |
| D-031 | 2026-10-31 | Drzwi przesuwne: stan w świecie (world.doorOpen), cykl z czasu meczu, czujnik bezpieczeństwa; SpatialGrid wpisuje bryłę w kubełki całego toru; nav: strefa drzwi = promień + ½ oczka. | Determinizm (pod M5) bez dynamicznej przebudowy siatki/grafu; czujnik eliminuje zgniatanie; węższa strefa przepuszczała krawędź nav przez zamknięte skrzydło 0.3 m. |
| D-032 | 2026-10-31 | Smoke: stan `playing` zamiast `countdown` przy pierwszej obserwacji startu = ostrzeżenie (wolne ładowanie), pozycje startowe sprawdzane tylko w odliczaniu; inne stany nadal porażką. | Ten sam wyścig po stronie testu co wcześniej przy obserwacji zamrożenia (zamrożenie pokrywa match.test.mjs); pojawiał się losowo na mapach bez zmian (Neon Hive), przy ładowaniu 3 stron równolegle w SwiftShader. |
| D-033 | 2026-10-31 | Pętla wizualna elementów zamknięta po 3 rundach (UV Maze 7 → 9 → 9, Orbita 7 → 8 → 8); otwarte: drzwi czytane jak przeszklony panel, stos opon słabo odróżnialny od beczki; kamery `window`/`door` w obu mapach; rurki UV tuż pod kratownicą i mgła bez indygo w Orbicie (klucze *Map). | Pozostałe NIE (dym, bloom, powtarzalność farby) to globalny renderer — decyzja użytkownika: wspólna runda renderu dla wszystkich map później. |
| D-034 | 2026-10-31 | Runda renderu (wszystkie mapy, 3 rundy): dym — warstwa środkowa 1.0–2.4 m z kryciem/jasnością per kłąb (128/64 cząstek Ultra/High), mniej płacht przyziemnych; emisja farby 0.75 → 0.62 (Reactor bez zmian przez paintIntensityMap), mniej poświaty na wierzchach brył, rzadsze i ciemniejsze rurki UV, ciemniejszy strop Orbity. Szerszy bloom i mniejsze motywy farby cofnięte. Wynik: UV Maze 9 → 10, Orbita 8 → 8, Hive 12 → 10, Reactor 10 → 8. | Bloom/skala farby dały regresję (brudne halo Hive, przepalony rdzeń i moiré Reactora) — cofnięte w rundzie 2; pozostały spadek Hive/Reactora vs wcześniejsze oceny mieści się częściowo w rozrzucie recenzentów (±1–2), punkty NIE: kolor mgły (turkus/zieleń z palet map), dym wciąż jako plamy, rurki UV bez czytelnych mocowań. |
| D-035 | 2026-10-31 | Drzwi: szyna-prowadnica na wspornikach (statyczna), pas ostrzegawczy w kolorze akcentu przy krawędzi natarcia, uchwyt; opony r 0.55, 4 sztuki z wcięciami i przerywanym bieżnikiem; siatka obwisła bez sztywnej ramy. | Recenzja: drzwi czytane jak okno (krzyż), opony nieodróżnialne od beczek, siatka jak ogrodzenie. |
| D-036 | 2026-10-31 | `Target crashed` w smoke (2 z 8 pełnych przebiegów) = OOM-kill cgroup (dmesg: chrome-headless 5 GB RSS); RSS pojedynczej strony jak przed sesją (UV Maze 889 vs 891 MB, Hive 933 vs 968, Reactor 906 vs 905). Test bez zmian. | Ograniczenie środowiska (wiele przeglądarek SwiftShader równolegle), nie regresja aplikacji; ewentualnie `--jobs 2` przy uruchamianiu smoke w tym kontenerze. |
| D-037 | 2026-11-01 | **Bronie + model obrażeń + brak celownika.** (1) Obrażenia w punktach: `combat.segmentPoints` = 4 punkty na segment; `P.hp` nadal = liczba segmentów (kontrakt HUD/botów/testów bez zmian), nowe `P.dmg` = punkty utracone w bieżącym segmencie (pełne 4 → −1 segment). Fazer zadaje 4 pkt (= dawne −1 HP), pistolet 2 pkt (½ segmentu), wyrzutnia 4. Punkty za trafienie proporcjonalne: `scoring.hit × dmg / segmentPoints` (seria pistoletu = 10 jak fazer); hit stun × `stunScale` broni. (2) Wyrzutnia: pocisk w sim (pula typed arrays, zero alokacji, deterministyczny), lot prostoliniowy bez grawitacji; **każda powierzchnia** (ściana, przeszkoda, rampa, podłoga, sufit) liczy się jako kontakt — 1. kontakt = odbicie lustrzane v − 2(v·n)n, 2. = znika; siatki maskujące przepuszczają (jak hitscan). Start z wylotu lufy awatara w kierunku punktu celowania z oka; strzelec nie trafia sam siebie, sojusznicy przepuszczani. Nowe zdarzenia LAUNCH/BOUNCE/PROJ_END i pola rekordu nx/ny/nz (normalna powierzchni, także w SHOT przy trafieniu w ścianę → odłamki). (3) Celownik usunięty całkowicie (bez zamiennika); broń FPP bliżej osi wzroku (`viewModel.weapons[typ].muzzle`), bez zmiany FOV. (4) Odłamki lasera = rozbudowane iskry z beams.js (ta sama pula, 1 draw call): kierunek odbity od normalnej + rozrzut, grawitacja, jedno słabe odbicie od podłogi (analitycznie w shaderze), życie 0.6–1.2 s. | Ułamkowe HP przez osobne pole zamiast skali `hp` × 4 — istniejące testy/boty/HUD ustawiają i czytają `hp` jako segmenty. Podłoga jako kontakt: jedna, przewidywalna reguła („drugi kontakt z czymkolwiek”) i strzały odbijane od podłogi pod przeszkodą; pocisk bez grawitacji, bo to impuls lasera, a tor prosty ułatwia odbicia zza rogu. Pozostałe bronie hitscan liczone w sim jak fazer (te same sensory/kapsuły). |
| D-039 | 2026-11-01 | Menu: zakładki SOLO / MULTIPLAYER; MULTIPLAYER → **Custom** (lokalnie z botami): 2–4 drużyny × 1…⌊16/drużyny⌋ osób, jedna liczebność dla wszystkich drużyn (`CONFIG.modes.custom`); sloty `{ team, kind: local/bot/remote }` (remote = typ pod M5, do czasu sieci bot). Spawny: 2 drużyny `sp.team % 2`, 3–4 drużyny `sp.team === team`. Punkt przesunięty od zajętego spawnu wolny przy luzie `combat.spawnOffsetClear` 0.8 m (zamiast `spawnOccupiedRadius` 1.5 m) i szukany wokół kolejnych dozwolonych spawnów. Numer D-037/D-038 zajęty w kodzie przez równoległe prace (bronie, mapy, render). | Jedna wartość „osób w drużynie” = prostszy, czytelny UI i równe drużyny; per-drużyna niepotrzebne bez sieci. Przy 3 drużynach % 3 dawało drużynie 0 dwie strony (N+W) — nierówno. `spawnOccupiedRadius` > `spawnOffset` sprawiał, że uczestnik stojący na spawnie blokował każdy punkt przesunięty: przy 16 osobach na 8 spawnach kilka ciał startowało w tym samym punkcie (test custom: min. odstęp ≥ 2 × promień ciała na wszystkich mapach). |
| D-038 | 2026-11-01 | Mapy: okna strzeleckie i stosy opon w Neon Hive (6 okien w pełnych bokach heksów pod 0/60°, tabela `WINDOWS` z przesunięciem jak `DOORS`; 4 opony), Reactor (4 okna na parterze w miejsce części ścian, 4 opony) i UV Maze (2 nowe okna 'ww' lane W/E, 2 nowe stosy opon). UV Maze otwarty: 20 komórek ścian mniej (78 → 58; 2 → osłony, 4 → okna), szersze bramy pierścienia i lane W/E 4 m, plac ~20×12 m; ściana r3 c3 (r14 c14) zostaje, bo bez niej lane W/E dawał linię spawn N ↔ spawn S przez okno. Bryły: UV Maze 74 → 76 (test mapgen), Hive 185 → 211, Reactor 60 → 80; węzły nav 912 → 960, 1081 → 1065, 1368 → 1354. Makro `window` z mapgen bez zmian (obsługuje `rot`). | Decyzja użytkownika („więcej wolnych korytarzy i przestrzeni”, więcej elementów). Bramki PROMPT-MAPY + nowa: żadna linia wzroku z otoczenia spawnu (±1.5 m, oko 1.65) na spawn wrogiej drużyny nie przechodzi przez otwór nowego okna — w Hive wymusiło to przesunięcie okna centrum ↔ R ENE ku narożnikowi (w środku boku tworzyło linię spawn E ↔ spawn W przez całą mapę). Reactor: okna tylko na parterze — makro okna nie ma `y` (galeria wymagałaby zmiany mapgen). |
| D-040 | 2026-11-01 | **Gęstszy dym + ruchome głowice pod sufitem (wszystkie mapy).** Dym: 0/40/104/192 kłębów (Low/Med/High/Ultra; było 0/24/64/128), Reactor × 1.35 (`smoke.countMap`), krycie 0.085 → 0.11, wraca warstwa podsufitowa (17%, do sufit − 0.8 m), płachty przyziemne słabsze (udział 0.2, krycie × 0.4 — nie czytają się jak plamy-decale). Głowice (`render/ceilingLights.js`, `CONFIG.render.movingHeads`): pod pasem dolnym dźwigarów, z dala od lamp/świetlówek/filarów, wybór najdalszy-od-wybranych; animacja pan/tilt deterministyczna z czasu (omiatanie do środka hali, co 3. głowica ciągły obrót); kolory z palety przez `lightColorHex`, bez akcentu (D-008). 2 draw calle: głowice (InstancedMesh, obrót jarzma/głowy w vertex shaderze) + snopy (InstancedMesh stożków addytywnych, długość = własny raycast promień–OBB/rampa/podłoga). Plamy: bez prawdziwych świateł — wspólne uniformy (≤ 8 snopów) w shaderze podłogi i ścian (stożek + gobo-pierścień, tylko do pierwszej przeszkody); dym w snopie łapie jego kolor (vertex shader dymu). Snopy i głowice poza odbiciem planarnym (jak stożki lamp — nie podwajają calli); plamy na ścianach widać w odbiciu, bo to shader ściany. Low: 4 głowice + przygaszony snop (× 0.6), bez plam; Medium: 6 + plamy; High/Ultra: 8 + plamy. | Brief: więcej dymu i klubowe skanery na suficie; budżet: +2 calle na każdym presecie (Ultra 52–58 / 160), zero alokacji w `update` (0 scavenge / 3 mln wywołań), PointLight bez zmian (limit presetu). Własny raycast zamiast `raycastWorld`: ten z physics.js przy promieniach w dół alokuje ~3–4 B/wywołanie (11 scavenge / 3 mln, semi-space 1 MB — do zbadania po stronie fizyki), a dodatkowo nie współdzielimy `RAYARG` z symulacją. |
