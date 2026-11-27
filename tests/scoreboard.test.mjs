// scoreboard.test.mjs — the TAB board's data source.
//
// The board reads `game.dm.scores` (a Map keyed by display name, each row carrying the roster
// `id` that online s:kill frames are matched against). These tests pin the bugs that made rows
// go missing or show stale/duplicate data in online matches.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NetMatch, PHASE} from '../src/netMatch.js';
import {S} from '../src/netProtocol.js';

class FakeClient {
  constructor(){ this.handlers=new Map(); this.sent=[]; }
  on(t,fn){ if(!this.handlers.has(t))this.handlers.set(t,[]); this.handlers.get(t).push(fn); return this; }
  emit(t,m){ for(const f of this.handlers.get(t)||[])f(m); }
  send(){ return true; }
  connect(){ return this; }
  close(){}
  ping(){}
}

function makeGame(){
  const dm={timer:180,scores:new Map()};
  return {
    playerName:'P', player:{alive:true,crouching:false,sprinting:false,pos:{x:0,y:0,z:0},yaw:0,pitch:0,health:100},
    weapon:{def:{id:'ak47'},adsAmt:0}, heroes:{list:[],byNetId:()=>null},
    ui:{setNetPill(){},lobbyError(){},banner(){},updateLobby(){},killFeed(){},setDmScore(){},hideLobby(){}},
    dm, mode:'dm', stats:{kills:0,headshots:0}, t:k=>k,
  };
}

const match = () => {
  const g=makeGame(); const c=new FakeClient();
  const nm=new NetMatch(g,{client:c}); nm.game=g;
  nm.me={id:'me',name:'P',team:'A'};
  nm.clock.offset=1_795_000_000-performance.now()/1000; nm.clock.ready=true;
  return {g,c,nm};
};

/* _syncScoreboard is called from S.ROOM during a live match. Calling it directly keeps this
   test free of the 3D avatar creation that S.ROOM also triggers. */
test('mid-match roster sync adds the joiner\'s row (g.mode is dm/koth, not "online")',()=>{
  const {g,nm}=match();
  nm.phase=PHASE.LIVE;
  g.mode='dm';                                  // startGame copies matchMode into g.mode
  g.dm.scores.set('P',{name:'P',id:'me',team:'A',kills:0,deaths:0,me:true});
  nm._syncScoreboard({roster:[{id:'me',name:'P',team:'A'},{id:'n1',name:'Newcomer',team:'B'}]});
  assert.ok(g.dm.scores.has('Newcomer'),
    'a player who joined mid-match must appear on the board');
  assert.equal(g.dm.scores.get('Newcomer').id,'n1');
});

test('a reconnect that changes the seat id keeps the accumulated K/D',()=>{
  const {g,nm}=match();
  nm.phase=PHASE.LIVE;
  g.mode='dm';
  g.dm.scores.set('P',{name:'P',id:'old-seat',team:'A',kills:7,deaths:2,me:true});
  nm._syncScoreboard({roster:[{id:'new-seat',name:'P',team:'A'}]});
  const row=g.dm.scores.get('P');
  assert.equal(row.id,'new-seat','the row must track the new seat id');
  assert.equal(row.kills,7,'reconnecting must not wipe the score');
  assert.equal(row.deaths,2);
});

test('an s:kill is credited to the right row by roster id',()=>{
  const {g,c,nm}=match();
  nm.phase=PHASE.LIVE;g.mode='dm';
  g.dm.scores.set('P',{name:'P',id:'me',team:'A',kills:0,deaths:0,me:true});
  g.dm.scores.set('Foe',{name:'Foe',id:'b1',team:'B',kills:0,deaths:0,me:false});
  c.emit(S.KILL,{killer:{id:'me',name:'P'},victim:{id:'b1',name:'Foe'},score:{A:1,B:0}});
  assert.equal(g.dm.scores.get('P').kills,1,'the killer gets the kill');
  assert.equal(g.dm.scores.get('Foe').deaths,1,'the victim gets the death');
});
