// Serves the scope app on http://localhost:8022 and opens it in a Chrome/Edge app window.
// WebUSB needs a secure origin; localhost counts. Keeping the same port keeps the USB permission remembered.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8022;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const FILES = new Set(['index.html', 'app.js', 'scope-driver.js', 'firmware.js', 'dsp.js', 'sim-scope.js']);

const server = http.createServer(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)) || 'index.html';
  if (!FILES.has(name)) { res.writeHead(404).end('not found'); return; }
  try {
    const body = await readFile(path.join(ROOT, name));
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body);
  } catch { res.writeHead(500).end(); }
});

function openBrowser() {
  const url = `http://localhost:${PORT}/`;
  const candidates = [
    `${process.env['ProgramFiles']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['LocalAppData']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['ProgramFiles']}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ];
  const exe = candidates.find(p => p && existsSync(p));
  if (exe) spawn(exe, [`--app=${url}`, '--window-size=1400,860'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Hantek Scope running at ${url}`);
  console.log('Keep this window open while you use the scope. Close it to quit.');
}

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log('Already running; opening another window.'); openBrowser(); setTimeout(() => process.exit(0), 500); }
  else { console.error(e); process.exit(1); }
});
server.listen(PORT, '127.0.0.1', () => { if (!process.argv.includes('--no-open')) openBrowser(); });
