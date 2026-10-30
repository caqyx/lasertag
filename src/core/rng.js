// Deterministyczny RNG (mulberry32). Czysty JS, bez alokacji w next()/range()/int()/pick().

/**
 * @param {number} seed  dowolna liczba (rzutowana na uint32)
 * @returns {{ next(): number, range(a:number,b:number): number, int(a:number,b:number): number, pick<T>(arr:T[]): T, seed: number }}
 */
export function createRng(seed) {
  let state = (seed >>> 0) || 0;

  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    seed: seed >>> 0,
    next,
    /** liczba rzeczywista w [a, b) */
    range(a, b) { return a + (b - a) * next(); },
    /** liczba całkowita w [a, b] (obustronnie domknięty) */
    int(a, b) { return a + Math.floor((b - a + 1) * next()); },
    /** losowy element tablicy (undefined dla pustej) */
    pick(arr) { return arr[Math.floor(arr.length * next())]; },
  };
}
