// Adaptacja botów do gracza (PLAN §8.3, SPEC §2.5). Bez alokacji w recordEvent/stepAdapt/skillScale.
//
// Co evalInterval s: r = (E + 1) / (D + 1) z eliminacji (E) i śmierci (D) gracza w oknie ostatnich `window` s.
// r > highRatio → offset += step; r < lowRatio → offset −= step; inaczej offset dąży do 0 o decay. offset ∈ [−max, +max].
// Skala (tylko boty-przeciwnicy gracza): rozrzut × (1 − s), reakcja × (1 − s), obrót × (1 + s).

import { CONFIG } from '../../config.js';
import { EV } from '../../core/events.js';

const KILL = 1;
const DEATH = 2;

/** @param {{ capacity?: number }} [o] capacity = pojemność pierścienia zdarzeń gracza w oknie */
export function createAdapt(o) {
  const cap = (o && o.capacity) | 0 || 512;
  const A = {
    offset: 0.5,             // (double od startu) → zerowane niżej
    nextEval: CONFIG.bots.adapt.evalInterval,
    lastRatio: 1.5,
    times: new Float64Array(cap),
    kinds: new Uint8Array(cap),
    head: 0,                 // indeks następnego zapisu
    count: 0,
    evals: 0,
    scale: { aimSigma: 0.5, reaction: 0.5, turn: 0.5 },   // wynik skillScale (prealokowany)
  };
  resetAdapt(A);
  return A;
}

/** Zeruje stan (np. nowy mecz). */
export function resetAdapt(A) {
  A.offset = 0;
  A.nextEval = CONFIG.bots.adapt.evalInterval;
  A.lastRatio = 1;
  A.head = 0;
  A.count = 0;
  A.evals = 0;
}

/** kind: 'kill' (gracz wyeliminował) | 'death' (gracz wyeliminowany). */
export function recordEvent(A, time, kind) {
  const cap = A.times.length;
  A.times[A.head] = time;
  A.kinds[A.head] = kind === 'kill' ? KILL : DEATH;
  A.head = (A.head + 1) % cap;
  if (A.count < cap) A.count++;
}

/**
 * Pomocniczo: przegląda kolejkę zdarzeń sim (ELIM) i zapisuje kill/death gracza.
 * Wołać raz na klatkę renderu, PRZED czyszczeniem kolejki (każdy rekord liczony raz).
 */
export function recordFromEvents(A, events, playerId) {
  for (let i = 0; i < events.count; i++) {
    const r = events.at(i);
    if (r.type !== EV.ELIM) continue;
    if (r.b === playerId) recordEvent(A, r.time, 'death');
    else if (r.a === playerId) recordEvent(A, r.time, 'kill');
  }
}

function evaluate(A, time) {
  const C = CONFIG.bots.adapt;
  const from = time - C.window;
  const cap = A.times.length;
  let e = 0;
  let d = 0;
  for (let i = 0; i < A.count; i++) {
    const k = (A.head - 1 - i + cap) % cap;
    if (A.times[k] < from) break;          // pierścień chronologiczny → dalej tylko starsze
    if (A.times[k] > time) continue;
    if (A.kinds[k] === KILL) e++; else d++;
  }
  const r = (e + 1) / (d + 1);
  A.lastRatio = r;
  let s = A.offset;
  if (r > C.highRatio) s += C.step;
  else if (r < C.lowRatio) s -= C.step;
  else if (s > 0) s = s - C.decay < 0 ? 0 : s - C.decay;
  else if (s < 0) s = s + C.decay > 0 ? 0 : s + C.decay;
  if (s > C.maxOffset) s = C.maxOffset;
  if (s < -C.maxOffset) s = -C.maxOffset;
  A.offset = Math.round(s * 1e6) / 1e6;    // bez dryfu zmiennoprzecinkowego (0.05 kroki)
  A.evals++;
}

/** Ocena co evalInterval (nadrabia, jeśli czas przeskoczył kilka okresów). Idempotentne w obrębie okresu. */
export function stepAdapt(A, time) {
  const iv = CONFIG.bots.adapt.evalInterval;
  while (time >= A.nextEval) {
    evaluate(A, A.nextEval);
    A.nextEval += iv;
  }
}

/**
 * Parametry poziomu przeskalowane offsetem → A.scale (prealokowany, nadpisywany przy każdym wywołaniu).
 * level: nazwa ('easy'|'normal'|'hard') lub obiekt z CONFIG.bots.levels.
 * Jednostki jak w CONFIG: aimSigma = stopnie, reaction = s, turn = °/s.
 */
export function skillScale(A, level) {
  const L = typeof level === 'string' ? CONFIG.bots.levels[level] : level;
  const s = A.offset;
  const out = A.scale;
  out.aimSigma = L.aimSigmaDeg * (1 - s);
  out.reaction = L.reaction * (1 - s);
  out.turn = L.turnDegPerSec * (1 + s);
  return out;
}
