// Bootstrap aplikacji: URL → menu → mecz (sim + boty) → ekran końca → (mecz | menu). PLAN §9.3.
// Stan aplikacji: app = 'menu' | 'match' | 'end'. Grafika, efekty (wiązki, awatary, view model), wejście i UI
// tworzone raz; zmiana mapy = graphics.setWorld (zwalnia poprzednią arenę) + nowy nav; każdy mecz = nowy sim/adapt/HUD.
import { Vector3 } from 'three';
import { CONFIG } from './config.js';
import { parseParams } from './core/urlParams.js';
import { createLoop } from './core/loop.js';
import { MAPS } from './world/maps/index.js';
import { buildWorld } from './world/mapgen.js';
import { buildNav } from './world/nav.js';
import { raycastWorld, createHit } from './world/physics.js';
import { createGraphics } from './render/graphics.js';
import { applyDebugCam, listDebugCams } from './render/debugCams.js';
import { resetInputState } from './game/input/inputState.js';
import { createParticipant } from './game/participant.js';
import { createSim, addParticipant, stepSim, findParticipant } from './game/sim.js';
import { MODES, setupRoster, spawnTeamCount } from './game/modes.js';
import { createMatch, stepMatch, matchRunning } from './game/match.js';
import { createBotBrain } from './game/bots/ai.js';
import { createAdapt, recordFromEvents } from './game/bots/adapt.js';
import { EV } from './core/events.js';
import { createBeams } from './render/beams.js';
import { createAvatars } from './render/avatars.js';
import { createViewModel } from './render/viewModel.js';
import { createHud } from './ui/hud.js';
import { createMenu } from './ui/menu.js';
import { createScoreboard } from './ui/scoreboard.js';
import { createEndScreen } from './ui/endScreen.js';
import { createMatchBar } from './ui/matchBar.js';
import { createKeyboardMouse } from './game/input/keyboardMouse.js';
import { createStatsOverlay } from './ui/statsOverlay.js';

const READY_FRAMES = 3;
const MENU_CAM_TIME = 12;     // s na kamerę tła menu
const MENU_CAM_SWAY = 0.22;   // rad — powolne panoramowanie
const MENU_CAM_DOLLY = 0.6;   // m — powolny najazd
const EMPTY = [];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const params = parseParams(location.search);
const canvas = document.getElementById('game');
const hudEl = document.getElementById('hud');
const startEl = document.getElementById('start');
const ctaEl = document.getElementById('start-cta');
const startMenuBtn = document.getElementById('start-menu');

if (!has(MAPS, params.map)) {
  console.info(`[lasertag] nieznana mapa "${params.map}" → "${CONFIG.defaults.map}"`);
  params.map = CONFIG.defaults.map;
}

// --- Błędy krytyczne (brak WebGL, utrata kontekstu, wyjątek w pętli) → komunikat w DOM ---
let fatal = false;
function showFatal(msg, err) {
  fatal = true;
  if (err) console.error('[lasertag]', err);
  hudEl.classList.add('hidden');
  startMenuBtn.classList.add('hidden');
  ctaEl.textContent = msg;
  startEl.classList.remove('hidden');
  startEl.classList.add('lt-fatal');
}

let graphicsInit = null;
try {
  graphicsInit = createGraphics({ canvas, presetName: params.preset });
} catch (err) {
  showFatal('Brak WebGL 2 — gra wymaga przeglądarki z obsługą WebGL.', err);
}
if (graphicsInit !== null) boot(graphicsInit);

function boot(graphics) {
  // --- Grafika i efekty (raz) ---
  const camera = graphics.camera;
  camera.rotation.order = 'YXZ';
  const beams = createBeams(graphics.scene);
  const avatars = createAvatars(graphics.scene, CONFIG.combat.maxParticipants);
  const viewModel = createViewModel(camera, graphics.scene);
  viewModel.group.visible = false;

  // --- Świat (przebudowa przy zmianie mapy) ---
  let world = null;
  let nav = null;
  function loadMap(id) {
    if (world !== null && world.id === id) return;
    world = buildWorld(MAPS[id]);
    graphics.setWorld(world);
    nav = buildNav(world);
  }
  loadMap(params.map);

  // --- Stan meczu ---
  let app = 'menu';
  let sim = null;
  let match = null;
  let adapt = null;
  let player = null;
  let lastCfg = null;
  let hud = null;
  let paused = false;

  // --- Debug cam ---
  let debugCam = false;
  if (params.cam !== null) {
    debugCam = applyDebugCam(camera, world, params.cam);
    if (!debugCam) console.info(`[lasertag] brak kamery debug "${params.cam}" na mapie "${world.id}"`);
  }
  const showHud = !params.nohud;

  /** HUD i broń FPP tylko w meczu, bez ?nohud i bez kamery debug (czyste kadry dla screens.mjs). */
  function refreshVisibility() {
    const fpp = app !== 'menu' && showHud && !debugCam;
    viewModel.group.visible = fpp;
    hudEl.classList.toggle('hidden', !fpp);
  }

  // --- Wejście ---
  const km = createKeyboardMouse(canvas, {
    onLockChange(locked) {
      // spóźniony lock (np. szybkie Menu zaraz po starcie) poza meczem → natychmiast zwolnij
      if (locked && app !== 'match') { km.exitLock(); return; }
      updatePause();
    },
    onLockError: () => { if (paused) ctaEl.textContent = 'Nie udało się przechwycić myszy — kliknij ponownie'; },
    captureUnlocked: () => app === 'match' && params.autostart,
  });
  const playerSource = { sample: samplePlayer };

  function controlActive() {
    return app === 'match' && !debugCam && (km.locked || params.autostart);
  }

  let playerWasAlive = true;
  const muzzle = new Vector3();

  /** InputSource gracza. Respawn (eliminated → alive): kąty myszy = yaw spawnu PRZED sample (inaczej przy kilku
   *  krokach sim na klatkę stary yaw myszy nadpisałby kierunek spawnu). */
  function samplePlayer(P, ctx, out) {
    const alive = P.state === 'alive';
    if (alive && !playerWasAlive) km.setAngles(P.body.yaw, 0);
    playerWasAlive = alive;
    if (controlActive()) km.sample(P, ctx, out);
    else resetInputState(out);
  }

  // --- UI ---
  const menu = createMenu(document.body, {
    maps: MAPS, modes: MODES, presets: CONFIG.presets, diffs: CONFIG.bots.levels,
    initial: { map: params.map, mode: params.mode, diff: params.diff, preset: params.preset, bots: params.bots },
  }, (cfg) => startMatch(cfg));
  const scoreboard = createScoreboard(document.body);
  const endScreen = createEndScreen(document.body, () => startMatch(lastCfg), () => goMenu());
  const matchBar = createMatchBar(hudEl);
  matchBar.show(false);
  const stats = params.stats ? createStatsOverlay(graphics) : null;

  function setStartVisible(visible, text) {
    if (text) ctaEl.textContent = text;
    startEl.classList.toggle('hidden', !visible);
  }

  /** Pauza: mecz w toku bez pointer locka (Esc) → sim i mecz stoją. autostart / debug cam nie pauzują. */
  function updatePause() {
    if (fatal) return;
    const p = app === 'match' && !params.autostart && !debugCam && !km.locked;
    if (p === paused) return;
    paused = p;
    const fresh = match !== null && match.state === 'countdown' && match.countdown >= CONFIG.match.countdown;
    setStartVisible(p, fresh ? 'Kliknij, aby grać' : 'Pauza — kliknij, aby wrócić');
    startMenuBtn.classList.toggle('hidden', !p);
  }

  startEl.addEventListener('click', () => { if (paused && !fatal) km.requestLock(); });
  startEl.addEventListener('keydown', (e) => { if (e.code === 'Enter' && paused && !fatal) km.requestLock(); });
  startMenuBtn.addEventListener('click', (e) => { e.stopPropagation(); goMenu(); });

  // --- Przejścia stanów ---
  function sanitize(cfg) {
    const c = cfg || {};
    return {
      map: has(MAPS, c.map) ? c.map : CONFIG.defaults.map,
      mode: has(MODES, c.mode) ? c.mode : CONFIG.defaults.mode,
      diff: has(CONFIG.bots.levels, c.diff) ? c.diff : CONFIG.defaults.diff,
      preset: has(CONFIG.presets, c.preset) ? c.preset : graphics.presetName,
      bots: Number.isInteger(c.bots) ? c.bots : null,
    };
  }

  function startMatch(cfgIn) {
    // Lock na samym początku — w obrębie gestu użytkownika (Enter/klik); przebudowa mapy/presetu trwa i gest by wygasł.
    if (!params.autostart && !debugCam) km.requestLock();
    const cfg = sanitize(cfgIn);
    lastCfg = cfg;
    if (cfg.preset !== graphics.presetName) graphics.setPreset(cfg.preset);
    loadMap(cfg.map);

    sim = createSim({
      world,
      seed: params.seed === null ? world.seed : params.seed,
      teamCount: spawnTeamCount(cfg.mode),
    });
    adapt = createAdapt();
    player = null;
    const roster = setupRoster(cfg.mode, { bots: cfg.bots, diff: cfg.diff });
    for (const r of roster) {
      const P = addParticipant(sim, createParticipant({
        id: r.id, name: r.name, team: r.team, color: r.color, isPlayer: r.isPlayer,
        inputSource: r.isPlayer ? playerSource : createBotBrain({ level: r.level, nav, adapt }),
      }));
      if (r.isPlayer) player = P;
    }
    match = createMatch(sim, cfg.mode);

    if (hud !== null) hud.dispose();
    hud = createHud(hudEl);
    km.setAngles(player.body.yaw, 0);
    playerWasAlive = true;
    deadCam = false;
    eyeY = eyeHeight;

    app = 'match';
    menu.hide();
    endScreen.hide();
    matchBar.show(true);
    refreshVisibility();
    paused = false;
    updatePause();
  }

  function endMatch() {
    app = 'end';
    updatePause();
    km.exitLock();
    scoreboard.update(match, sim, false);
    endScreen.show(match, sim);
  }

  function goMenu() {
    app = 'menu';
    km.exitLock();
    updatePause();
    setStartVisible(false);
    startMenuBtn.classList.add('hidden');
    endScreen.hide();
    matchBar.show(false);
    if (match !== null) scoreboard.update(match, sim, false);
    refreshVisibility();
    if (hud !== null) { hud.dispose(); hud = null; }
    sim = null;
    match = null;
    player = null;
    menuCamT = 0;
    menu.show();
  }

  // --- Pętla ---
  function step(dt) {
    if (app !== 'match' || paused) return;
    stepMatch(match, sim, dt);
    if (matchRunning(match)) stepSim(sim, dt);
    if (match.state === 'ended') endMatch();
  }

  let time = 0;
  let rendered = 0;
  let menuCamT = 0;
  let sbVisible = false;
  const eyeHeight = CONFIG.player.eyeHeight;

  /** Zdarzenia symulacji → efekty; zwraca true, jeśli gracz strzelił w tej klatce. */
  function consumeEvents() {
    const q = sim.events;
    let fired = false;
    for (let i = 0; i < q.count; i++) {
      const e = q.at(i);
      if (e.type === EV.SHOT) {
        const shooter = findParticipant(sim, e.a);
        if (e.a === player.id && !debugCam) {
          // wizualnie wiązka gracza startuje z widocznej lufy FPP (sim liczy strzał z oka)
          viewModel.muzzleWorld(muzzle);
          beams.spawn(muzzle.x, muzzle.y, muzzle.z, e.x2, e.y2, e.z2, player.color, e.value === 1);
        } else if (shooter !== null) {
          beams.spawn(e.x, e.y, e.z, e.x2, e.y2, e.z2, shooter.color, e.value === 1);
        }
        if (e.a === player.id) fired = true;
      }
    }
    return fired;
  }

  /** Tło menu: kolejne kamery debug mapy z powolnym panoramowaniem i najazdem (bez alokacji). */
  function menuCamera(dt) {
    const cams = world.cams;
    if (!cams || cams.length === 0) return;
    menuCamT += dt;
    const k = Math.floor(menuCamT / MENU_CAM_TIME) % cams.length;
    const u = (menuCamT % MENU_CAM_TIME) / MENU_CAM_TIME;       // 0..1 w obrębie ujęcia
    const c = cams[k];
    let dx = c.look[0] - c.pos[0], dy = c.look[1] - c.pos[1], dz = c.look[2] - c.pos[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const a = MENU_CAM_SWAY * (u * 2 - 1);
    const ca = Math.cos(a), sa = Math.sin(a);
    const rx = dx * ca + dz * sa, rz = -dx * sa + dz * ca;
    const d = MENU_CAM_DOLLY * u;
    const px = c.pos[0] + dx * d, py = c.pos[1] + dy * d, pz = c.pos[2] + dz * d;
    camera.position.set(px, py, pz);
    camera.lookAt(px + rx * 10, py + dy * 10, pz + rz * 10);
  }

  // --- Kamera gracza: wygładzona wysokość oka (kucanie) + death cam ---
  const CC = CONFIG.camera;
  const TWO_PI = Math.PI * 2;
  const upHit = createHit();
  let eyeY = eyeHeight;          // wygładzony offset oka nad stopami
  let deadCam = false;           // death cam aktywna (wykrycie przejścia alive → eliminated)
  let deathT = 0, deathYaw = 0, deathPitch = 0, deathTopH = 0;

  function placeCamera(alpha, dt) {
    if (debugCam) return;
    const b = player.body;
    const x = player.prevX + (b.x - player.prevX) * alpha;
    const y = player.prevY + (b.y - player.prevY) * alpha;
    const z = player.prevZ + (b.z - player.prevZ) * alpha;
    eyeY += (b.eyeHeight - eyeY) * (1 - Math.exp(-CC.eyeSmoothing * dt));
    if (player.state !== 'alive') { deathCamera(x, y, z, dt); return; }
    deadCam = false;
    camera.position.set(x, y + eyeY, z);
    // Kąty na żywo z myszy (mniejsze opóźnienie); bez sterowania — z ciała.
    if (controlActive() && !paused) camera.rotation.set(km.pitch, km.yaw, 0);
    else camera.rotation.set(b.pitch, b.yaw, 0);
  }

  /** Death cam (SPEC §2.2): powolne uniesienie nad ciało (clamp pod sufitem/spodem bryły) i obrót w stronę zabójcy. */
  function deathCamera(x, y, z, dt) {
    if (!deadCam) {
      deadCam = true;
      deathT = 0;
      deathYaw = camera.rotation.y;
      deathPitch = camera.rotation.x;
      let top = CC.deathHeight;
      if (raycastWorld(sim.world, x, y + eyeY, z, 0, 1, 0, CC.deathHeight, upHit) && upHit.hit) {
        const lim = eyeY + upHit.dist - CC.ceilingClearance;
        if (lim < top) top = lim;
      }
      deathTopH = top > eyeY ? top : eyeY;
    }
    deathT += dt;
    const u = deathT >= CC.deathRise ? 1 : deathT / CC.deathRise;
    const e = 1 - (1 - u) * (1 - u); // ease-out
    const cy = y + eyeY + (deathTopH - eyeY) * e;
    camera.position.set(x, cy, z);
    const K = player.lastHitBy >= 0 ? findParticipant(sim, player.lastHitBy) : null;
    if (K !== null && K !== player) {
      const kb = K.body;
      const dx = kb.x - x, dz = kb.z - z;
      const hz = Math.hypot(dx, dz);
      if (hz > 1e-3) {
        const k = 1 - Math.exp(-CC.deathLookRate * dt);
        let d = Math.atan2(-dx, -dz) - deathYaw;
        d -= TWO_PI * Math.round(d / TWO_PI);
        deathYaw += d * k;
        deathPitch += (Math.atan2(kb.y + kb.eyeHeight - cy, hz) - deathPitch) * k;
      }
    }
    camera.rotation.set(deathPitch, deathYaw, 0);
  }

  function frameMatch(alpha, frameDt) {
    placeCamera(alpha, frameDt);
    const fired = consumeEvents();
    recordFromEvents(adapt, sim.events, player.id);
    // localId + pozycja kamery: avatars ukrywa lokalnego gracza i awatary zbyt blisko kamery
    // ciało FPP (tors + nogi przy patrzeniu w dół) tylko w widoku z oczu: bez kamery debug, ?nohud i death cam
    avatars.sync(sim.participants, alpha, time, debugCam ? -1 : player.id, camera, showHud && !debugCam && !deadCam);
    const b = player.body;
    viewModel.update(frameDt, player.weapon, fired, player.color, Math.hypot(b.vx, b.vz), player.stunTimer > 0, avatars.localGait);
    if (showHud && !debugCam) {
      hud.update(player, sim, frameDt);
      matchBar.update(match, sim);
      const sb = app === 'match' && !paused && km.scoreboard;
      if (sb || sbVisible) scoreboard.update(match, sim, sb);
      sbVisible = sb;
    }
    sim.events.clear();
  }

  function frame(alpha, frameDt) {
    if (stats) stats.begin();
    time += frameDt;
    if (sim !== null) frameMatch(alpha, frameDt);
    else {
      if (!debugCam) menuCamera(frameDt);
      avatars.sync(EMPTY, alpha, time, -1);
    }
    beams.update(frameDt, camera);
    graphics.update(frameDt, time);
    graphics.render();
    if (stats) stats.end();
    if (rendered < READY_FRAMES && ++rendered === READY_FRAMES) window.__lt.ready = true;
  }

  window.addEventListener('resize', () => graphics.resize());

  window.__lt = {
    ready: false,
    params,
    get app() { return app; },
    get sim() { return sim; },
    match: () => match,
    startMatch: (cfg) => startMatch(cfg === undefined ? lastCfg || params : cfg),
    goMenu: () => goMenu(),
    info: () => graphics.info(),
    /** Kąty sterowania gracza (testy/zrzuty: np. patrzenie w dół). */
    setAngles: (yaw, pitch) => km.setAngles(yaw, pitch),
    camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z, yaw: camera.rotation.y, pitch: camera.rotation.x }),
    setCam(i) {
      if (i === null || i === undefined) {
        debugCam = false;
        refreshVisibility();
        return true;
      }
      const ok = applyDebugCam(camera, world, i);
      if (ok) { debugCam = true; refreshVisibility(); }
      return ok;
    },
    setPreset: (n) => graphics.setPreset(n),
    cams: () => listDebugCams(world).map((c) => c.name),
    get world() { return { id: world.id, solids: world.solids.length }; },
  };

  // Start: ?autostart=1 → mecz od razu z parametrów URL. ?cam= (bez autostart) → sama arena z kamery debug
  // (bez menu, HUD, broni i postaci — czyste kadry dla tests/tools/screens.mjs). Inaczej menu.
  if (params.autostart) startMatch(params);
  else if (!debugCam) menu.show();
  refreshVisibility();

  const loop = createLoop({
    hz: CONFIG.sim.hz, maxSubSteps: CONFIG.sim.maxSubSteps, step, frame,
    onError: (err) => { km.exitLock(); showFatal('Błąd gry — odśwież stronę (F5).', err); },
  });

  // Utrata kontekstu WebGL: stop pętli + komunikat; po przywróceniu przebudowa zasobów presetu i wznowienie.
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    loop.stop();
    km.exitLock();
    showFatal('Utracono kontekst grafiki — przywracanie…');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    try {
      graphics.setPreset(graphics.presetName);
      graphics.resize();
    } catch (err) {
      showFatal('Nie udało się przywrócić grafiki — odśwież stronę (F5).', err);
      return;
    }
    fatal = false;
    startEl.classList.remove('lt-fatal');
    startEl.classList.add('hidden');
    paused = false;
    refreshVisibility();
    updatePause();
    loop.start();
  });

  graphics.resize();
  loop.start();
}
