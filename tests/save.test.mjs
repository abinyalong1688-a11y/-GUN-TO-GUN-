// save.test.mjs — save v2 / daily challenges (regression for the third-round blockers
// and the fourth-round review follow-ups):
//   · dirty daily.progress (null / strings / negatives) must not crash award()
//   · headshot progress is serialized and the daily challenge is reachable
//   · waves and PvP each have a complete, reachable daily goal set
//   · a session crossing UTC midnight starts a fresh daily
//   · XP / level / stats invariants survive dirty input
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SaveSystem} from '../src/save.js';

const KEY='o07_save_v2';
const DAY='2026-11-24';
const NEXT_DAY='2026-11-25';
const FIXED=Date.parse(DAY+'T12:00:00Z');
const fixed=()=>FIXED;

function fakeLS(init={}){
  const map=new Map(Object.entries(init));
  return {
    getItem:k=>map.has(k)?map.get(k):null,
    setItem:(k,v)=>map.set(k,String(v)),
    removeItem:k=>map.delete(k),
    clear:()=>map.clear(),
  };
}
const mk=()=>new SaveSystem(fixed);

test('daily progress: headshots are awarded and serialized',()=>{
  globalThis.localStorage=fakeLS();
  const s=mk();
  s.award({kills:2,wave:3,headshots:4,score:100,time:10,opId:'frost'});
  assert.equal(s.data.daily.progress.headshots,4);
  const reloaded=mk();
  assert.equal(reloaded.data.daily.progress.headshots,4);
  assert.equal(reloaded.data.daily.progress.kills,2);
  assert.equal(reloaded.data.daily.progress.wave,3);
});

test('daily challenge is reachable: waves goals (kills / wave / headshots)',()=>{
  globalThis.localStorage=fakeLS();
  const s=mk();
  const goals=s.dailyGoals('waves');
  assert.equal(goals.length,3);
  s.data.daily.progress={kills:goals[0].n-1,wave:goals[1].n-1,headshots:goals[2].n-1,score:0};
  s.data.daily.done=false;
  s.award({kills:1,wave:goals[1].n,headshots:1,score:0,time:0,opId:'frost'});
  assert.equal(s.data.daily.done,true,'completing the waves goals should mark the daily done');
});

test('daily challenge is reachable: PvP goals (kills / best score / headshots)',()=>{
  globalThis.localStorage=fakeLS();
  const s=mk();
  const goals=s.dailyGoals('pvp');
  assert.equal(goals.length,3);
  assert.equal(goals[1].id,'score','PvP has no wave counter; its third goal is the best match score');
  s.data.daily.progress={kills:goals[0].n-1,wave:0,headshots:goals[2].n-1,score:goals[1].n-1};
  s.data.daily.done=false;
  s.award({kills:1,wave:0,headshots:1,score:goals[1].n,time:0,opId:'frost'});
  assert.equal(s.data.daily.progress.score,goals[1].n,'the best PvP score should persist');
  assert.equal(s.data.daily.done,true,'completing the PvP goals should mark the daily done');
});

test('dirty daily.progress: null / strings / negatives are rebuilt and never crash award()',()=>{
  const dirty=[
    null,
    'broken',
    {kills:'x',wave:-5,headshots:0},
    {kills:0,wave:NaN,headshots:Infinity},
  ];
  for(const progress of dirty){
    globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({v:2,daily:{date:DAY,progress,done:false}})});
    const s=mk();
    assert.doesNotThrow(()=>s.award({kills:2,wave:1,headshots:1,score:10,time:5,opId:'frost'}),'progress='+JSON.stringify(progress));
    assert.equal(s.data.daily.progress.kills,2,'dirty progress should be rebuilt before adding kills');
    assert.equal(s.data.daily.progress.headshots,1);
    assert.ok(Number.isFinite(s.data.daily.progress.wave)&&s.data.daily.progress.wave>=1);
    assert.ok(Number.isInteger(s.data.daily.progress.score)&&s.data.daily.progress.score>=0);
  }
});

test('dirty daily record type: a non-object daily field falls back to today',()=>{
  globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({v:2,daily:'nope'})});
  const s=mk();
  assert.equal(s.data.daily.date,DAY);
  assert.doesNotThrow(()=>s.award({kills:1}));
});

test('cross-midnight: the first match after UTC midnight starts a fresh daily',()=>{
  globalThis.localStorage=fakeLS();
  let now=Date.parse(DAY+'T23:59:30Z');
  const s=new SaveSystem(()=>now);
  s.award({kills:2,wave:1,headshots:1,score:100,time:10,opId:'frost'});
  assert.equal(s.data.daily.date,DAY);
  assert.equal(s.data.daily.progress.kills,2);
  now=Date.parse(NEXT_DAY+'T00:01:30Z');
  s.award({kills:1,wave:0,headshots:1,score:50,time:5,opId:'frost'});
  assert.equal(s.data.daily.date,NEXT_DAY);
  assert.equal(s.data.daily.progress.kills,1,'the new day starts at zero');
  assert.equal(s.data.daily.progress.wave,0);
  assert.equal(s.data.daily.progress.headshots,1);
  assert.equal(s.data.daily.progress.score,50);
  assert.equal(s.data.daily.done,false);
});

test('invariants: dirty operator/stats values clamp to level>=1, xp>=0, stats>=0',()=>{
  globalThis.localStorage=fakeLS({[KEY]:JSON.stringify({
    v:2,
    operators:{frost:{level:-5,xp:-100,camo:'x'}},
    stats:{bestScore:-1,bestWave:-2,kills:-3,playtime:-4},
    daily:{date:DAY,progress:{kills:0,wave:0,headshots:0},done:false},
  })});
  const s=mk();
  assert.equal(s.data.operators.frost.level,1);
  assert.equal(s.data.operators.frost.xp,0);
  assert.deepEqual(s.data.stats,{bestScore:0,bestWave:0,kills:0,playtime:0});
});
