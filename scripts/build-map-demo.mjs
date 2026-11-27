// Builds the standalone four-map inspection demo (no game runtime, no network requests).
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync } from 'fs';

const result = await esbuild.build({
  entryPoints: ['tools/map-demo/main.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: true,
  target: ['es2020'],
  charset: 'utf8',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = readFileSync('tools/map-demo/style.css', 'utf8');
const template = readFileSync('tools/map-demo/template.html', 'utf8');
const html = template.replace('/*__CSS__*/', () => css).replace('//__JS__', () => js);
writeFileSync('map-demo.html', html);
console.log(`✓ map-demo.html  ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB  (standalone, file:// ready)`);
