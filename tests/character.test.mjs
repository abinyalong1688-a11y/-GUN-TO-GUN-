// character.test.mjs — operator mesh builder (S1.2 acceptance):
//   complete parts / material count / shared geometry / camo override / fade and emissive / dispose keeps shared geometry
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildOperatorMesh,fadeMaterials,setEmissive} from '../src/character.js';
import {byId} from '../src/operators.js';

function fakeAssets(){
  const m=()=>new THREE.MeshStandardMaterial();
  return {mats:{
    ctFatigue:m(),tJacket:m(),ctArmor:m(),tRig:m(),tPants:m(),
    skinF:m(),skinM:m(),hairF:m(),hairM:m(),
    bootDark:m(),gloveDark:m(),gunDark:m(),gunWood:m(),gunPoly:m(),
    sclera:m(),iris:m(),brow:m(),lipsF:m(),lipsM:m(),clothDark:m(),armSleeve:m(),
  }};
}

function collectGeometries(root){
  const set=new Set();
  root.traverse(o=>{if(o.isMesh)set.add(o.geometry);});
  return set;
}

test('character parts complete: head / torso / limbs / ponytail / rifle / muzzle',()=>{
  const built=buildOperatorMesh(fakeAssets(),byId('frost'));
  const p=built.parts;
  for(const k of ['head','torso','armL','armR','legL','legR','pony','rifle','gunTip','nameTagAnchor'])
    assert.ok(p[k],`missing part ${k}`);
  assert.ok(p.headY>1.5&&p.headY<1.7);
  assert.ok(built.group.children.length>0);
  built.dispose();
});

test('at most 12 materials per character, independent between characters',()=>{
  const assets=fakeAssets();
  const a=buildOperatorMesh(assets,byId('frost'));
  const b=buildOperatorMesh(assets,byId('frost'));
  assert.ok(a.materials.length<=12,`material count ${a.materials.length} exceeds 12`);
  assert.equal(new Set(a.materials).size,a.materials.length,'material array must not contain duplicates');
  for(const m of a.materials)assert.ok(!b.materials.includes(m),'two characters must not share cloned materials');
  a.dispose();b.dispose();
});

test('geometry cache: characters with the same parameters share geometry',()=>{
  const assets=fakeAssets();
  const a=buildOperatorMesh(assets,byId('frost'));
  const b=buildOperatorMesh(assets,byId('frost'));
  const ga=collectGeometries(a.group),gb=collectGeometries(b.group);
  assert.equal(gb.size,ga.size);
  for(const g of gb)assert.ok(ga.has(g),'same-parameter geometry should hit the cache');
  a.dispose();b.dispose();
});

test('camo overrides clothing colours but not the accent colour',()=>{
  const assets=fakeAssets();
  const def=byId('frost');
  const normal=buildOperatorMesh(assets,def,{camo:'default'});
  const snow=buildOperatorMesh(assets,def,{camo:'snow'});
  const jacketIdx=2; // material order: skin, hair, jacket, ...
  assert.notEqual(snow.materials[jacketIdx].color.getHex(),normal.materials[jacketIdx].color.getHex());
  assert.equal(snow.materials[5].color.getHex(),def.palette.accent,'camo must not change the accent colour');
  normal.dispose();snow.dispose();
});

test('fadeMaterials: transparent / no depth write; setEmissive: emissive',()=>{
  const built=buildOperatorMesh(fakeAssets(),byId('raven'));
  fadeMaterials(built.materials,.4);
  for(const m of built.materials){
    assert.equal(m.opacity,.4);
    assert.equal(m.transparent,true);
    assert.equal(m.depthWrite,false);
  }
  fadeMaterials(built.materials,1);
  for(const m of built.materials){
    assert.equal(m.opacity,1);
    assert.equal(m.transparent,false);
    assert.equal(m.depthWrite,true);
  }
  setEmissive(built.materials,0xff0000,.5);
  assert.equal(built.materials[0].emissive.getHex(),0xff0000);
  assert.equal(built.materials[0].emissiveIntensity,.5);
  built.dispose();
});

test('dispose frees only cloned materials, never shared geometry',()=>{
  const built=buildOperatorMesh(fakeAssets(),byId('frost'));
  const geom=built.parts.head.children[0].geometry;
  let geoDisposed=false;
  const orig=geom.dispose.bind(geom);
  geom.dispose=()=>{geoDisposed=true;orig();};
  let matDisposed=0;
  for(const m of built.materials){
    const od=m.dispose.bind(m);
    m.dispose=()=>{matDisposed++;od();};
  }
  built.dispose();
  assert.equal(geoDisposed,false,'shared geometry must not be disposed');
  assert.equal(matDisposed,built.materials.length,'all cloned materials should be disposed');
});
