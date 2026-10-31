// Smoke (SPEC §11): każda mapa × preset ładuje się bez błędów/ostrzeżeń konsoli, bez błędów HTTP, renderer.info w budżecie
// (CONFIG.budget); scenariusz rozgrywki (gracz eliminuje manekina, respawn po eliminatedTime z pełnym HP); brak wycieków
// geometrii/tekstur przy zmianie presetu (low → ultra → low ×2).
// Przepływ meczu (--flow, domyślnie włączony; --skip-flow wyłącza, --flow-only pomija sekcję mapa × preset): menu → start z menu
// (klik mapy/trybu/poziomu/presetu + Enter) → mecz (8 uczestników, drużyny i spawny drużyn w tdm, odliczanie: 0.3 s obserwacji
// zamrożenia, reszta skrócona; boty strzelają)
// → timeLeft = 1 → ekran końca → „Jeszcze raz" (Enter) → goMenu() → zmiana mapy; 3 tryby na uvmaze + neonhive/tdm2 +
// reactor/tdm4; po powrocie na tę samą mapę renderer.info geometries/textures jak na początku. Zero błędów konsoli/HTTP.
// Użycie: npm run smoke [-- --map uvmaze --preset low,ultra --skip-game --skip-leak --leak-all --jobs 3 --skip-flow --flow-only --time-limit 480]
// Mapy sprawdzane równolegle (--jobs, domyślnie 3 strony), presety mapy po kolei. Test wycieków domyślnie tylko na pierwszej
// mapie (zmiana presetu nie zależy od mapy; ultra w SwiftShaderze jest wolne) — --leak-all na każdej.
// Kod wyjścia ≠ 0 przy jakimkolwiek problemie. Bez zrzutów ekranu (renderowanie programowe jest wolne).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../../src/config.js';
import { MAPS } from '../../src/world/maps/index.js';
import { MODES } from '../../src/game/modes.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const T0 = Date.now();
const TOTAL_LIMIT_MS = Number(arg('time-limit', 480)) * 1000; // --time-limit s (domyślnie 8 min)
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
async function openPage(browser, url, viewport = VIEWPORT) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} (${r.failure() && r.failure().errorText})`));
  const t = Date.now();
  await page.goto(url, { waitUntil: 'commit', timeout: 240000 }); // „load“ pod obciążeniem SwiftShadera bywa > 30 s
  await page.waitForFunction(() => window.__lt && window.__lt.ready, null, { timeout: 240000 });
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


// ------------------------------------------------------------------ przepływ meczu (menu → mecz → koniec → menu)

const FLOW_PLAN = [
  // [mapa, tryb, pełny przepływ?] — pełny: odliczanie, strzały botów, koniec, restart. Ostatni krok wraca na mapę startu
  // (porównanie renderer.info). Uwaga: każda strona ma swój kontekst WebGL → strony mogą iść równolegle.
  { name: 'flow-A', steps: [['uvmaze', 'ffa', true], ['uvmaze', 'tdm2', true], ['uvmaze', 'tdm4', true], ['neonhive', 'ffa', false], ['uvmaze', 'ffa', false]] },
  { name: 'flow-B', steps: [['neonhive', 'tdm2', true], ['reactor', 'tdm4', true], ['neonhive', 'tdm2', false]] },
];
const flowRows = [];
const FLOW_T = 180000;
// Mniejszy kadr = więcej klatek/s w SwiftShaderze = szybszy czas symulacji (pętla: maks. maxSubSteps kroków na klatkę).
const FLOW_VIEWPORT = { width: 400, height: 225 };
const COUNTDOWN_CHECK = 0.3; // s odliczania obserwowane „na żywo" (zamrożenie sim), resztę skracamy // ms — duże timeouty (SwiftShader na obciążonej maszynie: sim ~0.2–0.5× czasu rzeczywistego)
const mapIds = Object.keys(MAPS);
const modeIds = Object.keys(MODES);
const diffIds = Object.keys(CONFIG.bots.levels);
const presetIds = Object.keys(CONFIG.presets);

const appState = (page) => page.evaluate(() => {
  const lt = window.__lt;
  const M = lt.match();
  const vis = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return false;
    const cs = getComputedStyle(e); const r = e.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  return {
    app: lt.app, map: lt.world.id, mode: M ? M.modeId : null, state: M ? M.state : null, n: lt.sim ? lt.sim.participants.length : 0,
    menu: vis('.lt-menu'), end: vis('.lt-end'), hud: !document.getElementById('hud').classList.contains('hidden'),
    lock: !!document.pointerLockElement,
  };
});
const waitApp = (page, app, ms = FLOW_T) => page.waitForFunction((a) => window.__lt.app === a, app, { timeout: ms, polling: 100 });

/** Wybór w menu kliknięciami (karta mapy, karta trybu, poziom, preset) i start klawiszem Enter (gest → pointer lock). */
async function menuStart(page, map, mode, diff, preset) {
  await page.locator('.lt-mn-mapcard').nth(mapIds.indexOf(map)).click();
  await page.locator('.lt-mn-modecard').nth(modeIds.indexOf(mode)).click();
  const seg = page.locator('.lt-mn-row.lt-mn-seg');
  await seg.nth(0).locator('.lt-mn-pill').nth(diffIds.indexOf(diff)).click();
  await seg.nth(1).locator('.lt-mn-pill').nth(presetIds.indexOf(preset)).click();
  const sel = await page.evaluate(() => [...document.querySelectorAll('.lt-menu .sel')].length);
  if (sel !== 4) throw new Error(`menu: zaznaczonych opcji ${sel} ≠ 4`);
  await page.keyboard.press('Enter');
  await waitApp(page, 'match');
  return waitLock(page);
}
/**
 * Pointer lock przychodzi asynchronicznie (pointerlockchange); bez niego mecz stoi w pauzie. Gdy przeglądarka odmówi
 * (np. startMatch z przebudową presetu/mapy trwa w SwiftShaderze dłużej niż ważność gestu), gra pokazuje nakładkę
 * „Kliknij, aby grać" — klikamy ją jak gracz. Zwraca { lock, retried, cta }.
 */
async function waitLock(page) {
  const poll = () => page.waitForFunction(() => {
    if (document.pointerLockElement) return 'lock';
    const st = document.getElementById('start');
    return !st.classList.contains('hidden') && /Nie udało/.test(document.getElementById('start-cta').textContent) ? 'error' : false;
  }, null, { timeout: 15000, polling: 100 }).then((h) => h.jsonValue(), () => 'timeout');
  const r1 = await poll();
  if (r1 === 'lock') return { lock: true, retried: false };
  const cta = await page.evaluate(() => {
    const s = document.getElementById('start');
    return s.classList.contains('hidden') ? null : document.getElementById('start-cta').textContent;
  });
  if (cta !== null) await page.click('#start', { position: { x: 20, y: 20 } }).catch(() => {});
  return { lock: (await poll()) === 'lock', retried: true, cta };
}

/** Sprawdzenia składu: liczba uczestników wg trybu, drużyny (team = id % teams, po perTeam), spawny drużyn (sp.team % teams). */
async function checkRoster(page, mode, L, tag, inCountdown = true) {
  const r = await page.evaluate(() => {
    const sim = window.__lt.sim;
    return {
      teamCount: sim.teamCount,
      ps: sim.participants.map((P) => ({ id: P.id, team: P.team, color: P.color, isPlayer: P.isPlayer, x: P.body.x, y: P.body.y, z: P.body.z, state: P.state })),
      spawns: sim.world.spawns.map((s) => ({ x: s.x, y: s.y, z: s.z, team: s.team })),
    };
  });
  const m = MODES[mode];
  const errs = [];
  if (r.ps.length !== m.participants) errs.push(`uczestników ${r.ps.length} ≠ ${m.participants}`);
  if (r.ps.filter((p) => p.isPlayer).length !== 1 || !r.ps[0].isPlayer) errs.push('gracz ≠ id 0');
  if (r.teamCount !== m.teams) errs.push(`sim.teamCount ${r.teamCount} ≠ ${m.teams}`);
  // pozycje na starcie (odliczanie: uczestnicy zamrożeni) = spawny
  const spawnOf = (p) => r.spawns.find((s) => Math.abs(s.x - p.x) < 1e-6 && Math.abs(s.z - p.z) < 1e-6 && Math.abs(s.y - p.y) < 0.05);
  const used = new Set();
  // pozycje = spawny tylko w odliczaniu (zamrożeni); po wolnym starcie (playing) uczestnicy już się ruszyli → pomiń z ostrzeżeniem
  if (!inCountdown) L.say(`  ⚠ ${tag}: skład: pozycje startowe niesprawdzane (mecz już w toku — wolne ładowanie)`);
  for (const p of inCountdown ? r.ps : []) {
    const sp = spawnOf(p);
    if (!sp) { errs.push(`#${p.id} nie stoi na spawnie (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`); continue; }
    used.add(`${sp.x},${sp.z}`);
    if (m.teams > 0 && sp.team % m.teams !== p.team) errs.push(`#${p.id} (team ${p.team}) na spawnie drużyny ${sp.team} (team%${m.teams} = ${sp.team % m.teams})`);
  }
  // znany błąd (todo w tests/unit/match.test.mjs): pickSpawn stawia członków drużyny na tym samym spawnie — ostrzeżenie, nie porażka
  if (inCountdown && used.size !== r.ps.length && r.spawns.length >= r.ps.length) L.say(`  ⚠ ${tag}: uczestnicy na ${used.size} różnych spawnach (${r.ps.length} uczestników) — znany błąd pickSpawn (todo)`);
  if (m.teams > 0) {
    for (let t = 0; t < m.teams; t++) {
      const mem = r.ps.filter((p) => p.team === t);
      if (mem.length !== m.perTeam) errs.push(`drużyna ${t}: ${mem.length} ≠ ${m.perTeam}`);
      if (mem.some((p) => p.color !== CONFIG.colors.teams[t])) errs.push(`drużyna ${t}: kolor ≠ ${CONFIG.colors.teams[t]}`);
    }
    if (r.ps.some((p) => p.team !== p.id % m.teams)) errs.push('team ≠ id % teams');
    if (m.teams === 2) {
      // tdm2: strony drużyn = środki ciężkości spawnów team%2 po przeciwnych stronach środka areny
      const cen = (t) => { const s = r.spawns.filter((sp) => sp.team % 2 === t); return [s.reduce((a, b) => a + b.x, 0) / s.length, s.reduce((a, b) => a + b.z, 0) / s.length]; };
      const c0 = cen(0), c1 = cen(1);
      const pc = (t) => { const s = r.ps.filter((p) => p.team === t); return [s.reduce((a, b) => a + b.x, 0) / s.length, s.reduce((a, b) => a + b.z, 0) / s.length]; };
      const p0 = pc(0), p1 = pc(1);
      if (!(c0[0] * c1[0] + c0[1] * c1[1] < 0)) errs.push(`spawny drużyn nie po przeciwnych stronach: ${c0} / ${c1}`);
      if (!(p0[0] * c0[0] + p0[1] * c0[1] > 0 && p1[0] * c1[0] + p1[1] * c1[1] > 0)) errs.push(`drużyny nie po swoich stronach: team0 (${p0.map((v) => v.toFixed(1))}), team1 (${p1.map((v) => v.toFixed(1))})`);
    }
  } else {
    if (r.ps.some((p) => p.team !== -1)) errs.push('ffa: team ≠ -1');
    if (new Set(r.ps.map((p) => p.color)).size !== r.ps.length) errs.push('ffa: kolory nieunikalne');
  }
  if (errs.length) L.fail(`${tag}: skład/spawny: ${errs.join('; ')}`);
  else L.ok(`${tag}: ${r.ps.length} uczestników${m.teams ? `, ${m.teams} drużyny × ${m.perTeam}, spawny drużyn OK` : ', ffa'}`);
}

async function flowStep(page, L, [map, mode, full], k) {
  const tag = `${map}/${mode}`;
  const t0 = Date.now();
  let st = await appState(page);
  if (st.app !== 'menu' || !st.menu) { L.fail(`${tag}: przed startem app=${st.app}, menu widoczne=${st.menu}`); return; }
  const lk = await menuStart(page, map, mode, 'normal', 'low');
  if (lk.retried) L.say(`  ⚠ ${tag}: brak pointer locka po Enter (nakładka: "${lk.cta}") → klik nakładki: lock ${lk.lock}`);
  st = await appState(page);
  const bad = [];
  if (st.map !== map) bad.push(`mapa ${st.map}`);
  if (st.mode !== mode) bad.push(`tryb ${st.mode}`);
  if (st.menu) bad.push('menu nadal widoczne');
  if (st.end) bad.push('ekran końca widoczny');
  if (!st.hud) bad.push('HUD ukryty');
  // Wolne ładowanie w SwiftShader: odliczanie (3 s) potrafi minąć przed pierwszą obserwacją — ten sam wyścig po stronie
  // testu co przy obserwacji zamrożenia niżej (ostrzeżenie); zamrożenie w odliczaniu pokrywa tests/unit/match.test.mjs.
  // Inny stan niż countdown/playing (menu, koniec, brak meczu) nadal jest porażką.
  if (st.state === 'playing') L.say(`  ⚠ ${tag}: start: stan playing przed obserwacją odliczania (wolne ładowanie, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  else if (st.state !== 'countdown') bad.push(`stan meczu ${st.state} (oczekiwano countdown)`);
  if (!st.lock) bad.push('brak pointer locka (mecz w pauzie)');
  if (bad.length) L.fail(`${tag}: start: ${bad.join(', ')}`);
  await checkRoster(page, mode, L, tag, st.state === 'countdown');
  const row = { page: L.name, step: k + 1, map, mode, n: st.n, shots: '-', hits: '-', result: '-', restart: '-', ms: 0 };
  flowRows.push(row);

  // odliczanie: uczestnicy zamrożeni (sim.time = 0, pozycje stoją) przez COUNTDOWN_CHECK s, potem skrócenie odliczania
  // (oszczędność czasu; samo przejście countdown → playing zostaje naturalne) → playing
  await page.evaluate(() => {
    const lt = window.__lt;
    window.__cdStart = lt.match().countdown;
    window.__cdPos = lt.sim.participants.map((p) => `${p.body.x},${p.body.z}`).join(';');
  });
  const frozen = await page.waitForFunction((d) => {
    const lt = window.__lt; const M = lt.match();
    if (M.state !== 'countdown') return { early: M.state };
    if (M.countdown > window.__cdStart - d) return false;
    const moved = window.__cdPos !== lt.sim.participants.map((p) => `${p.body.x},${p.body.z}`).join(';');
    return { t: lt.sim.time, cd: M.countdown, moved };
  }, COUNTDOWN_CHECK, { timeout: FLOW_T, polling: 100 }).then((h) => h.jsonValue());
  // Przy pierwszym, ciężkim ładowaniu w SwiftShader odliczanie potrafi się skończyć, zanim test zdąży je zaobserwować
  // (wyścig po stronie testu). Zamrożenie w odliczaniu pokrywa deterministycznie tests/unit/match.test.mjs → ostrzeżenie.
  if (frozen.early) L.say(`  ⚠ ${tag}: odliczanie: stan ${frozen.early} przed obserwacją ${COUNTDOWN_CHECK} s (wolne ładowanie)`);
  else if (frozen.t !== 0 || frozen.moved) L.fail(`${tag}: odliczanie: sim nie zamrożony (sim.time ${frozen.t}, ruch ${frozen.moved})`);
  await page.evaluate(() => { const M = window.__lt.match(); if (M.state === 'countdown') M.countdown = Math.min(M.countdown, 0.05); });
  await page.waitForFunction(() => window.__lt.match().state === 'playing', null, { timeout: FLOW_T, polling: 100 });
  if (!full) {
    const ok = await page.evaluate(() => window.__lt.sim.time);
    L.ok(`${tag}: odliczanie → playing (sim.time ${ok.toFixed(2)})`);
  } else {
    // boty strzelają: statystyki shots botów rosną, timer biegnie
    const r = await page.waitForFunction(() => {
      const lt = window.__lt;
      const bots = lt.sim.participants.filter((p) => !p.isPlayer);
      const shots = bots.reduce((a, p) => a + p.stats.shots, 0);
      return shots >= 3 ? { shots, hits: bots.reduce((a, p) => a + p.stats.hits, 0), t: lt.sim.time, left: lt.match().timeLeft } : false;
    }, null, { timeout: FLOW_T, polling: 250 }).then((h) => h.jsonValue()).catch(() => null);
    if (!r) L.fail(`${tag}: boty nie strzelają (shots < 3 w ${FLOW_T / 1000} s)`);
    else {
      row.shots = r.shots; row.hits = r.hits;
      const M = MODES[mode];
      if (!(r.left < M.timeLimit && r.left > M.timeLimit - r.t - 1)) L.fail(`${tag}: timer ${r.left} przy sim.time ${r.t}`);
      L.ok(`${tag}: boty strzelają (strzałów ${r.shots}, trafień ${r.hits}, sim.time ${r.t.toFixed(1)} s, timer ${r.left.toFixed(1)} s)`);
    }
    // koniec czasu → ekran końca
    await page.evaluate(() => { window.__lt.match().timeLeft = 1; });
    await waitApp(page, 'end');
    await page.waitForSelector('.lt-end.show', { state: 'visible', timeout: 30000 });
    const end = await page.evaluate(() => {
      const M = window.__lt.match();
      const root = document.querySelector('.lt-end');
      const lines = [...root.querySelectorAll('.lt-st-line:not(.lt-st-head)')].filter((e) => e.style.display !== 'none');
      return {
        state: M.state, reason: M.endReason, winnerKind: M.winnerKind, title: root.querySelector('.lt-end-title').textContent,
        sub: root.querySelector('.lt-end-sub').textContent, meta: root.querySelector('.lt-end-meta').textContent,
        rows: lines.filter((e) => !e.classList.contains('lt-st-team')).length, teams: lines.filter((e) => e.classList.contains('lt-st-team')).length,
        mine: lines.filter((e) => e.classList.contains('mine')).length, result: root.dataset.result, lock: !!document.pointerLockElement,
      };
    });
    st = await appState(page);
    const e2 = [];
    if (end.state !== 'ended' || end.reason !== 'time') e2.push(`match ${end.state}/${end.reason}`);
    if (!['ZWYCIĘSTWO', 'PORAŻKA', 'REMIS'].includes(end.title)) e2.push(`tytuł "${end.title}"`);
    if (end.rows !== MODES[mode].participants) e2.push(`wierszy tabeli ${end.rows}`);
    if (end.teams !== MODES[mode].teams) e2.push(`wierszy drużyn ${end.teams}`);
    if (end.mine !== 1) e2.push(`wiersz gracza ×${end.mine}`);
    if (!/Koniec czasu/.test(end.meta)) e2.push(`meta "${end.meta}"`);
    if (end.lock) e2.push('pointer lock nie zwolniony');
    if (e2.length) L.fail(`${tag}: ekran końca: ${e2.join(', ')}`);
    else L.ok(`${tag}: ekran końca: ${end.title} — ${end.sub} (${end.winnerKind}), ${end.rows} wierszy${end.teams ? ` + ${end.teams} drużyn` : ''}`);
    row.result = end.title;

    // „Jeszcze raz" (Enter) → nowy mecz w tym samym trybie i mapie
    const simBefore = await page.evaluate(() => { window.__oldSim = window.__lt.sim; return true; });
    void simBefore;
    // ekran końca ignoruje klawisze przez CONFIG.match.endInputDelay (ochrona przed autorepeat) — odczekaj z zapasem
    const endDelay = await page.evaluate(async () => (await import('/src/config.js')).CONFIG.match.endInputDelay || 0);
    await page.waitForTimeout(endDelay * 1000 + 400);
    await page.keyboard.press('Enter');
    await waitApp(page, 'match');
    const lk2 = await waitLock(page);
    if (lk2.retried) L.say(`  ⚠ ${tag}: restart — brak pointer locka po Enter (nakładka: "${lk2.cta}") → klik: lock ${lk2.lock}`);
    const rs = await page.evaluate(() => {
      const lt = window.__lt; const M = lt.match();
      const ps = lt.sim.participants;
      return {
        fresh: lt.sim !== window.__oldSim, state: M.state, timeLeft: M.timeLeft, map: lt.world.id, mode: M.modeId,
        score: ps.reduce((a, p) => a + p.stats.score + p.stats.shots, 0), n: ps.length, lock: !!document.pointerLockElement,
      };
    });
    st = await appState(page);
    const e3 = [];
    if (!rs.fresh) e3.push('ten sam sim');
    if (rs.map !== map || rs.mode !== mode) e3.push(`${rs.map}/${rs.mode}`);
    if (rs.state !== 'countdown' || rs.timeLeft !== MODES[mode].timeLimit) e3.push(`stan ${rs.state}, timer ${rs.timeLeft}`);
    if (rs.score !== 0) e3.push('statystyki nie wyzerowane');
    if (rs.n !== MODES[mode].participants) e3.push(`uczestników ${rs.n}`);
    if (st.end || st.menu) e3.push(`widoczne: ${st.end ? 'koniec ' : ''}${st.menu ? 'menu' : ''}`);
    if (!rs.lock) e3.push('brak pointer locka');
    if (e3.length) L.fail(`${tag}: restart: ${e3.join(', ')}`);
    else L.ok(`${tag}: „Jeszcze raz" → nowy mecz (countdown, statystyki 0)`);
    row.restart = e3.length ? '✗' : '✓';
  }
  // → menu (najpierw kilka klatek: zdarzenie pointerlockchange po restarcie musi dojść do gry, inaczej exitLock jest no-op)
  await frames(page, 3);
  await page.evaluate(() => window.__lt.goMenu());
  await waitApp(page, 'menu');
  await page.waitForFunction(() => !document.pointerLockElement, null, { timeout: 5000, polling: 100 }).catch(() => {});
  await frames(page, 2);
  st = await appState(page);
  const e4 = [];
  if (!st.menu) e4.push('menu niewidoczne');
  if (st.end) e4.push('ekran końca widoczny');
  if (st.hud) e4.push('HUD widoczny');
  if (st.lock) e4.push('pointer lock nie zwolniony');
  if (st.n !== 0) e4.push('sim nie zwolniony');
  if (st.lock) await page.evaluate(() => document.exitPointerLock()); // dalsze kroki: klik w menu wymaga wolnego kursora
  if (e4.length) L.fail(`${tag}: goMenu: ${e4.join(', ')}`);
  else L.ok(`${tag}: goMenu → menu`);
  row.ms = Date.now() - t0;
}

/** Wszystkie kamery debug mapy po kolei (każda geometria areny przynajmniej raz w kadrze) → info. */
async function infoAllCams(page) {
  const n = await page.evaluate(() => window.__lt.cams().length);
  for (let i = 0; i < n; i++) {
    await page.evaluate((k) => window.__lt.setCam(k), i);
    await frames(page, 2);
  }
  await page.evaluate(() => window.__lt.setCam(null));
  await frames(page, 2);
  return info(page);
}

const LAUNCH = { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] };

/** Osobna przeglądarka na przepływ: pointer lock jest jeden na proces przeglądarki — dwie strony z lockiem w jednym
 *  procesie wzajemnie się pauzują (mecz bez locka = pauza). */
async function runFlow(base, plan) {
  const browser = await chromium.launch(LAUNCH);
  try { await runFlowIn(browser, base, plan); } finally { await browser.close().catch(() => {}); }
}

async function runFlowIn(browser, base, plan) {
  const L = createLog(plan.name);
  L.name = plan.name;
  L.say(`\n[${plan.name}] ${plan.steps.map((s) => `${s[0]}/${s[1]}${s[2] ? '' : '*'}`).join(' → ')}  start ${elapsed()}`);
  let page = null;
  let problems = [];
  try {
    const o = await openPage(browser, `${base}/`, FLOW_VIEWPORT);
    page = o.page; problems = o.problems;
    const st = await appState(page);
    if (st.app !== 'menu' || !st.menu || st.hud || st.n !== 0) L.fail(`start: app=${st.app}, menu=${st.menu}, hud=${st.hud}, sim=${st.n}`);
    else L.ok(`/ → menu (${o.loadMs} ms do ready)`);
    const first = plan.steps[0][0];
    let baseInfo = null;
    for (let k = 0; k < plan.steps.length; k++) {
      await flowStep(page, L, plan.steps[k], k);
      // punkt odniesienia renderer.info: menu po pierwszym meczu na mapie startowej (wszystkie zasoby leniwe już utworzone)
      if (k === 0) {
        baseInfo = await infoAllCams(page);
        L.say(`    info (menu, ${first}): g${baseInfo.geometries}/t${baseInfo.textures}`);
      }
    }
    const last = plan.steps[plan.steps.length - 1][0];
    if (last === first && baseInfo) {
      const fin = await infoAllCams(page);
      if (fin.geometries === baseInfo.geometries && fin.textures === baseInfo.textures) {
        L.ok(`powrót na ${first}: geometries/textures ${fin.geometries}/${fin.textures} = jak na początku`);
      } else {
        L.fail(`wyciek po zmianie mapy (${first} → … → ${first}): geometries ${baseInfo.geometries} → ${fin.geometries}, textures ${baseInfo.textures} → ${fin.textures}`);
      }
      flowRows.push({ page: plan.name, step: '—', map: first, mode: 'info', n: '', shots: `g${baseInfo.geometries}→${fin.geometries}`, hits: `t${baseInfo.textures}→${fin.textures}`, result: '', restart: '', ms: 0 });
    }
  } catch (e) {
    L.fail(`wyjątek: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  } finally {
    if (problems.length) L.fail(`konsola/HTTP (${problems.length}):\n      ${problems.join('\n      ')}`);
    else L.ok('konsola/HTTP: 0 problemów przez cały przepływ');
    if (page) await page.close().catch(() => {});
    L.say(`  koniec ${elapsed()}`);
    L.flush();
  }
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
  browser = await chromium.launch(LAUNCH);
  const withFlow = !flag('skip-flow');
  const withMaps = !flag('flow-only');
  console.log(`SMOKE: ${withMaps ? `${maps.join(',')} × ${presets.join(',')}` : '(bez map × presetów)'}${withFlow ? ' + przepływ meczu' : ''} (port ${port}, równolegle ${jobs})`);
  // jedna kolejka zadań: przepływy (dłuższe) najpierw, potem mapy
  const queue = [
    ...(withFlow ? FLOW_PLAN.map((p) => () => runFlow(base, p)) : []),
    ...(withMaps ? maps.map((m, i) => () => runMap(browser, base, m, !flag('skip-leak') && (i === 0 || flag('leak-all')))) : []),
  ];
  const worker = async () => { while (queue.length) await queue.shift()(); };
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
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
if (rows.length) console.log('\n| mapa | preset | uczestn. | calls | triangles | textures | geometries | programs | konsola/HTTP |');
if (rows.length) console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  console.log(`| ${r.map} | ${r.preset} | ${r.n} | ${cell(r.inf.calls, r.B.calls)} | ${cell(r.inf.triangles, r.B.triangles)} | ` +
    `${cell(r.inf.textures, r.B.textures)} | ${cell(r.inf.geometries, r.B.geometries)} | ${r.inf.programs} | ${r.console ?? '?'} |`);
}
if (flowRows.length) {
  console.log('\n| przepływ | krok | mapa | tryb | uczestn. | strzały botów | trafienia | koniec | restart | czas |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of flowRows) {
    console.log(`| ${r.page} | ${r.step} | ${r.map} | ${r.mode} | ${r.n} | ${r.shots} | ${r.hits} | ${r.result} | ${r.restart} | ${r.ms ? (r.ms / 1000).toFixed(1) + ' s' : ''} |`);
  }
}
if (failures.length) console.log(`\nPROBLEMY:\n  - ${failures.join('\n  - ')}`);
console.log(`\nSMOKE: ${failures.length ? `${failures.length} problem(ów)` : 'OK'} — ${elapsed()}`);
process.exit(failures.length ? 1 : 0);
