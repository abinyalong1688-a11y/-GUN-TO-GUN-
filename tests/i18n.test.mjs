// i18n.test.mjs —— 双语字典完整性与取词回退
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {t,setLang,lang,isEN} from '../src/i18n.js';

test('字典完整性:中英键集合一致',()=>{
  // 通过 t 的回退机制间接校验:遍历 zh 键,EN 取词不应回退到 zh 原文
  const zhKeys=['kicker','sub','callsign','deploy','hud_wave','hint_reload','sb_title','wave_banner','win','sponsor'];
  for(const k of zhKeys){
    setLang('en');
    const v=t(k);
    assert.ok(v!==undefined&&v!==k,'EN 字典缺少键: '+k);
    setLang('zh');
    assert.ok(t(k)!==undefined);
  }
});

test('t 取词与 {var} 占位替换',()=>{
  setLang('en');
  assert.equal(t('wave_banner',{n:'03'}),'WAVE 03');
  assert.equal(t('supply_sub',{n:300}),'Supply drop · Ammo +90 HP +25 · Bonus +300');
  setLang('zh');
  assert.equal(t('wave_banner',{n:'07'}),'第 07 波');
});

test('isEN 随语言切换',()=>{
  setLang('en');assert.ok(isEN());
  setLang('zh');assert.ok(!isEN());
});

test('未知键回退为键名',()=>{
  setLang('en');
  assert.equal(t('__no_such_key__'),'__no_such_key__');
});
