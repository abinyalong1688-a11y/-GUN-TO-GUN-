// weapon.test.mjs —— 武器库完整性 / 后坐力弹道模式 / 负重移速
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WEAPON_DEFS,recoilShot} from '../src/weapon.js';

const ALL=Object.values(WEAPON_DEFS);

test('武器定义完整性:必备字段与唯一 id',()=>{
  const ids=new Set();
  for(const w of ALL){
    assert.equal(typeof w.id,'string');
    assert.ok(!ids.has(w.id),'重复 id: '+w.id);
    ids.add(w.id);
    for(const k of ['name','slotName','rpm','dmg','mag','reloadDur','speedMul'])
      assert.ok(w[k]!=null,`${w.id} 缺少 ${k}`);
    assert.ok(w.rpm>0&&w.rpm<=1000,`${w.id} rpm 异常`);
    assert.ok(w.dmg>0&&w.dmg<=130,`${w.id} dmg 异常`);
    assert.ok(w.speedMul>0&&w.speedMul<=1.2,`${w.id} 移速倍率异常`);
  }
});

test('狙击/步枪/冲锋枪/手枪的弹速与负重排序符合真实武器定位',()=>{
  const g=id=>WEAPON_DEFS[id];
  assert.ok(g('awp').dmg>g('ak47').dmg,'AWP 单发威力应最高');
  assert.ok(g('awp').speedMul<g('ak47').speedMul,'AWP 负重应最慢');
  assert.ok(g('mp5').rpm>g('ak47').rpm,'MP5 射速应高于步枪');
  assert.ok(g('mp5').speedMul>g('ak47').speedMul,'冲锋枪移速应快于步枪');
  assert.ok(g('knife').speedMul>g('deagle').speedMul,'持军刀应快于持枪');
  assert.ok(g('awp').mag<g('ak47').mag,'狙击弹匣应更小');
});

test('瞄准镜武器:scope 标志与开镜倍率排序(AWP>AUG>SG553)',()=>{
  for(const id of ['aug','awp','sg553'])assert.ok(WEAPON_DEFS[id].scope,id+' 应带瞄准镜');
  for(const id of ['ak47','m4a4','mp5','deagle'])assert.ok(!WEAPON_DEFS[id].scope,id+' 不应带镜');
  const fov=id=>WEAPON_DEFS[id].scopeFov;
  assert.ok(fov('awp')<fov('aug'),'AWP 开镜应比 AUG 更窄(倍率更高)');
  assert.ok(fov('aug')<fov('sg553'),'AUG 开镜应比 SG553 更窄');
});

test('recoilShot:确定性、前几发爬升、停火复位无状态',()=>{
  const ak=WEAPON_DEFS.ak47;
  const a=recoilShot(ak,0,false), b=recoilShot(ak,0,false);
  assert.equal(a.up,b.up,'同一序号应完全确定(可复现弹道)');
  const up5=recoilShot(ak,5,false).up, up0=recoilShot(ak,0,false).up;
  assert.ok(up5>up0,'连射弹道应持续爬升');
  const ads=recoilShot(ak,5,true), hip=recoilShot(ak,5,false);
  assert.ok(Math.abs(ads.up)<hip.up,'ADS 后坐应收敛');
  assert.ok(typeof recoilShot(ak,0,false).right==='number','水平漂移应为数值');
});

test('军刀为近战且无弹药',()=>{
  const k=WEAPON_DEFS.knife;
  assert.ok(k.melee);
  assert.equal(k.mag,0);
});
