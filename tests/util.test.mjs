// util.test.mjs —— 通用工具单元测试
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escHTML,store,num} from '../src/util.js';

test('escHTML 转义全部危险字符',()=>{
  assert.equal(escHTML('<img src=x onerror=alert(1)>'),'&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escHTML(`'"&`),'&#39;&quot;&amp;');
  assert.equal(escHTML('普通昵称'),'普通昵称');
});

test('escHTML 非字符串输入',()=>{
  assert.equal(escHTML(123),'123');
  assert.equal(escHTML(null),'null');
});

test('store 读写永不抛异常;有 localStorage 时功能正常',()=>{
  assert.doesNotThrow(()=>store.set('__t_k','v1'));
  assert.doesNotThrow(()=>store.get('__t_k'));
  assert.equal(store.get('__t_missing','def'),'def');
  if(typeof globalThis.localStorage!=='undefined'&&globalThis.localStorage){
    store.set('__t_k','v1');
    assert.equal(store.get('__t_k'),'v1');
    store.set('__t_k',null);
    assert.equal(store.get('__t_k'),'null'); // set(null) 存字符串,语义由调用方保证
  }else{
    // 无 localStorage 环境(node):get 走缺省值路径
    assert.equal(store.get('__t_k','fallback'),'fallback');
  }
});

test('num 数值解析与脏数据兜底',()=>{
  assert.equal(num('1.5'),1.5);
  assert.equal(num('-3'),-3);
  assert.equal(num('abc'),null);
  assert.equal(num(''),null);
  assert.equal(num(null),null);
  assert.equal(num('12px')??1,12); // parseFloat 前缀行为
});
