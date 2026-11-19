// settings.test.mjs —— 设置中心(S1.4 验收):
//   默认值 / clamp / 点路径 / 持久化 / 旧 key 迁移 / 脏数据兜底
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {settings,DEFAULTS} from '../src/settings.js';

function fakeLS(init={}){
  const map=new Map(Object.entries(init));
  return {
    getItem:k=>map.has(k)?map.get(k):null,
    setItem:(k,v)=>map.set(k,String(v)),
    removeItem:k=>map.delete(k),
    clear:()=>map.clear(),
  };
}

test('默认值:未存档时使用 DEFAULTS',()=>{
  globalThis.localStorage=fakeLS();
  settings.load();
  assert.equal(settings.get('fov'),DEFAULTS.fov);
  assert.equal(settings.get('crosshair.color'),DEFAULTS.crosshair.color);
  assert.equal(settings.get('quality'),'high');
});

test('数值 clamp:越界自动收回区间',()=>{
  globalThis.localStorage=fakeLS();
  settings.reset();
  assert.equal(settings.set('fov',200),110);
  assert.equal(settings.set('fov',10),70);
  assert.equal(settings.set('sens',0.01),.3);
  assert.equal(settings.set('sens',99),2.2);
  assert.equal(settings.set('crosshair.gap',99),20);
  assert.equal(settings.set('crosshair.size',1),2);
  assert.equal(settings.set('uiScale',500),120);
});

test('点路径读写与非法值拒绝',()=>{
  globalThis.localStorage=fakeLS();
  settings.reset();
  assert.equal(settings.set('crosshair.color','#ff8800'),'#ff8800');
  assert.equal(settings.get('crosshair.color'),'#ff8800');
  assert.equal(settings.set('crosshair.color','red'),undefined);
  assert.equal(settings.get('crosshair.color'),'#ff8800');
  assert.equal(settings.set('quality','ultra'),'high');
  assert.equal(settings.set('botDifficulty','nightmare'),'normal');
});

test('持久化:保存后重新 load 仍保留',()=>{
  const ls=fakeLS();
  globalThis.localStorage=ls;
  settings.reset();
  settings.set('fov',90);
  settings.set('music',.25);
  settings.set('crosshair.dot',false);
  // 模拟刷新:重新 load
  settings.load();
  assert.equal(settings.get('fov'),90);
  assert.equal(settings.get('music'),.25);
  assert.equal(settings.get('crosshair.dot'),false);
});

test('旧 key 迁移:o07_sens/o07_vol/o07_quality',()=>{
  globalThis.localStorage=fakeLS({
    o07_sens:'1.35',
    o07_vol:'0.42',
    o07_quality:'low',
  });
  settings.load();
  assert.equal(settings.get('sens'),1.35);
  assert.equal(settings.get('volume'),.42);
  assert.equal(settings.get('quality'),'low');
  // 迁移后应写入 v2
  assert.ok(globalThis.localStorage.getItem('o07_settings_v2'));
});

test('脏 JSON 不崩溃并回退默认值',()=>{
  globalThis.localStorage=fakeLS({o07_settings_v2:'{bad json'});
  assert.doesNotThrow(()=>settings.load());
  assert.equal(settings.get('fov'),DEFAULTS.fov);
});
