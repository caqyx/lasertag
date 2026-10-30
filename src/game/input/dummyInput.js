// InputSource manekina treningowego (PLAN §7.6): stoi lub chodzi lewo-prawo (okres CONFIG.combat.dummy.strafePeriod).
// Nigdy nie strzela. Patrzy w kierunku, w którym go postawiono (spawn). Bez alokacji w sample().

import { CONFIG } from '../../config.js';

/** @param {{ strafe?: boolean }} [o] */
export function createDummyInput(o) {
  const strafe = !!(o && o.strafe);
  return {
    strafe,
    sample(P, sim, out) {
      const D = CONFIG.combat.dummy;
      out.moveZ = 0;
      out.fire = false;
      out.jump = false;
      out.sprint = false;
      out.scoreboard = false;
      out.yaw = P.body.yaw;
      out.pitch = 0;
      if (!strafe) { out.moveX = 0; return; }
      // faza przesunięta o id → manekiny nie chodzą synchronicznie; deterministyczne (czas symulacji)
      const ph = ((sim.time / D.strafePeriod) + P.id * 0.37) % 1;
      out.moveX = ph < 0.5 ? D.strafeMove : -D.strafeMove;
    },
  };
}
