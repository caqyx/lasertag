// Awatary uczestników + ciało gracza w FPP (SPEC §2.1/§2.2/§4; PLAN §7.7).
// createAvatars(scene, maxCount) → { sync(participants, alpha, time, localId, camera?, fpLocal?), localGait, dispose(), meshes }
//   camera: awatar, w którego kapsule (XZ < avatar.hideDist, w zakresie wysokości) jest kamera, jest pomijany.
//   fpLocal: true → lokalny gracz (localId) rysowany jako „ciało FPP” (tors + nogi, bez hełmu/ramion/broni — te są
//            w viewModel), przesunięte do tyłu o CONFIG.fpBody.back wg yaw kamery; tylko żywy. Osobny InstancedMesh na
//            warstwie LAYER_NO_REFLECT (bez bezgłowego ciała w odbiciu podłogi).
//   localGait: { phase, amp, sprint } lokalnego gracza po sync (faza kroku dla kołysania broni FPP).
//   Kucanie: body.height (wys. kapsuły) i body.crouch (0..1); sprint: body.sprinting (undefined = false).
//
// Draw calle: 2 (awatary: korpus + sensory) + 2 (ciało FPP: korpus + sensor przedni; tylko w FPP) — ≤ 8.
// Animacja: skinning w vertex shaderze (bez szkieletu three). Każdy wierzchołek ma aBone (część ciała: tors, uda,
// łydki, ramiona+broń, hełm, elementy ukrywane w FPP); na instancję aAnim = (faza kroku, wymach uda [rad],
// opuszczenie broni [rad], maska FPP) i aShape = (height/standHeight, crouch). Uda/łydki obracane wokół piwotów
// biodra/kolana (CONFIG.avatar), kucanie = zgięcie nóg (stopy na podłodze, biodra opadają) + ściśnięcie torsu tak,
// by wysokości sensorów ≈ y × height/standHeight (jak w combat). Wybrane zamiast osobnych InstancedMesh na kończyny:
// zero dodatkowych draw calli (×2 z odbiciem na High/Ultra), brak macierzy kończyn na CPU, jeden materiał.
// Faza kroku = przebyty dystans (interpolowana pozycja) / długość kroku × π, per uczestnik (tablice prealokowane).
// Model zwrócony w −Z (yaw = 0 patrzy w −Z, PLAN §0). sync bez alokacji (scratch na poziomie modułu).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';
import { LAYER_NO_REFLECT } from './arenaBuilder.js';
import { SENSOR, SENSOR_OFFSETS, isSensorLit } from '../game/participant.js';

const AV = CONFIG.avatar;
const FP = CONFIG.fpBody;
const TAU = Math.PI * 2;

// części ciała (atrybut aBone)
const B_TORSO = 0, B_LTHIGH = 1, B_LSHIN = 2, B_RTHIGH = 3, B_RSHIN = 4, B_ARMS = 5, B_HEAD = 6, B_UPPER = 7;

// scratch
const _m = new THREE.Matrix4();
const _ms = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const STAND = CONFIG.player.height;
const HIDE2 = CONFIG.avatar.hideDist * CONFIG.avatar.hideDist;
const LEG = AV.hipHeight - AV.ankleHeight;
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

// ------------------------------------------------------------------ geometria korpusu

function part(geo, emit, bone, matrix) {
  geo.deleteAttribute('uv');
  if (matrix) geo.applyMatrix4(matrix);
  const n = geo.attributes.position.count;
  geo.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(n).fill(emit), 1));
  geo.setAttribute('aBone', new THREE.BufferAttribute(new Float32Array(n).fill(bone), 1));
  return geo;
}

function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
}

// kapsuła między punktami a i b
function limb(ax, ay, az, bx, by, bz, r, bone, emit = 0, radial = 6) {
  const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
  const d = b.clone().sub(a);
  const len = d.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 2, radial);
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  return part(g, emit, bone, m);
}

// „sfazowany prostopadłościan”: graniastosłup ośmiokątny wzdłuż Z przeskalowany do w × h × d
function chamfer(w, h, d, emit, bone, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(1, 1, d, 8, 1);
  g.rotateY(Math.PI / 8);
  g.rotateX(Math.PI / 2);
  const k = 1 / Math.cos(Math.PI / 8);
  g.scale(w * 0.5 * k, h * 0.5 * k, 1);
  return part(g, emit, bone, trs(x, y, z, rx, ry, rz));
}

function box(w, h, d, emit, bone, x, y, z, rx = 0, ry = 0, rz = 0) {
  return part(new THREE.BoxGeometry(w, h, d), emit, bone, trs(x, y, z, rx, ry, rz));
}

function legParts(sx) {
  const x = sx * 0.105;
  const T = sx < 0 ? B_LTHIGH : B_RTHIGH;
  const S = sx < 0 ? B_LSHIN : B_RSHIN;
  const trim = AV.trimIntensity;
  return [
    limb(sx * 0.11, AV.hipHeight, 0, x, AV.kneeHeight + 0.02, 0, 0.082, T),
    box(0.012, 0.2, 0.03, trim * 0.45, T, sx * 0.19, 0.68, 0, 0, 0, sx * 0.03),       // pasek boczny uda
    limb(x, AV.kneeHeight, 0, x, 0.15, 0.005, 0.066, S),
    part(new THREE.SphereGeometry(1, 7, 4, 0, TAU, 0, Math.PI / 2), 0, S, trs(x, AV.kneeHeight, -0.055, -Math.PI / 2, 0, 0, 0.06, 0.04, 0.065)), // nakolannik (kopuła)
    part(new THREE.CylinderGeometry(0.078, 0.074, 0.08, 6, 1), 0, S, trs(x, 0.15, 0.0)), // cholewka
    chamfer(0.125, 0.1, 0.27, 0, S, x, 0.055, -0.045),                                // but
    box(0.13, 0.014, 0.275, trim * 0.5, S, x, 0.011, -0.045),                        // podeszwa (neon)
    box(0.02, 0.008, 0.11, trim * 0.6, S, x, 0.108, -0.1, -0.25),                       // pasek na cholewce (neon, widoczny z góry)
  ];
}

function armParts() {
  const trim = AV.trimIntensity;
  return [
    // prawe: ramię + przedramię + dłoń na chwycie
    limb(0.25, 1.45, 0.0, 0.28, 1.22, -0.07, 0.058, B_ARMS),
    limb(0.28, 1.22, -0.07, 0.205, 1.35, -0.14, 0.052, B_ARMS),
    part(new THREE.SphereGeometry(0.047, 6, 4), 0, B_ARMS, trs(0.205, 1.36, -0.15, 0, 0, 0, 0.9, 1.1, 1)),
    part(new THREE.CylinderGeometry(0.056, 0.056, 0.026, 6, 1, true), trim * 0.5, B_ARMS, trs(0.245, 1.285, -0.105, 0.6, 0, 0.5)),
    // lewe: przedramię nisko pod sensorem przednim (sensor widoczny z przodu), dłoń pod przodem broni
    limb(-0.25, 1.45, 0.0, -0.17, 1.08, -0.2, 0.058, B_ARMS),
    limb(-0.17, 1.08, -0.2, 0.17, 1.37, -0.37, 0.052, B_ARMS),
    part(new THREE.SphereGeometry(0.047, 6, 4), 0, B_ARMS, trs(0.19, 1.385, -0.375, 0, 0, 0, 1.1, 0.9, 1)),
    part(new THREE.CylinderGeometry(0.056, 0.056, 0.026, 6, 1, true), trim * 0.5, B_ARMS, trs(0.08, 1.29, -0.325, 0, 0, -0.9)),
  ];
}

// fazer w dłoniach — uproszczona wersja broni FPP (wylot ≈ (0.21, 1.47, −0.45) = oko + CONFIG.weapon.muzzleOffset)
function weaponParts() {
  const X = 0.21, trim = AV.trimIntensity, vis = AV.visorIntensity;
  return [
    chamfer(0.062, 0.078, 0.29, 0, B_ARMS, X, 1.44, -0.22),                 // korpus
    chamfer(0.074, 0.09, 0.1, 0, B_ARMS, X, 1.445, -0.36),                  // osłona przednia
    part(new THREE.CylinderGeometry(0.02, 0.024, 0.05, 8, 1), 0, B_ARMS, trs(X, 1.455, -0.43, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.019, 0.019, 0.01, 8, 1), vis, B_ARMS, trs(X, 1.455, -0.457, Math.PI / 2)), // soczewka
    box(0.03, 0.016, 0.2, 0, B_ARMS, X, 1.487, -0.22),                      // szyna
    box(0.012, 0.005, 0.17, trim, B_ARMS, X, 1.497, -0.22),                 // pasek ciepła (neon)
    box(0.004, 0.01, 0.26, trim * 0.8, B_ARMS, X - 0.032, 1.43, -0.24),     // listwy boczne
    box(0.004, 0.01, 0.26, trim * 0.8, B_ARMS, X + 0.032, 1.43, -0.24),
    box(0.04, 0.1, 0.05, 0, B_ARMS, X, 1.37, -0.13, 0.3),                   // chwyt
    box(0.032, 0.06, 0.04, 0, B_ARMS, X, 1.385, -0.37),                     // chwyt przedni
  ];
}

function buildBodyGeometry() {
  const trim = AV.trimIntensity;
  const parts = [
    ...legParts(-1), ...legParts(1),
    // biodra + pas (neon) ze sprzączką
    part(new THREE.SphereGeometry(0.16, 8, 5), 0, B_TORSO, trs(0, 0.88, 0, 0, 0, 0, 1.25, 0.7, 0.95)),
    part(new THREE.TorusGeometry(0.205, 0.017, 3, 12), trim * 0.6, B_TORSO, trs(0, 0.95, 0, Math.PI / 2, 0, 0, 1.12, 0.92, 1)),
    box(0.075, 0.05, 0.025, 0, B_TORSO, 0, 0.95, -0.215),
    // tors: brzuch + klatka (kombinezon), kamizelka: płyty przód/tył z dolną listwą neonową, boczne pasy,
    // gniazda sensorów (pozycje z CONFIG.combat.sensors — pad sensora to osobna instancja)
    part(new THREE.CapsuleGeometry(0.15, 0.16, 2, 8), 0, B_TORSO, trs(0, 1.09, 0, 0, 0, 0, 1.18, 1, 0.92)),
    part(new THREE.CapsuleGeometry(0.17, 0.2, 2, 8), 0, B_TORSO, trs(0, 1.36, 0, 0, 0, 0, 1.22, 1, 0.9)),
    chamfer(0.38, 0.42, 0.09, 0, B_TORSO, 0, 1.33, -0.15),
    chamfer(0.38, 0.44, 0.09, 0, B_TORSO, 0, 1.33, 0.15),
    box(0.06, 0.34, 0.24, 0, B_TORSO, -0.19, 1.31, 0),
    box(0.06, 0.34, 0.24, 0, B_TORSO, 0.19, 1.31, 0),
    box(0.34, 0.012, 0.012, trim * 0.55, B_TORSO, 0, 1.115, -0.197),
    box(0.34, 0.012, 0.012, trim * 0.55, B_TORSO, 0, 1.105, 0.197),
    part(new THREE.CylinderGeometry(0.088, 0.095, 0.03, 8, 1), 0, B_TORSO, trs(0, SENSOR_OFFSETS[1], -SENSOR_OFFSETS[2] + 0.015, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.088, 0.095, 0.03, 8, 1), 0, B_TORSO, trs(0, SENSOR_OFFSETS[4], -SENSOR_OFFSETS[5] - 0.015, -Math.PI / 2)),
    // kołnierz, szyja, naramienniki (ukrywane w FPP)
    part(new THREE.TorusGeometry(0.1, 0.03, 4, 12), 0, B_UPPER, trs(0, 1.57, 0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.06, 0.07, 0.12, 7, 1, true), 0, B_UPPER, trs(0, 1.63, 0)),
    part(new THREE.SphereGeometry(0.11, 8, 4, 0, TAU, 0, Math.PI / 2), 0, B_UPPER, trs(-0.245, 1.465, 0, 0, 0, 0.4, 1.0, 0.95, 1.2)),
    part(new THREE.SphereGeometry(0.11, 8, 4, 0, TAU, 0, Math.PI / 2), 0, B_UPPER, trs(0.245, 1.465, 0, 0, 0, -0.4, 1.0, 0.95, 1.2)),
    // hełm: skorupa, wizjer (neon, łuk z przodu), grzebień z paskiem, nauszniki
    part(new THREE.SphereGeometry(0.145, 10, 7), 0, B_HEAD, trs(0, 1.75, 0.01, 0, 0, 0, 1, 1.02, 1.08)),
    part(new THREE.CylinderGeometry(0.153, 0.149, 0.058, 12, 1, true, Math.PI - 1.0, 2.0), AV.visorIntensity, B_HEAD, trs(0, 1.75, 0.005)),
    box(0.045, 0.03, 0.26, 0, B_HEAD, 0, 1.892, 0.02),
    box(0.012, 0.006, 0.22, trim, B_HEAD, 0, 1.909, 0.02),
    part(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 6, 1), 0, B_HEAD, trs(-0.145, 1.735, 0.025, 0, 0, Math.PI / 2)),
    part(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 6, 1), 0, B_HEAD, trs(0.145, 1.735, 0.025, 0, 0, Math.PI / 2)),
    ...armParts(),
    ...weaponParts(),
  ];
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

// pad sensora: spłaszczona półkula, normalna wzdłuż +Z
function buildSensorGeometry() {
  const g = new THREE.SphereGeometry(1, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  g.rotateX(Math.PI / 2); // biegun (+Y) → +Z
  g.scale(0.075, 0.06, 0.035);
  g.deleteAttribute('uv');
  return g;
}

// lokalne macierze sensorów (model w −Z: przód = −Z, prawo = +X)
function buildSensorLocals() {
  const out = [];
  for (let i = 0; i < 4; i++) {
    // SENSOR_OFFSETS: x prawo, y od stóp, z przód → model: z = −przód
    const x = SENSOR_OFFSETS[i * 3], y = SENSOR_OFFSETS[i * 3 + 1], z = -SENSOR_OFFSETS[i * 3 + 2];
    let rx = 0, ry = 0;
    if (i === SENSOR.FRONT) ry = Math.PI;      // przód: pad patrzy w −Z
    else if (i === SENSOR.BACK) ry = 0;        // tył: +Z
    else if (i === SENSOR.LEFT) { ry = -Math.PI / 2; rx = -AV.shoulderTilt; } // lewe ramię: −X, uniesione ku górze
    else { ry = Math.PI / 2; rx = -AV.shoulderTilt; }                        // prawe ramię: +X
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0, 'YXZ'));
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
    out.push(m);
  }
  return out;
}

// ------------------------------------------------------------------ materiał korpusu (skinning w shaderze)

const SKIN_GLSL = /* glsl */`
attribute float aEmit;
attribute float aBone;
attribute float aFx;
attribute vec2 aShape;
attribute vec4 aAnim;
uniform float uHeadBase, uHip, uKneeY, uAnkle, uCrouchA, uKneeWalk, uKneeBase, uFpLean, uFpLeanBase, uFpLegFwd, uFpEmit, uFpRim;
uniform vec2 uShoulder;
varying float vEmit;
varying float vFx;
varying float vRimK;
vec3 ltP;
vec3 ltN;
// obrót wokół osi X (dodatni kąt: wektor „w dół” → „do przodu” (−Z))
vec2 ltRot(vec2 yz, float a) { float c = cos(a), s = sin(a); return vec2(yz.x * c - yz.y * s, yz.x * s + yz.y * c); }
void ltSkin(vec3 p, vec3 n) {
  float b = aBone;
  float sY = aShape.x;
  float cA = aShape.y * uCrouchA;
  float hip = uHip - (uHip - uAnkle) * (1.0 - cos(cA));      // biodra opadają, stopy zostają na podłodze
  float su = (uHeadBase * sY - hip) / (uHeadBase - uHip);     // tors: biodra → podstawa hełmu (≈ y × sY dla sensorów)
  ltP = p; ltN = n;
  if (aAnim.w > 0.5 && b > 4.5) { ltP = vec3(0.0, -50.0, 0.0); return; } // ciało FPP: bez ramion/broni, hełmu, naramienników
  if (b > 0.5 && b < 4.5) {
    // noga: lewa faza φ, prawa φ + π; udo wymach + kuc, kolano zgięte w fazie wykroku
    bool right = b > 2.5;
    float ph = aAnim.x + (right ? 3.14159265 : 0.0);
    float amp = aAnim.y;
    float thigh = amp * sin(ph) + cA;
    float knee = 2.0 * cA + amp * (uKneeWalk * max(0.0, cos(ph)) + uKneeBase);
    bool shin = b > 1.5 && b < 2.5 || b > 3.5;
    vec2 rel = vec2(p.y - uHip, p.z);
    vec2 base = vec2(hip, 0.0);
    float a = thigh;
    if (shin) {
      base += ltRot(vec2(uKneeY - uHip, 0.0), thigh);
      rel = vec2(p.y - uKneeY, p.z);
      a = thigh - knee;
    }
    vec2 r = ltRot(rel, a) + base;
    ltP = vec3(p.x, r.x, r.y);
    if (aAnim.w > 0.5) ltP.z -= uFpLegFwd * clamp(1.0 - r.x / hip, 0.0, 1.0); // FPP: nogi skośnie do przodu (stopy przed pasem)
    ltN = vec3(n.x, ltRot(n.yz, a));
  } else if (b > 5.5 && b < 6.5) {
    ltP.y = p.y - uHeadBase * (1.0 - sY);                      // hełm: sztywno w dół
  } else if (b > 4.5 && b < 5.5) {
    // ramiona + broń: sztywno za barkiem, obrót wokół piwotu barku (opuszczenie przy sprincie, kołysanie)
    float sh = hip + (uShoulder.x - uHip) * su;
    vec2 r = ltRot(vec2(p.y - uShoulder.x, p.z - uShoulder.y), -aAnim.z);
    ltP = vec3(p.x, r.x + sh, r.y + uShoulder.y);
    ltN = vec3(n.x, ltRot(n.yz, -aAnim.z));
  } else {
    ltP.y = hip + (p.y - uHip) * su;                           // tors/biodra: ściśnięcie przy kucaniu
    if (aAnim.w > 0.5) ltP.z += max(ltP.y - hip + uFpLeanBase, 0.0) * uFpLean; // ciało FPP: tors (z biodrami) odchylony do tyłu
    ltN = normalize(vec3(n.x, n.y / max(su, 0.2), n.z));
  }
}
`;

function buildBodyMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: AV.bodyColor, roughness: AV.roughness, metalness: 0.0,
  });
  const uniforms = {
    uTint: { value: AV.bodyTint },
    uRimI: { value: AV.rimIntensity },
    uRimPow: { value: AV.rimPower },
    uHeadBase: { value: AV.headBase },
    uHip: { value: AV.hipHeight },
    uKneeY: { value: AV.kneeHeight },
    uAnkle: { value: AV.ankleHeight },
    uCrouchA: { value: AV.crouchThigh },
    uKneeWalk: { value: AV.kneeWalk },
    uKneeBase: { value: AV.kneeBase },
    uFpLean: { value: FP.lean },
    uFpLeanBase: { value: FP.leanBase },
    uFpLegFwd: { value: FP.legForward },
    uFpEmit: { value: FP.emit },
    uFpRim: { value: FP.rim },
    uShoulder: { value: new THREE.Vector2(AV.shoulderPivot[0], AV.shoulderPivot[1]) },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + SKIN_GLSL)
      .replace('#include <beginnormal_vertex>', 'ltSkin(position, normal);\nvec3 objectNormal = ltN;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif')
      .replace('#include <begin_vertex>', 'vec3 transformed = ltP;\nbool ltFp = aAnim.w > 0.5;\nvEmit = aEmit * (ltFp ? uFpEmit : 1.0);\nvRimK = ltFp ? uFpRim : 1.0;\nvFx = aFx;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTint;\nuniform float uRimI;\nuniform float uRimPow;\nvarying float vEmit;\nvarying float vFx;\nvarying float vRimK;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), vColor, uTint);')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        'float rimD = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);',
        'float rim = pow(rimD, uRimPow);',
        'totalEmissiveRadiance += vColor * (vEmit + rim * uRimI * vRimK) * vFx;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'lt-avatar-body-v2';
  return mat;
}

// ------------------------------------------------------------------ API

function instAttr(geo, name, n, size, fill) {
  const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size).fill(fill), size).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute(name, a);
  return a;
}

export function createAvatars(scene, maxCount) {
  const bodyGeo = buildBodyGeometry();
  const fxAttr = instAttr(bodyGeo, 'aFx', maxCount, 1, 1);
  const shapeAttr = instAttr(bodyGeo, 'aShape', maxCount, 2, 1);
  const animAttr = instAttr(bodyGeo, 'aAnim', maxCount, 4, 0);
  const bodyMat = buildBodyMaterial();
  const body = new THREE.InstancedMesh(bodyGeo, bodyMat, maxCount);
  body.name = 'avatars:body';
  body.frustumCulled = false;
  body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const sensorGeo = buildSensorGeometry();
  const sensorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const sensors = new THREE.InstancedMesh(sensorGeo, sensorMat, maxCount * 4);
  sensors.name = 'avatars:sensors';
  sensors.frustumCulled = false;
  sensors.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // ciało FPP: osobna geometria współdzieląca bufory wierzchołków korpusu (własne atrybuty instancji), 1 instancja
  const fpGeo = new THREE.BufferGeometry();
  fpGeo.setIndex(bodyGeo.index);
  for (const k of ['position', 'normal', 'aEmit', 'aBone']) fpGeo.setAttribute(k, bodyGeo.getAttribute(k));
  const fpFx = instAttr(fpGeo, 'aFx', 1, 1, 1);
  const fpShape = instAttr(fpGeo, 'aShape', 1, 2, 1);
  const fpAnim = instAttr(fpGeo, 'aAnim', 1, 4, 0);
  fpAnim.array[3] = 1; // maska FPP
  const fpBody = new THREE.InstancedMesh(fpGeo, bodyMat, 1);
  fpBody.name = 'avatars:fpBody';
  fpBody.frustumCulled = false;
  fpBody.layers.set(LAYER_NO_REFLECT);
  fpBody.visible = false;
  const fpSensorList = Int8Array.from(FP.sensors.map((k) => ['front', 'back', 'left', 'right'].indexOf(k)).filter((i) => i >= 0));
  const fpSensors = new THREE.InstancedMesh(sensorGeo, sensorMat, Math.max(1, fpSensorList.length));
  fpSensors.name = 'avatars:fpSensors';
  fpSensors.frustumCulled = false;
  fpSensors.layers.set(LAYER_NO_REFLECT);
  fpSensors.visible = false;

  // prealokacja instanceColor (setColorAt tworzy bufor przy pierwszym wywołaniu — robimy to tutaj, nie w sync)
  for (let i = 0; i < maxCount; i++) body.setColorAt(i, _white);
  for (let i = 0; i < maxCount * 4; i++) sensors.setColorAt(i, _white);
  fpBody.setColorAt(0, _white);
  for (let i = 0; i < fpSensors.count; i++) fpSensors.setColorAt(i, _white);
  body.instanceColor.setUsage(THREE.DynamicDrawUsage);
  sensors.instanceColor.setUsage(THREE.DynamicDrawUsage);
  fpSensors.instanceColor.setUsage(THREE.DynamicDrawUsage);
  body.count = 0;
  sensors.count = 0;

  const locals = buildSensorLocals();
  // cache koloru per slot instancji: hex liczony tylko przy zmianie stringu koloru (porównanie referencji)
  const colStr = new Array(maxCount).fill(null);
  const colRGB = new Float32Array(maxCount * 3);
  let fpColStr = null;
  const fpRGB = new Float32Array(3);

  // stan chodu per uczestnik (indeks w tablicy participants)
  const gPhase = new Float64Array(maxCount);
  const gAmp = new Float32Array(maxCount);
  const gSprint = new Float32Array(maxCount);
  const gX = new Float64Array(maxCount);
  const gZ = new Float64Array(maxCount);
  const gInit = new Uint8Array(maxCount);
  // pola od startu w reprezentacji double (0.5), potem zerowane
  const localGait = { phase: 0.5, amp: 0.5, sprint: 0.5 };
  localGait.phase = 0; localGait.amp = 0; localGait.sprint = 0;
  // Liczby zmiennoprzecinkowe między funkcjami pomocniczymi przez bufor (nie argumenty/wyniki ani `let` z domknięcia —
  // V8 pakuje je w HeapNumber przy nie-inline'owanych wywołaniach, por. D-012).
  const F = new Float64Array(8); // 0 dt, 1 time, 2 lastTime, 3 fx, 4 yaw, 5 crouch
  F[2] = -1;

  scene.add(body);
  scene.add(sensors);
  scene.add(fpBody);
  scene.add(fpSensors);

  /** Faza/amplituda kroku uczestnika i (dystans z interpolowanej pozycji _p; dt = F[0]). */
  function stepGait(i, P) {
    const dt = F[0];
    const b = P.body;
    let dist = 0;
    if (gInit[i]) {
      const dx = _p.x - gX[i], dz = _p.z - gZ[i];
      dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > AV.teleportDist) dist = 0;
    }
    gInit[i] = 1;
    gX[i] = _p.x; gZ[i] = _p.z;
    const alive = P.state === 'alive';
    const crouch = b.crouch > 0 ? b.crouch : 0;
    const sprintT = alive && b.sprinting === true ? 1 : 0;
    gSprint[i] += (sprintT - gSprint[i]) * Math.min(1, dt * AV.sprintSmooth);
    const spr = gSprint[i];
    const step = (AV.stepWalk + (AV.stepSprint - AV.stepWalk) * spr) * (1 + (AV.stepCrouch / AV.stepWalk - 1) * crouch);
    let ph = gPhase[i] + dist / step * Math.PI;
    if (ph > TAU) ph -= TAU;
    gPhase[i] = ph;
    const speed = alive && b.onGround !== false ? Math.sqrt(b.vx * b.vx + b.vz * b.vz) : 0;
    const k = Math.min(1, speed / CONFIG.player.walkSpeed);
    const target = k * (AV.swingWalk + (AV.swingSprint - AV.swingWalk) * spr) * (1 + (AV.swingCrouch - 1) * crouch);
    gAmp[i] += (target - gAmp[i]) * Math.min(1, dt * AV.swingSmooth);
  }

  /** Kolor sensora s uczestnika P (kolor bazowy rgb[o..o+2]; mnożnik stanu F[3]) → _c. */
  function sensorColor(P, s, rgb, o, elim) {
    const fx = F[3];
    let I;
    if (elim) I = AV.sensorLit * fx;
    else if (!isSensorLit(P, s)) I = AV.sensorOff;
    else I = AV.sensorLit * (P.protectTimer > 0 ? fx : 1);
    _c.r = rgb[o] * I; _c.g = rgb[o + 1] * I; _c.b = rgb[o + 2] * I;
    const fl = P.sensorFlash[s];
    if (fl > 0) {
      const t = Math.min(1, fl / CONFIG.combat.hitFlashTime);
      const w = AV.sensorFlash * t;
      _c.r += (w - _c.r) * t; _c.g += (w - _c.g) * t; _c.b += (w - _c.b) * t;
    }
  }

  /** Mnożnik emisji ze stanu (eliminacja → miganie, ochrona → pulsowanie) → F[3]; czas = F[1]. */
  function stateFx(P) {
    const time = F[1];
    let fx = 1;
    if (P.state === 'eliminated') fx = Math.sin(time * TAU * AV.elimBlinkHz) > 0 ? 1 : AV.elimDim;
    else if (P.protectTimer > 0) fx = 1 + AV.protectBoost * (0.5 + 0.5 * Math.sin(time * TAU * AV.protectPulseHz));
    F[3] = fx;
  }

  /** Macierz instancji: pozycja _p (+ opadanie przy wykroku), yaw = F[4] → _m. */
  function composeAt(i) {
    const sw = gAmp[i] * Math.sin(gPhase[i]);
    _p.y -= LEG * (1 - Math.cos(sw)) * AV.bodyBob;
    const h = F[4] * 0.5; // obrót wokół Y (jak setFromAxisAngle, bez argumentu double)
    _q.set(0, Math.sin(h), 0, Math.cos(h));
    _m.compose(_p, _q, _s);
  }

  /** aAnim instancji (faza, wymach, opuszczenie broni); kucanie = F[5]. */
  function writeAnim(arr, o, i) {
    const amp = gAmp[i];
    arr[o] = gPhase[i];
    arr[o + 1] = amp;
    arr[o + 2] = gSprint[i] * AV.sprintArmPitch * (1 - F[5]) + AV.armBob * (amp / AV.swingWalk) * Math.sin(2 * gPhase[i]);
  }

  function syncLocal(P, i, camera) {
    const b = P.body;
    const h = b.height > 0 ? b.height : STAND;
    const crouch = b.crouch > 0 ? b.crouch : 0;
    const yaw = camera ? camera.rotation.y : b.yaw;
    const back = FP.back + (FP.crouchBack - FP.back) * crouch;
    _p.x += Math.sin(yaw) * back;
    _p.z += Math.cos(yaw) * back;
    F[4] = yaw;
    composeAt(i);
    fpBody.setMatrixAt(0, _m);
    fpBody.instanceMatrix.needsUpdate = true;
    const sY = h / STAND;
    fpShape.array[0] = sY; fpShape.array[1] = crouch;
    F[5] = crouch;
    writeAnim(fpAnim.array, 0, i);
    fpShape.needsUpdate = true; fpAnim.needsUpdate = true;
    stateFx(P);
    fpFx.array[0] = F[3]; fpFx.needsUpdate = true;
    if (P.color !== fpColStr) {
      fpColStr = P.color;
      _c.setHex(hexNumber(P.color));
      fpRGB[0] = _c.r; fpRGB[1] = _c.g; fpRGB[2] = _c.b;
      fpBody.setColorAt(0, _c);
      fpBody.instanceColor.needsUpdate = true;
    }
    const hip = AV.hipHeight - LEG * (1 - Math.cos(crouch * AV.crouchThigh));
    for (let k = 0; k < fpSensorList.length; k++) {
      const s = fpSensorList[k];
      _l.copy(locals[s]);
      _l.elements[13] *= sY;
      _l.elements[14] += Math.max(0, _l.elements[13] - hip + FP.leanBase) * FP.lean; // jak ścięcie torsu w shaderze
      _ms.multiplyMatrices(_m, _l);
      fpSensors.setMatrixAt(k, _ms);
      sensorColor(P, s, fpRGB, 0, false);
      fpSensors.setColorAt(k, _c);
    }
    fpSensors.instanceMatrix.needsUpdate = true;
    fpSensors.instanceColor.needsUpdate = true;
  }

  function sync(participants, alpha, time, localId, camera, fpLocal = false) {
    let dt = F[2] < 0 ? 0 : time - F[2];
    if (dt < 0 || dt > 0.25) dt = 0;
    F[0] = dt; F[1] = time; F[2] = time;
    const cp = camera ? camera.position : null; // kamera jest dzieckiem sceny (bez rodzica z transformacją) → position = świat
    let j = 0;
    let fpShown = false;
    const n = participants.length < maxCount ? participants.length : maxCount;
    for (let i = 0; i < n; i++) {
      const P = participants[i];
      const b = P.body;
      _p.x = P.prevX + (b.x - P.prevX) * alpha;
      _p.y = P.prevY + (b.y - P.prevY) * alpha;
      _p.z = P.prevZ + (b.z - P.prevZ) * alpha;
      stepGait(i, P);
      if (P.id === localId) {
        localGait.phase = gPhase[i];
        localGait.amp = gAmp[i] / AV.swingWalk;
        localGait.sprint = gSprint[i];
        if (fpLocal && P.state === 'alive') { syncLocal(P, i, camera); fpShown = true; }
        continue;
      }
      const h = b.height > 0 ? b.height : STAND;
      // kamera w (lub tuż przy) korpusie → pomiń instancję (nigdy pełnoekranowy ciemny blok)
      if (cp !== null) {
        const dx = cp.x - _p.x, dz = cp.z - _p.z;
        if (dx * dx + dz * dz < HIDE2 && cp.y > _p.y - AV.hideMarginY && cp.y < _p.y + h + AV.hideMarginY) continue;
      }
      const sY = h / STAND;
      const crouch = b.crouch > 0 ? b.crouch : 0;
      shapeAttr.array[j * 2] = sY;
      shapeAttr.array[j * 2 + 1] = crouch;
      F[5] = crouch;
      writeAnim(animAttr.array, j * 4, i);
      F[4] = b.yaw;
      composeAt(i);
      body.setMatrixAt(j, _m);

      // stan: eliminacja → miganie, ochrona → pulsowanie
      const elim = P.state === 'eliminated';
      stateFx(P);
      fxAttr.array[j] = F[3];

      if (P.color !== colStr[j]) {
        colStr[j] = P.color;
        _c.setHex(hexNumber(P.color));
        colRGB[j * 3] = _c.r; colRGB[j * 3 + 1] = _c.g; colRGB[j * 3 + 2] = _c.b;
        body.setColorAt(j, _c);
        body.instanceColor.needsUpdate = true;
      }
      for (let s = 0; s < 4; s++) {
        const k = j * 4 + s;
        // sensor na wysokości y × height/standHeight (spójnie z combat)
        _l.copy(locals[s]);
        _l.elements[13] *= sY;
        _ms.multiplyMatrices(_m, _l);
        sensors.setMatrixAt(k, _ms);
        sensorColor(P, s, colRGB, j * 3, elim);
        sensors.setColorAt(k, _c);
      }
      j++;
    }
    for (let i = n; i < maxCount; i++) gInit[i] = 0;
    fpBody.visible = fpShown;
    fpSensors.visible = fpShown && fpSensorList.length > 0;
    body.count = j;
    sensors.count = j * 4;
    body.instanceMatrix.needsUpdate = true;
    sensors.instanceMatrix.needsUpdate = true;
    sensors.instanceColor.needsUpdate = true;
    fxAttr.needsUpdate = true;
    shapeAttr.needsUpdate = true;
    animAttr.needsUpdate = true;
  }

  function dispose() {
    for (const m of [body, sensors, fpBody, fpSensors]) if (m.parent) m.parent.remove(m);
    // fpGeo współdzieli bufory z bodyGeo — zwalniane razem
    fpGeo.dispose(); bodyGeo.dispose(); bodyMat.dispose(); body.dispose(); fpBody.dispose();
    sensorGeo.dispose(); sensorMat.dispose(); sensors.dispose(); fpSensors.dispose();
  }

  return { sync, dispose, localGait, meshes: [body, sensors, fpBody, fpSensors] };
}
