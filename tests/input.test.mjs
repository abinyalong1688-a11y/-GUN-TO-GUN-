// input.test.mjs —— 输入抽象(S1.5 验收):
//   InputManager 负责挂载/更新/卸载适配器;键鼠适配器不在 Node 中 attach。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InputManager,KeyboardMouseAdapter} from '../src/input.js';

test('InputManager:attach 调用适配器 attach,update 转发 dt',()=>{
  const mgr=new InputManager({});
  const log=[];
  const adapter={
    attach(){log.push('attach');},
    update(dt){log.push(dt);},
    detach(){log.push('detach');},
  };
  mgr.attach(adapter);
  mgr.update(.016);
  mgr.detachAll();
  assert.deepEqual(log,['attach',.016,'detach']);
});

test('KeyboardMouseAdapter:构造不触碰 DOM,detach 可重复调用',()=>{
  const a=new KeyboardMouseAdapter({});
  assert.doesNotThrow(()=>a.detach());
  assert.equal(a._handlers.length,0);
});
