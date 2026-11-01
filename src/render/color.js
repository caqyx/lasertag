// Wspólne helpery koloru dla warstwy render (beams/avatars/viewModel).

/** '#rrggbb' | 0xrrggbb → liczba 0xrrggbb, bez alokacji (bez regexów/substringów). */
export function hexNumber(c) {
  if (typeof c === 'number') return c;
  let n = 0;
  const start = c.charCodeAt(0) === 35 ? 1 : 0; // '#'
  for (let i = start; i < start + 6; i++) {
    const ch = c.charCodeAt(i);
    const v = ch <= 57 ? ch - 48 : (ch | 32) - 87; // 0-9, a-f/A-F
    n = (n << 4) | (v & 15);
  }
  return n >>> 0;
}
