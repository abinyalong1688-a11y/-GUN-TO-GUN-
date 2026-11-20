// build.mjs — bundle with esbuild into a single HTML file (all JS/CSS inlined, zero external requests)
import * as esbuild from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,statSync} from 'fs';

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  charset: 'utf8',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});

let js = result.outputFiles[0].text
  .replace(/<\/script/gi, '<\\/script'); // keep the bundle from closing the script tag early

const css = readFileSync('src/style.css', 'utf-8');
const template = readFileSync('src/template.html', 'utf-8');
const html = template
  .replace('/*__CSS__*/', () => css)
  .replace('//__JS__', () => js);

// PWA offline support: service worker + manifest are emitted with dist (the three deploy artifacts)
// The SW cache name gets the package.json version so it stays in sync with the game VERSION and old caches do not linger
const {version} = JSON.parse(readFileSync('package.json', 'utf-8'));
const sw = readFileSync('src/sw.js', 'utf-8').replace('gtg-v__VERSION__', `gtg-v${version}`);
const manifest = readFileSync('src/manifest.webmanifest', 'utf-8');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/gun-to-gun.html', html);
writeFileSync('dist/sw.js', sw);
writeFileSync('dist/manifest.webmanifest', manifest);
const mb = statSync('dist/gun-to-gun.html').size / 1024 / 1024;
console.log(`✓ dist/gun-to-gun.html  ${mb.toFixed(2)} MB  ${mb <= 5 ? '(within the 5 MB budget)' : '(OVER the 5 MB budget!)'}`);
console.log('✓ dist/sw.js + dist/manifest.webmanifest  (PWA offline support: all three deploy artifacts)');
