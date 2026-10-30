// Tryby gry (SPEC §2.6, PLAN §9.1). Czysty JS, bez three. Alokacje tylko przy konfiguracji meczu.
import { CONFIG } from '../config.js';

const TEAM_NAMES = ['Czerwoni', 'Niebiescy', 'Zieloni', 'Żółci'];
const BOT_NAMES = [
  'Vex', 'Nova', 'Rift', 'Kilo', 'Jinx', 'Echo', 'Flux', 'Onyx',
  'Zed', 'Lumen', 'Volt', 'Raze', 'Hex', 'Pixel', 'Neon', 'Quark',
];

function mode(id, name, short, desc) {
  const c = CONFIG.modes[id];
  return Object.freeze({
    id, name, short, desc,
    teams: c.teams,
    perTeam: c.perTeam || 0,
    participants: c.teams > 0 ? c.teams * c.perTeam : c.participants,
    timeLimit: c.timeLimit,
    elimLimit: c.elimLimit,
  });
}

export const MODES = Object.freeze({
  ffa: mode('ffa', 'Każdy na każdego', 'FFA', 'Ty + 7 botów. Wygrywa najwyższy wynik.'),
  tdm2: mode('tdm2', 'Drużyny 4 v 4', 'TDM 2', 'Czerwoni kontra Niebiescy. Wynik drużyny = suma wyników.'),
  tdm4: mode('tdm4', '4 drużyny po 2', 'TDM 4', 'Cztery dwuosobowe drużyny. Chaos kontrolowany.'),
});

export function getMode(modeId) {
  return Object.prototype.hasOwnProperty.call(MODES, modeId) ? MODES[modeId] : MODES[CONFIG.defaults.mode];
}

/** Nazwa drużyny (0..3) lub '' dla FFA (-1). */
export function teamName(team) {
  return team >= 0 && team < TEAM_NAMES.length ? TEAM_NAMES[team] : '';
}

export function teamColor(team) {
  const c = CONFIG.colors.teams;
  return team >= 0 && team < c.length ? c[team] : '#ffffff';
}

/** Liczba drużyn do createSim({ teamCount }): 0 (ffa) | 2 | 4. */
export function spawnTeamCount(modeId) {
  return getMode(modeId).teams;
}

/**
 * Skład meczu. Gracz zawsze id 0, team 0 w tdm.
 * @param {string} modeId
 * @param {{ bots?: number|null, diff?: string, playerName?: string }} [opts]
 *   bots: liczba botów (null → domyślna z trybu); łącznie ≤ CONFIG.combat.maxParticipants.
 * @returns {{ id:number, name:string, team:number, color:string, isPlayer:boolean, level:string|null }[]}
 */
export function setupRoster(modeId, opts = {}) {
  const m = getMode(modeId);
  const level = Object.prototype.hasOwnProperty.call(CONFIG.bots.levels, opts.diff) ? opts.diff : CONFIG.defaults.diff;
  const maxTotal = CONFIG.combat.maxParticipants;
  let total = Number.isInteger(opts.bots) && opts.bots >= 0 ? opts.bots + 1 : m.participants;
  if (total > maxTotal) total = maxTotal;
  if (total < 1) total = 1;

  const ffaColors = CONFIG.colors.ffa;
  const pc = CONFIG.match.playerColorFfa;
  const roster = [];
  for (let i = 0; i < total; i++) {
    const isPlayer = i === 0;
    let team = -1;
    let color;
    if (m.teams > 0) {
      team = i % m.teams;
      color = teamColor(team);
    } else {
      // gracz dostaje kolor pc, boty kolejne kolory z pominięciem koloru gracza
      const k = isPlayer ? pc : (pc + i) % ffaColors.length;
      color = ffaColors[k];
    }
    roster.push({
      id: i,
      name: isPlayer ? (opts.playerName || 'Ty') : BOT_NAMES[(i - 1) % BOT_NAMES.length],
      team,
      color,
      isPlayer,
      level: isPlayer ? null : level,
    });
  }
  return roster;
}
