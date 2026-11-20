// weapon.test.mjs — weapon table integrity / recoil patterns / weight-based move speed
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WEAPON_DEFS,recoilShot} from '../src/weapon.js';

const ALL=Object.values(WEAPON_DEFS);

test('weapon definitions complete: required fields and unique ids',()=>{
  const ids=new Set();
  for(const w of ALL){
    assert.equal(typeof w.id,'string');
    assert.ok(!ids.has(w.id),'duplicate id: '+w.id);
    ids.add(w.id);
    for(const k of ['name','slotName','rpm','dmg','mag','reloadDur','speedMul'])
      assert.ok(w[k]!=null,`${w.id} is missing ${k}`);
    assert.ok(w.rpm>0&&w.rpm<=1000,`${w.id} rpm out of range`);
    assert.ok(w.dmg>0&&w.dmg<=130,`${w.id} dmg out of range`);
    assert.ok(w.speedMul>0&&w.speedMul<=1.2,`${w.id} speed multiplier out of range`);
  }
});

test('sniper / rifle / SMG / pistol damage and weight ordering matches real-world roles',()=>{
  const g=id=>WEAPON_DEFS[id];
  assert.ok(g('awp').dmg>g('ak47').dmg,'Longbow should have the highest single-shot damage');
  assert.ok(g('awp').speedMul<g('ak47').speedMul,'Longbow should be the heaviest');
  assert.ok(g('mp5').rpm>g('ak47').rpm,'MP5 should fire faster than the rifles');
  assert.ok(g('mp5').speedMul>g('ak47').speedMul,'SMG should move faster than a rifle');
  assert.ok(g('knife').speedMul>g('deagle').speedMul,'knife should move faster than any gun');
  assert.ok(g('awp').mag<g('ak47').mag,'sniper magazine should be smaller');
});

test('scoped weapons: scope flag and zoom ordering (Longbow > AUG > SG553)',()=>{
  for(const id of ['aug','awp','sg553'])assert.ok(WEAPON_DEFS[id].scope,id+' should have a scope');
  for(const id of ['ak47','m4a4','mp5','deagle'])assert.ok(!WEAPON_DEFS[id].scope,id+' should not have a scope');
  const fov=id=>WEAPON_DEFS[id].scopeFov;
  assert.ok(fov('awp')<fov('aug'),'Longbow scope should be narrower than AUG (higher zoom)');
  assert.ok(fov('aug')<fov('sg553'),'AUG scope should be narrower than SG553');
});

test('recoilShot: deterministic, climbs over the first shots, stateless reset when firing stops',()=>{
  const ak=WEAPON_DEFS.ak47;
  const a=recoilShot(ak,0,false), b=recoilShot(ak,0,false);
  assert.equal(a.up,b.up,'the same shot index must be fully deterministic (reproducible pattern)');
  const up5=recoilShot(ak,5,false).up, up0=recoilShot(ak,0,false).up;
  assert.ok(up5>up0,'the spray pattern should keep climbing');
  const ads=recoilShot(ak,5,true), hip=recoilShot(ak,5,false);
  assert.ok(Math.abs(ads.up)<hip.up,'ADS should tighten recoil');
  assert.ok(typeof recoilShot(ak,0,false).right==='number','horizontal drift should be a number');
});

test('knife is melee and uses no ammo',()=>{
  const k=WEAPON_DEFS.knife;
  assert.ok(k.melee);
  assert.equal(k.mag,0);
});
