// Wspólne helpery DOM dla UI (hud, scoreboard, …). Używane tylko przy budowie elementów, nie w pętli.

/** Tworzy <tag class=cls>text</tag> i dołącza do parent. Zwraca element. */
export function el(parent, cls, text, tag = 'div') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null && text !== '') e.textContent = text; // 0 też jest treścią
  if (parent) parent.appendChild(e);
  return e;
}
