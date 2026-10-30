// Tablica wyników (Tab) + wspólny renderer tabeli (używany też przez endScreen). PLAN §9.2.
// DOM budowany raz; update/render dotyka DOM tylko przy zmianie wartości (cache per komórka).
import { CONFIG } from '../config.js';
import { createStandings, standings } from '../game/match.js';
import { getMode, teamName, teamColor } from '../game/modes.js';

const MAX_TEAMS = CONFIG.colors.teams.length;
const COLS = 5; // #, nazwa, wynik, E, D

export function el(parent, cls, text, tag = 'div') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

/** mm:ss z sekund (zaokrąglenie w górę — 0:00 dopiero na końcu). */
export function formatTime(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = (s / 60) | 0;
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

const KIND_HIDDEN = 0, KIND_TEAM = 1, KIND_ROW = 2;

/**
 * Tabela wyników w `parent`. render(M, sim) przelicza standings (bufor prealokowany) i aktualizuje linie.
 */
export function createStandingsTable(parent, capacity = CONFIG.combat.maxParticipants) {
  const root = el(parent, 'lt-st');
  const head = el(root, 'lt-st-line lt-st-head');
  const headCells = ['#', 'GRACZ', 'WYNIK', 'E', 'D'];
  for (let i = 0; i < COLS; i++) el(head, 'lt-st-c lt-st-c' + i, headCells[i]);

  const lines = [];
  for (let k = 0; k < capacity + MAX_TEAMS; k++) {
    const e = el(root, 'lt-st-line');
    e.style.display = 'none';
    const cells = [];
    for (let i = 0; i < COLS; i++) cells.push(el(e, 'lt-st-c lt-st-c' + i));
    // kolorowa kropka przed nazwą
    const dot = document.createElement('span');
    dot.className = 'lt-st-dot';
    const name = document.createElement('span');
    name.className = 'lt-st-name';
    cells[1].appendChild(dot);
    cells[1].appendChild(name);
    lines.push({ e, cells, name, v: [null, null, null, null, null], kind: -1, color: '', mine: -1, dead: -1 });
  }
  const out = createStandings(capacity);

  function setCell(line, i, value) {
    if (line.v[i] === value) return;
    line.v[i] = value;
    if (i === 1) line.name.textContent = value;
    else line.cells[i].textContent = value;
  }

  function setLine(line, kind, color, mine, dead) {
    if (line.kind !== kind) {
      line.kind = kind;
      line.e.style.display = kind === KIND_HIDDEN ? 'none' : '';
      line.e.classList.toggle('lt-st-team', kind === KIND_TEAM);
    }
    if (line.color !== color) { line.color = color; line.e.style.setProperty('--c', color); }
    if (line.mine !== mine) { line.mine = mine; line.e.classList.toggle('mine', mine === 1); }
    if (line.dead !== dead) { line.dead = dead; line.e.classList.toggle('dead', dead === 1); }
  }

  function render(M, sim) {
    const S = standings(M, sim, out);
    let k = 0;
    if (S.teamCount > 0) {
      let r = 0;
      for (let ti = 0; ti < S.teamCount; ti++) {
        const T = S.teams[ti];
        const L = lines[k++];
        setLine(L, KIND_TEAM, teamColor(T.team), 0, 0);
        setCell(L, 0, ti + 1);
        setCell(L, 1, teamName(T.team));
        setCell(L, 2, T.score);
        setCell(L, 3, T.elims);
        setCell(L, 4, T.deaths);
        for (; r < S.count && S.rows[r].team === T.team; r++) k = rowLine(lines[k], S.rows[r], '', k);
      }
      for (; r < S.count; r++) k = rowLine(lines[k], S.rows[r], '', k); // (np. team spoza zakresu)
    } else {
      for (let r = 0; r < S.count; r++) k = rowLine(lines[k], S.rows[r], r + 1, k);
    }
    for (; k < lines.length; k++) setLine(lines[k], KIND_HIDDEN, '', 0, 0);
    return S;
  }

  function rowLine(L, P, rank, k) {
    setLine(L, KIND_ROW, P.color, P.isPlayer ? 1 : 0, P.state === 'alive' ? 0 : 1);
    setCell(L, 0, rank);
    setCell(L, 1, P.name);
    setCell(L, 2, P.stats.score);
    setCell(L, 3, P.stats.elims);
    setCell(L, 4, P.stats.deaths);
    return k + 1;
  }

  return { el: root, render, dispose() { root.remove(); } };
}

/** Tablica pod Tab. update(M, sim, visible) — odświeżanie co CONFIG.match.scoreboardRefresh. */
export function createScoreboard(rootEl) {
  const root = el(rootEl, 'lt-sb');
  const panel = el(root, 'lt-sb-panel lt-panel');
  const head = el(panel, 'lt-sb-head');
  el(head, 'lt-sb-title', 'TABLICA');
  const modeEl = el(head, 'lt-sb-mode');
  const timeEl = el(head, 'lt-sb-time');
  const table = createStandingsTable(panel);
  const foot = el(panel, 'lt-sb-foot');

  let shown = false;
  let last = -1e9;
  let cMode = '', cTime = -1, cFoot = '';
  const refreshMs = CONFIG.match.scoreboardRefresh * 1000;

  function update(M, sim, visible) {
    if (visible !== shown) {
      shown = visible;
      root.classList.toggle('show', visible);
      last = -1e9;
    }
    if (!visible) return;
    const now = performance.now();
    if (now - last < refreshMs) return;
    last = now;
    if (cMode !== M.modeId) {
      cMode = M.modeId;
      const m = getMode(M.modeId);
      modeEl.textContent = m.short + ' · ' + m.name;
      const f = 'Limit: ' + m.elimLimit + (m.teams > 0 ? ' eliminacji drużyny' : ' eliminacji') + ' · E = eliminacje, D = śmierci';
      if (f !== cFoot) { cFoot = f; foot.textContent = f; }
    }
    const t = Math.ceil(M.timeLeft);
    if (t !== cTime) { cTime = t; timeEl.textContent = formatTime(M.timeLeft); }
    table.render(M, sim);
  }

  return {
    update,
    dispose() { table.dispose(); root.remove(); },
  };
}
