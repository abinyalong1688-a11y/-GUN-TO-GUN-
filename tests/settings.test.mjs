// settings.test.mjs — settings hub (S1.4 acceptance):
//   defaults / clamp / dotted paths / persistence / legacy key migration / dirty data fallback
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

test('defaults: DEFAULTS are used when nothing is saved',()=>{
  globalThis.localStorage=fakeLS();
  settings.load();
  assert.equal(settings.get('fov'),DEFAULTS.fov);
  assert.equal(settings.get('crosshair.color'),DEFAULTS.crosshair.color);
  assert.equal(settings.get('quality'),'high');
});

test('numeric clamp: out-of-range values are pulled back into range',()=>{
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

test('dotted-path get/set and rejection of invalid values',()=>{
  globalThis.localStorage=fakeLS();
  settings.reset();
  assert.equal(settings.set('crosshair.color','#ff8800'),'#ff8800');
  assert.equal(settings.get('crosshair.color'),'#ff8800');
  assert.equal(settings.set('crosshair.color','red'),undefined);
  assert.equal(settings.get('crosshair.color'),'#ff8800');
  assert.equal(settings.set('quality','ultra'),'high');
  assert.equal(settings.set('botDifficulty','nightmare'),'normal');
});

test('persistence: values survive a reload after saving',()=>{
  const ls=fakeLS();
  globalThis.localStorage=ls;
  settings.reset();
  settings.set('fov',90);
  settings.set('music',.25);
  settings.set('crosshair.dot',false);
  // Simulate a page refresh: load again
  settings.load();
  assert.equal(settings.get('fov'),90);
  assert.equal(settings.get('music'),.25);
  assert.equal(settings.get('crosshair.dot'),false);
});

test('legacy key migration: o07_sens / o07_vol / o07_quality',()=>{
  globalThis.localStorage=fakeLS({
    o07_sens:'1.35',
    o07_vol:'0.42',
    o07_quality:'low',
  });
  settings.load();
  assert.equal(settings.get('sens'),1.35);
  assert.equal(settings.get('volume'),.42);
  assert.equal(settings.get('quality'),'low');
  // After migration the v2 record should be written
  assert.ok(globalThis.localStorage.getItem('o07_settings_v2'));
});

test('dirty JSON does not crash and falls back to defaults',()=>{
  globalThis.localStorage=fakeLS({o07_settings_v2:'{bad json'});
  assert.doesNotThrow(()=>settings.load());
  assert.equal(settings.get('fov'),DEFAULTS.fov);
});
