// Dym z wytwornicy (SPEC §4): miękkie, wolno dryfujące kłęby, łapiące kolor lamp.
// createSmoke(world, count, rng, opts?) → { mesh, update(dt, camera), dispose() }
//   rng: funkcja () → [0,1) albo obiekt { next() } (src/core/rng.js).
//   opts.texture: tekstura 'smoke' z textures.js (gdy brak — moduł tworzy własną i ją zwalnia).
//   opts.atmo: wspólne uniformy snopów ruchomych głowic (ceilingLights.js) — kłąb w snopie łapie jego kolor (D-040).
// Jeden draw call: InstancedMesh quadów; billboard, dryf i rotacja w vertex shaderze (zero pracy CPU w update).
// Mieszanie addytywne (dym rozprasza światło UV — w ciemnej scenie daje „świecącą mgiełkę", nigdy szarą zasłonę).
import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { createTextures } from './textures.js';
import { lightColorHex, lampPosition, paletteFor, darkNormFor } from './arenaBuilder.js';
import { MAX_SPOTS } from './ceilingLights.js';

const SM = CONFIG.smoke;
const MAX_LIGHTS = SM.maxLights;
const MH = CONFIG.render.movingHeads;

const VERT = /* glsl */`
attribute vec4 aParams;   // x faza, y prędkość obrotu (rad/s, ze znakiem), z rozmiar, w mieszanie odcienia
uniform float time;
uniform float driftRadius;
uniform float driftSpeed;
uniform vec3 tintA;
uniform vec3 tintB;
uniform float baseGlow;
uniform vec3 lightPos[${MAX_LIGHTS}];
uniform vec3 lightCol[${MAX_LIGHTS}];
uniform float lightRange[${MAX_LIGHTS}];
uniform int lightCount;
uniform vec4 spotPos[${MAX_SPOTS}];   // snopy głowic: xyz początek, w długość
uniform vec4 spotDir[${MAX_SPOTS}];   // xyz kierunek, w cos kąta połówkowego
uniform vec3 spotCol[${MAX_SPOTS}];
uniform int spotCount;
uniform float beamGain;
varying vec2 vUv;
varying vec3 vColor;
varying vec3 vBeam;
varying float vDepth;
varying float vCenterDepth;
varying float vWorldY;
varying float vAlpha;
void main() {
  float ph = aParams.x;
  float driftR = instanceMatrix[0][0];   // amplituda dryfu per kłąb (ograniczona prześwitem)
  vec3 base = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float w = driftSpeed / driftRadius;
  vec3 pos = base + vec3(
    sin(time * w + ph * 6.2831) * driftR,
    sin(time * w * 0.63 + ph * 11.0) * 0.22,
    cos(time * w * 0.81 + ph * 4.7) * driftR);
  // kolor: odcień palety + światło lamp w pobliżu (dym „łapie" kolor)
  vec3 col = mix(tintA, tintB, aParams.w * 0.5) * baseGlow * instanceMatrix[0][1];
  vAlpha = instanceMatrix[2][2];
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= lightCount) break;
    float d = distance(pos, lightPos[i]);
    float k = 1.0 - smoothstep(0.0, lightRange[i], d);
    col += lightCol[i] * k * k;
  }
  vColor = col;
  // snopy ruchomych głowic: odległość środka kłębu od osi snopu (do przeszkody) → kolor snopu (snop „rysuje się" w dymie)
  float size0 = aParams.z;
  vec3 bc = vec3(0.0);
  for (int i = 0; i < ${MAX_SPOTS}; i++) {
    if (i >= spotCount) break;
    vec3 v = pos - spotPos[i].xyz;
    float t = clamp(dot(v, spotDir[i].xyz), 0.0, spotPos[i].w);
    float perp = length(v - spotDir[i].xyz * t);
    float co = spotDir[i].w;
    float r = sqrt(max(1.0 - co * co, 0.0)) / co * t + size0 * ${MH.smokeWidth.toFixed(3)};
    float k = 1.0 - smoothstep(r * 0.4, r + size0 * 0.25, perp);
    bc += spotCol[i] * k * k / (1.0 + t * ${MH.beamFalloff.toFixed(3)});
  }
  vBeam = bc * beamGain;
  vec4 mvC = modelViewMatrix * vec4(pos, 1.0);
  vCenterDepth = -mvC.z;
  float size = aParams.z * (1.0 + 0.08 * sin(time * 0.11 + ph * 9.0));
  float a = (ph - 0.5) * ${SM.tilt.toFixed(3)} + sin(time * aParams.y + ph * 6.0) * ${(SM.tilt * 0.5).toFixed(3)};
  float aspect = instanceMatrix[1][1];   // poziome smugi: szerokość / wysokość
  float c = cos(a), s = sin(a);
  vec2 q = vec2(position.x * aspect, position.y);
  vec2 p = vec2(c * q.x - s * q.y, s * q.x + c * q.y) * size;
  vec4 mv = mvC + vec4(p, 0.0, 0.0);
  vDepth = -mv.z;
  // wysokość narożnika billboardu w świecie (oś „góra" kamery) → zanik przy podłodze/suficie (brak twardych cięć)
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vWorldY = pos.y + camRight.y * p.x + camUp.y * p.y;
  vUv = uv;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */`
uniform sampler2D map;
uniform float opacity;
uniform vec2 nearFade;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec2 vUv;
varying vec3 vColor;
varying float vDepth;
varying float vCenterDepth;
varying float vWorldY;
uniform float ceilY;
uniform float planeFade;
varying float vAlpha;
varying vec3 vBeam;
uniform vec3 hiFade;   // x..y: wysokość przejścia (m), z: jasność powyżej
void main() {
  float d = texture2D(map, vUv).r;
  d *= smoothstep(0.0, planeFade, vWorldY) * smoothstep(0.0, planeFade, ceilY - vWorldY);
  // zanik przy kamerze: po środku kłębu i po fragmencie (żadnych „ścian" przed twarzą)
  float near = smoothstep(nearFade.x, nearFade.y, vCenterDepth) * smoothstep(0.3, nearFade.x + 0.6, vDepth);
  float fogF = exp(-fogDensity * fogDensity * vDepth * vDepth);
  float a = d * opacity * vAlpha * near * fogF;
  // powyżej wysokości ścian: ciemniej i bez koloru (brak barwnej „zupy" pod sufitem)
  float hi = smoothstep(hiFade.x, hiFade.y, vWorldY);
  vec3 col = mix(vColor, vec3(dot(vColor, vec3(0.2126, 0.7152, 0.0722))) * hiFade.z, hi) + vBeam;
  gl_FragColor = vec4(col * a, 1.0);
}`;

export function createSmoke(world, count, rng, opts = {}) {
  if (!count) return { mesh: null, update() {}, dispose() {} };
  const rnd = typeof rng === 'function' ? rng : () => rng.next();

  let ownTextures = null;
  let texture = opts.texture;
  if (!texture) {
    ownTextures = createTextures({ size: 256, anisotropy: 1, palette: world.palette, seed: world.seed >>> 0 });
    texture = ownTextures.get('smoke');
  }

  count = Math.round(count * (SM.countMap[world.id] ?? 1));
  const atmo = opts.atmo || null;
  const geo = new THREE.PlaneGeometry(1, 1);
  const params = new Float32Array(count * 4);
  const pal = world.palette;
  const lights = (world.lights || []).slice(0, MAX_LIGHTS);
  const lightPos = [], lightCol = [], lightRange = [];
  for (let i = 0; i < MAX_LIGHTS; i++) {
    const L = lights[i];
    const lp = L ? lampPosition(world, L) : null;
    lightPos.push(L ? new THREE.Vector3(lp.x, L.y - SM.lightDrop, lp.z) : new THREE.Vector3());
    lightCol.push(L ? new THREE.Color(lightColorHex(world, L.color)).multiplyScalar(SM.lightGain * (SM.lightGainMap[world.id] ?? 1)) : new THREE.Color(0, 0, 0));
    lightRange.push(L ? (L.range || CONFIG.render.lights.defaultRange) * SM.lightRangeScale : 1);
  }

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      map: { value: texture },
      time: { value: 0 },
      opacity: { value: SM.opacity },
      driftRadius: { value: SM.driftRadius },
      driftSpeed: { value: SM.drift },
      // chłodna, ciemna mgiełka (uv palety + mgła); kolor dają głównie lampy
      tintA: { value: new THREE.Color(paletteFor(world).uv).lerp(new THREE.Color(pal.fog), SM.fogMix) },
      tintB: { value: new THREE.Color(paletteFor(world).uv) },
      baseGlow: { value: SM.baseGlow * darkNormFor(world) },
      lightPos: { value: lightPos },
      lightCol: { value: lightCol },
      lightRange: { value: lightRange },
      lightCount: { value: lights.length },
      nearFade: { value: new THREE.Vector2(SM.nearFade[0], SM.nearFade[1]) },
      ceilY: { value: world.ceiling },
      planeFade: { value: SM.planeFade },
      hiFade: { value: new THREE.Vector3(SM.hiFade[0], SM.hiFade[1], SM.hiFade[2]) },
      // snopy: wspólne obiekty uniformów (wartości zmienia ceilingLights.update); bez głowic — spotCount 0
      spotPos: atmo ? atmo.spotPos : { value: emptyV4() },
      spotDir: atmo ? atmo.spotDir : { value: emptyV4() },
      spotCol: atmo ? atmo.spotCol : { value: emptyV3() },
      spotCount: atmo ? atmo.spotCount : { value: 0 },
      beamGain: { value: MH.smokeGain * (SM.beamGainMap[world.id] ?? 1) },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: true,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'smoke';
  mesh.frustumCulled = false; // pozycje przesuwane w shaderze
  mesh.renderOrder = 3;
  const b = world.bounds;
  const m = SM.margin;
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    // dwie warstwy: nisko nad podłogą (większe płachty) i pod sufitem (wokół lamp); trochę pomiędzy
    const r0 = rnd();
    // warstwy: przyziemna (płachty), środkowa na wysokości oka/listew (kłęby bliższe kuli — widoczny dym w powietrzu),
    // podsufitowa (opcjonalna), reszta losowo w [heightMin, heightMax]
    const band = r0 < SM.lowShare ? SM.lowBand
      : r0 < SM.lowShare + SM.midShare ? SM.midBand
        : r0 < SM.lowShare + SM.midShare + SM.highShare ? SM.highBand : [SM.heightMin, SM.heightMax];
    const top = Math.min(band === SM.highBand ? world.ceiling - SM.highCeilGap : band[1], world.ceiling - 0.45);
    const layer = rnd();
    const y = band[0] + layer * Math.max(0, top - band[0]);
    // środek kłębu w wolnej przestrzeni (nie w bryle) — inaczej marnuje się w ścianie
    let x = 0, z = 0;
    for (let tries = 0; tries < 24; tries++) {
      x = b.minX + m + rnd() * (b.maxX - b.minX - 2 * m);
      z = b.minZ + m + rnd() * (b.maxZ - b.minZ - 2 * m);
      if (!insideAnySolid(world, x, y, z, SM.wallClearance)) break;
    }
    mtx.makeTranslation(x, y, z);
    params[i * 4] = rnd();
    params[i * 4 + 1] = (rnd() - 0.5) * 2 * SM.spin;
    let size = SM.sizeMin + (SM.sizeMax - SM.sizeMin) * (band === SM.lowBand ? 1 : band === SM.midBand ? SM.midSize : 0.7) * (0.6 + 0.4 * rnd());
    // prześwit do ścian: kłąb (z dryfem) nie może przecinać brył — inaczej widać prostą krawędź billboardu
    const clear = clearanceXZ(world, x, z, y);
    const amp = Math.min(SM.driftRadius, Math.max(0, clear - SM.wallClearance) * 0.5);
    const asp = band === SM.midBand ? SM.midAspect : SM.aspect;
    const aspect = asp[0] + (asp[1] - asp[0]) * rnd();
    // szerokość smugi (size × aspect) ograniczona prześwitem
    size = Math.min(size, Math.max(SM.sizeFloor, (clear - amp) * SM.sizePerClearance) / aspect);
    mtx.elements[0] = amp;    // amplituda dryfu w instanceMatrix[0][0] (translacja w [3])
    mtx.elements[5] = aspect; // proporcje smugi w [1][1]
    const mid = band === SM.midBand;
    mtx.elements[10] = mid ? SM.midOpacity : band === SM.lowBand ? SM.lowOpacity : band === SM.highBand ? SM.highOpacity : 1;   // mnożnik krycia w [2][2]
    mtx.elements[1] = mid ? SM.midGlow : 1;       // mnożnik jasności bazowej w [0][1]
    mesh.setMatrixAt(i, mtx);
    params[i * 4 + 2] = size;
    params[i * 4 + 3] = rnd();
  }
  geo.setAttribute('aParams', new THREE.InstancedBufferAttribute(params, 4));
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,
    update(dt) {
      mat.uniforms.time.value += dt;
    },
    dispose() {
      if (mesh.parent) mesh.parent.remove(mesh);
      geo.dispose();
      mat.dispose();
      mesh.dispose();
      if (ownTextures) ownTextures.disposeAll();
    },
  };
}

function emptyV4() { const a = []; for (let i = 0; i < MAX_SPOTS; i++) a.push(new THREE.Vector4()); return a; }
function emptyV3() { const a = []; for (let i = 0; i < MAX_SPOTS; i++) a.push(new THREE.Vector3()); return a; }

function insideAnySolid(world, x, y, z, margin) {
  for (const s of world.solids) {
    if (y < s.y0 - margin || y > s.y1 + margin) continue;
    const dx = x - s.cx, dz = z - s.cz;
    const lx = dx * s.cos - dz * s.sin, lz = dx * s.sin + dz * s.cos;
    if (Math.abs(lx) < s.hx + margin && Math.abs(lz) < s.hz + margin) return true;
  }
  return false;
}

// odległość w XZ od (x,z) do najbliższej bryły obejmującej wysokość y (i do granic areny)
function clearanceXZ(world, x, z, y) {
  const b = world.bounds;
  let best = Math.min(x - b.minX, b.maxX - x, z - b.minZ, b.maxZ - z);
  for (const s of world.solids) {
    if (y < s.y0 - 1.0 || y > s.y1 + 1.0) continue;
    const dx = x - s.cx, dz = z - s.cz;
    const lx = Math.abs(dx * s.cos - dz * s.sin) - s.hx, lz = Math.abs(dx * s.sin + dz * s.cos) - s.hz;
    const d = Math.hypot(Math.max(lx, 0), Math.max(lz, 0));
    if (d < best) best = d;
  }
  return best;
}
