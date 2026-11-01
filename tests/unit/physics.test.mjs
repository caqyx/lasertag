// Testy src/world/physics.js: brak przenikania (kąty, sprint, wysoki dt), ślizganie, stopnie, rampy, sufit/spód platformy,
// bounds, OBB obrócone, raycast vs brute force + normalne, segmentClear, połówka, groundHeight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { moveBody, groundHeight, raycastWorld, segmentClear, createHit } from '../../src/world/physics.js';
import { createRng } from '../../src/core/rng.js';
import uvmaze from '../../src/world/maps/uvmaze.js';
import { CONFIG } from '../../src/config.js';

const P = CONFIG.player;
const R = P.radius;
const DT = 1 / CONFIG.sim.hz;
const uv = buildWorld(uvmaze);

function mk({ walls = [], ramps = [], size = 30, ceiling = 5, perimeter = true, spawns = [] } = {}) {
  return buildWorld({
    id: 't', name: 't', seed: 1, size: { w: size, d: size }, ceiling,
    perimeter: perimeter ? { h: ceiling } : undefined, walls, ramps, spawns, cams: [],
  });
}
function body(x, z, y = 0) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0, onGround: true, radius: R, height: P.height };
}
/** n kroków z wymuszoną prędkością poziomą (jak stały input). */
function drive(w, b, vx, vz, n, dt = DT, each) {
  for (let i = 0; i < n; i++) { b.vx = vx; b.vz = vz; moveBody(w, b, dt); if (each) each(b, i); }
}
function local(s, x, z) {
  const dx = x - s.cx; const dz = z - s.cz;
  return [dx * s.cos - dz * s.sin, dx * s.sin + dz * s.cos];
}
/** Głębokość wejścia koła postaci w bryłę blokującą w paśmie [feet+step, feet+height] (0 = brak). */
function penetration(w, b) {
  let worst = 0;
  for (const s of w.solids) {
    if (!(s.y1 > b.y + P.stepHeight && s.y0 < b.y + b.height)) continue;
    const [lx, lz] = local(s, b.x, b.z);
    const qx = Math.max(-s.hx, Math.min(s.hx, lx));
    const qz = Math.max(-s.hz, Math.min(s.hz, lz));
    const d = Math.hypot(lx - qx, lz - qz);
    const inside = Math.abs(lx) < s.hx && Math.abs(lz) < s.hz;
    const pen = inside ? b.radius + Math.min(s.hx - Math.abs(lx), s.hz - Math.abs(lz)) : b.radius - d;
    if (pen > worst) worst = pen;
  }
  return worst;
}
function freePoints(w, n, rng) {
  const pts = [];
  while (pts.length < n) {
    const x = rng.range(w.bounds.minX + 1, w.bounds.maxX - 1);
    const z = rng.range(w.bounds.minZ + 1, w.bounds.maxZ - 1);
    if (penetration(w, body(x, z)) <= 0 && groundHeight(w, x, z, 0, R) === 0) pts.push([x, z]);
  }
  return pts;
}
const TOL = 2e-3; // tolerancja numeryczna (skin = 0.001)

// ------------------------------------------------------------------------------------------------ kolizje poziome

test('UV Maze: brak przenikania — 72 kierunki × spawny i losowe punkty × walk/sprint × dt do 0.25 s', () => {
  const starts = uv.spawns.map((s) => [s.x, s.z]).concat(freePoints(uv, 8, createRng(5)));
  const B = uv.bounds;
  for (const dt of [DT, 0.05, 0.1, 0.25]) {
    for (const speed of [P.walkSpeed, P.sprintSpeed]) {
      for (const [sx, sz] of starts) {
        for (let k = 0; k < 72; k++) {
          const a = (k / 72) * Math.PI * 2;
          const b = body(sx, sz);
          drive(uv, b, Math.cos(a) * speed, Math.sin(a) * speed, Math.ceil(1.5 / dt), dt, (bb) => {
            const pen = penetration(uv, bb);
            if (pen > TOL) assert.fail(`penetracja ${pen.toFixed(4)} m (dt=${dt}, v=${speed}, start ${sx.toFixed(2)},${sz.toFixed(2)}, kąt ${k * 5}°) @ ${bb.x},${bb.z}`);
            assert.ok(bb.x >= B.minX + R - 1e-9 && bb.x <= B.maxX - R + 1e-9 && bb.z >= B.minZ + R - 1e-9 && bb.z <= B.maxZ - R + 1e-9, 'poza bounds');
            assert.equal(bb.y, 0, 'UV Maze jest płaska — y musi zostać 0');
          });
        }
      }
    }
  }
});

test('cienka ściana (0.1 m): brak tunelowania dla realnych prędkości i dt aż do 1 s', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 0.1, d: 20, h: 3 }] });
  for (const dt of [DT, 0.1, 0.25, 0.5, 1]) {
    for (const sp of [P.walkSpeed, P.sprintSpeed, 12]) {
      for (const dir of [1, -1]) {
        const b = body(-dir * 1.5, 0);
        drive(w, b, dir * sp, 0, Math.ceil(2 / dt), dt);
        assert.ok(dir * b.x < -0.05 - R + 1e-6, `tunelowanie: dt=${dt} v=${sp} dir=${dir} x=${b.x}`);
      }
    }
  }
});

test('BUG/limit: tunelowanie przez cienką ścianę przy v·dt > ~32·(r+½grubości)', { todo: 'MAX_SUBSTEPS=32 bez sweep testu: dt=1, v=15 m/s przechodzi przez ścianę 0.1 m (nieosiągalne przy 60 Hz i v ≤ 7.6)' }, () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 0.1, d: 20, h: 3 }] });
  const b = body(-1, 0);
  drive(w, b, 15, 0, 2, 1);
  assert.ok(b.x < 0, `x=${b.x}`);
});

test('ślizganie po ścianie osiowej: składowa styczna prędkości zachowana, normalna wyzerowana', () => {
  const w = mk({ walls: [{ x: 2, z: 0, w: 1, d: 24, h: 3 }] });
  const b = body(0, -5);
  let contact = 0;
  drive(w, b, 4, 3, 60, DT, (bb) => {
    if (bb.x > 1.5 - R - 0.01) {
      contact++;
      assert.equal(bb.vx, 0, 'składowa w głąb ściany nie wyzerowana');
      assert.equal(bb.vz, 3, 'składowa styczna zmieniona');
    }
  });
  assert.ok(contact > 30);
  assert.ok(Math.abs(b.x - (1.5 - R - CONFIG.physics.skin)) < TOL, `x=${b.x}`);
  assert.ok(Math.abs(b.z - (-5 + 3 * 60 * DT)) < 1e-6, `z=${b.z}: ślizg traci dystans`);
});

test('ślizganie po ścianie obróconej o π/3: v·t zachowane, v·n = 0, brak przenikania', () => {
  const rot = Math.PI / 3;
  const w = mk({ walls: [{ x: 0, z: 0, w: 1, d: 20, h: 3, rot }] });
  const s = w.solids[0];
  // normalna lokalnej ściany −X w świecie: local (−1,0) → (−cos, +sin); styczna = lokalne +Z → (sin, cos)
  const nx = -s.cos; const nz = s.sin;
  const tx = s.sin; const tz = s.cos;
  const b = body(nx * 3, nz * 3);
  const vx = -nx * 4 + tx * 2; const vz = -nz * 4 + tz * 2; // w ścianę + wzdłuż
  let contact = 0;
  drive(w, b, vx, vz, 90, DT, (bb) => {
    assert.ok(penetration(w, bb) <= TOL);
    const vn = bb.vx * nx + bb.vz * nz;
    if (Math.abs(vn) < 1e-9) {
      contact++;
      assert.ok(Math.abs(bb.vx * tx + bb.vz * tz - 2) < 1e-9, 'styczna zmieniona');
    }
  });
  assert.ok(contact > 30, `kontaktów ${contact}`);
  const [lx] = local(s, b.x, b.z);
  assert.ok(Math.abs(lx - (-0.5 - R - CONFIG.physics.skin)) < TOL, `lx=${lx}`);
});

test('OBB obrócone (π/3, π/4, 1.0 rad): brak przenikania z 72 kierunków; AABB-narożnik jest wolny', () => {
  for (const rot of [Math.PI / 3, Math.PI / 4, 1.0]) {
    const w = mk({ walls: [{ x: 0, z: 0, w: 6, d: 0.6, h: 3, rot }, { x: 6, z: 6, w: 0.6, d: 0.6, h: 4.5, rot, kind: 'pillar' }] });
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const b = body(Math.cos(a) * 5, Math.sin(a) * 5);
      drive(w, b, -Math.cos(a) * P.sprintSpeed, -Math.sin(a) * P.sprintSpeed, 90, DT, (bb) => {
        const pen = penetration(w, bb);
        if (pen > TOL) assert.fail(`rot=${rot} kąt=${k * 5}°: penetracja ${pen}`);
      });
    }
    // punkt w AABB obróconej ściany, ale poza OBB → postać może tam stać
    const s = w.solids[0];
    const [lx, lz] = local(s, 2.0, 2.0);
    assert.ok(Math.abs(lz) > s.hz + R);
    const b = body(2.0, 2.0);
    moveBody(w, b, DT);
    assert.ok(Math.abs(b.x - 2) < 1e-9 && Math.abs(b.z - 2) < 1e-9, `wypchnięty z wolnego miejsca: ${lx}`);
  }
});

test('bounds bez ścian obwodowych: postać zatrzymana na krawędzi, prędkość w stronę krawędzi wyzerowana', () => {
  const w = mk({ perimeter: false, size: 10 });
  for (const [vx, vz] of [[10, 0], [-10, 0], [0, 10], [0, -10], [7, 7], [-7, 7]]) {
    const b = body(0, 0);
    drive(w, b, vx, vz, 120);
    if (vx > 0) assert.equal(b.x, 5 - R);
    if (vx < 0) assert.equal(b.x, -5 + R);
    if (vz > 0) assert.equal(b.z, 5 - R);
    if (vz < 0) assert.equal(b.z, -5 + R);
    b.vx = vx; b.vz = vz;
    moveBody(w, b, DT);
    if (vx !== 0) assert.equal(b.vx, 0);
    if (vz !== 0) assert.equal(b.vz, 0);
  }
});

// ------------------------------------------------------------------------------------------------ pion

test('grawitacja i lądowanie: spadek z 3 m kończy się na y=0, onGround=true, vy=0', () => {
  const w = mk();
  const b = body(0, 0, 3);
  b.onGround = false;
  let landedAt = -1;
  for (let i = 0; i < 120; i++) {
    moveBody(w, b, DT);
    assert.ok(b.y >= 0);
    if (b.onGround && landedAt < 0) landedAt = i;
  }
  assert.equal(b.y, 0);
  assert.equal(b.vy, 0);
  // t = sqrt(2h/g) ≈ 0.548 s ≈ 33 kroki
  assert.ok(Math.abs(landedAt - Math.sqrt(6 / P.gravity) / DT) < 3, `lądowanie po ${landedAt} krokach`);
});

test('stopnie: h ≤ stepHeight wchodzi bez skoku, h > stepHeight blokuje', () => {
  for (const h of [0.1, 0.3, P.stepHeight - 0.01, P.stepHeight, P.stepHeight + 0.01, 0.8, 1.1]) {
    const w = mk({ walls: [{ x: 2, z: 0, w: 2, d: 4, h }] });
    const b = body(-1, 0);
    drive(w, b, P.walkSpeed, 0, 45);
    if (h <= P.stepHeight) {
      assert.ok(Math.abs(b.y - h) < 1e-9, `h=${h}: y=${b.y} (nie wszedł)`);
      assert.ok(b.x > 1, `h=${h}: x=${b.x}`);
      assert.equal(b.onGround, true);
    } else {
      assert.equal(b.y, 0, `h=${h}: wszedł na zbyt wysoki stopień`);
      assert.ok(Math.abs(b.x - (1 - R - CONFIG.physics.skin)) < TOL, `h=${h}: x=${b.x}`);
    }
  }
});

test('zejście ze stopnia: krótki spadek (≤ groundSnap) przyklejony, wyższy spada, na końcu y=0 i onGround', () => {
  for (const h of [0.1, 0.45]) {
    const w = mk({ walls: [{ x: 0, z: 0, w: 2, d: 4, h }] });
    const b = body(0, 0, h);
    moveBody(w, b, DT);
    assert.equal(b.y, h);
    let airborne = 0;
    drive(w, b, P.walkSpeed, 0, 40, DT, (bb) => { if (!bb.onGround) airborne++; });
    assert.equal(b.y, 0);
    assert.equal(b.onGround, true);
    if (h <= CONFIG.physics.groundSnap) assert.equal(airborne, 0, 'snap nie zadziałał');
    else assert.ok(airborne > 0, 'zejście z 0.45 m bez fazy lotu');
  }
});

test('skok (vy = jumpSpeed): wskakuje na 0.9 m, nie wskakuje na połówkę 1.1 m', () => {
  for (const [h, should] of [[0.9, true], [1.1, false]]) {
    const w = mk({ walls: [{ x: 2, z: 0, w: 2, d: 4, h }] });
    const b = body(-0.2, 0);
    moveBody(w, b, DT);
    b.vy = P.jumpSpeed; b.onGround = false;
    drive(w, b, P.walkSpeed, 0, 30); // 2.6 m → x ≈ 2.4 (nad bryłą x∈[1,3])
    if (should) { assert.ok(Math.abs(b.y - h) < 1e-9, `nie wskoczył na ${h}: y=${b.y}`); assert.equal(b.onGround, true); }
    else { assert.equal(b.y, 0, `wskoczył na ${h}`); assert.ok(b.x < 1 - R + TOL); }
  }
});

test('spód platformy: skok pod platformą zatrzymuje głowę na y0, vy zerowane', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 6, d: 6, h: 0.3, y: 2.0, kind: 'platform' }] });
  const b = body(0, 0);
  moveBody(w, b, DT);
  b.vy = P.jumpSpeed; b.onGround = false;
  let maxHead = 0; let hit = false;
  for (let i = 0; i < 60; i++) {
    moveBody(w, b, DT);
    maxHead = Math.max(maxHead, b.y + b.height);
    if (b.y + b.height >= 2.0 - 1e-9) { hit = true; assert.ok(b.vy <= 0); }
  }
  assert.ok(hit, 'głowa nie doszła do spodu platformy');
  assert.ok(maxHead <= 2.0 + 1e-9, `głowa w platformie: ${maxHead}`);
  assert.equal(b.y, 0);
});

test('sufit świata: skok przy niskim suficie nie wychodzi głową ponad sufit', () => {
  const w = mk({ ceiling: 2.0 });
  const b = body(0, 0);
  moveBody(w, b, DT);
  b.vy = P.jumpSpeed; b.onGround = false;
  for (let i = 0; i < 60; i++) {
    moveBody(w, b, DT);
    assert.ok(b.y + b.height <= 2.0 + 1e-9);
  }
});

test('stanie na platformie i lądowanie na cienkiej platformie z dużą prędkością (bez przebicia)', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 4, d: 4, h: 0.1, y: 2.0, kind: 'platform' }] });
  for (const [vy, dt] of [[0, DT], [-20, DT], [-50, 0.1], [-200, 0.25]]) {
    const b = body(0, 0, 3);
    b.vy = vy; b.onGround = false;
    for (let i = 0; i < 60; i++) moveBody(w, b, dt);
    assert.ok(Math.abs(b.y - 2.1) < 1e-9, `vy=${vy} dt=${dt}: y=${b.y}`);
    assert.equal(b.onGround, true);
  }
});

test('platforma zawieszona nisko (y0 < stepHeight+wysokość) blokuje z boku', () => {
  const w = mk({ walls: [{ x: 2, z: 0, w: 2, d: 4, h: 0.3, y: 1.0, kind: 'platform' }] });
  const b = body(-1, 0);
  drive(w, b, P.walkSpeed, 0, 60);
  assert.ok(b.x < 1 - R + TOL, `przeszedł przez platformę na wysokości głowy: x=${b.x}`);
  assert.equal(b.y, 0);
});

// ------------------------------------------------------------------------------------------------ rampy

const RAMP = { x: 0, z: 0, w: 4, d: 10, y0: 0, y1: 2 }; // z∈[-5,5], y = 0.2·(z+5)
const rampY = (z) => Math.max(0, Math.min(2, 0.2 * (z + 5)));

test('rampa: wejście — y śledzi powierzchnię, onGround przez cały czas, wejście na platformę', () => {
  const w = mk({ ramps: [RAMP], walls: [{ x: 0, z: 7, w: 4, d: 4, h: 2, kind: 'platform' }] });
  const b = body(0, -8);
  drive(w, b, 0, P.walkSpeed, Math.ceil(16 / P.walkSpeed / DT), DT, (bb) => { // 16 m → z ≈ 8 (platforma z∈[5,9])
    assert.equal(bb.onGround, true, `oderwanie od rampy z=${bb.z}`);
    if (bb.z > -4.5 && bb.z < 4.5) assert.ok(Math.abs(bb.y - rampY(bb.z)) < 1e-6, `z=${bb.z} y=${bb.y} oczekiwane ${rampY(bb.z)}`);
  });
  assert.ok(b.z > 6, `nie doszedł na platformę: z=${b.z}`);
  assert.equal(b.y, 2);
});

test('rampa: zejście sprintem — przyklejone do powierzchni (bez fazy lotu)', () => {
  const w = mk({ ramps: [RAMP], walls: [{ x: 0, z: 7, w: 4, d: 4, h: 2, kind: 'platform' }] });
  const b = body(0, 7, 2);
  moveBody(w, b, DT);
  drive(w, b, 0, -P.sprintSpeed, Math.ceil(14 / P.sprintSpeed / DT), DT, (bb) => { // 14 m: z 7 → −7
    assert.equal(bb.onGround, true, `lot na rampie z=${bb.z} y=${bb.y}`);
    if (bb.z > -4.5 && bb.z < 4.5) assert.ok(Math.abs(bb.y - rampY(bb.z)) < 1e-6, `z=${bb.z} y=${bb.y}`);
  });
  assert.equal(b.y, 0);
});

test('rampa obrócona (rot=π/2 → wznosi się wzdłuż +X): wejście działa', () => {
  const w = mk({ ramps: [{ ...RAMP, rot: Math.PI / 2 }] });
  assert.ok(Math.abs(groundHeight(w, 4, 0, 2, R) - 1.8) < 1e-9);
  assert.ok(Math.abs(groundHeight(w, -4, 0, 0, R) - 0.2) < 1e-9);
  const b = body(-8, 0);
  drive(w, b, P.walkSpeed, 0, 120, DT, (bb) => { if (bb.x > -4.5 && bb.x < 4.5) assert.ok(Math.abs(bb.y - rampY(bb.x)) < 1e-6); });
});

test('rampa: bok wysokiej części i tył wysokiego końca blokują; niski bok przepuszcza', () => {
  const w = mk({ ramps: [RAMP] });
  const side = body(-6, 3); // powierzchnia 1.6 m
  drive(w, side, 5, 0, 120);
  assert.ok(side.x < -2 - R + TOL && side.y === 0, `bok: x=${side.x}`);
  const back = body(0, 8); // tył końca 2 m
  drive(w, back, 0, -5, 120);
  assert.ok(back.z > 5 + R - TOL && back.y === 0, `tył: z=${back.z}`);
  const low = body(-6, -4); // powierzchnia 0.2 m ≤ stepHeight
  drive(w, low, 5, 0, 150);
  assert.ok(low.x > 2 + R, `niski bok zablokował: x=${low.x}`);
});

// ------------------------------------------------------------------------------------------------ groundHeight

test('groundHeight: podłoga, top bryły ≤ feet+step, wyższe bryły ignorowane, częściowe nachodzenie koła', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 0.4 }, { x: 5, z: 0, w: 2, d: 2, h: 1.0 }] });
  assert.equal(groundHeight(w, -5, -5, 0, R), 0);
  assert.equal(groundHeight(w, 0, 0, 0, R), 0.4);
  assert.equal(groundHeight(w, 1 + R - 0.01, 0, 0, R), 0.4); // krawędź koła na bryle
  assert.equal(groundHeight(w, 1 + R + 0.01, 0, 0, R), 0);
  assert.equal(groundHeight(w, 5, 0, 0, R), 0); // 1.0 > 0 + step
  assert.equal(groundHeight(w, 5, 0, 0.6, R), 1.0); // 1.0 ≤ 0.6 + step
  assert.equal(groundHeight(w, 5, 0, 2.0, R), 1.0);
  // rampa: tylko gdy środek w obrysie
  const wr = mk({ ramps: [RAMP] });
  assert.ok(Math.abs(groundHeight(wr, 0, 0, 1, R) - 1) < 1e-12);
  assert.equal(groundHeight(wr, 0, 0, 0, R), 0); // 1.0 > 0 + step
  assert.equal(groundHeight(wr, 0, 6, 5, R), 0);
});

// ------------------------------------------------------------------------------------------------ raycast

/** Naiwny raycast: wszystkie bryły (slab), podłoga, sufit. Zwraca { dist, index } lub null. */
function bruteRay(w, ox, oy, oz, dx, dy, dz, max) {
  const L = Math.hypot(dx, dy, dz); dx /= L; dy /= L; dz /= L;
  let best = max; let idx = null;
  if (dy < 0 && oy >= 0) { const t = -oy / dy; if (t < best) { best = t; idx = -1; } }
  if (dy > 0 && oy <= w.ceiling) { const t = (w.ceiling - oy) / dy; if (t < best) { best = t; idx = -1; } }
  w.solids.forEach((s, i) => {
    if (s.seeThrough) return;   // siatka maskująca: przepuszcza promień (CONFIG.elements.net)
    const [lox, loz] = local(s, ox, oz);
    const ldx = dx * s.cos - dz * s.sin; const ldz = dx * s.sin + dz * s.cos;
    const o = [lox, oy, loz]; const d = [ldx, dy, ldz];
    const mn = [-s.hx, s.y0, -s.hz]; const mx = [s.hx, s.y1, s.hz];
    let t0 = -Infinity; let t1 = Infinity;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-12) { if (o[a] < mn[a] || o[a] > mx[a]) return; continue; }
      let a1 = (mn[a] - o[a]) / d[a]; let a2 = (mx[a] - o[a]) / d[a];
      if (a1 > a2) [a1, a2] = [a2, a1];
      t0 = Math.max(t0, a1); t1 = Math.min(t1, a2);
    }
    if (t1 >= t0 && t0 >= 0 && t0 < best) { best = t0; idx = i; }
  });
  return idx === null ? null : { dist: best, index: idx };
}

function rotWorld() {
  const walls = [];
  const rng = createRng(77);
  for (let i = 0; i < 25; i++) {
    walls.push({
      x: rng.range(-12, 12), z: rng.range(-12, 12), w: rng.range(0.3, 6), d: rng.range(0.3, 3),
      h: rng.range(0.5, 3), y: rng.next() < 0.3 ? rng.range(0.5, 2) : 0, rot: rng.range(-Math.PI, Math.PI),
      kind: 'prop',
    });
  }
  return mk({ walls });
}

test('raycastWorld vs brute force: losowe promienie (UV Maze + losowe obrócone bryły i platformy)', () => {
  const hit = createHit();
  for (const [name, w] of [['uvmaze', uv], ['rot', rotWorld()]]) {
    const rng = createRng(2024);
    const lim = w.bounds.maxX + 3;
    let hits = 0;
    for (let i = 0; i < 6000; i++) {
      const ox = rng.range(-lim, lim); const oy = rng.range(-0.5, w.ceiling + 0.5); const oz = rng.range(-lim, lim);
      const th = rng.range(0, Math.PI * 2); const ph = rng.next() < 0.3 ? 0 : rng.range(-1.4, 1.4);
      const dx = Math.cos(th) * Math.cos(ph); const dy = Math.sin(ph); const dz = Math.sin(th) * Math.cos(ph);
      const max = rng.next() < 0.1 ? Infinity : rng.range(0.5, 80);
      const r = raycastWorld(w, ox, oy, oz, dx * 3, dy * 3, dz * 3, max, hit); // kierunek nienormalizowany
      const b = bruteRay(w, ox, oy, oz, dx, dy, dz, max);
      const ctx = `${name}#${i} o=(${ox},${oy},${oz}) d=(${dx},${dy},${dz}) max=${max}`;
      assert.equal(r, b !== null, `hit różny: ${ctx} raycast=${r && hit.dist} brute=${b && b.dist}`);
      assert.equal(hit.hit, r);
      if (!r) continue;
      hits++;
      assert.ok(Math.abs(hit.dist - b.dist) < 1e-7, `dist ${hit.dist} vs ${b.dist}: ${ctx}`);
      if (b.index >= 0) assert.ok(hit.index >= 0, `typ trafienia: ${ctx}`);
      assert.ok(Math.abs(hit.x - (ox + dx * hit.dist)) < 1e-7 && Math.abs(hit.y - (oy + dy * hit.dist)) < 1e-7 && Math.abs(hit.z - (oz + dz * hit.dist)) < 1e-7);
    }
    assert.ok(hits > 1000, `${name}: za mało trafień (${hits})`);
  }
});

test('raycast normalne: jednostkowe, przeciwne do promienia, punkt na powierzchni trafionej bryły', () => {
  const hit = createHit();
  const w = rotWorld();
  const rng = createRng(31);
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    const ox = rng.range(-14, 14); const oy = rng.range(0.1, 4.9); const oz = rng.range(-14, 14);
    const th = rng.range(0, Math.PI * 2); const ph = rng.range(-1.2, 1.2);
    const dx = Math.cos(th) * Math.cos(ph); const dy = Math.sin(ph); const dz = Math.sin(th) * Math.cos(ph);
    if (!raycastWorld(w, ox, oy, oz, dx, dy, dz, 60, hit)) continue;
    assert.ok(Math.abs(Math.hypot(hit.nx, hit.ny, hit.nz) - 1) < 1e-9);
    assert.ok(hit.nx * dx + hit.ny * dy + hit.nz * dz < 0, 'normalna zgodna z promieniem');
    if (hit.index === -1) { assert.ok(hit.ny === 1 || hit.ny === -1); assert.equal(hit.nx, 0); continue; }
    const s = w.solids[hit.index];
    const inside = (x, y, z) => { const [lx, lz] = local(s, x, z); return Math.abs(lx) <= s.hx + 1e-9 && Math.abs(lz) <= s.hz + 1e-9 && y >= s.y0 - 1e-9 && y <= s.y1 + 1e-9; };
    const e = 1e-4;
    assert.ok(inside(hit.x - hit.nx * e, hit.y - hit.ny * e, hit.z - hit.nz * e), 'punkt −n nie w bryle');
    assert.ok(!inside(hit.x + hit.nx * e, hit.y + hit.ny * e, hit.z + hit.nz * e), 'punkt +n w bryle');
    checked++;
  }
  assert.ok(checked > 500);
});

test('raycast: konkretne przypadki — ściana osiowa, obrócona, podłoga, sufit, start w bryle, maxDist', () => {
  const hit = createHit();
  const rot = Math.PI / 3;
  const w = mk({ walls: [{ x: 5, z: 0, w: 2, d: 4, h: 3 }, { x: -5, z: 0, w: 2, d: 4, h: 3, rot }] });
  assert.ok(raycastWorld(w, 0, 1, 0, 1, 0, 0, 50, hit));
  assert.deepEqual([hit.dist, hit.nx, hit.ny, hit.nz, hit.index], [4, -1, 0, 0, 0]);
  // obrócona: promień wzdłuż lokalnej −X ściany → normalna = lokalne +X w świecie (cos, −sin)
  const s = w.solids[1];
  const ox = s.cx + 5 * s.cos; const oz = s.cz - 5 * s.sin;
  assert.ok(raycastWorld(w, ox, 1, oz, -s.cos, 0, s.sin, 50, hit));
  assert.ok(Math.abs(hit.dist - 4) < 1e-9);
  assert.ok(Math.abs(hit.nx - s.cos) < 1e-9 && Math.abs(hit.nz + s.sin) < 1e-9 && hit.index === 1);
  // podłoga i sufit
  assert.ok(raycastWorld(w, 0, 2, 0, 0, -1, 0, 50, hit));
  assert.deepEqual([hit.dist, hit.ny, hit.index], [2, 1, -1]);
  assert.ok(raycastWorld(w, 0, 2, 0, 0, 1, 0, 50, hit));
  assert.deepEqual([hit.dist, hit.ny, hit.index], [3, -1, -1]);
  // maxDist krótszy niż odległość → brak trafienia
  assert.equal(raycastWorld(w, 0, 1, 0, 1, 0, 0, 3.99, hit), false);
  assert.equal(hit.hit, false);
  // zerowy kierunek / maxDist ≤ 0 → false
  assert.equal(raycastWorld(w, 0, 1, 0, 0, 0, 0, 50, hit), false);
  assert.equal(raycastWorld(w, 0, 1, 0, 1, 0, 0, 0, hit), false);
  // start wewnątrz bryły: ta bryła ignorowana, trafia następną (obwód)
  assert.ok(raycastWorld(w, 5, 1, 0, 1, 0, 0, 50, hit));
  assert.notEqual(hit.index, 0);
});

test('raycast vs rampa: trafienie powierzchni od góry, indeks −2−i, normalna prostopadła do stoku', () => {
  const w = mk({ ramps: [RAMP] });
  const hit = createHit();
  assert.ok(raycastWorld(w, 0, 4, 0, 0, -1, 0, 50, hit));
  assert.ok(Math.abs(hit.y - 1) < 1e-9);
  assert.equal(hit.index, -2);
  const k = 0.2; const inv = 1 / Math.sqrt(1 + k * k);
  assert.ok(Math.abs(hit.ny - inv) < 1e-9 && Math.abs(hit.nz + k * inv) < 1e-9 && Math.abs(hit.nx) < 1e-12);
  // poza obrysem rampy → podłoga
  assert.ok(raycastWorld(w, 3, 4, 0, 0, -1, 0, 50, hit));
  assert.equal(hit.index, -1);
});

test('BUG: raycast przechodzi przez boki/koniec klina rampy, które blokują ruch', () => {
  const w = mk({ ramps: [RAMP] });
  const hit = createHit();
  // poziomo w bok rampy na wysokości 0.5, gdzie powierzchnia ma 1.6 m: ruch blokuje (test wyżej), promień nie
  assert.ok(raycastWorld(w, -6, 0.5, 3, 1, 0, 0, 20, hit), 'bok klina przepuszcza promień');
  assert.ok(Math.abs(hit.dist - 4) < 1e-6);
  // w tylną ścianę końca (z=5, wysokość 2) na y=1: powinno trafić przy z=5 (dist 4), trafia spód powierzchni dalej
  assert.ok(raycastWorld(w, 0, 1, 9, 0, 0, -1, 20, hit));
  assert.ok(Math.abs(hit.dist - 4) < 1e-6, `dist=${hit.dist}`);
});

test('segmentClear: symetryczny dla punktów poza bryłami; zerowa długość → true', () => {
  const inside = (w, x, y, z) => w.solids.some((s) => { const [lx, lz] = local(s, x, z); return Math.abs(lx) <= s.hx && Math.abs(lz) <= s.hz && y >= s.y0 && y <= s.y1; });
  for (const w of [uv, rotWorld()]) {
    const rng = createRng(8);
    let blocked = 0; let clear = 0;
    for (let i = 0; i < 8000; i++) {
      const a = [rng.range(-14, 14), rng.range(0.05, 4.4), rng.range(-14, 14)];
      const b = [rng.range(-14, 14), rng.range(0.05, 4.4), rng.range(-14, 14)];
      if (inside(w, ...a) || inside(w, ...b)) continue;
      const ab = segmentClear(w, ...a, ...b);
      assert.equal(ab, segmentClear(w, ...b, ...a), `asymetria ${a} ↔ ${b}`);
      if (ab) clear++; else blocked++;
    }
    assert.ok(clear > 100 && blocked > 100, `${clear}/${blocked}`);
  }
  assert.equal(segmentClear(uv, 1, 1, 1, 1, 1, 1), true);
});

test('segmentClear gdy koniec odcinka leży w bryle — asymetria (udokumentowane „start w bryle → ignoruj”)', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 2, d: 2, h: 3 }] });
  assert.equal(segmentClear(w, 0, 1, 0, 5, 1, 0), segmentClear(w, 5, 1, 0, 0, 1, 0));
});

test('osłona połówkowa: blokuje nisko, przepuszcza wysoko (linia oczu nad osłoną)', () => {
  const w = mk({ walls: [{ x: 0, z: 0, w: 4, d: 0.5, h: 1.1, kind: 'half' }] });
  assert.equal(segmentClear(w, 0, 1.0, -3, 0, 1.0, 3), false);
  assert.equal(segmentClear(w, 0, 1.09, -3, 0, 1.09, 3), false);
  assert.equal(segmentClear(w, 0, 1.12, -3, 0, 1.12, 3), true);
  assert.equal(segmentClear(w, 0, P.eyeHeight, -3, 0, P.eyeHeight, 3), true);
  // oko 1.65 → sensor przód 1.35 kucającego za osłoną 0.5 m dalej: odcinek nad 1.1? y na osłonie ≈ 1.39 → widać
  assert.equal(segmentClear(w, 0, P.eyeHeight, -3, 0, 1.35, 0.8), true);
  // oko → stopy celu tuż za osłoną: zasłonięte
  assert.equal(segmentClear(w, 0, P.eyeHeight, -3, 0, 0.3, 0.6), false);
  // ruch: osłona połówkowa blokuje postać
  const b = body(0, -3);
  drive(w, b, 0, 5, 60);
  assert.ok(b.z < -0.25 - R + TOL && b.y === 0);
});

test('moveBody: dt ≤ 0 lub NaN — brak zmian', () => {
  const w = mk();
  for (const dt of [0, -1, NaN]) {
    const b = body(1, 2, 0.5);
    b.vx = 3; b.vy = 1; b.onGround = false;
    const before = JSON.stringify(b);
    moveBody(w, b, dt);
    assert.equal(JSON.stringify(b), before);
  }
});

test('BUG: postać przeciska się przez szczelinę węższą niż średnica (0.65 m < 0.70 m)', () => {
  const gap = 0.65;
  const w = mk({ walls: [{ x: -1 - gap / 2, z: 0, w: 2, d: 1, h: 3 }, { x: 1 + gap / 2, z: 0, w: 2, d: 1, h: 3 }] });
  const b = body(0, -2);
  drive(w, b, 0, P.sprintSpeed, 120);
  assert.ok(b.z < 0, `przeszedł przez szczelinę ${gap} m: z=${b.z}`);
});

test('szczeliny ≥ średnica są przechodnie, wyraźnie węższe blokują; wewnętrzne narożniki bez penetracji', () => {
  for (const [gap, pass] of [[0.4, false], [0.5, false], [0.75, true], [1.0, true]]) {
    const w = mk({ walls: [{ x: -1 - gap / 2, z: 0, w: 2, d: 1, h: 3 }, { x: 1 + gap / 2, z: 0, w: 2, d: 1, h: 3 }] });
    const b = body(0, -2);
    drive(w, b, 0, P.sprintSpeed, 120, DT, (bb) => assert.ok(penetration(w, bb) <= TOL, `gap ${gap}: pen ${penetration(w, bb)}`));
    assert.equal(b.z > 1, pass, `gap ${gap}: z=${b.z}`);
  }
  for (const rot of [0, 0.3, Math.PI / 3]) {
    const w = mk({ walls: [{ x: 0, z: 0, w: 4, d: 0.4, h: 3, rot }, { x: 0, z: 0, w: 0.4, d: 4, h: 3, rot }] });
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2;
      const b = body(Math.cos(a) * 4, Math.sin(a) * 4);
      drive(w, b, -Math.cos(a) * P.sprintSpeed, -Math.sin(a) * P.sprintSpeed, 90, DT, (bb) => assert.ok(penetration(w, bb) <= TOL));
    }
  }
});
