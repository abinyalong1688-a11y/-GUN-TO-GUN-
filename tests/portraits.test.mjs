// portraits.test.mjs — portrait renderer fallback (S1.3 acceptance):
//   without WebGL (Node) nothing may throw, render() returns null; dispose() is idempotent.
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

test('no WebGL: render returns null and does not throw',()=>{
  const p=new PortraitRenderer(fakeAssets());
  assert.equal(p.render(byId('frost')),null);
  assert.equal(p.render(byId('raven'),'snow'),null);
  p.dispose();
  p.dispose();
  assert.equal(p.render(byId('frost')),null);
});

test('cache keys distinguish id|camo|size (no cache entries without WebGL)',()=>{
  const p=new PortraitRenderer(fakeAssets());
  p.render(byId('frost'),'default',256);
  assert.equal(p.cache.size,0);
  p.dispose();
});
