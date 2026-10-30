// Wiązki lasera + błysk przy lufie + iskry trafień (SPEC §2.3, §4; PLAN §7.7).
// createBeams(scene, capacity, sparkCapacity?) → { spawn(x,y,z, x2,y2,z2, color, hit), update(dt, camera), dispose() }
//
// 2 draw calle:
//  • wiązki — instancjonowana geometria: wstęga (billboard wokół osi wiązki w vertex shaderze, zwężona przy lufie)
//    + quad błysku przy lufie + quad poświaty na końcu. Biały rdzeń + kolorowa poświata, HDR (> 1) → bloom.
//  • iskry — na instancję (trafienie) rozbłysk + CONFIG.fx.sparkFragments odłamków; kierunki odłamków zapisane
//    w geometrii, lot (prędkość, grawitacja, smuga) liczony w shaderze z uniformu time — zero pracy CPU na cząstkę.
// Pule pierścieniowe: najstarszy slot nadpisywany. spawn/update bez alokacji. Mieszanie addytywne + mgła exp2.
import * as THREE from 'three';
import { CONFIG } from '../config.js';

const FX = CONFIG.fx;

// '#rrggbb' | 0xrrggbb → liczba, bez alokacji (bez regexów/substringów).
export function hexNumber(c) {
  if (typeof c === 'number') return c;
  let n = 0;
  const start = c.charCodeAt(0) === 35 ? 1 : 0; // '#'
  for (let i = start; i < start + 6; i++) {
    const ch = c.charCodeAt(i);
    const v = ch <= 57 ? ch - 48 : (ch | 32) - 87; // 0-9, a-f/A-F
    n = (n << 4) | (v & 15);
  }
  return n >>> 0;
}

const _c = new THREE.Color();

const COLLAPSE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';

const FOG_PARS = /* glsl */`
uniform vec3 fogColor;
uniform float fogDensity;
`;

// ------------------------------------------------------------------ wiązki

const BEAM_VERT = /* glsl */`
attribute float aFrac;     // ułamek długości (dodawany do position.x w metrach)
attribute vec3 aA;         // start (lufa)
attribute vec4 aB;         // koniec xyz, w = trafienie (0/1)
attribute vec4 aC;         // kolor rgb (liniowy), w = czas startu
uniform float uTime;
uniform float uDur;
uniform float uWidth;
uniform float uTaper;
uniform float uTaperMin;
uniform float uMuzzleSize;
uniform float uMuzzleTime;
uniform float uEndSize;
varying vec2 vQ;
varying float vKind;
varying float vK;
varying vec3 vCol;
varying float vDepth;
void main() {
  float kind = position.z;            // 0 wstęga, 1 błysk lufy, 2 koniec
  float life = kind > 0.5 && kind < 1.5 ? uMuzzleTime : uDur;
  float age = uTime - aC.w;
  vec3 A = aA;
  vec3 B = aB.xyz;
  vec3 d = B - A;
  float len = length(d);
  if (age < 0.0 || age > life || len < 1e-3) { ${COLLAPSE} }
  float k = age / life;
  vec3 dir = d / len;
  vec4 mv;
  if (kind < 0.5) {
    float s = min(position.x + aFrac * len, len);
    vec3 P = A + dir * s;
    vec3 side = cross(dir, cameraPosition - P);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
    float w = uWidth * mix(uTaperMin, 1.0, clamp(s / uTaper, 0.0, 1.0)) * (1.0 + 0.5 * k);
    P += side * (position.y * w);
    mv = viewMatrix * vec4(P, 1.0);
    vQ = vec2(s / len, position.y);
  } else {
    vec3 C = kind < 1.5 ? A : B;
    float size = kind < 1.5 ? uMuzzleSize * (0.7 + 0.6 * k) : uEndSize * (0.8 + 0.6 * k);
    mv = viewMatrix * vec4(C, 1.0);
    mv.xy += position.xy * size;
    vQ = position.xy;
  }
  vKind = kind;
  vK = k;
  vCol = aC.rgb;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FRAG = /* glsl */`
${FOG_PARS}
uniform float uCore;
uniform float uCoreI;
uniform float uGlowI;
uniform float uMuzzleI;
uniform float uEndI;
uniform vec2 uNearFade;
varying vec2 vQ;
varying float vKind;
varying float vK;
varying vec3 vCol;
varying float vDepth;
void main() {
  vec3 col;
  if (vKind < 0.5) {
    float a = abs(vQ.y);
    float core = exp(-(a * a) / (uCore * uCore) * 2.0);
    float glow = exp(-a * a * 3.0) * (1.0 - a);
    float fade = (1.0 - vK) * (1.0 - vK);
    // rdzeń gaśnie szybciej niż poświata; delikatny zanik na samym końcu wiązki
    float tail = smoothstep(1.0, 0.985, vQ.x);
    float near = mix(0.3, 1.0, smoothstep(uNearFade.x, uNearFade.y, vDepth));
    col = (vec3(uCoreI) * core * (1.0 - vK) + vCol * glow * uGlowI) * fade * tail * near;
  } else {
    float r = length(vQ);
    if (r > 1.0) discard;
    float g = exp(-r * r * 6.0) * (1.0 - r);
    float hot = exp(-r * r * 30.0);
    float fade = (1.0 - vK) * (1.0 - vK);
    float I = vKind < 1.5 ? uMuzzleI : uEndI;
    col = (vCol * g + vec3(hot)) * I * fade;
  }
  float fogF = exp(-fogDensity * fogDensity * vDepth * vDepth);
  gl_FragColor = vec4(col * fogF, 1.0);
}`;

// ------------------------------------------------------------------ iskry

const SPARK_VERT = /* glsl */`
attribute vec4 aSeed;      // kierunek odłamka (jednostkowy) + czynnik prędkości 0..1
attribute vec4 aP;         // punkt trafienia xyz, w = siła (1 trafienie uczestnika, <1 ściana)
attribute vec3 aN;         // kierunek odbicia (przeciwny do wiązki)
attribute vec4 aC;         // kolor rgb, w = czas startu
uniform float uTime;
uniform float uLife;
uniform float uFlashTime;
uniform float uFlashSize;
uniform vec2 uSpeed;
uniform float uGravity;
uniform float uStreak;
uniform float uSparkWidth;
varying vec2 vQ;
varying float vKind;
varying float vK;
varying float vPow;
varying vec3 vCol;
varying float vDepth;
void main() {
  float kind = position.z;  // 0 odłamek, 1 rozbłysk
  float pw = aP.w;
  float age = uTime - aC.w;
  float life = kind > 0.5 ? uFlashTime : uLife * (0.55 + 0.45 * aSeed.w) * (0.6 + 0.4 * pw);
  if (age < 0.0 || age > life) { ${COLLAPSE} }
  float k = age / life;
  vec4 mv;
  if (kind > 0.5) {
    mv = viewMatrix * vec4(aP.xyz, 1.0);
    mv.xy += position.xy * uFlashSize * (0.45 + 0.8 * k) * mix(0.45, 1.0, pw);
    // lekko przed powierzchnią, żeby rozbłysk nie wchodził w ścianę
    mv.z += 0.08;
    vQ = position.xy;
  } else {
    vec3 v0 = normalize(aSeed.xyz + aN * 1.1) * mix(uSpeed.x, uSpeed.y, aSeed.w) * mix(0.55, 1.0, pw);
    vec3 g = vec3(0.0, -uGravity, 0.0);
    vec3 p = aP.xyz + v0 * age + 0.5 * g * age * age;
    vec3 vel = v0 + g * age;
    float sp = length(vel);
    vec3 vd = vel / max(sp, 1e-4);
    vec3 P = p - vd * (sp * uStreak * (1.0 - position.x));
    vec3 side = cross(vd, cameraPosition - P);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(0.0, 1.0, 0.0);
    P += side * (position.y * uSparkWidth * (1.0 - 0.5 * k));
    mv = viewMatrix * vec4(P, 1.0);
    vQ = position.xy;
  }
  vKind = kind;
  vK = k;
  vPow = pw;
  vCol = aC.rgb;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const SPARK_FRAG = /* glsl */`
${FOG_PARS}
uniform float uSparkI;
uniform float uFlashI;
varying vec2 vQ;
varying float vKind;
varying float vK;
varying float vPow;
varying vec3 vCol;
varying float vDepth;
void main() {
  vec3 col;
  if (vKind > 0.5) {
    float r = length(vQ);
    if (r > 1.0) discard;
    float g = exp(-r * r * 5.0) * (1.0 - r);
    float hot = exp(-r * r * 26.0);
    float fade = (1.0 - vK) * (1.0 - vK) * (1.0 - vK);
    col = (vCol * g + vec3(hot) * 1.5) * uFlashI * fade * vPow;
  } else {
    float a = abs(vQ.y);
    float across = 1.0 - a;
    float head = 0.35 + 0.65 * vQ.x;
    vec3 c = mix(vec3(1.0, 0.95, 0.9), vCol, smoothstep(0.0, 0.6, vK));
    col = c * across * head * uSparkI * (1.0 - vK) * mix(0.5, 1.0, vPow);
  }
  float fogF = exp(-fogDensity * fogDensity * vDepth * vDepth);
  gl_FragColor = vec4(col * fogF, 1.0);
}`;

// ------------------------------------------------------------------ geometrie

function quadIndices(out, base) {
  out.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function buildBeamGeometry(capacity) {
  const pos = [];
  const frac = [];
  const idx = [];
  // wstęga: wiersze w metrach od lufy (zwężenie) + koniec (ułamek 1)
  const rows = [[0, 0], [0.3, 0], [0.7, 0], [FX.beamTaper, 0], [0, 1]];
  for (let r = 0; r < rows.length; r++) {
    pos.push(rows[r][0], -1, 0, rows[r][0], 1, 0);
    frac.push(rows[r][1], rows[r][1]);
  }
  for (let r = 0; r < rows.length - 1; r++) {
    const a = r * 2;
    idx.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  // błysk lufy (kind 1) i koniec (kind 2)
  for (let kind = 1; kind <= 2; kind++) {
    const base = pos.length / 3;
    pos.push(-1, -1, kind, 1, -1, kind, 1, 1, kind, -1, 1, kind);
    frac.push(0, 0, 0, 0);
    quadIndices(idx, base);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFrac', new THREE.Float32BufferAttribute(frac, 1));
  const aA = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aB = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < capacity; i++) aC.array[i * 4 + 3] = -1e6;
  g.setAttribute('aA', aA);
  g.setAttribute('aB', aB);
  g.setAttribute('aC', aC);
  g.instanceCount = capacity;
  return g;
}

function buildSparkGeometry(capacity) {
  const n = FX.sparkFragments;
  const pos = [];
  const seed = [];
  const idx = [];
  let s = 0x9e3779b9;
  const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = 0; i < n; i++) {
    // losowy kierunek na sferze; przesunięcie w stronę odbicia robi shader (aN)
    const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    const dx = r * Math.cos(th), dy = u * 0.8 + 0.25, dz = r * Math.sin(th);
    const sp = 0.15 + 0.85 * rnd();
    const base = pos.length / 3;
    // x: 0 ogon → 1 głowa; y: bok
    pos.push(0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0);
    for (let k = 0; k < 4; k++) seed.push(dx, dy, dz, sp);
    quadIndices(idx, base);
  }
  const base = pos.length / 3;
  pos.push(-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1);
  for (let k = 0; k < 4; k++) seed.push(0, 0, 0, 0);
  quadIndices(idx, base);

  const g = new THREE.InstancedBufferGeometry();
  g.setIndex(idx);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 4));
  const aP = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const aN = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const aC = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < capacity; i++) aC.array[i * 4 + 3] = -1e6;
  g.setAttribute('aP', aP);
  g.setAttribute('aN', aN);
  g.setAttribute('aC', aC);
  g.instanceCount = capacity;
  return g;
}

function additiveMaterial(vertexShader, fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), ...uniforms },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
}

// ------------------------------------------------------------------ API

export function createBeams(scene, capacity = CONFIG.pools.beams, sparkCapacity = CONFIG.pools.sparks) {
  const beamGeo = buildBeamGeometry(capacity);
  const beamMat = additiveMaterial(BEAM_VERT, BEAM_FRAG, {
    uTime: { value: 0 },
    uDur: { value: CONFIG.weapon.beamDuration },
    uWidth: { value: FX.beamWidth },
    uTaper: { value: FX.beamTaper },
    uTaperMin: { value: FX.beamTaperMin },
    uMuzzleSize: { value: FX.muzzleFlashSize },
    uMuzzleTime: { value: FX.muzzleFlashTime },
    uEndSize: { value: FX.endFlashSize },
    uCore: { value: FX.beamCore },
    uCoreI: { value: FX.beamCoreIntensity },
    uGlowI: { value: FX.beamGlowIntensity },
    uMuzzleI: { value: FX.muzzleFlashIntensity },
    uEndI: { value: FX.endFlashIntensity },
    uNearFade: { value: new THREE.Vector2(FX.beamNearFade[0], FX.beamNearFade[1]) },
  });
  const beamMesh = new THREE.Mesh(beamGeo, beamMat);
  beamMesh.name = 'beams';
  beamMesh.frustumCulled = false;
  beamMesh.renderOrder = 5;

  const sparkGeo = buildSparkGeometry(sparkCapacity);
  const sparkMat = additiveMaterial(SPARK_VERT, SPARK_FRAG, {
    uTime: { value: 0 },
    uLife: { value: FX.sparkLife },
    uFlashTime: { value: FX.hitFlashTime },
    uFlashSize: { value: FX.hitFlashSize },
    uSpeed: { value: new THREE.Vector2(FX.sparkSpeed[0], FX.sparkSpeed[1]) },
    uGravity: { value: FX.sparkGravity },
    uStreak: { value: FX.sparkStreak },
    uSparkWidth: { value: FX.sparkWidth },
    uSparkI: { value: FX.sparkIntensity },
    uFlashI: { value: FX.hitFlashIntensity },
  });
  const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
  sparkMesh.name = 'sparks';
  sparkMesh.frustumCulled = false;
  sparkMesh.renderOrder = 6;

  scene.add(beamMesh);
  scene.add(sparkMesh);

  const bA = beamGeo.attributes.aA.array, bB = beamGeo.attributes.aB.array, bC = beamGeo.attributes.aC.array;
  const sP = sparkGeo.attributes.aP.array, sN = sparkGeo.attributes.aN.array, sC = sparkGeo.attributes.aC.array;
  let beamNext = 0;
  let sparkNext = 0;
  let beamDirty = false;
  let sparkDirty = false;
  let time = 0;

  function spawnSparks(x, y, z, nx, ny, nz, r, g, b, power) {
    const i = sparkNext;
    sparkNext = (sparkNext + 1) % sparkCapacity;
    sP[i * 4] = x; sP[i * 4 + 1] = y; sP[i * 4 + 2] = z; sP[i * 4 + 3] = power;
    sN[i * 3] = nx; sN[i * 3 + 1] = ny; sN[i * 3 + 2] = nz;
    sC[i * 4] = r; sC[i * 4 + 1] = g; sC[i * 4 + 2] = b; sC[i * 4 + 3] = time;
    sparkDirty = true;
  }

  function spawn(x, y, z, x2, y2, z2, color, hit) {
    _c.setHex(hexNumber(color));
    const i = beamNext;
    beamNext = (beamNext + 1) % capacity;
    bA[i * 3] = x; bA[i * 3 + 1] = y; bA[i * 3 + 2] = z;
    bB[i * 4] = x2; bB[i * 4 + 1] = y2; bB[i * 4 + 2] = z2; bB[i * 4 + 3] = hit ? 1 : 0;
    bC[i * 4] = _c.r; bC[i * 4 + 1] = _c.g; bC[i * 4 + 2] = _c.b; bC[i * 4 + 3] = time;
    beamDirty = true;
    const dx = x - x2, dy = y - y2, dz = z - z2;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    spawnSparks(x2, y2, z2, dx / len, dy / len, dz / len, _c.r, _c.g, _c.b, hit ? 1 : FX.wallPower);
  }

  function update(dt) {
    time += dt;
    beamMat.uniforms.uTime.value = time;
    sparkMat.uniforms.uTime.value = time;
    if (beamDirty) {
      beamGeo.attributes.aA.needsUpdate = true;
      beamGeo.attributes.aB.needsUpdate = true;
      beamGeo.attributes.aC.needsUpdate = true;
      beamDirty = false;
    }
    if (sparkDirty) {
      sparkGeo.attributes.aP.needsUpdate = true;
      sparkGeo.attributes.aN.needsUpdate = true;
      sparkGeo.attributes.aC.needsUpdate = true;
      sparkDirty = false;
    }
  }

  function dispose() {
    if (beamMesh.parent) beamMesh.parent.remove(beamMesh);
    if (sparkMesh.parent) sparkMesh.parent.remove(sparkMesh);
    beamGeo.dispose(); beamMat.dispose();
    sparkGeo.dispose(); sparkMat.dispose();
  }

  return { spawn, update, dispose, meshes: [beamMesh, sparkMesh] };
}
