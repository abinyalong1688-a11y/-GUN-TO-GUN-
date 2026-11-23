// weapon-attach.test.mjs — attachment integrity: a gun must be ONE welded assembly.
// Every mesh island that is not connected to the receiver (within 3 mm) is a floating
// accessory — scope without a riser, butt plate behind the stock, front sight above the
// barrel. Reports the island's gap/centre/size on failure.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Weapon} from '../src/weapon.js';
import {makeRifle} from '../src/character.js';
import {attachmentIslands,attachReport} from '../src/attach.js';

const RIFLE_KINDS=['ak47','m4a4','awp','mp5','sg553','aug'];

function matsProxy(){
  const cache={};
  return new Proxy(cache,{get:(t,k)=>k in t?t[k]:(t[k]=new THREE.MeshStandardMaterial({name:String(k)}))});
}

function fakeWeapon(){
  const ui={setSlotNames(){},weaponSlots(){},setAmmo(){},reloadRing(){}};
  const audio=new Proxy({},{get:()=>()=>{}});
  return new Weapon(new THREE.Group(),{mats:matsProxy(),tex:{flash:new THREE.Texture()}},audio,ui,'low');
}

test('first-person weapons: every accessory is welded to the gun body',()=>{
  const w=fakeWeapon();
  const ids=Object.keys(w.models);
  assert.ok(ids.length>=8,'all viewmodels should be built, got '+ids.join(','));
  const bad=[];
  for(const id of ids){
    const r=attachmentIslands(w.models[id]);
    assert.ok(r.meshes>0,id+': no gun meshes found');
    if(!r.ok)bad.push(`${id}: ${r.count} islands\n`+attachReport(r));
  }
  assert.ok(!bad.length,'floating weapon parts:\n'+bad.join('\n'));
});

test('bot rifle silhouettes: every accessory is welded to the gun body',()=>{
  const mats=matsProxy();
  const bad=[];
  for(const kind of RIFLE_KINDS){
    const rifle=makeRifle(kind,mats).group;
    const r=attachmentIslands(rifle);
    if(!r.ok)bad.push(`${kind}: ${r.count} islands\n`+attachReport(r));
  }
  assert.ok(!bad.length,'floating rifle parts:\n'+bad.join('\n'));
});

test('first-person arms are excluded, the gun still reports its own meshes',()=>{
  const w=fakeWeapon();
  const m4=w.models.m4a4;
  let all=0,arms=0;
  m4.traverse(o=>{if(o.isMesh){all++;if(o.userData.fpArm)arms++;}});
  assert.ok(arms>0,'the viewmodel should carry first-person arm meshes');
  const r=attachmentIslands(m4);
  assert.equal(r.meshes,all-arms,'the arm meshes must not count as gun parts');
});
