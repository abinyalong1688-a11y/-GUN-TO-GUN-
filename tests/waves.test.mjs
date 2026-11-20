// waves.test.mjs — wave scheduler unit tests
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

test('wave composition grows with the wave number and uses the three drone classes',()=>{
  const w=new Waves(makeGame());
  const q1=w.composition(1);
  assert.ok(q1.every(t=>['WASP','REAPER','WARDEN'].includes(t)),'composition should only contain the three drone classes');
  const q1w=q1.filter(t=>t==='WASP').length;
  const q8=w.composition(8);
  const q8w=q8.filter(t=>t==='WASP').length;
  const q8r=q8.filter(t=>t==='REAPER').length;
  assert.ok(q8r>0,'REAPER should appear by wave 8');
  assert.ok(q8w>=q1w,'WASP count should not decrease');
  assert.ok(q8.length>q1.length,'total count should grow with the wave number');
});

test('state machine: intermission → active → cleared → intermission',()=>{
  const g=makeGame();
  const w=new Waves(g);
  w.reset();
  assert.equal(w.state,'intermission');
  w.update(2.0); // timer runs out, wave 1 starts
  assert.equal(w.state,'active');
  assert.equal(w.n,1);
  assert.ok(w.queue.length>0,'entering active should queue spawns');
});

test('remaining count = list + queue',()=>{
  const g=makeGame();
  g.enemies.list=[{},{},{}];
  const w=new Waves(g);
  w.queue=['WASP','WASP'];
  assert.equal(w.remaining(),5);
});
