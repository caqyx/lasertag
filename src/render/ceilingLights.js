// Ruchome głowice pod kratownicą sufitu (reflektory/skanery jak w klubie laser tag) — D-038.
// createAtmoUniforms() → wspólne uniformy snopów (pozycja/kierunek/kolor), czytane przez:
//   • podłogę i ściany (arenaBuilder: plamy światła z gobo; injectSpots),
//   • dym (smoke.js: kłęby przecinane snopem łapią jego kolor).
// createCeilingLights(world, preset, atmo) → { group, update(time), dispose() }
//   2 draw calle: głowice (InstancedMesh: uchwyt statyczny, jarzmo pan, głowa tilt — obrót w vertex shaderze)
//   + snopy (InstancedMesh stożków addytywnych, długość = raycast do pierwszej przeszkody).
//   Oba na warstwie LAYER_NO_REFLECT (jak stożki lamp i kratownica) — nie podwajają kosztu odbicia planarnego;
//   plamy na podłodze/ścianach są w shaderach powierzchni, więc ściany w odbiciu i tak je pokazują.
// Animacja deterministyczna z czasu (pan/tilt = f(t)); update bez alokacji (bufory Float32Array, RAYARG — D-012).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';
import { segmentClear } from '../world/physics.js';
import { lightColorHex, lampPosition, LAYER_NO_REFLECT } from './arenaBuilder.js';

const H = CONFIG.render.movingHeads;
const A = CONFIG.render.arena;
export const MAX_SPOTS = H.maxHeads;

/** Wspólne uniformy snopów (wartości aktualizuje createCeilingLights.update). */
export function createAtmoUniforms() {
  const pos = [], dir = [], col = [];
  for (let i = 0; i < MAX_SPOTS; i++) { pos.push(new THREE.Vector4()); dir.push(new THREE.Vector4(0, -1, 0, 1)); col.push(new THREE.Vector3()); }
  return {
    spotPos: { value: pos },     // xyz: początek snopu (soczewka), w: długość do przeszkody (m)
    spotDir: { value: dir },     // xyz: kierunek (jednostkowy), w: cos kąta połówkowego
    spotCol: { value: col },     // kolor liniowy (× jasność głowicy)
    spotCount: { value: 0 },
    spotSurf: { value: 0 },      // mnożnik plam na powierzchniach (0 = bez plam, np. Low)
  };
}

// ------------------------------------------------------------ fragmenty GLSL dla powierzchni (onBeforeCompile)

/** Deklaracje dla fragment shadera MeshStandardMaterial (po #include <common>). */
export const SPOT_FRAG_DECL = /* glsl */`
uniform vec4 spotPos[ ${MAX_SPOTS} ];
uniform vec4 spotDir[ ${MAX_SPOTS} ];
uniform vec3 spotCol[ ${MAX_SPOTS} ];
uniform int spotCount;
uniform float spotSurf;
varying vec3 vSpotW;
// plama snopu na powierzchni: kąt od osi (miękka krawędź) × gobo (jaśniejszy pierścień) × zasięg do przeszkody
vec3 spotLight( float k ) {
  vec3 acc = vec3( 0.0 );
  for ( int i = 0; i < ${MAX_SPOTS}; i ++ ) {
    if ( i >= spotCount ) break;
    vec3 w = vSpotW - spotPos[ i ].xyz;
    float dist = length( w );
    float c = dot( w, spotDir[ i ].xyz ) / max( dist, 1e-3 );
    float co = spotDir[ i ].w;
    if ( c <= co ) continue;
    // r: 0 na osi, 1 na krawędzi stożka (tan kąta / tan kąta połówkowego)
    float tanA = sqrt( max( 1.0 - c * c, 0.0 ) ) / c;
    float tanO = sqrt( max( 1.0 - co * co, 0.0 ) ) / co;
    float r = tanA / tanO;
    float edge = 1.0 - smoothstep( ${H.spotEdge.toFixed(3)}, 1.0, r );
    float gobo = ${H.goboBase.toFixed(3)} + ${(1 - H.goboBase).toFixed(3)} * smoothstep( ${H.goboRing[0].toFixed(3)}, ${H.goboRing[1].toFixed(3)}, r );
    // tylko do pierwszej przeszkody (brak plam za ścianą, w którą trafił snop)
    float reach = 1.0 - smoothstep( spotPos[ i ].w + ${H.spotSlack[0].toFixed(3)}, spotPos[ i ].w + ${H.spotSlack[1].toFixed(3)}, dist );
    float att = ${H.spotRef.toFixed(2)} / max( dist, ${H.spotRef.toFixed(2)} );
    acc += spotCol[ i ] * edge * gobo * reach * att;
  }
  return acc * k * spotSurf;
}`;
export const SPOT_VERT_DECL = 'varying vec3 vSpotW;';
export const SPOT_VERT_MAIN = 'vSpotW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;';

/** Podpina uniformy snopów do shadera (sh z onBeforeCompile). */
export function bindSpotUniforms(sh, atmo) {
  sh.uniforms.spotPos = atmo.spotPos;
  sh.uniforms.spotDir = atmo.spotDir;
  sh.uniforms.spotCol = atmo.spotCol;
  sh.uniforms.spotCount = atmo.spotCount;
  sh.uniforms.spotSurf = atmo.spotSurf;
}

// ------------------------------------------------------------ głowice

const HEAD_VERT = /* glsl */`
attribute float aPart;      // 0 uchwyt (statyczny), 1 jarzmo (pan), 2 głowa (pan + tilt)
attribute float aEmit;      // 1 soczewka
attribute vec2 aAim;        // per instancja: pan, tilt (rad)
attribute vec3 aColor;      // per instancja: kolor soczewki
uniform vec2 pivots;        // x: y osi jarzma, y: y osi tilt (lokalnie, względem punktu montażu)
varying vec3 vCol;
varying float vEmit;
varying float vShade;
varying float vFogDepth;
vec3 rotX( vec3 p, float a ) { float c = cos( a ), s = sin( a ); return vec3( p.x, p.y * c - p.z * s, p.y * s + p.z * c ); }
vec3 rotY( vec3 p, float a ) { float c = cos( a ), s = sin( a ); return vec3( p.x * c + p.z * s, p.y, -p.x * s + p.z * c ); }
void main() {
  vec3 p = position;
  vec3 n = normal;
  if ( aPart > 1.5 ) { p.y -= pivots.y; p = rotX( p, aAim.y ); n = rotX( n, aAim.y ); p.y += pivots.y; }
  if ( aPart > 0.5 ) { p.y -= pivots.x; p = rotY( p, aAim.x ); n = rotY( n, aAim.x ); p.y += pivots.x; }
  vec4 wp = vec4( instanceMatrix[3].xyz + p, 1.0 );
  vec4 mv = viewMatrix * wp;
  vCol = aColor;
  vEmit = aEmit;
  vShade = 0.55 + 0.45 * clamp( n.y * 0.5 + 0.5, 0.0, 1.0 );
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const HEAD_FRAG = /* glsl */`
uniform vec3 bodyColor;
uniform float lensK;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec3 vCol;
varying float vEmit;
varying float vShade;
varying float vFogDepth;
void main() {
  // korpus: ciemny metal z lekkim odbłyskiem koloru soczewki (sylwetka czytelna pod stropem)
  vec3 c = mix( bodyColor * vShade + vCol * ${H.bodyTint.toFixed(3)} * vShade, vCol * lensK, vEmit );
  float fogF = 1.0 - exp( -fogDensity * fogDensity * vFogDepth * vFogDepth );
  c = mix( c, fogColor, fogF * ( 1.0 - vEmit * ${H.lensFogKeep.toFixed(2)} ) );
  gl_FragColor = vec4( c, 1.0 );
}`;

// ------------------------------------------------------------ snopy

const BEAM_VERT = /* glsl */`
attribute vec4 aHead;   // xyz początek, w długość
attribute vec4 aDir;    // xyz kierunek, w tan kąta połówkowego
attribute vec3 aColor;
uniform float r0;
varying vec3 vColor;
varying float vT;
varying float vLen;
varying vec3 vN;
varying vec3 vV;
varying vec3 vWP;
varying float vFogDepth;
void main() {
  vec3 d = aDir.xyz;
  vec3 up = abs( d.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
  vec3 rt = normalize( cross( d, up ) );
  vec3 fw = cross( rt, d );
  float t = -position.y;                       // 0 przy soczewce, 1 na końcu
  float len = aHead.w;
  float r = r0 + aDir.w * t * len;
  vec3 radial = rt * position.x + fw * position.z;
  vec3 wp = aHead.xyz + d * ( t * len ) + radial * r;
  vec4 mv = viewMatrix * vec4( wp, 1.0 );
  vColor = aColor;
  vT = t;
  vLen = len;
  vN = normalize( ( viewMatrix * vec4( radial, 0.0 ) ).xyz );
  vV = normalize( -mv.xyz );
  vWP = wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const BEAM_FRAG = /* glsl */`
uniform float opacity;
uniform float time;
uniform vec3 fogColor;
uniform float fogDensity;
varying vec3 vColor;
varying float vT;
varying float vLen;
varying vec3 vN;
varying vec3 vV;
varying vec3 vWP;
varying float vFogDepth;
void main() {
  float facing = clamp( abs( dot( vN, vV ) ), 0.0, 1.0 );
  float edge = pow( smoothstep( ${H.beamEdge[0].toFixed(2)}, ${H.beamEdge[1].toFixed(2)}, facing ), ${H.beamEdgePow.toFixed(1)} );
  // jasno przy soczewce, słabiej dalej (rozpraszanie w dymie); miękki początek i koniec
  float dist = vT * vLen;
  float fall = 1.0 / ( 1.0 + dist * ${H.beamFalloff.toFixed(3)} );
  fall *= smoothstep( 0.0, ${H.beamStart.toFixed(2)}, dist );
  // ostatnie beamEndFade m przygaszone (miękkie wejście w powierzchnię — plamę rysuje shader powierzchni)
  fall *= 1.0 - smoothstep( vLen - ${H.beamEndFade.toFixed(2)}, vLen, dist ) * ${H.beamEndDim.toFixed(2)};
  // pasma dymu płynące wzdłuż snopu (snop „w dymie", nie lita rura)
  float n = sin( vWP.y * 2.7 - time * 0.6 + sin( vWP.x * 1.9 + vWP.z * 1.4 + time * 0.3 ) * 2.0 );
  n = ${(1 - H.beamNoise).toFixed(2)} + ${H.beamNoise.toFixed(2)} * ( 0.5 + 0.5 * n * sin( vWP.x * 0.8 - vWP.z * 1.1 + time * 0.2 ) );
  float near = smoothstep( ${H.beamNear[0].toFixed(2)}, ${H.beamNear[1].toFixed(2)}, vFogDepth );
  float fogF = exp( -fogDensity * fogDensity * vFogDepth * vFogDepth * ${H.beamFog.toFixed(2)} );
  float a = opacity * edge * fall * n * near * fogF;
  gl_FragColor = vec4( vColor * a, 1.0 );
}`;

// ------------------------------------------------------------ długość snopu (własny raycast bez alokacji)
// raycastWorld z physics.js alokował ~3–4 B/promień przy promieniach w dół (pomiar v8.GCProfiler) — tu prosty test
// promień–OBB po wszystkich bryłach + powierzchnie ramp + podłoga; argumenty i wynik w Float64Array (D-012).
const RB = new Float64Array(8);
const NO_RAMPS = [];   // ox, oy, oz, dx, dy, dz, max → [7] wynik

function beamLength(world) {
  const ox = RB[0], oy = RB[1], oz = RB[2], dx = RB[3], dy = RB[4], dz = RB[5];
  let best = RB[6];
  if (dy < -1e-6) { const t = -oy / dy; if (t < best) best = t; }
  const solids = world.solids;
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    if (s.seeThrough === true) continue;
    const rx = ox - s.cx, rz = oz - s.cz, c = s.cos, sn = s.sin;
    const lox = rx * c - rz * sn, loz = rx * sn + rz * c;
    const ldx = dx * c - dz * sn, ldz = dx * sn + dz * c;
    let t0 = 0, t1 = best;
    if (ldx > -1e-6 && ldx < 1e-6) { if (lox < -s.hx || lox > s.hx) continue; } else {
      let a = (-s.hx - lox) / ldx, b = (s.hx - lox) / ldx;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
    }
    if (dy > -1e-6 && dy < 1e-6) { if (oy < s.y0 || oy > s.y1) continue; } else {
      let a = (s.y0 - oy) / dy, b = (s.y1 - oy) / dy;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
    }
    if (ldz > -1e-6 && ldz < 1e-6) { if (loz < -s.hz || loz > s.hz) continue; } else {
      let a = (-s.hz - loz) / ldz, b = (s.hz - loz) / ldz;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) continue;
    }
    if (t0 < best) best = t0;
  }
  // rampy: płaszczyzna y = y0 + k·(lz + hz) w obrysie |lx| ≤ hx, |lz| ≤ hz
  const ramps = world.ramps || NO_RAMPS;
  for (let i = 0; i < ramps.length; i++) {
    const r = ramps[i];
    const rx = ox - r.cx, rz = oz - r.cz, c = r.cos, sn = r.sin;
    const lox = rx * c - rz * sn, loz = rx * sn + rz * c;
    const ldx = dx * c - dz * sn, ldz = dx * sn + dz * c;
    const k = (r.y1 - r.y0) / (2 * r.hz);
    const den = dy - k * ldz;
    if (den > -1e-6 && den < 1e-6) continue;
    const t = (r.y0 + k * (loz + r.hz) - oy) / den;
    if (t <= 0 || t >= best) continue;
    const px = lox + ldx * t, pz = loz + ldz * t;
    if (px >= -r.hx && px <= r.hx && pz >= -r.hz && pz <= r.hz) best = t;
  }
  RB[7] = best;
}

// ------------------------------------------------------------ rozmieszczenie

function trussRows(world) {
  const b = world.bounds;
  const rows = [];
  for (let z = b.minZ + A.trussSpacing; z < b.maxZ - A.trussEdge; z += A.trussSpacing) rows.push(z);
  return rows;
}

/** Kandydaci pod pasem dolnym dźwigarów: z dala od lamp/świetlówek, nad wolną przestrzenią, wewnątrz hali. */
export function placeHeads(world, count, mountY, lensY) {
  const b = world.bounds;
  const U = { ...A.uvTube, ...(A.uvTubeMap[world.id] || {}) };
  const rows = trussRows(world);
  const lamps = (world.lights || []).map((L) => lampPosition(world, L));
  const refs = world.spawns.map((s) => [s.x, s.z]);
  refs.push([(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2]);
  const cands = [];
  rows.forEach((z, ri) => {
    const off = (ri % 2) * H.spacing / 2;
    for (let x = b.minX + H.edge + off; x <= b.maxX - H.edge; x += H.spacing) {
      if (z < b.minZ + H.edge || z > b.maxZ - H.edge) continue;
      let bad = false;
      for (const L of lamps) if (Math.abs(L.x - x) < H.lampClear[0] && Math.abs(L.z - z) < H.lampClear[1]) bad = true;
      // świetlówki UV: ten sam rytm co w arenaBuilder (oprawa pod osią dźwigara)
      for (let tx = b.minX + U.spacing / 2; tx < b.maxX - U.length / 2; tx += U.spacing) {
        if (Math.abs(tx - x) < U.length / 2 + H.tubeClear) bad = true;
      }
      // nad bryłą sięgającą pod strop (filar, rdzeń) — snop nie miałby miejsca
      for (const s of world.solids) {
        if (s.y1 < lensY - H.tallClear) continue;
        const dx = x - s.cx, dz = z - s.cz;
        if (Math.abs(dx * s.cos - dz * s.sin) < s.hx + H.solidClear && Math.abs(dx * s.sin + dz * s.cos) < s.hz + H.solidClear) bad = true;
      }
      if (bad) continue;
      // wewnątrz hali: widać stąd (na wysokości soczewki) spawn albo środek — poza obrysem (np. narożniki plastra) odpada
      let inside = false;
      for (const r of refs) if (segmentClear(world, x, lensY, z, r[0], lensY, r[1])) { inside = true; break; }
      if (inside) cands.push({ x, z });
    }
  });
  // równomierny wybór: najdalszy punkt od już wybranych (deterministyczny start: najbliżej środka)
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const out = [];
  if (!cands.length || count <= 0) return out;
  let first = 0, bd = Infinity;
  cands.forEach((c, i) => { const d = Math.hypot(c.x - cx, c.z - cz); if (d < bd) { bd = d; first = i; } });
  out.push(cands[first]);
  while (out.length < Math.min(count, cands.length)) {
    let best = -1, bestD = -Infinity;
    cands.forEach((c, i) => {
      let m = Infinity;
      for (const o of out) m = Math.min(m, Math.hypot(c.x - o.x, c.z - o.z));
      if (m < H.minGap) return;
      // najdalej od wybranych, z lekką preferencją środka hali (snopy nad placami, nie w narożnikach obwodu)
      const score = m - H.centerBias * Math.hypot(c.x - cx, c.z - cz);
      if (score > bestD) { bestD = score; best = i; }
    });
    if (best < 0) break;
    out.push(cands[best]);
  }
  return out;
}

function headGeometry() {
  const G = H.geo;
  const parts = [];
  const add = (geo, part, emit) => {
    const n = geo.attributes.position.count;
    geo.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(n).fill(part), 1));
    geo.setAttribute('aEmit', new THREE.BufferAttribute(new Float32Array(n).fill(emit), 1));
    geo.deleteAttribute('uv');
    parts.push(geo);
  };
  // uchwyt: obejma na pasie dźwigara + trzpień
  add(new THREE.BoxGeometry(G.clamp[0], G.clamp[1], G.clamp[2]).translate(0, -G.clamp[1] / 2, 0), 0, 0);
  add(new THREE.CylinderGeometry(G.rod, G.rod, G.rodLen, 8).translate(0, -G.clamp[1] - G.rodLen / 2, 0), 0, 0);
  const yokeY = -G.clamp[1] - G.rodLen;
  // jarzmo (obraca się w poziomie): belka + 2 ramiona
  add(new THREE.BoxGeometry(G.yokeW, G.yokeT, G.yokeD).translate(0, yokeY - G.yokeT / 2, 0), 1, 0);
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(G.yokeT, G.armLen, G.yokeD).translate(sx * (G.yokeW - G.yokeT) / 2, yokeY - G.yokeT - G.armLen / 2, 0), 1, 0);
  const tiltY = yokeY - G.yokeT - G.armLen + G.yokeD / 2;
  // głowa (tilt): walec wzdłuż osi snopu (w dół przy tilt=0) + soczewka
  add(new THREE.CylinderGeometry(G.headR, G.headR * 1.1, G.headLen, 14).translate(0, tiltY - G.headLen * 0.3, 0), 2, 0);
  add(new THREE.CircleGeometry(G.lensR, 14).rotateX(Math.PI / 2).translate(0, tiltY - G.headLen * 0.8 - 0.002, 0), 2, 1);
  return { parts, yokeY, tiltY, lensOff: G.headLen * 0.8 };
}

export function createCeilingLights(world, preset, atmo) {
  const n0 = Math.min(preset.heads | 0, MAX_SPOTS);
  if (!n0) { atmo.spotCount.value = 0; return { group: null, update() {}, dispose() {} }; }
  const group = new THREE.Group();
  group.name = 'movingHeads';
  const yBot = world.ceiling - A.trussDrop - A.trussDepth;
  const mountY = yBot - A.trussChord / 2;
  const hg = headGeometry();
  const lensY = mountY + hg.tiltY;
  const spots = placeHeads(world, n0, mountY, lensY);
  const n = spots.length;
  atmo.spotCount.value = 0;
  if (!n) { for (const g of hg.parts) g.dispose(); return { group: null, update() {}, dispose() {} }; }

  // kolory z palety (bez akcentu — D-008): klucze per mapa, przez lightColorHex (remapy lamp)
  const keys = H.colorsMap[world.id] || H.colors;
  const pal = world.palette;
  const cols = [];
  const hd = new Float32Array(n * 4);   // per głowica: faza, kierunek obrotu, tryb (0 omiatanie, 1 krąg), baza pan
  for (let i = 0; i < n; i++) {
    const c = new THREE.Color(lightColorHex(world, pal[keys[i % keys.length]]));
    cols.push(c);
    hd[i * 4] = (i * H.phaseStep) % (Math.PI * 2);
    hd[i * 4 + 1] = i % 2 ? -1 : 1;
    hd[i * 4 + 2] = (i % 3 === 2) ? 1 : 0;
    // omiatanie skierowane do środka hali (snopy nie wiszą przy ścianach obwodowych)
    const b = world.bounds;
    const dx = (b.minX + b.maxX) / 2 - spots[i].x, dz = (b.minZ + b.maxZ) / 2 - spots[i].z;
    hd[i * 4 + 3] = Math.atan2(-dx, -dz);   // pan, przy którym kierunek (−sin p, ·, −cos p) celuje do środka
  }

  // --- głowice: 1 draw call
  const geo = mergeGeometries(hg.parts);
  for (const g of hg.parts) g.dispose();
  const aim = new Float32Array(n * 2);
  const colArr = new Float32Array(n * 3);
  cols.forEach((c, i) => { colArr[i * 3] = c.r; colArr[i * 3 + 1] = c.g; colArr[i * 3 + 2] = c.b; });
  const aimAttr = new THREE.InstancedBufferAttribute(aim, 2);
  aimAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAim', aimAttr);
  geo.setAttribute('aColor', new THREE.InstancedBufferAttribute(colArr, 3));
  const headMat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      pivots: { value: new THREE.Vector2(hg.yokeY, hg.tiltY) },
      bodyColor: { value: new THREE.Color(H.bodyColor) },
      lensK: { value: H.lensIntensity },
    },
    vertexShader: HEAD_VERT, fragmentShader: HEAD_FRAG, fog: true,
  });
  const heads = new THREE.InstancedMesh(geo, headMat, n);
  heads.name = 'movingHeads:body';
  heads.frustumCulled = false;
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < n; i++) { m4.makeTranslation(spots[i].x, mountY, spots[i].z); heads.setMatrixAt(i, m4); }
  heads.instanceMatrix.needsUpdate = true;
  heads.layers.set(LAYER_NO_REFLECT);
  group.add(heads);

  // --- snopy: 1 draw call
  const bgeo = new THREE.CylinderGeometry(1, 1, 1, H.beamSegments, H.beamRows, true).translate(0, -0.5, 0);
  bgeo.deleteAttribute('uv');
  const bHead = new Float32Array(n * 4), bDir = new Float32Array(n * 4), bCol = new Float32Array(n * 3);
  const beamK = H.beamIntensity * (H.beamIntensityMap[world.id] ?? 1);
  cols.forEach((c, i) => { bCol[i * 3] = c.r * beamK; bCol[i * 3 + 1] = c.g * beamK; bCol[i * 3 + 2] = c.b * beamK; });
  const headAttr = new THREE.InstancedBufferAttribute(bHead, 4); headAttr.setUsage(THREE.DynamicDrawUsage);
  const dirAttr = new THREE.InstancedBufferAttribute(bDir, 4); dirAttr.setUsage(THREE.DynamicDrawUsage);
  bgeo.setAttribute('aHead', headAttr);
  bgeo.setAttribute('aDir', dirAttr);
  bgeo.setAttribute('aColor', new THREE.InstancedBufferAttribute(bCol, 3));
  const beamMat = new THREE.ShaderMaterial({
    uniforms: {
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      opacity: { value: H.beamOpacity * (preset.smoke > 0 ? 1 : H.beamNoSmoke) },
      time: { value: 0 },
      r0: { value: H.geo.lensR },
    },
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, fog: true,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const beams = new THREE.InstancedMesh(bgeo, beamMat, n);
  beams.name = 'movingHeads:beams';
  beams.frustumCulled = false;
  beams.renderOrder = 2;
  beams.layers.set(LAYER_NO_REFLECT);
  group.add(beams);

  // uniformy plam (powierzchnie + dym)
  const spotK = H.spotIntensity * (H.spotIntensityMap[world.id] ?? 1);
  for (let i = 0; i < n; i++) atmo.spotCol.value[i].set(cols[i].r * spotK, cols[i].g * spotK, cols[i].b * spotK);
  atmo.spotCount.value = n;
  atmo.spotSurf.value = preset.headSpots ? 1 : 0;
  const cosHalf = Math.cos(H.halfAngle), tanHalf = Math.tan(H.halfAngle);
  const maxLen = Math.hypot(world.bounds.maxX - world.bounds.minX, world.ceiling) + 1;
  const tilt0 = H.tiltBase, tiltAmp = H.tiltAmp, panAmp = H.panAmp, spin = H.spin, wPan = H.panSpeed, wTilt = H.tiltSpeed;

  const sp4 = atmo.spotPos.value, sd4 = atmo.spotDir.value;
  function update(time) {
    beamMat.uniforms.time.value = time;
    for (let i = 0; i < n; i++) {
      const ph = hd[i * 4], sg = hd[i * 4 + 1], mode = hd[i * 4 + 2], base = hd[i * 4 + 3];
      // tryb 0: omiatanie wahadłowe w stronę środka; tryb 1: ciągły obrót (plama zatacza krąg)
      const pan = mode > 0.5 ? base + sg * spin * time + ph
        : base + panAmp * Math.sin(wPan * time * (1 + 0.13 * i) + ph);
      const tilt = tilt0 + tiltAmp * Math.sin(wTilt * time * (1 + 0.07 * i) + ph * 1.7);
      aim[i * 2] = pan; aim[i * 2 + 1] = tilt;
      const st = Math.sin(tilt), ct = Math.cos(tilt), sp = Math.sin(pan), cp = Math.cos(pan);
      const dx = -st * sp, dy = -ct, dz = -st * cp;
      const ox = spots[i].x + dx * hg.lensOff, oy = lensY + dy * hg.lensOff, oz = spots[i].z + dz * hg.lensOff;
      RB[0] = ox; RB[1] = oy; RB[2] = oz; RB[3] = dx; RB[4] = dy; RB[5] = dz; RB[6] = maxLen;
      beamLength(world);
      const len = RB[7];
      bHead[i * 4] = ox; bHead[i * 4 + 1] = oy; bHead[i * 4 + 2] = oz; bHead[i * 4 + 3] = len;
      bDir[i * 4] = dx; bDir[i * 4 + 1] = dy; bDir[i * 4 + 2] = dz; bDir[i * 4 + 3] = tanHalf;
      // pola wprost (bez wywołania set z doublami w argumentach — boxing V8, D-012)
      const P = sp4[i], Dv = sd4[i];
      P.x = ox; P.y = oy; P.z = oz; P.w = len;
      Dv.x = dx; Dv.y = dy; Dv.z = dz; Dv.w = cosHalf;
    }
    aimAttr.needsUpdate = true;
    headAttr.needsUpdate = true;
    dirAttr.needsUpdate = true;
  }
  update(0);

  return {
    group,
    update,
    dispose() {
      if (group.parent) group.parent.remove(group);
      geo.dispose(); headMat.dispose(); heads.dispose();
      bgeo.dispose(); beamMat.dispose(); beams.dispose();
      atmo.spotCount.value = 0;
    },
  };
}
