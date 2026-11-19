// waves.test.mjs —— 波次调度单元测试
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Waves} from '../src/waves.js';

function makeGame(){
  return {
    ui:{setRemain(){},setWave(){},banner(){}},
    enemies:{list:[]},
    addScore(){},banner(){},audio:{waveStart(){},supply(){}},
    weapon:{addReserve(){}},
    player:{heal(){}},
  };
}

test('波次构成:随波数增长且由三类敌机组成',()=>{
  const w=new Waves(makeGame());
  const q1=w.composition(1);
  assert.ok(q1.every(t=>['WASP','REAPER','WARDEN'].includes(t)),'构成应只含三类敌机');
  const q1w=q1.filter(t=>t==='WASP').length;
  const q8=w.composition(8);
  const q8w=q8.filter(t=>t==='WASP').length;
  const q8r=q8.filter(t=>t==='REAPER').length;
  assert.ok(q8r>0,'第 8 波应出现 REAPER');
  assert.ok(q8w>=q1w,'WASP 数量不应减少');
  assert.ok(q8.length>q1.length,'总数量应随波数增长');
});

test('状态机:intermission → active → 清空 → intermission',()=>{
  const g=makeGame();
  const w=new Waves(g);
  w.reset();
  assert.equal(w.state,'intermission');
  w.update(2.0); // 计时结束进入第 1 波
  assert.equal(w.state,'active');
  assert.equal(w.n,1);
  assert.ok(w.queue.length>0,'进入 active 后应排队出怪');
});

test('剩余数量=list+queue',()=>{
  const g=makeGame();
  g.enemies.list=[{},{},{}];
  const w=new Waves(g);
  w.queue=['WASP','WASP'];
  assert.equal(w.remaining(),5);
});
