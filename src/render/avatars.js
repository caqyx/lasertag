// Awatary uczestników (SPEC §2.1/§2.2/§4; PLAN §7.7).
// createAvatars(scene, maxCount) → { sync(participants, alpha, time, localId, camera?), dispose() }
//   camera: awatar, w którego kapsule (XZ < avatar.hideDist, w zakresie wysokości) jest kamera, jest pomijany.
//   Kucanie: body.height (wys. kapsuły) i body.crouch (0..1) — undefined = stojący.
//
// 2 draw calle:
//  • korpus — jedna scalona geometria na uczestnika (nogi, tors, ramiona, hełm z wizjerem, broń w dłoni, pas),
//    ciemny matowy MeshStandardMaterial; atrybut wierzchołka aEmit = części emisyjne (wizjer, pas, pasek broni)
//    w kolorze uczestnika (instanceColor), + tani fresnel/rim w kolorze uczestnika (czytelna sylwetka w ciemności).
//    aFx (na instancję) = mnożnik emisji: eliminacja → miganie, ochrona → pulsowanie.
//  • sensory kamizelki — 4 instancje na uczestnika (front/back na klatce, lewe/prawe na ramionach,
//    pozycje z SENSOR_OFFSETS/CONFIG.combat.sensors), MeshBasicMaterial × instanceColor HDR: zapalony = kolor × sensorLit,
//    zgaszony = ciemny, błysk = biały, eliminacja = miganie, ochrona = pulsowanie.
// Model zwrócony w −Z (yaw = 0 patrzy w −Z, PLAN §0). sync bez alokacji (scratch na poziomie modułu).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';
import { SENSOR, SENSOR_OFFSETS, isSensorLit } from '../game/participant.js';

const AV = CONFIG.avatar;

// scratch
const _m = new THREE.Matrix4();
const _ms = new THREE.Matrix4();
const _l = new THREE.Matrix4();
const STAND = CONFIG.player.height;
const HIDE2 = CONFIG.avatar.hideDist * CONFIG.avatar.hideDist;
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);
const _c = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

// ------------------------------------------------------------------ geometria korpusu

function part(geo, emit, matrix) {
  geo.deleteAttribute('uv');
  if (matrix) geo.applyMatrix4(matrix);
  const n = geo.attributes.position.count;
  const e = new Float32Array(n).fill(emit);
  geo.setAttribute('aEmit', new THREE.BufferAttribute(e, 1));
  return geo;
}

function trs(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  const m = new THREE.Matrix4();
  m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  return m;
}

// kapsuła między punktami a i b
function limb(ax, ay, az, bx, by, bz, r, emit = 0) {
  const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
  const d = b.clone().sub(a);
  const len = d.length();
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 2, 5);
  const m = new THREE.Matrix4().compose(
    a.clone().add(b).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()),
    new THREE.Vector3(1, 1, 1),
  );
  return part(g, emit, m);
}

function buildBodyGeometry() {
  const parts = [
    // nogi + biodra
    limb(-0.11, 0.1, 0.0, -0.1, 0.78, 0.0, 0.085),
    limb(0.11, 0.1, 0.0, 0.1, 0.78, 0.0, 0.085),
    part(new THREE.SphereGeometry(0.16, 8, 5), 0, trs(0, 0.86, 0, 0, 0, 0, 1.25, 0.7, 0.95)),
    // tors (kamizelka): kapsuła spłaszczona
    part(new THREE.CapsuleGeometry(0.2, 0.38, 3, 10), 0, trs(0, 1.27, 0, 0, 0, 0, 1.18, 1, 1.0)),
    // naramienniki
    part(new THREE.SphereGeometry(0.095, 7, 5), 0, trs(-0.235, 1.5, 0, 0, 0, 0, 1, 0.85, 1)),
    part(new THREE.SphereGeometry(0.095, 7, 5), 0, trs(0.235, 1.5, 0, 0, 0, 0, 1, 0.85, 1)),
    // ramiona: fazer na wysokości barku (wylot = CONFIG.weapon.muzzleOffset względem oka — stąd startują wiązki botów)
    limb(0.25, 1.45, 0.0, 0.28, 1.22, -0.08, 0.06),
    limb(0.28, 1.22, -0.08, 0.2, 1.36, -0.15, 0.055),
    // lewe przedramię nisko pod sensorem przednim (sensor ma być widoczny z przodu)
    limb(-0.25, 1.45, 0.0, -0.17, 1.08, -0.2, 0.06),
    limb(-0.17, 1.08, -0.2, 0.15, 1.37, -0.38, 0.055),
    // szyja + hełm + wizjer (emisyjny, łuk z przodu)
    part(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 6, 1, true), 0, trs(0, 1.64, 0)),
    part(new THREE.SphereGeometry(0.145, 10, 7), 0, trs(0, 1.75, 0.01, 0, 0, 0, 1, 1.02, 1.08)),
    part(new THREE.CylinderGeometry(0.152, 0.148, 0.055, 10, 1, true, Math.PI - 0.95, 1.9), AV.visorIntensity, trs(0, 1.75, 0.005)),
    // pas (emisyjny, słaby) — linia talii czytelna z daleka
    part(new THREE.TorusGeometry(0.205, 0.016, 3, 14), AV.trimIntensity * 0.6, trs(0, 0.95, 0, Math.PI / 2, 0, 0, 1.12, 0.92, 1)),
    // fazer w dłoniach (wylot ≈ (0.22, 1.47, −0.45))
    part(new THREE.BoxGeometry(0.07, 0.09, 0.36), 0, trs(0.2, 1.44, -0.25)),
    part(new THREE.BoxGeometry(0.045, 0.11, 0.055), 0, trs(0.2, 1.36, -0.14, 0.3, 0, 0)),
    part(new THREE.BoxGeometry(0.075, 0.016, 0.26), AV.trimIntensity, trs(0.2, 1.492, -0.27)),
    part(new THREE.CylinderGeometry(0.024, 0.024, 0.05, 6), AV.visorIntensity, trs(0.21, 1.46, -0.445, Math.PI / 2, 0, 0)),
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

// ------------------------------------------------------------------ materiał korpusu

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
    uKnee: { value: AV.kneeBend },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aEmit;\nattribute float aFx;\nattribute vec2 aShape;\nuniform float uHeadBase;\nuniform float uHip;\nuniform float uKnee;\nvarying float vEmit;\nvarying float vFx;')
      // kucanie: wszystko poniżej podstawy hełmu skalowane w pionie (aShape.x = height/standHeight — te same
      // wysokości sensorów co w combat), hełm przesunięty sztywno; kolana wypchnięte do przodu (aShape.y = crouch)
      .replace('#include <beginnormal_vertex>', [
        '#include <beginnormal_vertex>',
        'if (position.y < uHeadBase) objectNormal = normalize(vec3(objectNormal.x, objectNormal.y / max(aShape.x, 0.2), objectNormal.z));',
      ].join('\n'))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        'if (position.y < uHeadBase) {',
        '  transformed.y = position.y * aShape.x;',
        '  float leg = clamp(position.y / uHip, 0.0, 1.0);',
        '  transformed.z -= aShape.y * uKnee * sin(3.14159265 * leg) * step(position.y, uHip);',
        '} else {',
        '  transformed.y = position.y - uHeadBase * (1.0 - aShape.x);',
        '}',
        'vEmit = aEmit;',
        'vFx = aFx;',
      ].join('\n'));
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTint;\nuniform float uRimI;\nuniform float uRimPow;\nvarying float vEmit;\nvarying float vFx;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= mix(vec3(1.0), vColor, uTint);')
      .replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        'float rimD = 1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);',
        'float rim = pow(rimD, uRimPow);',
        'totalEmissiveRadiance += vColor * (vEmit + rim * uRimI) * vFx;',
      ].join('\n'));
  };
  mat.customProgramCacheKey = () => 'lt-avatar-body';
  return mat;
}

// ------------------------------------------------------------------ API

export function createAvatars(scene, maxCount) {
  const bodyGeo = buildBodyGeometry();
  const fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxCount).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
  bodyGeo.setAttribute('aFx', fxAttr);
  const shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxCount * 2).fill(1), 2).setUsage(THREE.DynamicDrawUsage);
  bodyGeo.setAttribute('aShape', shapeAttr);
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

  // prealokacja instanceColor (setColorAt tworzy bufor przy pierwszym wywołaniu — robimy to tutaj, nie w sync)
  for (let i = 0; i < maxCount; i++) body.setColorAt(i, _white);
  for (let i = 0; i < maxCount * 4; i++) sensors.setColorAt(i, _white);
  body.instanceColor.setUsage(THREE.DynamicDrawUsage);
  sensors.instanceColor.setUsage(THREE.DynamicDrawUsage);
  body.count = 0;
  sensors.count = 0;

  const locals = buildSensorLocals();
  // cache koloru per slot instancji: hex liczony tylko przy zmianie stringu koloru (porównanie referencji)
  const colStr = new Array(maxCount).fill(null);
  const colRGB = new Float32Array(maxCount * 3);

  scene.add(body);
  scene.add(sensors);

  const TAU = Math.PI * 2;

  function sync(participants, alpha, time, localId, camera) {
    const cp = camera ? camera.position : null; // kamera jest dzieckiem sceny (bez rodzica z transformacją) → position = świat
    let j = 0;
    const n = participants.length;
    for (let i = 0; i < n && j < maxCount; i++) {
      const P = participants[i];
      if (P.id === localId) continue;
      const b = P.body;
      _p.set(
        P.prevX + (b.x - P.prevX) * alpha,
        P.prevY + (b.y - P.prevY) * alpha,
        P.prevZ + (b.z - P.prevZ) * alpha,
      );
      const h = b.height > 0 ? b.height : STAND;
      // kamera w (lub tuż przy) korpusie → pomiń instancję (nigdy pełnoekranowy ciemny blok)
      if (cp !== null) {
        const dx = cp.x - _p.x, dz = cp.z - _p.z;
        if (dx * dx + dz * dz < HIDE2 && cp.y > _p.y - AV.hideMarginY && cp.y < _p.y + h + AV.hideMarginY) continue;
      }
      const sY = h / STAND;
      shapeAttr.array[j * 2] = sY;
      shapeAttr.array[j * 2 + 1] = b.crouch > 0 ? b.crouch : 0;
      _q.setFromAxisAngle(_up, b.yaw);
      _m.compose(_p, _q, _s);
      body.setMatrixAt(j, _m);

      // stan: eliminacja → miganie, ochrona → pulsowanie
      const elim = P.state === 'eliminated';
      let fx = 1;
      if (elim) fx = Math.sin(time * TAU * AV.elimBlinkHz) > 0 ? 1 : AV.elimDim;
      else if (P.protectTimer > 0) fx = 1 + AV.protectBoost * (0.5 + 0.5 * Math.sin(time * TAU * AV.protectPulseHz));
      fxAttr.array[j] = fx;

      if (P.color !== colStr[j]) {
        colStr[j] = P.color;
        _c.setHex(hexNumber(P.color));
        colRGB[j * 3] = _c.r; colRGB[j * 3 + 1] = _c.g; colRGB[j * 3 + 2] = _c.b;
        body.setColorAt(j, _c);
        body.instanceColor.needsUpdate = true;
      }
      const cr = colRGB[j * 3], cg = colRGB[j * 3 + 1], cb = colRGB[j * 3 + 2];
      for (let s = 0; s < 4; s++) {
        const k = j * 4 + s;
        // sensor na wysokości y × height/standHeight (spójnie z combat)
        _l.copy(locals[s]);
        _l.elements[13] *= sY;
        _ms.multiplyMatrices(_m, _l);
        sensors.setMatrixAt(k, _ms);
        let I;
        if (elim) I = AV.sensorLit * fx;
        else if (!isSensorLit(P, s)) I = AV.sensorOff;
        else I = AV.sensorLit * (P.protectTimer > 0 ? fx : 1);
        _c.setRGB(cr * I, cg * I, cb * I);
        const fl = P.sensorFlash[s];
        if (fl > 0) {
          const t = Math.min(1, fl / CONFIG.combat.hitFlashTime);
          const w = AV.sensorFlash * t;
          _c.r += (w - _c.r) * t; _c.g += (w - _c.g) * t; _c.b += (w - _c.b) * t;
        }
        sensors.setColorAt(k, _c);
      }
      j++;
    }
    body.count = j;
    sensors.count = j * 4;
    body.instanceMatrix.needsUpdate = true;
    sensors.instanceMatrix.needsUpdate = true;
    sensors.instanceColor.needsUpdate = true;
    fxAttr.needsUpdate = true;
    shapeAttr.needsUpdate = true;
  }

  function dispose() {
    if (body.parent) body.parent.remove(body);
    if (sensors.parent) sensors.parent.remove(sensors);
    bodyGeo.dispose(); bodyMat.dispose(); body.dispose();
    sensorGeo.dispose(); sensorMat.dispose(); sensors.dispose();
  }

  return { sync, dispose, meshes: [body, sensors] };
}
