// Mecz (SPEC §2.4, §2.6, PLAN §9.1): odliczanie → gra (timer, limit eliminacji) → koniec, zwycięzca.
// Czysty JS, bez three. stepMatch i standings nie alokują (bufory tworzone w createMatch/createStandings).
//
// Zamrożenie w odliczaniu realizuje właściciel pętli: `if (matchRunning(M)) stepSim(sim, dt)`.
import { CONFIG } from '../config.js';
import { getMode } from './modes.js';

const MAX_TEAMS = CONFIG.colors.teams.length;

/** Prealokowany wynik standings(): wiersze uczestników i drużyn, posortowane. */
export function createStandings(capacity = CONFIG.combat.maxParticipants) {
  const teams = [];
  for (let t = 0; t < MAX_TEAMS; t++) teams.push({ team: t, score: 0, elims: 0, deaths: 0, size: 0 });
  return {
    rows: new Array(capacity).fill(null), // uczestnicy; w tdm pogrupowani wg kolejności drużyn
    count: 0,
    teams,                                // posortowane drużyny (tylko pierwsze teamCount)
    teamCount: 0,
  };
}

/**
 * @param {object} sim
 * @param {string} modeId
 * @param {{ countdown?: number }} [opts]  countdown: 0 → start od razu (np. testy)
 */
export function createMatch(sim, modeId, opts = {}) {
  const m = getMode(modeId);
  const cd = opts.countdown === undefined ? CONFIG.match.countdown : opts.countdown;
  const M = {
    modeId: m.id,
    teams: m.teams,                       // 0 = ffa
    timeLimit: m.timeLimit,
    elimLimit: m.elimLimit,
    timeLeft: m.timeLimit,
    countdown: cd,
    sinceStart: 0,                        // s od zakończenia odliczania (do „START!")
    state: cd > 0 ? 'countdown' : 'playing',
    elapsed: 0,
    // wyniki
    winner: -1,                           // id uczestnika (ffa) | indeks drużyny (tdm) | -1 remis/brak
    winnerKind: 'none',                   // 'player' | 'team' | 'draw' | 'none'
    endReason: 'none',                    // 'time' | 'limit' | 'none'
    leaderId: -1,                         // bieżący lider (ffa)
    teamScore: new Float64Array(MAX_TEAMS),
    teamElims: new Int32Array(MAX_TEAMS),
    teamDeaths: new Int32Array(MAX_TEAMS),
    standings: createStandings(Math.max(CONFIG.combat.maxParticipants, sim.participants.length)),
  };
  updateTotals(M, sim);
  return M;
}

/** Czy symulacja ma iść (false w odliczaniu i po końcu). */
export function matchRunning(M) {
  return M.state === 'playing';
}

// a lepszy od b? wynik ↓, eliminacje ↓, śmierci ↑, id ↑ (stabilnie)
function betterP(a, b) {
  const sa = a.stats, sb = b.stats;
  if (sa.score !== sb.score) return sa.score > sb.score;
  if (sa.elims !== sb.elims) return sa.elims > sb.elims;
  if (sa.deaths !== sb.deaths) return sa.deaths < sb.deaths;
  return a.id < b.id;
}

function betterT(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  if (a.elims !== b.elims) return a.elims > b.elims;
  if (a.deaths !== b.deaths) return a.deaths < b.deaths;
  return a.team < b.team;
}

function updateTotals(M, sim) {
  const sc = M.teamScore, el = M.teamElims, de = M.teamDeaths;
  for (let t = 0; t < MAX_TEAMS; t++) { sc[t] = 0; el[t] = 0; de[t] = 0; }
  const ps = sim.participants;
  let leader = null;
  for (let i = 0; i < ps.length; i++) {
    const P = ps[i];
    if (P.team >= 0 && P.team < MAX_TEAMS) {
      sc[P.team] += P.stats.score;
      el[P.team] += P.stats.elims;
      de[P.team] += P.stats.deaths;
    }
    if (leader === null || betterP(P, leader)) leader = P;
  }
  M.leaderId = leader === null ? -1 : leader.id;
}

function limitReached(M, sim) {
  const lim = M.elimLimit;
  if (!(lim > 0)) return false;
  if (M.teams > 0) {
    for (let t = 0; t < M.teams; t++) if (M.teamElims[t] >= lim) return true;
    return false;
  }
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) if (ps[i].stats.elims >= lim) return true;
  return false;
}

function decideWinner(M, sim) {
  const S = standings(M, sim, M.standings);
  if (M.teams > 0) {
    const a = S.teams[0], b = S.teamCount > 1 ? S.teams[1] : null;
    if (b !== null && a.score === b.score && a.elims === b.elims) { M.winner = -1; M.winnerKind = 'draw'; }
    else { M.winner = a.team; M.winnerKind = 'team'; }
  } else {
    if (S.count === 0) { M.winner = -1; M.winnerKind = 'none'; return; }
    const a = S.rows[0].stats, b = S.count > 1 ? S.rows[1].stats : null;
    if (b !== null && a.score === b.score && a.elims === b.elims) { M.winner = -1; M.winnerKind = 'draw'; }
    else { M.winner = S.rows[0].id; M.winnerKind = 'player'; }
  }
}

function endMatch(M, sim, reason) {
  M.state = 'ended';
  M.endReason = reason;
  decideWinner(M, sim);
}

/** Krok meczu (wołać w stałym kroku, przed/po stepSim). Bez alokacji. */
export function stepMatch(M, sim, dt) {
  if (M.state === 'ended') return;
  if (M.state === 'countdown') {
    M.countdown -= dt;
    if (M.countdown <= 0) {
      M.countdown = 0;
      M.state = 'playing';
      M.sinceStart = 0;
    }
    return;
  }
  M.elapsed += dt;
  M.sinceStart += dt;
  M.timeLeft -= dt;
  updateTotals(M, sim);
  if (limitReached(M, sim)) { endMatch(M, sim, 'limit'); return; }
  if (M.timeLeft <= 0) {
    M.timeLeft = 0;
    endMatch(M, sim, 'time');
  }
}

/**
 * Posortowana tablica wyników do `out` (createStandings). Bez alokacji.
 * ffa: rows = wszyscy wg wyniku. tdm: teams posortowane, rows pogrupowane wg kolejności drużyn,
 * w drużynie wg wyniku.
 */
export function standings(M, sim, out) {
  const ps = sim.participants;
  const rows = out.rows;
  let n = ps.length < rows.length ? ps.length : rows.length;
  for (let i = 0; i < n; i++) rows[i] = ps[i];
  for (let i = n; i < rows.length; i++) rows[i] = null;
  out.count = n;

  const nt = M.teams;
  out.teamCount = nt;
  if (nt > 0) {
    // sumy drużyn z bieżących statystyk
    const T = out.teams;
    for (let t = 0; t < MAX_TEAMS; t++) { const r = T[t]; r.team = t; r.score = 0; r.elims = 0; r.deaths = 0; r.size = 0; }
    for (let i = 0; i < n; i++) {
      const P = rows[i];
      if (P.team >= 0 && P.team < nt) {
        const r = T[P.team];
        r.score += P.stats.score; r.elims += P.stats.elims; r.deaths += P.stats.deaths; r.size++;
      }
    }
    // sortowanie przez wstawianie (≤ 4 elementy)
    for (let i = 1; i < nt; i++) {
      const x = T[i];
      let j = i - 1;
      while (j >= 0 && betterT(x, T[j])) { T[j + 1] = T[j]; j--; }
      T[j + 1] = x;
    }
  }

  // sortowanie uczestników przez wstawianie (≤ 16): w tdm najpierw ranga drużyny
  for (let i = 1; i < n; i++) {
    const x = rows[i];
    const rx = nt > 0 ? teamRank(out, x.team) : 0;
    let j = i - 1;
    while (j >= 0) {
      const y = rows[j];
      const ry = nt > 0 ? teamRank(out, y.team) : 0;
      if (rx < ry || (rx === ry && betterP(x, y))) { rows[j + 1] = y; j--; } else break;
    }
    rows[j + 1] = x;
  }
  return out;
}

function teamRank(out, team) {
  const T = out.teams;
  for (let k = 0; k < out.teamCount; k++) if (T[k].team === team) return k;
  return MAX_TEAMS;
}

/** Wynik z perspektywy uczestnika P: 'win' | 'lose' | 'draw'. */
export function outcomeFor(M, P) {
  if (M.winnerKind === 'draw' || M.winnerKind === 'none') return 'draw';
  if (M.winnerKind === 'team') return P.team === M.winner ? 'win' : 'lose';
  return P.id === M.winner ? 'win' : 'lose';
}
