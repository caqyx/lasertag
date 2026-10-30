// Renderer + postprocessing + presety (SPEC §4/§5/§7, PLAN §5).
// createGraphics({ canvas, presetName }) → Graphics
// Łańcuch: RenderPass → [UnrealBloomPass (preset.bloom, rozdz. × bloom.scale)] → OutputPass (ACES + sRGB) → [FXAA]
// MSAA: render target composera z samples=4 (HalfFloat dla HDR) gdy preset.aa === 'msaa'.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { CONFIG } from '../config.js';
import { createTextures, makeRng } from './textures.js';
import { buildArena } from './arenaBuilder.js';
import { createSmoke } from './smoke.js';

const R = CONFIG.render;

export function createGraphics({ canvas, presetName = CONFIG.defaults.preset }) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance', stencil: false, alpha: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; // stosowane w OutputPass
  renderer.toneMappingExposure = R.toneMappingExposure;
  renderer.setClearColor(new THREE.Color(R.clearColor), 1);
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CONFIG.player.fov, 1, R.near, R.far);
  camera.position.set(0, CONFIG.player.eyeHeight, 0);

  const hemi = new THREE.HemisphereLight(0x000000, 0x000000, R.lights.hemiIntensity);
  scene.add(hemi);
  const pointLights = [];

  let preset = null;
  let world = null;
  let textures = null;
  let arena = null;
  let smoke = null;
  let composer = null, bloomPass = null, fxaaPass = null, outputPass = null, renderPass = null;
  const size = new THREE.Vector2();

  const infoOut = { calls: 0, triangles: 0, points: 0, lines: 0, textures: 0, geometries: 0, programs: 0 };

  // ------------------------------------------------------------ composer

  function disposeComposer() {
    if (!composer) return;
    for (const p of composer.passes) if (p.dispose) p.dispose();
    composer.dispose(); // renderTarget1/2 + copyPass
    composer = bloomPass = fxaaPass = outputPass = renderPass = null;
  }

  function buildComposer() {
    disposeComposer();
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: preset.aa === 'msaa' ? R.msaaSamples : 0,
    });
    composer = new EffectComposer(renderer, rt);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    if (preset.bloom) {
      const bl = preset.bloom;
      bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), bl.strength, bl.radius, bl.threshold);
      const scale = bl.scale;
      if (scale !== 1) {
        const base = UnrealBloomPass.prototype.setSize;
        bloomPass.setSize = function setSizeScaled(w, h) { base.call(this, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))); };
      }
      // wagi mipów: mocniej mała poświata przy listwach, słabiej szerokie „mydło" (bliskie listwy nie zalewają kadru)
      const f = bloomPass.compositeMaterial.uniforms.bloomFactors.value;
      for (let i = 0; i < f.length && i < R.bloomFactors.length; i++) f[i] = R.bloomFactors[i];
      composer.addPass(bloomPass);
    }
    outputPass = new OutputPass();
    composer.addPass(outputPass);
    if (preset.aa === 'fxaa') {
      fxaaPass = new ShaderPass(FXAAShader);
      composer.addPass(fxaaPass);
    }
    resize();
  }

  // ------------------------------------------------------------ światła

  function disposeLights() {
    for (const l of pointLights) { scene.remove(l); l.dispose(); }
    pointLights.length = 0;
  }

  function buildLights() {
    disposeLights();
    if (!world) return;
    const pal = world.palette;
    hemi.color.set(pal.ambient);
    hemi.groundColor.set(pal.ambient).multiplyScalar(R.lights.hemiGround);
    const n = Math.min(preset.pointLights, (world.lights || []).length);
    for (let i = 0; i < n; i++) {
      const L = world.lights[i];
      const pl = new THREE.PointLight(L.color, L.intensity * R.lights.pointScale, (L.range || 12) * R.lights.rangeScale, 2);
      pl.position.set(L.x, L.y - R.lights.drop, L.z);
      pl.castShadow = false;
      scene.add(pl);
      pointLights.push(pl);
    }
  }

  // ------------------------------------------------------------ świat

  function disposeWorldContent() {
    if (smoke) { smoke.dispose(); smoke = null; }
    if (arena) { arena.dispose(); arena = null; }
    if (textures) { textures.disposeAll(); textures = null; }
  }

  function buildWorldContent() {
    disposeWorldContent();
    if (!world) return;
    textures = createTextures({
      size: preset.texSize, anisotropy: Math.min(preset.anisotropy, renderer.capabilities.getMaxAnisotropy()),
      palette: world.palette, seed: world.seed >>> 0,
    });
    arena = buildArena(world, preset, textures, { renderer });
    scene.add(arena.group);
    smoke = createSmoke(world, preset.smoke, makeRng((world.seed ^ 0x5307e) >>> 0),
      { texture: preset.smoke > 0 ? textures.get('smoke') : null });
    if (smoke.mesh) scene.add(smoke.mesh);
  }

  function applyFog() {
    if (!world) { scene.fog = null; return; }
    if (!scene.fog) scene.fog = new THREE.FogExp2(world.palette.fog, R.fogDensity);
    scene.fog.color.set(world.palette.fog);
    scene.fog.density = R.fogDensity;
  }

  // ------------------------------------------------------------ API

  function setPreset(name) {
    const p = CONFIG.presets[name];
    if (!p) throw new Error(`graphics: nieznany preset '${name}'`);
    preset = p;
    api.presetName = name;
    buildComposer();
    buildLights();
    buildWorldContent();
  }

  function setWorld(w) {
    world = w;
    applyFog();
    buildLights();
    buildWorldContent();
  }

  function pixelRatioFor(p) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return p.pixelRatio > 1 ? Math.min(dpr, p.pixelRatio) : p.pixelRatio;
  }

  function resize() {
    const w = canvas.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1280);
    const h = canvas.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 720);
    const pr = pixelRatioFor(preset);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      if (fxaaPass) {
        renderer.getDrawingBufferSize(size);
        fxaaPass.material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
      }
    }
  }

  function update(dt, time) {
    if (smoke) smoke.update(dt, camera);
    if (arena) arena.update(time);
  }

  function render() {
    renderer.info.reset();
    composer.render();
  }

  function info() {
    const i = renderer.info;
    infoOut.calls = i.render.calls;
    infoOut.triangles = i.render.triangles;
    infoOut.points = i.render.points;
    infoOut.lines = i.render.lines;
    infoOut.textures = i.memory.textures;
    infoOut.geometries = i.memory.geometries;
    infoOut.programs = i.programs ? i.programs.length : 0;
    return infoOut;
  }

  function dispose() {
    disposeWorldContent();
    disposeLights();
    disposeComposer();
    scene.remove(hemi);
    hemi.dispose();
    renderer.dispose();
  }

  const api = {
    renderer, scene, camera,
    presetName: presetName,
    setPreset, setWorld, update, render, resize, info, dispose,
  };
  setPreset(presetName);
  return api;
}
