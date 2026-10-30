// Bootstrap aplikacji (M0): URL → świat → grafika → gracz → pętla.
import { CONFIG } from './config.js';
import { parseParams } from './core/urlParams.js';
import { createLoop } from './core/loop.js';
import { MAPS } from './world/maps/index.js';
import { buildWorld } from './world/mapgen.js';
import { createGraphics } from './render/graphics.js';
import { applyDebugCam, listDebugCams } from './render/debugCams.js';
import { resetInputState } from './game/input/inputState.js';
import { createParticipant } from './game/participant.js';
import { createSim, addParticipant, stepSim, findParticipant } from './game/sim.js';
import { createDummyInput } from './game/input/dummyInput.js';
import { EV } from './core/events.js';
import { createBeams } from './render/beams.js';
import { createAvatars } from './render/avatars.js';
import { createViewModel } from './render/viewModel.js';
import { createHud } from './ui/hud.js';
import { createKeyboardMouse } from './game/input/keyboardMouse.js';
import { createStatsOverlay } from './ui/statsOverlay.js';

const READY_FRAMES = 3;

const params = parseParams(location.search);
const canvas = document.getElementById('game');
const hudEl = document.getElementById('hud');
const startEl = document.getElementById('start');
const ctaEl = document.getElementById('start-cta');

// --- Świat i grafika ---
let mapId = params.map;
if (!Object.prototype.hasOwnProperty.call(MAPS, mapId)) {
  console.info(`[lasertag] nieznana mapa "${mapId}" → "${CONFIG.defaults.map}"`);
  mapId = CONFIG.defaults.map;
  params.map = mapId;
}
const world = buildWorld(MAPS[mapId]);
const graphics = createGraphics({ canvas, presetName: params.preset });
graphics.setWorld(world);
const camera = graphics.camera;
camera.rotation.order = 'YXZ';

// --- Symulacja: gracz + manekiny (M1) ---
const sim = createSim({ world, seed: params.seed === null ? world.seed : params.seed });
const playerSource = { sample: samplePlayer };
const player = addParticipant(sim, createParticipant({
  id: 0, name: 'Ty', team: -1, color: CONFIG.colors.ffa[1], isPlayer: true, inputSource: playerSource,
}));
for (let i = 1; i <= CONFIG.combat.dummy.count; i++) {
  addParticipant(sim, createParticipant({
    id: i, name: `Manekin ${i}`, team: -1, color: CONFIG.colors.ffa[(i + 1) % CONFIG.colors.ffa.length],
    inputSource: createDummyInput({ strafe: i % 2 === 1 }),
  }));
}
const body = player.body;

// --- Debug cam / UI ---
let debugCam = false;
if (params.cam !== null) {
  debugCam = applyDebugCam(camera, world, params.cam);
  if (!debugCam) console.info(`[lasertag] brak kamery debug "${params.cam}" na mapie "${mapId}"`);
}

function setStartVisible(visible, text) {
  if (text) ctaEl.textContent = text;
  startEl.classList.toggle('hidden', !visible);
}

const km = createKeyboardMouse(canvas, {
  onLockChange(locked) {
    if (params.nohud || debugCam) return;
    if (locked) setStartVisible(false);
    else if (!params.autostart) setStartVisible(true, 'Pauza — kliknij, aby wrócić');
  },
});
km.setAngles(body.yaw, 0);

function samplePlayer(P, ctx, out) {
  if (controlActive()) km.sample(P, ctx, out);
  else resetInputState(out);
}

if (params.nohud) hudEl.classList.add('hidden');
if (params.nohud || debugCam || params.autostart) setStartVisible(false);
startEl.addEventListener('click', () => km.requestLock());
startEl.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') km.requestLock();
});

const stats = params.stats ? createStatsOverlay(graphics) : null;

// --- Efekty i HUD (M1) ---
const beams = createBeams(graphics.scene);
const avatars = createAvatars(graphics.scene, CONFIG.combat.maxParticipants);
const viewModel = createViewModel(camera, graphics.scene);
const hud = createHud(hudEl);
if (params.nohud || debugCam) viewModel.group.visible = false;

// --- Pętla ---
function controlActive() {
  return !debugCam && (km.locked || params.autostart);
}

function step(dt) {
  stepSim(sim, dt);
}

let time = 0;
let rendered = 0;
const eyeHeight = CONFIG.player.eyeHeight;

/** Zdarzenia symulacji → efekty; zwraca true, jeśli gracz strzelił w tej klatce. */
function consumeEvents() {
  const q = sim.events;
  let fired = false;
  for (let i = 0; i < q.count; i++) {
    const e = q.at(i);
    if (e.type === EV.SHOT) {
      const shooter = findParticipant(sim, e.a);
      if (shooter !== null) beams.spawn(e.x, e.y, e.z, e.x2, e.y2, e.z2, shooter.color, e.value === 1);
      if (e.a === player.id) fired = true;
    } else if (e.type === EV.RESPAWN && e.a === player.id) {
      km.setAngles(body.yaw, 0);
    }
  }
  return fired;
}

function placeCamera(alpha) {
  if (debugCam) return;
  camera.position.set(
    player.prevX + (body.x - player.prevX) * alpha,
    player.prevY + (body.y - player.prevY) * alpha + eyeHeight,
    player.prevZ + (body.z - player.prevZ) * alpha,
  );
  // Kąty na żywo z myszy (mniejsze opóźnienie); bez sterowania — z ciała.
  if (controlActive() && player.state === 'alive') camera.rotation.set(km.pitch, km.yaw, 0);
  else camera.rotation.set(body.pitch, body.yaw, 0);
}

function frame(alpha, frameDt) {
  if (stats) stats.begin();
  time += frameDt;
  placeCamera(alpha);
  const fired = consumeEvents();
  avatars.sync(sim.participants, alpha, time, debugCam ? -1 : player.id);
  beams.update(frameDt, camera);
  viewModel.update(frameDt, player.weapon, fired, player.color, Math.hypot(body.vx, body.vz));
  if (!params.nohud && !debugCam) hud.update(player, sim, frameDt);
  sim.events.clear();
  graphics.update(frameDt, time);
  graphics.render();
  if (stats) stats.end();
  if (rendered < READY_FRAMES && ++rendered === READY_FRAMES) window.__lt.ready = true;
}

window.addEventListener('resize', () => graphics.resize());

window.__lt = {
  ready: false,
  params,
  info: () => graphics.info(),
  setCam(i) {
    if (i === null || i === undefined) { debugCam = false; viewModel.group.visible = !params.nohud; return true; }
    const ok = applyDebugCam(camera, world, i);
    if (ok) { debugCam = true; viewModel.group.visible = false; }
    return ok;
  },
  setPreset: (n) => graphics.setPreset(n),
  cams: () => listDebugCams(world).map((c) => c.name),
  world: { id: world.id, solids: world.solids.length },
  sim,
};

const loop = createLoop({ hz: CONFIG.sim.hz, maxSubSteps: CONFIG.sim.maxSubSteps, step, frame });
graphics.resize();
loop.start();
