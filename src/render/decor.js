// Dekoracje wizualne z world.decor (M4). Nieznane typy są ignorowane.
// createDecor(world, preset) → { group, update(time), dispose(), covers(solid) }
//   covers(solid) — true, gdy bryła kolizyjna jest w całości przykryta wizualem dekoracji (arena jej nie rysuje).
//
// reactorCore { x, z, r, h }: świecący rdzeń reaktora — ≤ 4 draw calle:
//   1) rdzeń (walec energii + pręt wewnętrzny, ShaderMaterial, przepływ energii przez uniform time),
//   2) konstrukcja stalowa (cokół ośmiokątny, słupki, pierścienie, kołnierze),
//   3) pierścienie neonowe pulsujące + ostrzegawcze pasy (vertexColors + faza w shaderze),
//   4) osłona szklana (addytywna, fresnel).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

const D = CONFIG.render.decor;

const CORE_VERT = /* glsl */`
attribute float aK;
varying float vK;
varying float vY;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
varying float vFogDepth;
void main() {
  vK = aK;
  vY = position.y;
  vAng = atan(position.z, position.x);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const CORE_FRAG = /* glsl */`
uniform float time;
uniform vec3 colA;
uniform vec3 colB;
uniform vec3 fogColor;
uniform float fogDensity;
uniform float intensity;
varying float vK;
varying float vY;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
varying float vFogDepth;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  // energia płynąca w górę: pasma + skośne strugi
  float bands = smoothstep(0.78, 1.0, fract(vY * 0.55 - time * 0.45));
  float flow = 0.5 + 0.5 * sin(vAng * 9.0 + vY * 2.2 - time * 2.3);
  flow = pow(flow, 6.0);
  float pulse = 0.85 + 0.15 * sin(time * 2.7);
  vec3 c;
  if (vK > 0.5) {
    // pręt wewnętrzny: jasny, prawie biało-zielony
    c = mix(colA, vec3(1.0), 0.35) * (1.6 + 0.6 * bands) * pulse;
  } else {
    // płaszcz: ciemniejszy środek, jaśniejsze brzegi (fresnel), pasma i strugi
    float rim = pow(1.0 - facing, 2.0);
    c = colA * (0.25 + 0.9 * rim + 1.4 * bands + 0.8 * flow) * pulse;
    c += colB * smoothstep(0.92, 1.0, fract(vY * 0.12 - time * 0.08)) * 0.8;
  }
  float fogF = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor = vec4(mix(fogColor, c * intensity, fogF), 1.0);
}`;

const PULSE_VERT = /* glsl */`
attribute vec3 color;
attribute float aPhase;
varying vec3 vColor;
varying float vPhase;
varying float vFogDepth;
void main() {
  vColor = color;
  vPhase = aPhase;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PULSE_FRAG = /* glsl */`
uniform float time;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec3 vColor;
varying float vPhase;
varying float vFogDepth;
void main() {
  // fala jasności biegnąca po pierścieniach w górę (vPhase = wysokość); faza < 0 → stałe (ostrzegawcze)
  float k = vPhase < 0.0 ? 1.0 : 0.45 + 0.75 * pow(0.5 + 0.5 * sin(time * 2.4 - vPhase * 1.3), 3.0);
  float fogF = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * 0.6);
  gl_FragColor = vec4(mix(fogColor, vColor * k, fogF), 1.0);
}`;

const GLASS_FRAG = /* glsl */`
uniform vec3 col;
uniform float opacity;
uniform float time;
uniform float fogDensity;
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying float vFogDepth;
void main() {
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(1.0 - facing, 3.0);
  float scan = smoothstep(0.96, 1.0, fract(vY * 0.35 - time * 0.3));
  float fogF = exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  gl_FragColor = vec4(col * (opacity * (0.25 + rim) + scan * 0.25) * fogF, 1.0);
}`;

const GLASS_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vV;
varying float vY;
varying float vFogDepth;
void main() {
  vY = position.y;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

function octagonPoints(R, phase = Math.PI / 8) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = phase + (i * Math.PI) / 4;
    pts.push([Math.cos(a) * R, Math.sin(a) * R]);
  }
  return pts;
}

// pręt między dwoma punktami (BoxGeometry ustawiony wzdłuż odcinka)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3();
function bar(ax, ay, az, bx, by, bz, w, h) {
  _a.set(ax, ay, az); _b.set(bx, by, bz);
  const len = _a.distanceTo(_b);
  const g = new THREE.BoxGeometry(w, len, h);
  _dir.subVectors(_b, _a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  _m.compose(_a.clone().add(_b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

function withAttr(g, name, size, fill) {
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * size);
  for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) arr[i * size + k] = fill[k];
  g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  return g;
}

function stripForMerge(g, keep) {
  for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
  if (!g.index) return g;
  return g.toNonIndexed();
}

function buildReactorCore(d, world, own) {
  const group = new THREE.Group();
  group.name = 'decor:reactorCore';
  group.position.set(d.x, 0, d.z);
  const pal = world.palette;
  const h = Math.min(d.h || world.ceiling, world.ceiling);
  // wizual pokrywa bryłę kolizyjną: ośmiokąt opisany na gwieździe dwóch kwadratów (promień narożnika ≈ r·1.2)
  const R = (d.r || 2.6) * D.core.coverScale;
  const green = new THREE.Color(pal.primary);
  const red = new THREE.Color(pal.accent);
  const fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);

  // 1) rdzeń energii
  const coreR = R * D.core.columnRadius;
  const mant = new THREE.CylinderGeometry(coreR, coreR, h, 40, 8, true);
  mant.translate(0, h / 2, 0);
  withAttr(mant, 'aK', 1, [0]);
  const rod = new THREE.CylinderGeometry(coreR * 0.35, coreR * 0.35, h, 20, 1, true);
  rod.translate(0, h / 2, 0);
  withAttr(rod, 'aK', 1, [1]);
  const coreGeo = own(mergeGeometries([stripForMerge(mant, ['position', 'normal', 'aK']), stripForMerge(rod, ['position', 'normal', 'aK'])]));
  mant.dispose(); rod.dispose();
  const coreMat = own(new THREE.ShaderMaterial({
    uniforms: { ...fogU, time: { value: 0 }, colA: { value: green }, colB: { value: red }, intensity: { value: D.core.intensity } },
    vertexShader: CORE_VERT, fragmentShader: CORE_FRAG, fog: true, side: THREE.DoubleSide,
  }));
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.name = 'reactor:core';
  group.add(core);

  // 2) stal: cokół, słupki, pierścienie konstrukcyjne, kołnierz górny
  const steel = [];
  const base = new THREE.CylinderGeometry(R, R * 1.04, D.core.plinth, 8, 1, false);
  base.rotateY(Math.PI / 8);
  base.translate(0, D.core.plinth / 2, 0);
  steel.push(stripForMerge(base, ['position', 'normal']));
  const top = new THREE.CylinderGeometry(R * 1.02, R, D.core.collar, 8, 1, false);
  top.rotateY(Math.PI / 8);
  top.translate(0, h - D.core.collar / 2, 0);
  steel.push(stripForMerge(top, ['position', 'normal']));
  const oct = octagonPoints(R * 0.99);
  for (const [x, z] of oct) steel.push(stripForMerge(bar(x, D.core.plinth, z, x, h - D.core.collar, z, 0.16, 0.16), ['position', 'normal']));
  for (const y of D.core.cageRings) {
    if (y >= h - D.core.collar) continue;
    for (let i = 0; i < 8; i++) {
      const [x0, z0] = oct[i], [x1, z1] = oct[(i + 1) % 8];
      steel.push(stripForMerge(bar(x0, y, z0, x1, y, z1, 0.12, 0.12), ['position', 'normal']));
    }
  }
  // skośne stężenia między pierścieniami (co drugi bok)
  for (let i = 0; i < 8; i += 2) {
    const [x0, z0] = oct[i], [x1, z1] = oct[(i + 1) % 8];
    steel.push(stripForMerge(bar(x0, D.core.plinth, z0, x1, D.core.cageRings[1] || h * 0.5, z1, 0.06, 0.06), ['position', 'normal']));
  }
  // rury z kołnierza do stropu (detal pokrywy rdzenia)
  for (let k = 0; k < D.core.pipes; k++) {
    const a = (k / D.core.pipes) * Math.PI * 2 + Math.PI / 8;
    const pr = R * D.core.pipeRing;
    const pipe = new THREE.CylinderGeometry(D.core.pipeRadius, D.core.pipeRadius, world.ceiling - h + D.core.collar, 10, 1, true);
    pipe.translate(Math.cos(a) * pr, h - D.core.collar + (world.ceiling - h + D.core.collar) / 2, Math.sin(a) * pr);
    steel.push(stripForMerge(pipe, ['position', 'normal']));
  }
  const steelGeo = own(mergeGeometries(steel));
  for (const g of steel) g.dispose();
  const steelMat = own(new THREE.MeshStandardMaterial({
    color: D.steelColor, metalness: 0.7, roughness: 0.45,
    emissive: green, emissiveIntensity: D.core.steelGlow,
  }));
  const steelMesh = new THREE.Mesh(steelGeo, steelMat);
  steelMesh.name = 'reactor:steel';
  group.add(steelMesh);

  // 3) neon: pierścienie pulsujące (zielone) + pasy ostrzegawcze na cokole (czerwone, stałe)
  const neon = [];
  const nk = D.core.ringIntensity;
  const ringR = R * 1.005;
  const ringOct = octagonPoints(ringR + 0.02);
  for (const y of D.core.glowRings) {
    if (y >= h - D.core.collar) continue;
    for (let i = 0; i < 8; i++) {
      const [x0, z0] = ringOct[i], [x1, z1] = ringOct[(i + 1) % 8];
      const g = stripForMerge(bar(x0, y, z0, x1, y, z1, 0.07, 0.07), ['position']);
      withAttr(g, 'color', 3, [green.r * nk, green.g * nk, green.b * nk]);
      withAttr(g, 'aPhase', 1, [y]);
      neon.push(g);
    }
  }
  // kołnierz górny: listwa w kolorze drugim palety (cyjan) — czytelny detal pokrywy, bez przepalonej zieleni
  {
    const sec = new THREE.Color(pal.secondary), kk = D.core.collarIntensity;
    const topOct = octagonPoints(R * 1.03 + 0.03);
    for (let i = 0; i < 8; i++) {
      const [x0, z0] = topOct[i], [x1, z1] = topOct[(i + 1) % 8];
      for (const y of [h - D.core.collar + 0.05, h - 0.05]) {
        const g = stripForMerge(bar(x0, y, z0, x1, y, z1, 0.05, 0.05), ['position']);
        withAttr(g, 'color', 3, [sec.r * kk, sec.g * kk, sec.b * kk]);
        withAttr(g, 'aPhase', 1, [-1]);
        neon.push(g);
      }
    }
  }
  // cokół: górna krawędź czerwona + skośne pasy ostrzegawcze na ścianach cokołu
  const baseOct = octagonPoints(R * 1.03 + 0.03);
  const rk = D.core.warnIntensity;
  for (let i = 0; i < 8; i++) {
    const [x0, z0] = baseOct[i], [x1, z1] = baseOct[(i + 1) % 8];
    const ge = stripForMerge(bar(x0, D.core.plinth - 0.04, z0, x1, D.core.plinth - 0.04, z1, 0.06, 0.06), ['position']);
    withAttr(ge, 'color', 3, [red.r * rk, red.g * rk, red.b * rk]);
    withAttr(ge, 'aPhase', 1, [-1]);
    neon.push(ge);
    for (let k = 1; k <= 3; k++) {
      const t0 = k / 4 - 0.07, t1 = k / 4 + 0.07;
      const ax = x0 + (x1 - x0) * t0, az = z0 + (z1 - z0) * t0, bx = x0 + (x1 - x0) * t1, bz = z0 + (z1 - z0) * t1;
      const gs = stripForMerge(bar(ax, 0.15, az, bx, D.core.plinth - 0.18, bz, 0.05, 0.03), ['position']);
      withAttr(gs, 'color', 3, [red.r * rk * 0.7, red.g * rk * 0.7, red.b * rk * 0.7]);
      withAttr(gs, 'aPhase', 1, [-1]);
      neon.push(gs);
    }
  }
  const neonGeo = own(mergeGeometries(neon));
  for (const g of neon) g.dispose();
  const neonMat = own(new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), time: { value: 0 } },
    vertexShader: PULSE_VERT, fragmentShader: PULSE_FRAG, fog: true,
  }));
  const neonMesh = new THREE.Mesh(neonGeo, neonMat);
  neonMesh.name = 'reactor:rings';
  group.add(neonMesh);

  // 4) szklana osłona (addytywna)
  const glassH = h - D.core.plinth - D.core.collar;
  const glass = new THREE.CylinderGeometry(R * 0.96, R * 0.96, glassH, 8, 1, true);
  glass.rotateY(Math.PI / 8);
  glass.translate(0, D.core.plinth + glassH / 2, 0);
  own(glass);
  const glassMat = own(new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), col: { value: green }, opacity: { value: D.core.glassOpacity }, time: { value: 0 } },
    vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, fog: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }));
  const glassMesh = new THREE.Mesh(glass, glassMat);
  glassMesh.name = 'reactor:glass';
  glassMesh.renderOrder = 2;
  group.add(glassMesh);

  const timed = [coreMat, neonMat, glassMat];
  return {
    group,
    update(time) { for (const m of timed) m.uniforms.time.value = time; },
    // bryła przykryta: środek w ośmiokącie, a narożniki w promieniu wizualu
    covers(s) {
      const dx = s.cx - d.x, dz = s.cz - d.z;
      const reach = Math.hypot(Math.abs(dx) + Math.max(s.hx, s.hz) * 1.415, Math.abs(dz));
      return reach <= R * 1.03 + 0.05 && s.kind === 'prop';
    },
  };
}

export function createDecor(world, preset) {
  const group = new THREE.Group();
  group.name = 'decor';
  const disposables = [];
  const own = (x) => { disposables.push(x); return x; };
  const items = [];
  for (const d of world.decor || []) {
    if (d.type === 'reactorCore') items.push(buildReactorCore(d, world, own));
  }
  for (const it of items) group.add(it.group);
  return {
    group,
    update(time) { for (let i = 0; i < items.length; i++) items[i].update(time); },
    covers(s) { for (const it of items) if (it.covers(s)) return true; return false; },
    dispose() {
      if (group.parent) group.parent.remove(group);
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    },
  };
}
