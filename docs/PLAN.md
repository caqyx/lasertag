# PLAN — architektura i interfejsy

Źródło prawdy: `docs/SPEC.md`. Ten plik definiuje **kontrakty między modułami**. Zmiana kontraktu = decyzja orkiestratora (wpis w SPEC §14).

## 0. Konwencje
- Moduły ES, bez bundlera. `three` i `three/addons/` przez importmap → `vendor/three/` (0.170.0).
- Układ: metry, Y w górę. **yaw = 0 patrzy w −Z**, yaw rośnie w lewo (konwencja Three.js: obrót wokół +Y). Wektor patrzenia: `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`.
- Kod symulacji (`src/world/`, `src/game/` poza `input/keyboardMouse.js`) **nie importuje three** i działa w Node.
- Zero alokacji w `step()/update()/render()`: scratch obiekty na poziomie modułu, pule.
- Liczby wyłącznie z `src/config.js` (`CONFIG`). Dane map w `src/world/maps/*.js` (to dane, nie liczby konfiguracyjne).
- Serwer dev: `node tools/serve.mjs` (port 8080). Testy: `npm test` (unit), `npm run smoke` (Playwright).
- Playwright: zainstalowany globalnie; w skryptach `.mjs` ładuj przez `createRequire(import.meta.url)('playwright')` z `NODE_PATH=$(npm root -g)` (skrypty npm to ustawiają). **Nie instalować** playwrighta.
- Chromium headless: `chromium.launch({ args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] })` (WebGL2 działa).

## 1. Dane mapy (`src/world/maps/<id>.js`, `export default MapData`)
```js
MapData = {
  id: 'uvmaze', name: 'UV Maze', seed: 1337,
  size: { w: 36, d: 36 },            // arena wycentrowana w (0,0): x∈[-w/2,w/2], z∈[-d/2,d/2]
  ceiling: 4.5,                       // wysokość sufitu
  perimeter: { h: 4.5, paint: 'stripes' },   // mapgen dodaje 4 ściany obwodowe (kind 'wall', boundary:true)
  palette: { primary, secondary, uv, accent, fog, ambient },   // '#rrggbb'
  grid: { cell: 2, rows: ['#####...', ...] },  // opcjonalnie; legenda: '#' ściana pełna, 'h' osłona połówkowa,
                                               // 'o' filar, '.' pusto. Wiersz 0 = z min, kolumna 0 = x min.
  walls: [ { x, z, w, d, h, y: 0, rot: 0, kind: 'wall'|'half'|'pillar'|'platform'|'prop',
             paint?: 'stripes'|'geo'|'splatter'|'grid'|'none', trim?: 'primary'|'secondary'|'accent'|'uv'|'none',
             trimBottom?: bool } ],     // jawne bryły (dodawane do tych z grid); rot w radianach wokół Y
  ramps: [ { x, z, w, d, rot, y0, y1 } ],      // wznosi się wzdłuż lokalnego +Z: y0 przy -d/2, y1 przy +d/2
  decor: [ { type: 'reactorCore'|'truss'|..., ... } ],  // tylko wizualne, renderer interpretuje, mapgen przepuszcza
  lights: [ { x, y, z, color, intensity, range } ],     // kolejność = priorytet (preset bierze pierwsze N)
  spawns: [ { x, z, y: 0, yaw, team: 0..3 } ],          // team = indeks drużyny dla trybów tdm (ffa ignoruje)
  cams: [ { name, pos: [x,y,z], look: [x,y,z] } ],      // kamery debug (min. 4)
}
```

## 2. World (`src/world/mapgen.js`)
```js
buildWorld(mapData) → World
World = {
  id, name, seed, palette, ceiling, size,
  bounds: { minX, maxX, minZ, maxZ },
  solids: Solid[],          // wszystkie bryły kolizyjne (grid + walls + obwód), runy z grid scalone
  ramps: Ramp[],
  grid: SpatialGrid,        // kubełki indeksów solids/ramps (komórka CONFIG-niezależna, np. 4 m) do szybkich zapytań
  spawns, lights, cams, decor,   // przepisane z danych (spawny z y uzupełnionym)
}
Solid = { kind, cx, cz, hx, hz, y0, y1, rot, cos, sin, paint, trim, trimBottom, boundary }
        // OBB w XZ (połowy wymiarów hx,hz w lokalnym układzie), zakres pionowy [y0,y1]
Ramp  = { cx, cz, hx, hz, rot, cos, sin, y0, y1 }
```
- Determinizm: brakujące `paint`/`trim` przypisywane przez seeded RNG (`src/core/rng.js`, mulberry32) z `mapData.seed`.

## 3. Fizyka (`src/world/physics.js`) — czysta, bez alokacji
```js
groundHeight(world, x, z, feetY, radius) → number   // najwyższa powierzchnia (podłoga 0 / top bryły / rampa) ≤ feetY + stepHeight
moveBody(world, body, dt) → void   // grawitacja, integracja, kolizje z solids (koło vs OBB w lokalnym XZ, gdy zakresy Y się nakładają
                                   // powyżej feetY+stepHeight), wejście na stopnie, rampy, sufit (głowa vs spód bryły), bounds; ustawia body.onGround
raycastWorld(world, ox,oy,oz, dx,dy,dz, maxDist, outHit) → boolean   // ray vs OBB (slab w lokalnym układzie) + podłoga/sufit
       // outHit = { hit, dist, x, y, z, nx, ny, nz, index }   (index bryły, -1 podłoga/sufit)
segmentClear(world, ax,ay,az, bx,by,bz) → boolean    // linia wzroku
createHit() → outHit
```

## 4. Ruch (`src/game/movement.js`) — czysty
```js
createBody() → Body = { x,y,z, vx,vy,vz, yaw, pitch, onGround, radius, height }
stepMovement(body, input, dt, world) → void   // input → przyspieszenie (CONFIG.player), sprint, skok, tarcie; potem physics.moveBody
```
`InputState` (`src/game/input/inputState.js`): `{ moveX, moveZ, yaw, pitch, fire, jump, sprint, scoreboard }`; moveX/moveZ ∈ [-1,1] lokalnie (moveZ=+1 = do przodu).
**InputSource** (interfejs dla Participant): `sample(participant, ctx, outInput)` — wypełnia outInput, bez alokacji.

## 5. Grafika (`src/render/`)
```js
// graphics.js
createGraphics({ canvas, presetName }) → Graphics = {
  renderer, scene, camera,              // PerspectiveCamera (CONFIG.player.fov)
  setPreset(name), presetName,          // przebudowa composera/AA/bloom/dymu/świateł/tekstur bez wycieków
  setWorld(world),                      // buduje arenę (arenaBuilder), dym, światła, mgłę; dispose poprzedniej
  update(dt, time),                     // animacje (dym, pulsowanie)
  render(),                             // renderer.info.autoReset=false; reset na początku klatki → info obejmuje całą klatkę
  resize(),
  info() → { calls, triangles, points, lines, textures, geometries, programs },
  dispose(),
}
// textures.js   — proceduralne CanvasTexture (farba UV ×4 style, podłoga, sufit, dym) wg rozdzielczości presetu; cache + disposeAll()
// arenaBuilder.js — buildArena(world, preset, textures) → { group, dispose(), update(time) }
//                  geometria scalona per materiał; listwy neonowe jednym meshem z vertexColors (HDR)
// smoke.js     — createSmoke(world, count, rng) → { mesh, update(dt, camera), dispose() }  (1 draw call, InstancedMesh billboardów)
// debugCams.js — applyDebugCam(camera, world, camParam) → boolean
// beams.js (M1), avatars.js (M1)
```

## 6. Aplikacja (`index.html`, `src/main.js`, `src/core/`)
- `src/core/urlParams.js`: `parseParams(search) → { preset, map, mode, bots, diff, cam, nohud, stats, seed, autostart }`.
- `src/core/loop.js`: `createLoop({ hz, maxSubSteps, step(dt), frame(alpha, frameDt) }) → { start(), stop() }` (stały krok, akumulator).
- `src/game/input/keyboardMouse.js`: `createKeyboardMouse(canvas) → { sample(participant, ctx, out), dispose(), locked }`.
- `src/ui/statsOverlay.js`: `?stats=1` → stats.js + panel `renderer.info`.
- `window.__lt` (zawsze): `{ ready, params, info(), setCam(i), world: { id, solids: n } }` — dla testów/zrzutów.
- `src/world/maps/index.js`: `MAPS = { uvmaze, neonhive, reactor }`.

## 7. M1 — strzelanie (kontrakty)

### 7.1 Zdarzenia (`src/core/events.js`)
```js
createEventQueue(capacity) → Q = { push(type) → Rec, count, at(i) → Rec, clear() }   // pierścień prealokowanych rekordów
Rec = { type, time, a, b, team, sensor, x, y, z, x2, y2, z2, value }   // a = sprawca (id), b = cel (id) lub -1
EV = { SHOT:1, HIT:2, ELIM:3, RESPAWN:4, OVERHEAT:5, PROTECT_END:6 }   // stałe typów (eksport)
```
Symulacja czyści kolejkę na początku `stepSim`? **Nie** — kolejka jest czyszczona przez właściciela pętli raz na klatkę renderu
(po tym, jak render/HUD ją przeczytały), bo w jednej klatce może być kilka kroków symulacji.

### 7.2 Uczestnik (`src/game/participant.js`)
```js
createParticipant({ id, name, team, color, isPlayer, inputSource }) → P = {
  id, name, team, color /* '#rrggbb' */, isPlayer, inputSource,
  body /* movement.createBody() */, input /* createInputState() */, prevX, prevY, prevZ,   // do interpolacji renderu
  hp, state /* 'alive'|'eliminated' */, stateTimer, protectTimer,
  weapon /* createWeapon() */,
  sensorFlash: Float32Array(4) /* timery błysku [front, back, left, right] */, sensorsLit: 4,
  stats: { score, hits, elims, deaths, shots },
  lastHitBy, lastHitTime, lastHitDirX, lastHitDirZ,   // do wskaźnika kierunku trafienia
}
SENSOR = { FRONT:0, BACK:1, LEFT:2, RIGHT:3 }
```

### 7.3 Broń (`src/game/weapon.js`)
```js
createWeapon() → W = { heat, cooldown, sinceShot, overheated }
stepWeapon(W, wantFire, dt) → boolean fired       // SPEC §2.3, CONFIG.weapon
```

### 7.4 Walka (`src/game/combat.js`)
```js
eyeRay(P, out)                                    // out = { ox,oy,oz, dx,dy,dz } z pozycji oka i yaw/pitch (PLAN §0)
rayVsParticipant(P, ox,oy,oz, dx,dy,dz, maxDist) → dist | -1   // kapsuła pionowa CONFIG.combat.hitCapsule*
nearestSensor(P, x,y,z) → SENSOR index           // sensory obrócone o body.yaw
resolveShot(sim, shooter)                         // world raycast + uczestnicy (pomija siebie, wyeliminowanych, sojuszników
                                                  // gdy !friendlyFire — przelatuje przez nich), emituje SHOT (+HIT/ELIM)
applyHit(sim, shooter, target, sensor, hx,hy,hz)  // ochrona → brak efektu; hp−1, błysk, punkty, eliminacja przy 0
stepParticipantState(sim, P, dt)                  // timery: eliminacja → respawn (pickSpawn), ochrona, błyski
pickSpawn(sim, P) → spawn                         // najdalszy od żywych wrogów z linią wzroku (fallback: najdalszy od wszystkich)
```
Strzał przerywa ochronę (PROTECT_END).

### 7.5 Punktacja (`src/game/scoring.js`)
`awardHit(sim, shooter, target)`, `awardElim(sim, shooter, target)` — CONFIG.scoring; wyniki drużyn liczone w `teamScores(sim, out)`.

### 7.6 Symulacja (`src/game/sim.js`)
```js
createSim({ world, seed, friendlyFire }) → sim = { world, rng, participants: [], events, time, teams: [] }
addParticipant(sim, P)        // ustawia na spawnie (pickSpawn), state alive, hp max
stepSim(sim, dt)              // dla każdego P: prev = pos; inputSource.sample(P, sim, P.input);
                              // stepParticipantState; jeśli alive: stepMovement; stepWeapon(input.fire) → resolveShot
```
`InputSource` dla manekina: `src/game/input/dummyInput.js` → `createDummyInput({ strafe:boolean })` (stoi lub powoli chodzi lewo-prawo).

### 7.7 Render/UI M1
```js
// src/render/beams.js
createBeams(scene, capacity) → { spawn(x,y,z, x2,y2,z2, colorHex, hit:boolean), update(dt, camera), dispose() }
   // 1 draw call: InstancedMesh billboardowych wstęg (rdzeń + poświata w shaderze), pula; iskry w punkcie trafienia (osobna pula Points/Instanced, 1 call)
// src/render/avatars.js
createAvatars(scene, maxCount) → { sync(participants, alpha, time, localId), dispose() }
   // InstancedMesh: korpus (ciemny), głowa/hełm, 4 sensory kamizelki (emisyjne, kolor uczestnika; zgaszone = ciemne;
   // błysk = biały; eliminacja = miganie; ochrona = pulsowanie), broń; lokalny gracz ukryty. ≤ 6 draw calli łącznie.
// src/render/viewModel.js
createViewModel(camera) → { update(dt, weapon, firedThisFrame, color), dispose() }   // fazer FPP, pasek ciepła na broni, odrzut
// src/ui/hud.js
createHud(rootEl) → { update(player, sim, dt), dispose() }   // HP 4 segmenty, ciepło, trafienie (hitmarker), kierunek
   // trafienia, ekran eliminacji z odliczaniem, ochrona, feed eliminacji (z kolejki zdarzeń); DOM aktualizowany tylko przy zmianie
```

## 8. M2 — boty (kontrakty)

### 8.1 Nawigacja (`src/world/nav.js`) — czysta, bez three
```js
buildNav(world) → Nav = {
  count, x: Float32Array, y: Float32Array, z: Float32Array,       // węzły (próbkowanie co CONFIG.nav.cell na powierzchniach chodliwych, clearance od brył)
  edgeStart: Int32Array(count+1), edges: Int32Array, cost: Float32Array,   // CSR; krawędź = przejście możliwe dla kapsuły gracza (bez skoku), też rampy/poziomy
  cover: Uint8Array?                                               // opcjonalnie: węzły przy osłonach (połówki/filary/narożniki)
}
nearestNode(nav, x, y, z) → index | -1          // najbliższy węzeł na tym samym poziomie (|dy| < 1), preferuj z linią przejścia
findPath(nav, from, to, outPath: Int32Array) → length (0 = brak)   // A* z prealokowanymi buforami (bez alokacji), ścieżka wygładzona? (opcjonalnie: smoothPath)
randomNode(nav, rng) → index
```
Wymóg: z każdego spawnu osiągalne ≥ 98% węzłów; na mapach 2-poziomowych (M4) krawędzie przez rampy.

### 8.2 Bot (`src/game/bots/ai.js`) — InputSource
```js
createBotBrain({ level: 'easy'|'normal'|'hard', nav, adapt }) → { sample(P, sim, out), state, target }
```
FSM wg SPEC §2.5: patrol → namierzanie (reakcja, obrót z limitem °/s, rozrzut σ, serie) → osłona → pościg. Widzenie: dystans, FOV, `segmentClear`
oko→oko (z rozłożeniem zapytań w czasie: CONFIG.bots.thinkInterval). Ruch: podążanie za ścieżką (`findPath`), strafe w walce, wykrywanie utknięcia
(CONFIG.bots.stuckTime → nowa ścieżka). Bot nie strzela do sojuszników, nie strzela przegrzany (czeka), ma rozsądną dyscyplinę ognia. Zero alokacji w sample.

### 8.3 Adaptacja (`src/game/bots/adapt.js`)
```js
createAdapt() → A = { offset, ... }
recordEvent(A, time, kind /* 'kill'|'death' gracza */)
stepAdapt(A, time) → void                        // co CONFIG.bots.adapt.evalInterval wg SPEC §2.5
skillScale(A, level) → { aimSigma, reaction, turn }   // zapis do prealokowanego obiektu; dotyczy botów-przeciwników gracza
```

## 9. Etapy późniejsze (szkic)
- **M3**: `modes.js`, `match.js` (timer, limity, koniec), `ui/scoreboard.js`, `ui/menu.js`, `ui/endScreen.js`.
- **M4**: `maps/neonhive.js`, `maps/reactor.js` + decor (rdzeń reaktora).

## 10. Podział pracy M0 (równolegle, rozłączne pliki)
| Coder | Pliki |
|---|---|
| A — świat | `src/core/rng.js`, `src/world/maps/uvmaze.js`, `src/world/maps/index.js`, `src/world/mapgen.js`, `src/world/physics.js`, `src/game/movement.js` |
| B — grafika | `src/render/graphics.js`, `textures.js`, `arenaBuilder.js`, `smoke.js` |
| C — aplikacja | `index.html`, `styles.css`, `src/main.js`, `src/core/loop.js`, `src/core/urlParams.js`, `src/game/input/keyboardMouse.js`, `src/render/debugCams.js`, `src/ui/statsOverlay.js` |
| Orkiestrator | `src/config.js`, `src/game/input/inputState.js`, `tools/serve.mjs`, `package.json`, docs |
