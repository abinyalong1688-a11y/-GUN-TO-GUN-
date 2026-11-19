// build.mjs —— esbuild 打包为单文件 HTML(JS/CSS 全部内联,零外部请求)
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
  .replace(/<\/script/gi, '<\\/script'); // 防止提前闭合 script 标签

const css = readFileSync('src/style.css', 'utf-8');
const template = readFileSync('src/template.html', 'utf-8');
const html = template
  .replace('/*__CSS__*/', () => css)
  .replace('//__JS__', () => js);

// PWA 离线支持:Service Worker + manifest 随 dist 一起产出(云端部署三件套)
const sw = readFileSync('src/sw.js', 'utf-8');
const manifest = readFileSync('src/manifest.webmanifest', 'utf-8');

mkdirSync('dist', { recursive: true });
writeFileSync('dist/gun-to-gun.html', html);
writeFileSync('dist/sw.js', sw);
writeFileSync('dist/manifest.webmanifest', manifest);
const mb = statSync('dist/gun-to-gun.html').size / 1024 / 1024;
console.log(`✓ dist/gun-to-gun.html  ${mb.toFixed(2)} MB  ${mb <= 5 ? '(≤5MB 达标)' : '(超出 5MB 预算!)'}`);
console.log('✓ dist/sw.js + dist/manifest.webmanifest  (PWA 离线支持,云端部署三件套齐)');
