// scripts/fun-perf.mjs — Fun Brawl frame-time probe. Plays a scripted match in headless Chrome
// and records EVERY frame (interval between frames, wall time of tick(), a per-subsystem
// breakdown, the GL calls that allocate / compile on that frame), so a hitch is attributed from
// measurements instead of guessed.
//
//   node scripts/fun-perf.mjs [--gpu] [--runs=2] [--seconds=40] [--profile] [--dpr=1] [--map=desert]
//                            [--warm-props] [--res=fixed]
//
// Three phases, reported separately:
//   first-use — the first throw of each prop type (a model that has never been drawn compiles
//               its shader / uploads its buffers on that very frame);
//   steady    — bots fighting and throwing props (the normal "is it smooth" window);
//   deaths    — scripted player deaths and respawns.
// --gpu renders on the real GPU; frame intervals are only meaningful with it. Without --gpu the
// run uses software WebGL and only the CPU-side breakdown is representative.
// --profile samples the CPU for the whole run (unminified bundle → readable names).
// --warm-props is a what-if: draw every prop variant once before the match starts (the fix this
// probe was built to justify). --res=fixed pins the dynamic resolution (what-if for the scaler).
import {execFileSync} from 'child_process';
import {mkdirSync,rmSync,writeFileSync} from 'fs';
import {resolve} from 'path';
import {openGame} from './lib/browser.mjs';

const argv=process.argv.slice(2);
const flag=n=>argv.includes('--'+n);
const num=(n,d)=>{const a=argv.find(x=>x.startsWith('--'+n+'='));return a?Number(a.split('=')[1]):d;};
const str=(n,d)=>{const a=argv.find(x=>x.startsWith('--'+n+'='));return a?a.split('=')[1]:d;};
const GPU=flag('gpu'),RUNS=num('runs',1),SECONDS=num('seconds',40),PROFILE=flag('profile'),DPR=num('dpr',1);
const MAP=str('map','desert'),W=num('w',1600),H=num('h',900),TAG=str('tag','run');
const WARM_PROPS=flag('warm-props'),FIXED_RES=num('res',0);
const ROOT=resolve('dist/diag'); // gitignored scratch build
rmSync(ROOT,{recursive:true,force:true});
mkdirSync(ROOT,{recursive:true});
execFileSync(process.execPath,['build.mjs'],{stdio:'ignore',
  env:{...process.env,GTG_DEBUG:'1',GTG_MINIFY:'0',GTG_OUT:'dist/diag'}});

/* Seeded Math.random so every run sees the same bot decisions (comparable before/after). */
const SEED=`(()=>{let s=${num('seed',20261128)}>>>0;Math.random=()=>{s=(s+0x6D2B79F5)>>>0;let t=s;
t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};})();`;

const GL_CALLS=['compileShader','linkProgram','getProgramParameter','getShaderParameter','bufferData',
  'texImage2D','texStorage2D','compressedTexImage2D','framebufferTexture2D','renderbufferStorageMultisample','getSyncParameter','clientWaitSync'];

/* ---- in-page scenario. Source is shipped verbatim, so it must not close over Node state. ---- */
async function run(stage,opts){
  const g=window.__GTG_DEBUG__;
  const now=performance.now.bind(performance);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const monoUs=()=>Math.round((performance.timeOrigin+now())*1000);
  const TYPES=['banana','magnet','spring','water'];
  /* GL calls that compile or allocate; must live inside run() — it is serialized into the page. */
  const GL_CALLS=['compileShader','linkProgram','getProgramParameter','getShaderParameter','bufferData',
    'texImage2D','texStorage2D','compressedTexImage2D','framebufferTexture2D','renderbufferStorageMultisample','getSyncParameter','clientWaitSync'];
  let S=window.__perf;

  if(stage==='setup'){
    S=window.__perf={frames:[],marks:[],cur:{},gl:{},T0:now(),lastAlive:true,resLog:[],w:false};
    const mark=l=>S.marks.push({t:now(),l});
    /* GL calls that compile or allocate: counted per frame. */
    const proto=Object.getPrototypeOf(g.renderer.getContext());
    for(const n of GL_CALLS){
      const f=proto[n];if(typeof f!=='function')continue;
      proto[n]=function(...a){S.gl[n]=(S.gl[n]||0)+1;return f.apply(this,a);};
    }
    /* Event marks: what happened during / right before a slow frame. */
    const hook=(o,n,l)=>{const f=o[n];if(typeof f!=='function')return;o[n]=function(...a){mark(l);return f.apply(this,a);};};
    for(const n of ['_launch','_place','_magnetPulse','_magnetBurst','_remove','_consume'])hook(g.funItems,n,'fun.'+n);
    for(const n of ['drop','_collect','_remove'])hook(g.pickups,n,'pickups.'+n);
    for(const n of ['onHeroKill','onFunEvent'])hook(g,n,n);
    for(const n of ['explosion','hammerSlam','bloodPuff'])hook(g.effects,n,'fx.'+n);
    /* Dynamic-resolution log: the scaler runs every 60 frames; (slow/60) is its input. */
    const aq=g._applyQuality.bind(g);
    g._applyQuality=function(){
      S.resLog.push({t:now(),to:g.dynScale,slow:g.perf.slow,n:Math.max(1,g.perf.frames-g._perfAt)});
      return aq();
    };
    /* Per-subsystem wall time inside one tick (inclusive). */
    const wrap=(o,n,l)=>{const f=o[n];if(typeof f!=='function')return;
      o[n]=function(...a){const a0=now();try{return f.apply(this,a);}finally{S.cur[l]=(S.cur[l]||0)+(now()-a0);}};};
    wrap(g.heroes,'update','heroes');wrap(g.squad,'update','squad');wrap(g.weapon,'update','weapon');
    wrap(g.player,'update','player');wrap(g.effects,'update','fx.update');wrap(g.funItems,'update','fun.update');
    wrap(g.pickups,'update','pickups.update');wrap(g.composer,'render','render');wrap(g.ui,'update','ui.update');
    wrap(g.radar,'update','radar');
    /* Frame recorder. `work` = wall time of the whole tick; `gap` = time since the previous
       frame started (what the eye reads as a stutter). */
    const info=g.renderer.info,tick=g.tick.bind(g);
    let prev=0,drive=null;
    S.setDrive=f=>{drive=f;};
    g.tick=function(){
      const t0=now();
      for(const k in S.cur)delete S.cur[k];
      for(const k in S.gl)delete S.gl[k];
      S.m0=S.marks.length;
      if(drive)drive(t0);
      let err=null;
      try{tick();}catch(e){err=String(e&&e.message||e);}
      const t1=now(),alive=g.player.alive;
      if(alive&&!S.lastAlive)S.marks.push({t:t0,l:'respawn'});
      S.lastAlive=alive;
      S.frames.push({t:t0,t1,gap:prev?t0-prev:0,work:t1-t0,dp:info.programs.length-(S.p0==null?info.programs.length:S.p0),
        dg:info.memory.geometries-(S.g0==null?info.memory.geometries:S.g0),dt:info.memory.textures-(S.x0==null?info.memory.textures:S.x0),
        scale:g.dynScale,w:g.perf.frames-g._perfAt,gl:Object.assign({},S.gl),ph:Object.assign({},S.cur),m0:S.m0,m1:S.marks.length,err});
      S.p0=info.programs.length;S.g0=info.memory.geometries;S.x0=info.memory.textures;
      prev=t0;
    };
    localStorage.setItem('o07_tutorial_done','1');
    g.ui.sel.mode='fun';g.ui.sel.map=opts.map;
    g.fallbackAim=true;
    /* What-if: pin the dynamic resolution so the scaler cannot interfere. */
    if(opts.fixedRes){g.dynScale=opts.fixedRes;g._applyQuality();
      Object.defineProperty(g,'dynScale',{get:()=>opts.fixedRes,set:()=>{},configurable:true});}
    mark('startGame');
    const s0=now();g.startGame();S.startMs=now()-s0;
    /* The probe must stay inside gameplay: no early finish, no death during the throw phase. */
    g.dm.winKills=1e9;g.dm.timer=1e9;
    g.player.god=true;g.invulnT=0;g.spawnInvulnT=0;
    g.player.pos.set(0,0,22);g.player.vel.set(0,0,0);g.player.yaw=0;g.player.pitch=-.04;
    /* What-if: every prop variant exists for one rendered frame before anything else happens. */
    if(opts.warmProps){
      const V=g.player.pos.constructor,far=new V(0,-100,0),zero=new V(0,0,0),own={team:'A',name:g.playerName,isPlayer:true};
      for(const tp of TYPES){
        g.funItems._launch(tp,far,zero,own);
        g.funItems._place({type:tp,pos:far,owner:own},-100);
      }
      for(const p of g.funItems.list)p.mesh.traverse(o=>{o.frustumCulled=false;});
      for(const p of g.funItems.placed)p.mesh.traverse(o=>{o.frustumCulled=false;});
      mark('warmProps');
      g.composer.render();
      S.warmWork=now()-S.T0;
      for(const p of g.funItems.list)g.scene.remove(p.mesh);
      for(const p of g.funItems.placed)g.scene.remove(p.mesh);
      g.funItems.list.length=0;g.funItems.placed.length=0;
    }
    /* Bot deaths: the first corpse fade flips the character materials to transparent, which is
       another shader variant that has never been compiled. */
    const hookBot=(h)=>{
      if(h.__perf)return;h.__perf=true;
      const td=h.takeDamage.bind(h);
      h.takeDamage=function(...a){const r=td(...a);if(!this.alive&&this.state!=='active')mark('botDeath');return r;};
      const rs=h.respawn.bind(h);h.respawn=function(...a){mark('botRespawn');return rs(...a);};
      const dr=h.dropRifle&&h.dropRifle.bind(h);if(dr)h.dropRifle=function(...a){mark('botDropRifle');return dr(...a);};
    };
    S.hookBots=()=>g.heroes.list.forEach(hookBot);S.hookBots();
    /* Bots must not throw during the first-use phase, or a bot would compile a prop before the
       scripted throw and the measurement would read "free". */
    const botThrow=g.funItems.botThrow;g.funItems.botThrow=()=>false;
    await sleep(opts.warm*1000);
    for(const tp of TYPES){
      g.funItems.counts[tp]=1;
      mark('first:'+tp);
      g.funItems.throw(tp);
      await sleep(opts.gap*1000);
    }
    g.funItems.botThrow=botThrow;
    S.marks.push({t:now(),l:'steady'});
    return {ok:true,startMs:+S.startMs.toFixed(1),warmMs:S.warmWork?+S.warmWork.toFixed(1):0,
      renderer:(()=>{const gl=g.renderer.getContext(),e=gl.getExtension('WEBGL_debug_renderer_info');
        return e?gl.getParameter(e.UNMASKED_RENDERER_WEBGL):'unknown';})(),
      size:innerWidth+'x'+innerHeight+'@'+devicePixelRatio,quality:g.quality,programs:g.renderer.info.programs.length};
  }

  if(stage==='steady'||stage==='deaths'){
    const mark2=l=>S.marks.push({t:now(),l});
    if(stage==='steady')S.hookBots();else mark2('deaths');
    const botThrow=()=>{
      const bots=g.heroes.list.filter(h=>h.alive);if(!bots.length)return;
      const b=bots[Math.floor(Math.random()*bots.length)];
      const foes=g.heroes.list.filter(h=>h.alive&&h.team!==b.team);
      if(g.player.alive&&(g.playerTeam||'A')!==b.team)foes.push({pos:g.player.pos});
      let best=null,bd=1e9;
      for(const f of foes){const d=Math.hypot(f.pos.x-b.pos.x,f.pos.z-b.pos.z);if(d<bd){bd=d;best=f;}}
      if(!best)return;
      g.funItems.botThrow(TYPES[Math.floor(Math.random()*4)],{x:b.pos.x,y:b.pos.y+1.4,z:b.pos.z},
        {x:best.pos.x,z:best.pos.z},{team:b.team,name:b.name,isPlayer:false});
    };
    if(stage==='steady'){
      let botT=0,plT=0;
      S.setDrive(t=>{
        if(t-botT>opts.botEvery*1000){botT=t;botThrow();}
        if(g.player.alive&&t-plT>opts.playerEvery*1000){plT=t;const tp=TYPES[Math.floor(Math.random()*4)];g.funItems.counts[tp]=1;g.funItems.throw(tp);}
      });
      S.steadyFromUs=monoUs();
      const end=now()+opts.seconds*1000;
      while(now()<end)await sleep(100);
      S.setDrive(null);
      S.steadyToUs=monoUs();
    }else{
      /* Scripted deaths: 5 HP, no shield, one hit from the nearest enemy. */
      g.player.god=false;
      for(let i=0;i<opts.deaths;i++){
        const t0=now();
        while(!g.player.alive&&now()-t0<8000)await sleep(50);
        if(!g.player.alive)break;
        g.spawnInvulnT=0;g.invulnT=0;g.player.god=false;g.player.health=5;
        const foe=g.heroes.list.find(h=>h.team!==g.playerTeam)||g.heroes.list[0];
        mark2('death');
        g.damagePlayer(50,foe?{name:foe.name,pos:foe.pos}:{name:'E2E',pos:null});
        await sleep(opts.deathGap*1000);
      }
      g.player.god=true;
      S.deathsToUs=monoUs();
    }
    return {ok:true};
  }

  if(stage==='summary'){
    const F=S.frames,sec=t=>+((t-S.T0)/1000).toFixed(2);
    const pct=(a,p)=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y);return +s[Math.min(s.length-1,Math.floor(p*s.length))].toFixed(2);};
    const mean=a=>a.length?+(a.reduce((x,y)=>x+y,0)/a.length).toFixed(2):0;
    const at=l=>{const m=S.marks.find(x=>x.l===l);return m?m.t:null;};
    const win=(from,to)=>{
      const f=F.filter(x=>x.t>=from&&x.t<to);
      const gaps=f.map(x=>x.gap).filter(x=>x>0),work=f.map(x=>x.work);
      const out={frames:f.length,fps:gaps.length?+(1000/mean(gaps)).toFixed(1):0,
        gap:{p50:pct(gaps,.5),p95:pct(gaps,.95),p99:pct(gaps,.99),max:pct(gaps,1)},
        work:{p50:pct(work,.5),p95:pct(work,.95),p99:pct(work,.99),max:pct(work,1)},
        slow25:f.filter(x=>x.gap>25).length,slow50:f.filter(x=>x.gap>50).length,slow100:f.filter(x=>x.gap>100).length,
        newPrograms:f.reduce((s,x)=>s+x.dp,0),newGeos:f.reduce((s,x)=>s+x.dg,0),newTexs:f.reduce((s,x)=>s+x.dt,0),
        resChanges:f.filter((x,i)=>i>0&&x.scale!==f[i-1].scale).length,
        gl:{},phases:{}};
      for(const k of GL_CALLS){const n=f.reduce((s,x)=>s+(x.gl[k]||0),0);if(n)out.gl[k]=n;}
      const ph={};for(const x of f)for(const k in x.ph)(ph[k]=ph[k]||[]).push(x.ph[k]);
      for(const k in ph)out.phases[k]={avg:mean(ph[k]),p99:pct(ph[k],.99),max:pct(ph[k],1)};
      return out;
    };
    const steadyFrom=at('steady'),deathsFrom=at('deaths'),end=now();
    const res={startMs:+S.startMs.toFixed(1),frames:F.length,
      warm:win(S.marks[0].t,steadyFrom),steady:win(steadyFrom,deathsFrom||end),deaths:deathsFrom?win(deathsFrom,end):null};
    /* First use: the slowest frames in the 3 s after each scripted first throw. */
    const glOf=x=>{const s=[];for(const k of GL_CALLS)if(x.gl[k])s.push(k+'×'+x.gl[k]);return s.join(' ');};
    const worst=(f,n)=>f.slice().sort((a,b)=>b.gap-a.gap).slice(0,n).map(x=>({at:sec(x.t),gap:+x.gap.toFixed(1),work:+x.work.toFixed(1),
      dp:x.dp,dg:x.dg,dt:x.dt,gl:glOf(x)}));
    res.firstUse=TYPES.map(tp=>{const t=at('first:'+tp);if(!t)return null;
      const f=F.filter(x=>x.t>=t&&x.t<t+3000);
      return {type:tp,maxWork:+Math.max(0,...f.map(x=>x.work)).toFixed(1),maxGap:+Math.max(0,...f.map(x=>x.gap)).toFixed(1),
        newPrograms:f.reduce((s,x)=>s+x.dp,0),newGeos:f.reduce((s,x)=>s+x.dg,0),worst:worst(f,3)};});
    const top=o=>Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>k+':'+v.toFixed(1)).join(' ');
    const glc=x=>GL_CALLS.filter(k=>(k==='bufferData'?x.gl[k]>4:x.gl[k])).map(k=>k+'×'+x.gl[k]).join(' ');
    res.hitches=F.filter(x=>x.gap>50||x.work>50).sort((a,b)=>b.gap-a.gap).slice(0,60)
      .map(x=>({at:sec(x.t),gap:+x.gap.toFixed(1),work:+x.work.toFixed(1),fromUs:Math.round((performance.timeOrigin+x.t)*1000),
        toUs:Math.round((performance.timeOrigin+x.t1)*1000),dp:x.dp,dg:x.dg,dt:x.dt,gl:glc(x),top:top(x.ph),
        inFrame:[...new Set(S.marks.slice(x.m0,x.m1).map(m=>m.l))].slice(0,6),
        before:[...new Set(S.marks.slice(0,x.m0).filter(m=>m.t>x.t-1500&&m.t<=x.t).map(m=>m.l))].slice(0,6),
        err:x.err||undefined}));
    /* Raw frame gaps of the steady window: lets a scaler policy be replayed offline. */
    res.steadyGaps=F.filter(x=>x.t>=steadyFrom&&x.t<(deathsFrom||end)).map(x=>+x.gap.toFixed(1));
    res.resLog=S.resLog.map(r=>({at:+((r.t-S.T0)/1000).toFixed(1),to:r.to,ratio:+(r.slow/r.n).toFixed(2)}));
    /* Every scaler window (60 frames) of the steady phase, as the scaler itself saw it. */
    const wins=[];let cur=[];
    for(const x of F){if(x.t<steadyFrom||x.t>=(deathsFrom||end))continue;cur.push(x);if(cur.length===60){wins.push(cur);cur=[];}}
    res.resWindows=wins.map(w=>+(w.filter(x=>x.gap>25).length/w.length).toFixed(2));
    res.counts={};
    for(const m of S.marks){const k=m.l.indexOf('first:')===0?'first':m.l;res.counts[k]=(res.counts[k]||0)+1;}
    res.steadyFromUs=S.steadyFromUs;res.steadyToUs=S.steadyToUs;res.deathsToUs=S.deathsToUs;res.origin=performance.timeOrigin;
    res.dynScale=g.dynScale;res.programs=g.renderer.info.programs.length;
    res.frameErrors=F.filter(x=>x.err).slice(0,5).map(x=>x.err);
    res.uiErrors=g.ui.errors.filter(e=>e.indexOf('ERR')===0).slice(0,5);
    res.all=F.map(x=>[+((x.t-S.T0)/1000).toFixed(3),+x.gap.toFixed(1),+x.work.toFixed(1),x.dp,x.scale]);
    return res;
  }
}
const pageFn=(stage,o)=>`(${run.toString()})(${JSON.stringify(stage)},${JSON.stringify(o)})`;

/* ---- CPU profile → self / inclusive time per function over a window ---- */
function profileReport(prof,lo,hi,topN){
  const byId=new Map(prof.nodes.map(n=>[n.id,n])),parent=new Map();
  for(const n of prof.nodes)for(const c of n.children||[])parent.set(c,n.id);
  const ts=[];let t=prof.startTime;
  for(let i=0;i<prof.samples.length;i++){t+=prof.timeDeltas[i]||0;ts.push(t);}
  const key=n=>(n.callFrame.functionName||'(anon)')+':'+(n.callFrame.lineNumber+1);
  const self=new Map(),incl=new Map();let total=0,n=0;
  const a=lo==null?prof.startTime:lo,b=hi==null?prof.endTime:hi;
  for(let i=0;i<prof.samples.length-1;i++){
    if(ts[i]<a)continue;
    if(ts[i]>=b)break;
    const dt=(ts[i+1]-ts[i])/1000;total+=dt;n++;
    const id=prof.samples[i],k=key(byId.get(id));self.set(k,(self.get(k)||0)+dt);
    for(let p=id;p!=null;p=parent.get(p)){const kk=key(byId.get(p));incl.set(kk,(incl.get(kk)||0)+dt);}
  }
  if(!n)return {totalMs:0};
  const top=(m,c)=>[...m.entries()].sort((x,y)=>y[1]-x[1]).slice(0,c).map(([k,v])=>`${k} ${v.toFixed(0)}ms`).join(' · ');
  return {totalMs:+total.toFixed(0),self:top(self,topN),incl:top(incl,topN)};
}

/* ---- report ---- */
const f1=x=>x==null?'—':x.toFixed(1);
const winLine=(n,w)=>{
  if(!w||!w.frames)return `  ${n.padEnd(7)} (no frames)`;
  const best=Object.entries(w.phases).sort((a,b)=>b[1].avg-a[1].avg).slice(0,6)
    .map(([k,v])=>`${k} ${v.avg.toFixed(2)}ms`).join(' · ');
  const gl=Object.entries(w.gl).map(([k,v])=>k+'×'+v).join(' ');
  return `  ${n.padEnd(7)} ${String(w.frames).padStart(5)}f  ${String(w.fps).padStart(5)} fps  gap p50/p95/p99/max ${w.gap.p50}/${w.gap.p95}/${w.gap.p99}/${w.gap.max} ms`+
    `  work p50/p99/max ${w.work.p50}/${w.work.p99}/${w.work.max} ms  >25ms ${w.slow25}  >50ms ${w.slow50}  >100ms ${w.slow100}`+
    `  newProg ${w.newPrograms} newGeo ${w.newGeos} newTex ${w.newTexs} resChg ${w.resChanges}\n          avg: ${best}${gl?'\n          GL: '+gl:''}`;
};

const runs=[];
for(let r=0;r<RUNS;r++){
  const page=await openGame({root:ROOT,query:'?debug=1',gpu:GPU,beforeNavigate:async send=>{
    await send('Emulation.setDeviceMetricsOverride',{width:W,height:H,deviceScaleFactor:DPR,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument',{source:SEED});
  }});
  try{
    await page.waitFor('window.__GTG_DEBUG__&&window.__GTG_DEBUG__.clock&&window.__modelAssets&&window.__modelAssets.isReady()',120000,150);
    await new Promise(r=>setTimeout(r,600));
    if(PROFILE){await page.send('Profiler.enable');await page.send('Profiler.setSamplingInterval',{interval:250});await page.send('Profiler.start');}
    const info=await page.evaluate(pageFn('setup',{map:MAP,warm:6,gap:2.5,warmProps:WARM_PROPS,fixedRes:FIXED_RES}),180000);
    await page.evaluate(pageFn('steady',{seconds:SECONDS,botEvery:1.6,playerEvery:3.4}),SECONDS*1000+120000);
    const shot=await page.send('Page.captureScreenshot',{format:'png'});
    if(shot.data)writeFileSync(resolve(ROOT,`fun-perf-${TAG}-${r+1}.png`),Buffer.from(shot.data,'base64'));
    await page.evaluate(pageFn('deaths',{deaths:5,deathGap:4.2}),120000);
    const res=await page.evaluate(pageFn('summary',{}),60000);
    let prof=null;
    if(PROFILE){prof=(await page.send('Profiler.stop')).profile;await page.send('Profiler.disable');}
    const frameProfile=h=>prof?profileReport(prof,h.fromUs,h.toUs,8):null;    runs.push({info,res});
    const mode=[GPU?'real GPU':'software WebGL',WARM_PROPS?'props pre-warmed':null,FIXED_RES?'res pinned '+FIXED_RES:null].filter(Boolean).join(' · ');
    console.log(`\n[fun-perf] run ${r+1}/${RUNS} · ${mode} · ${info.renderer} · ${info.size} · quality ${info.quality}`+
      ` · startGame() ${f1(info.startMs)}ms · programs ${info.programs}→${res.programs} · dynScale ${res.dynScale.toFixed(2)}`);
    if(info.warmMs)console.log(`  prop warm-up frame: ${info.warmMs}ms`);
    for(const fu of res.firstUse)if(fu){
      console.log(`  first ${fu.type.padEnd(6)} maxWork ${String(fu.maxWork).padStart(6)}ms  maxGap ${String(fu.maxGap).padStart(6)}ms  newPrograms ${fu.newPrograms}  newGeos ${fu.newGeos}`);
      for(const w of fu.worst)console.log(`      t+${String(w.at).padStart(6)}s gap ${String(w.gap).padStart(6)} work ${String(w.work).padStart(6)} dp ${w.dp} dg ${w.dg} dt ${w.dt}  ${w.gl}`);
    }
    console.log(winLine('warm',res.warm));
    console.log(winLine('steady',res.steady));
    console.log(winLine('deaths',res.deaths));
    console.log('  events: '+Object.entries(res.counts).map(([k,v])=>k+'×'+v).join(' '));
    if(res.resLog.length)console.log('  resolution changes: '+res.resLog.map(x=>`→${x.to.toFixed(2)}@${x.ratio}`).join('  '));
    console.log(`  slow-frame ratio per 60-frame window (steady): ${res.resWindows.join(' ')}`);
    if(res.hitches.length){
      console.log('  slowest frames  [gap = time since the previous frame started · dp/dg/dt = new shader programs / geometries / textures in that tick]:');
      for(const h of res.hitches.slice(0,26)){
        console.log(`   t+${String(h.at).padStart(7)}s gap ${String(h.gap).padStart(6)} work ${String(h.work).padStart(6)}  dp ${h.dp} dg ${h.dg} dt ${h.dt}  ${h.gl}`+
          `  during[${h.inFrame.join(',')}]  before[${h.before.join(',')}]${h.err?'  ERR '+h.err:''}`);
        if(PROFILE&&h.gap>=60){const p=frameProfile(h);if(p&&p.totalMs)console.log(`        cpu ${p.totalMs}ms: ${p.self}`);}
      }
    }
    if(PROFILE){
      const rep=profileReport(prof,res.steadyFromUs,res.steadyToUs,22);
      console.log(`  CPU profile (steady window, ${rep.totalMs}ms sampled):\n   self: ${rep.self}\n   incl: ${rep.incl}`);
    }
    if(res.frameErrors.length)console.log('  FRAME ERRORS: '+res.frameErrors.join(' | '));
    if(res.uiErrors.length)console.log('  UI ERRORS: '+res.uiErrors.join(' | '));
    writeFileSync(resolve(ROOT,`fun-perf-${TAG}-${r+1}.json`),JSON.stringify({info,res:{...res,all:undefined,steadyGaps:undefined}}));
    writeFileSync(resolve(ROOT,`fun-perf-${TAG}-${r+1}.frames.json`),JSON.stringify(res.all));
  }finally{page.close();}
}
process.exit(0);
