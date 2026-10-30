// Smoke (SPEC §11): każda mapa × preset ładuje się bez błędów/ostrzeżeń konsoli, bez błędów HTTP, renderer.info w budżecie
// (CONFIG.budget); scenariusz rozgrywki (gracz eliminuje manekina, respawn po eliminatedTime z pełnym HP); brak wycieków
// geometrii/tekstur przy zmianie presetu (low → ultra → low ×2).
// Użycie: npm run smoke [-- --map uvmaze --preset low,ultra --skip-game --skip-leak]
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
const VIEWPORT = { width: 960, height: 540 };

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes('--' + name);
const maps = arg('map', Object.keys(MAPS).join(',')).split(',');
const presets = arg('preset', Object.keys(CONFIG.presets).join(',')).split(',');

const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  ✗ ${msg}`); };
const ok = (msg) => console.log(`  ✓ ${msg}`);
const elapsed = () => `${((Date.now() - T0) / 1000).toFixed(1)} s`;

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
  await page.goto(url);
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

async function gameplay(page) {
  console.log(`  [rozgrywka] ${elapsed()}`);
  // podmiana inputSource gracza: celuje w wybranego manekina (yaw = atan2(−dx, −dz)), strzela gdy __smoke.fire
  const setup = await page.evaluate(() => {
    const sim = window.__lt.sim;
    const P = sim.participants.find((p) => p.isPlayer);
    const dummies = sim.participants.filter((p) => !p.isPlayer);
    const T = dummies.find((d) => d.inputSource && d.inputSource.strafe === false) || dummies[0];
    const S = window.__smoke = { player: P.id, target: T.id, fire: false, elimAt: -1, respawnAt: -1, hpAtRespawn: -1, protAtRespawn: -1, prevState: T.state };
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
    return { target: T.id, strafe: T.inputSource.strafe, tx: T.body.x, tz: T.body.z };
  });
  ok(`cel: manekin #${setup.target} (strafe ${setup.strafe}) w (${setup.tx.toFixed(1)}, ${setup.tz.toFixed(1)})`);

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
    if (hit.hp < r.hp0 || hit.hp === 0) { placed = { ...r, ox, oz }; break; }
    await page.evaluate(() => { window.__smoke.fire = false; });
  }
  if (!placed) { fail('rozgrywka: brak pozycji z linią strzału do manekina (HP nie spada)'); return; }
  ok(`gracz przesunięty o (${placed.ox}, ${placed.oz}) m — HP manekina spada`);

  await page.waitForFunction(() => window.__smoke.elimAt >= 0, null, { timeout: 90000, polling: 100 })
    .catch(() => fail('rozgrywka: manekin nie został wyeliminowany'));
  const afterElim = await page.evaluate(() => {
    const sim = window.__lt.sim;
    const S = window.__smoke;
    const P = sim.participants.find((p) => p.id === S.player);
    const T = sim.participants.find((p) => p.id === S.target);
    return { score: P.stats.score, elims: P.stats.elims, state: T.state, deaths: T.stats.deaths, elimAt: S.elimAt };
  });
  if (afterElim.elimAt >= 0) ok(`manekin wyeliminowany (t_sim ${afterElim.elimAt.toFixed(2)} s, deaths ${afterElim.deaths})`);
  if (afterElim.score >= 90) ok(`wynik gracza ${afterElim.score} ≥ 90`);
  else fail(`rozgrywka: wynik gracza ${afterElim.score} < 90`);

  await page.waitForFunction(() => window.__smoke.respawnAt >= 0, null, { timeout: 120000, polling: 100 })
    .catch(() => fail('rozgrywka: manekin nie respawnował'));
  const resp = await page.evaluate(() => ({ ...window.__smoke }));
  if (resp.respawnAt >= 0) {
    const dt = resp.respawnAt - resp.elimAt;
    const tol = 2 / CONFIG.sim.hz + 1e-6;
    if (Math.abs(dt - CONFIG.combat.eliminatedTime) <= tol) ok(`respawn po ${dt.toFixed(3)} s czasu symulacji`);
    else fail(`rozgrywka: respawn po ${dt.toFixed(3)} s (oczekiwano ${CONFIG.combat.eliminatedTime} s)`);
    if (resp.hpAtRespawn === CONFIG.combat.maxHp) ok(`HP po respawnie ${resp.hpAtRespawn}`);
    else fail(`rozgrywka: HP po respawnie ${resp.hpAtRespawn} ≠ ${CONFIG.combat.maxHp}`);
    if (resp.protAtRespawn > 0) ok(`ochrona po respawnie aktywna (${resp.protAtRespawn.toFixed(2)} s)`);
    else fail('rozgrywka: brak ochrony po respawnie');
  }
}

// ------------------------------------------------------------------ wycieki

async function leakTest(page) {
  console.log(`  [wycieki] ${elapsed()}`);
  await frames(page, 3);
  const base = await info(page);
  const seq = ['ultra', 'low', 'ultra', 'low'];
  const trace = [`low g${base.geometries}/t${base.textures}`];
  let last = base;
  for (const p of seq) {
    await page.evaluate((n) => window.__lt.setPreset(n), p);
    await frames(page, 4);
    await page.waitForTimeout(300);
    last = await info(page);
    trace.push(`${p} g${last.geometries}/t${last.textures}`);
  }
  console.log(`    ${trace.join(' → ')}`);
  if (last.geometries === base.geometries && last.textures === base.textures) ok('geometrie/tekstury wracają do wartości początkowych');
  else fail(`wyciek przy zmianie presetu: geometries ${base.geometries} → ${last.geometries}, textures ${base.textures} → ${last.textures}`);
  return trace;
}

// ------------------------------------------------------------------ main

const port = await freePort();
const server = spawn(process.execPath, ['tools/serve.mjs', String(port)], { cwd: ROOT, stdio: 'ignore' });
const base = `http://127.0.0.1:${port}`;
let browser = null;
const rows = [];
try {
  await waitForServer(`${base}/`);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  console.log(`SMOKE: ${maps.join(',')} × ${presets.join(',')} (port ${port})`);
  for (const map of maps) {
    for (const preset of presets) {
      console.log(`\n[${map}/${preset}] ${elapsed()}`);
      const { page, problems, loadMs } = await openPage(browser, `${base}/?map=${map}&preset=${preset}&autostart=1&seed=1`);
      await page.waitForTimeout(SETTLE_MS);
      const inf = await info(page);
      const B = CONFIG.budget[preset];
      const over = ['calls', 'triangles', 'textures', 'geometries'].filter((k) => !(inf[k] <= B[k]));
      const ltPreset = await page.evaluate(() => window.__lt.params.preset);
      if (ltPreset !== preset) fail(`${map}/${preset}: aktywny preset ${ltPreset}`);
      if (over.length) fail(`${map}/${preset}: poza budżetem: ${over.map((k) => `${k} ${inf[k]} > ${B[k]}`).join(', ')}`);
      else ok(`w budżecie (${loadMs} ms do ready)`);
      const row = { map, preset, inf, B, consoleAtLoad: problems.length };
      rows.push(row);
      if (preset === 'low' && !flag('skip-leak')) row.leak = await leakTest(page);
      if (preset === 'low' && !flag('skip-game')) await gameplay(page);
      if (problems.length) fail(`${map}/${preset}: konsola/HTTP:\n      ${problems.join('\n      ')}`);
      else ok('konsola/HTTP: 0 problemów');
      row.console = problems.length;
      await page.close();
    }
  }
} catch (e) {
  fail(`wyjątek: ${e && e.stack ? e.stack : e}`);
} finally {
  if (browser) await browser.close();
  server.kill();
}

// tabela
const cell = (v, b) => `${v}/${b}${v <= b ? '' : ' !'}`;
console.log('\n| mapa | preset | calls | triangles | textures | geometries | programs | konsola |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.map} | ${r.preset} | ${cell(r.inf.calls, r.B.calls)} | ${cell(r.inf.triangles, r.B.triangles)} | ` +
    `${cell(r.inf.textures, r.B.textures)} | ${cell(r.inf.geometries, r.B.geometries)} | ${r.inf.programs} | ${r.console ?? '?'} |`);
}
console.log(`\nSMOKE: ${failures.length ? `${failures.length} problem(ów)` : 'OK'} — ${elapsed()}`);
process.exit(failures.length ? 1 : 0);
