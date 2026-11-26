// scripts/load-check.mjs — slow-link loading check for the WEB build (dist/ layout: static
// loading screen + baked thumbnails in the page, character rigs as separate files).
//
//   node scripts/load-check.mjs [kbPerSecond] [--gpu]
//
// Under network throttling it records, from in-page timestamps (so a busy main thread cannot
// skew them):
//   first paint      – the static loading screen with the 8 operator faces (no JS needed)
//   bundle received  – end of the HTML download (= when the program can start)
//   menu ready       – the Game constructor finished (operator cards show baked thumbnails)
//   rigs ready       – character models downloaded + decoded; cards switch to live renders
// Software WebGL (default) makes "menu ready" far slower than on real hardware; pass --gpu on a
// machine with a GPU for realistic boot numbers. The pass/fail rules do not depend on GPU speed.
import {execFileSync} from 'child_process';
import {mkdirSync,rmSync,statSync,readdirSync} from 'fs';
import {resolve,join} from 'path';
import {openGame} from './lib/browser.mjs';

const KB = Number(process.argv[2] || 60);
const GPU = process.argv.includes('--gpu');
const ROOT = resolve('dist/loadcheck');
rmSync(ROOT, {recursive: true, force: true});
mkdirSync(ROOT, {recursive: true});
execFileSync(process.execPath, ['build.mjs'], {stdio: 'ignore', env: {...process.env, GTG_DEBUG: '1', GTG_OUT: 'dist/loadcheck'}});

const kb = f => statSync(f).size / 1024;
const htmlKb = kb(join(ROOT, 'gun-to-gun.html'));
const rigDir = join(ROOT, 'assets/characters');
const rigKb = readdirSync(rigDir).reduce((s, f) => s + kb(join(rigDir, f)), 0);

const errors = [];
const page = await openGame({root: ROOT, query: '?debug=1', gpu: GPU, throttle: {downBytesPerSecond: KB * 1024, latencyMs: 40}});
const PROBE = `(()=>{
  const src=[...document.querySelectorAll('.op-card .op-portrait')].map(c=>c.style.backgroundImage||'');
  const mark=n=>{const m=performance.getEntriesByName(n)[0];return m?m.startTime:null;};
  const paint=n=>{const p=performance.getEntriesByName(n)[0];return p?p.startTime:null;};
  const nav=performance.getEntriesByType('navigation')[0];
  return {firstPaint:paint('first-paint'),bundleEnd:nav?nav.responseEnd:null,menuReady:mark('gtg:ready'),
    cards:src.length,baked:src.filter(s=>s.includes('jpeg')).length,png:src.filter(s=>s.includes('png')).length,
    rigReq:performance.getEntriesByType('resource').filter(e=>/\\.glb/.test(e.name)).map(e=>[Math.round(e.startTime),Math.round(e.responseEnd)]),
    ready:!!(window.__modelAssets&&window.__modelAssets.isReady()),failed:!!(window.__modelAssets&&window.__modelAssets.error()),
    bootGone:!document.getElementById('boot')};
})()`;
try {
  // first snapshot as soon as the menu exists (cards built, rigs possibly still downloading)
  await page.waitFor(`document.querySelectorAll('.op-card').length===8`, 300000, 100);
  const atMenu = await page.evaluate(PROBE);
  await page.waitFor('window.__modelAssets&&window.__modelAssets.isReady()&&document.querySelectorAll(".op-card .op-portrait").length===8', 300000, 100);
  await new Promise(r => setTimeout(r, 400)); // roster rebuild after onReady
  const end = await page.evaluate(PROBE);
  for (const l of page.logs) if (/^EXCEPTION|Uncaught|GLB load failed/i.test(l)) errors.push(l);
  if (!end.ready && end.failed) errors.push('rig load failed');
  const f = ms => ms == null ? '   —  ' : (ms / 1000).toFixed(1).padStart(6) + 's';
  console.log(`[load-check] link ${KB} KB/s · ${GPU ? 'real GPU' : 'software WebGL (boot numbers are pessimistic)'} · page ${htmlKb.toFixed(0)} KB + rigs ${rigKb.toFixed(0)} KB`);
  console.log(`[load-check]   ${f(end.firstPaint)}  loading screen with operator faces painted (static HTML, before any JS)`);
  console.log(`[load-check]   ${f(end.bundleEnd)}  program downloaded`);
  console.log(`[load-check]   ${f(end.menuReady)}  menu ready (operator cards: ${atMenu.baked} baked faces / ${atMenu.png} live)`);
  console.log(`[load-check]   ${f(end.rigReq.length ? end.rigReq[end.rigReq.length - 1][1] : null)}  character models downloaded → cards on live renders: ${end.png}/8`);
  const problems = [];
  if (end.firstPaint == null || end.bundleEnd == null || !(end.firstPaint < end.bundleEnd * 0.5)) problems.push('loading screen did not paint well before the program finished downloading');
  if (atMenu.baked !== 8) problems.push(`menu appeared with ${atMenu.baked}/8 baked faces`);
  if (end.png !== 8 || !end.ready) problems.push(`cards did not switch to live renders (${end.png}/8)`);
  if (!end.bootGone) problems.push('loading screen was not removed');
  if (errors.length) problems.push(...errors.slice(0, 3));
  if (problems.length) { console.error('[load-check] FAIL: ' + problems.join(' | ')); process.exitCode = 1; }
  else console.log('[load-check] PASS');
} finally {
  page.close();
  rmSync(ROOT, {recursive: true, force: true});
}
process.exit(process.exitCode || 0);
