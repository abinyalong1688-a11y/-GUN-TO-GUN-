// character.test.mjs —— 角色构建器(S1.2 验收):
//   部件完整 / 材质数量 / 几何共享 / 迷彩覆盖 / 淡出与自发光 / dispose 不释放共享几何
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

test('角色部件完整:头/躯干/四肢/马尾/步枪/枪口',()=>{
  const built=buildOperatorMesh(fakeAssets(),byId('frost'));
  const p=built.parts;
  for(const k of ['head','torso','armL','armR','legL','legR','pony','rifle','gunTip','nameTagAnchor'])
    assert.ok(p[k],`缺少部件 ${k}`);
  assert.ok(p.headY>1.5&&p.headY<1.7);
  assert.ok(built.group.children.length>0);
  built.dispose();
});

test('每角色材质 ≤12 且互相独立',()=>{
  const assets=fakeAssets();
  const a=buildOperatorMesh(assets,byId('frost'));
  const b=buildOperatorMesh(assets,byId('frost'));
  assert.ok(a.materials.length<=12,`材质数量 ${a.materials.length} 超过 12`);
  assert.equal(new Set(a.materials).size,a.materials.length,'材质数组不应重复');
  for(const m of a.materials)assert.ok(!b.materials.includes(m),'两个角色不应共享克隆材质');
  a.dispose();b.dispose();
});

test('几何体缓存:同参数角色共享几何',()=>{
  const assets=fakeAssets();
  const a=buildOperatorMesh(assets,byId('frost'));
  const b=buildOperatorMesh(assets,byId('frost'));
  const ga=collectGeometries(a.group),gb=collectGeometries(b.group);
  assert.equal(gb.size,ga.size);
  for(const g of gb)assert.ok(ga.has(g),'同参数几何应命中缓存');
  a.dispose();b.dispose();
});

test('迷彩覆盖服装色但不改强调色',()=>{
  const assets=fakeAssets();
  const def=byId('frost');
  const normal=buildOperatorMesh(assets,def,{camo:'default'});
  const snow=buildOperatorMesh(assets,def,{camo:'snow'});
  const jacketIdx=2; // materials 顺序:skin,hair,jacket,...
  assert.notEqual(snow.materials[jacketIdx].color.getHex(),normal.materials[jacketIdx].color.getHex());
  assert.equal(snow.materials[5].color.getHex(),def.palette.accent,'迷彩不应改强调色');
  normal.dispose();snow.dispose();
});

test('fadeMaterials:透明/不写深度;setEmissive:自发光',()=>{
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

test('dispose 只释放克隆材质,不释放共享几何',()=>{
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
  assert.equal(geoDisposed,false,'共享几何不应被 dispose');
  assert.equal(matDisposed,built.materials.length,'克隆材质应全部释放');
});
