// ?stats=1 → stats.js (FPS/MS) + panel tekstowy z graphics.info(), odświeżany co ~0.5 s.
import Stats from 'three/addons/libs/stats.module.js';

const REFRESH_MS = 500;

export function createStatsOverlay(graphics) {
  const stats = new Stats();
  stats.showPanel(0);
  document.body.appendChild(stats.dom);

  const panel = document.createElement('div');
  panel.id = 'stats-info';
  document.body.appendChild(panel);

  let lastUpdate = -Infinity;

  function refresh() {
    const i = graphics.info();
    panel.textContent =
      'preset ' + graphics.presetName +
      '\ncalls  ' + i.calls +
      '\ntris   ' + i.triangles +
      '\ntex    ' + i.textures +
      '\ngeom   ' + i.geometries +
      '\nprog   ' + i.programs;
  }

  return {
    begin() { stats.begin(); },
    end() {
      stats.end();
      const now = performance.now();
      if (now - lastUpdate >= REFRESH_MS) {
        lastUpdate = now;
        refresh();
      }
    },
    dispose() {
      stats.dom.remove();
      panel.remove();
    },
  };
}
