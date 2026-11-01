// Menu startowe (PLAN §9.2): zakładki SOLO / MULTIPLAYER, mapa (karty z paletą), tryb (z opisem),
// [MULTIPLAYER → Custom: liczba drużyn, osób w drużynie], poziom botów, preset grafiki, „GRAJ".
// Klawiatura: ↑/↓ (W/S) wiersz, ←/→ (A/D) wybór, Enter — start. Mysz: klik wybiera, klik „GRAJ" startuje.
// Wiersze ukryte (np. Custom w zakładce SOLO) i opcje wyłączone (osób w drużynie ponad limit) są pomijane.
import { el } from './dom.js';
import { teamColor, customMode, customTeamRange, customMaxPerTeam, clampCustom } from '../game/modes.js';
import { CONFIG } from '../config.js';

const DIFF_LABELS = { easy: ['ŁATWY', 'Wolne reakcje, duży rozrzut'], normal: ['NORMALNY', 'Strafe i osłony'], hard: ['TRUDNY', 'Szybcy, celni, bezlitośni'] };
const WEAPON_LABELS = {
  phaser: ['HITSCAN', 'Ogień ciągły, zasięg 50 m, przegrzewanie'],
  pistol: ['SERIA ×2', 'Klik = 2 szybkie strzały, ½ segmentu każdy, zasięg 16 m'],
  bouncer: ['ODBICIE', 'Wolny impuls, odbija się raz od ściany — trafia zza rogu'],
};
const PRESET_LABELS = { low: 'NISKI', medium: 'ŚREDNI', high: 'WYSOKI', ultra: 'ULTRA' };

function toList(src) {
  if (!src) return [];
  if (Array.isArray(src)) return src;
  return Object.keys(src).map((k) => (typeof src[k] === 'object' && src[k] !== null ? { id: k, ...src[k] } : { id: k }));
}

function idsOf(list) { return list.map((x) => (typeof x === 'string' ? x : x.id)); }

const GROUP_LABELS = { solo: ['SOLO', 'Ty kontra boty · FFA i drużyny'], mp: ['MULTIPLAYER', 'Custom · lokalnie z botami (online wkrótce)'] };

/** „1 bot", „3 boty", „12 botów" (polska odmiana). */
function botsLabel(n) {
  const d = n % 10, dd = n % 100;
  return n + (n === 1 ? ' bot' : d >= 2 && d <= 4 && (dd < 12 || dd > 14) ? ' boty' : ' botów');
}

/** Kropki składu trybu (podgląd drużyn). wrap: istniejący kontener (odświeżenie) albo nowy w parent. */
function rosterDots(parent, mode, wrap = el(parent, 'lt-mn-dots')) {
  wrap.textContent = '';
  if (mode.teams > 0) {
    for (let t = 0; t < mode.teams; t++) {
      const g = el(wrap, 'lt-mn-dotgroup');
      for (let i = 0; i < mode.perTeam; i++) el(g, 'lt-mn-dot').style.setProperty('--c', teamColor(t));
    }
  } else {
    const g = el(wrap, 'lt-mn-dotgroup');
    const c = CONFIG.colors.ffa;
    for (let i = 0; i < mode.participants; i++) el(g, 'lt-mn-dot').style.setProperty('--c', c[i % c.length]);
  }
}

/**
 * @param {HTMLElement} rootEl
 * @param {{ maps, modes, presets, diffs, initial? }} opts
 *   maps: MAPS (obiekt id → MapData) lub tablica MapData; modes: MODES; presets: CONFIG.presets lub tablica id;
 *   diffs: CONFIG.bots.levels lub tablica id; mpModes: MP_MODES (zakładka MULTIPLAYER; brak → bez zakładek);
 *   initial: { map, mode, diff, preset, bots, teams, perTeam }
 * @param {(cfg:{ map, mode, diff, preset, bots, teams, perTeam }) => void} onStart
 */
export function createMenu(rootEl, opts, onStart) {
  const maps = toList(opts.maps);
  const modes = toList(opts.modes);
  const mpModes = toList(opts.mpModes);
  const presets = idsOf(toList(opts.presets));
  const diffs = idsOf(toList(opts.diffs));
  const init = opts.initial || {};

  const root = el(rootEl, 'lt-menu');
  const inner = el(root, 'lt-mn-inner');

  // --- tytuł
  const head = el(inner, 'lt-mn-head');
  const h1 = el(head, 'lt-mn-title', null, 'h1');
  el(h1, 'lt-mn-t1', 'LASER', 'span');
  el(h1, 'lt-mn-t2', 'TAG', 'span');
  el(head, 'lt-mn-tagline', 'ARENA · NEON · UV · DYM');

  const rows = []; // { key, el, items: [{el, value}], index }

  function section(key, label, cls, parent = inner) {
    const sec = el(parent, 'lt-mn-row ' + cls);
    sec.dataset.key = key;
    const lab = el(sec, 'lt-mn-label');
    el(lab, 'lt-mn-label-txt', label, 'span');
    el(lab, 'lt-mn-label-keys', '← →', 'span');
    const list = el(sec, 'lt-mn-options');
    const row = { key, el: sec, list, items: [], index: 0, hidden: false, onChange: null };
    rows.push(row);
    sec.addEventListener('mouseenter', () => setRow(rows.indexOf(row)));
    return row;
  }

  function addItem(row, value, node) {
    const idx = row.items.length;
    row.items.push({ el: node, value, off: false });
    node.setAttribute('role', 'option');
    node.addEventListener('click', () => {
      setRow(rows.indexOf(row));
      select(row, idx);
    });
  }

  // --- SOLO / MULTIPLAYER
  const rGroup = mpModes.length > 0 ? section('group', 'GRA', 'lt-mn-tabs') : null;
  if (rGroup !== null) {
    for (const g of ['solo', 'mp']) {
      const b = el(rGroup.list, 'lt-mn-pill lt-mn-tab');
      el(b, 'lt-mn-pill-name', GROUP_LABELS[g][0]);
      el(b, 'lt-mn-pill-desc', GROUP_LABELS[g][1]);
      addItem(rGroup, g, b);
    }
  }

  // --- mapa
  const rMap = section('map', 'MAPA', 'lt-mn-maps');
  for (const m of maps) {
    const card = el(rMap.list, 'lt-mn-card lt-mn-mapcard');
    const p = m.palette || {};
    card.style.setProperty('--c', p.primary || '#22e8ff');
    card.style.setProperty('--c2', p.secondary || '#ff2bd6');
    const bar = el(card, 'lt-mn-palette');
    for (const k of ['primary', 'secondary', 'uv', 'accent']) {
      if (p[k]) el(bar, 'lt-mn-swatch').style.setProperty('--c', p[k]);
    }
    el(card, 'lt-mn-card-name', m.name || m.id);
    const info = m.size ? Math.round(m.size.w) + ' × ' + Math.round(m.size.d) + ' m' : '';
    el(card, 'lt-mn-card-desc', info + (m.ceiling ? ' · sufit ' + m.ceiling + ' m' : ''));
    addItem(rMap, m.id, card);
  }

  // --- tryb
  const rMode = section('mode', 'TRYB', 'lt-mn-modes');
  for (const m of modes) {
    const card = el(rMode.list, 'lt-mn-card lt-mn-modecard');
    const top = el(card, 'lt-mn-card-top');
    el(top, 'lt-mn-card-tag', m.short || m.id);
    rosterDots(top, m);
    el(card, 'lt-mn-card-name', m.name || m.id);
    el(card, 'lt-mn-card-desc', m.desc || '');
    addItem(rMode, m.id, card);
  }

  // --- MULTIPLAYER: tryb (Custom) + skład
  const range = customTeamRange();
  const maxPer = customMaxPerTeam(range.min);
  let rMp = null, rTeams = null, rPer = null, mpPair = null;
  const customCards = [];   // { name, desc, dots }
  if (mpModes.length > 0) {
    rMp = section('mpmode', 'TRYB · MULTIPLAYER', 'lt-mn-modes lt-mn-mp');
    for (const m of mpModes) {
      const card = el(rMp.list, 'lt-mn-card lt-mn-modecard lt-mn-mpcard');
      const top = el(card, 'lt-mn-card-top');
      el(top, 'lt-mn-card-tag', m.id === 'custom' ? 'CUSTOM' : (m.short || m.id));
      const dots = el(top, 'lt-mn-dots');
      rosterDots(top, m, dots);
      const name = el(card, 'lt-mn-card-name', m.name || m.id);
      const desc = el(card, 'lt-mn-card-desc', m.desc || '');
      if (m.id === 'custom') customCards.push({ name, desc, dots });
      addItem(rMp, m.id, card);
    }
    el(rMp.list, 'lt-mn-mpnote', 'Sloty drużyn zajmują boty — w trybie online (M5) zastąpią je gracze sieciowi.');

    mpPair = el(inner, 'lt-mn-pair');   // DRUŻYNY | OSÓB W DRUŻYNIE w jednej linii
    rTeams = section('teams', 'DRUŻYNY', 'lt-mn-seg lt-mn-mp', mpPair);
    for (let t = range.min; t <= range.max; t++) {
      const b = el(rTeams.list, 'lt-mn-pill');
      el(b, 'lt-mn-pill-name', String(t));
      const sw = el(b, 'lt-mn-pill-desc lt-mn-teamsw');
      for (let k = 0; k < t; k++) el(sw, 'lt-mn-dot').style.setProperty('--c', teamColor(k));
      addItem(rTeams, t, b);
    }

    rPer = section('per', 'OSÓB W DRUŻYNIE', 'lt-mn-seg lt-mn-mp', mpPair);
    for (let p = CONFIG.modes.custom.minPerTeam; p <= maxPer; p++) {
      const b = el(rPer.list, 'lt-mn-pill');
      el(b, 'lt-mn-pill-name', String(p));
      addItem(rPer, p, b);
    }
    rTeams.onChange = () => refreshCustom();
    rPer.onChange = () => refreshCustom();
  }

  /** Limit osób w drużynie wg liczby drużyn (opcje ponad limit wyłączone) + podgląd składu na karcie Custom. */
  function refreshCustom() {
    if (rTeams === null) return;
    const teams = valueOf('teams');
    const max = customMaxPerTeam(teams);
    let changed = false;
    for (const it of rPer.items) {
      const off = it.value > max;
      if (off !== it.off) { it.off = off; it.el.classList.toggle('lt-mn-off', off); changed = true; }
    }
    if (changed && rPer.items[rPer.index].off) select(rPer, indexOf(rPer, max));
    const m = customMode(teams, valueOf('per'));
    for (const c of customCards) {
      rosterDots(null, m, c.dots);
      c.name.textContent = 'Custom · ' + m.teams + ' × ' + m.perTeam;
      c.desc.textContent = m.teams + ' drużyny po ' + m.perTeam + ' · Ty + ' + botsLabel(m.participants - 1) + ' · limit ' + m.elimLimit + ' eliminacji drużyny';
    }
  }

  /** Zakładka SOLO / MULTIPLAYER → widoczność wierszy trybu. */
  function refreshGroup() {
    if (rGroup === null) return;
    const mp = valueOf('group') === 'mp';
    setHidden(rMode, mp);
    for (const r of [rMp, rTeams, rPer]) setHidden(r, !mp);
    mpPair.classList.toggle('lt-mn-hidden', !mp);
  }

  function setHidden(row, hidden) {
    row.hidden = hidden;
    row.el.classList.toggle('lt-mn-hidden', hidden);
  }

  function indexOf(row, value) {
    return row.items.findIndex((it) => it.value === value);
  }
  if (rGroup !== null) rGroup.onChange = () => refreshGroup();

  // --- broń gracza (D-037): jedna na cały mecz; boty losują swoją
  const rWeapon = section('weapon', 'BROŃ', 'lt-mn-modes lt-mn-weapons');
  for (const id of Object.keys(CONFIG.weapons)) {
    const lab = WEAPON_LABELS[id] || [id.toUpperCase(), ''];
    const card = el(rWeapon.list, 'lt-mn-card lt-mn-modecard lt-mn-weaponcard');
    const top = el(card, 'lt-mn-card-top');
    el(top, 'lt-mn-card-name', CONFIG.weapons[id].name);
    el(top, 'lt-mn-card-tag', lab[0]);
    el(card, 'lt-mn-card-desc', lab[1]);
    addItem(rWeapon, id, card);
  }

  // --- boty
  const rDiff = section('diff', 'BOTY', 'lt-mn-seg');
  for (const d of diffs) {
    const lab = DIFF_LABELS[d] || [d.toUpperCase(), ''];
    const b = el(rDiff.list, 'lt-mn-pill');
    el(b, 'lt-mn-pill-name', lab[0]);
    el(b, 'lt-mn-pill-desc', lab[1]);
    addItem(rDiff, d, b);
  }

  // --- grafika
  const rPreset = section('preset', 'GRAFIKA', 'lt-mn-seg');
  for (const p of presets) {
    const b = el(rPreset.list, 'lt-mn-pill');
    el(b, 'lt-mn-pill-name', PRESET_LABELS[p] || p.toUpperCase());
    addItem(rPreset, p, b);
  }

  // --- graj
  const playRow = el(inner, 'lt-mn-row lt-mn-playrow');
  const play = el(playRow, 'lt-mn-play', 'GRAJ', 'button');
  play.type = 'button';
  el(playRow, 'lt-mn-hint', '↑ ↓ wybór sekcji · ← → zmiana · Enter — start');
  const playIndex = rows.length;
  play.addEventListener('mouseenter', () => setRow(playIndex));
  play.addEventListener('click', () => start());

  el(inner, 'lt-mn-foot', 'WASD ruch · Mysz celowanie · LPM strzał · Shift sprint · Spacja skok · C kucanie · Tab tablica · Esc pauza');

  let rowIdx = 0;
  let visible = false;

  /** Wybór opcji idx; wyłączone (off) pomijane w kierunku dir. */
  function select(row, idx, dir = 1) {
    const n = row.items.length;
    if (n === 0) return;
    let i = ((idx % n) + n) % n;
    for (let k = 0; k < n && row.items[i].off; k++) i = (((i + dir) % n) + n) % n;
    if (row.items[i].off) return;
    const prev = row.index;
    row.index = i;
    for (let i = 0; i < n; i++) {
      const on = i === row.index;
      row.items[i].el.classList.toggle('sel', on);
      row.items[i].el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (row.onChange !== null && prev !== row.index) row.onChange(row.items[row.index].value);
  }

  /** Wiersz i (rows.length = przycisk GRAJ); ukryte wiersze pomijane w kierunku dir. */
  function setRow(i, dir = 1) {
    const n = rows.length + 1;
    let r = ((i % n) + n) % n;
    for (let k = 0; k < n && r < rows.length && rows[r].hidden; k++) r = (((r + dir) % n) + n) % n;
    rowIdx = r;
    for (let k = 0; k < rows.length; k++) rows[k].el.classList.toggle('focus', k === rowIdx);
    play.classList.toggle('focus', rowIdx === playIndex);
  }

  function valueOf(key) {
    for (const r of rows) if (r.key === key) return r.items.length ? r.items[r.index].value : null;
    return null;
  }

  function setValue(key, value) {
    for (const r of rows) {
      if (r.key !== key) continue;
      const i = r.items.findIndex((it) => it.value === value);
      select(r, i >= 0 ? i : 0);
    }
  }

  function config() {
    const mp = rGroup !== null && valueOf('group') === 'mp';
    return {
      map: valueOf('map'),
      mode: mp ? valueOf('mpmode') : valueOf('mode'),
      diff: valueOf('diff'),
      preset: valueOf('preset'),
      bots: init.bots === undefined ? null : init.bots,
      teams: rTeams !== null ? valueOf('teams') : null,
      perTeam: rPer !== null ? valueOf('per') : null,
      weapon: valueOf('weapon'),
    };
  }

  function start() {
    if (!visible) return;
    if (onStart) onStart(config());
  }

  function onKey(e) {
    if (!visible || e.repeat) return;
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': setRow(rowIdx - 1, -1); e.preventDefault(); break;
      case 'ArrowDown': case 'KeyS': case 'Tab': setRow(rowIdx + 1); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA':
        if (rowIdx < rows.length) select(rows[rowIdx], rows[rowIdx].index - 1, -1);
        e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD':
        if (rowIdx < rows.length) select(rows[rowIdx], rows[rowIdx].index + 1);
        e.preventDefault(); break;
      case 'Enter': case 'NumpadEnter': case 'Space':
        e.preventDefault(); start(); break;
      default: break;
    }
  }
  window.addEventListener('keydown', onKey);

  const isMp = mpModes.some((m) => m.id === init.mode);
  if (rGroup !== null) setValue('group', isMp ? 'mp' : 'solo');
  setValue('map', init.map);
  setValue('mode', isMp ? undefined : init.mode);
  if (rMp !== null) {
    const c = clampCustom(init.teams, init.perTeam);
    setValue('mpmode', isMp ? init.mode : undefined);
    setValue('teams', c.teams);
    setValue('per', c.perTeam);
  }
  refreshGroup();
  refreshCustom();
  setValue('diff', init.diff);
  setValue('preset', init.preset);
  setValue('weapon', init.weapon);
  setRow(playIndex);

  return {
    show() { visible = true; root.classList.add('show'); },
    hide() { visible = false; root.classList.remove('show'); },
    get visible() { return visible; },
    get config() { return config(); },
    dispose() {
      window.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}
