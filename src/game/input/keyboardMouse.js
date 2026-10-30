// InputSource gracza lokalnego: klawiatura + mysz (pointer lock). SPEC §9, PLAN §4.
// Konwencja kątów (PLAN §0): yaw rośnie w lewo → ruch myszy w prawo zmniejsza yaw.
// Bez alokacji w sample(): stan trzymany w prymitywach na poziomie instancji.
import { CONFIG } from '../../config.js';

const TWO_PI = Math.PI * 2;
const INV_SQRT2 = Math.SQRT1_2;

// Indeksy klawiszy logicznych
const K_FWD = 0, K_BACK = 1, K_LEFT = 2, K_RIGHT = 3, K_SPRINT = 4, K_JUMP = 5, K_SCORE = 6, K_CROUCH = 7;
const K_COUNT = 8;

function keyIndex(code) {
  switch (code) {
    case 'KeyW': case 'ArrowUp': return K_FWD;
    case 'KeyS': case 'ArrowDown': return K_BACK;
    case 'KeyA': case 'ArrowLeft': return K_LEFT;
    case 'KeyD': case 'ArrowRight': return K_RIGHT;
    case 'ShiftLeft': case 'ShiftRight': return K_SPRINT;
    case 'Space': return K_JUMP;
    case 'Tab': return K_SCORE;
    case 'KeyC': case 'ControlLeft': return K_CROUCH; // kucanie (przytrzymaj)
    default: return -1;
  }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onLockChange?: (locked:boolean) => void, onLockError?: () => void, captureUnlocked?: () => boolean }} [opts]
 *   Klawisze zapisywane (i Tab/Spacja/strzałki blokowane) tylko przy pointer locku albo gdy captureUnlocked() → true
 *   (np. ?autostart=1) — menu i ekran końca dostają klawisze normalnie.
 */
export function createKeyboardMouse(canvas, opts = {}) {
  const sens = CONFIG.player.mouseSensitivity;
  const pitchLimit = CONFIG.player.pitchLimit;
  const keys = new Uint8Array(K_COUNT);
  const onLockChange = opts.onLockChange || null;
  const onLockErrorCb = opts.onLockError || null;
  const captureUnlocked = opts.captureUnlocked || null;
  let fire = false;        // poziom (LPM trzymany)
  let firePressed = false; // zbocze — krótkie kliknięcie między krokami sim nie ginie (czyszczone w sample)
  let yaw = 0;
  let pitch = 0;
  let locked = false;
  let pending = false; // requestPointerLock wysłane, pointerlockchange jeszcze nie przyszło

  function clearKeys() {
    keys.fill(0);
    fire = false;
    firePressed = false;
  }

  function capturing() {
    return locked || (captureUnlocked !== null && captureUnlocked());
  }

  function onKeyDown(e) {
    const i = keyIndex(e.code);
    if (i < 0 || !capturing()) return;
    // Tab nie przenosi fokusu, Spacja/strzałki nie przewijają strony; Ctrl blokowany tylko przy locku (skróty przeglądarki)
    if (e.code !== 'ControlLeft' || locked) e.preventDefault();
    keys[i] = 1;
  }

  function onKeyUp(e) {
    const i = keyIndex(e.code);
    if (i < 0) return;
    if (capturing() && (e.code !== 'ControlLeft' || locked)) e.preventDefault();
    keys[i] = 0;
  }

  function onMouseMove(e) {
    if (!locked) return;
    yaw -= e.movementX * sens;
    pitch -= e.movementY * sens;
    if (pitch > pitchLimit) pitch = pitchLimit;
    else if (pitch < -pitchLimit) pitch = -pitchLimit;
    if (yaw > Math.PI) yaw -= TWO_PI;
    else if (yaw < -Math.PI) yaw += TWO_PI;
  }

  function onMouseDown(e) {
    if (e.button !== 0) return;
    if (capturing()) { fire = true; firePressed = true; }
  }

  function onMouseUp(e) {
    if (e.button === 0) fire = false;
  }

  function onCanvasClick() {
    if (!locked) requestLock();
  }

  function onLockStateChange() {
    const now = document.pointerLockElement === canvas;
    pending = false;
    if (now === locked) return;
    locked = now;
    if (!locked) clearKeys();
    if (onLockChange) onLockChange(locked);
  }

  function onLockError() {
    // Np. zbyt szybkie ponowne żądanie po Esc (Chrome wymaga ~1 s przerwy) — informujemy, użytkownik kliknie ponownie.
    pending = false;
    if (onLockErrorCb) onLockErrorCb();
  }

  function onBlur() {
    clearKeys();
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  // Wywoływać wyłącznie z obsługi gestu użytkownika (klik).
  function requestLock() {
    if (locked || typeof canvas.requestPointerLock !== 'function') return;
    pending = true;
    try {
      const p = canvas.requestPointerLock();
      if (p && typeof p.catch === 'function') p.catch(onLockError);
    } catch {
      onLockError();
    }
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('pointerlockchange', onLockStateChange);
  document.addEventListener('pointerlockerror', onLockError);
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    /** InputSource: wypełnia out (InputState) bez alokacji. participant/ctx nieużywane. */
    sample(participant, ctx, out) {
      let mx = keys[K_RIGHT] - keys[K_LEFT];
      let mz = keys[K_FWD] - keys[K_BACK];
      if (mx !== 0 && mz !== 0) { mx *= INV_SQRT2; mz *= INV_SQRT2; }
      out.moveX = mx;
      out.moveZ = mz;
      out.yaw = yaw;
      out.pitch = pitch;
      out.fire = fire || firePressed;
      firePressed = false;
      out.jump = keys[K_JUMP] === 1;
      out.sprint = keys[K_SPRINT] === 1;
      out.scoreboard = keys[K_SCORE] === 1;
      out.crouch = keys[K_CROUCH] === 1;
    },
    /** Ustawia kąty (np. ze spawnu). */
    setAngles(y, p) {
      yaw = y;
      pitch = p > pitchLimit ? pitchLimit : (p < -pitchLimit ? -pitchLimit : p);
    },
    requestLock,
    /** Zwalnia lock bezwarunkowo — także gdy żądanie jest w toku (pointerlockchange jeszcze nie przyszło). */
    exitLock() {
      const inFlight = pending;
      pending = false;
      if (document.exitPointerLock && (locked || inFlight || document.pointerLockElement)) document.exitPointerLock();
    },
    /** Tab trzymany (dla UI; nie zużywa zbocza strzału jak sample). */
    get scoreboard() { return keys[K_SCORE] === 1; },
    get yaw() { return yaw; },
    get pitch() { return pitch; },
    get locked() { return locked; },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('pointerlockchange', onLockStateChange);
      document.removeEventListener('pointerlockerror', onLockError);
      canvas.removeEventListener('click', onCanvasClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      if (locked && document.exitPointerLock) document.exitPointerLock();
      clearKeys();
    },
  };
}
