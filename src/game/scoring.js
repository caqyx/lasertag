// Punktacja (PLAN §7.5, SPEC §2.4). Bez alokacji.
// Trafienie +CONFIG.scoring.hit, eliminacja +CONFIG.scoring.elimination dla strzelającego
// (trafienie eliminujące daje oba: hit + elimination). Cel: stats.deaths++ (0 pkt).
// sim.teams[t] = { score, elims, deaths } — sumy drużynowe aktualizowane przyrostowo (team ≥ 0).

import { CONFIG } from '../config.js';

function teamOf(sim, P) {
  const t = P.team;
  return t >= 0 && t < sim.teams.length ? sim.teams[t] : null;
}

/** pts HP zadane trafieniem (D-037): punkty = scoring.hit × dmgPts / segmentPoints (zaokrąglone); brak → scoring.hit. */
export function awardHit(sim, shooter, target, dmgPts) {
  const pts = dmgPts === undefined ? CONFIG.scoring.hit
    : (CONFIG.scoring.hit * dmgPts / CONFIG.combat.segmentPoints + 0.5) | 0;   // | 0 → Smi (bez HeapNumber)
  shooter.stats.hits++;
  shooter.stats.score += pts;
  const T = teamOf(sim, shooter);
  if (T !== null) T.score += pts;
}

export function awardElim(sim, shooter, target) {
  const pts = CONFIG.scoring.elimination;
  shooter.stats.elims++;
  shooter.stats.score += pts;
  target.stats.deaths++;
  const T = teamOf(sim, shooter);
  if (T !== null) { T.score += pts; T.elims++; }
  const D = teamOf(sim, target);
  if (D !== null) D.deaths++;
}

/**
 * Wynik drużyny = suma wyników członków (liczone od zera z sim.participants).
 * out: tablica liczb (np. Float64Array(4)); out[t] dla t < out.length. Zwraca out.
 */
export function teamScores(sim, out) {
  for (let t = 0; t < out.length; t++) out[t] = 0;
  const ps = sim.participants;
  for (let i = 0; i < ps.length; i++) {
    const P = ps[i];
    if (P.team >= 0 && P.team < out.length) out[P.team] += P.stats.score;
  }
  return out;
}
