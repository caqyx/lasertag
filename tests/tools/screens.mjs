// Zrzuty do pętli wizualnej (SPEC §6) + renderer.info per kamera.
// Użycie: npm run screens -- [--map uvmaze] [--preset ultra] [--out screenshots/m0] [--w 1280 --h 720]
// Wynik: <out>/<map>-<preset>-<cam>.png oraz <out>/info.json
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}

const maps = arg('map', 'uvmaze').split(',');
const presets = arg('preset', 'ultra').split(',');
const out = arg('out', 'screenshots/latest');
const width = Number(arg('w', 1280));
const height = Number(arg('h', 720));
const port = Number(arg('port', 8091));
const settle = Number(arg('settle', 1500));

const server = spawn('node', ['tools/serve.mjs', String(port)], { cwd: ROOT, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 400));

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
await mkdir(`${ROOT}/${out}`, { recursive: true });
const report = {};
let failures = 0;

try {
  for (const map of maps) {
    for (const preset of presets) {
      const page = await browser.newPage({ viewport: { width, height } });
      const problems = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      await page.goto(`http://localhost:${port}/?map=${map}&preset=${preset}&cam=0&nohud=1&seed=1`);
      await page.waitForFunction(() => window.__lt && window.__lt.ready, null, { timeout: 60000 });
      const cams = await page.evaluate(() => (window.__lt.cams ? window.__lt.cams() : null));
      const count = cams ? cams.length : 5;
      for (let i = 0; i < count; i++) {
        await page.evaluate((n) => window.__lt.setCam(n), i);
        await page.waitForTimeout(settle);
        const info = await page.evaluate(() => ({ ...window.__lt.info() }));
        const name = cams ? cams[i] : String(i);
        const file = `${out}/${map}-${preset}-${i}-${name}.png`;
        await page.screenshot({ path: `${ROOT}/${file}`, timeout: 120000 });
        report[`${map}/${preset}/${name}`] = { file, info };
        console.log(file, JSON.stringify(info));
      }
      if (problems.length) { failures++; console.log(`CONSOLE PROBLEMS ${map}/${preset}:\n  ` + problems.join('\n  ')); }
      report[`${map}/${preset}/console`] = problems;
      await page.close();
    }
  }
  await writeFile(`${ROOT}/${out}/info.json`, JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.kill();
}
process.exit(failures ? 1 : 0);
