// Smoke (SPEC §11): każda mapa × preset ładuje się bez błędów/ostrzeżeń konsoli, bez błędów HTTP, renderer.info w budżecie
// (CONFIG.budget); scenariusz rozgrywki (gracz eliminuje manekina, respawn po eliminatedTime z pełnym HP); brak wycieków
// geometrii/tekstur przy zmianie presetu (low → ultra → low ×2).
// Użycie: npm run smoke [-- --map uvmaze --preset low,ultra --skip-game --skip-leak --leak-all --jobs 3]
// Mapy sprawdzane równolegle (--jobs, domyślnie 3 strony), presety mapy po kolei. Test wycieków domyślnie tylko na pierwszej
// mapie (zmiana presetu nie zależy od mapy; ultra w SwiftShaderze jest wolne) — --leak-all na każdej.
// Kod wyjścia ≠ 0 przy jakimkolwiek problemie. Bez zrzutów ekranu (renderowanie programowe jest wolne).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../src/config.js';
import { MAPS } from '../../src/world/maps/index.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const T0 = Date.now();
const TOTAL_LIMIT_MS = 6 * 60 * 1000;
const SETTLE_MS = 2000;
const VIEWPORT = { width: 640, height: 360 }; // liczby renderer.info nie zależą od rozdzielczości; mniejszy = szybciej w SwiftShaderze

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes('--' + name);
const maps = arg('map', Object.keys(MAPS).join(',')).split(',');
const presets = arg('preset', Object.keys(CONFIG.presets).join(',')).split(',');

const jobs = Math.max(1, Number(arg('jobs', 3)) | 0);

const failures = [];
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(1)} s`;
/** Log mapy (wypisywany w całości po jej zakończeniu — mapy idą równolegle). */
function createLog(name) {
  const lines = [];
  return {
    lines,
    say: (msg) => lines.push(msg),
    ok: (msg) => lines.push(`  ✓ ${msg}`),
    fail: (msg) => { failures.push(`${name}: ${msg}`); lines.push(`  ✗ ${msg}`); },
    flush: () => console.log(lines.join('\n')),
  };
}

const watchdog = setTimeout(() => {
  console.log(`\nSMOKE: przekroczono limit czasu ${TOTAL_LIMIT_MS / 1000} s`);
  process.exit(2);
}, TOTAL_LIMIT_MS);
watchdog.unref();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitForServer(url, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* jeszcze nie */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`serwer nie odpowiada: ${url}`);
}

/** Strona z nasłuchem problemów: console error/warning, pageerror, HTTP ≥ 400, requestfailed. */
async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} (${r.failure() && r.failure().errorText})`));
  const t = Date.now();
  await page.goto(url, { waitUntil: 'commit', timeout: 120000 }); // „load“ pod obciążeniem SwiftShadera bywa > 30 s
  await page.waitForFunction(() => window.__lt && window.__lt.ready, null, { timeout: 120000 });
  return { page, problems, loadMs: Date.now() - t };
}

const frames = (page, n = 3) => page.evaluate((k) => new Promise((res) => {
  let i = 0;
  const f = () => (++i >= k ? res() : requestAnimationFrame(f));
  requestAnimationFrame(f);
}), n);
const info = (page) => page.evaluate(() => ({ ...window.__lt.info() }));

// ------------------------------------------------------------------ scenariusz rozgrywki

async function gameplay(page, L) {
  L.say(`  [rozgrywka] ${elapsed()}`);
  // Boty zamrożone (manekiny: stoją, nie strzelają); gracz dostaje inputSource celujący w wybrany cel
  // (yaw = atan2(−dx, −dz)) i strzelający, gdy __smoke.fire. Zmiany stanu celu rejestrowane w czasie symulacji.
  await page.evaluate(() => {
    const sim = window.__lt.sim;
    for (const Q of sim.participants) {
      if (Q.isPlayer) continue;
      Q.inputSource = {
        sample(p, s, out) {
          out.moveX = 0; out.moveZ = 0; out.fire = false; out.jump = false; out.sprint = false; out.scoreboard = false;
          out.yaw = p.body.yaw; out.pitch = 0;
        },
      };
    }
  });
  // cel: żywy, pełne HP, bez ochrony (zamrożeni boty dochodzą do tego stanu najpóźniej po eliminatedTime + protectionTime)
  const setup = await page.waitForFunction(() => {
    const sim = window.__lt.sim;
    const P = sim.participants.find((p) => p.isPlayer);
    if (!P || P.state !== 'alive') return false;
    const T = sim.participants.find((q) => !q.isPlayer && q.state === 'alive' && q.protectTimer <= 0 && q.hp === 4);
    if (!T) return false;
    const S = window.__smoke = {
      player: P.id, target: T.id, fire: false, elimAt: -1, respawnAt: -1, hpAtRespawn: -1, protAtRespawn: -1,
      prevState: T.state, score0: P.stats.score,
    };
    P.inputSource = {
      sample(p, s, out) {
        out.moveX = 0; out.moveZ = 0; out.jump = false; out.sprint = false; out.scoreboard = false;
        const dx = T.body.x - p.body.x, dz = T.body.z - p.body.z;
        const ty = T.body.y + 1.3, ey = p.body.y + 1.65;
        out.yaw = Math.atan2(-dx, -dz);
        out.pitch = Math.atan2(ty - ey, Math.hypot(dx, dz));
        out.fire = S.fire && T.state === 'alive';
        if (S.prevState === 'alive' && T.state === 'eliminated' && S.elimAt < 0) { S.elimAt = s.time; S.fire = false; }
        if (S.prevState === 'eliminated' && T.state === 'alive' && S.respawnAt < 0) {
          S.respawnAt = s.time; S.hpAtRespawn = T.hp; S.protAtRespawn = T.protectTimer;
        }
        S.prevState = T.state;
      },
    };
    return { target: T.id, name: T.name, tx: T.body.x, tz: T.body.z, score0: S.score0 };
  }, null, { timeout: 120000, polling: 200 }).then((h) => h.jsonValue());
  L.ok(`cel: #${setup.target} ${setup.name} w (${setup.tx.toFixed(1)}, ${setup.tz.toFixed(1)})`);

  const offsets = [[5, 0], [-5, 0], [0, 5], [0, -5], [3, 0], [-3, 0], [0, 3], [0, -3], [4, 4], [-4, -4], [4, -4], [-4, 4]];
  let placed = null;
  for (const [ox, oz] of offsets) {
    const r = await page.evaluate(async ([ox, oz]) => {
      const { segmentClear } = await import('/src/world/physics.js');
      const sim = window.__lt.sim;
      const S = window.__smoke;
      const P = sim.participants.find((p) => p.id === S.player);
      const T = sim.participants.find((p) => p.id === S.target);
      const x = T.body.x + ox, z = T.body.z + oz;
      if (!segmentClear(sim.world, x, T.body.y + 1.65, z, T.body.x, T.body.y + 1.3, T.body.z)) return null;
      const b = P.body;
      b.x = x; b.z = z; b.y = T.body.y; b.vx = 0; b.vy = 0; b.vz = 0;
      P.prevX = x; P.prevY = b.y; P.prevZ = z;
      S.fire = true;
      return { x, z, hp0: T.hp, t0: sim.time };
    }, [ox, oz]);
    if (!r) continue;
    // czekamy na spadek HP (≤ 1.5 s czasu symulacji)
    const hit = await page.waitForFunction(([hp0, t0]) => {
      const sim = window.__lt.sim;
      const T = sim.participants.find((p) => p.id === window.__smoke.target);
      return T.hp < hp0 || T.state !== 'alive' || sim.time - t0 > 1.5 ? { hp: T.hp, dt: sim.time - t0 } : false;
    }, [r.hp0, r.t0], { timeout: 60000, polling: 50 }).then((h) => h.jsonValue());
    if (hit.hp < r.hp0) { placed = { ...r, ox, oz }; break; }
    await page.evaluate(() => { window.__smoke.fire = false; });
  }
  if (!placed) { L.fail('rozgrywka: brak pozycji z linią strzału do celu (HP nie spada)'); return; }
  L.ok(`gracz przesunięty o (${placed.ox}, ${placed.oz}) m od celu — HP celu spada`);

  await page.waitForFunction(() => window.__smoke.elimAt >= 0, null, { timeout: 90000, polling: 100 })
    .catch(() => L.fail('rozgrywka: cel nie został wyeliminowany'));
  const afterElim = await page.evaluate(() => {
    const sim = window.__lt.sim;
    const S = window.__smoke;
    const P = sim.participants.find((p) => p.id === S.player);
    const T = sim.participants.find((p) => p.id === S.target);
    return { score: P.stats.score - S.score0, state: T.state, deaths: T.stats.deaths, elimAt: S.elimAt };
  });
  if (afterElim.elimAt >= 0) L.ok(`cel wyeliminowany (t_sim ${afterElim.elimAt.toFixed(2)} s)`);
  if (afterElim.score >= 90) L.ok(`wynik gracza +${afterElim.score} ≥ 90`);
  else L.fail(`rozgrywka: wynik gracza +${afterElim.score} < 90`);

  await page.waitForFunction(() => window.__smoke.respawnAt >= 0, null, { timeout: 120000, polling: 100 })
    .catch(() => L.fail('rozgrywka: cel nie respawnował'));
  const resp = await page.evaluate(() => ({ ...window.__smoke }));
  if (resp.respawnAt >= 0) {
    const dt = resp.respawnAt - resp.elimAt;
    const E = CONFIG.combat.eliminatedTime;
    if (Math.abs(dt - E) <= 2 / CONFIG.sim.hz + 1e-6) L.ok(`respawn po ${dt.toFixed(3)} s czasu symulacji`);
    else L.fail(`rozgrywka: respawn po ${dt.toFixed(3)} s (oczekiwano ${E} s)`);
    if (resp.hpAtRespawn === CONFIG.combat.maxHp) L.ok(`HP po respawnie ${resp.hpAtRespawn}`);
    else L.fail(`rozgrywka: HP po respawnie ${resp.hpAtRespawn} ≠ ${CONFIG.combat.maxHp}`);
    if (resp.protAtRespawn > 0) L.ok(`ochrona po respawnie aktywna (${resp.protAtRespawn.toFixed(2)} s)`);
    else L.fail('rozgrywka: brak ochrony po respawnie');
  }
}

// ------------------------------------------------------------------ wycieki

async function leakTest(page, L) {
  L.say(`  [wycieki] ${elapsed()}`);
  await frames(page, 3);
  const base = await info(page);
  const seq = ['ultra', 'low', 'ultra', 'low'];
  const trace = [`low g${base.geometries}/t${base.textures}`];
  let last = base;
  for (const p of seq) {
    await page.evaluate((n) => window.__lt.setPreset(n), p);
    await frames(page, 3);
    last = await info(page);
    trace.push(`${p} g${last.geometries}/t${last.textures}`);
  }
  L.say(`    ${trace.join(' → ')}`);
  if (last.geometries === base.geometries && last.textures === base.textures) L.ok('geometrie/tekstury wracają do wartości początkowych');
  else L.fail(`wyciek przy zmianie presetu: geometries ${base.geometries} → ${last.geometries}, textures ${base.textures} → ${last.textures}`);
}

// ------------------------------------------------------------------ main

const rows = [];

async function runMap(browser, base, map, withLeak) {
  for (const preset of presets) {
    const L = createLog(`${map}/${preset}`);
    L.say(`\n[${map}/${preset}] start ${elapsed()}`);
    let page = null;
    let problems = [];
    try {
      const o = await openPage(browser, `${base}/?map=${map}&preset=${preset}&autostart=1&seed=1`);
      page = o.page; problems = o.problems;
      await page.waitForTimeout(SETTLE_MS);
      const inf = await info(page);
      const B = CONFIG.budget[preset];
      const st = await page.evaluate(() => ({ preset: window.__lt.params.preset, map: window.__lt.world.id, app: window.__lt.app, n: window.__lt.sim ? window.__lt.sim.participants.length : 0 }));
      if (st.preset !== preset) L.fail(`aktywny preset ${st.preset}`);
      if (st.map !== map) L.fail(`aktywna mapa ${st.map}`);
      if (st.app !== 'match') L.fail(`app = ${st.app} (autostart nie wystartował meczu)`);
      const over = ['calls', 'triangles', 'textures', 'geometries'].filter((k) => !(inf[k] <= B[k]));
      if (over.length) L.fail(`poza budżetem: ${over.map((k) => `${k} ${inf[k]} > ${B[k]}`).join(', ')}`);
      else L.ok(`w budżecie (${o.loadMs} ms do ready, uczestników ${st.n})`);
      const row = { map, preset, inf, B, n: st.n, console: null };
      rows.push(row);
      if (preset === 'low' && withLeak) await leakTest(page, L);
      if (preset === 'low' && !flag('skip-game')) await gameplay(page, L);
      if (problems.length) L.fail(`konsola/HTTP (${problems.length}):\n      ${problems.join('\n      ')}`);
      else L.ok('konsola/HTTP: 0 problemów');
      row.console = problems.length;
    } catch (e) {
      L.fail(`wyjątek: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      if (problems.length) L.say(`      konsola: ${problems.join('\n      ')}`);
    } finally {
      if (page) await page.close().catch(() => {});
      L.say(`  koniec ${elapsed()}`);
      L.flush();
    }
  }
}

const port = await freePort();
const server = spawn(process.execPath, ['tools/serve.mjs', String(port)], { cwd: ROOT, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let browser = null;
try {
  await waitForServer(`${base}/`);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  console.log(`SMOKE: ${maps.join(',')} × ${presets.join(',')} (port ${port}, równolegle ${jobs})`);
  const queue = maps.map((m, i) => [m, !flag('skip-leak') && (i === 0 || flag('leak-all'))]);
  const worker = async () => { while (queue.length) { const [m, leak] = queue.shift(); await runMap(browser, base, m, leak); } };
  await Promise.all(Array.from({ length: Math.min(jobs, maps.length) }, worker));
} catch (e) {
  failures.push(`wyjątek: ${e && e.stack ? e.stack : e}`);
  console.log(`  ✗ wyjątek: ${e && e.stack ? e.stack : e}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

// tabela
const cell = (v, b) => `${v}/${b}${v <= b ? '' : ' !'}`;
rows.sort((a, b) => maps.indexOf(a.map) - maps.indexOf(b.map) || presets.indexOf(a.preset) - presets.indexOf(b.preset));
console.log('\n| mapa | preset | uczestn. | calls | triangles | textures | geometries | programs | konsola/HTTP |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.map} | ${r.preset} | ${r.n} | ${cell(r.inf.calls, r.B.calls)} | ${cell(r.inf.triangles, r.B.triangles)} | ` +
    `${cell(r.inf.textures, r.B.textures)} | ${cell(r.inf.geometries, r.B.geometries)} | ${r.inf.programs} | ${r.console ?? '?'} |`);
}
if (failures.length) console.log(`\nPROBLEMY:\n  - ${failures.join('\n  - ')}`);
console.log(`\nSMOKE: ${failures.length ? `${failures.length} problem(ów)` : 'OK'} — ${elapsed()}`);
process.exit(failures.length ? 1 : 0);
