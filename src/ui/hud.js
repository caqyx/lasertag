// HUD gracza (SPEC §9, PLAN §7.7). createHud(rootEl) → { update(player, sim, dt), dispose() }
// DOM budowany raz w rootEl (#hud). update() porównuje z poprzednimi wartościami (cache) i dotyka DOM
// tylko przy zmianie. Zdarzenia czytane z sim.events (count/at(i)) — kolejkę czyści main po klatce.
// Elementy: 4 segmenty HP (kolor gracza, błysk przy utracie), pasek ciepła (+ ostrzeżenie, PRZEGRZANIE),
// hitmarker, wskaźnik kierunku obrażeń (łuk wokół celownika), ekran eliminacji z odliczaniem,
// wskaźnik ochrony, feed eliminacji (ostatnie N, znikają), wynik gracza, hit stun (P.stunTimer > 0 → „FAZER OFF”).
import { CONFIG } from '../config.js';
import { EV } from '../core/events.js';
import { findParticipant } from '../game/sim.js';
import { el } from './dom.js';

const H = CONFIG.hud;
const MAX_HP = CONFIG.combat.maxHp;

// kwantyzacja do kroku — mniej zapisów do DOM przy płynnych wartościach
function q(v, step) { return Math.round(v / step) * step; }

export function createHud(rootEl) {
  const root = el(rootEl, 'lt-hud');

  // --- środek: hitmarker, kierunek obrażeń, ochrona
  const center = el(root, 'lt-center');
  const hit = el(center, 'lt-hitmarker');
  for (let i = 0; i < 4; i++) el(hit, 'lt-hm lt-hm' + i);
  const dmg = el(center, 'lt-dmgdir');
  el(dmg, 'lt-dmgarc');
  // hit stun (P.stunTimer > 0): krótki napis + pasek pod celownikiem
  const stun = el(root, 'lt-stun');
  el(stun, 'lt-stun-label', 'FAZER OFF');
  const stunBar = el(el(stun, 'lt-stun-track'), 'lt-stun-fill');
  const protect = el(root, 'lt-protect');
  el(protect, 'lt-protect-label', 'OCHRONA');
  const protectBar = el(el(protect, 'lt-protect-track'), 'lt-protect-fill');

  // --- lewy dół: kamizelka (HP) + wynik
  const vitals = el(root, 'lt-vitals');
  el(vitals, 'lt-label', 'KAMIZELKA');
  const segWrap = el(vitals, 'lt-segs');
  const segs = [];
  for (let i = 0; i < MAX_HP; i++) segs.push(el(segWrap, 'lt-seg'));
  const scoreRow = el(vitals, 'lt-score');
  el(scoreRow, 'lt-label', 'WYNIK');
  const scoreVal = el(scoreRow, 'lt-score-val', '0');

  // --- prawy dół: ciepło
  const heat = el(root, 'lt-heat');
  const heatHead = el(heat, 'lt-heat-head');
  el(heatHead, 'lt-label', 'CIEPŁO');
  el(heatHead, 'lt-heat-warn', 'PRZEGRZANIE');
  el(heatHead, 'lt-heat-stun', 'FAZER OFF');
  const heatFill = el(el(heat, 'lt-heat-track'), 'lt-heat-fill');

  // --- prawa góra: feed eliminacji
  const feed = el(root, 'lt-feed');
  const rows = [];
  for (let i = 0; i < H.feedSize; i++) {
    const r = el(feed, 'lt-feed-row');
    rows.push({ row: r, k: el(r, 'lt-feed-name'), icon: el(r, 'lt-feed-icon', '▸'), v: el(r, 'lt-feed-name'), op: -1 });
  }
  const feedKiller = new Array(H.feedSize).fill('');
  const feedVictim = new Array(H.feedSize).fill('');
  const feedKC = new Array(H.feedSize).fill('');
  const feedVC = new Array(H.feedSize).fill('');
  const feedMine = new Uint8Array(H.feedSize);
  const feedT = new Float64Array(H.feedSize).fill(-1e9);
  let feedDirty = true;

  // --- eliminacja
  const elim = el(root, 'lt-elim');
  el(elim, 'lt-elim-title', 'WYELIMINOWANY');
  const elimBy = el(elim, 'lt-elim-by');
  const elimCount = el(elim, 'lt-elim-count');

  // --- cache stanu (wartości ostatnio zapisane do DOM)
  let t = 0;
  let cColor = null, cHp = -1, cScore = -1, cHeat = -1, cWarn = -1, cOver = -1;
  let cDead = -1, cElimBy = -2, cCount = -1, cProt = -1, cProtW = -1;
  let cHitOp = -1, cHitKill = -1, cDmgOp = -1, cDmgAng = 1e9;
  let cStun = -1, cStunW = -1, stunPeak = 0;
  let hitT = 0, hitKill = 0, dmgT = 0, lastHitTime = -1e9;
  const segFlashT = new Float32Array(MAX_HP);
  const segState = new Int8Array(MAX_HP).fill(-1); // 0 off, 1 on, 2 błysk

  function pushFeed(killer, victim, mine) {
    for (let i = H.feedSize - 1; i > 0; i--) {
      feedKiller[i] = feedKiller[i - 1]; feedVictim[i] = feedVictim[i - 1];
      feedKC[i] = feedKC[i - 1]; feedVC[i] = feedVC[i - 1];
      feedMine[i] = feedMine[i - 1]; feedT[i] = feedT[i - 1];
    }
    feedKiller[0] = killer ? killer.name : '?';
    feedKC[0] = killer ? killer.color : '#ffffff';
    feedVictim[0] = victim ? victim.name : '?';
    feedVC[0] = victim ? victim.color : '#ffffff';
    feedMine[0] = mine;
    feedT[0] = t;
    feedDirty = true;
  }

  function readEvents(player, sim) {
    const Q = sim.events;
    if (!Q) return;
    const id = player.id;
    for (let i = 0; i < Q.count; i++) {
      const e = Q.at(i);
      if (e.type === EV.HIT) {
        if (e.a === id && e.b !== id) { hitT = H.hitmarkerTime; }
      } else if (e.type === EV.ELIM) {
        if (e.a === id && e.b !== id) { hitT = H.hitmarkerTime * 1.6; hitKill = 1; }
        pushFeed(findParticipant(sim, e.a), findParticipant(sim, e.b), e.a === id || e.b === id ? 1 : 0);
      }
    }
  }

  function updateVitals(player) {
    if (player.color !== cColor) {
      cColor = player.color;
      root.style.setProperty('--pc', cColor);
    }
    const hp = player.state === 'eliminated' ? 0 : player.hp;
    if (hp !== cHp) {
      // utracone segmenty błyskają
      if (cHp > hp) for (let i = Math.max(0, hp); i < cHp && i < MAX_HP; i++) segFlashT[i] = H.hpFlashTime;
      cHp = hp;
    }
    for (let i = 0; i < MAX_HP; i++) {
      let s = i < hp ? 1 : 0;
      if (segFlashT[i] > 0) s = 2;
      if (s !== segState[i]) {
        segState[i] = s;
        segs[i].className = s === 1 ? 'lt-seg on' : s === 2 ? 'lt-seg flash' : 'lt-seg';
      }
    }
    const sc = player.stats ? player.stats.score : 0;
    if (sc !== cScore) { cScore = sc; scoreVal.textContent = String(sc); }
  }

  function updateHeat(player) {
    const W = player.weapon;
    const h = W ? q(Math.min(1, Math.max(0, W.heat)), 0.01) : 0;
    if (h !== cHeat) { cHeat = h; heatFill.style.transform = 'scaleX(' + h + ')'; }
    const over = W && W.overheated ? 1 : 0;
    const warn = !over && h > H.heatWarn ? 1 : 0;
    if (warn !== cWarn) { cWarn = warn; heat.classList.toggle('warn', warn === 1); }
    if (over !== cOver) { cOver = over; heat.classList.toggle('over', over === 1); }
  }

  function updateStun(player) {
    const st = player.state === 'alive' && player.stunTimer > 0 ? player.stunTimer : 0;
    if (st > stunPeak) stunPeak = st;          // początek stunu (lub przedłużenie) — długość całkowita bez zależności od CONFIG
    const on = st > 0 ? 1 : 0;
    if (!on) stunPeak = 0;
    if (on !== cStun) {
      cStun = on;
      stun.classList.toggle('show', on === 1);
      heat.classList.toggle('stun', on === 1);
    }
    if (on) {
      const w = q(st / stunPeak, 0.05);
      if (w !== cStunW) { cStunW = w; stunBar.style.transform = 'scaleX(' + w + ')'; }
    }
  }

  function updateCenter(player) {
    // hitmarker
    const hop = hitT > 0 ? q(Math.min(1, hitT / (H.hitmarkerTime * 0.5)), 0.1) : 0;
    if (hop !== cHitOp) { cHitOp = hop; hit.style.opacity = String(hop); }
    if (hitT <= 0) hitKill = 0;
    if (hitKill !== cHitKill) { cHitKill = hitKill; hit.classList.toggle('kill', hitKill === 1); }

    // kierunek obrażeń: lastHitDir = kierunek XZ od gracza do strzelca
    if (player.lastHitTime !== lastHitTime) {
      lastHitTime = player.lastHitTime;
      if (player.lastHitDirX !== 0 || player.lastHitDirZ !== 0) dmgT = H.dmgDirTime;
    }
    const dop = dmgT > 0 ? q(Math.min(1, dmgT / (H.dmgDirTime * 0.6)), 0.05) : 0;
    if (dop !== cDmgOp) { cDmgOp = dop; dmg.style.opacity = String(dop); }
    if (dop > 0) {
      const yaw = player.body.yaw;
      const s = Math.sin(yaw), c = Math.cos(yaw);
      const dx = player.lastHitDirX, dz = player.lastHitDirZ;
      // prawo = (cos, −sin), przód = (−sin, −cos) (PLAN §0)
      const right = dx * c - dz * s;
      const fwd = -dx * s - dz * c;
      const ang = q(Math.atan2(right, fwd) * 57.29578, 2);
      if (ang !== cDmgAng) { cDmgAng = ang; dmg.style.transform = 'rotate(' + ang + 'deg)'; }
    }

    // ochrona
    const pt = player.state === 'alive' ? player.protectTimer : 0;
    const prot = pt > 0 ? 1 : 0;
    if (prot !== cProt) { cProt = prot; protect.classList.toggle('show', prot === 1); }
    if (prot) {
      const w = q(Math.min(1, pt / CONFIG.combat.protectionTime), 0.02);
      if (w !== cProtW) { cProtW = w; protectBar.style.transform = 'scaleX(' + w + ')'; }
    }
  }

  function updateElim(player, sim) {
    const dead = player.state === 'eliminated' ? 1 : 0;
    if (dead !== cDead) {
      cDead = dead;
      root.classList.toggle('dead', dead === 1);
      rootEl.classList.toggle('lt-dead', dead === 1);
    }
    if (!dead) return;
    const by = player.lastHitBy;
    if (by !== cElimBy) {
      cElimBy = by;
      const k = by >= 0 && by !== player.id ? findParticipant(sim, by) : null;
      if (k) {
        elimBy.textContent = 'przez ' + k.name;
        elimBy.style.color = k.color;
      } else {
        elimBy.textContent = '';
      }
    }
    const n = Math.max(0, Math.ceil(player.stateTimer));
    if (n !== cCount) { cCount = n; elimCount.textContent = n > 0 ? 'powrót za ' + n : 'powrót…'; }
  }

  function updateFeed() {
    for (let i = 0; i < H.feedSize; i++) {
      const r = rows[i];
      const age = t - feedT[i];
      let op = 0;
      if (age < H.feedTime && feedKiller[i] !== '') {
        op = age > H.feedTime - H.feedFade ? q((H.feedTime - age) / H.feedFade, 0.1) : 1;
      }
      if (feedDirty) {
        r.k.textContent = feedKiller[i]; r.k.style.color = feedKC[i];
        r.v.textContent = feedVictim[i]; r.v.style.color = feedVC[i];
        r.row.classList.toggle('mine', feedMine[i] === 1);
      }
      if (op !== r.op) {
        r.op = op;
        r.row.style.opacity = String(op);
        r.row.style.display = op > 0 ? 'flex' : 'none';
      }
    }
    feedDirty = false;
  }

  function update(player, sim, dt) {
    t += dt;
    if (hitT > 0) hitT -= dt;
    if (dmgT > 0) dmgT -= dt;
    for (let i = 0; i < MAX_HP; i++) if (segFlashT[i] > 0) segFlashT[i] -= dt;
    readEvents(player, sim);
    updateVitals(player);
    updateHeat(player);
    updateStun(player);
    updateCenter(player);
    updateElim(player, sim);
    updateFeed();
  }

  function dispose() {
    root.remove();
    rootEl.classList.remove('lt-dead');
  }

  return { update, dispose };
}
