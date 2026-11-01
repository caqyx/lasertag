// Minimalny statyczny serwer dev: node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const BASE = ROOT.endsWith(sep) ? ROOT : ROOT + sep;

function resolvePath(url) {
  let path;
  try { path = decodeURIComponent(new URL(url, 'http://x').pathname); } catch { return null; }
  if (path.split('/').some((seg) => seg.startsWith('.'))) return null; // .git, .env, ukryte pliki
  const file = normalize(join(ROOT, path.endsWith('/') ? path + 'index.html' : path));
  return file.startsWith(BASE) ? file : null;
}

const server = createServer(async (req, res) => {
  const file = resolvePath(req.url);
  if (file === null) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// Tylko localhost — serwer deweloperski nie wystawia repo w sieci lokalnej.
server.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
