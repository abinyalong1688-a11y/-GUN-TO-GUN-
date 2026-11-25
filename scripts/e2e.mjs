#!/usr/bin/env node
// e2e.mjs — headless end-to-end runner for the ?e2e=1 suite.
//
//   npm run test:e2e              (uses dist/gun-to-gun.html, builds if missing)
//   node scripts/e2e.mjs --build  (rebuild first)
//
// Starts a tiny static server for dist/, launches the installed Chrome/Edge with a private
// profile, drives it over the DevTools Protocol (no npm dependencies), waits for
// window.__e2e and exits non-zero if any in-browser assertion failed. Console output is
// forwarded so [E2E] / ERR lines show up in CI logs.
import {createServer} from 'http';
import {readFileSync, existsSync, statSync, mkdtempSync, rmSync} from 'fs';
import {join, extname, resolve, sep} from 'path';
import {tmpdir} from 'os';
import {spawn, execFileSync} from 'child_process';

const ROOT = resolve('dist');
const HTML = join(ROOT, 'gun-to-gun.html');
const args = new Set(process.argv.slice(2));
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 180000);

if (!existsSync(HTML) || args.has('--build')) {
  console.log('[e2e] building dist…');
  execFileSync(process.execPath, ['build.mjs'], {stdio: 'inherit'});
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/gun-to-gun.html';
  const file = join(ROOT, p);
  if (!file.startsWith(ROOT + sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, {'Content-Type': MIME[extname(file)] || 'application/octet-stream'});
  res.end(readFileSync(file));
});

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = chromeCandidates.find(p => existsSync(p));
if (!chrome) {
  console.error('[e2e] no Chrome/Edge found; set CHROME_PATH');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const profile = mkdtempSync(join(tmpdir(), 'gtg-e2e-'));
const debugPort = 9200 + Math.floor(Math.random() * 600);
const chromeArgs = [
  '--headless=new',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-dev-shm-usage',
  '--mute-audio',
  // Software WebGL2 for machines/CI without a usable GPU.
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  'about:blank',
];
const child = spawn(chrome, chromeArgs, {stdio: 'ignore'});

let ws = null;
let nextId = 1;
const pending = new Map();
const logs = [];

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
    pending.set(id, {resolve, reject, timer});
    ws.send(JSON.stringify({id, method, params}));
  });
}

function cleanup() {
  try { server.close(); } catch {}
  try { ws && ws.close(); } catch {}
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore'});
    else child.kill('SIGKILL');
  } catch {}
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}

let exitCode = 1;
try {
  // Wait for the DevTools endpoint.
  let list = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (r.ok) { list = await r.json(); break; }
    } catch {}
    await sleep(150);
  }
  if (!list) throw new Error('Chrome DevTools endpoint did not come up');
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('no page target');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, {once: true});
    ws.addEventListener('error', reject, {once: true});
  });
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map(a => a.value != null ? String(a.value) : (a.description || '')).join(' ');
      logs.push(text);
      if (/\[E2E\]|\[PERF\]|^ERR|error/i.test(text)) console.log('[console]', text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push('EXCEPTION ' + (d.exception && d.exception.description || d.text));
      console.log('[console] EXCEPTION', d.exception && d.exception.description || d.text);
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  const url = `http://127.0.0.1:${port}/?e2e=1`;
  await send('Page.navigate', {url});
  console.log('[e2e] opened', url);

  const started = Date.now();
  let result = null;
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(500);
    const r = await send('Runtime.evaluate', {expression: 'window.__e2e || null', returnByValue: true});
    if (r.result && r.result.value) { result = r.result.value; break; }
  }
  if (!result) {
    const r = await send('Runtime.evaluate', {
      expression: '({url:location.href, errors:(window.__game&&window.__game.ui&&window.__game.ui.errors)||[], state:window.__game&&window.__game.state})',
      returnByValue: true,
    });
    throw new Error('timed out waiting for window.__e2e: ' + JSON.stringify(r.result && r.result.value));
  }
  const failed = result.results.filter(r => !r.ok);
  for (const row of result.results) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name}${row.ok ? '' : ' :: ' + row.err}`);
  console.log(`\n[e2e] ${result.pass}/${result.results.length} PASS, ${result.fail} FAIL`);
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('[e2e] FAILED:', err && err.message || err);
  if (logs.length) console.error('[e2e] last console lines:\n' + logs.slice(-20).join('\n'));
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
