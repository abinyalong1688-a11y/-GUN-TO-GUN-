// scripts/fun-shot.mjs — prop lineup screenshot: builds a fun-mode match and places every prop
// variant (fly + rest forms, plus the magnet pulse) in front of the player, then captures a PNG
// per camera angle so the redraw can be judged visually.
//   node scripts/fun-shot.mjs [--map=desert] [--out=dist/diag]
import {execFileSync} from 'child_process';
import {mkdirSync,rmSync,writeFileSync} from 'fs';
import {resolve} from 'path';
import {openGame} from './lib/browser.mjs';

const argv=process.argv.slice(2);
const val=(n,d)=>{const a=argv.find(x=>x.startsWith('--'+n+'='));return a?a.split('=')[1]:d;};
const MAP=val('map','desert'),OUT=resolve(val('out','dist/diag'));
rmSync(OUT,{recursive:true,force:true});
mkdirSync(OUT,{recursive:true});
execFileSync(process.execPath,['build.mjs'],{stdio:'ignore',env:{...process.env,GTG_DEBUG:'1',GTG_MINIFY:'0',GTG_OUT:'dist/diag'}});

/* In-page: one prop centered in front of the camera. Source ships verbatim — no Node state. */
function lineup(spec){
  const g=window.__GTG_DEBUG__;
  localStorage.setItem('o07_tutorial_done','1');
  g.ui.sel.mode='fun';g.ui.sel.map=spec.map;
  g.startGame();
  /* Freeze the loop: tick() would fly the props away at 15 m/s and age the puddles. */
  g.renderer.setAnimationLoop(null);
  g.fallbackAim=true;g.player.god=true;
  g.weapon.group.visible=false;   // the first-person gun covers the centre of the frame
  g.dm.winKills=1e9;g.dm.timer=1e9;
  g.player.pos.set(0,0,0);g.player.vel.set(0,0,0);g.player.yaw=0;g.player.pitch=0;
  const own={team:'A',name:g.playerName,isPlayer:true};
  const V=g.player.pos.constructor;
  const at=(x,y,z)=>new V(x,y,z);
  const dir=()=>new V(0,0,-1);
  g.funItems.clear();
  const eye=1.62;
  if(spec.kind==='fly'){
    g.funItems._launch(spec.type,at(0,eye+.3,-(spec.dist||1.5)),dir(),own);
    g.player.pitch=.06;   // clear of the first-person weapon model
  }else if(spec.kind==='rest'){
    g.funItems._place({type:spec.type,pos:at(0,0,-(spec.dist||1.6)),owner:own},0);
    g.player.pitch=-Math.atan2(eye,spec.dist||1.6);
  }else{ // pulse
    g.funItems._magnetPulse(at(0,0.02,-(spec.dist||2.6)),2.2);
    g.player.pitch=-Math.atan2(eye,spec.dist||2.6);
  }
  g.scene.updateMatrixWorld(true);
  g.composer.render();
  g.camera.position.copy(g.player.eye);
  g.camera.rotation.set(g.player.pitch,0,0,'YXZ');
  g.composer.render();
  return {ok:true};
}
const pageFn=spec=>`(${lineup.toString()})(${JSON.stringify({map:MAP,...spec})})`;

function shot(){
  return `(function(){const g=window.__GTG_DEBUG__;
    g.camera.position.copy(g.player.eye);
    g.camera.rotation.set(g.player.pitch,0,0,'YXZ');
    g.scene.updateMatrixWorld(true);
    g.composer.render();
    return g.captureFrame();})()`;
}

const page=await openGame({root:'dist/diag',query:'?debug=1',gpu:true});
try{
  await page.waitFor('window.__GTG_DEBUG__&&window.__GTG_DEBUG__.clock&&window.__modelAssets&&window.__modelAssets.isReady()',120000,150);
  await new Promise(r=>setTimeout(r,400));
  const cases=[
    ['banana-fly',{kind:'fly',type:'banana',dist:1.0}],
    ['magnet-fly',{kind:'fly',type:'magnet',dist:1.0}],
    ['spring-fly',{kind:'fly',type:'spring',dist:1.0}],
    ['water-fly',{kind:'fly',type:'water',dist:1.1}],
    ['banana-rest',{kind:'rest',type:'banana',dist:1.3}],
    ['spring-rest',{kind:'rest',type:'spring',dist:1.6}],
    ['water-rest',{kind:'rest',type:'water',dist:4.2}],
    ['magnet-pulse',{kind:'pulse',dist:4.5}],
  ];
  for(const [name,spec] of cases){
    console.log(name,JSON.stringify(await page.evaluate(pageFn(spec),60000)));
    const data=await page.evaluate(shot(),30000);
    if(data){const f=resolve(OUT,`fun-shot-${MAP}-${name}.png`);writeFileSync(f,Buffer.from(data.split(',')[1],'base64'));console.log('saved',f);}
  }
  /* One wide reference per remaining map: a rest row at gameplay distances. */
  for(const map of ['snow','snowtown','ember']){
    if(map===MAP)continue;
    const data=await page.evaluate(`(function(){const g=window.__GTG_DEBUG__;g.toMenu();g.ui.sel.map='${map}';g.buildWorldFor('${map}');
      (${lineup.toString()})({map:'${map}',kind:'rest',type:'water',dist:4.2});
      g.funItems._place({type:'banana',pos:g.player.pos.constructor?new (g.player.pos.constructor)(-1.6,0,-4.2):null,owner:{team:'A',name:g.playerName,isPlayer:true}},0);
      g.funItems._place({type:'spring',pos:new (g.player.pos.constructor)(1.6,0,-4.2),owner:{team:'A',name:g.playerName,isPlayer:true}},0);
      g.player.pitch=-.35;g.scene.updateMatrixWorld(true);g.composer.render();
      g.camera.position.copy(g.player.eye);g.camera.rotation.set(-.35,0,0,'YXZ');g.composer.render();
      return g.captureFrame();})()`,60000);
    if(data){const f=resolve(OUT,`fun-shot-${map}-wide.png`);writeFileSync(f,Buffer.from(data.split(',')[1],'base64'));console.log('saved',f);}
  }
}finally{page.close();}
process.exit(0);
