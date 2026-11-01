// Wiązki lasera + błysk przy lufie + iskry/odłamki trafień (SPEC §2.3, §4; PLAN §7.7; D-037).
// createBeams(scene, capacity, sparkCapacity?) → { spawn(x,y,z, x2,y2,z2, color, hit), shot(color, hit), shards(color, power),
//   A, update(dt, camera), dispose() }
//   A (Float64Array) — argumenty shot/shards bez boxingu doubli (D-012):
//     shot:   A = [x,y,z, x2,y2,z2, nx,ny,nz, floorY, width, dur] — normalna powierzchni (0 = brak: koniec zasięgu, bez
//             odłamków), floorY = podłoga pod punktem końca (odbicie odłamków), width = × fx.beamWidth, dur = czas wiązki (s)
//     shards: A = [x,y,z, dx,dy,dz, floorY] — odłamki w kierunku d (np. odbicie pocisku, koniec pocisku)
//
// 2 draw calle:
//  • wiązki — instancjonowana geometria: wstęga (billboard wokół osi wiązki w vertex shaderze, zwężona przy lufie)
//    + quad błysku przy lufie + quad poświaty na końcu. Biały rdzeń + kolorowa poświata, HDR (> 1) → bloom.
//  • iskry/odłamki — na instancję (zdarzenie) rozbłysk + CONFIG.fx.shards.count odłamków; losowe kierunki zapisane
//    w geometrii, lot (kierunek odbity od normalnej + rozrzut, grawitacja, jedno słabe odbicie od podłogi, smuga, zanik)
//    liczony analitycznie w shaderze z uniformu time — zero pracy CPU na cząstkę.
// Pule pierścieniowe: najstarszy slot nadpisywany. spawn/update bez alokacji. Mieszanie addytywne + mgła exp2.
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { hexNumber } from './color.js';

const FX = CONFIG.fx;
const SH = FX.shards;

const _c = new THREE.Color();

const COLLAPSE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';

const FOG_PARS = /* glsl */`
uniform vec3 fogColor;
uniform float fogDensity;
`;

// ------------------------------------------------------------------ wiązki

const BEAM_VERT = /* glsl */`
attribute float aFrac;     // ułamek długości (dodawany do position.x w metrach)
attribute vec4 aA;         // start (lufa), w = czas trwania wiązki (s)
attribute vec4 aB;         // koniec xyz, w = skala szerokości
attribute vec4 aC;         // kolor rgb (liniowy), w = czas startu
uniform float uTime;
uniform float uWidth;
uniform float uTaper;
uniform float uTaperMin;
uniform float uMuzzleSize;
uniform float uMuzzleTime;
uniform float uEndSize;
uniform float uNearSize;
uniform float uFlashNearMin;
uniform vec2 uMuzzleGrow;
uniform vec2 uEndGrow;
varying vec2 vQ;
varying float vKind;
varying float vK;
varying vec3 vCol;
varying float vDepth;
void main() {
  float kind = position.z;            // 0 wstęga, 1 błysk lufy, 2 koniec
  float life = kind > 0.5 && kind < 1.5 ? uMuzzleTime : aA.w;
  float age = uTime - aC.w;
  vec3 A = aA.xyz;
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
    float w = uWidth * aB.w * mix(uTaperMin, 1.0, clamp(s / uTaper, 0.0, 1.0)) * (1.0 + 0.5 * k);
    P += side * (position.y * w);
    mv = viewMatrix * vec4(P, 1.0);
    vQ = vec2(s / len, position.y);
  } else {
    vec3 C = kind < 1.5 ? A : B;
    float size = (kind < 1.5 ? uMuzzleSize * (uMuzzleGrow.x + uMuzzleGrow.y * k) : uEndSize * (uEndGrow.x + uEndGrow.y * k)) * sqrt(aB.w);
    mv = viewMatrix * vec4(C, 1.0);
    // przy samej kamerze (własna lufa) błysk mniejszy — nie zasłania pół ekranu
    size *= clamp(-mv.z / uNearSize, uFlashNearMin, 1.0);
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
uniform float uNearMin;
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
    float near = mix(uNearMin, 1.0, smoothstep(uNearFade.x, uNearFade.y, vDepth));
    col = (vec3(uCoreI) * core * (1.0 - vK) + vCol * glow * uGlowI) * fade * tail * near;
  } else {
    float r = length(vQ);
    if (r > 1.0) discard;
    float g = exp(-r * r * 6.0) * (1.0 - r);
    float hot = exp(-r * r * 30.0);
    float fade = (1.0 - vK) * (1.0 - vK);
    float I = vKind < 1.5 ? uMuzzleI : uEndI;
    col = (vCol * g + vec3(hot) * 0.6) * I * fade;
  }
  float fogF = exp(-fogDensity * fogDensity * vDepth * vDepth);
  gl_FragColor = vec4(col * fogF, 1.0);
}`;

// ------------------------------------------------------------------ iskry

const SPARK_VERT = /* glsl */`
attribute vec4 aSeed;      // losowy kierunek odłamka (jednostkowy) + czynnik 0..1 (prędkość, życie)
attribute vec4 aP;         // punkt zdarzenia xyz, w = siła (1 trafienie uczestnika, <1 ściana/odbicie)
attribute vec4 aN;         // kierunek wylotu (odbity od normalnej / ku strzelcowi) xyz, w = wysokość podłogi pod punktem
attribute vec4 aC;         // kolor rgb, w = czas startu
uniform float uTime;
uniform vec2 uLife;
uniform float uHitLife;
uniform float uFlashTime;
uniform float uFlashSize;
uniform vec2 uSpeed;
uniform float uSpread;
uniform float uGravity;
uniform float uRest;
uniform float uFric;
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
  float life = kind > 0.5 ? uFlashTime : mix(uLife.x, uLife.y, aSeed.w) * (pw > 0.99 ? uHitLife : 1.0);
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
    vec3 v0 = normalize(aN.xyz + aSeed.xyz * uSpread) * mix(uSpeed.x, uSpeed.y, aSeed.w);
    float g = uGravity;
    float h0 = max(aP.y - aN.w, 0.0);
    // pierwszy kontakt z podłogą: h0 + vy t − g t²/2 = 0
    float t1 = (v0.y + sqrt(v0.y * v0.y + 2.0 * g * h0)) / g;
    vec3 p;
    vec3 vel;
    if (age < t1) {
      p = aP.xyz + v0 * age + vec3(0.0, -0.5 * g * age * age, 0.0);
      vel = v0 + vec3(0.0, -g * age, 0.0);
    } else {
      // jedno słabe odbicie: pion × restitution, poziom × friction; potem leży na podłodze
      vec3 pb = aP.xyz + v0 * t1 + vec3(0.0, -0.5 * g * t1 * t1, 0.0);
      vec3 vb = vec3(v0.x * uFric, (g * t1 - v0.y) * uRest, v0.z * uFric);
      float tt = age - t1;
      p = pb + vb * tt + vec3(0.0, -0.5 * g * tt * tt, 0.0);
      vel = vb + vec3(0.0, -g * tt, 0.0);
      if (p.y < aN.w) { p.y = aN.w + 0.005; vel = vec3(vb.x, 0.0, vb.z) * 0.3; }
    }
    float sp = length(vel);
    vec3 vd = sp > 1e-4 ? vel / sp : vec3(0.0, 1.0, 0.0);
    vec3 P = p - vd * (max(sp, 0.6) * uStreak * (1.0 - position.x));
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
    col = (vCol * g + vec3(hot) * 0.8) * uFlashI * fade * vPow;
  } else {
    float a = abs(vQ.y);
    float across = (1.0 - a) * (1.0 - a);
    float head = sin(3.14159 * vQ.x) * (0.4 + 0.6 * vQ.x);
    vec3 c = mix(vec3(1.0, 0.95, 0.9), vCol, smoothstep(0.0, 0.35, vK));
    col = c * across * head * uSparkI * (1.0 - vK) * (1.0 - vK);
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
  const rows = [[0, 0], [FX.beamRows[0], 0], [FX.beamRows[1], 0], [FX.beamTaper, 0], [0, 1]];
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
  const aA = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
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
  const n = SH.count;
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
  const aN = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
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
    uWidth: { value: FX.beamWidth },
    uTaper: { value: FX.beamTaper },
    uTaperMin: { value: FX.beamTaperMin },
    uMuzzleSize: { value: FX.muzzleFlashSize },
    uMuzzleTime: { value: FX.muzzleFlashTime },
    uEndSize: { value: FX.endFlashSize },
    uNearSize: { value: FX.flashNearDist },
    uFlashNearMin: { value: FX.flashNearMin },
    uMuzzleGrow: { value: new THREE.Vector2(FX.muzzleFlashGrow[0], FX.muzzleFlashGrow[1]) },
    uEndGrow: { value: new THREE.Vector2(FX.endFlashGrow[0], FX.endFlashGrow[1]) },
    uNearMin: { value: FX.beamNearMin },
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
    uLife: { value: new THREE.Vector2(SH.life[0], SH.life[1]) },
    uHitLife: { value: SH.hitLife },
    uFlashTime: { value: FX.hitFlashTime },
    uFlashSize: { value: FX.hitFlashSize },
    uSpeed: { value: new THREE.Vector2(SH.speed[0], SH.speed[1]) },
    uSpread: { value: SH.spread },
    uGravity: { value: SH.gravity },
    uRest: { value: SH.restitution },
    uFric: { value: SH.friction },
    uStreak: { value: SH.streak },
    uSparkWidth: { value: SH.width },
    uSparkI: { value: SH.intensity },
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

  const A = new Float64Array(12);
  const DEF_DUR = CONFIG.weapon.beamDuration;

  function spawnSparks(r, g, b, power) {
    const i = sparkNext;
    sparkNext = (sparkNext + 1) % sparkCapacity;
    sP[i * 4] = SA[0]; sP[i * 4 + 1] = SA[1]; sP[i * 4 + 2] = SA[2]; sP[i * 4 + 3] = power;
    sN[i * 4] = SA[3]; sN[i * 4 + 1] = SA[4]; sN[i * 4 + 2] = SA[5]; sN[i * 4 + 3] = SA[6];
    sC[i * 4] = r; sC[i * 4 + 1] = g; sC[i * 4 + 2] = b; sC[i * 4 + 3] = time;
    sparkDirty = true;
  }
  // argumenty spawnSparks: punkt, kierunek wylotu, podłoga
  const SA = new Float64Array(7);

  /** Wiązka z argumentami w A (patrz nagłówek); odłamki: trafienie uczestnika → ku strzelcowi, ściana → odbicie od normalnej. */
  function shot(color, hit) {
    _c.setHex(hexNumber(color));
    const i = beamNext;
    beamNext = (beamNext + 1) % capacity;
    bA[i * 4] = A[0]; bA[i * 4 + 1] = A[1]; bA[i * 4 + 2] = A[2]; bA[i * 4 + 3] = A[11];
    bB[i * 4] = A[3]; bB[i * 4 + 1] = A[4]; bB[i * 4 + 2] = A[5]; bB[i * 4 + 3] = A[10];
    bC[i * 4] = _c.r; bC[i * 4 + 1] = _c.g; bC[i * 4 + 2] = _c.b; bC[i * 4 + 3] = time;
    beamDirty = true;
    let dx = A[3] - A[0], dy = A[4] - A[1], dz = A[5] - A[2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= len; dy /= len; dz /= len;
    SA[0] = A[3]; SA[1] = A[4]; SA[2] = A[5]; SA[6] = A[9];
    if (hit) {
      SA[3] = -dx; SA[4] = -dy; SA[5] = -dz;
      spawnSparks(_c.r, _c.g, _c.b, 1);
      return;
    }
    const nx = A[6], ny = A[7], nz = A[8];
    if (nx === 0 && ny === 0 && nz === 0) return;   // koniec zasięgu w powietrzu — bez odłamków
    const dn = dx * nx + dy * ny + dz * nz;
    SA[3] = dx - 2 * dn * nx; SA[4] = dy - 2 * dn * ny; SA[5] = dz - 2 * dn * nz;
    spawnSparks(_c.r, _c.g, _c.b, FX.wallPower);
  }

  /** Same odłamki (bez wiązki): A = [x,y,z, dx,dy,dz, floorY]. */
  function shards(color, power) {
    _c.setHex(hexNumber(color));
    for (let k = 0; k < 7; k++) SA[k] = A[k];
    spawnSparks(_c.r, _c.g, _c.b, power);
  }

  /** Zgodność wstecz: wiązka fazera bez normalnej (odłamki ku strzelcowi przy trafieniu). */
  function spawn(x, y, z, x2, y2, z2, color, hit) {
    A[0] = x; A[1] = y; A[2] = z; A[3] = x2; A[4] = y2; A[5] = z2;
    A[6] = 0; A[7] = 0; A[8] = 0; A[9] = 0; A[10] = 1; A[11] = DEF_DUR;
    shot(color, hit);
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

  return { spawn, shot, shards, A, update, dispose, meshes: [beamMesh, sparkMesh] };
}
