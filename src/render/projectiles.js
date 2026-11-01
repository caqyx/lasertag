// Pociski wyrzutni (D-037): świecąca, pulsująca kula + ślad w kolorze strzelca. 1 draw call (InstancedBufferGeometry,
// instancje = aktywne pociski z sim.proj, upakowane co klatkę); brak pocisków → mesh niewidoczny (0 calli).
// createProjectileFx(scene) → { sync(sim, alpha, localIndex, muzzle), update(dt), dispose() }
//   sync czyta pulę symulacji (pozycja interpolowana prev → bieżąca), bez alokacji. Własny pocisk gracza (localIndex)
//   przez fx.projectile.muzzleBlend s startuje wizualnie z lufy FPP (muzzle: Vector3 w świecie) i zbiega do pozycji z sim.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';

const PF = CONFIG.fx.projectile;
const COLLAPSE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';

const VERT = /* glsl */`
attribute vec4 aPos;       // pozycja xyz, w = długość śladu (m)
attribute vec4 aDir;       // kierunek lotu xyz, w = faza pulsowania
attribute vec3 aCol;
uniform float uTime;
uniform float uSize;
uniform float uPulseHz;
uniform float uPulse;
uniform float uTrailW;
varying vec2 vQ;
varying float vKind;
varying vec3 vCol;
varying float vDepth;
void main() {
  float kind = position.z;   // 0 kula, 1 ślad
  vec4 mv;
  if (kind < 0.5) {
    float s = uSize * (1.0 + uPulse * sin(6.2831853 * (uTime * uPulseHz + aDir.w)));
    mv = viewMatrix * vec4(aPos.xyz, 1.0);
    mv.xy += position.xy * s;
    vQ = position.xy;
  } else {
    if (aPos.w < 1e-3) { ${COLLAPSE} }
    // x: 0 głowa (kula) → 1 ogon
    vec3 P = aPos.xyz - aDir.xyz * (position.x * aPos.w);
    vec3 side = cross(aDir.xyz, cameraPosition - P);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
    P += side * (position.y * uTrailW * (1.0 - 0.7 * position.x));
    mv = viewMatrix * vec4(P, 1.0);
    vQ = position.xy;
  }
  vKind = kind;
  vCol = aCol;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform vec3 fogColor;
uniform float fogDensity;
uniform float uCoreI;
uniform float uGlowI;
uniform float uTrailI;
varying vec2 vQ;
varying float vKind;
varying vec3 vCol;
varying float vDepth;
void main() {
  vec3 col;
  if (vKind < 0.5) {
    float r = length(vQ);
    if (r > 1.0) discard;
    float glow = exp(-r * r * 4.0) * (1.0 - r);
    float core = exp(-r * r * 40.0);
    col = vCol * glow * uGlowI + vec3(core) * uCoreI;
  } else {
    float a = abs(vQ.y);
    float t = 1.0 - vQ.x;
    float across = exp(-a * a * 3.0) * (1.0 - a);
    float core = exp(-a * a * 30.0);
    col = (vCol * across + vec3(core) * 0.5) * uTrailI * t * t;
  }
  float fogF = exp(-fogDensity * fogDensity * vDepth * vDepth);
  gl_FragColor = vec4(col * fogF, 1.0);
}`;

function buildGeometry(capacity) {
  const pos = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,   // kula
    0, -1, 1, 1, -1, 1, 1, 1, 1, 0, 1, 1];               // ślad
  const idx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPos', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aDir', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aCol', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = 0;
  return g;
}

export function createProjectileFx(scene, capacity = CONFIG.weapons.bouncer.maxActive) {
  const geo = buildGeometry(capacity);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uSize: { value: PF.size },
      uPulseHz: { value: PF.pulseHz },
      uPulse: { value: PF.pulse },
      uTrailW: { value: PF.trailWidth },
      uCoreI: { value: PF.coreIntensity },
      uGlowI: { value: PF.glowIntensity },
      uTrailI: { value: PF.trailIntensity },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'projectiles';
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  mesh.visible = false;
  scene.add(mesh);

  const aPos = geo.attributes.aPos, aDir = geo.attributes.aDir, aCol = geo.attributes.aCol;
  const P4 = aPos.array, D4 = aDir.array, C3 = aCol.array;
  const maxP = CONFIG.combat.maxParticipants;
  const colStr = new Array(maxP).fill('');
  const colRGB = new Float32Array(maxP * 3);
  const _c = new THREE.Color();

  function ownerColor(sim, o, k) {
    const P = sim.participants[o];
    if (o < maxP && P.color !== colStr[o]) {
      colStr[o] = P.color;
      _c.setHex(hexNumber(P.color));
      colRGB[o * 3] = _c.r; colRGB[o * 3 + 1] = _c.g; colRGB[o * 3 + 2] = _c.b;
    }
    const j = o < maxP ? o : 0;
    C3[k * 3] = colRGB[j * 3]; C3[k * 3 + 1] = colRGB[j * 3 + 1]; C3[k * 3 + 2] = colRGB[j * 3 + 2];
  }

  function sync(sim, alpha, localIndex, muzzle) {
    const pr = sim === null ? null : sim.proj;
    if (pr === null || pr.count === 0) {
      mesh.visible = false;
      geo.instanceCount = 0;
      return;
    }
    const sp = CONFIG.weapons.bouncer.speed;
    let k = 0;
    for (let i = 0; i < pr.capacity && k < capacity; i++) {
      if (pr.active[i] === 0) continue;
      let x = pr.px[i] + (pr.x[i] - pr.px[i]) * alpha;
      let y = pr.py[i] + (pr.y[i] - pr.py[i]) * alpha;
      let z = pr.pz[i] + (pr.z[i] - pr.pz[i]) * alpha;
      const o = pr.owner[i];
      if (o === localIndex && pr.bounces[i] === 0 && pr.age[i] < PF.muzzleBlend && muzzle !== null) {
        const w = 1 - pr.age[i] / PF.muzzleBlend;
        x += (muzzle.x - pr.sx[i]) * w; y += (muzzle.y - pr.sy[i]) * w; z += (muzzle.z - pr.sz[i]) * w;
      }
      const dx = pr.vx[i] / sp, dy = pr.vy[i] / sp, dz = pr.vz[i] / sp;
      const ex = x - pr.sx[i], ey = y - pr.sy[i], ez = z - pr.sz[i];
      const run = Math.sqrt(ex * ex + ey * ey + ez * ez);
      P4[k * 4] = x; P4[k * 4 + 1] = y; P4[k * 4 + 2] = z; P4[k * 4 + 3] = run < PF.trail ? run : PF.trail;
      D4[k * 4] = dx; D4[k * 4 + 1] = dy; D4[k * 4 + 2] = dz; D4[k * 4 + 3] = (i * 0.618034) % 1;
      ownerColor(sim, o, k);
      k++;
    }
    geo.instanceCount = k;
    mesh.visible = k > 0;
    aPos.needsUpdate = true; aDir.needsUpdate = true; aCol.needsUpdate = true;
  }

  function update(dt) {
    mat.uniforms.uTime.value += dt;
  }

  function dispose() {
    if (mesh.parent) mesh.parent.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { sync, update, dispose, mesh };
}
