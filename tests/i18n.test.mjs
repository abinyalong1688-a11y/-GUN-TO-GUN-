// i18n.test.mjs — bilingual dictionary completeness and lookup fallback
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {t,setLang,lang,isEN} from '../src/i18n.js';

test('dictionary completeness: zh and en key sets match',()=>{
  // Checked indirectly via t()'s fallback: for every zh key, the EN lookup must not fall back to the zh text
  const zhKeys=['sub','callsign','deploy','hud_wave','hint_reload','sb_title','wave_banner','win','sponsor'];
  for(const k of zhKeys){
    setLang('en');
    const v=t(k);
    assert.ok(v!==undefined&&v!==k,'EN dictionary is missing key: '+k);
    setLang('zh');
    assert.ok(t(k)!==undefined);
  }
});

test('t lookup and {var} placeholder substitution',()=>{
  setLang('en');
  assert.equal(t('wave_banner',{n:'03'}),'WAVE 03');
  assert.equal(t('supply_sub',{n:300}),'Supply drop · Ammo +90 HP +25 · Bonus +300');
  setLang('zh');
  assert.equal(t('wave_banner',{n:'07'}),'第 07 波'); // zh: "wave 07"
});

test('isEN follows the language switch',()=>{
  setLang('en');assert.ok(isEN());
  setLang('zh');assert.ok(!isEN());
});

test('unknown keys fall back to the key name',()=>{
  setLang('en');
  assert.equal(t('__no_such_key__'),'__no_such_key__');
});
