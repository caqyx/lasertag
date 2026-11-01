// Zdarzenia broni z symulacji → efekty (D-037): wiązki (fazer/pistolet: szerokość i czas z CONFIG.weapons), odłamki
// przy trafieniu w ścianę/przeszkodę/podłogę (kierunek odbity od normalnej), pociski wyrzutni (render/projectiles.js),
// odłamki przy odbiciu i zniknięciu pocisku. Bez alokacji (argumenty przez beams.A — D-012).
// createShotFx({ beams, projFx, viewModel }) → { consume(sim, player, debugCam) → fired, sync(sim, alpha, player, debugCam) }
import { Vector3 } from 'three';
import { CONFIG } from '../config.js';
import { EV } from '../core/events.js';
import { groundHeight } from '../world/physics.js';
import { findParticipant } from '../game/sim.js';

const FLOOR_PROBE = 0.05;   // m — punkt zapytania o podłogę odsunięty od powierzchni wzdłuż normalnej
const FX = CONFIG.fx;

export function createShotFx({ beams, projFx, viewModel }) {
  const A = beams.A;
  const muzzle = new Vector3();
  const below = CONFIG.player.stepHeight + 0.01;

  /** Wysokość podłogi pod punktem A[px..] (odsuniętym o normalną) → zapisana w A[slot]. */
  function floorUnder(sim, px, py, pz, slot) {
    // groundHeight zwraca powierzchnię ≤ feetY + stepHeight; feetY = y − stepHeight → nie wyżej niż punkt
    A[slot] = groundHeight(sim.world, px, pz, py - below, 0);
  }

  function shotBeam(sim, e, shooter, own) {
    if (own) {
      // wizualnie wiązka gracza startuje z widocznej lufy FPP (sim liczy strzał z oka)
      viewModel.muzzleWorld(muzzle);
      A[0] = muzzle.x; A[1] = muzzle.y; A[2] = muzzle.z;
    } else {
      A[0] = e.x; A[1] = e.y; A[2] = e.z;
    }
    A[3] = e.x2; A[4] = e.y2; A[5] = e.z2;
    A[6] = e.nx; A[7] = e.ny; A[8] = e.nz;
    floorUnder(sim, e.x2 + e.nx * FLOOR_PROBE, e.y2 + e.ny * FLOOR_PROBE, e.z2 + e.nz * FLOOR_PROBE, 9);
    const WC = shooter.weapon.C;
    A[10] = WC.beamWidth;
    A[11] = WC.beamDuration;
    beams.shot(shooter.color, e.value === 1);
  }

  /** Odłamki w punkcie e.x..z w kierunku (dx,dy,dz). */
  function burst(sim, e, owner, dx, dy, dz, power) {
    A[0] = e.x; A[1] = e.y; A[2] = e.z;
    A[3] = dx; A[4] = dy; A[5] = dz;
    floorUnder(sim, e.x + e.nx * FLOOR_PROBE, e.y + e.ny * FLOOR_PROBE, e.z + e.nz * FLOOR_PROBE, 6);
    beams.shards(owner.color, power);
  }

  function consume(sim, player, debugCam) {
    const q = sim.events;
    let fired = false;
    for (let i = 0; i < q.count; i++) {
      const e = q.at(i);
      const t = e.type;
      if (t !== EV.SHOT && t !== EV.LAUNCH && t !== EV.BOUNCE && t !== EV.PROJ_END) continue;
      const P = findParticipant(sim, e.a);
      if (P === null) continue;
      if (t === EV.SHOT) {
        shotBeam(sim, e, P, e.a === player.id && !debugCam);
        if (e.a === player.id) fired = true;
      } else if (t === EV.LAUNCH) {
        if (e.a === player.id) fired = true;
      } else if (t === EV.BOUNCE) {
        burst(sim, e, P, e.x2, e.y2, e.z2, FX.wallPower);   // nowy kierunek = odbity
      } else if (e.value === 0) {
        // 2. kontakt: odłamki odbite od powierzchni
        const dn = e.x2 * e.nx + e.y2 * e.ny + e.z2 * e.nz;
        burst(sim, e, P, e.x2 - 2 * dn * e.nx, e.y2 - 2 * dn * e.ny, e.z2 - 2 * dn * e.nz, FX.wallPower);
      } else if (e.value === 1 || e.value === 2) {
        burst(sim, e, P, -e.x2, -e.y2, -e.z2, 1);         // trafienie uczestnika: iskry ku strzelcowi
      }
    }
    return fired;
  }

  /** Pociski z puli sim (co klatkę). Własne pociski gracza startują wizualnie z lufy FPP. */
  function sync(sim, alpha, player, debugCam) {
    if (sim === null) { projFx.sync(null, alpha, -1, null); return; }
    let local = -1;
    if (!debugCam && sim.proj.count > 0) {
      local = sim.participants.indexOf(player);
      viewModel.muzzleWorld(muzzle);
    }
    projFx.sync(sim, alpha, local, local >= 0 ? muzzle : null);
  }

  return { consume, sync };
}
