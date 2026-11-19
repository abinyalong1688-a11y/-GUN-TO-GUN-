// operators.test.mjs —— 干员注册表数据完整性(M1-S1.1 验收)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OPERATORS,byId,byFaction,DEFAULT_OP,CAMOS,paletteFor} from '../src/operators.js';
import {WEAPON_DEFS} from '../src/weapon.js';

test('干员数量与阵营分布',()=>{
  assert.equal(OPERATORS.length,8);
  assert.equal(byFaction('ct').length,4);
  assert.equal(byFaction('t').length,4);
});

test('干员 id 唯一且默认干员存在',()=>{
  const ids=OPERATORS.map(o=>o.id);
  assert.equal(new Set(ids).size,ids.length,'干员 id 不应重复');
  assert.ok(byId(DEFAULT_OP),'默认干员必须存在');
  assert.equal(byId('nope'),null,'未知 id 应返回 null');
});

test('干员武器均在 WEAPON_DEFS 中',()=>{
  for(const o of OPERATORS)assert.ok(WEAPON_DEFS[o.rifle],`${o.id} 的武器 ${o.rifle} 不存在`);
});

test('干员必填字段完整',()=>{
  for(const o of OPERATORS){
    assert.ok(o.name.zh&&o.name.en,`${o.id} 缺少名称`);
    assert.ok(o.role.zh&&o.role.en,`${o.id} 缺少定位`);
    assert.ok(o.hp>0,`${o.id} hp 非法`);
    assert.ok(o.speedMul>0&&o.reloadMul>0&&o.recoilMul>0,`${o.id} 属性乘数非法`);
    for(const k of ['skin','hair','jacket','armor','accent','cloth'])
      assert.equal(typeof o.palette[k],'number',`${o.id} palette.${k} 应为数字`);
    assert.ok(Array.isArray(o.extras)&&o.extras.length<=3,`${o.id} extras 应为数组且不超过 3 项`);
    assert.ok(o.bio.zh&&o.bio.en,`${o.id} 缺少简介`);
    assert.ok(o.quote.zh&&o.quote.en,`${o.id} 缺少台词`);
    assert.ok(o.voice.pitch>0,`${o.id} 缺少音高`);
  }
});

test('迷彩覆盖与未知迷彩回退',()=>{
  const frost=byId('frost');
  assert.deepEqual(paletteFor(frost,'default'),frost.palette);
  const snow=paletteFor(frost,'snow');
  assert.notEqual(snow.jacket,frost.palette.jacket,'雪地迷彩应覆盖夹克色');
  assert.equal(snow.accent,frost.palette.accent,'迷彩不应覆盖强调色');
  assert.equal(paletteFor(frost,'nope').jacket,frost.palette.jacket,'未知迷彩应回退 default');
  assert.ok(Object.keys(CAMOS).includes('desert')&&Object.keys(CAMOS).includes('urban'));
});
