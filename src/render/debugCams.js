// Kamery debug (SPEC §6): ?cam=<indeks|nazwa> → kamera ustawiona wg world.cams.

function findCam(cams, camParam) {
  if (!cams || cams.length === 0 || camParam === null || camParam === undefined) return null;
  if (typeof camParam === 'number' || /^\d+$/.test(String(camParam))) {
    const i = Number(camParam);
    return Number.isInteger(i) && i >= 0 && i < cams.length ? cams[i] : null;
  }
  const name = String(camParam).toLowerCase();
  for (let i = 0; i < cams.length; i++) {
    if (String(cams[i].name).toLowerCase() === name) return cams[i];
  }
  return null;
}

/** Ustawia position + lookAt kamery. Zwraca false, gdy kamera nie istnieje. */
export function applyDebugCam(camera, world, camParam) {
  const cam = findCam(world && world.cams, camParam);
  if (!cam) return false;
  camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
  camera.lookAt(cam.look[0], cam.look[1], cam.look[2]);
  camera.updateMatrixWorld();
  return true;
}

/** Lista kamer: [{ index, name }]. */
export function listDebugCams(world) {
  const cams = (world && world.cams) || [];
  return cams.map((c, index) => ({ index, name: c.name }));
}
