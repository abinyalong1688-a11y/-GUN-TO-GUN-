// netHeroes.test.mjs — 5v5 team setup: remote avatars, host bots, AI fill, spawnBase, adoption
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.document={createElement(){
  return {width:0,height:0,getContext(){return{
    font:'',textAlign:'',textBaseline:'',shadowColor:'',shadowBlur:0,fillStyle:'',fillText(){},
  };}};
}};
const {HeroTeam}=await import('../src/heroes.js');
const {byId}=await import('../src/operators.js');

const m=()=>new THREE.MeshStandardMaterial();
function makeGame(){
  return {
    scene:new THREE.Scene(),
    assets:{mats:{ctFatigue:m(),tJacket:m(),ctArmor:m(),tRig:m(),tPants:m(),skinF:m(),skinM:m(),
      hairF:m(),hairM:m(),bootDark:m(),gloveDark:m(),gunDark:m(),gunWood:m(),gunPoly:m(),
      sclera:m(),iris:m(),brow:m(),lipsF:m(),lipsM:m(),clothDark:m(),armSleeve:m()}},
    fx:{tracer(){},bloodPuff(){},impact(){}},
    audio:{respawn(){},radio(){},botShot(){},kill(){},hurt(){}},
    ui:{bark(){}},
    settings:{get:()=>'normal'},
    world:{colliders:[],losStatics:[]},
    heroes:{list:[]},
    spawns:{A:new THREE.Vector3(0,0,40),B:new THREE.Vector3(0,0,-40)},
    player:{pos:new THREE.Vector3(),eye:new THREE.Vector3(),alive:true,health:100,maxHealth:100},
    camera:{position:new THREE.Vector3()},
    onHeroKill(){},damagePlayerFromBot(){},botDamageFx(){},
  };
}

test('setup with opts: 5v5, A=4 bots / B=5, unique names, custom spawnBase',()=>{
  const g=makeGame(),team=new HeroTeam(g);
  team.setup('ct','Player','frost',{sizes:{A:5,B:5},humans:{A:0,B:0},playerTeam:'A',online:true});
  assert.equal(team.list.length,9);
  assert.equal(team.list.filter(h=>h.team==='A').length,4);
  assert.equal(team.list.filter(h=>h.team==='B').length,5);
  assert.equal(new Set(team.list.map(h=>h.name)).size,9);
  for(const h of team.list){
    const base=h.team==='A'?40:-40;
    assert.ok(Math.abs(h.pos.z-base)<=5.01,'spawnBase should be used: '+h.name+' z='+h.pos.z.toFixed(1));
    assert.equal(h.faction,h.team==='A'?'ct':'t');
  }
  team.clear();
});

test('setup with opts: remote humans occupy slots, AI fills only the remainder',()=>{
  const g=makeGame(),team=new HeroTeam(g);
  const roster=[
    {netId:'u2',name:'GuestA1',op:'snowwolf',camo:'snow',team:'A'},
    {netId:'u3',name:'GuestA2',op:'swift',camo:'default',team:'A'},
    {netId:'u4',name:'GuestB1',op:'fox',camo:'urban',team:'B'},
  ];
  team.setup('ct','Player','frost',{
    sizes:{A:5,B:5},humans:{A:2,B:1},playerTeam:'A',roster,bots:[],online:true,isHost:false,
  });
  assert.equal(team.list.length,9);
  assert.equal(team.list.filter(h=>h.kind==='human').length,3,'three remote human proxies');
  assert.equal(team.list.filter(h=>h.kind==='bot').length,6,'AI fills 2 + 4');
  for(const r of roster){
    const h=team.byNetId(r.netId);
    assert.ok(h&&h.netDriven&&h.netBuf,'remote human should be a snapshot-driven proxy');
    assert.equal(h.name,r.name);
    assert.equal(h.faction,r.team==='A'?'ct':'t');
  }
  const bots=team.list.filter(h=>h.kind==='bot');
  assert.equal(bots.filter(h=>h.team==='A').length,2);
  assert.equal(bots.filter(h=>h.team==='B').length,4);
  team.clear();
});

test('host bots are locally simulated; non-host bots are snapshot-driven',()=>{
  const bots=[{id:'bA0',name:'BOT-A1',op:'frost',team:'A'},{id:'bB0',name:'BOT-B1',op:'raven',team:'B'}];
  const opts=sizes=>({sizes:{A:5,B:5},humans:{A:0,B:0},playerTeam:'A',roster:[],bots,online:true});
  const host=new HeroTeam(makeGame());
  host.setup('ct','Player','frost',{...opts(),isHost:true});
  for(const b of bots){const h=host.byNetId(b.id);assert.ok(h&&!h.netDriven&&h.isSimulated,'host simulates bots');}
  const away=new HeroTeam(makeGame());
  away.setup('ct','Player','frost',{...opts(),isHost:false});
  for(const b of bots){const h=away.byNetId(b.id);assert.ok(h&&h.netDriven&&h.netBuf,'non-host replicates bots');}
  host.clear();away.clear();
});

test('online side B: local player faction follows the fixed A=NOVA / B=ROGUE mapping',()=>{
  const g=makeGame(),team=new HeroTeam(g);
  team.setup('t','Player','raven',{sizes:{A:5,B:5},humans:{A:0,B:0},playerTeam:'B',roster:[],bots:[],online:true});
  assert.equal(team.list.filter(h=>h.team==='A').length,5);
  assert.equal(team.list.filter(h=>h.team==='B').length,4);
  assert.ok(team.list.filter(h=>h.team==='A').every(h=>h.faction==='ct'));
  assert.ok(team.list.filter(h=>h.team==='B').every(h=>h.faction==='t'));
  team.clear();
});

test('adopt() appends without clearing and byNetId() ignores local AI',()=>{
  const g=makeGame(),team=new HeroTeam(g);
  team.setup('ct','Player','frost');
  const before=team.list.length;
  const extra={netId:'late',name:'LateJoin'};
  g.heroes.list=team.list;
  const adopted=team.adopt(extra);
  assert.equal(team.list.length,before+1);
  assert.equal(team.byNetId('late'),adopted);
  assert.equal(team.byNetId(0),null,'local bots have netId 0 and are not network-addressable');
  team.list.pop(); team.clear();
});
