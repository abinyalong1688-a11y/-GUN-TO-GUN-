// verify-all.mjs — end-to-end acceptance of the five changes in a real (headless) browser.
import {spawn} from 'child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_='http://127.0.0.1:8137/gtg-debug.html?debug=1';
const profile=mkdtempSync(join(tmpdir(),'gtg-ver-'));
const chrome=spawn(CHROME,[
  '--headless=new','--remote-debugging-port=9334',`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--use-angle=swiftshader','about:blank',
],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getWs(){
  for(let i=0;i<40;i++){
    try{
      const tabs=await (await fetch('http://127.0.0.1:9334/json/list')).json();
      const page=tabs.find(t=>t.type==='page');
      if(page)return page.webSocketDebuggerUrl;
    }catch{}
    await sleep(250);
  }
  throw new Error('no CDP target');
}
const ws=new WebSocket(await getWs());
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
let id=0;const pending=new Map();
ws.onmessage=ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
const send=(method,params={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
const evaljs=async expr=>{
  const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.result?.result?.value ?? null;
};

await send('Page.enable');await send('Runtime.enable');
await send('Runtime.evaluate',{expression:`window.__errlog=[];window.onerror=(m)=>window.__errlog.push(String(m));`});
await send('Page.navigate',{url:URL_});
await sleep(4000);

// 1. thumbnails: GLB-ready portraits on operator cards
const thumbs=await evaljs(`(async()=>{
  for(let i=0;i<40;i++){if(window.__modelAssets.isReady())break;await new Promise(r=>setTimeout(r,250));}
  const cards=[...document.querySelectorAll('.op-card')];
  return JSON.stringify({
    glbReady: window.__modelAssets.isReady(),
    cards: cards.length,
    withArt: cards.filter(c=>(c.querySelector('.op-portrait')?.style.backgroundImage||'').startsWith('url("data:image/png')).length,
  });
})()`);
console.log('[1] menu thumbnails:',thumbs);

// 2. deploy -> lobby -> solo training
await evaljs(`document.getElementById('m-start').click()`);
await sleep(800);
await evaljs(`document.getElementById('lobby-solo').click()`);
await sleep(3500);
const dep=await evaljs(`JSON.stringify({
  state:window.__GTG_DEBUG__.state, mode:window.__GTG_DEBUG__.mode,
  cam:window.__GTG_DEBUG__.camera.position.toArray().map(v=>+v.toFixed(2)),
  tutorial:!document.getElementById('tutorial').classList.contains('hidden'),
})`);
console.log('[2] after deploy:',dep);

// 3. waves death = game over (no respawn): skip the tutorial first, then kill
const death=await evaljs(`(async()=>{
  const g=window.__GTG_DEBUG__;
  document.getElementById('tut-skip')?.click();
  await new Promise(r=>setTimeout(r,400));
  g.player.god=false;g.player.damage(9999,performance.now()/1000);
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,100));if(g.state==='over')break;}
  return JSON.stringify({
    alive:g.player.alive, state:g.state,
    overVisible:!document.getElementById('over')?.classList.contains('hidden'),
    respawnT:g.dmRespawnT,
    wave:g.waves.n,
  });
})()`);
console.log('[3] waves death:',death);

const shot=await send('Page.captureScreenshot',{format:'png'});
if(shot.result?.data)writeFileSync('poster/verify-final.png',Buffer.from(shot.result.data,'base64'));

console.log('[4] js errors:',await evaljs(`JSON.stringify(window.__errlog||[])`));
chrome.kill();
try{rmSync(profile,{recursive:true,force:true});}catch{}
process.exit(0);
