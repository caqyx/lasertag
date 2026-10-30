// Bootstrap aplikacji (M0): URL → świat → grafika → gracz → pętla.
import { CONFIG } from './config.js';
import { parseParams } from './core/urlParams.js';
import { createLoop } from './core/loop.js';
import { MAPS } from './world/maps/index.js';
import { buildWorld } from './world/mapgen.js';
import { createGraphics } from './render/graphics.js';
import { applyDebugCam, listDebugCams } from './render/debugCams.js';
import { createBody, stepMovement } from './game/movement.js';
import { createInputState } from './game/input/inputState.js';
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

// --- Gracz ---
const body = createBody();
const input = createInputState();
const spawn = world.spawns && world.spawns[0];
if (spawn) {
  body.x = spawn.x; body.y = spawn.y || 0; body.z = spawn.z;
  body.yaw = spawn.yaw || 0;
}
body.pitch = 0;
input.yaw = body.yaw;
input.pitch = 0;
let prevX = body.x, prevY = body.y, prevZ = body.z;

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

if (params.nohud) hudEl.classList.add('hidden');
if (params.nohud || debugCam || params.autostart) setStartVisible(false);
startEl.addEventListener('click', () => km.requestLock());
startEl.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') km.requestLock();
});

const stats = params.stats ? createStatsOverlay(graphics) : null;

// --- Pętla ---
function controlActive() {
  return !debugCam && (km.locked || params.autostart);
}

function step(dt) {
  prevX = body.x; prevY = body.y; prevZ = body.z;
  if (!controlActive()) return;
  km.sample(null, null, input);
  stepMovement(body, input, dt, world);
}

let time = 0;
let rendered = 0;
const eyeHeight = CONFIG.player.eyeHeight;

function frame(alpha, frameDt) {
  if (stats) stats.begin();
  time += frameDt;
  if (!debugCam) {
    camera.position.set(
      prevX + (body.x - prevX) * alpha,
      prevY + (body.y - prevY) * alpha + eyeHeight,
      prevZ + (body.z - prevZ) * alpha,
    );
    // Kąty na żywo z myszy (mniejsze opóźnienie); bez sterowania — z ciała.
    if (controlActive()) camera.rotation.set(km.pitch, km.yaw, 0);
    else camera.rotation.set(body.pitch, body.yaw, 0);
  }
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
    if (i === null || i === undefined) { debugCam = false; return true; }
    const ok = applyDebugCam(camera, world, i);
    if (ok) debugCam = true;
    return ok;
  },
  setPreset: (n) => graphics.setPreset(n),
  cams: () => listDebugCams(world).map((c) => c.name),
  world: { id: world.id, solids: world.solids.length },
};

const loop = createLoop({ hz: CONFIG.sim.hz, maxSubSteps: CONFIG.sim.maxSubSteps, step, frame });
graphics.resize();
loop.start();
