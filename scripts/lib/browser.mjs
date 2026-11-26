// scripts/lib/browser.mjs — tiny shared harness: static server for a build folder + headless
// Chrome/Edge over the DevTools protocol. Used by scripts/bake-portraits.mjs and
// scripts/load-check.mjs (the e2e runner keeps its own copy on purpose).
import {createServer} from 'http';
import {spawn,execFileSync} from 'child_process';
import {mkdtempSync,rmSync,existsSync,statSync,readFileSync} from 'fs';
import {tmpdir} from 'os';
import {join,extname,sep,resolve} from 'path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.glb': 'model/gltf-binary',
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findChrome() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean).find(p => existsSync(p)) || null;
}

/* openGame({root, query, throttle}) → {url, send, evaluate, waitFor, logs, close}
   throttle: {downBytesPerSecond, latencyMs} network shaping for the page (slow-link tests). */
export async function openGame({root, query = '?debug=1', throttle = null, beforeNavigate = null, gpu = false, url: urlOverride = null} = {}) {
  root = resolve(root); // absolute + native separators: the path-containment check below needs both
  const server = createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    if (p === '/') p = '/gun-to-gun.html';
    const file = join(root, p);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, {'Content-Type': MIME[extname(file)] || 'application/octet-stream'});
    res.end(readFileSync(file));
  });
  const port = await new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  const chrome = findChrome();
  if (!chrome) { server.close(); throw new Error('no Chrome/Edge found; set CHROME_PATH'); }
  const profile = mkdtempSync(join(tmpdir(), 'gtg-web-'));
  const debugPort = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(chrome, [
    '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-dev-shm-usage', '--mute-audio',
    // Software WebGL2 for machines without a usable GPU (gpu:true → real hardware, timing only)
    ...(gpu ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    'about:blank',
  ], {stdio: 'ignore'});

  let ws = null, nextId = 1;
  const pending = new Map();
  const logs = [];
  const send = (method, params = {}, timeoutMs = 60000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeoutMs);
    pending.set(id, {resolve, reject, timer});
    ws.send(JSON.stringify({id, method, params}));
  });

  const close = () => {
    try { server.close(); } catch {}
    try { ws && ws.close(); } catch {}
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {stdio: 'ignore'});
      else child.kill('SIGKILL');
    } catch {}
    try { rmSync(profile, {recursive: true, force: true}); } catch {}
  };

  try {
    let list = null;
    for (let i = 0; i < 100 && !list; i++) {
      try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/list`); if (r.ok) list = await r.json(); } catch {}
      if (!list) await sleep(150);
    }
    if (!list) throw new Error('Chrome DevTools endpoint did not come up');
    const page = list.find(t => t.type === 'page');
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
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent') {
        logs.push('NET ' + Math.round(msg.params.timestamp * 1000) + ' ' + msg.params.request.method + ' ' + msg.params.request.url.replace(/^https?:\/\/[^/]+/, '') + ' type=' + msg.params.type + (msg.params.initiator && msg.params.initiator.type ? ' via ' + msg.params.initiator.type : ''));
      } else if (msg.method === 'Network.loadingFinished') {
        logs.push('NET-END ' + Math.round(msg.params.timestamp * 1000) + ' ' + msg.params.encodedDataLength + 'B');
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push((msg.params.args || []).map(a => a.value != null ? String(a.value) : (a.description || '')).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.exceptionDetails;
        logs.push('EXCEPTION ' + (d.exception && d.exception.description || d.text));
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    if (throttle) {
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', {
        offline: false, latency: throttle.latencyMs || 0,
        downloadThroughput: throttle.downBytesPerSecond, uploadThroughput: throttle.downBytesPerSecond,
      });
    }
    const url = urlOverride || `http://127.0.0.1:${port}/${query}`;
    if (beforeNavigate) await beforeNavigate(send);
    await send('Page.navigate', {url});

    const evaluate = async (expression, timeoutMs) => {
      const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}, timeoutMs);
      if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
      // an unserialisable value (DOM node, cyclic object) still means "the expression evaluated"
      if (r.result && r.result.type === 'object' && r.result.value === undefined) return r.result.objectId ? true : undefined;
      return r.result && r.result.value;
    };
    const waitFor = async (expression, timeoutMs = 120000, stepMs = 100) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try { const v = await evaluate(expression); if (v) return v; } catch {}
        await sleep(stepMs);
      }
      throw new Error('timed out waiting for: ' + expression);
    };
    return {url, port, send, evaluate, waitFor, logs, close};
  } catch (e) {
    close();
    throw e;
  }
}
