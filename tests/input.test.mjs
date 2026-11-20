// input.test.mjs — input abstraction (S1.5 acceptance):
//   InputManager attaches / updates / detaches adapters; the keyboard/mouse adapter is not attached under Node.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {InputManager,KeyboardMouseAdapter} from '../src/input.js';

test('InputManager: attach calls adapter attach, update forwards dt',()=>{
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

test('KeyboardMouseAdapter: constructor does not touch the DOM, detach is idempotent',()=>{
  const a=new KeyboardMouseAdapter({});
  assert.doesNotThrow(()=>a.detach());
  assert.equal(a._handlers.length,0);
});
