// Ekran końca meczu (PLAN §9.2): wynik z perspektywy gracza, zwycięzca, tabela końcowa,
// „Jeszcze raz" (Enter / R) i „Menu" (M / Backspace). Strzałki ←/→ przełączają przycisk.
import { el } from './dom.js';
import { createStandingsTable, formatTime } from './scoreboard.js';
import { getMode, teamName, teamColor } from '../game/modes.js';
import { outcomeFor } from '../game/match.js';

const TITLES = { win: 'ZWYCIĘSTWO', lose: 'PORAŻKA', draw: 'REMIS' };

export function createEndScreen(rootEl, onRestart, onMenu) {
  const root = el(rootEl, 'lt-end');
  const panel = el(root, 'lt-end-panel lt-panel');
  const title = el(panel, 'lt-end-title');
  const sub = el(panel, 'lt-end-sub');
  const meta = el(panel, 'lt-end-meta');
  const table = createStandingsTable(panel);
  const btns = el(panel, 'lt-end-btns');
  const bRestart = el(btns, 'lt-btn lt-btn-primary', 'JESZCZE RAZ', 'button');
  const bMenu = el(btns, 'lt-btn', 'MENU', 'button');
  el(panel, 'lt-end-hint', 'Enter — jeszcze raz · M — menu');
  bRestart.type = 'button';
  bMenu.type = 'button';

  let visible = false;
  let focus = 0;

  function setFocus(i) {
    focus = i;
    bRestart.classList.toggle('focus', i === 0);
    bMenu.classList.toggle('focus', i === 1);
  }

  function fire(i) {
    if (!visible) return;
    if (i === 0) onRestart && onRestart();
    else onMenu && onMenu();
  }

  function onKey(e) {
    if (!visible) return;
    switch (e.code) {
      case 'ArrowLeft': case 'ArrowRight': case 'KeyA': case 'KeyD':
        setFocus(focus === 0 ? 1 : 0); e.preventDefault(); break;
      case 'Enter': case 'NumpadEnter': case 'Space':
        e.preventDefault(); fire(focus); break;
      case 'KeyR': fire(0); break;
      case 'KeyM': case 'Backspace': e.preventDefault(); fire(1); break;
      default: break;
    }
  }

  bRestart.addEventListener('click', () => fire(0));
  bMenu.addEventListener('click', () => fire(1));
  bRestart.addEventListener('mouseenter', () => setFocus(0));
  bMenu.addEventListener('mouseenter', () => setFocus(1));
  window.addEventListener('keydown', onKey);

  function show(M, sim) {
    const ps = sim.participants;
    let player = null;
    for (let i = 0; i < ps.length; i++) if (ps[i].isPlayer) { player = ps[i]; break; }
    const res = player ? outcomeFor(M, player) : 'draw';
    title.textContent = TITLES[res];
    root.dataset.result = res;

    let winColor = '#ffffff';
    if (M.winnerKind === 'team') {
      winColor = teamColor(M.winner);
      sub.textContent = 'Wygrywa drużyna: ' + teamName(M.winner);
    } else if (M.winnerKind === 'player') {
      let w = null;
      for (let i = 0; i < ps.length; i++) if (ps[i].id === M.winner) { w = ps[i]; break; }
      winColor = w ? w.color : winColor;
      sub.textContent = w && w.isPlayer ? 'Najlepszy wynik na arenie' : 'Wygrywa: ' + (w ? w.name : '?');
    } else {
      sub.textContent = 'Równy wynik i eliminacje na szczycie tabeli';
    }
    root.style.setProperty('--win', winColor);

    const m = getMode(M.modeId);
    const reason = M.endReason === 'limit' ? 'Limit ' + m.elimLimit + ' eliminacji' : 'Koniec czasu';
    meta.textContent = m.short + ' · ' + reason + ' · czas gry ' + formatTime(M.elapsed);

    table.render(M, sim);
    visible = true;
    root.classList.add('show');
    setFocus(0);
  }

  function hide() {
    visible = false;
    root.classList.remove('show');
  }

  return {
    show,
    hide,
    get visible() { return visible; },
    dispose() {
      window.removeEventListener('keydown', onKey);
      table.dispose();
      root.remove();
    },
  };
}
