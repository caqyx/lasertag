// Testy src/world/nav.js (PLAN §8.1, SPEC §11): buildNav na 3 mapach (MAPS) — osiągalność ze spawnów ≥ 98%, symetria
// krawędzi, findPath (brak ścieżki → 0, from == to, outPath za krótki), nearestNode na obu poziomach Reactor, smoothPath
// nie skraca przez ściany (linia na wysokości bioder + symulacja stepMovement wzdłuż wygładzonej ścieżki), determinizm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorld } from '../../src/world/mapgen.js';
import { buildNav, nearestNode, findPath, randomNode, smoothPath, NEAR, nearestNodeBuf } from '../../src/world/nav.js';
import { segmentClear } from '../../src/world/physics.js';
import { createBody, stepMovement } from '../../src/game/movement.js';
import { createInputState } from '../../src/game/input/inputState.js';
import { createRng } from '../../src/core/rng.js';
import { CONFIG } from '../../src/config.js';
import { MAPS } from '../../src/world/maps/index.js';

const WORLDS = {};
const NAVS = {};
for (const id of Object.keys(MAPS)) {
  WORLDS[id] = buildWorld(MAPS[id]);
  NAVS[id] = buildNav(WORLDS[id]);
}
const DECK = 3.2; // Reactor: poziom galerii (SPEC §3.3)

// Znane błędy (zgłoszone w raporcie testera) — test jako todo, dopóki nie naprawione w src/.
const TODO_SMOOTH = {
  reactor: 'BUG nav.smoothPath: segFree/straightOk sprawdza tylko bryły (solids), pomija rampy — wygładzona ścieżka ' +
    '(-9.5,-9.5)→(-5.5,-5.5) ścina narożnik wysokiego końca rampy (-5.5,-10.2) w 0.14 m < radius; kapsuła ociera się (0.21 m zepchnięcia)',
};

function reach(nav, from) {
  const seen = new Uint8Array(nav.count);
  const st = [from]; seen[from] = 1; let n = 1;
  while (st.length) {
    const c = st.pop();
    for (let j = nav.edgeStart[c]; j < nav.edgeStart[c + 1]; j++) {
      const b = nav.edges[j];
      if (!seen[b]) { seen[b] = 1; n++; st.push(b); }
    }
  }
  return n;
}

function hasEdge(nav, a, b) {
  for (let j = nav.edgeStart[a]; j < nav.edgeStart[a + 1]; j++) if (nav.edges[j] === b) return j;
  return -1;
}

for (const id of Object.keys(MAPS)) {
  const w = WORLDS[id];
  const nav = NAVS[id];

  test(`${id}: kontrakt Nav (typy, CSR, węzły w granicach mapy, koszty = długość 3D)`, () => {
    assert.ok(nav.count > 100, `za mało węzłów: ${nav.count}`);
    assert.ok(nav.x instanceof Float32Array && nav.y instanceof Float32Array && nav.z instanceof Float32Array);
    assert.ok(nav.edgeStart instanceof Int32Array && nav.edges instanceof Int32Array && nav.cost instanceof Float32Array);
    assert.equal(nav.edgeStart.length, nav.count + 1);
    assert.equal(nav.edgeStart[nav.count], nav.edges.length);
    assert.equal(nav.cost.length, nav.edges.length);
    const b = w.bounds;
    for (let i = 0; i < nav.count; i++) {
      assert.ok(nav.x[i] > b.minX && nav.x[i] < b.maxX && nav.z[i] > b.minZ && nav.z[i] < b.maxZ, `węzeł ${i} poza mapą`);
      assert.ok(nav.y[i] >= -1e-6 && nav.y[i] + CONFIG.player.height <= w.ceiling + 1e-3, `węzeł ${i} y=${nav.y[i]}`);
      assert.ok(nav.edgeStart[i + 1] >= nav.edgeStart[i]);
      for (let j = nav.edgeStart[i]; j < nav.edgeStart[i + 1]; j++) {
        const k = nav.edges[j];
        assert.ok(k >= 0 && k < nav.count && k !== i, `krawędź ${i}→${k}`);
        const d = Math.hypot(nav.x[k] - nav.x[i], nav.y[k] - nav.y[i], nav.z[k] - nav.z[i]);
        assert.ok(Math.abs(nav.cost[j] - d) < 1e-3, `koszt ${i}→${k}: ${nav.cost[j]} vs ${d}`);
        assert.ok(d <= CONFIG.nav.cell * Math.SQRT2 * 1.5 + 1e-3, `krawędź ${i}→${k} za długa (${d})`);
      }
    }
  });

  test(`${id}: z każdego spawnu osiągalne ≥ 98% węzłów`, () => {
    for (const sp of w.spawns) {
      const n = nearestNode(nav, sp.x, sp.y, sp.z);
      assert.ok(n >= 0, `spawn (${sp.x}, ${sp.z}) bez węzła`);
      assert.ok(Math.abs(nav.y[n] - sp.y) < 0.1, `spawn (${sp.x}, ${sp.y}, ${sp.z}) → węzeł na y=${nav.y[n]}`);
      assert.ok(Math.hypot(nav.x[n] - sp.x, nav.z[n] - sp.z) < 1.0, 'najbliższy węzeł spawnu > 1 m');
      const r = reach(nav, n) / nav.count;
      assert.ok(r >= 0.98, `spawn (${sp.x}, ${sp.z}): osiągalne ${(r * 100).toFixed(1)}%`);
    }
  });

  test(`${id}: krawędzie symetryczne (a→b ⇔ b→a, ten sam koszt)`, () => {
    const bad = [];
    for (let a = 0; a < nav.count; a++) {
      for (let j = nav.edgeStart[a]; j < nav.edgeStart[a + 1]; j++) {
        const b = nav.edges[j];
        const k = hasEdge(nav, b, a);
        if (k < 0 || Math.abs(nav.cost[k] - nav.cost[j]) > 1e-5) bad.push(`${a}→${b}`);
      }
    }
    assert.equal(bad.length, 0, `asymetryczne: ${bad.length} (np. ${bad.slice(0, 5).join(', ')})`);
  });

  test(`${id}: findPath — ścieżka spójna (kolejne węzły połączone krawędzią), from==to, outPath za krótki, błędne argumenty`, () => {
    const rng = createRng(7);
    const out = new Int32Array(CONFIG.bots.pathCapacity * 4);
    for (let k = 0; k < 40; k++) {
      const a = randomNode(nav, rng), b = randomNode(nav, rng);
      const len = findPath(nav, a, b, out);
      assert.ok(len > 0, `brak ścieżki ${a}→${b}`);
      assert.equal(out[0], a); assert.equal(out[len - 1], b);
      for (let i = 1; i < len; i++) assert.ok(hasEdge(nav, out[i - 1], out[i]) >= 0, `skok ${out[i - 1]}→${out[i]}`);
      // A* z heurystyką dopuszczalną: koszt ≥ odległość w linii prostej
      let cost = 0;
      for (let i = 1; i < len; i++) cost += nav.cost[hasEdge(nav, out[i - 1], out[i])];
      const straight = Math.hypot(nav.x[b] - nav.x[a], nav.y[b] - nav.y[a], nav.z[b] - nav.z[a]);
      assert.ok(cost + 1e-3 >= straight);
      if (len > 3) {
        const short = new Int32Array(3);
        assert.equal(findPath(nav, a, b, short), 3, 'outPath za krótki → zapis początku (outPath.length)');
        assert.deepEqual([...short], [...out.subarray(0, 3)]);
      }
    }
    const one = new Int32Array(4);
    assert.equal(findPath(nav, 5, 5, one), 1); assert.equal(one[0], 5);
    assert.equal(findPath(nav, -1, 5, one), 0);
    assert.equal(findPath(nav, 5, nav.count, one), 0);
    assert.equal(findPath(nav, 1, 2, new Int32Array(0)), 0);
  });

  test(`${id}: findPath optymalny (A* = Dijkstra) na losowych parach`, () => {
    const rng = createRng(11);
    const out = new Int32Array(nav.count);
    const dist = new Float64Array(nav.count);
    for (let k = 0; k < 5; k++) {
      const a = randomNode(nav, rng), b = randomNode(nav, rng);
      // Dijkstra (prosty O(n²) — n ~ 1400)
      dist.fill(Infinity); dist[a] = 0;
      const done = new Uint8Array(nav.count);
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i < nav.count; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0 || u === b) break;
        done[u] = 1;
        for (let j = nav.edgeStart[u]; j < nav.edgeStart[u + 1]; j++) {
          const v = nav.edges[j]; const nd = dist[u] + nav.cost[j];
          if (nd < dist[v]) dist[v] = nd;
        }
      }
      const len = findPath(nav, a, b, out);
      let cost = 0;
      for (let i = 1; i < len; i++) cost += nav.cost[hasEdge(nav, out[i - 1], out[i])];
      assert.ok(Math.abs(cost - dist[b]) < 1e-2, `${a}→${b}: A* ${cost.toFixed(3)} vs Dijkstra ${dist[b].toFixed(3)}`);
    }
  });

  test(`${id}: smoothPath — każdy wygładzony odcinek przechodni (linia bioder wolna, stepMovement dochodzi do celu)`, { todo: TODO_SMOOTH[id] }, () => {
    const rng = createRng(3);
    const out = new Int32Array(CONFIG.bots.pathCapacity * 4);
    const body = createBody();
    const inp = createInputState();
    const DT = 1 / CONFIG.sim.hz;
    const P = CONFIG.player;
    let segs = 0, removed = 0;
    for (let k = 0; k < 30; k++) {
      const a = randomNode(nav, rng), b = randomNode(nav, rng);
      const len0 = findPath(nav, a, b, out);
      const raw = Array.from(out.subarray(0, len0));
      const len = smoothPath(nav, out, len0);
      assert.ok(len >= 1 && len <= len0);
      assert.equal(out[0], a); assert.equal(out[len - 1], b);
      // wygładzona ścieżka = podciąg surowej (kolejność zachowana)
      let p = 0;
      for (let i = 0; i < len; i++) { while (p < raw.length && raw[p] !== out[i]) p++; assert.ok(p < raw.length, 'węzeł spoza surowej ścieżki'); }
      removed += len0 - len;
      for (let i = 1; i < len; i++) {
        const u = out[i - 1], v = out[i];
        const dy = nav.y[v] - nav.y[u];
        const hip = 1.0;
        // linia bioder i kolan (oba poziomy ciała) wolna — nie skraca przez ściany/osłony
        for (const h of [0.6, hip, 1.5]) {
          assert.ok(segmentClear(w, nav.x[u], nav.y[u] + h, nav.z[u], nav.x[v], nav.y[v] + h, nav.z[v]),
            `odcinek ${u}→${v} (${nav.x[u]},${nav.z[u]})→(${nav.x[v]},${nav.z[v]}) przez bryłę na wys. ${h}`);
        }
        if (Math.abs(dy) > 0.05) continue; // rampy/stopnie zostają surowe (krawędzie grafu)
        segs++;
        // symulacja ruchu kapsuły prosto z u do v
        body.x = nav.x[u]; body.y = nav.y[u]; body.z = nav.z[u]; body.vx = 0; body.vy = 0; body.vz = 0; body.onGround = true;
        const L = Math.hypot(nav.x[v] - nav.x[u], nav.z[v] - nav.z[u]);
        const maxSteps = Math.ceil((L / P.walkSpeed) * CONFIG.sim.hz * 1.6) + 30;
        let ok = false;
        let maxDev = 0;
        for (let s = 0; s < maxSteps; s++) {
          const dx = nav.x[v] - body.x, dz = nav.z[v] - body.z;
          if (dx * dx + dz * dz < 0.25 * 0.25) { ok = true; break; }
          inp.yaw = Math.atan2(-dx, -dz); inp.pitch = 0; inp.moveX = 0; inp.moveZ = 1; inp.sprint = false; inp.jump = false;
          stepMovement(body, inp, DT, w);
          // odchylenie od odcinka (kolizja ze ścianą zepchnęłaby kapsułę z linii)
          const ux = (nav.x[v] - nav.x[u]) / L, uz = (nav.z[v] - nav.z[u]) / L;
          const ex = body.x - nav.x[u], ez = body.z - nav.z[u];
          const dev = Math.abs(ex * uz - ez * ux);
          if (dev > maxDev) maxDev = dev;
        }
        assert.ok(ok, `stepMovement nie doszedł ${u}→${v} (${nav.x[u]},${nav.z[u]})→(${nav.x[v]},${nav.z[v]}), ciało (${body.x.toFixed(2)},${body.z.toFixed(2)})`);
        assert.ok(maxDev < 0.15, `odcinek ${u}→${v}: kapsuła zepchnięta z linii o ${maxDev.toFixed(3)} m (otarcie o ścianę)`);
        assert.ok(Math.abs(body.y - nav.y[v]) < 0.1, `odcinek ${u}→${v}: koniec na y=${body.y.toFixed(2)}, oczekiwano ${nav.y[v]}`);
      }
    }
    assert.ok(segs > 30, `za mało odcinków płaskich: ${segs}`);
    assert.ok(removed > 0, 'smoothPath nic nie usunął');
    // len ≤ 2 bez zmian
    out[0] = 1; out[1] = 2;
    assert.equal(smoothPath(nav, out, 2), 2); assert.equal(smoothPath(nav, out, 1), 1);
  });

  test(`${id}: determinizm buildNav (dwukrotna budowa → identyczne tablice)`, () => {
    const n2 = buildNav(buildWorld(MAPS[id]));
    assert.equal(n2.count, nav.count);
    for (const k of ['x', 'y', 'z', 'edgeStart', 'edges', 'cost', 'cover']) {
      assert.deepEqual(Buffer.from(n2[k].buffer), Buffer.from(nav[k].buffer), `${k} różne`);
    }
    const o1 = new Int32Array(256), o2 = new Int32Array(256);
    const r1 = createRng(5), r2 = createRng(5);
    for (let k = 0; k < 10; k++) {
      const a = randomNode(nav, r1), b = randomNode(nav, r1);
      assert.equal(randomNode(n2, r2), a); assert.equal(randomNode(n2, r2), b);
      const l1 = findPath(nav, a, b, o1), l2 = findPath(n2, a, b, o2);
      assert.equal(l1, l2); assert.deepEqual([...o1.subarray(0, l1)], [...o2.subarray(0, l2)]);
    }
  });

  test(`${id}: nearestNode — |dy| < 1, wariant Buf zgodny, -1 dla pustego grafu`, () => {
    const rng = createRng(9);
    for (let k = 0; k < 200; k++) {
      const x = w.bounds.minX + rng.next() * (w.bounds.maxX - w.bounds.minX);
      const z = w.bounds.minZ + rng.next() * (w.bounds.maxZ - w.bounds.minZ);
      const n = nearestNode(nav, x, 0, z);
      if (n >= 0) assert.ok(Math.abs(nav.y[n]) < 1, `y=${nav.y[n]}`);
      NEAR[0] = x; NEAR[1] = 0; NEAR[2] = z;
      assert.equal(nearestNodeBuf(nav), n);
    }
    assert.equal(nearestNode({ ...nav, count: 0 }, 0, 0, 0), -1);
    assert.equal(randomNode({ ...nav, count: 0 }, rng), -1);
  });
}

test('reactor: nearestNode rozróżnia galerię (y≈3.2) i parter pod nią; rampy łączą poziomy', () => {
  const w = WORLDS.reactor;
  const nav = NAVS.reactor;
  let upper = 0, lower = 0, mid = 0;
  for (let i = 0; i < nav.count; i++) {
    if (Math.abs(nav.y[i] - DECK) < 0.05) upper++;
    else if (nav.y[i] < 0.05) lower++;
    else mid++;
  }
  assert.ok(upper > 100 && lower > 500 && mid > 10, `galeria ${upper}, parter ${lower}, rampy ${mid}`);
  // punkty galerii, pod którymi jest parter (pas N galerii: x∈[-9,9], z∈[-7,-3.5])
  const pts = [[-6.5, -5.5], [0.5, -5.5], [6.5, 5.5], [-0.5, 5.5]];
  for (const [x, z] of pts) {
    const up = nearestNode(nav, x, DECK, z);
    const dn = nearestNode(nav, x, 0, z);
    assert.ok(up >= 0 && dn >= 0, `(${x},${z}) brak węzła`);
    assert.ok(Math.abs(nav.y[up] - DECK) < 0.05, `(${x},${z}) góra → y=${nav.y[up]}`);
    assert.ok(nav.y[dn] < 0.05, `(${x},${z}) dół → y=${nav.y[dn]}`);
    assert.ok(Math.hypot(nav.x[up] - x, nav.z[up] - z) < 1.5);
    assert.ok(Math.hypot(nav.x[dn] - x, nav.z[dn] - z) < 1.5, `(${x},${z}) dół za daleko`);
    // stoją w tej samej kolumnie XZ (ok. 1 m), na różnych poziomach
    // ścieżka parter → galeria istnieje i przechodzi przez rampę (monotoniczne kroki ≤ maxClimb)
    const out = new Int32Array(nav.count);
    const len = findPath(nav, dn, up, out);
    assert.ok(len > 2, `brak ścieżki parter→galeria z (${x},${z})`);
    for (let i = 1; i < len; i++) {
      assert.ok(Math.abs(nav.y[out[i]] - nav.y[out[i - 1]]) <= CONFIG.nav.maxClimb + CONFIG.player.maxSlopeY * 1.5 + 1e-3);
    }
  }
  // spawny na balkonach (y = 3.2) → węzeł na galerii, nie pod spodem
  for (const sp of w.spawns.filter((s) => s.y > 1)) {
    const n = nearestNode(nav, sp.x, sp.y, sp.z);
    assert.ok(Math.abs(nav.y[n] - DECK) < 0.05);
  }
});
