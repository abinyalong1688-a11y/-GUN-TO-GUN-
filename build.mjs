// build.mjs — bundle with esbuild into a single HTML file (all JS/CSS inlined, zero external requests)
import * as esbuild from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,statSync,copyFileSync} from 'fs';

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

// Character GLBs: four shared rigs — one male + one female per faction — across the 8-operator
// roster. Nova: female1 / male1, Rogue: male11 / female11 (modelAssets.js maps every operator
// to the rig for its faction + gender). Palette tint, camos and addExtrasGLTF still carry the
// per-operator identity; only baked headgear is shared. Cuts the embedded payload by ~46 %.
// They are INERT <script> tags placed AFTER the main bundle, so the menu is interactive while
// the model payload is still streaming in; each is read on demand by modelAssets.js.
const SHARED_MODELS = ['female1', 'male1', 'male11', 'female11'];
let glbTags = '';
for (const g of SHARED_MODELS) {
  try {
    const b = readFileSync(`assets/characters/${g}.glb`);
    const url = `data:model/gltf-binary;base64,${b.toString('base64')}`;
    glbTags += `<script type="application/octet-stream" id="gtg-glb-${g}">${url}</script>\n`;
  } catch (e) { /* missing file → runtime fetch fallback → procedural characters */ }
}

const css = readFileSync('src/style.css', 'utf-8');
const template = readFileSync('src/template.html', 'utf-8');
const html = template
  .replace('<!--__GLB__-->', () => glbTags)
  .replace('/*__CSS__*/', () => css)
  .replace('//__JS__', () => js);

// PWA offline support: service worker + manifest + icons are emitted with dist (the deploy artifacts)
// The SW cache name gets the package.json version so it stays in sync with the game VERSION and old caches do not linger
const {version} = JSON.parse(readFileSync('package.json', 'utf-8'));
const sw = readFileSync('src/sw.js', 'utf-8').replace('gtg-v__VERSION__', `gtg-v${version}`);
const manifest = readFileSync('src/manifest.webmanifest', 'utf-8');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/gun-to-gun.html', html);
writeFileSync('dist/sw.js', sw);
writeFileSync('dist/manifest.webmanifest', manifest);
for(const icon of ['icon.svg','icon-192.png','icon-512.png'])copyFileSync(`src/${icon}`,`dist/${icon}`);
const mb = statSync('dist/gun-to-gun.html').size / 1024 / 1024;
console.log(`✓ dist/gun-to-gun.html  ${mb.toFixed(2)} MB  (${SHARED_MODELS.length} shared rigs)  ${mb <= 4 ? '(within the 4 MB single-file budget)' : '(OVER the single-file budget!)'}`);
console.log('✓ dist/sw.js + dist/manifest.webmanifest + dist/icon*.png  (PWA offline support)');
