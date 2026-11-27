// heroes.test.mjs — bot combat AI: team setup / targeting / firing / reload / separation / death-respawn
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
function makeGame({difficulty='normal'}={}){
  const playerPos=new THREE.Vector3(0,0,40);
  return {
    scene:new THREE.Scene(),assets:fakeAssets(),
    fx:{tracers:[],tracer(from,dir,len){this.tracers.push({from:from.clone(),dir:dir.clone(),len});},bloodPuff(){},impact(){}},
    audio:{respawn(){},radio(){},botShot(){},kill(){},hurt(){}},
    ui:{barks:[],bark(name){this.barks.push(name);}},
    settings:{get:k=>k==='botDifficulty'?difficulty:null},
    world:{colliders:[],losStatics:[]},
    heroes:{list:[]},
    player:{pos:playerPos,vel:new THREE.Vector3(),eye:new THREE.Vector3(0,1.62,40),alive:true,health:100,maxHealth:100,god:false},
    playerTeam:'A',mode:'dm',koth:null,time:0,
    playerShotT:-99,playerShotPos:new THREE.Vector3(),
    camera:{position:new THREE.Vector3(0,1.6,8)},
    grenades:null,smokeCalls:0,
    damageCalls:[],kills:[],
    damagePlayerFromBot(dmg,fromName){this.damageCalls.push({dmg,fromName});},
    botDamageFx(){},
    onHeroKill(byName,victim){this.kills.push({byName,victim:victim.name});},
  };
}
function makeBot(g,{team='A',op='frost',name='Bot',pos=[0,0,0]}={}){
  const h=new HeroBot(g,g.scene,g.assets,g.fx,g.audio,g.ui,{operator:byId(op),team,name});
  h.place(new THREE.Vector3(...pos),team==='A'?Math.PI:0);
  g.heroes.list.push(h);
  return h;
}
const step=(h,n=1,dt=.016,los=()=>true)=>{for(let i=0;i<n;i++){NOW+=dt;h.update(dt,NOW,los);}};
const stepTeam=(team,n=1,dt=.016,los=()=>true)=>{for(let i=0;i<n;i++){NOW+=dt;team.update(dt,NOW,los);}};
const withRand=(v,fn)=>{const orig=Math.random;Math.random=()=>v;try{return fn();}finally{Math.random=orig;}};
/* Seed a remembered (heard) target without relying on the view cone — used by cover tests
   where the LOS stub intentionally reports "blocked" to simulate a hiding threat. */
const primeSuspicion=(a,b,time=NOW)=>{a.brain.sensor.alert('h'+b.id,b.pos,time,{noise:0,entity:b,team:b.team});};

/* ---- team setup ---- */
test('HeroTeam.setup: 2 teammates + 3 enemies (3v3), the player operator excluded, unique names, base facing',()=>{
  const g=makeGame();
  const team=new HeroTeam(g);
  team.setup('ct','PlayerName','frost');
  assert.equal(team.list.length,5,'deathmatch fields 5 bots (3v3 with the player), got '+team.list.length);
  assert.equal(team.list.filter(h=>h.team==='A').length,2);
  assert.equal(team.list.filter(h=>h.team==='B').length,3);
  assert.ok(team.list.every(h=>h.opId!=='frost'),'bots must not duplicate the player operator');
  assert.ok(team.list.every(h=>(h.team==='A')===(h.faction==='ct')),'team A follows the player faction');
  const names=team.list.map(h=>h.name);
  assert.equal(new Set(names).size,names.length,'cycled operators need distinct names: '+names.join(','));
  for(const h of team.list){
    if(h.team==='A'){assert.ok(Math.abs(h.pos.z-24)<=5.001,'team A spawns at the base z=24±5, got '+h.pos.z);assert.equal(h.yaw,Math.PI);}
    else{assert.ok(Math.abs(h.pos.z+24)<=5.001,'team B spawns at the base z=-24±5, got '+h.pos.z);assert.equal(h.yaw,0);}
  }
  team.clear();
});

/* ---- targeting ---- */
test('targeting: nearest visible enemy wins, dead bots are skipped, team A never targets the player',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});       // faces -z (yaw π)
  const near=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-3]});
  const far=makeBot(g,{team:'B',op:'raven',name:'B2',pos:[0,0,-10]});
  g.player.pos.set(1,0,-1);g.player.eye.set(1,1.62,-1); // closest of all — but team A ignores the player
  a.update(.016,NOW+=.016,()=>true); // acquire
  a.reactionT=0;a.fireT=0;
  withRand(.99,()=>step(a,1));
  assert.equal(near.maxHp-near.hp,12,'the nearest visible enemy bot should take the ct dmgH 12, got '+(near.maxHp-near.hp));
  assert.equal(far.hp,far.maxHp,'the farther bot should be untouched');
  assert.equal(g.damageCalls.length,0,'team A bots never shoot the player');
  near.takeDamage(9999,'X'); // dead bots are skipped
  step(a,8);            // let the sensor prune the corpse and re-acquire (≈.13 s)
  a.reactionT=0;a.fireT=0;
  withRand(.99,()=>step(a,1));
  assert.equal(far.maxHp-far.hp,12,'after the nearest dies, fire shifts to the next enemy');
});

test('team B bots target the player when the player is the nearest enemy',()=>{
  const g=makeGame();
  makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,3]});       // t dmgP 9
  g.player.pos.set(0,0,1);g.player.eye.set(0,1.62,1); // dist 2 < 3
  b.update(.016,NOW+=.016,()=>true);
  b.reactionT=0;b.fireT=0;
  withRand(.99,()=>step(b,1));
  assert.equal(g.damageCalls.length,1,'the player should be shot');
  assert.equal(g.damageCalls[0].dmg,9,'rogue dmgP should be 9, got '+g.damageCalls[0].dmg);
  assert.equal(g.damageCalls[0].fromName,'B1');
});

test('firing line: a teammate in the way holds fire, then fire resumes once the line clears',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});         // faces -z
  const mate=makeBot(g,{team:'A',op:'frost',name:'A2',pos:[0,0,-3]});
  const foe=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-6]});
  a.update(.016,NOW+=.016,()=>true); // acquire the enemy past the teammate
  a.reactionT=0;a.fireT=0;
  const t0=g.fx.tracers.length;
  withRand(.99,()=>step(a,3));
  assert.equal(g.fx.tracers.length,t0,'no shot may pass through a teammate');
  assert.equal(foe.hp,foe.maxHp,'the enemy behind the teammate must stay untouched');
  assert.equal(mate.hp,mate.maxHp,'the teammate must never take bot damage');
  assert.ok(a.brain.blockedLineT>0,'the brain should record the blocked firing line');
  mate.pos.set(4,0,-3); // teammate steps out of the line
  a.reactionT=0;a.fireT=0;
  withRand(.99,()=>step(a,1));
  assert.ok(foe.hp<foe.maxHp,'fire should resume once the line is clear');
  assert.equal(mate.hp,mate.maxHp);
});

/* ---- reaction / burst / reload ---- */
test('reaction time gates the first shot and scales with difficulty',()=>{
  for(const [diff,expect] of [['normal',.24],['hard',.13],['easy',.55]]){
    const g=makeGame({difficulty:diff});
    const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
    makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-8]});
    a.update(.016,NOW+=.016,()=>true); // acquisition sets reactionT
    assert.ok(Math.abs(a.reactionT-expect)<1e-6,`${diff}: reactionT should be ${expect}, got ${a.reactionT}`);
    a.fireT=0;
    const t0=g.fx.tracers.length;
    const win=Math.ceil(expect/.016); // frames until the reaction window reaches 0
    step(a,win-1);
    assert.equal(g.fx.tracers.length,t0,diff+': no shot while reactionT>0');
    step(a,1);
    assert.equal(g.fx.tracers.length,t0+1,diff+': the shot should land once the reaction time expires');
  }
});

test('burst cadence: burstT spacing inside the burst, then a pause before the next burst',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});                    // ct: burst 3, burstT .13, pause 1.2
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-10]});
  a.update(.016,NOW+=.016,()=>true);
  a.reactionT=0;a.fireT=0;
  const shots=[];
  withRand(.99,()=>{
    for(let i=0;i<220;i++){
      b.hp=b.maxHp; // keep the target alive through the burst cycle
      const t0=g.fx.tracers.length;
      a.update(.016,NOW+=.016,()=>true);
      if(g.fx.tracers.length>t0)shots.push(NOW);
      if(shots.length>=4)break;
    }
  });
  assert.ok(shots.length>=4,'expected 4 shots, got '+shots.length);
  const g1=shots[1]-shots[0],g2=shots[2]-shots[1],g3=shots[3]-shots[2];
  assert.ok(Math.abs(g1-.13)<.03&&Math.abs(g2-.13)<.03,`in-burst spacing should be ≈burstT .13: ${g1.toFixed(3)}, ${g2.toFixed(3)}`);
  assert.ok(g3>1.15,`after a full burst there should be a pause ≥1.2, got ${g3.toFixed(3)}`);
});

test('tactical reload: low ammo triggers a 1.2 s reload that blocks firing (ammo refills immediately)',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'}); // mag 30
  makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-10]});
  a.update(.016,NOW+=.016,()=>true); // acquire
  a.reactionT=0;a.fireT=0;a.ammo=3; // 10 % against a visible target — reload beats firing
  a.update(.016,NOW+=.016,()=>true);
  assert.equal(a.ammo,30,'ammo refills the moment the reload starts (cosmetic while reloadT>0)');
  assert.ok(Math.abs(a.reloadT-1.2)<1e-6,'reload timer should be 1.2 s, got '+a.reloadT);
  const t0=g.fx.tracers.length;
  step(a,74); // 74 frames ≈ 1.184 s — still reloading
  assert.equal(g.fx.tracers.length,t0,'no shots while reloadT>0');
  assert.ok(a.reloadT>0&&a.reloadT<=.016+1e-9,'the reload timer should be nearly done, got '+a.reloadT);
  step(a,2);
  assert.equal(g.fx.tracers.length,t0+1,'firing should resume after the reload');
  assert.equal(a.ammo,29);
});

test('empty magazine: _consumeAmmo starts the reload path even mid-burst',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  a.ammo=1;a.reloadT=0;a._consumeAmmo();
  assert.equal(a.ammo,30,'the magazine refills immediately');
  assert.ok(Math.abs(a.reloadT-1.2)<1e-6,'the empty-magazine reload should run for 1.2 s');
});

/* ---- accuracy / damage routing ---- */
test('accuracy: misses deal no damage; smoke inflates the miss chance across its boundary',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'}); // ct missK 1.0
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-10]});
  a.update(.016,NOW+=.016,()=>true);
  a.reactionT=0;a.fireT=0;
  // clean 10 m shot: base .24 + fresh-aim .12 (+ a little while strafing) < .6 → hit
  withRand(.6,()=>step(a,1));
  assert.equal(b.maxHp-b.hp,12,'a clean 10 m shot should hit, hp drop '+(b.maxHp-b.hp));
  b.hp=b.maxHp;
  g.grenades={inSmoke:()=>{g.smokeCalls++;return true;}};
  a.fireT=0;
  withRand(.6,()=>step(a,1));
  assert.equal(g.smokeCalls,1,'inSmoke should be consulted for the target position');
  assert.equal(b.hp,b.maxHp,'smoke pushes the miss chance above .6 → miss, no damage');
  b.hp=b.maxHp;a.fireT=0;
  withRand(0,()=>step(a,1)); // rand 0 < any miss chance → guaranteed miss
  assert.equal(b.hp,b.maxHp,'a missed shot deals no damage');
});

test('miss chance caps at .92 even at long range on easy',()=>{
  const g=makeGame({difficulty:'easy'});
  const b=makeBot(g,{team:'B',op:'raven',name:'B1'});                    // rogue easy: missK 1.35, easy damage .85
  const t=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,30]});       // 30 m: raw chance >1 → capped .92
  b.update(.016,NOW+=.016,()=>true);
  b.reactionT=0;b.fireT=0;
  const saved=b.brain.params;
  b.brain.params={...saved,accuracy:.2}; // force the raw chance above the cap
  try{
    withRand(.93,()=>step(b,1));
    assert.equal(t.maxHp-t.hp,13,'chance capped at .92 → rand .93 should hit (easy damage 15×.85→13), hp drop '+(t.maxHp-t.hp));
    t.hp=t.maxHp;b.fireT=0;
    withRand(.91,()=>step(b,1));
    assert.equal(t.hp,t.maxHp,'rand .91 below the cap should miss');
  }finally{b.brain.params=saved;}
});

/* ---- separation / collision ---- */
test('_separate: overlapping bots split to R, dead and distant pairs untouched, player pushes are one-way',()=>{
  const g=makeGame();
  const team=new HeroTeam(g);
  const P=(x,z,alive=true)=>({pos:new THREE.Vector3(x,0,z),alive});
  const a=P(0,0),b=P(.2,0); // overlapping pair
  team.list=[a,b];team._separate();
  const d=a.pos.distanceTo(b.pos);
  assert.ok(Math.abs(d-.96)<.02,'overlapping bots should end at their .45+.45+.06 radius sum, got '+d.toFixed(3));
  assert.ok(Math.abs(a.pos.x+.38)<.02&&Math.abs(b.pos.x-.58)<.02,'the push should be symmetric (half each)');
  const c=P(5,0),e=P(20,0); // distant pair untouched
  team.list=[c,e];team._separate();
  assert.equal(c.pos.x,5);assert.equal(e.pos.x,20);
  const f=P(0,0,false),h2=P(.2,0); // dead bots are not separated
  team.list=[f,h2];team._separate();
  assert.equal(f.pos.x,0);assert.equal(h2.pos.x,.2);
  g.player.alive=true;g.player.pos.set(0,0,0);
  const w=P(.3,0); // the player is solid as well: the bot yields fully, the player is nudged half
  team.list=[w];team._separate();
  assert.ok(Math.abs(w.pos.x-.91)<.02,'the bot should be pushed out of the player circle, got '+w.pos.x.toFixed(3));
  assert.ok(Math.abs(g.player.pos.x+.305)<.02,'the player should take the soft half push, got '+g.player.pos.x.toFixed(3));
  const z1=P(0,0),z2=P(0,0); // coincident bots split deterministically — no NaN
  team.list=[z1,z2];team._separate();
  assert.ok(Number.isFinite(z1.pos.x)&&Number.isFinite(z2.pos.x),'coincident bots must not produce NaN');
});

test('_collide: circle push-out, arena clamp, and bots embedded IN a box pop out to the nearest face',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:2}];
  a.pos.set(2.3,0,0);a._collide(g.world.colliders);
  assert.ok(Math.abs(a.pos.x-2.45)<.01,'a bot within r=.45 of a face should be pushed out, got '+a.pos.x.toFixed(3));
  a.pos.set(0,0,0);a._collide(g.world.colliders);
  assert.ok(a.pos.x>2.44&&Math.abs(a.pos.z)<.01,'a bot whose center is inside the box should pop to the nearest face, got '+a.pos.x.toFixed(3)+','+a.pos.z.toFixed(3));
  a.pos.set(60,0,0);a._collide([]);
  assert.ok(Math.abs(a.pos.x-52)<.01,'the arena clamp is r=52, got '+a.pos.x);
});

test('integration: separation shoving a bot across a collider boundary ends with the bot outside',()=>{
  const g=makeGame();
  const team=new HeroTeam(g);
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:2}];
  // Both team A (no targets → no update-time collide): A2 sits fully inside the box,
  // A1 just outside the +x face — their overlap must not leave anyone embedded.
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[2.3,0,.1]});
  const b=makeBot(g,{team:'A',op:'frost',name:'A2',pos:[1.7,0,-.1]});
  team.list=[a,b];
  stepTeam(team,5);
  assert.ok(a.pos.x>=2.44&&Number.isFinite(a.pos.x),'the outside bot should stay clear of the face, got '+a.pos.x.toFixed(3));
  assert.ok(b.pos.x>=2.44&&Number.isFinite(b.pos.x),'the embedded bot should pop out instead of staying inside, got '+b.pos.x.toFixed(3));
});

/* ---- cover ---- */
test('_findCover: returns a standable spot outside the cover with the threat blocked',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,8]});
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:2}];
  const threat=new THREE.Vector3(0,1.4,0);
  const c=a._findCover(threat,()=>false);
  assert.ok(c&&Number.isFinite(c.x)&&Number.isFinite(c.z),'a valid cover spot should be found');
  assert.ok(Math.hypot(c.x,c.z)>2,'the cover spot should be outside the cover, got '+c);
  assert.ok(Math.hypot(c.x,c.z)<8,'the cover spot should stay near the cover box, got '+c);
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:.5}];
  assert.equal(a._findCover(threat,()=>false),null,'props under 1 m are not cover');
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:2}];
  assert.equal(a._findCover(threat,()=>true),null,'spots with clear LOS to the threat are rejected');
});

test('bots sidestep around a blocker on the cover path instead of grinding in place',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-30]});
  // box1 provides a valid cover spot; box2 (low: not a cover candidate) blocks the
  // straight path to it — cover movement adds no strafe, so without a detour the bot would
  // grind against the blocker forever.
  g.world.colliders=[
    {minX:-2,maxX:2,minZ:-5,maxZ:-4,top:2},
    {minX:-3,maxX:3,minZ:-1.2,maxZ:-.4,top:.8},
  ];
  a.hp=a.maxHp*.3;
  primeSuspicion(a,b,NOW+1);
  step(a,150,.016,()=>false); // ~2.4 s: inside the first low-health retreat window
  assert.ok(a.coverTarget,'the low-health bot should seek cover against a remembered threat');
  assert.ok(a.pos.z<-1.5,'a blocked bot should sidestep around the blocker and reach cover, stuck at z='+a.pos.z.toFixed(2)+' x='+a.pos.x.toFixed(2));
});

test('holding at the cover spot is not mistaken for being stuck',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-30]});
  g.world.colliders=[{minX:-2,maxX:2,minZ:-5,maxZ:-4,top:2}]; // only the cover box, no blocker
  a.hp=a.maxHp*.3;
  primeSuspicion(a,b,NOW+1);
  step(a,150,.016,()=>false); // ~2.4 s: reach the spot, then hold it
  assert.equal(a.detourT,0,'arriving at cover must not trigger a detour');
  assert.ok(a.coverTarget,'the bot should still own a cover target while holding');
  const d=Math.hypot(a.pos.x-a.coverTarget.x,a.pos.z-a.coverTarget.z);
  assert.ok(d<1.5,'the bot should settle at its cover spot, distance '+d.toFixed(2));
});

/* ---- death / respawn ---- */
test('death chain: die → dying → dead → respawn restores stats at the team base facing the enemy',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});
  a.takeDamage(9999,'Tester');
  assert.equal(g.kills.length,1,'the kill should be reported');
  assert.equal(g.kills[0].byName,'Tester');assert.equal(g.kills[0].victim,'A1');
  assert.equal(a.state,'dying');assert.equal(a.respawnT,5.5);
  assert.equal(a.parts.rifle.parent,g.scene,'the rifle should drop to the scene on death');
  step(a,45); // .72 s → collapsed corpse
  assert.equal(a.state,'dead');
  // the collapse lands prone with the limbs flat on the ground (shins/hips exist only on GLB rigs)
  assert.ok(Math.abs(a.group.rotation.x+Math.PI/2.2)<.02,'the body should be prone at collapse end, rotation.x='+a.group.rotation.x.toFixed(2));
  if(a.shinL){
    const rs=a.shinL.userData.restR;
    assert.ok(Math.abs(a.shinL.rotation.x-rs.x)<.02,'the knees should fully straighten when the limbs land');
  }
  if(a.legL){
    const rl=a.legL.userData.restR;
    assert.ok(Math.abs(a.legL.rotation.z-rl.z-.12)<.02,'the legs should sprawl slightly, roll '+(a.legL.rotation.z-rl.z).toFixed(3));
  }
  assert.ok(Math.abs(a.armL.rotation.x)<.02&&Math.abs(a.armL.rotation.y)<.02,'the arms should hang flat along the body');
  step(a,50); // +0.8 s → the corpse fades out
  assert.equal(a.materials[0].opacity,0,'the corpse should be gone shortly after the limbs land');
  a.deathT=5.55;step(a,1);
  assert.ok(a.alive&&a.state==='active','the bot should respawn after 5.5 s');
  assert.equal(a.hp,a.maxHp);assert.equal(a.ammo,30);
  assert.ok(Math.abs(a.pos.z-24)<=4.001,'team A respawns at the base z=24±4, got '+a.pos.z);
  assert.ok(Math.abs(a.yaw-Math.PI)<1e-6,'team A should face the enemy side (yaw π)');
  assert.equal(a.materials[0].opacity,1,'the corpse fade should be restored');
  assert.ok(a.parts.rifle.parent!==g.scene,'the rifle should be back in hand');
});

/* ---- hitboxes ---- */
test('hitSpheres: head r .16 at headY, body r .42 at +.95, following the bot position',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[3,0,5]});
  const [head,body]=a.hitSpheres();
  assert.equal(head.r,.16);assert.equal(head.part,'head');
  assert.ok(Math.abs(head.c.x-3)<1e-6&&Math.abs(head.c.z-5)<1e-6&&Math.abs(head.c.y-a.headY)<1e-6);
  assert.equal(body.r,.42);assert.equal(body.part,'body');
  assert.ok(Math.abs(body.c.y-.95)<1e-6&&Math.abs(body.c.x-3)<1e-6);
});

/* ---- flashbang blindness ---- */
test('flashblind: loses the target, holds fire, coasts to a stop',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  makeBot(g,{team:'B',op:'raven',name:'B1',pos:[6,0,0]});
  a.vel.set(3,0,2);a.blindT=.5;a.fireT=0;a.reactionT=0;
  step(a,1);
  assert.ok(a.pos.x>.04&&a.pos.x<.055,'a blinded bot coasts on residual velocity, x='+a.pos.x.toFixed(4));
  assert.ok(a.vel.x<3&&a.vel.z<2,'velocity should decay');
  assert.ok(Math.abs(a.blindT-.484)<1e-6,'blindT should tick down');
  assert.equal(g.fx.tracers.length,0,'no firing while blinded');
});

/* ---- radio ---- */
test('radio bark cooldown: 6 s between barks unless forced',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  a._barkT=0;
  assert.ok(a.bark('bark_spot'),'the first bark should fire');
  assert.ok(!a.bark('bark_spot'),'a repeat within the 6 s cooldown is blocked');
  assert.ok(a.bark('bark_spot',true),'force overrides the cooldown');
  assert.equal(g.ui.barks.length,2);
});

/* ---- optimization-pass regressions ---- */
test('switching targets re-opens the reaction window (no snap-fire on the new target)',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  const b1=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-8]});
  makeBot(g,{team:'B',op:'raven',name:'B2',pos:[0,0,-20]});
  a.update(.016,NOW+=.016,()=>true); // acquire B1
  a.reactionT=0;a.fireT=0;
  withRand(.99,()=>step(a,1));
  assert.equal(b1.maxHp-b1.hp,12,'B1 should be shot first');
  b1.takeDamage(9999,'X');           // B1 dies → the target switches to B2
  a.fireT=0;
  const t0=g.fx.tracers.length;
  step(a,15); // 15 frames ≈ .24 s — inside the re-opened reaction window (.24)
  assert.equal(g.fx.tracers.length,t0,'no shot right after switching targets');
  assert.ok(a.reactionT>0&&a.reactionT<=.24,'the reaction window should re-arm, got '+a.reactionT);
  step(a,4); // the window expires on the 19th frame
  assert.equal(g.fx.tracers.length,t0+1,'fire resumes once the window expires');
});

test('difficulty applies live: a mid-match botDifficulty change reaches existing bots',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  makeBot(g,{team:'B',op:'raven',name:'B1',pos:[8,0,0]});
  assert.equal(a.difficulty,'normal');
  g.settings.get=k=>k==='botDifficulty'?'hard':null; // changed mid-match
  a.update(.016,NOW+=.016,()=>true);
  assert.equal(a.difficulty,'hard','the bot should pick up the new difficulty on the next frame');
});

test('miss tracers stop at the first wall instead of drawing through cover',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'}); // faces -z; target 10 m ahead
  const b=makeBot(g,{team:'B',op:'raven',name:'B1',pos:[0,0,-10]});
  const wall=new THREE.Mesh(new THREE.BoxGeometry(2,3,1));
  wall.position.set(0,1.5,-5);wall.updateMatrixWorld(true); // refresh matrices before same-block raycasts
  g.world.losStatics.push(wall);
  a.update(.016,NOW+=.016,()=>true);
  a.reactionT=0;a.fireT=0;
  withRand(0,()=>step(a,1)); // guaranteed miss
  assert.equal(g.fx.tracers.length,1);
  assert.ok(g.fx.tracers[0].len<8,'the miss tracer should clip at the wall ≈4.5 m, len '+g.fx.tracers[0].len.toFixed(2));
  assert.equal(b.hp,b.maxHp,'a missed shot deals no damage');
  a.fireT=0;
  g.world.losStatics.length=0; // same miss with no cover → the tracer flies the full distance
  withRand(0,()=>step(a,1));
  assert.ok(g.fx.tracers[1].len>12,'without cover the tracer runs past the target, len '+g.fx.tracers[1].len.toFixed(2));
});

test('a flash mid-reload no longer freezes the reload timer',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1'});
  makeBot(g,{team:'B',op:'raven',name:'B1',pos:[6,0,0]});
  a.reloadT=1.2;a.blindT=1;
  step(a,30); // .48 s blinded
  assert.ok(a.reloadT>0&&a.reloadT<1.2-.4,'the reload should keep ticking while blinded, got '+a.reloadT);
  assert.equal(g.fx.tracers.length,0,'still holds fire while blinded');
});

test('a dropped rifle rests on crate tops (origin .06 above the surface) instead of sinking',()=>{
  const g=makeGame();
  const a=makeBot(g,{team:'A',op:'frost',name:'A1',pos:[0,0,0]});
  g.world.colliders=[{minX:-2,maxX:2,minZ:-2,maxZ:2,top:.5}]; // low platform under the drop point
  a.takeDamage(9999,'X'); // die → the rifle drops from the hand (held above .5)
  assert.ok(a.rifleFalling,'the rifle should be falling');
  step(a,90);
  assert.ok(!a.rifleFalling,'the rifle should settle');
  assert.ok(Math.abs(a.parts.rifle.position.y-.56)<.01,'the rifle should rest .06 above the platform top .5, got y='+a.parts.rifle.position.y.toFixed(2));
});
