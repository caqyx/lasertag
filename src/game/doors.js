// Drzwi przesuwne (MapData.doors → world.doors, world.doorOpen). Czysty JS, bez alokacji w stepDoors.
//
// Cel otwarcia wynika z czasu meczu (cykl: otwarte → zamykanie → zamknięte → otwieranie, przesunięty o phase), więc
// przebieg jest deterministyczny. Czujnik bezpieczeństwa: skrzydło nie zamyka się, jeśli nowa poza nachodzi na żywe
// ciało (koło gracza vs OBB w paśmie wysokości) — brak zgniatania i wypychania przez ściany. Otwieranie (do kieszeni
// w ścianie) nigdy nie jest blokowane. Stan żyje w świecie (bryły + doorOpen): jeden aktywny sim na świat.

import { CONFIG } from '../config.js';

// scratch (D-012: double przez bufor, nie przez argumenty/wynik nie-inline'owanej funkcji): [czas, wynik]
const TT = new Float64Array(2);

/** Docelowe otwarcie drzwi D w chwili TT[0] → TT[1] ∈ [0, 1]. Bez alokacji. */
function targetInto(D) {
  let u = (TT[0] + D.phase) % D.period;
  if (u < 0) u += D.period;
  let o;
  if (u < D.tOpen) o = 1;
  else if ((u -= D.tOpen) < D.tMove) o = 1 - u / D.tMove;
  else if ((u -= D.tMove) < D.tClosed) o = 0;
  else o = (u - D.tClosed) / D.tMove;
  TT[1] = o;
}

/** Docelowe otwarcie drzwi D w chwili t (wygoda: testy, render). */
export function doorTarget(D, t) {
  TT[0] = t;
  targetInto(D);
  return TT[1];
}

/** Ustawia bryłę drzwi i w pozie o stopniu otwarcia o (0 zamknięte, 1 otwarte). */
function placeDoor(world, i, o) {
  const D = world.doors[i];
  const s = world.solids[D.solid];
  s.cx = D.x0 + D.sx * o;
  s.cz = D.z0 + D.sz * o;
  world.doorOpen[i] = o;
}

/** Start meczu: drzwi od razu w pozie docelowej dla czasu time (bez animacji). */
export function resetDoors(world, time) {
  const doors = world.doors;
  if (doors === undefined) return;
  for (let i = 0; i < doors.length; i++) placeDoor(world, i, doorTarget(doors[i], time));
}

/** Czy bryła s nachodzi na żywe ciało któregoś uczestnika. */
function blocksBody(s, ps) {
  const P = CONFIG.player;
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k];
    if (p.state !== 'alive') continue;
    const b = p.body;
    if (!(s.y1 > b.y + P.stepHeight && s.y0 < b.y + b.height)) continue;
    const dx = b.x - s.cx, dz = b.z - s.cz;
    const lx = dx * s.cos - dz * s.sin, lz = dx * s.sin + dz * s.cos;
    const qx = lx < -s.hx ? lx + s.hx : lx > s.hx ? lx - s.hx : 0;
    const qz = lz < -s.hz ? lz + s.hz : lz > s.hz ? lz - s.hz : 0;
    const r = b.radius + CONFIG.elements.door.safety;
    if (qx * qx + qz * qz < r * r) return true;
  }
  return false;
}

/** Krok drzwi (w stepSim po zwiększeniu sim.time, przed ruchem uczestników): otwarcie dąży do celu z prędkością 1/tMove; zamykanie wstrzymane przez ciało. */
export function stepDoors(sim, dt) {
  const world = sim.world;
  const doors = world.doors;
  if (doors === undefined || doors.length === 0) return;
  const open = world.doorOpen;
  for (let i = 0; i < doors.length; i++) {
    const D = doors[i];
    const cur = open[i];
    TT[0] = sim.time;   // stepSim zwiększył już czas
    targetInto(D);
    const tgt = TT[1];
    const rate = dt / D.tMove;
    let o = tgt > cur ? (tgt - cur > rate ? cur + rate : tgt) : (cur - tgt > rate ? cur - rate : tgt);
    if (o === cur) continue;
    const s = world.solids[D.solid];
    const px = s.cx, pz = s.cz;
    s.cx = D.x0 + D.sx * o;
    s.cz = D.z0 + D.sz * o;
    if (o < cur && blocksBody(s, sim.participants)) { s.cx = px; s.cz = pz; continue; }   // czujnik: wstrzymaj zamykanie
    open[i] = o;
  }
}
