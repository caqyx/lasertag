// Parametry URL (SPEC §9): ?preset=&map=&mode=&bots=&diff=&cam=&nohud=1&stats=1&seed=&autostart=1&weapon=
// Custom (mode=custom): &teams=2..4&per=1..floor(16/teams) — brak/niepoprawne → domyślne, za duże per → przycięte.
// Czysty moduł (działa w Node). Nieznane/niepoprawne wartości → domyślne z CONFIG.defaults.
// Walidację `map` względem MAPS robi main.js (tu tylko format identyfikatora).
import { CONFIG } from '../config.js';
import { clampCustom } from '../game/modes.js';

const ID_RE = /^[a-z0-9_-]{1,32}$/;
const INT_RE = /^-?\d{1,10}$/;
const MAX_BOTS = CONFIG.combat.maxParticipants - 1;

function pick(value, allowed, fallback) {
  return value !== null && Object.prototype.hasOwnProperty.call(allowed, value) ? value : fallback;
}

function flag(value) {
  return value === '1' || value === 'true';
}

function parseCam(value) {
  if (value === null) return null;
  const v = value.trim();
  if (v === '') return null;
  if (/^\d{1,3}$/.test(v)) return Number(v);
  return v.length <= 64 ? v : null;
}

function parseBots(value) {
  const fallback = CONFIG.defaults.bots ?? null;
  if (value === null || !/^\d{1,2}$/.test(value)) return fallback;
  const n = Number(value);
  return n <= MAX_BOTS ? n : fallback;
}

function parseSmallInt(value) {
  return value !== null && /^\d{1,2}$/.test(value) ? Number(value) : null;
}

function parseSeed(value) {
  if (value === null || !INT_RE.test(value)) return null;
  return Number(value) >>> 0; // uint32 (mulberry32)
}

export function parseParams(search = '') {
  const q = new URLSearchParams(typeof search === 'string' ? search : '');
  const d = CONFIG.defaults;
  const mapRaw = q.get('map');
  const map = mapRaw !== null && ID_RE.test(mapRaw.toLowerCase()) ? mapRaw.toLowerCase() : d.map;
  const custom = clampCustom(parseSmallInt(q.get('teams')), parseSmallInt(q.get('per')));
  return {
    preset: pick(q.get('preset'), CONFIG.presets, d.preset),
    map,
    mode: pick(q.get('mode'), CONFIG.modes, d.mode),
    bots: parseBots(q.get('bots')),
    diff: pick(q.get('diff'), CONFIG.bots.levels, d.diff),
    cam: parseCam(q.get('cam')),
    nohud: flag(q.get('nohud')),
    stats: flag(q.get('stats')),
    seed: parseSeed(q.get('seed')),
    autostart: flag(q.get('autostart')),
    weapon: pick(q.get('weapon'), CONFIG.weapons, d.weapon),   // D-037: phaser | pistol | bouncer
    teams: custom.teams,       // Custom: liczba drużyn
    perTeam: custom.perTeam,   // Custom: osób w drużynie
  };
}
