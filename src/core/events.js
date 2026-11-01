// Kolejka zdarzeń symulacji (PLAN §7.1). Pierścień prealokowanych rekordów — push() nie alokuje.
// Kolejkę czyści właściciel pętli raz na klatkę renderu (po odczycie przez render/HUD), nie stepSim.
// Przepełnienie: najstarszy rekord jest nadpisywany (licznik Q.dropped rośnie).
//
// Pola rekordu wg typu (a = sprawca id, b = cel id lub -1, team = drużyna sprawcy, sensor = indeks SENSOR lub -1):
//   SHOT        x,y,z = wylot lufy; x2,y2,z2 = koniec wiązki; b = trafiony uczestnik lub -1;
//               value: 0 = pudło (ściana/zasięg), 1 = trafienie, 2 = zablokowane ochroną celu (brak HIT)
//   HIT         x,y,z = punkt trafienia; x2,y2,z2 = wylot lufy strzelca; sensor = trafiony segment; value = HP celu po trafieniu
//   ELIM        a = eliminujący, b = wyeliminowany; x,y,z = pozycja (stopy) celu; team = drużyna eliminującego
//   RESPAWN     a = uczestnik; x,y,z = punkt spawnu; team = drużyna uczestnika
//   OVERHEAT    a = uczestnik; value = ciepło
//   PROTECT_END a = uczestnik; value: 1 = przerwana strzałem, 0 = upłynął czas
//   (D-037) SHOT z broni hitscan: nx,ny,nz = normalna trafionej powierzchni (value 0 i trafiona bryła/podłoga), inaczej 0
//   LAUNCH      a = strzelec (wyrzutnia); x,y,z = start pocisku; x2,y2,z2 = kierunek (jednostkowy); value = slot puli
//   BOUNCE      a = właściciel pocisku; x,y,z = punkt odbicia; nx,ny,nz = normalna powierzchni; x2,y2,z2 = nowy kierunek
//   PROJ_END    a = właściciel; b = trafiony lub -1; x,y,z = punkt końca; nx,ny,nz = normalna (ściana) lub 0;
//               x2,y2,z2 = kierunek lotu; value: 0 = 2. kontakt z powierzchnią, 1 = trafienie, 2 = ochrona celu, 3 = koniec życia

export const EV = Object.freeze({ SHOT: 1, HIT: 2, ELIM: 3, RESPAWN: 4, OVERHEAT: 5, PROTECT_END: 6, LAUNCH: 7, BOUNCE: 8, PROJ_END: 9 });

function createRec() {
  return {
    type: 0, time: 0.5, a: -1, b: -1, team: -1, sensor: -1,
    x: 0.5, y: 0.5, z: 0.5, x2: 0.5, y2: 0.5, z2: 0.5, nx: 0.5, ny: 0.5, nz: 0.5, value: 0.5,
  };
}

function resetRec(r, type) {
  r.type = type;
  r.time = 0;
  r.a = -1;
  r.b = -1;
  r.team = -1;
  r.sensor = -1;
  r.x = 0; r.y = 0; r.z = 0;
  r.x2 = 0; r.y2 = 0; r.z2 = 0;
  r.nx = 0; r.ny = 0; r.nz = 0;
  r.value = 0;
}

/**
 * @param {number} capacity liczba rekordów pierścienia
 * @returns {{ push(type:number): object, count: number, at(i:number): object, clear(): void, capacity: number, dropped: number }}
 */
export function createEventQueue(capacity) {
  const cap = Math.max(1, capacity | 0);
  const recs = new Array(cap);
  for (let i = 0; i < cap; i++) recs[i] = createRec();
  let start = 0;

  const Q = {
    capacity: cap,
    count: 0,
    dropped: 0,
    /** Rezerwuje rekord (pola wyzerowane, a/b/team/sensor = -1) i go zwraca. */
    push(type) {
      let idx;
      if (Q.count < cap) {
        idx = (start + Q.count) % cap;
        Q.count++;
      } else {
        idx = start;
        start = (start + 1) % cap;
        Q.dropped++;
      }
      const r = recs[idx];
      resetRec(r, type);
      return r;
    },
    /** i-ty rekord od najstarszego (0 ≤ i < count). */
    at(i) {
      return recs[(start + i) % cap];
    },
    clear() {
      start = 0;
      Q.count = 0;
    },
  };
  return Q;
}
