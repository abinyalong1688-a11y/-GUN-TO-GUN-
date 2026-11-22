// operators.test.mjs — operator registry data integrity (M1-S1.1 acceptance)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OPERATORS,byId,byFaction,DEFAULT_OP,CAMOS,paletteFor} from '../src/operators.js';
import {WEAPON_DEFS} from '../src/weapon.js';

test('operator count and faction split',()=>{
  assert.equal(OPERATORS.length,8);
  for(const f of ['ct','t']){
    const ops=byFaction(f);
    assert.equal(ops.length,4,f+' should have 4 operators');
    assert.deepEqual(ops.map(o=>o.gender).sort(),['f','f','m','m'],f+' should be two males + two females');
  }
});

test('operator ids are unique and the default operator exists',()=>{
  const ids=OPERATORS.map(o=>o.id);
  assert.equal(new Set(ids).size,ids.length,'operator ids must not repeat');
  assert.ok(byId(DEFAULT_OP),'the default operator must exist');
  assert.equal(byId('nope'),null,'unknown id should return null');
});

test('every operator weapon exists in WEAPON_DEFS',()=>{
  for(const o of OPERATORS)assert.ok(WEAPON_DEFS[o.rifle],`${o.id}: weapon ${o.rifle} does not exist`);
});

test('operator required fields are complete',()=>{
  for(const o of OPERATORS){
    assert.ok(o.name.zh&&o.name.en,`${o.id} is missing a name`);
    assert.ok(o.role.zh&&o.role.en,`${o.id} is missing a role`);
    assert.ok(o.hp>0,`${o.id} has invalid hp`);
    assert.ok(o.speedMul>0&&o.reloadMul>0&&o.recoilMul>0,`${o.id} has invalid stat multipliers`);
    for(const k of ['skin','hair','jacket','armor','accent','cloth'])
      assert.equal(typeof o.palette[k],'number',`${o.id} palette.${k} should be a number`);
    assert.ok(Array.isArray(o.extras)&&o.extras.length<=3,`${o.id} extras should be an array of at most 3`);
    assert.ok(o.quote.zh&&o.quote.en,`${o.id} is missing a quote`);
    assert.ok(o.voice.pitch>0,`${o.id} is missing a voice pitch`);
  }
});

test('camo override and unknown camo fallback',()=>{
  const frost=byId('frost');
  assert.deepEqual(paletteFor(frost,'default'),frost.palette);
  const snow=paletteFor(frost,'snow');
  assert.notEqual(snow.jacket,frost.palette.jacket,'snow camo should override the jacket colour');
  assert.equal(snow.accent,frost.palette.accent,'camo must not override the accent colour');
  assert.equal(paletteFor(frost,'nope').jacket,frost.palette.jacket,'unknown camo should fall back to default');
  assert.ok(Object.keys(CAMOS).includes('desert')&&Object.keys(CAMOS).includes('urban'));
});
