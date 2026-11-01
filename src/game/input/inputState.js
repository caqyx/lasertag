// InputState — wspólny format wejścia dla każdego InputSource (gracz, bot, sieć w M5).
// moveX/moveZ ∈ [-1,1] w układzie lokalnym (moveZ = +1 do przodu). yaw/pitch to kąty absolutne. crouch = trzymany kuc.

export function createInputState() {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, fire: false, jump: false, sprint: false, crouch: false, scoreboard: false };
}

export function resetInputState(s) {
  s.moveX = 0; s.moveZ = 0; s.fire = false; s.jump = false; s.sprint = false; s.crouch = false; s.scoreboard = false;
}
