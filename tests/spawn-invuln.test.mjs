// spawn-invuln.test.mjs — every respawn grants 3 s of damage immunity.
//
// The rule lives in netProtocol.js (SPAWN_INVULN) so the player, the bots and the server read
// the same number. These tests pin the bot side (HeroBot.takeDamage / respawn) and the shared
// constant; the player side is covered by the in-browser `spawn-invuln` e2e case.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.document={createElement(tag){
  if(tag!=='canvas')throw new Error('unexpected createElement: '+tag);
  return {width:0,height:0,getContext(){return{
    font:'',textAlign:'',textBaseline:'',shadowColor:'',shadowBlur:0,fillStyle:'',fillText(){},
  };}};
}};

const {HeroBot}=await import('../src/heroes.js');
const {byId}=await import('../src/operators.js');
const {SPAWN_INVULN}=await import('../src/netProtocol.js');

const fakeAssets=()=>{
  const m=()=>new THREE.MeshStandardMaterial();
  return {mats:{ctFatigue:m(),tJacket:m(),ctArmor:m(),tRig:m(),tPants:m(),skinF:m(),skinM:m(),
    hairF:m(),hairM:m(),bootDark:m(),gloveDark:m(),gunDark:m(),gunWood:m(),gunPoly:m(),
    sclera:m(),iris:m(),brow:m(),lipsF:m(),lipsM:m(),clothDark:m(),armSleeve:m()}};
};
function makeGame(){
  return {
    scene:new THREE.Scene(),assets:fakeAssets(),
    fx:{tracer(){},bloodPuff(){},impact(){}},
    audio:{respawn(){},radio(){},botShot(){},kill(){},hurt(){}},
    ui:{bark(){}},settings:{get:()=>null},
    world:{colliders:[],losStatics:[]},heroes:{list:[]},
    player:{pos:new THREE.Vector3(0,0,40),vel:new THREE.Vector3(),eye:new THREE.Vector3(0,1.62,40),
      alive:true,health:100,maxHealth:100,god:false},
    playerTeam:'A',mode:'dm',time:0,
    camera:{position:new THREE.Vector3(0,1.6,8)},
    damagePlayerFromBot(){},botDamageFx(){},onHeroKill(){},
  };
}
const makeBot=()=>{
  const g=makeGame();
  const h=new HeroBot(g,g.scene,g.assets,g.fx,g.audio,g.ui,{operator:byId('frost'),team:'B',name:'B1'});
  g.heroes.list.push(h);
  return h;
};

test('SPAWN_INVULN is the 3 s the requirement asks for',()=>{
  assert.equal(SPAWN_INVULN,3);
});

test('a respawned bot ignores damage for 3 s, then takes it again',()=>{
  const h=makeBot();
  // force a full death → respawn cycle
  h.invulnT=0;h.takeDamage(9999,'tester');
  assert.equal(h.alive,false,'the bot should be dead');
  h.deathT=99;h.update(.016,0,()=>true);
  assert.equal(h.alive,true,'the bot should have respawned');
  assert.ok(h.invulnT>2.9&&h.invulnT<=3.001,`respawn must arm a 3 s shield, got ${h.invulnT}`);

  const hp=h.hp;
  const res=h.takeDamage(230,'tester',true,'tester');
  assert.equal(res,-1,'a shielded bot reports "nothing settled"');
  assert.equal(h.hp,hp,'a shielded bot loses no HP (not even from a headshot)');
  assert.equal(h.alive,true,'a shielded bot cannot die');

  // let the shield run out (dt is clamped in game, but the bot steps on raw dt)
  for(let i=0;i<200;i++)h.update(.016,i*.016,()=>true);
  assert.equal(h.invulnT,0,'the shield must expire, never stay on');
  const after=h.takeDamage(50,'tester');
  assert.equal(h.hp,hp-50,`damage lands once the shield is gone, hp ${h.hp}`);
  assert.notEqual(after,-1);
});

test('a shielded bot is not credited as a kill and spawns no impact',()=>{
  const h=makeBot();
  h.invulnT=SPAWN_INVULN;
  let killed=false;
  h.game.onHeroKill=()=>{killed=true;};
  const res=h.takeDamage(9999,'tester',true,'tester');
  assert.equal(res,-1);
  assert.equal(killed,false,'a shielded target must never produce a kill');
  assert.equal(h.flashT,0,'a shielded hit must not flash the model');
});

/* ---- waves: the drone bolt path calls Player.damage() directly, bypassing damagePlayer() ---- */
test('a shielded player ignores a drone bolt, and takes it once the shield is gone',async()=>{
  const {Enemies}=await import('../src/enemies.js');
  let hp=100;
  const player={
    alive:true,health:100,pos:new THREE.Vector3(0,0,0),
    get eye(){return new THREE.Vector3(0,1.62,0);},
    damage(n){hp=Math.max(0,hp-n);this.health=hp;if(hp<=0)this.alive=false;},
  };
  const mat=()=>new THREE.MeshBasicMaterial();
  const game={
    spawnInvulnT:SPAWN_INVULN,
    camera:{position:new THREE.Vector3()},
    world:{losStatics:[],shootStatics:[]},
    timer:0,
  };
  const en=new Enemies(new THREE.Scene(),
    {mats:new Proxy({},{get:mat}),tex:new Proxy({},{get:()=>new THREE.Texture()}),
     ground:new Proxy({},{get:mat})},
    {impact(){},explosion(){},tracer(){}},
    {whineSet(){},boltShoot(){},explosion(){}},
    {barks:[]});
  // A bolt aimed straight through the player's chest.
  en.spawnBolt(new THREE.Vector3(0,1.27,-1),new THREE.Vector3(0,0,1),20,40,false);
  for(let i=0;i<20;i++)en.update(.016,player,[],i*.016,game);
  assert.equal(hp,100,'a shielded player must ignore bolt damage');
  game.spawnInvulnT=0;
  en.spawnBolt(new THREE.Vector3(0,1.27,-1),new THREE.Vector3(0,0,1),20,40,false);
  for(let i=0;i<20;i++)en.update(.016,player,[],i*.016,game);
  assert.ok(hp<100,'without the shield the same bolt must hurt: hp='+hp);
});
