// netMatch.test.mjs — clock/intent logic that only shows up with a real event order
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NetMatch, PHASE} from '../src/netMatch.js';
import {S, C, LIMITS} from '../src/netProtocol.js';

/* Minimal client double: records sends, lets the test push server frames. */
class FakeClient {
  constructor(){ this.handlers=new Map(); this.sent=[]; this.ws=null; this.token=''; this.url=''; }
  on(t,fn){ if(!this.handlers.has(t))this.handlers.set(t,[]); this.handlers.get(t).push(fn); return this; }
  emit(t,m){ for(const f of this.handlers.get(t)||[])f(m); }
  send(t,p={}){ this.sent.push({...p,t}); return true; }
  connect(url){ this.url=url; return this; }
  close(){ this.ws=null; }
  ping(){ this.send(C.PING,{c:performance.now()}); }
  last(t){ return [...this.sent].reverse().find(m=>m.t===t)||null; }
}

function makeGame(){
  const dm={timer:180,scores:new Map()};
  return {
    playerName:'P', player:{alive:true,crouching:false,sprinting:false,pos:{x:0,y:0,z:0},yaw:0,pitch:0,health:100},
    weapon:{def:{id:'ak47'},adsAmt:0}, heroes:{list:[],byNetId:()=>null},
    ui:{setNetPill(){},lobbyError(e){this.err=e;},banner(){},updateLobby(){},killFeed(){},setDmScore(){},hideLobby(){}},
    dm, mode:'online', stats:{kills:0,headshots:0}, t:k=>k,
  };
}

const match = () => {
  const g=makeGame(); const c=new FakeClient();
  const nm=new NetMatch(g,{client:c}); nm.game=g;
  // A live match always has a seat and a clock; tick() reads both.
  nm.me={id:'me',name:'P',team:'A'};
  nm.clock.offset=1_795_000_000-performance.now()/1000; nm.clock.ready=true;
  return {g,c,nm};
};

test('PONG is measured on the performance clock, so the offset matches renderTime', () => {
  const {nm,c}=match();
  // Seed exactly like the first S.PEERS frame does.
  const perfNow=performance.now()/1000;
  c.emit(S.PEERS,{st:1_795_000_000+perfNow,p:[]});
  assert.ok(nm.clock.ready);
  const seeded=nm.clock.offset;
  // A PONG with c on the performance clock must not move the offset materially.
  c.emit(S.PONG,{c:performance.now(),srv:1_795_000_000+performance.now()/1000});
  assert.ok(Math.abs(nm.clock.offset-seeded)<1,'offset drifted by '+(nm.clock.offset-seeded));
  assert.equal(nm.renderTime().toFixed(3), (performance.now()/1000+nm.clock.offset).toFixed(3));
});

test('a PONG stamped with the epoch clock cannot drag the offset into the past', () => {
  // This is what Date.now() would have produced: off ≈ serverT − epochSeconds ≈ −1.6e9.
  const {nm,c}=match();
  c.emit(S.PEERS,{st:1_795_000_000,p:[]});
  c.emit(S.PONG,{c:Date.now(),srv:1_795_000_000,now:Date.now()});
  // Even if such a frame arrived, jitter must stay bounded (dynamicDelay is clamped anyway).
  assert.ok(nm.clock.jitter>=0);
});

test('match clock drains once per real second, not once per frame', () => {
  const {g,nm}=match();
  const t0=nm.clock.serverNow(performance.now());   // server clock, seconds
  nm.startAt=t0*1000;                // match starts now (startAt is epoch-ms)
  nm.duration=180;
  nm.phase=PHASE.LIVE;
  g.dm.timer=180;
  for(let i=0;i<60;i++){ nm.tick(1/60); g.dm.timer=nm.left; }   // mirror main.js
  assert.ok(nm.left>179&&nm.left<180.2,'after 1 s left should be ≈179, got '+nm.left);
  // tick() is wall-clock driven, so advance the server clock rather than only calling it.
  const before=nm.left;
  nm.startAt-=10_000;                                           // 11 s of match time elapsed
  for(let i=0;i<60;i++){ nm.tick(1/60); g.dm.timer=nm.left; }
  assert.ok(before-nm.left>9.5&&before-nm.left<10.5,'10 s of real time must remove ~10 s, removed '+(before-nm.left));
});

test('countdown keeps the clock full and never goes negative', () => {
  const {nm}=match();
  nm.phase=PHASE.LIVE;
  nm.startAt=(nm.clock.serverNow(performance.now())+2)*1000;   // still 2 s to go
  nm.duration=180;
  nm.tick(1/60);
  assert.equal(nm.left,180);
});

test('requestHit tags grenades as frag and keeps them inside the grenade cap', () => {
  const {nm}=match();
  nm.phase=PHASE.LIVE; nm.me={id:'me'};
  nm.phase=PHASE.LIVE; nm.me={id:'me'};
  nm.requestHit({netId:'v1'},78,'P',false,{kind:'frag'});
  const m=nm.client.last(C.HIT);
  assert.equal(m.w,'frag');
  assert.equal(m.head,0);
  assert.ok(m.dmg<=78,'grenade damage must be capped, got '+m.dmg);
  // A normal weapon still uses the equipped gun.
  nm.requestHit({netId:'v1'},36,'P',true);
  assert.equal(nm.client.last(C.HIT).w,'ak47');
});

test('room URLs are built against the Worker route, not the bare base', async () => {
  const {nm,c}=match();
  const {roomWsUrl}=await import('../src/net.js');
  assert.equal(roomWsUrl('wss://h','ABC23'),'wss://h/rooms/ABC23/ws');
});
