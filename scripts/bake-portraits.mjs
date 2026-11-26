// scripts/bake-portraits.mjs — render every operator's bust portrait with the PRODUCTION
// PortraitRenderer and write src/portraits.baked.json (small JPEGs). build.mjs inlines that file,
// so the roster shows real faces before the character rigs have downloaded.
//
//   npm run bake:portraits
//
// Re-run whenever an operator's look changes (palette / camo / headgear / rig).
import {execFileSync} from 'child_process';
import {mkdirSync,writeFileSync,rmSync,statSync} from 'fs';
import {resolve} from 'path';
import {openGame} from './lib/browser.mjs';

const OUT_DIR = resolve('dist/bake');
const SIZE = 192;          // card edge; displayed at 92-110 CSS px (retina-sharp)
const QUALITY = 0.72;
const {version} = JSON.parse((await import('fs')).readFileSync('package.json', 'utf8'));

// 1. Isolated debug build with the rigs embedded (no asset paths to worry about).
rmSync(OUT_DIR, {recursive: true, force: true});
mkdirSync(OUT_DIR, {recursive: true});
execFileSync(process.execPath, ['build.mjs', '--single'], {
  stdio: 'inherit',
  env: {...process.env, GTG_DEBUG: '1', GTG_OUT: 'dist/bake'},
});

// 2. Open it headless, wait for the rigs, render each operator, flatten onto the card gradient.
const page = await openGame({root: OUT_DIR, query: '?debug=1'});
try {
  await page.waitFor('!!(window.__GTG_DEBUG__&&window.__GTG_OPS__&&window.__modelAssets&&window.__modelAssets.isReady())', 120000);
  const result = await page.evaluate(`(async()=>{
    const g=window.__GTG_DEBUG__,ops=window.__GTG_OPS__,S=${SIZE};
    // same gradients as .op-card.no-art .op-portrait (style.css), 160deg
    const grad=(x,stops)=>{
      const L=S*(Math.abs(Math.sin(160*Math.PI/180))+Math.abs(Math.cos(160*Math.PI/180)));
      const ex=S/2+Math.sin(160*Math.PI/180)*L/2,ey=S/2-Math.cos(160*Math.PI/180)*L/2;
      const gr=x.createLinearGradient(S-ex,S-ey,ex,ey);
      for(const [o,c] of stops)gr.addColorStop(o,c);
      return gr;
    };
    const CT=[[0,'#1c2736'],[0.6,'#3d5270'],[1,'#7fa8c8']],T=[[0,'#3a1210'],[0.55,'#7a1f22'],[1,'#c0392b']];
    const out={};
    for(const op of ops){
      const png=g.portraits.render(op,'default',S,{frame:'bust'});
      if(!png)return {error:'render returned null for '+op.id};
      const img=await new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=()=>rej(new Error('decode '+op.id));i.src=png;});
      const c=document.createElement('canvas');c.width=c.height=S;
      const x=c.getContext('2d');
      x.fillStyle=grad(x,op.faction==='t'?T:CT);x.fillRect(0,0,S,S);
      // .op-portrait uses background-size:cover / position:center top on a square → identical
      x.drawImage(img,0,0,S,S);
      out[op.id]=c.toDataURL('image/jpeg',${QUALITY});
    }
    const meta={};for(const op of ops)meta[op.id]={faction:op.faction,gender:op.gender||''};
    return {ops:out,meta,mode:window.__modelAssets.mode()};
  })()`, 120000);
  if (result.error) throw new Error(result.error);
  writeFileSync('src/portraits.baked.json', JSON.stringify({v: version, size: SIZE, ops: result.ops, meta: result.meta}));
  const bytes = statSync('src/portraits.baked.json').size;
  console.log(`✓ src/portraits.baked.json  ${Object.keys(result.ops).length} operators × ${SIZE}px  ${(bytes / 1024).toFixed(1)} KB total  (renderer mode: ${result.mode})`);
} finally {
  page.close();
  rmSync(OUT_DIR, {recursive: true, force: true});
}
