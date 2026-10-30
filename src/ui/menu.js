// Menu startowe (PLAN §9.2): mapa (karty z paletą), tryb (z opisem), poziom botów, preset grafiki, „GRAJ".
// Klawiatura: ↑/↓ (W/S) wiersz, ←/→ (A/D) wybór, Enter — start. Mysz: klik wybiera, klik „GRAJ" startuje.
import { el } from './scoreboard.js';
import { teamColor } from '../game/modes.js';
import { CONFIG } from '../config.js';

const DIFF_LABELS = { easy: ['ŁATWY', 'Wolne reakcje, duży rozrzut'], normal: ['NORMALNY', 'Strafe i osłony'], hard: ['TRUDNY', 'Szybcy, celni, bezlitośni'] };
const PRESET_LABELS = { low: 'NISKI', medium: 'ŚREDNI', high: 'WYSOKI', ultra: 'ULTRA' };

function toList(src) {
  if (!src) return [];
  if (Array.isArray(src)) return src;
  return Object.keys(src).map((k) => (typeof src[k] === 'object' && src[k] !== null ? { id: k, ...src[k] } : { id: k }));
}

function idsOf(list) { return list.map((x) => (typeof x === 'string' ? x : x.id)); }

/** Kropki składu trybu (podgląd drużyn). */
function rosterDots(parent, mode) {
  const wrap = el(parent, 'lt-mn-dots');
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
 *   diffs: CONFIG.bots.levels lub tablica id; initial: { map, mode, diff, preset, bots }
 * @param {(cfg:{ map, mode, diff, preset, bots }) => void} onStart
 */
export function createMenu(rootEl, opts, onStart) {
  const maps = toList(opts.maps);
  const modes = toList(opts.modes);
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

  function section(key, label, cls) {
    const sec = el(inner, 'lt-mn-row ' + cls);
    const lab = el(sec, 'lt-mn-label');
    el(lab, 'lt-mn-label-txt', label, 'span');
    el(lab, 'lt-mn-label-keys', '← →', 'span');
    const list = el(sec, 'lt-mn-options');
    const row = { key, el: sec, list, items: [], index: 0 };
    rows.push(row);
    sec.addEventListener('mouseenter', () => setRow(rows.indexOf(row)));
    return row;
  }

  function addItem(row, value, node) {
    const idx = row.items.length;
    row.items.push({ el: node, value });
    node.setAttribute('role', 'option');
    node.addEventListener('click', () => {
      setRow(rows.indexOf(row));
      select(row, idx);
    });
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
    const info = m.size ? m.size.w + ' × ' + m.size.d + ' m' : '';
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

  el(inner, 'lt-mn-foot', 'WASD ruch · Mysz celowanie · LPM strzał · Shift sprint · Spacja skok · Tab tablica · Esc pauza');

  let rowIdx = 0;
  let visible = false;

  function select(row, idx) {
    const n = row.items.length;
    if (n === 0) return;
    row.index = ((idx % n) + n) % n;
    for (let i = 0; i < n; i++) {
      const on = i === row.index;
      row.items[i].el.classList.toggle('sel', on);
      row.items[i].el.setAttribute('aria-selected', on ? 'true' : 'false');
    }
  }

  function setRow(i) {
    const n = rows.length + 1;
    rowIdx = ((i % n) + n) % n;
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
    return {
      map: valueOf('map'),
      mode: valueOf('mode'),
      diff: valueOf('diff'),
      preset: valueOf('preset'),
      bots: init.bots === undefined ? null : init.bots,
    };
  }

  function start() {
    if (!visible) return;
    if (onStart) onStart(config());
  }

  function onKey(e) {
    if (!visible) return;
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': setRow(rowIdx - 1); e.preventDefault(); break;
      case 'ArrowDown': case 'KeyS': case 'Tab': setRow(rowIdx + 1); e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA':
        if (rowIdx < rows.length) select(rows[rowIdx], rows[rowIdx].index - 1);
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

  setValue('map', init.map);
  setValue('mode', init.mode);
  setValue('diff', init.diff);
  setValue('preset', init.preset);
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
