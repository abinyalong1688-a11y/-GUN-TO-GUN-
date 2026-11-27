// sniper-damage.test.mjs — the LONGBOW (awp) must one-tap every operator with a headshot.
//
// Two damage paths exist and they must agree:
//   · offline / local bots: WEAPON_DEFS.awp.dmg × playerCritMul() through HeroBot.takeDamage
//   · online: the DO recomputes WEAPON_DMG.awp × HEAD_MUL from src/netProtocol.js
// A regression here is invisible in play (the rifle "doesn't kill"), so it is pinned down here.
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

const {HeroBot}=await import('../src/heroes.js');
const {OPERATORS,byId}=await import('../src/operators.js');
const {WEAPON_DEFS}=await import('../src/weapon.js');
const {WEAPON_DMG,HEAD_MUL,HIT_DMG_CAP}=await import('../src/netProtocol.js');

const AWP=WEAPON_DEFS.awp;
const fakeAssets=()=>{
  const m=()=>new THREE.MeshStandardMaterial();
  return {mats:{ctFatigue:m(),tJacket:m(),ctArmor:m(),tRig:m(),tPants:m(),skinF:m(),skinM:m(),
    hairF:m(),hairM:m(),bootDark:m(),gloveDark:m(),gunDark:m(),gunWood:m(),gunPoly:m(),
    sclera:m(),iris:m(),brow:m(),lipsF:m(),lipsM:m(),clothDark:m(),armSleeve:m()}};
};
function makeGame(){
  const playerPos=new THREE.Vector3(0,0,40);
  return {
    scene:new THREE.Scene(),assets:fakeAssets(),
    fx:{tracer(){},bloodPuff(){},impact(){}},
    audio:{respawn(){},radio(){},botShot(){},kill(){},hurt(){}},
    ui:{bark(){}},
    settings:{get:()=>null},
    world:{colliders:[],losStatics:[]},
    heroes:{list:[]},
    player:{pos:playerPos,vel:new THREE.Vector3(),eye:new THREE.Vector3(0,1.62,40),alive:true,health:100,maxHealth:100,god:false},
    playerTeam:'A',mode:'dm',time:0,
    playerShotT:-99,playerShotPos:new THREE.Vector3(),
    camera:{position:new THREE.Vector3(0,1.6,8)},
    damagePlayerFromBot(){},botDamageFx(){},onHeroKill(){},
  };
}
const makeBot=(op)=>{
  const g=makeGame();
  const h=new HeroBot(g,g.scene,g.assets,g.fx,g.audio,g.ui,{operator:op,team:'B',name:op.id});
  h.invulnT=0;
  g.heroes.list.push(h);
  return h;
};

/* ---- power tables ---- */
test('awp: the offline and online damage tables describe the same rifle',()=>{
  assert.equal(AWP.dmg,WEAPON_DMG.awp,'weapon.js dmg and netProtocol WEAPON_DMG must not drift');
  assert.equal(HEAD_MUL,2,'the headshot multiplier the DO applies is ×2');
  assert.ok(HIT_DMG_CAP.awp>=WEAPON_DMG.awp*HEAD_MUL,
    `the DO cap (${HIT_DMG_CAP.awp}) must accept a full headshot (${WEAPON_DMG.awp*HEAD_MUL})`);
});

test('awp headshot one-taps every operator (offline path)',()=>{
  const dmg=AWP.dmg*2; // playerCritMul() is 2.0 before wave upgrades
  for(const op of OPERATORS){
    const h=makeBot(op);
    // The lowest-HP operator still survives a body shot, so the headshot is doing real work.
    h.takeDamage(AWP.dmg,'tester',false,'tester');
    const aliveAfterBody=h.alive;
    h.hp=h.maxHp;h.alive=true;h.state='active';
    h.takeDamage(dmg,'tester',true,'tester');
    assert.equal(h.alive,false,`${op.id} (${op.hp} hp) must die to one AWP headshot (${dmg} dmg)`);
    // snowwolf (125 hp) is the only one that survives a torso hit
    assert.equal(aliveAfterBody,op.hp>AWP.dmg,`${op.id}: torso survives only when hp > ${AWP.dmg}`);
  }
});

test('awp torso: at most two hits for every operator',()=>{
  for(const op of OPERATORS){
    const h=makeBot(op);
    h.takeDamage(AWP.dmg,'tester',false,'tester');
    const shotsAfterFirst=h.alive?1:0;
    if(h.alive)h.takeDamage(AWP.dmg,'tester',false,'tester');
    assert.equal(h.alive,false,`${op.id} (${op.hp} hp) must die within two AWP torso hits`);
    assert.ok(shotsAfterFirst<=1,`${op.id} needs at most one extra torso hit`);
  }
});

/* ---- hit sphere geometry (no gap that swallows a head shot) ---- */
test('hit spheres form a closed column: head, neck and torso overlap',()=>{
  for(const id of ['frost','snowwolf']){ // female / male rig heights
    const h=makeBot(byId(id));
    const s=h.hitSpheres();
    const head=s.find(x=>x.part==='head');
    const body=s.filter(x=>x.part==='body');
    // The neck is the small body sphere (r=.09); the chest is the big one (r=.42).
    const neck=body.reduce((a,b)=>a.r<b.r?a:b);
    const torso=body.reduce((a,b)=>a.r>b.r?a:b);
    assert.ok(neck.c.y+neck.r>=head.c.y-head.r-1e-9,
      `${id}: neck top (${(neck.c.y+neck.r).toFixed(2)}) must reach the head sphere `+
      `(bottom ${(head.c.y-head.r).toFixed(2)}) — no empty band at the throat`);
    assert.ok(torso.c.y+torso.r>=neck.c.y-neck.r-1e-9,
      `${id}: torso top must reach the neck sphere`);
    assert.equal(head.r,.16,'head sphere radius is pinned (the server LOS_HEAD matches it)');
    assert.equal(torso.r,.42,'torso sphere radius is pinned');
  }
});

test('a level shot at head height reports the head part, not the body',()=>{
  for(const op of OPERATORS){
    const h=makeBot(op);
    const head=h.hitSpheres().find(s=>s.part==='head');
    // Ray from 10 m away, straight at the head centre, fired level.
    const origin=new THREE.Vector3(head.c.x,head.c.y,head.c.z-10);
    const dir=new THREE.Vector3(0,0,1);
    let bestT=Infinity,bestPart=null;
    for(const s of h.hitSpheres()){
      const oc=new THREE.Vector3().copy(origin).sub(s.c);
      const b=oc.dot(dir),cc=oc.dot(oc)-s.r*s.r;
      const disc=b*b-cc;
      if(cc<=0){bestT=0;bestPart=s.part;continue;}
      if(disc<0)continue;
      const t=-b-Math.sqrt(disc);
      if(t>0&&t<bestT){bestT=t;bestPart=s.part;}
    }
    assert.equal(bestPart,'head',`${op.id}: aiming at the head centre must register as a head hit`);
  }
});
