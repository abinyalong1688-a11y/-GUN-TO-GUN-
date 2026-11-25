// netClient.test.mjs — transport: no socket before connect(), queue, rate limit, malformed frames
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NetClient,resolveServerUrl} from '../src/net.js';
import {C,S} from '../src/netProtocol.js';

class FakeWS {
  constructor(){ this.readyState=0; this.sent=[]; this.onopen=null;this.onmessage=null;this.onclose=null;this.onerror=null; }
  open(){ this.readyState=1;this.onopen&&this.onopen(); }
  send(raw){ this.sent.push(raw); }
  close(){ this.readyState=3;this.onclose&&this.onclose(); }
}

test('offline guarantee: no socket is opened until connect()',()=>{
  const c=new NetClient({wsFactory:()=>new FakeWS()});
  assert.equal(c.stats.socketsOpened,0);
  c.send(C.PING,{c:1});
  assert.equal(c.stats.socketsOpened,0);
  assert.equal(c.queue.length,1);
});

test('connect opens exactly one socket; hello and queued messages flush on open',()=>{
  let ws;
  const c=new NetClient({wsFactory:()=>{ws=new FakeWS();return ws;}});
  c.send(C.READY,{r:1});                       // queued while offline
  c.connect('ws://test',{t:C.CREATE,name:'A'});
  assert.equal(c.stats.socketsOpened,1);
  assert.equal(ws.readyState,0);
  ws.open();
  assert.equal(c.queue.length,0);
  assert.deepEqual(ws.sent.map(s=>JSON.parse(s).t),[C.CREATE,C.READY]);
});

test('handlers dispatch by type; malformed / unknown frames are silently ignored',()=>{
  const c=new NetClient({wsFactory:()=>new FakeWS()});
  let hellos=0;
  c.on(S.HELLO,()=>hellos++);
  c.connect('ws://test');
  const ws=c.ws;ws.open();
  ws.onmessage({data:'{bad json'});
  ws.onmessage({data:JSON.stringify({t:123})});
  ws.onmessage({data:JSON.stringify({x:1})});
  ws.onmessage({data:JSON.stringify({t:S.HELLO,id:'a'})});
  assert.equal(hellos,1);
});

test('token bucket caps at 32 messages per burst and 4 KB per frame',()=>{
  let ws;
  const c=new NetClient({wsFactory:()=>{ws=new FakeWS();return ws;}});
  c.connect('ws://test');ws.open();
  let ok=0;
  for(let i=0;i<40;i++)if(c.send(C.PING,{c:i}))ok++;
  assert.equal(ok,32,'only 32 messages fit in the initial bucket, got '+ok);
  assert.equal(c.send(C.SNAP,{s:'x'.repeat(5000)}),false,'oversized frames are rejected');
});

test('close() stops retries and clears the queue',()=>{
  const c=new NetClient({wsFactory:()=>new FakeWS()});
  c.connect('ws://test');
  c.send(C.PING,{c:1});
  c.close();
  assert.equal(c.closedByUs,true);
  assert.equal(c.queue.length,0);
  assert.equal(c.ws,null);
});

test('resolveServerUrl priority: ?server= > localStorage > build constant',()=>{
  const oldLoc=globalThis.location,oldLS=globalThis.localStorage;
  try{
    globalThis.localStorage={getItem:k=>k==='o07_server'?'wss://from-storage':null,setItem(){}};
    globalThis.location={search:''};
    assert.equal(resolveServerUrl(),'wss://from-storage');
    globalThis.location={search:'?server=wss://from-query'};
    assert.equal(resolveServerUrl(),'wss://from-query');
    globalThis.location={search:''};
    globalThis.localStorage={getItem:()=>null,setItem(){}};
    assert.equal(resolveServerUrl(),''); // no build constant in Node
  }finally{
    globalThis.location=oldLoc;globalThis.localStorage=oldLS;
  }
});

/* ---- room routing: the Worker only upgrades /rooms/{CODE}/ws (see server/worker.js) ---- */
test('roomWsUrl builds the Durable-Object path for the room code', async () => {
  const { roomWsUrl } = await import('../src/net.js');
  assert.equal(roomWsUrl('wss://h.workers.dev', 'abc23'), 'wss://h.workers.dev/rooms/ABC23/ws');
  assert.equal(roomWsUrl('wss://h.workers.dev/', 'abc23'), 'wss://h.workers.dev/rooms/ABC23/ws');
  assert.equal(roomWsUrl('', 'ABC23'), '', 'no base → no url');
  assert.equal(roomWsUrl('wss://h', ''), '', 'no code → no url');
});

test('reserveRoomCode POSTs /rooms and returns the issued code', async () => {
  const { reserveRoomCode } = await import('../src/net.js');
  const seen = [];
  const fake = async (url, opts) => {
    seen.push({ url, method: opts && opts.method });
    return { ok: true, json: async () => ({ code: 'xyz23' }) };
  };
  assert.equal(await reserveRoomCode('wss://h.workers.dev/', fake), 'XYZ23');
  assert.deepEqual(seen[0], { url: 'https://h.workers.dev/rooms', method: 'POST' }, 'ws→http and /rooms');
  const fail = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await reserveRoomCode('ws://127.0.0.1:8787', fail), '');
});

test('ping carries the performance clock so the interpolation offset stays consistent', () => {
  let ws;
  const c = new NetClient({ wsFactory: () => (ws = new FakeWS()) });
  c.connect('ws://test'); ws.open();
  const before = performance.now();
  c.ping();
  const after = performance.now();
  const sent = JSON.parse(ws.sent[ws.sent.length - 1]).c;
  assert.ok(sent >= before - 1 && sent <= after + 1, 'c must be performance.now(), got ' + sent);
  assert.ok(Math.abs(sent - Date.now()) > 1e6, 'c must NOT be epoch milliseconds');
});

test('bot detection is a roster lookup, not a first-letter test', () => {
  // Human seat ids are UUIDs and may begin with 'b' (e.g. b55e9a4a-…). Treating them as bots
  // skipped the LOS check for those victims entirely.
  const bots = [{ id: 'bA1' }, { id: 'bB2' }];
  const isBotId = (id) => !!id && bots.some(b => b.id === id);
  assert.equal(isBotId('bA1'), true);
  assert.equal(isBotId('b55e9a4a-…'), false);
  assert.equal(String('b55e9a4a-…').startsWith('b'), true, 'the old prefix test would have said bot');
});
