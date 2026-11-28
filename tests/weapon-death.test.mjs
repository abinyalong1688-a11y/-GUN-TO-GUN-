// weapon-death.test.mjs — the viewmodel must not freeze when the player dies.
//
// weapon.update() is the only place that decays the muzzle flash, the shell casings, the recoil
// kick and the ADS zoom. main.js used to skip the call entirely for a dead player, so every one of
// those values froze on the death frame — a muzzle flash that stayed lit on the gun tip forever.
// These tests pin down the cleanup contract and, just as importantly, that a corpse cannot shoot.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>({
  font:'',textAlign:'',textBaseline:'',shadowColor:'',shadowBlur:0,fillStyle:'',fillText(){},
})})};
globalThis.window={innerWidth:1920,innerHeight:1080,devicePixelRatio:1,addEventListener(){}};

const {Weapon}=await import('../src/weapon.js');

const mkMat=()=>new THREE.MeshStandardMaterial();
const assets={mats:new Proxy({},{get:mkMat}),tex:new Proxy({},{get:()=>new THREE.Texture()})};
const audio=new Proxy({},{get:()=>()=>{}});
const uiCalls=[];
const ui=new Proxy({},{get:(_,k)=>{
  if(k==='reloadRing')return v=>uiCalls.push(v);
  return ()=>{};
}});
const makeWeapon=()=>new Weapon(new THREE.Scene(),assets,audio,ui,'high');
/* A live player stub — the same shape the other weapon tests use, plus `alive`. */
const mkPlayer=(alive=true)=>({vel:new THREE.Vector3(),sprinting:false,airborne:false,crouching:false,alive});
const cam=new THREE.PerspectiveCamera();
const DT=1/60;
const step=(w,player,input,shots)=>w.update(DT,input,player,cam,0,()=>{shots&&shots.push(1);});

test('a dead player cannot fire, auto-reload or finish a swap',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  const dead=mkPlayer(false);
  const shots=[];
  const ammoBefore=w.st.ammo;
  for(let i=0;i<120;i++)step(w,dead,{firing:true,ads:true},shots);
  assert.equal(shots.length,0,'a corpse must never produce a shot');
  assert.equal(w.st.ammo,ammoBefore,'a corpse must not spend ammo');
  assert.equal(w.reloading,false,'a corpse must not start a reload');
  assert.equal(w.switchT,-1,'a corpse must not be switching weapons');
});

test('death clears the muzzle flash and its point light',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  const live=mkPlayer();
  step(w,live,{firing:true,ads:false});   // first trigger pull fires a shot
  assert.ok(w.muzzleFlashT>0,'the shot should have lit the flash');
  assert.equal(w.flash.visible,true,'the flash plane should be showing');

  const dead=mkPlayer(false);
  step(w,dead,{firing:false,ads:false});
  assert.equal(w.muzzleFlashT,0,'the flash timer must be cleared on the death frame');
  assert.equal(w.flash.visible,false,'the flash plane must be hidden');
  assert.equal(w.flashLight.intensity,0,'the muzzle point light must be off');
});

test('death deactivates every shell casing',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  step(w,mkPlayer(),{firing:true,ads:false});
  assert.ok(w.shells.some(s=>s.active),'a shot should have ejected a casing');
  step(w,mkPlayer(false),{firing:false,ads:false});
  assert.ok(w.shells.every(s=>!s.active&&!s.mesh.visible),'casings must not hang in the air');
});

test('death cancels an in-progress reload instead of pausing it',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  const live=mkPlayer();
  step(w,live,{firing:true,ads:false});   // spend a round: startReload refuses on a full magazine
  assert.ok(w.st.ammo<w.def.mag,'a round should have been spent');
  w.startReload();
  for(let i=0;i<20;i++)step(w,live,{firing:false,ads:false});
  assert.ok(w.reloadT>0,'the reload should be underway');

  step(w,mkPlayer(false),{firing:false,ads:false});
  assert.equal(w.reloading,false,'the reload must be cancelled');
  assert.equal(w.reloadT,0,'the reload timer must be reset');
});

test('the ADS zoom eases out while dead so the camera FOV is restored',()=>{
  const w=makeWeapon();w.setLoadout('awp');
  const dead=mkPlayer(false);
  w.adsAmt=1;
  for(let i=0;i<60;i++)step(w,dead,{firing:false,ads:false});
  assert.ok(w.adsAmt<.02,`ADS should ease back to hip, got ${w.adsAmt}`);
});

test('recoil kick is zeroed on death so the camera cannot drift',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  w.camKick=.25;w.camKickYaw=.1;w.gunKickZ=.05;w.heat=1;
  step(w,mkPlayer(false),{firing:false,ads:false});
  assert.equal(w.camKick,0);
  assert.equal(w.camKickYaw,0);
  assert.equal(w.gunKickZ,0);
  assert.equal(w.heat,0);
});

test('onDeath is idempotent and repeatable across deaths',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  assert.doesNotThrow(()=>{w.onDeath();w.onDeath();});
  // A respawn re-arms the cleanup, so the NEXT death cleans up again.
  w.onRespawn();
  step(w,mkPlayer(),{firing:true,ads:false});
  assert.ok(w.muzzleFlashT>0,'alive again: the rifle fires');
  step(w,mkPlayer(false),{firing:false,ads:false});
  assert.equal(w.muzzleFlashT,0,'the second death cleans up too');
});

test('a player stub without an `alive` field is treated as alive',()=>{
  /* Regression guard: `alive === false` (strict) is what keeps the existing weapon tests, whose
     player stubs have no `alive` property at all, from silently becoming corpses. */
  const w=makeWeapon();w.setLoadout('m4a4');
  const shots=[];
  const legacy=mkPlayer();delete legacy.alive;
  step(w,legacy,{firing:true,ads:false},shots);
  assert.equal(shots.length,1,'a stub without `alive` must still be able to fire');
});

/* ---------- pause path (same frozen-frame symptom, different trigger) ---------- */
test('clearTransientFx kills the flash and casings without touching a reload',()=>{
  /* Pausing mid-reload must RESUME that reload, so unlike onDeath() this clear cannot cancel it. */
  const w=makeWeapon();w.setLoadout('m4a4');
  const live=mkPlayer();
  step(w,live,{firing:true,ads:false});        // light the flash + eject a casing
  assert.ok(w.muzzleFlashT>0&&w.shells.some(s=>s.active));
  w.startReload();
  for(let i=0;i<10;i++)step(w,live,{firing:false,ads:false});
  assert.ok(w.reloadT>0,'reload underway');
  const adsBefore=w.adsAmt;

  w.clearTransientFx();
  assert.equal(w.muzzleFlashT,0,'flash timer cleared');
  assert.equal(w.flash.visible,false,'flash plane hidden');
  assert.equal(w.flashLight.intensity,0,'muzzle light off');
  assert.ok(w.shells.every(s=>!s.active),'casings hidden');
  assert.equal(w.reloading,true,'a pause must not cancel the reload');
  assert.ok(w.reloadT>0,'the reload timer is preserved');
  assert.equal(w.adsAmt,adsBefore,'ADS is preserved — resume keeps the same zoom');
});

test('clearTransientFx is idempotent and does not fire a held trigger on resume',()=>{
  const w=makeWeapon();w.setLoadout('m4a4');
  assert.doesNotThrow(()=>{w.clearTransientFx();w.clearTransientFx();});
  // A trigger held down when the menu opened must not produce a shot the moment play resumes.
  w._trigWasDown=true;w._shotBuf=.1;
  w.clearTransientFx();
  const shots=[];
  step(w,mkPlayer(),{firing:false,ads:false},shots);
  assert.equal(shots.length,0,'no shot on the frame after resume');
});
