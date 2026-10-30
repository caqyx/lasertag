// Pasek meczu u góry ekranu (PLAN §9.2): timer, w tdm wyniki drużyn, w ffa lider + pozycja gracza;
// odliczanie startu na środku ekranu. update(M, sim) — DOM tylko przy zmianie.
import { CONFIG } from '../config.js';
import { el } from './dom.js';
import { formatTime } from './scoreboard.js';
import { teamColor, teamName } from '../game/modes.js';

const MAX_TEAMS = CONFIG.colors.teams.length;

export function createMatchBar(rootEl) {
  const root = el(rootEl, 'lt-mb');
  const teamsWrap = el(root, 'lt-mb-teams');
  const teams = [];
  for (let t = 0; t < MAX_TEAMS; t++) {
    const chip = el(teamsWrap, 'lt-mb-team');
    chip.style.setProperty('--c', teamColor(t));
    chip.title = teamName(t);
    const val = el(chip, 'lt-mb-team-val', '0');
    chip.style.display = 'none';
    teams.push({ chip, val, v: -1, lead: -1, shown: -1 });
  }
  const timer = el(root, 'lt-mb-timer', '0:00');
  const sub = el(root, 'lt-mb-sub');
  const leadName = el(sub, 'lt-mb-lead');
  const pos = el(sub, 'lt-mb-pos');

  const cdWrap = el(rootEl, 'lt-countdown');
  const cdNum = el(cdWrap, 'lt-countdown-num');
  const cdLabel = el(cdWrap, 'lt-countdown-label', 'PRZYGOTUJ SIĘ');

  let cTime = -1, cWarn = -1, cLeadId = -2, cLeadScore = -1, cPos = -1, cTotal = -1, cTeams = -1;
  let cCd = -2;
  const warnAt = CONFIG.match.timerWarn;
  const goTime = CONFIG.match.goTime;

  function update(M, sim) {
    // timer
    const t = Math.ceil(M.timeLeft);
    if (t !== cTime) { cTime = t; timer.textContent = formatTime(M.timeLeft); }
    const warn = M.state === 'playing' && M.timeLeft <= warnAt ? 1 : 0;
    if (warn !== cWarn) { cWarn = warn; timer.classList.toggle('warn', warn === 1); }

    // drużyny / lider
    const nt = M.teams;
    if (nt !== cTeams) {
      cTeams = nt;
      root.classList.toggle('ffa', nt === 0);
      root.classList.toggle('t4', nt >= 4);
      for (let i = 0; i < MAX_TEAMS; i++) teams[i].chip.style.display = i < nt ? '' : 'none';
    }
    if (nt > 0) {
      let best = 0;
      for (let i = 1; i < nt; i++) if (M.teamScore[i] > M.teamScore[best]) best = i;
      for (let i = 0; i < nt; i++) {
        const T = teams[i];
        const v = M.teamScore[i];
        if (v !== T.v) { T.v = v; T.val.textContent = v; }
        const lead = i === best && v > 0 ? 1 : 0;
        if (lead !== T.lead) { T.lead = lead; T.chip.classList.toggle('lead', lead === 1); }
      }
    } else {
      updateFfa(M, sim);
    }

    // odliczanie / START!
    let cd = -1; // -1 ukryte, 0 = START!, n = liczba
    if (M.state === 'countdown') cd = Math.max(1, Math.ceil(M.countdown));
    else if (M.state === 'playing' && M.sinceStart < goTime) cd = 0;
    if (cd !== cCd) {
      cCd = cd;
      cdWrap.classList.toggle('show', cd >= 0);
      cdWrap.classList.toggle('go', cd === 0);
      cdLabel.style.visibility = cd > 0 ? '' : 'hidden';
      if (cd >= 0) {
        cdNum.textContent = cd === 0 ? 'START!' : cd;
        // restart animacji
        cdNum.classList.remove('tick');
        void cdNum.offsetWidth;
        cdNum.classList.add('tick');
      }
    }
  }

  function updateFfa(M, sim) {
    const ps = sim.participants;
    let leader = null, player = null;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].id === M.leaderId) leader = ps[i];
      if (ps[i].isPlayer) player = ps[i];
    }
    const lid = leader ? leader.id : -1;
    const ls = leader ? leader.stats.score : 0;
    if (lid !== cLeadId || ls !== cLeadScore) {
      cLeadId = lid; cLeadScore = ls;
      const has = leader !== null && ls > 0;
      leadName.textContent = has ? 'LIDER ' + leader.name + ' · ' + ls : 'LIDER —';
      leadName.style.color = has ? leader.color : '';
    }
    if (player) {
      let p = 1;
      for (let i = 0; i < ps.length; i++) if (ps[i] !== player && ps[i].stats.score > player.stats.score) p++;
      if (p !== cPos || ps.length !== cTotal) {
        cPos = p; cTotal = ps.length;
        pos.textContent = 'TY #' + p + '/' + ps.length;
      }
    }
  }

  return {
    update,
    show(v) { root.classList.toggle('hidden', !v); if (!v) cdWrap.classList.remove('show'); cCd = -2; },
    dispose() { root.remove(); cdWrap.remove(); },
  };
}
