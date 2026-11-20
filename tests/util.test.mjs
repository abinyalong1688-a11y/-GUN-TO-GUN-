// util.test.mjs — shared helper unit tests
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escHTML,store,num} from '../src/util.js';

test('escHTML escapes every dangerous character',()=>{
  assert.equal(escHTML('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHTML(`'"&`),'&#39;&quot;&amp;');
  assert.equal(escHTML('普通 callsign'),'普通 callsign'); // non-ASCII text passes through untouched
});

test('escHTML with non-string input',()=>{
  assert.equal(escHTML(123),'123');
  assert.equal(escHTML(null),'null');
});

test('store never throws on read/write; works normally when localStorage exists',()=>{
  assert.doesNotThrow(()=>store.set('__t_k','v1'));
  assert.doesNotThrow(()=>store.get('__t_k'));
  assert.equal(store.get('__t_missing','def'),'def');
  if(typeof globalThis.localStorage!=='undefined'&&globalThis.localStorage){
    store.set('__t_k','v1');
    assert.equal(store.get('__t_k'),'v1');
    store.set('__t_k',null);
    assert.equal(store.get('__t_k'),'null'); // set(null) stores a string; callers own the semantics
  }else{
    // No localStorage (Node): get takes the default-value path
    assert.equal(store.get('__t_k','fallback'),'fallback');
  }
});

test('num parsing and dirty-data fallback',()=>{
  assert.equal(num('1.5'),1.5);
  assert.equal(num('-3'),-3);
  assert.equal(num('abc'),null);
  assert.equal(num(''),null);
  assert.equal(num(null),null);
  assert.equal(num('12px')??1,12); // parseFloat prefix behaviour
});
