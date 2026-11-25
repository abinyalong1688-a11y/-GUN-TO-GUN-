// repro-sky.mjs — headless Chrome (CDP) reproduction of the deploy flow.
// Usage: node scripts/repro-sky.mjs [--fresh]   (--fresh = new Chrome profile dir each run)
import {spawn} from 'child_process';
import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe';
const QS=process.argv[2]||'?shot=probe';
const URL_='http://127.0.0.1:8137/gtg-debug.html'+QS;
const profile=mkdtempSync(join(tmpdir(),'gtg-prof-'));

const chrome=spawn(CHROME,[
  '--headless=new','--remote-debugging-port=9333',`--user-data-dir=${profile}`,
  '--no-first-run','--no-default-browser-check','--disable-gpu-sandbox','--use-angle=swiftshader',
  'about:blank',
],{stdio:'ignore'});

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getWs(){
  for(let i=0;i<40;i++){
    try{
      const res=await fetch('http://127.0.0.1:9333/json/list');
      const tabs=await res.json();
      const page=tabs.find(t=>t.type==='page');
      if(page)return page.webSocketDebuggerUrl;
    }catch{}
    await sleep(250);
  }
  throw new Error('no CDP target');
}

const wsUrl=await getWs();
const ws=new WebSocket(wsUrl);
await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});

let id=0;const pending=new Map();
ws.onmessage=ev=>{
  const m=JSON.parse(ev.data);
  if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}
};
const send=(method,params={})=>new Promise(res=>{
  const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method,params}));
});
const evaljs=async expr=>{
  const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true});
  return r.result?.result?.value ?? r.result?.result?.description ?? null;
};

await send('Page.enable');
await send('Runtime.enable');
const logs=[];
await send('Runtime.evaluate',{expression:`window.__errlog=[];window.onerror=(m,s,l,c,e)=>{window.__errlog.push(String(m)+' @'+l+':'+c);};`});
await send('Page.navigate',{url:URL_});
await sleep(3500);

console.log('--- menu state ---');
console.log(await evaljs(`JSON.stringify({
  state: window.__GTG_DEBUG__?.state,
  mode: window.__GTG_DEBUG__?.mode,
  camY: window.__GTG_DEBUG__?.camera?.position?.y?.toFixed(2),
})`));

// click DEPLOY -> lobby -> SOLO TRAINING
await evaljs(`try{document.getElementById('m-start')?.click()}catch(e){window.__errlog.push('click threw '+e)}`);
await sleep(1200);

console.log('--- errors ---');
console.log(await evaljs(`JSON.stringify(window.__errlog||[])`));
console.log('lobby visible:', await evaljs(`!document.getElementById('lobby')?.classList.contains('hidden')`));

await evaljs(`try{document.getElementById('lobby-solo')?.click()}catch(e){window.__errlog.push('solo threw '+e)}`);
await sleep(3500);   // solo training starts after the socket attempt fails

console.log('--- after deploy ---');
const s1=await evaljs(`JSON.stringify({
  state: window.__GTG_DEBUG__?.state,
  mode: window.__GTG_DEBUG__?.mode,
  playerPos: window.__GTG_DEBUG__?.player?.pos?.toArray?.()?.map(v=>+v.toFixed(2)),
  grounded: window.__GTG_DEBUG__?.player?.grounded,
  cam: window.__GTG_DEBUG__?.camera?.position?.toArray?.()?.map(v=>+v.toFixed(2)),
  uiLock: window.__GTG_DEBUG__?._uiLock,
  tutorialVisible: !document.getElementById('tutorial')?.classList.contains('hidden'),
})`);
console.log(s1);

// wait more (2 s) — does it fall / snap somewhere?
await sleep(2000);
console.log('--- after 2 s more ---');
console.log(await evaljs(`JSON.stringify({
  state: window.__GTG_DEBUG__?.state,
  playerPos: window.__GTG_DEBUG__?.player?.pos?.toArray?.()?.map(v=>+v.toFixed(2)),
  cam: window.__GTG_DEBUG__?.camera?.position?.toArray?.()?.map(v=>+v.toFixed(2)),
})`));

// screenshot for visual check
const shot=await send('Page.captureScreenshot',{format:'png'});
if(shot.result?.data){
  const {writeFileSync}=await import('fs');
  writeFileSync('poster/repro-deploy.png',Buffer.from(shot.result.data,'base64'));
  console.log('screenshot saved: poster/repro-deploy.png');
}else{
  console.log('screenshot failed:',JSON.stringify(shot).slice(0,300));
}

chrome.kill();
try{rmSync(profile,{recursive:true,force:true});}catch{}
process.exit(0);
