// netRoom.test.mjs — pure Durable-Object room state machine (no Cloudflare dependency)
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../server/room.js';
import {LIMITS,ROOM_CODE_RE,sanitizeName,BOT_ID,BOT_OP,modeLimits} from '../src/netProtocol.js';

const NOW=1_700_000_000_000;
const room=()=>R.createRoom('ABC23',NOW);
const add=(s,id,name='P',team)=>{
  const r=R.join(s,{id,name,op:'frost',camo:'default'},NOW);
  if(team)R.setSide(s,id,team);
  return r;
};
const fill=(s,n)=>{for(let i=0;i<n;i++)add(s,'h'+i,'P'+i);};

test('room code alphabet excludes ambiguous glyphs',()=>{
  assert.ok(ROOM_CODE_RE.test('ABC23'));
  assert.ok(!ROOM_CODE_RE.test('AB0OI'));
  assert.ok(!ROOM_CODE_RE.test('abcde'));
  assert.ok(!ROOM_CODE_RE.test('ABC2'));
});

test('sanitizeName strips control chars / angle brackets and folds whitespace',()=>{
  assert.equal(sanitizeName('  <b>x</b>\n y  '),'bx/b y'); // slashes survive; angle brackets / control chars do not
  assert.equal(sanitizeName('a\u0000b'),'ab');
  assert.equal(sanitizeName('a'.repeat(50)).length,LIMITS.nameMax);
  assert.equal(sanitizeName(null),'');
});

test('join: auto-balance, unique names, reconnect, 5-per-team and 10-human caps',()=>{
  const s=room();
  assert.equal(add(s,'a','Alex').team,'A');
  assert.equal(add(s,'b','Alex').team,'B');        // auto-balance to the smaller team
  assert.equal(s.humans.b.name,'Alex 2');          // duplicate names are disambiguated
  assert.equal(s.hostId,'a');                      // first joiner is host
  const again=R.join(s,{id:'a',name:'Other'},NOW+1);
  assert.ok(again.ok&&again.reconnect);
  assert.equal(s.humans.a.name,'Alex');            // reconnect keeps the old seat
  fill(s,8);
  assert.equal(Object.keys(s.humans).length,10);
  assert.equal(R.join(s,{id:'overflow'},NOW).err,'full');
  // A full team is auto-balanced away from, and manual switching into it is rejected
  const t=room();fill(t,5);
  for(const id of Object.keys(t.humans))R.setSide(t,id,'A');
  const sixth=R.join(t,{id:'six'},NOW);
  assert.equal(sixth.team,'B');
  assert.equal(R.setSide(t,'six','A').err,'teamFull');
});

test('setSide / setReady obey the 5-per-team cap and lock after start',()=>{
  const s=room();fill(s,3);
  for(const id of Object.keys(s.humans))R.setSide(s,id,'A');
  assert.equal(R.setSide(s,'h0','B').ok,true);
  assert.equal(R.setSide(s,'ghost','B').err,'unknown');
  assert.equal(R.setSide(s,'h0','Z').err,'badTeam');
  assert.equal(R.setReady(s,'h0',1).ok,true);
  assert.equal(s.humans.h0.ready,true);
  R.start(s,NOW,{map:'snow'});
  assert.equal(R.setSide(s,'h0','A').err,'locked');
  assert.equal(R.setReady(s,'h0',0).err,'locked');
});

test('start: 3 s countdown, score reset, AI fills both teams to 5 with operator ids',()=>{
  const s=room();add(s,'a','A');add(s,'b','B');
  const r=R.start(s,NOW,{map:'snowtown'});
  assert.ok(r.ok);
  assert.equal(s.phase,'live');assert.equal(s.map,'snowtown');
  assert.equal(s.startAt,NOW+3000);assert.equal(s.left,LIMITS.duration);
  assert.deepEqual(s.score,{A:0,B:0});
  assert.equal(s.bots.length,8);
  assert.equal(s.bots.filter(b=>b.team==='A').length,4);
  assert.equal(s.bots.filter(b=>b.team==='B').length,4);
  assert.ok(s.bots.every(b=>b.op===BOT_OP[b.team]));
  assert.ok(s.bots.some(b=>b.id===BOT_ID('A',1)));
  assert.equal(R.start(s,NOW).err,'alreadyLive');
});

test('recordKill: team scoring, win threshold, monotonic seq de-dup, bot kills',()=>{
  const s=room();add(s,'a','A');add(s,'b','B');
  R.start(s,NOW);
  let r=R.recordKill(s,{killerId:'a',victimId:'b',killerName:'A',victimName:'B',weapon:'ak47',seq:1});
  assert.deepEqual(r.score,{A:1,B:0});
  assert.equal(R.recordKill(s,{killerId:'a',victimId:'b',seq:1}).err,'duplicate');
  r=R.recordKill(s,{killerId:'b',victimId:'a',seq:1});
  assert.deepEqual(r.score,{A:1,B:1});
  // A human killing an opposing bot scores for the killer's team (bA1 is team A, 'b' is team B)
  r=R.recordKill(s,{killerId:'b',victimId:'bA1',seq:2});
  assert.equal(r.score.B,2);
  // 25 kills ends the match
  for(let i=0;i<22;i++)R.recordKill(s,{killerId:'b',victimId:'bA1',seq:3+i});
  r=R.recordKill(s,{killerId:'b',victimId:'bA1',seq:100});
  assert.equal(r.end,'B');
  assert.equal(s.score.B,LIMITS.winKills);
  assert.equal(R.recordKill(s,{seq:0}).err,'unknown');
});

test('recordKill: a bot killing an opponent scores for the bot own team',()=>{
  const s=room();add(s,'a','A');add(s,'b','B');
  R.start(s,NOW);
  const botA=s.bots.find(x=>x.team==='A');
  const r=R.recordKill(s,{killerId:botA.id,victimId:'b',killerName:botA.name,victimName:'B',weapon:'ak47',seq:1});
  assert.deepEqual(r.score,{A:1,B:0});
});

test('recordKill: team-kills and unknown victims never score',()=>{
  const s=room();add(s,'a','A');add(s,'b','B');
  R.start(s,NOW);
  const ownBot=s.bots.find(x=>x.team==='A');
  let r=R.recordKill(s,{killerId:'a',victimId:ownBot.id,seq:1});
  assert.deepEqual(r.score,{A:0,B:0},'killing your own bot is a team kill');
  r=R.recordKill(s,{killerId:'a',victimId:'nobody',seq:2});
  assert.deepEqual(r.score,{A:0,B:0},'an unknown victim cannot score');
  const otherBot=s.bots.find(x=>x.team==='A');
  r=R.recordKill(s,{killerId:'b',victimId:otherBot.id,seq:3});
  assert.deepEqual(r.score,{A:0,B:1},'an opposing bot still scores normally');
});

test('tick: countdown stays full, then drains, then ends on time',()=>{
  const s=room();add(s,'a','A');R.start(s,NOW);
  assert.equal(R.tick(s,NOW+1500).left,LIMITS.duration);       // still counting down
  const mid=R.tick(s,NOW+3000+30000);
  assert.ok(Math.abs(mid.left-270)<.01,'left should be 270 s, got '+mid.left);
  const end=R.tick(s,NOW+3000+301000);
  assert.equal(end.end,'time');assert.equal(s.phase,'over');
});

test('promoteHost picks the next connected joiner in order, or clears it',()=>{
  const s=room();add(s,'a','A');add(s,'b','B');add(s,'c','C');
  assert.equal(s.hostId,'a');
  assert.equal(R.promoteHost(s),'b');
  s.humans.a.connected=false; s.humans.b.connected=false; // both the old and the current host dropped
  assert.equal(R.promoteHost(s),'c');
  s.humans.c.connected=false;
  assert.equal(R.promoteHost(s),null);
});

test('toJSON / fromJSON round-trips the full room state',()=>{
  const s=room();fill(s,2);R.start(s,NOW);R.setReady(s,'h0',1);
  const clone=R.fromJSON(R.toJSON(s));
  assert.deepEqual(clone,s);
});

/* ---------------- per-mode rooms (koth 3v3 / dm 5v5) ---------------- */
const withMode=(mode)=>{const s=room();add(s,'h','Host');R.setMode(s,mode);return s;};

test('setMode: only before anyone else joins, and it drives team size / duration / win target',()=>{
  const s=room();add(s,'h','Host');
  assert.equal(R.setMode(s,'koth').ok,true);
  assert.equal(s.teamSize,3);
  assert.equal(s.winKills,modeLimits('koth').winKills);
  assert.equal(s.duration,240);
  assert.equal(R.setMode(s,'nope').err,'badMode');
  assert.equal(R.setMode(s,'waves').err,'badMode','waves is single-player only now');
  add(s,'g','Guest');
  assert.equal(R.setMode(s,'dm').err,'locked','a second player freezes the mode');
});

test('koth: 6 seats, kills do not move the score, capture ticks do',()=>{
  const s=withMode('koth');
  for(let i=0;i<5;i++)R.join(s,{id:'p'+i,name:'P'+i},NOW);
  assert.equal(R.join(s,{id:'over'},NOW).err,'full');
  R.start(s,NOW,{});
  const r=R.recordKill(s,{killerId:'h',victimId:'bB1',seq:1});
  assert.deepEqual(r.score,{A:0,B:0},'kills are only K/D in koth');
  // one tick = one second of holding the hill (KOTH_RATE in modes.js); the target is the mode's winKills
  const target=s.winKills;
  assert.equal(target,200,'King of the Hill is first to 200 capture points');
  for(let i=0;i<target-2;i++)R.addPoint(s,'A');
  assert.equal(s.score.A,target-2);
  assert.equal(R.addPoint(s,'A').end,null,'one short of the target the match runs on');
  assert.equal(s.score.A,target-1);
  const end=R.addPoint(s,'A');
  assert.equal(end.end,'A',target+' point ticks end the match');
});

test('dm: 10 seats, first to 25 kills, bots fill the remainder',()=>{
  const s=withMode('dm');
  for(let i=0;i<9;i++)R.join(s,{id:'p'+i,name:'P'+i},NOW);
  assert.equal(R.join(s,{id:'over'},NOW).err,'full');
  R.start(s,NOW,{});
  assert.equal(s.bots.length,0,'10 humans fill both teams');
  const bot=withMode('dm');
  R.start(bot,NOW,{});
  assert.equal(bot.bots.length,9,'a solo host gets 9 bots (5+5 minus its own seat)');
});

/* Regression: capacity used to count every seat ever created, so a room that had seen 10
   different visitors was permanently "full". Disconnected seats must be pruned after the
   grace window (the DO calls pruneGone() from its alarm and from join()). */
test('seats left disconnected past the grace window are reclaimed (room never fills up for good)',()=>{
  const s=room();
  for(let i=0;i<10;i++)R.join(s,{id:'v'+i,name:'V'+i},NOW+i);
  assert.equal(R.join(s,{id:'new'},NOW).err,'full','live room is full');
  // everyone leaves
  for(const id of Object.keys(s.humans)){s.humans[id].connected=false;s.humans[id].disconnectedAt=NOW;}
  assert.equal(R.join(s,{id:'new'},NOW+59_000).err,'full','within the grace window the seats are still held');
  assert.equal(R.join(s,{id:'new'},NOW+61_000).team,'A','after the grace window a newcomer gets in');
  assert.equal(Object.keys(s.humans).length,1,'pruned down to the newcomer only');
});

test('join() prunes stale seats by itself, no alarm needed',()=>{
  const s=room();
  for(let i=0;i<10;i++)R.join(s,{id:'v'+i,name:'V'+i},NOW+i);
  for(const id of Object.keys(s.humans)){s.humans[id].connected=false;s.humans[id].disconnectedAt=NOW-61_000;}
  assert.ok(R.join(s,{id:'new'},NOW).ok,'a stale-full room accepts the newcomer directly');
});
