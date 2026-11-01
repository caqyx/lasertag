// Broń FPP + ręce gracza — stylizowany fazer laser tag w prawym dolnym rogu (PLAN §7.7).
// createViewModel(camera, scene?) → { update(dt, weapon, firedThisFrame, color, speed?, stunned?, gait?), muzzleWorld(out), dispose(), group }
//   stunned: true/1 podczas „hit stun” (P.stunTimer > 0) — akcenty, pasek ciepła i wylot przygaszone.
//   gait: { phase, amp, sprint } (avatars.localGait) — kołysanie w rytmie kroku (faza z przebytego dystansu),
//         sprint (0..1) → broń opuszczona i przechylona. Bez gait: kołysanie z prędkości (speed) i czasu.
//
// Grupa jest dzieckiem kamery; aby dzieci kamery były renderowane, kamera musi być w scenie —
// gdy camera.parent jest pusty i podano `scene`, kamera jest do niej dodawana.
// Wylot lufy: CONFIG.weapon.muzzleOffset + CONFIG.viewModel.offset (układ kamery); muzzleWorld(out) zwraca go w świecie
// (np. jako start wiązki gracza, żeby wiązka wychodziła z widocznej lufy).
// 1 draw call: scalona geometria broni i rąk z atrybutem aPart (0 korpus, 1 listwy w kolorze gracza, 2 pasek ciepła,
// 3 pierścień wylotu, 4 rękawice/rękawy, 5 akcenty rękawic, 6 soczewka emitera, 7 ciemny metal). Ręce są w tej samej
// grupie co broń → ten sam odrzut i kołysanie. Warstwa LAYER_NO_REFLECT (nie trafia do odbicia podłogi).
// Bez drugiego passu: w vertex shaderze głębia jest ściskana do przedniego ułamka zakresu (CONFIG.viewModel.depthRange),
// więc broń i ręce nie wbijają się w ściany, a ich własne ściany nadal poprawnie się zasłaniają.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';
import { LAYER_NO_REFLECT } from './arenaBuilder.js';

const VM = CONFIG.viewModel;
const M0 = CONFIG.weapon.muzzleOffset;
const OFF = VM.offset;
const MUZZLE = [M0[0] + OFF[0], M0[1] + OFF[1], M0[2] + OFF[2]];
const TAU = Math.PI * 2;

const P_BODY = 0, P_TRIM = 1, P_HEAT = 2, P_RING = 3, P_GLOVE = 4, P_GACC = 5, P_LENS = 6, P_DARK = 7;
const HEAT_BACK = 0.29, HEAT_FRONT = 0.115; // zakres Z paska ciepła (aBar 0 z tyłu → 1 z przodu)

// ------------------------------------------------------------------ geometria (układ lokalny: wylot = 0,0,0; broń sięga w +Z, ku kamerze)

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();

function finish(geo, kind, m) {
  geo.deleteAttribute('uv');
  if (m) geo.applyMatrix4(m);
  const pos = geo.attributes.position;
  const n = pos.count;
  const aBar = new Float32Array(n);
  if (kind === P_HEAT) for (let i = 0; i < n; i++) aBar[i] = (pos.getZ(i) - HEAT_BACK) / (HEAT_FRONT - HEAT_BACK);
  geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(kind), 1));
  geo.setAttribute('aBar', new THREE.BufferAttribute(aBar, 1));
  return geo;
}

function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

const box = (w, h, d, kind, x, y, z, rx = 0, ry = 0, rz = 0) => finish(new THREE.BoxGeometry(w, h, d), kind, trs(x, y, z, rx, ry, rz));

// sfazowany prostopadłościan wzdłuż Z (graniastosłup ośmiokątny przeskalowany do w × h × d)
function chamfer(w, h, d, kind, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(1, 1, d, 8, 1);
  g.rotateY(Math.PI / 8);
  g.rotateX(Math.PI / 2);
  const k = 1 / Math.cos(Math.PI / 8);
  g.scale(w * 0.5 * k, h * 0.5 * k, 1);
  return finish(g, kind, trs(x, y, z, rx, ry, rz));
}

// walec wzdłuż Z
function tube(r0, r1, len, seg, kind, x, y, z, open = false) {
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open);
  g.rotateX(Math.PI / 2); // +Y → +Z: r0 z przodu (−Z), r1 z tyłu
  return finish(g, kind, trs(x, y, z));
}

const ring = (r, t, kind, x, y, z, rx = 0, ry = 0, rz = 0, arc = TAU, seg = 14) =>
  finish(new THREE.TorusGeometry(r, t, 4, seg, arc), kind, trs(x, y, z, rx, ry, rz));

// zwężana „kapsuła” (walec + kulki na końcach) między punktami a i b
function seg(ax, ay, az, bx, by, bz, ra, rb, kind, radial = 8, caps = true) {
  _v0.set(ax, ay, az); _v1.set(bx, by, bz);
  const d = _v1.clone().sub(_v0);
  const len = d.length();
  const g = new THREE.CylinderGeometry(rb, ra, len, radial, 1, true);
  const m = new THREE.Matrix4().compose(
    _v0.clone().add(_v1).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  const out = [finish(g, kind, m)];
  if (caps) {
    out.push(finish(new THREE.SphereGeometry(ra, radial, 4), kind, trs(ax, ay, az)));
    out.push(finish(new THREE.SphereGeometry(rb, radial, 4), kind, trs(bx, by, bz)));
  }
  return out;
}

function ellipsoid(rx, ry, rz, kind, x, y, z, ax = 0, ay = 0, az = 0, ws = 8, hs = 6) {
  return finish(new THREE.SphereGeometry(1, ws, hs), kind, trs(x, y, z, ax, ay, az, rx, ry, rz));
}

function phaserParts() {
  return [
    // emiter: soczewka, pierścień wylotu, osłona lufy z żebrami chłodzącymi
    tube(0.0165, 0.0165, 0.006, 14, P_LENS, 0, 0, 0.002),
    ring(0.0195, 0.0042, P_RING, 0, 0, 0.004),
    tube(0.023, 0.026, 0.07, 12, P_DARK, 0, 0, 0.04, true),
    ring(0.0265, 0.0035, P_BODY, 0, 0, 0.03),
    ring(0.0275, 0.0035, P_BODY, 0, 0, 0.048),
    ring(0.0285, 0.0035, P_TRIM, 0, 0, 0.066),
    // obudowa przednia (szersza) + korpus + tylna pokrywa
    chamfer(0.064, 0.078, 0.07, P_BODY, 0, -0.004, 0.105),
    chamfer(0.052, 0.066, 0.2, P_BODY, 0, -0.002, 0.235),
    chamfer(0.046, 0.058, 0.03, P_DARK, 0, 0.0, 0.345),
    // listwy: pierścień z przodu obudowy, boki (lewy widoczny z kamery), spód
    box(0.066, 0.004, 0.004, P_TRIM, 0, 0.033, 0.069),
    box(0.002, 0.005, 0.21, P_TRIM, -0.0272, -0.012, 0.22),
    box(0.002, 0.005, 0.21, P_TRIM, 0.0272, -0.012, 0.22),
    box(0.002, 0.004, 0.06, P_TRIM, -0.0332, -0.02, 0.105),
    // górny panel: radiator (ciemny) z paskiem ciepła, celownik na szynie
    box(0.032, 0.012, 0.2, P_DARK, 0, 0.037, 0.2),
    box(0.01, 0.003, HEAT_BACK - HEAT_FRONT, P_HEAT, 0, 0.0445, (HEAT_BACK + HEAT_FRONT) / 2),
    box(0.003, 0.004, 0.18, P_BODY, -0.012, 0.045, 0.2),
    box(0.003, 0.004, 0.18, P_BODY, 0.012, 0.045, 0.2),
    chamfer(0.018, 0.02, 0.035, P_DARK, 0, 0.054, 0.3),
    box(0.012, 0.003, 0.004, P_TRIM, 0, 0.0575, 0.2826),
    // ogniwo zasilające pod korpusem (świecąca rurka)
    tube(0.009, 0.009, 0.075, 8, P_TRIM, 0, -0.04, 0.17),
    // chwyt przedni (lewa dłoń)
    chamfer(0.026, 0.05, 0.03, P_DARK, 0, -0.058, 0.098, -0.12),
    // chwyt + osłona spustu + spust
    chamfer(0.034, 0.1, 0.045, P_DARK, 0, -0.078, 0.29, 0.28),
    box(0.036, 0.004, 0.03, P_TRIM, 0, -0.118, 0.302, 0.28),
    ring(0.022, 0.0035, P_BODY, 0, -0.038, 0.232, 0, Math.PI / 2, 0, Math.PI, 10),
    box(0.008, 0.024, 0.009, P_DARK, 0, -0.045, 0.228, 0.25),
  ];
}

// ręce: prawa na chwycie, lewa pod chwytem przednim; przedramiona schodzą poza kadr (w stronę kamery, w dół)
function handParts() {
  const out = [];
  // prawa dłoń: grzbiet (zewnętrzna strona chwytu), palce owinięte z przodu, kciuk po lewej, palec wskazujący na spuście
  out.push(ellipsoid(0.028, 0.04, 0.03, P_GLOVE, 0.012, -0.08, 0.305, 0.28, 0, 0));
  for (let i = 0; i < 3; i++) {
    const y = -0.072 - i * 0.017, z = 0.262 + i * 0.005;
    out.push(...seg(0.02, y, z + 0.012, -0.019, y + 0.003, z, 0.0085, 0.0078, P_GLOVE, 6, true));
  }
  out.push(...seg(0.017, -0.045, 0.255, 0.003, -0.044, 0.222, 0.0075, 0.007, P_GLOVE, 6, true)); // palec na spuście
  out.push(...seg(-0.02, -0.06, 0.3, -0.024, -0.025, 0.262, 0.009, 0.0078, P_GLOVE, 6, true));   // kciuk
  out.push(box(0.003, 0.014, 0.022, P_GACC, 0.04, -0.082, 0.31, 0.28));                         // akcent na grzbiecie
  // prawy nadgarstek (mankiet neonowy) + przedramię
  out.push(ring(0.028, 0.006, P_GACC, 0.016, -0.125, 0.338, 1.15, 0.25, 0, TAU, 12));
  out.push(...seg(0.016, -0.125, 0.338, 0.1, -0.29, 0.62, 0.027, 0.04, P_GLOVE, 9, false));
  out.push(box(0.004, 0.01, 0.16, P_GACC, -0.006, -0.19, 0.46, -1.05, 0.25, 0));
  // lewa dłoń: pod chwytem przednim, palce owinięte od prawej, kciuk po lewej górą
  out.push(ellipsoid(0.03, 0.022, 0.036, P_GLOVE, -0.01, -0.085, 0.105, 0.1, 0.35, 0.25));
  for (let i = 0; i < 3; i++) {
    const z = 0.088 + i * 0.016;
    out.push(...seg(-0.012, -0.088, z, 0.02, -0.055, z - 0.002, 0.0082, 0.0075, P_GLOVE, 6, true));
  }
  out.push(...seg(-0.03, -0.07, 0.115, -0.03, -0.03, 0.088, 0.0088, 0.0078, P_GLOVE, 6, true));
  out.push(ring(0.028, 0.006, P_GACC, -0.032, -0.108, 0.13, 1.0, -0.5, 0.3, TAU, 12));
  out.push(...seg(-0.032, -0.108, 0.13, -0.28, -0.25, 0.42, 0.027, 0.042, P_GLOVE, 9, false));
  out.push(box(0.004, 0.01, 0.17, P_GACC, -0.15, -0.165, 0.27, -0.42, -0.72, 0));
  return out;
}

function buildGeometry() {
  const parts = [...phaserParts(), ...handParts()];
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
        'uniform vec3 uDark; uniform vec3 uGlove; uniform float uGloveAcc; uniform float uLensI;',
        'varying float vPart; varying float vBar;',
      ].join('\n'))
      .replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'if (vPart > 3.5 && vPart < 5.5) diffuseColor.rgb = uGlove;',
        'else if (vPart > 6.5) diffuseColor.rgb = uDark;',
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
        '} else if (vPart > 2.5 && vPart < 3.5) totalEmissiveRadiance += (uColor + vec3(uFlashWhite * uFlash)) * uFlashI * (uFlashIdle + uFlash) * uDim;',
        'else if (vPart > 4.5 && vPart < 5.5) totalEmissiveRadiance += uColor * uGloveAcc * uDim;',
        'else if (vPart > 5.5 && vPart < 6.5) totalEmissiveRadiance += (uColor * uLensI + vec3(uFlashWhite * uFlash)) * (1.0 + uFlash) * uDim;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'lt-viewmodel-v2';
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
    uDark: { value: new THREE.Color(VM.darkColor) },
    uGlove: { value: new THREE.Color(VM.gloveColor) },
    uGloveAcc: { value: VM.gloveAccent },
    uLensI: { value: VM.lensIntensity },
  };
  const geo = buildGeometry();
  const mat = buildMaterial(uniforms);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'viewModel';
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.layers.set(LAYER_NO_REFLECT);

  const group = new THREE.Group();
  group.name = 'viewModelRoot';
  group.add(mesh);
  group.scale.setScalar(VM.scale);
  group.position.set(MUZZLE[0], MUZZLE[1], MUZZLE[2]);
  camera.add(group);

  let lastColor = null;
  // stan liczbowy w buforze (nie `let` z domknięcia — V8 alokuje HeapNumber przy każdym zapisie doubla)
  const S = new Float64Array(6); // 0 recoil, 1 flash, 2 bobPhase, 3 bobAmt, 4 sprint, 5 time

  function update(dt, weapon, fired, color, speed = 0, stunned = 0, gait = null) {
    S[5] += dt;
    if (color !== lastColor) {
      lastColor = color;
      uniforms.uColor.value.setHex(hexNumber(color));
    }
    if (fired) { S[0] = 1; S[1] = 1; }
    const recoil = S[0] * Math.exp(-VM.recoilReturn * dt);
    const flash = Math.max(0, S[1] - dt / VM.flashTime);
    S[0] = recoil; S[1] = flash;

    const heat = weapon ? weapon.heat : 0;
    const over = weapon ? weapon.overheated : false;
    uniforms.uHeat.value = heat;
    uniforms.uBlink.value = over ? (Math.sin(S[5] * TAU * VM.overheatBlinkHz) > 0 ? VM.overheatBlink[0] : VM.overheatBlink[1]) : 1;
    uniforms.uFlash.value = flash;
    // stun: szybkie przygaszenie, powrót płynny
    const dimT = stunned ? VM.stunDim : 1;
    uniforms.uDim.value += (dimT - uniforms.uDim.value) * Math.min(1, dt * VM.stunFade);

    // kołysanie: faza kroku z awatarów (dystans) albo — bez gait — z prędkości i czasu
    let ph, amt, sprint;
    if (gait !== null) {
      ph = gait.phase;
      amt = gait.amp;
      sprint = gait.sprint;
    } else {
      const k = Math.min(1, speed / CONFIG.player.walkSpeed);
      S[3] += (k - S[3]) * Math.min(1, dt * VM.bobSmooth);
      let bp = S[2] + dt * Math.PI * VM.bobFreq * Math.max(VM.bobMinRate, k);
      if (bp > TAU) bp -= TAU;
      S[2] = bp;
      ph = bp;
      amt = S[3];
      sprint = 0;
    }
    const amp = VM.bobAmp * amt * (1 + (VM.bobSprint - 1) * sprint);
    const sp = Math.sin(ph);
    const bx = sp * amp * VM.bobSide;           // na boki raz na cykl (2 kroki)
    const by = -sp * sp * amp;                   // w dół przy każdym kroku
    const D = VM.sprintDrop;
    const gp = group.position, gr = group.rotation;
    gp.x = MUZZLE[0] + bx + D[0] * sprint;
    gp.y = MUZZLE[1] + by + D[1] * sprint;
    gp.z = MUZZLE[2] + VM.recoilKick * recoil + D[2] * sprint;
    gr.set(VM.recoilPitch * recoil - VM.sprintPitch * sprint, VM.sprintYaw * sprint, VM.sprintRoll * sprint + bx * 2);
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
