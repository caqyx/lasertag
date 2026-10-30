// Pętla ze stałym krokiem symulacji i renderem co klatkę (SPEC §7: 60 Hz).
// Bez alokacji per klatkę: callback rAF tworzony raz, stan w zmiennych domknięcia.
import { CONFIG } from '../config.js';

export function createLoop({
  hz = CONFIG.sim.hz,
  maxSubSteps = CONFIG.sim.maxSubSteps,
  step,
  frame,
  raf = (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null),
  caf = (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null),
}) {
  const dt = 1 / hz;
  const maxFrameDt = dt * maxSubSteps; // dłuższe klatki są przycinane (czas „gubiony")
  let acc = 0;
  let last = -1;
  let handle = 0;
  let running = false;

  // Jedna klatka; t w ms (jak timestamp rAF). Zwraca liczbę wykonanych kroków.
  function tick(t) {
    let frameDt = last < 0 ? 0 : (t - last) / 1000;
    last = t;
    if (frameDt < 0) frameDt = 0;
    if (frameDt > maxFrameDt) frameDt = maxFrameDt;
    acc += frameDt;
    let n = 0;
    while (acc >= dt && n < maxSubSteps) {
      step(dt);
      acc -= dt;
      n++;
    }
    if (acc >= dt) acc = acc % dt; // zabezpieczenie (nie powinno wystąpić po clampie)
    frame(acc / dt, frameDt);
    return n;
  }

  function onFrame(t) {
    if (!running) return;
    tick(t); // wyjątek zatrzymuje pętlę (jeden błąd w konsoli zamiast lawiny)
    if (running) handle = raf(onFrame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = -1;
      acc = 0;
      handle = raf(onFrame);
    },
    stop() {
      running = false;
      if (caf && handle) caf(handle);
      handle = 0;
    },
    // Ręczny krok (testy / deterministyczne zrzuty): wykonuje pojedynczy krok symulacji i render.
    stepOnce() {
      step(dt);
      frame(0, dt);
    },
    tick,
    get running() { return running; },
  };
}
