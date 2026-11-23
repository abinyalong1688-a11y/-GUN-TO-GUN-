// save.test.mjs — save v2 / daily challenges (regression for the third-round blockers):
//   · dirty daily.progress (null / strings / negatives) must not crash award()
//   · headshot progress is serialized and the daily challenge is reachable
//   · XP / level / stats invariants survive dirty input
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SaveSystem} from '../src/save.js';

const KEY='o07_save_v2';
const today=()=>new Date().toISOString().slice(0,10);

function fakeLS(init={}){
  const map=new Map(Object.entries(init));
  return {
    getItem:k=>map.has(k)?map.get(k):null,
    setItem:(k,v)=>map.set(k,String(v)),
    removeItem:k=>map.delete(k),
    clear:()=>map.clear(),
  };
}

test('daily progress: headshots are awarded and serialized',()=>{
  globalThis.localStorage=fakeLS();
  const s=new SaveSystem();
  s.award({kills:2,wave:3,headshots:4,score:100,time:10,opId:'frost'});
  assert.equal(s.data.daily.progress.headshots,4);
  const reloaded=new SaveSystem();
  assert.equal(reloaded.data.daily.progress.headshots,4);
  assert.equal(reloaded.data.daily.progress.kills,2);
  assert.equal(reloaded.data.daily.progress.wave,3);
});

test('daily challenge is reachable: meeting all three goals sets done',()=>{
  globalThis.localStorage=fakeLS();
  const s=new SaveSystem();
  const goals=s.dailyGoals();
  assert.equal(goals.length,3);
  s.data.daily.progress={kills:goals[0].n-1,wave:goals[1].n-1,headshots:goals[2].n-1};
  s.data.daily.done=false;
  s.award({kills:1,wave:goals[1].n,headshots:1,score:0,time:0,opId:'frost'});
  assert.equal(s.data.daily.done,true,'completing all goals should mark the daily done');
});

test('dirty daily.progress: null / strings / negatives are rebuilt and never crash award()',()=>{
  const dirty=[
    null,
    'broken',
    {kills:'x',wave:-5,headshots:0},
    {kills:0,wave:NaN,headshots:Infinity},
  ];
  for(const progress of dirty){
    globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({v:2,daily:{date:today(),progress,done:false}})});
    const s=new SaveSystem();
    assert.doesNotThrow(()=>s.award({kills:2,wave:1,headshots:1,score:10,time:5,opId:'frost'}),'progress='+JSON.stringify(progress));
    assert.equal(s.data.daily.progress.kills,2,'dirty progress should be rebuilt before adding kills');
    assert.equal(s.data.daily.progress.headshots,1);
    assert.ok(Number.isFinite(s.data.daily.progress.wave)&&s.data.daily.progress.wave>=1);
  }
});

test('dirty daily record type: a non-object daily field falls back to today',()=>{
  globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({v:2,daily:'nope'})});
  const s=new SaveSystem();
  assert.equal(s.data.daily.date,today());
  assert.doesNotThrow(()=>s.award({kills:1}));
});

test('invariants: dirty operator/stats values clamp to level>=1, xp>=0, stats>=0',()=>{
  globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({
    v:2,
    operators:{frost:{level:-5,xp:-100,camo:'x'}},
    stats:{bestScore:-1,bestWave:-2,kills:-3,playtime:-4},
    daily:{date:today(),progress:{kills:0,wave:0,headshots:0},done:false},
  })});
  const s=new SaveSystem();
  assert.equal(s.data.operators.frost.level,1);
  assert.equal(s.data.operators.frost.xp,0);
  assert.deepEqual(s.data.stats,{bestScore:0,bestWave:0,kills:0,playtime:0});
});
