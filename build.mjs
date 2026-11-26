// build.mjs — bundle with esbuild into one HTML page (all JS/CSS inlined).
//
//   npm run build            → dist/                 web build (default)
//   npm run build:single     → dist-single/          self-contained page, works from file://
//   GTG_OUT=<dir> node build.mjs   → custom output dir (used by the e2e runner)
//
// Web build: the page is ~1.3 MB of program and the two character rigs are SEPARATE files
// (dist/assets/characters/*.glb) fetched right after the menu is up, so a slow link reaches an
// interactive menu without waiting for the models. Baked thumbnails (src/portraits.baked.json)
// ride inside the bundle, so operator portraits are visible from the first frame.
// Single build: the same page with the rigs embedded after the bundle (no requests at all).
// No service worker any more: revisits rely on the ordinary HTTP cache of the host.
import * as esbuild from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,statSync,copyFileSync,existsSync,unlinkSync,rmSync} from 'fs';

const args=new Set(process.argv.slice(2));
const SINGLE=args.has('--single');
const OUT=process.env.GTG_OUT||(SINGLE?'dist-single':'dist');

/* ONE female + ONE male rig for the whole roster (see MODEL_MAP in src/modelAssets.js). */
const SHARED_MODELS = ['female1', 'male1'];

/* Baked operator thumbnails (scripts/bake-portraits.mjs → src/portraits.baked.json).
   Baked with the production renderer, so the menu shows real faces before the rigs arrive. */
const BAKED='src/portraits.baked.json';
let bakedJson=null;
try{bakedJson=JSON.parse(readFileSync(BAKED,'utf-8'));}catch(e){bakedJson=null;}
const baked=bakedJson?readFileSync(BAKED,'utf-8'):'null';
/* Static loading screen (top of <body>, before the bundle): the browser paints it while the
   bundle is still downloading, so the player sees the squad's faces within the first second. */
const bootFaces=bakedJson&&bakedJson.ops
  ?Object.entries(bakedJson.ops).map(([id,src])=>{
      const m=bakedJson.meta&&bakedJson.meta[id]||{};
      return `<img src="${src}" alt="" width="64" height="64"${m.faction==='t'?' class="t"':''}>`;
    }).join('')
  :Array.from({length:8},()=>'<span class="ph"></span>').join('');

const result = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  write: false,
  format: 'iife',
  minify: process.env.GTG_MINIFY !== '0', // GTG_MINIFY=0 → readable frames for CPU profiling
  target: ['es2020'],
  charset: 'utf8',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': '"production"',
    DEBUG_HOOKS: process.env.GTG_DEBUG==='1' ? 'true' : 'false', // e2e/dev build only; production strips debug globals
    __GTG_SERVER__: JSON.stringify(process.env.GTG_SERVER || ''),
    __GTG_PORTRAITS__: baked,
    __GTG_RIGS_EMBEDDED__: SINGLE ? 'true' : 'false', // web build: fetch the rigs at once (no tag to wait for)
  },
});

let js = result.outputFiles[0].text
  .replace(/<\/script/gi, '<\\/script'); // keep the bundle from closing the script tag early

/* Single-file build only: the rigs as INERT <script> tags AFTER the main bundle (base64 in a
   data URL). modelAssets.js reads them on demand; the menu is interactive meanwhile. */
let glbTags = '';
const rigs=[];
for (const g of SHARED_MODELS) {
  try {
    const b = readFileSync(`assets/characters/${g}.glb`);
    rigs.push({name:g,bytes:b.length});
    if (SINGLE) {
      const url = `data:model/gltf-binary;base64,${b.toString('base64')}`;
      glbTags += `<script type="application/octet-stream" id="gtg-glb-${g}">${url}</script>\n`;
    }
  } catch (e) { /* missing file → runtime fetch fallback → procedural characters */ }
}

const css = readFileSync('src/style.css', 'utf-8');
const template = readFileSync('src/template.html', 'utf-8');
const html = template
  .replace('<!--__GLB__-->', () => glbTags)
  .replace('<!--__THUMBS__-->', () => bootFaces)
  .replace('/*__CSS__*/', () => css)
  .replace('//__JS__', () => js);

const manifest = readFileSync('src/manifest.webmanifest', 'utf-8');

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/gun-to-gun.html`, html);
writeFileSync(`${OUT}/manifest.webmanifest`, manifest);
for(const icon of ['icon.svg','icon-192.png','icon-512.png'])copyFileSync(`src/${icon}`,`${OUT}/${icon}`);

/* Rigs as separate files for the web build; drop them (and a stale offline worker) from the
   single output so neither folder carries files it does not use. */
const rigDir=`${OUT}/assets/characters`;
if(!SINGLE){
  mkdirSync(rigDir,{recursive:true});
  for(const r of rigs)copyFileSync(`assets/characters/${r.name}.glb`,`${rigDir}/${r.name}.glb`);
}else if(existsSync(`${OUT}/assets`))rmSync(`${OUT}/assets`,{recursive:true,force:true});
for(const stale of ['sw.js'])if(existsSync(`${OUT}/${stale}`))unlinkSync(`${OUT}/${stale}`);

const mb = statSync(`${OUT}/gun-to-gun.html`).size / 1024 / 1024;
const rigKb=Math.round(rigs.reduce((s,r)=>s+r.bytes,0)/1024);
if(SINGLE){
  console.log(`✓ ${OUT}/gun-to-gun.html  ${mb.toFixed(2)} MB  (single file: bundle + ${rigs.length} embedded rigs, works from file://)`);
}else{
  console.log(`✓ ${OUT}/gun-to-gun.html  ${mb.toFixed(2)} MB  (program + baked thumbnails; reaches the menu first)`);
  console.log(`✓ ${OUT}/assets/characters/{${SHARED_MODELS.join(',')}}.glb  ${(rigKb/1024).toFixed(2)} MB  (loaded after the menu)`);
  console.log(`  → upload the WHOLE ${OUT}/ folder (html + assets/ + manifest + icons), not just the html`);
}
console.log(`✓ ${OUT}/manifest.webmanifest + icon*.png  (app name / icons; no offline worker)`);
if (!process.env.GTG_SERVER)
  console.log('· GTG_SERVER 未设置：联机模式会提示「服务器未配置」，单机玩法不受影响');
