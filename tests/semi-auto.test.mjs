// semi-auto.test.mjs — the bolt-action trigger must not swallow clicks, and the ADS cone must
// be a smooth blend rather than a hard threshold.
//
// Both bugs made the LONGBOW feel like it "never fires / never hits":
//  · a click during the bolt cooldown was dropped outright (no queue, no dry-fire);
//  · `spreadRad` used the full hip cone until adsAmt crossed .7, so every shot taken while the
//    scope was still easing in inherited the 1.2 m-at-20 m hip cone.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({
  font:'',textAlign:'',textBaseline:'',shadowColor:'',shadowBlur:0,fillStyle:'',fillText(){},
})})};
globalThis.window={innerWidth:1920,innerHeight:1080,devicePixelRatio:1,addEventListener(){}};

const {Weapon,WEAPON_DEFS}=await import('../src/weapon.js');

const mkMat=()=>new THREE.MeshStandardMaterial();
const assets={mats:new Proxy({},{get:mkMat}),tex:new Proxy({},{get:()=>new THREE.Texture()})};
const audio=new Proxy({},{get:()=>()=>{}});
const ui=new Proxy({},{get:()=>()=>{}});
const makeWeapon=()=>new Weapon(new THREE.Scene(),assets,audio,ui,'high');
const makePlayer=()=>({vel:new THREE.Vector3(),sprinting:false,airborne:false,crouching:false});
const cam=new THREE.PerspectiveCamera();
const DT=1/60;

/* Run the weapon for `frames` at 60 fps, returning the shot timestamps. `isDown(t)` decides the
   trigger each frame, which is how a real click arrives (one pressed frame per click). */
function fire(weapon,isDown,frames=300){
  const player=makePlayer();
  const shots=[];
  for(let i=0;i<frames;i++){
    const t=i*DT;
    weapon.update(DT,{firing:isDown(t),ads:true},player,cam,t,()=>shots.push(+t.toFixed(3)));
  }
  return shots;
}
const clickAt=times=>t=>times.some(x=>Math.abs(t-x)<DT/2);

test('semi-auto: a click during the bolt cooldown is queued, not swallowed',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  // Six clicks 0.2 s apart on a 1.46 s bolt: without the queue only the very first fires.
  const shots=fire(w,clickAt([0,.2,.4,.6,.8,1.0]));
  assert.ok(shots.length>=2,`rapid clicks must not all be dropped, got ${shots.length} shot(s)`);
});

test('semi-auto: one click per bolt cycle always fires (no lost inputs)',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  const cool=60/WEAPON_DEFS.awp.rpm;              // 1.463 s
  const times=[0,1,2,3,4].map(i=>i*cool*1.6);     // safely slower than the bolt
  const frames=Math.ceil((times.at(-1)+1)/DT);    // run until 1 s past the last click
  const shots=fire(w,clickAt(times),frames);
  assert.equal(shots.length,times.length,
    `every click spaced beyond the bolt cycle must fire (${shots.length}/${times.length})`);
});

test('semi-auto: holding the trigger does not make a bolt rifle full-auto',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  const shots=fire(w,()=>true,300);               // 5 s held
  assert.equal(shots.length,1,'a held trigger is one shot for a semi-auto');
});

test('semi-auto: the queue expires instead of firing late',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  // Fire once, then click once more mid-bolt and never touch the trigger again: exactly 2 shots.
  const shots=fire(w,clickAt([0,3]),Math.ceil(6/DT));
  assert.equal(shots.length,2,'a click during the bolt fires on completion, then nothing more');
});

test('spread blends hip → ADS continuously (no hard .7 threshold)',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  const player=makePlayer();
  const sample=adsAmt=>{w.adsAmt=adsAmt;w.heat=0;return w.spreadRad(player);};
  const hip=sample(0), mid=sample(.45), ads=sample(1);
  assert.ok(hip>mid&&mid>ads,
    `spread must shrink monotonically with the scope: hip ${hip} / mid ${mid} / ads ${ads}`);
  assert.ok(mid<hip*.75,
    `half-scoped must be well tighter than hip (mid ${mid.toFixed(4)} vs hip ${hip.toFixed(4)})`);
});

test('awp hip cone at 20 m stays inside a torso-sized circle',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  const player=makePlayer();
  w.adsAmt=0;w.heat=0;
  const radius=Math.tan(w.spreadRad(player))*20;
  // The torso hit sphere is .42 m; a hip cone much wider than that reads as "the rifle can't hit".
  assert.ok(radius<.95,`20 m hip spread radius ${radius.toFixed(2)} m is wider than a body`);
});
