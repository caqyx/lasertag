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

/** Tryby SOLO (menu: zakładka SOLO). Multiplayer → Custom: customMode() / MP_MODES. */
export const MODES = Object.freeze({
  ffa: mode('ffa', 'Każdy na każdego', 'FFA', 'Ty + 7 botów. Wygrywa najwyższy wynik.'),
  tdm2: mode('tdm2', 'Drużyny 4 v 4', 'TDM 2', 'Czerwoni kontra Niebiescy. Wynik drużyny = suma wyników.'),
  tdm4: mode('tdm4', '4 drużyny po 2', 'TDM 4', 'Cztery dwuosobowe drużyny. Chaos kontrolowany.'),
});

// ---------------- Multiplayer → Custom (SPEC §2.6, D-039) ----------------
// Lokalnie z botami; slot = { team, kind: 'local' | 'bot' | 'remote' } — pod M5 bot w slocie zostanie
// podmieniony na gracza sieciowego (Participant.inputSource jest wymienny). 'remote' to na razie tylko typ danych.

export const SLOT_KINDS = Object.freeze(['local', 'bot', 'remote']);
const CUS = CONFIG.modes.custom;
const CUS_MAX_TEAMS = Math.min(CUS.maxTeams, CONFIG.colors.teams.length, TEAM_NAMES.length);

function clampInt(v, lo, hi, fallback) {
  if (!Number.isInteger(v)) return fallback;
  return v < lo ? lo : v > hi ? hi : v;
}

/** Zakres liczby drużyn Custom: { min, max }. */
export function customTeamRange() {
  return { min: CUS.minTeams, max: CUS_MAX_TEAMS };
}

/** Maks. osób w drużynie przy `teams` drużynach (łącznie ≤ CONFIG.combat.maxParticipants). */
export function customMaxPerTeam(teams) {
  const t = clampInt(teams, CUS.minTeams, CUS_MAX_TEAMS, CUS.defaultTeams);
  return Math.max(CUS.minPerTeam, Math.floor(CONFIG.combat.maxParticipants / t));
}

/** Poprawna para { teams, perTeam } (brak/niepoprawne → domyślne z CONFIG, za duże → przycięte do limitu). */
export function clampCustom(teams, perTeam) {
  const t = clampInt(teams, CUS.minTeams, CUS_MAX_TEAMS, CUS.defaultTeams);
  const max = customMaxPerTeam(t);
  const p = clampInt(perTeam, CUS.minPerTeam, max, Math.min(CUS.defaultPerTeam, max));
  return { teams: t, perTeam: p };
}

const customCache = new Map();
/** Deskryptor trybu Custom dla (teams, perTeam) — ten sam kształt co MODES.*, zamrożony, z pamięci podręcznej. */
export function customMode(teams, perTeam) {
  const c = clampCustom(teams, perTeam);
  const key = c.teams * 100 + c.perTeam;
  let m = customCache.get(key);
  if (m === undefined) {
    m = Object.freeze({
      id: 'custom',
      name: c.teams + ' drużyny po ' + c.perTeam,
      short: 'CUSTOM ' + c.teams + '×' + c.perTeam,
      desc: c.teams + ' drużyny po ' + c.perTeam + (c.perTeam === 1 ? ' osobie' : c.perTeam <= 4 ? ' osoby' : ' osób') + '. Ty + boty, sloty gotowe pod online.',
      teams: c.teams,
      perTeam: c.perTeam,
      participants: c.teams * c.perTeam,
      timeLimit: CUS.timeLimit,
      elimLimit: CUS.elimPerMember * c.perTeam,
    });
    customCache.set(key, m);
  }
  return m;
}

/** Tryby MULTIPLAYER (menu): na razie tylko Custom z domyślnym składem. */
export const MP_MODES = Object.freeze({ custom: customMode(CUS.defaultTeams, CUS.defaultPerTeam) });

/** Czy id to znany tryb (SOLO lub Custom). */
export function isModeId(modeId) {
  return Object.prototype.hasOwnProperty.call(MODES, modeId) || modeId === 'custom';
}

/**
 * Sloty Custom: teams × perTeam, przeplatane (slot i → drużyna i % teams), slot 0 = gracz lokalny (drużyna 0),
 * reszta boty. @returns {{ team:number, kind:'local'|'bot'|'remote' }[]}
 */
export function buildCustomSlots(teams, perTeam) {
  const c = clampCustom(teams, perTeam);
  const n = c.teams * c.perTeam;
  const slots = [];
  for (let i = 0; i < n; i++) slots.push({ team: i % c.teams, kind: i === 0 ? 'local' : 'bot' });
  return slots;
}

/** Sloty z cfg poprawne? (tablica ≤ maxParticipants, team w [0, teams), kind ze SLOT_KINDS, dokładnie jeden 'local'). */
function validSlots(slots, teams) {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > CONFIG.combat.maxParticipants) return false;
  let local = 0;
  for (const s of slots) {
    if (!s || !Number.isInteger(s.team) || s.team < 0 || s.team >= teams || !SLOT_KINDS.includes(s.kind)) return false;
    if (s.kind === 'local') local++;
  }
  return local === 1;
}

/**
 * Deskryptor trybu. Custom: opts.teams / opts.perTeam (brak → domyślne). Nieznany id → domyślny tryb.
 * @param {string} modeId
 * @param {{ teams?: number, perTeam?: number }} [opts]
 */
export function getMode(modeId, opts) {
  if (modeId === 'custom') return customMode(opts ? opts.teams : undefined, opts ? opts.perTeam : undefined);
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

/** Liczba drużyn do createSim({ teamCount }): 0 (ffa) | 2..4. Custom: opts.teams. */
export function spawnTeamCount(modeId, opts) {
  return getMode(modeId, opts).teams;
}

/**
 * Skład meczu. Gracz zawsze id 0, team 0 w tdm.
 * @param {string} modeId
 * @param {{ bots?: number|null, diff?: string, playerName?: string, teams?: number, perTeam?: number, slots?: object[] }} [opts]
 *   bots: liczba botów (null → domyślna z trybu); łącznie ≤ CONFIG.combat.maxParticipants. Custom: bots ignorowane,
 *   skład z opts.slots (poprawne) albo buildCustomSlots(opts.teams, opts.perTeam).
 * @returns {{ id:number, name:string, team:number, color:string, isPlayer:boolean, level:string|null,
 *   kind:'local'|'bot'|'remote' }[]}
 */
export function setupRoster(modeId, opts = {}) {
  const level = Object.prototype.hasOwnProperty.call(CONFIG.bots.levels, opts.diff) ? opts.diff : CONFIG.defaults.diff;
  if (modeId === 'custom') return customRoster(opts, level);
  const m = getMode(modeId);
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
      // (cykl po len−1 kolorach — przy > len uczestnikach bot nie dostaje koloru gracza)
      const len = ffaColors.length;
      const k = isPlayer ? pc : (pc + 1 + (i - 1) % (len - 1)) % len;
      color = ffaColors[k];
    }
    roster.push({
      id: i,
      name: isPlayer ? (opts.playerName || 'Ty') : BOT_NAMES[(i - 1) % BOT_NAMES.length],
      team,
      color,
      isPlayer,
      level: isPlayer ? null : level,
      kind: isPlayer ? 'local' : 'bot',
    });
  }
  return roster;
}

function customRoster(opts, level) {
  const m = customMode(opts.teams, opts.perTeam);
  const slots = validSlots(opts.slots, m.teams) ? opts.slots : buildCustomSlots(m.teams, m.perTeam);
  const roster = [];
  let bot = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const isPlayer = s.kind === 'local';
    roster.push({
      id: i,
      name: isPlayer ? (opts.playerName || 'Ty') : BOT_NAMES[bot++ % BOT_NAMES.length],
      team: s.team,
      color: teamColor(s.team),
      isPlayer,
      level: isPlayer ? null : level,   // 'remote' (M5): do czasu sieci slot sterowany botem
      kind: s.kind,
    });
  }
  return roster;
}
