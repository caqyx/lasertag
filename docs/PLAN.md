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

## 7. Etapy późniejsze (szkic kontraktów)
- **M1**: `participant.js` (`createParticipant({ id, name, team, color, inputSource })` = body + hp + weapon + stany),
  `weapon.js` (`createWeapon()`, `stepWeapon(w, wantFire, dt) → fired:boolean`), `combat.js`
  (`raycastParticipants`, `applyHit`, `stepCombatState` eliminacja/respawn/ochrona), `scoring.js`, `beams.js` (pula), `avatars.js`, `hud.js`.
- **M2**: `nav.js` (`buildNav(world) → { nodes, edges, findPath(a,b,outPath), nearestNode(x,y,z) }`), `bots/ai.js` (FSM jako InputSource), `bots/adapt.js`.
- **M3**: `modes.js`, `match.js` (timer, limity, koniec), `ui/scoreboard.js`, `ui/menu.js`, `ui/endScreen.js`.
- **M4**: `maps/neonhive.js`, `maps/reactor.js` + decor (rdzeń reaktora).

## 8. Podział pracy M0 (równolegle, rozłączne pliki)
| Coder | Pliki |
|---|---|
| A — świat | `src/core/rng.js`, `src/world/maps/uvmaze.js`, `src/world/maps/index.js`, `src/world/mapgen.js`, `src/world/physics.js`, `src/game/movement.js` |
| B — grafika | `src/render/graphics.js`, `textures.js`, `arenaBuilder.js`, `smoke.js` |
| C — aplikacja | `index.html`, `styles.css`, `src/main.js`, `src/core/loop.js`, `src/core/urlParams.js`, `src/game/input/keyboardMouse.js`, `src/render/debugCams.js`, `src/ui/statsOverlay.js` |
| Orkiestrator | `src/config.js`, `src/game/input/inputState.js`, `tools/serve.mjs`, `package.json`, docs |
