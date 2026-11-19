// portraits.test.mjs —— 立绘渲染器兜底(S1.3 验收):
//   Node 无 WebGL 环境下不得抛异常,render() 返回 null;dispose() 可重复调用。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {PortraitRenderer} from '../src/portraits.js';
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

test('无 WebGL 环境:render 返回 null 且不抛异常',()=>{
  const p=new PortraitRenderer(fakeAssets());
  assert.equal(p.render(byId('frost')),null);
  assert.equal(p.render(byId('raven'),'snow'),null);
  p.dispose();
  p.dispose();
  assert.equal(p.render(byId('frost')),null);
});

test('缓存键按 id|camo|size 区分(无 WebGL 时不产生缓存)',()=>{
  const p=new PortraitRenderer(fakeAssets());
  p.render(byId('frost'),'default',256);
  assert.equal(p.cache.size,0);
  p.dispose();
});
