// build-debug.mjs — dev-only bundle with debug hooks enabled (same pipeline as build.mjs)
import * as esbuild from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'fs';

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: false,
  target: ['es2020'],
  charset: 'utf8',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"development"',
    DEBUG_HOOKS: 'true',
    __GTG_SERVER__: JSON.stringify(''),
  },
});

let js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const SHARED_MODELS = ['female1', 'male1', 'male11', 'female11'];
let glbTags = '';
for (const g of SHARED_MODELS) {
  try {
    const b = readFileSync(`assets/characters/${g}.glb`);
    const url = `data:model/gltf-binary;base64,${b.toString('base64')}`;
    glbTags += `<script type="application/octet-stream" id="gtg-glb-${g}">${url}</script>\n`;
  } catch (e) { /* missing file → runtime fetch fallback */ }
}

const css = readFileSync('src/style.css', 'utf-8');
const template = readFileSync('src/template.html', 'utf-8');
const html = template
  .replace('<!--__GLB__-->', () => glbTags)
  .replace('/*__CSS__*/', () => css)
  .replace('//__JS__', () => js);

mkdirSync('dist', { recursive: true });
writeFileSync('dist/gtg-debug.html', html);
console.log('✓ dist/gtg-debug.html (debug hooks ON)');
