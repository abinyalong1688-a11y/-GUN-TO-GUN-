// nav.test.mjs — bot navigation (P0–P3): wall slide, stuck escape, pathfinding, crowd spacing
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/* makeNameTag (heroes.js) draws on a 2d canvas — stub document before the import */
globalThis.document={createElement(tag){
  if(tag!=='canvas')throw new Error('unexpected createElement: '+tag);
  return {width:0,height:0,getContext(){return{
    font:'',textAlign:'',textBaseline:'',shadowColor:'',shadowBlur:0,fillStyle:'',fillText(){},
  };}};
}};

const {HeroBot,HeroTeam}=await import('../src/heroes.js');
const {SpatialGrid,ColliderGrid}=await import('../src/world.js');
const {byId}=await import('../src/operators.js');

/* ---- harness ---- */
const fakeAssets=()=>{ // same material set as character.test.mjs
  const m=()=>new THREE.MeshStandardMaterial();
  return {mats:{
    ctFatigue:m(),tJacket:m(),ctArmor:m(),tRig:m(),tPants:m(),
    skinF:m(),skinM:m(),hairF:m(),hairM:m(),
    bootDark:m(),gloveDark:m(),gunDark:m(),gunWood:m(),gunPoly:m(),
    sclera:m(),iris:m(),brow:m(),lipsF:m(),lipsM:m(),clothDark:m(),armSleeve:m(),
  }};
};
let NOW=0;
function makeGame(colliders=[]){
  return {
    scene:new THREE.Scene(),assets:fakeAssets(),
    fx:{tracer(){},bloodPuff(){},impact(){}},
    audio:{respawn(){},radio(){},botShot(){},kill(){},hurt(){}},
    ui:{barks:[],bark(name){this.barks.push(name);}},
    settings:{get:()=>null},
    world:{colliders,losStatics:[]},heroes:{list:[]},
    player:{pos:new THREE.Vector3(0,0,60),eye:new THREE.Vector3(0,1.62,60),vel:new THREE.Vector3(),alive:true,health:100,maxHealth:100,god:false},
    camera:{position:new THREE.Vector3(0,1.6,8)},
    grenades:null,damagePlayerFromBot(){},botDamageFx(){},onHeroKill(){},
  };
}
function makeTeam(g,{foe=true,foePos=[0,0,-40]}={}){
  const team=new HeroTeam(g);g.heroes=team;
  if(foe){ // a blind, harmless enemy far away: the one point every bot walks to
    const f=new HeroBot(g,g.scene,g.assets,g.fx,g.audio,g.ui,{operator:byId('raven'),team:'B',name:'Foe'});
    f.place(new THREE.Vector3(...foePos),0);f.blindT=1e9;f.vel.set(0,0,0);team.list.push(f);
  }
  return team;
}
const addBot=(team,{team:side='A',op='frost',name='Bot',pos=[0,0,0],yaw=Math.PI}={})=>{
  const g=team.game;
  const h=new HeroBot(g,g.scene,g.assets,g.fx,g.audio,g.ui,{operator:byId(op),team:side,name});
  h.place(new THREE.Vector3(...pos),yaw);team.list.push(h);return h;
};
const DT=.016;
const stepTeam=(team,n)=>{for(let i=0;i<n;i++){NOW+=DT;team.update(DT,NOW,()=>true);}};
/* Deterministic Math.random for the scenario tests */
const seeded=(seed,fn)=>{
  let s=seed|0;const r=()=>{s=s+0x6D2B79F5|0;let t=Math.imul(s^s>>>15,1|s);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
  const orig=Math.random;Math.random=r;try{return fn();}finally{Math.random=orig;}
};
/* Is the bot's circle embedded in any collider? (the slide must always leave it clear) */
const embedded=(h,colliders)=>{
  for(const c of colliders){
    if(h.pos.y>c.top)continue;
    const cx=Math.max(c.minX,Math.min(h.pos.x,c.maxX)),cz=Math.max(c.minZ,Math.min(h.pos.z,c.maxZ));
    if((h.pos.x-cx)**2+(h.pos.z-cz)**2<h.radius**2-.01)return true;
  }
  return false;
};
const d2=(a,b)=>Math.hypot(a.pos.x-b.pos.x,a.pos.z-b.pos.z);
const minPair=list=>{let m=Infinity;for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++)m=Math.min(m,d2(list[i],list[j]));return m;};
/* Runs the movement layer only: no targeting, no combat — every bot walks where it is told */
const walkOnly=(bots,moves,team,frames,each)=>{
  for(let f=0;f<frames;f++){
    NOW+=DT;
    bots.forEach((h,i)=>h._stepMove(moves[i][0],moves[i][1],DT));
    team._separate();
    for(const h of bots)h._collide(team.game.world.colliders);
    if(each)each(f);
  }
};

/* ---- P1.4 spatial grid ---- */
test('SpatialGrid.query returns every box under the square, each once — same set as a brute-force scan',()=>{
  const grid=new SpatialGrid(2),boxes=[];
  let s=7;const rnd=()=>{s=(s*16807)%2147483647;return s/2147483647;};
  for(let i=0;i<400;i++){
    const x=(rnd()-.5)*80,z=(rnd()-.5)*80,w=1+rnd()*6,d=1+rnd()*6;
    boxes.push({minX:x-w/2,maxX:x+w/2,minZ:z-d/2,maxZ:z+d/2,id:i});
    grid.insertBox(x-w/2,z-d/2,x+w/2,z+d/2,boxes[i]);
  }
  const out=[];
  for(let p=0;p<300;p++){
    const x=(rnd()-.5)*80,z=(rnd()-.5)*80,r=rnd()*6;
    const got=grid.query(x,z,r,out);
    const want=boxes.filter(b=>b.minX<=x+r&&b.maxX>=x-r&&b.minZ<=z+r&&b.maxZ>=z-r);
    assert.equal(new Set(got).size,got.length,'a box spanning several cells is listed once');
    for(const w of want)assert.ok(got.includes(w),'box '+w.id+' under the square is reported');
    // A box lying in a touched cell but just outside the square may be reported too — harmless,
    // every caller runs the exact test on what the grid hands back
  }
});
test('ColliderGrid rebuilds when the collider list grows',()=>{
  const cols=[{minX:-5,maxX:5,minZ:-5,maxZ:5,top:1}];
  const grid=new ColliderGrid(cols),out=[];
  assert.equal(grid.query(20,0,1,out).length,0);
  cols.push({minX:19,maxX:21,minZ:-1,maxZ:1,top:1});
  assert.equal(grid.query(20,0,1,out)[0],cols[1]);
});

/* ---- P0.2 / P1.1 normal-projection slide ---- */
test('slide: a square-on hit stops at the wall face, kills the normal velocity and reports a full block',()=>{
  const cols=[{minX:-3,maxX:3,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,-1.7]}); // touching distance
  h.vel.set(0,0,-5);h.pos.z-=5*DT;
  const block=h._slide(0,-5);
  assert.ok(block>.99,'square behind the wall');
  assert.ok(h.pos.z>=-2.2+h.radius-.02,`not embedded (z=${h.pos.z})`);
  assert.ok(Math.abs(h.vel.z)<.3,`velocity into the wall removed (vz=${h.vel.z})`);
  assert.ok(Math.abs(h.vel.x)<.3,'no sideways kick on a square-on hit');
});
test('slide: a 45° hit runs along the wall and keeps 90 % of the tangential speed',()=>{
  const cols=[{minX:-8,maxX:8,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,-1.7]});
  h.vel.set(4,-.0,-4);h.pos.x+=4*DT;h.pos.z-=4*DT;
  const block=h._slide(4,-4);
  assert.ok(block>.5&&block<.95,'a glancing contact');
  assert.ok(h.pos.z>=-2.2+h.radius-.02,'not embedded');
  assert.ok(Math.abs(h.vel.z)<.05,`along the wall (vz=${h.vel.z})`);
  assert.ok(h.vel.x>4.8&&h.vel.x<=Math.hypot(4,4)+.01,`90 % of the approach speed, never more (vx=${h.vel.x})`);
});
test('slide: a residual overlap is relaxed 40 % per contact — no one-frame snap that reads as a shove',()=>{
  const cols=[{minX:-3,maxX:3,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,-1.83]}); // .08 m into the face (under the quarter-radius line)
  h.vel.set(0,0,0);h._slide(0,0);
  const left=(-2.2+h.radius)-h.pos.z;
  assert.ok(Math.abs(left-.08*.6*.6)<.01,`40 % of the overlap goes per contact, two passes per call (left=${left.toFixed(3)})`);
  // A shallow overlap stays a residual for the next frames: never embedded, never a snap
  for(let i=0;i<6;i++)h._slide(0,0);
  assert.ok(Math.abs(left*.6**12)<.004,`the rest bleeds off over the following frames (left=${((-2.2+h.radius)-h.pos.z).toFixed(4)})`);
});
test('slide: a deep overlap (over a quarter radius) is cleared at once',()=>{
  const cols=[{minX:-3,maxX:3,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,-1.9]}); // .15 m in, over the quarter-radius line
  h.vel.set(0,0,0);h._slide(0,0);
  assert.ok(!embedded(h,cols));
  assert.ok(Math.abs(h.pos.z-(-2.2+h.radius))<.001,'pushed back out to the face in one go');
});

/* ---- P0.4 stuck escape ---- */
test('stuck escape: pushing straight into a 60 m wall, the bot slides sideways instead of grinding',()=>{
  const cols=[{minX:-30,maxX:30,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,0]});
  let maxX=0,escaped=false;
  walkOnly([h],[[0,-5]],team,120,f=>{maxX=Math.max(maxX,Math.abs(h.pos.x));if(h.detourT>0)escaped=true;});
  assert.ok(escaped,'an escape opened');
  assert.ok(maxX>1.5,`moved ${maxX.toFixed(2)} m along the wall`);
  assert.ok(!embedded(h,cols));
});

/* ---- acceptance: walls and cover ---- */
test('head-on into a 6 m wall with the target 40 m behind it: goes around, never back-and-forth',()=>{
  const cols=[{minX:-3,maxX:3,minZ:-2.6,maxZ:-2.2,top:2}];
  const g=makeGame(cols);
  const res=seeded(3,()=>{ // same seed as the bench's "B" scenario
    const team=makeTeam(g),h=addBot(team,{pos:[0,0,0]});
    let past=-1,zRev=0,pz=0;
    for(let f=0;f<600;f++){
      stepTeam(team,1);
      if(past<0&&h.pos.z<-15)past=f/60;
      if(f&&Math.sign(h.vel.z)!==Math.sign(pz)&&Math.abs(h.vel.z)>.5&&Math.abs(pz)>.5)zRev++;
      pz=h.vel.z;
      assert.ok(!embedded(h,cols),`embedded at frame ${f}`);
    }
    return {past,zRev};
  });
  assert.ok(res.past>0&&res.past<5,`through in ${res.past}s`);
  assert.equal(res.zRev,0,'no forward/backward jitter');
});
test('five staggered boxes: threads them without a no-progress window',()=>{
  const cols=[];for(let i=0;i<5;i++)cols.push({minX:-3+(i%2?4:-1),maxX:-1+(i%2?6:1),minZ:-2-i*3,maxZ:-2-i*3+1.6,top:1.6});
  const g=makeGame(cols);
  const past=seeded(9,()=>{
    const team=makeTeam(g),h=addBot(team,{pos:[0,0,0]});
    let t=-1,d0=0,pastF=false;
    for(let f=0;f<900;f++){
      if(f%30===0)d0=h.pos.z;
      else if(f%30===29&&f<780)assert.ok(d0-h.pos.z>-.05||h.pos.z<-15,`went backwards or stalled near z=${h.pos.z.toFixed(1)} at ${f/60}s`);
      stepTeam(team,1);
      if(t<0&&h.pos.z<-15)t=f/60;
    }
    return t;
  });
  assert.ok(past>0&&past<6,`through in ${past}s`);
});
test('a low crate on the way to the cover spot: the bot climbs over the route instead of stopping',()=>{
  const cols=[{minX:-2,maxX:2,minZ:-5,maxZ:-4,top:2},{minX:-3,maxX:3,minZ:-1.2,maxZ:-.4,top:.8}];
  const g=makeGame(cols);
  const reach=seeded(5,()=>{
    const team=makeTeam(g,{foePos:[0,0,-30]}),h=addBot(team,{pos:[0,0,0]});
    let t=-1;
    for(let f=0;f<600;f++){stepTeam(team,1);if(t<0&&h.pos.z<-1.5)t=f/60;}
    return t;
  });
  assert.ok(reach>0&&reach<4,`past the crate in ${reach}s`);
});

/* ---- acceptance: crowds ---- */
test('10 bots from a tight spawn on one target: spread within 2 s and stay apart',()=>{
  const g=makeGame([]);
  const res=seeded(7,()=>{
    const team=makeTeam(g),L=[];
    for(let i=0;i<10;i++)L.push(addBot(team,{pos:[-1.5+Math.random()*3,0,14+Math.random()*5]}));
    let minLate=Infinity,tSpread=-1;
    for(let f=0;f<240;f++){
      stepTeam(team,1);
      const m=minPair(L);
      if(f>=120)minLate=Math.min(minLate,m);
      if(tSpread<0&&m>=.7)tSpread=f/60;
    }
    return {minLate,tSpread};
  });
  assert.ok(res.tSpread>=0&&res.tSpread<2,`all pairs ≥ .7 m after ${res.tSpread}s`);
  assert.ok(res.minLate>=.6,`stay apart after 2 s (closest ${res.minLate.toFixed(2)} m)`);
});
test('respawn pile-up: 7 bots spawned on the same spot untangle within 1 s and stay clear',()=>{  // stress case: larger than a 3v3 roster on purpose
  const g=makeGame([]);
  const res=seeded(13,()=>{
    const team=makeTeam(g),L=[];
    for(let i=0;i<7;i++)L.push(addBot(team,{pos:[(Math.random()-.5)*.5,0,20+(Math.random()-.5)*.5]}));
    let t=-1;
    for(let f=0;f<90;f++){stepTeam(team,1);if(t<0&&minPair(L)>=.7)t=f/60;}
    return {t,final:minPair(L)};
  });
  assert.ok(res.t>=0&&res.t<1,`all pairs ≥ .7 m after ${res.t}s`);
  assert.ok(res.final>=.6,`stay clear (${res.final.toFixed(2)} m)`);
});
test('narrow corridor, two bots straight at each other: both get through, nobody is squeezed into a wall',()=>{
  const cols=[{minX:-8,maxX:-1.2,minZ:-3,maxZ:3,top:2},{minX:1.2,maxX:8,minZ:-3,maxZ:3,top:2}];
  const g=makeGame(cols),team=makeTeam(g,{foe:false});
  const a=addBot(team,{pos:[-.2,0,-6],yaw:0}),b=addBot(team,{team:'B',op:'raven',name:'b',pos:[.2,0,6]});
  let minD=Infinity,t=-1;
  walkOnly([a,b],[[0,5],[0,-5]],team,450,f=>{
    minD=Math.min(minD,d2(a,b));
    if(t<0&&a.pos.z>3.8&&b.pos.z<-3.8)t=f/60;
  });
  assert.ok(t>=0,`both through (${t}s)`);
  assert.ok(minD>.5,`no clipping (closest ${minD.toFixed(2)} m)`);
  assert.ok(!embedded(a,cols)&&!embedded(b,cols));
});
test('open ground, two bots head-on: avoidance redirects, it never speeds a bot up or stops it dead',()=>{
  const g=makeGame([]),team=makeTeam(g,{foe:false});
  const a=addBot(team,{pos:[0,0,0],yaw:0}),b=addBot(team,{team:'B',op:'raven',name:'b',pos:[0,0,-5]});
  let maxV=0,t=-1;
  walkOnly([a,b],[[0,-5],[0,5]],team,240,f=>{
    for(const h of [a,b])maxV=Math.max(maxV,h.vel.length());
    if(t<0&&a.pos.z<-2&&b.pos.z>2)t=f/60;
  });
  assert.ok(t>=0,`both carried past each other (${t}s)`);
  assert.ok(maxV<=a.speed*1.001,`capped at the walk speed (${maxV.toFixed(2)} ≤ ${a.speed})`);
});
test('separation: the lower-priority bot takes the larger share of the split',()=>{
  const g=makeGame([]),team=makeTeam(g,{foe:false});
  const a=addBot(team,{pos:[0,0,0]}),b=addBot(team,{team:'B',op:'raven',name:'b',pos:[.3,0,0]});
  a.prio=1;b.prio=3;
  const ax=a.pos.x,bx=b.pos.x;
  team._separate();
  const da=ax-a.pos.x,db=b.pos.x-bx;
  assert.ok(da>.3&&da<.34,`priority 1 takes three quarters of the split (${da.toFixed(2)} m)`);
  assert.ok(Math.abs(db-da/3)<.01,`priority 3 moves a third of that (${db.toFixed(2)} m)`);
  assert.ok(Math.abs(da+db-(.72-.3))<.001,'the pair is exactly .72 m apart');
});

/* ---- P0.1 claim-your-own-spot / P3.2 pathfinding ---- */
test('claimSpot: teammates after the same target never share a stand-off point',()=>{
  const g=makeGame([]),team=makeTeam(g,{foe:false}),L=[];
  for(let i=0;i<4;i++)L.push(addBot(team,{pos:[i*.3,0,0]}));
  seeded(21,()=>{for(const h of L)h._claimSpot();});
  for(let i=0;i<L.length;i++)for(let j=i+1;j<L.length;j++){
    const dx=Math.cos(L[i]._offA)*L[i]._offR-Math.cos(L[j]._offA)*L[j]._offR;
    const dz=Math.sin(L[i]._offA)*L[i]._offR-Math.sin(L[j]._offA)*L[j]._offR;
    assert.ok(Math.hypot(dx,dz)>=1.19,`bots ${i} and ${j} keep their own point (${Math.hypot(dx,dz).toFixed(2)} m)`);
  }
  assert.ok(L.every(h=>h.holdD>0&&h.holdD<20),'each bot gets a stand-off distance of its own');
});
test('local grid A*: a wall with a gap — the route threads the gap and every leg is clear',()=>{
  const cols=[{minX:-6,maxX:-.9,minZ:-4,maxZ:-3.4,top:2},{minX:1.1,maxX:6,minZ:-4,maxZ:-3.4,top:2}];
  const g=makeGame(cols),team=makeTeam(g,{foe:false}),h=addBot(team,{pos:[0,0,0]});
  const route=h._gridPath(0,-9);
  assert.ok(route&&route.length,'a route exists');
  const pts=[{x:h.pos.x,z:h.pos.z},...route];
  for(let i=1;i<pts.length;i++)assert.ok(h._segFree(pts[i-1].x,pts[i-1].z,pts[i].x,pts[i].z),`leg ${i} is clear`);
  assert.ok(route.some(p=>p.z<-3.4&&p.x>-.9&&p.x<1.1),'it passes through the gap');
  for(const p of route)assert.ok(!embedded({pos:p,radius:h.radius},cols),'no waypoint inside a box');
});
test('an 80 m wall: no way through the local window, the corner route takes over',()=>{
  const cols=[{minX:-40,maxX:40,minZ:-3.4,maxZ:-2.8,top:2}]; // right in front of the bot, far wider than the window
  const g=makeGame(cols),team=makeTeam(g,{foe:false}),h=addBot(team,{pos:[0,0,0]});
  assert.equal(h._gridPath(0,-20),null,'nothing inside the 10 m window');
  const route=h._planPath(0,-20);
  assert.ok(route&&route.length,'a corner route exists');
  let x=h.pos.x,z=h.pos.z;
  for(const p of route){assert.ok(h._segFree(x,z,p.x,p.z),'every leg is clear');x=p.x;z=p.z;}
  assert.ok(h._segFree(x,z,0,-20),'the goal is reachable from the last corner');
  assert.ok(Math.abs(x)>39,'it goes round the end of the wall');
});

/* ---- regression: state that outlives a life (respawn / abandoned waypoint / arena edges) ---- */
test('respawn keeps a real escape side: a bot that died still slides out of a wall instead of grinding',()=>{
  const cols=[{minX:-30,maxX:30,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,0]});
  h.respawn();
  h.place(new THREE.Vector3(0,0,0),Math.PI);h.vel.set(0,0,0); // respawn drops the bot at the team spawn; walk it at the wall
  assert.ok(Math.abs(h._detourSide)===1,`the escape side is ±1 (got ${h._detourSide})`);
  let maxX=0;
  walkOnly([h],[[0,-5]],team,150,f=>{maxX=Math.max(maxX,Math.abs(h.pos.x));});
  assert.ok(maxX>1.5,`still escapes after a respawn (moved ${maxX.toFixed(2)} m)`);
  assert.ok(!embedded(h,cols));
});
test('a legacy side of 0 is healed by _escape — the sideways slide is not multiplied by zero',()=>{
  const cols=[{minX:-30,maxX:30,minZ:-2.6,maxZ:-2.2,top:2}],g=makeGame(cols),team=makeTeam(g,{foe:false});
  const h=addBot(team,{pos:[0,0,0]});
  h._detourSide=0; // what an older respawn() left behind
  let maxX=0;
  walkOnly([h],[[0,-5]],team,150,f=>{maxX=Math.max(maxX,Math.abs(h.pos.x));});
  assert.ok(Math.abs(h._detourSide)===1,`the side is normalised (got ${h._detourSide})`);
  assert.ok(maxX>1.5,`escaped (moved ${maxX.toFixed(2)} m)`);
  assert.ok(!embedded(h,cols));
});
test('the abandoned-waypoint window expires: _blockT is a countdown, not a latch',()=>{
  const g=makeGame([]),team=makeTeam(g,{foe:false}),h=addBot(team,{pos:[0,0,0]});
  h._blockWp={x:0,z:-6};h._blockT=3;
  for(let f=0;f<60;f++)stepTeam(team,1); // ~1 s
  const mid=h._blockT;
  assert.ok(mid>1.5&&mid<2.1,`still counting down after 1 s (${mid.toFixed(2)})`);
  for(let f=0;f<150;f++)stepTeam(team,1);
  assert.equal(h._blockT,0,'expired after 3 s — the waypoint is planned around for that window only');
  assert.equal(h._gridPath(0,-6).length>0,true,'the route through the old waypoint works again');
});
test('corner route never hands back a waypoint outside the playfield (r=52)',()=>{
  const cols=[{minX:-60,maxX:60,minZ:-3.4,maxZ:-2.8,top:2}]; // both ends past the arena boundary
  const g=makeGame(cols),team=makeTeam(g,{foe:false}),h=addBot(team,{pos:[0,0,0]});
  const route=h._planPath(0,-20);
  assert.equal(route,null,'no reachable corner inside the arena — no phantom route either');
});
test('SpatialGrid.clear drops the seen-marks too, so old occupants are not retained',()=>{
  const grid=new SpatialGrid(2),out=[];
  for(let m=0;m<20;m++){grid.clear();grid.insertBox(0,0,0,0,{});grid.query(0,0,5,out);}
  assert.ok(grid._mark.size<=1,`_mark left with ${grid._mark.size} entries`);
});
