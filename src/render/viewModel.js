// Broń FPP — stylizowany fazer w prawym dolnym rogu (PLAN §7.7).
// createViewModel(camera, scene?) → { update(dt, weapon, firedThisFrame, color, speed?, stunned?), muzzleWorld(out), dispose(), group }
//   stunned: true/1 podczas „hit stun” (P.stunTimer > 0) — akcenty, pasek ciepła i wylot przygaszone.
//
// Grupa jest dzieckiem kamery; aby dzieci kamery były renderowane, kamera musi być w scenie —
// gdy camera.parent jest pusty i podano `scene`, kamera jest do niej dodawana.
// Wylot lufy: CONFIG.weapon.muzzleOffset + CONFIG.viewModel.offset (układ kamery); muzzleWorld(out) zwraca go w świecie
// (np. jako start wiązki gracza, żeby wiązka wychodziła z widocznej lufy).
// 1 draw call: scalona geometria z atrybutem aPart (0 korpus, 1 listwy w kolorze gracza, 2 pasek ciepła, 3 wylot).
// Bez drugiego passu: w vertex shaderze głębia jest ściskana do przedniego ułamka zakresu (CONFIG.viewModel.depthRange),
// więc broń nie wbija się w ściany, a jej własne ściany nadal poprawnie się zasłaniają.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';

const VM = CONFIG.viewModel;
const M0 = CONFIG.weapon.muzzleOffset;
const OFF = VM.offset;
const MUZZLE = [M0[0] + OFF[0], M0[1] + OFF[1], M0[2] + OFF[2]];
const TAU = Math.PI * 2;

// część: box/cylinder w układzie lokalnym (wylot = 0,0,0; broń sięga w +Z, ku kamerze)
function part(geo, kind, x, y, z, rx = 0, barFrom = 0, barTo = 0) {
  geo.deleteAttribute('uv');
  if (rx) geo.rotateX(rx);
  geo.translate(x, y, z);
  const pos = geo.attributes.position;
  const n = pos.count;
  const aPart = new Float32Array(n).fill(kind);
  const aBar = new Float32Array(n);
  if (kind === 2) {
    // 0 przy tylnym końcu (barFrom) → 1 przy przednim (barTo)
    for (let i = 0; i < n; i++) aBar[i] = (pos.getZ(i) - barFrom) / (barTo - barFrom);
  }
  geo.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1));
  geo.setAttribute('aBar', new THREE.BufferAttribute(aBar, 1));
  return geo;
}

function buildGeometry() {
  const parts = [
    // korpus i osłona przednia
    part(new THREE.BoxGeometry(0.05, 0.062, 0.24), 0, 0, -0.004, 0.18),
    part(new THREE.BoxGeometry(0.06, 0.074, 0.055), 0, 0, -0.004, 0.075),
    // lufa + pierścień wylotu
    part(new THREE.CylinderGeometry(0.014, 0.016, 0.05, 12), 0, 0, 0, 0.025, Math.PI / 2),
    part(new THREE.CylinderGeometry(0.019, 0.019, 0.012, 12), 3, 0, 0, 0.004, Math.PI / 2),
    // emiter na górze (obudowa) + pasek ciepła na górnej ścianie
    part(new THREE.BoxGeometry(0.03, 0.012, 0.17), 0, 0, 0.032, 0.18),
    part(new THREE.BoxGeometry(0.008, 0.003, 0.15), 2, 0, 0.0395, 0.18, 0, 0.255, 0.105),
    // listwy w kolorze gracza: lewy bok (widoczny z kamery) i przód osłony
    part(new THREE.BoxGeometry(0.002, 0.004, 0.2), 1, -0.0258, -0.018, 0.18),
    part(new THREE.BoxGeometry(0.062, 0.005, 0.004), 1, 0, 0.026, 0.047),
    // rękojeść + spust
    part(new THREE.BoxGeometry(0.034, 0.095, 0.042), 0, 0, -0.072, 0.255, 0.28),
    part(new THREE.BoxGeometry(0.01, 0.025, 0.01), 0, 0, -0.045, 0.215),
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function buildMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({
    color: VM.bodyColor, roughness: VM.roughness, metalness: VM.metalness, fog: false,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uDepthK;\nattribute float aPart;\nattribute float aBar;\nvarying float vPart;\nvarying float vBar;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;\nvBar = aBar;')
      .replace('#include <project_vertex>', '#include <project_vertex>\ngl_Position.z = gl_Position.z * uDepthK - (1.0 - uDepthK) * gl_Position.w;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', [
        '#include <common>',
        'uniform vec3 uColor; uniform vec3 uHot; uniform float uHeat; uniform float uBlink; uniform float uFlash;',
        'uniform float uTrimI; uniform float uHeatI; uniform float uFlashI; uniform float uRimI; uniform vec3 uFill;',
        'uniform float uRimPow; uniform float uFillBase; uniform float uTrimFlash; uniform vec2 uHeatRamp;',
        'uniform float uBarOff; uniform float uFlashWhite; uniform float uFlashIdle; uniform float uDim;',
        'varying float vPart; varying float vBar;',
      ].join('\n'))
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        // sztuczne światło od góry (układ widoku = układ kamery) + fresnel w kolorze gracza: bryła czytelna w ciemności
        'float vmRim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), uRimPow);',
        'totalEmissiveRadiance += uFill * (uFillBase + (1.0 - uFillBase) * clamp(normal.y, 0.0, 1.0)) + uColor * vmRim * uRimI;',
        'if (vPart > 0.5 && vPart < 1.5) totalEmissiveRadiance += uColor * uTrimI * (1.0 + uTrimFlash * uFlash) * uDim;',
        'else if (vPart > 1.5 && vPart < 2.5) {',
        '  float on = step(vBar, uHeat);',
        '  vec3 hc = mix(uColor, uHot, smoothstep(uHeatRamp.x, uHeatRamp.y, uHeat));',
        '  totalEmissiveRadiance += mix(uColor * uBarOff, hc * uHeatI * uBlink, on) * uDim;',
        '} else if (vPart > 2.5) totalEmissiveRadiance += (uColor + vec3(uFlashWhite * uFlash)) * uFlashI * (uFlashIdle + uFlash) * uDim;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'lt-viewmodel';
  return mat;
}

export function createViewModel(camera, scene) {
  // kamera musi być w scenie, żeby jej dzieci się renderowały; zapamiętujemy, czy to my ją dodaliśmy
  const addedCamera = !camera.parent && !!scene;
  if (addedCamera) scene.add(camera);

  const uniforms = {
    uColor: { value: new THREE.Color(1, 1, 1) },
    uHot: { value: new THREE.Color(VM.hotColor) },
    uHeat: { value: 0 },
    uBlink: { value: 1 },
    uFlash: { value: 0 },
    uTrimI: { value: VM.trimIntensity },
    uHeatI: { value: VM.heatIntensity },
    uFlashI: { value: VM.flashIntensity },
    uRimI: { value: VM.rimIntensity },
    uFill: { value: new THREE.Color(VM.fillColor) },
    uRimPow: { value: VM.rimPower },
    uFillBase: { value: VM.fillBase },
    uTrimFlash: { value: VM.trimFlashBoost },
    uHeatRamp: { value: new THREE.Vector2(VM.heatRamp[0], VM.heatRamp[1]) },
    uBarOff: { value: VM.barOff },
    uFlashWhite: { value: VM.flashWhite },
    uFlashIdle: { value: VM.flashIdle },
    uDepthK: { value: VM.depthRange },
    uDim: { value: 1 },
  };
  const geo = buildGeometry();
  const mat = buildMaterial(uniforms);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'viewModel';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;

  const group = new THREE.Group();
  group.name = 'viewModelRoot';
  group.add(mesh);
  group.scale.setScalar(VM.scale);
  group.position.set(MUZZLE[0], MUZZLE[1], MUZZLE[2]);
  camera.add(group);

  let lastColor = null;
  let recoil = 0;
  let flash = 0;
  let bobPhase = 0;
  let bobAmt = 0;
  let time = 0;

  function update(dt, weapon, fired, color, speed = 0, stunned = 0) {
    time += dt;
    if (color !== lastColor) {
      lastColor = color;
      uniforms.uColor.value.setHex(hexNumber(color));
    }
    if (fired) { recoil = 1; flash = 1; }
    recoil *= Math.exp(-VM.recoilReturn * dt);
    flash = Math.max(0, flash - dt / VM.flashTime);

    const heat = weapon ? weapon.heat : 0;
    const over = weapon ? weapon.overheated : false;
    uniforms.uHeat.value = heat;
    uniforms.uBlink.value = over ? (Math.sin(time * TAU * VM.overheatBlinkHz) > 0 ? VM.overheatBlink[0] : VM.overheatBlink[1]) : 1;
    uniforms.uFlash.value = flash;
    // stun: szybkie przygaszenie, powrót płynny
    const dimT = stunned ? VM.stunDim : 1;
    uniforms.uDim.value += (dimT - uniforms.uDim.value) * Math.min(1, dt * VM.stunFade);

    // bob proporcjonalny do prędkości (opcjonalny argument)
    const k = Math.min(1, speed / CONFIG.player.walkSpeed);
    bobAmt += (k - bobAmt) * Math.min(1, dt * VM.bobSmooth);
    bobPhase += dt * TAU * VM.bobFreq * Math.max(VM.bobMinRate, k);
    const bx = Math.sin(bobPhase) * VM.bobAmp * VM.bobSide * bobAmt;
    const by = -Math.abs(Math.cos(bobPhase)) * VM.bobAmp * bobAmt;

    group.position.set(MUZZLE[0] + bx, MUZZLE[1] + by, MUZZLE[2] + VM.recoilKick * recoil);
    group.rotation.set(VM.recoilPitch * recoil, 0, 0);
  }

  // faktyczny wylot lufy (z odrzutem i kołysaniem) w układzie świata; bez alokacji
  function muzzleWorld(out) {
    group.updateWorldMatrix(true, false);
    return out.set(0, 0, 0).applyMatrix4(group.matrixWorld);
  }

  function dispose() {
    camera.remove(group);
    if (addedCamera && camera.parent) camera.parent.remove(camera);
    geo.dispose();
    mat.dispose();
  }

  return { update, muzzleWorld, dispose, group };
}
