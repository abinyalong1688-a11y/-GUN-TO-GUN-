// net.js — transport layer. No socket is opened until connect() is called, so offline play
// keeps net.stats.socketsOpened === 0 (hard constraint of the online feature).
import { C, S, PROTO, LIMITS, RATES, HIT_DMG_CAP, isValidMsg, BOT_OP, BOT_ID, isMode, modeLimits } from './netProtocol.js';
import { store } from './util.js';

/* Address priority: ?server= (dev only) > localStorage (dev only) > build constant > ''.
   Production builds force wss:// so a crafted link cannot hijack the session. */
const NET_DEBUG=typeof DEBUG_HOOKS!=='undefined'?DEBUG_HOOKS:true;
function safeServerUrl(u){
  if(!u)return '';
  if(/^wss:\/\//i.test(u))return u;
  if(NET_DEBUG&&/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(u))return u;
  return '';
}
export function resolveServerUrl() {
  try {
    const q = NET_DEBUG ? new URLSearchParams(location.search).get('server') : null;
    if (q) return safeServerUrl(q);
  } catch (e) {}
  const ls = NET_DEBUG ? store.get('o07_server') : '';
  if (ls) return safeServerUrl(ls);
  return safeServerUrl(typeof __GTG_SERVER__ === 'string' ? __GTG_SERVER__ : '');
}
export const serverConfigured = () => !!resolveServerUrl();

/* The Worker only accepts WebSockets on /rooms/{CODE}/ws (one Durable Object per room).
   Connecting to the bare base URL gets a 404, which is why the room code must be known
   *before* the socket is opened: create → POST /rooms first, join → the code is typed in. */
export function roomWsUrl(base, code) {
  const c = String(code || '').toUpperCase();
  if (!base || !c) return '';
  return `${base.replace(/\/+$/, '')}/rooms/${c}/ws`;
}

/* Reserve a fresh room code (POST /rooms) and return it, or '' on failure. */
export async function reserveRoomCode(base, fetchImpl = fetch) {
  if (!base) return '';
  const http = base.replace(/^ws(s?):\/\//i, 'http$1://').replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${http}/rooms`, { method: 'POST' });
    if (!res.ok) return '';
    const body = await res.json();
    return typeof body.code === 'string' ? body.code.toUpperCase() : '';
  } catch (e) {
    return '';
  }
}

const RETRY = [0.5, 1, 2, 4, 8];
const CRITICAL_TYPES = new Set([C.HELLO, C.CREATE, C.JOIN, C.HIT, C.DIED, C.BOT_DEATH, C.READY, C.START]);

export class NetClient {
  constructor({ wsFactory } = {}) {
    this.wsFactory = wsFactory || (u => new WebSocket(u));
    this.ws = null; this.queue = []; this.handlers = new Map();
    this.token = ''; this.hello = null; this.attempt = 0; this.closedByUs = false;
    this.stats = { socketsOpened:0, bytesIn:0, bytesOut:0, rtt:0 };
    this._tokens = LIMITS.msgPerSec; this._refill = 0;
    this.url = ''; this._retryTimer = null;
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }
  _emit(type, data) {
    const l = this.handlers.get(type);
    if (l) for (const f of l) try { f(data); } catch (e) { console.warn('[net] handler', type, e); }
  }

  connect(url, hello) {
    this.url = url; this.hello = hello || null; this.closedByUs = false;
    return this._open();
  }
  _open() {
    this.stats.socketsOpened++;                       // offline assertion: stays 0 without connect()
    let ws;
    try { ws = this.wsFactory(this.url); } catch (e) { this._scheduleRetry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      if (this.hello) this.send(this.hello.t, this.hello);
      while (this.queue.length) {
        const m = this.queue.shift();
        this.send(m.t, m);
      }
      this._emit('open');
    };
    ws.onmessage = e => {
      const raw = typeof e.data === 'string' ? e.data : '';
      this.stats.bytesIn += raw.length;
      let m; try { m = JSON.parse(raw); } catch (err) { return; }   // malformed frame: silent drop
      if (!isValidMsg(m)) return;
      this._emit(m.t, m);
    };
    ws.onclose = () => {
      this.ws = null;
      this._emit('close');
      if (!this.closedByUs) this._scheduleRetry();
    };
    ws.onerror = () => {};
    return ws;
  }
  _scheduleRetry() {
    if (this._retryTimer) return;
    const base = RETRY[Math.min(this.attempt++, RETRY.length - 1)];
    const d = base * (0.8 + Math.random() * 0.4);   // jitter avoids reconnect storms
    this._emit('reconnecting', { in:d, attempt:this.attempt });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (!this.closedByUs) this._open();
    }, d * 1000);
  }
  _allow(bytes, critical = false) {
    const now = performance.now();
    this._tokens = Math.min(LIMITS.msgPerSec, this._tokens + (now - this._refill) / 1000 * LIMITS.msgPerSec);
    this._refill = now;
    if (bytes > LIMITS.bytesPerMsg) return false;
    if (critical) return true;                  // hit/death/join frames must not be dropped by SNAP traffic
    if (this._tokens < 1) return false;
    this._tokens -= 1; return true;
  }
  send(type, payload = {}) {
    const msg = { ...payload, t:type };
    if (this.ws && this.ws.readyState === 1) {
      const raw = JSON.stringify(msg);
      const critical = CRITICAL_TYPES.has(type);
      if (!this._allow(raw.length, critical)) return false;
      this.stats.bytesOut += raw.length;
      try { this.ws.send(raw); return true; } catch (e) { return false; }
    }
    if (this.queue.length < LIMITS.queueMax) this.queue.push(msg);
    return false;
  }
  /* Ping carries the *performance* clock: interp.js compares it with performance.now() when it
     computes the server offset (offset = serverT − performance.now()/1000). Using Date.now()
     here made the offset collapse towards −epoch-seconds on the first PONG. */
  ping() { this.send(C.PING, { c:performance.now() }); }
  close() {
    this.closedByUs = true;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this.queue.length = 0;
    try { this.ws && this.ws.close(); } catch (e) {}
    this.ws = null;
  }
}

/* ------------------------------------------------------------------ *
 * Loopback: an in-memory WebSocket pair + a tiny room server that mirrors the
 * Worker's message flow. `?net=loopback` and the e2e suite use it to drive the
 * full lobby → match → result flow with no server and no second Game instance.
 * ------------------------------------------------------------------ */
const LOOP_CODE='LOOP1';
class LoopbackRoom {
  constructor() {
    this.code=LOOP_CODE; this.hostId=null; this.order=[];
    this.humans=new Map(); this.bots=[]; this.phase='lobby';
    this.map='desert'; this.score={A:0,B:0}; this.seq=0;
    this.startAt=0; this.duration=LIMITS.duration;
  }
  get roster(){
    return [...this.humans.values()].map(h=>({
      id:h.id,name:h.name,op:h.op,camo:h.camo,team:h.team,
      ready:h.ready,host:h.id===this.hostId,connected:h.connected,
    }));
  }
  count(team){ return [...this.humans.values()].filter(h=>h.team===team).length; }
  nameOf(id){
    if(this.humans.has(id))return this.humans.get(id).name;
    const b=this.bots.find(x=>x.id===id);
    return b?b.name:'BOT';
  }
}

export class LoopbackTransport {
  constructor() {
    this.room=new LoopbackRoom();
    this.sockets=new Set();
    this._seq=0;
  }
  attach(serverImpl) { if (serverImpl) this.room=serverImpl; return this.room; }
  nameOf(id){ return this.room.nameOf(id); }
  createClient() {
    const c=new NetClient({ wsFactory:()=>this._fakeSocket() });
    return c;
  }
  _fakeSocket() {
    const self=this;
    const sock={
      readyState:0, onopen:null, onmessage:null, onclose:null, onerror:null,
      send(raw){
        if(sock.readyState!==1)return;
        let m;try{m=JSON.parse(raw);}catch(e){return;}
        if(isValidMsg(m))self._handle(sock,m);
      },
      close(){
        if(sock.readyState===3)return;
        sock.readyState=3;self.sockets.delete(sock);
        if(sock.id)self._drop(sock.id);
        try{sock.onclose&&sock.onclose();}catch(e){}
      },
    };
    this.sockets.add(sock);
    setTimeout(()=>{
      if(sock.readyState!==0)return;
      sock.readyState=1;
      sock.id='u'+(++this._seq);
      try{sock.onopen&&sock.onopen();}catch(e){}
    },0);
    return sock;
  }
  _send(sock,msg){ try{sock.onmessage&&sock.onmessage({data:JSON.stringify(msg)});}catch(e){} }
  _broadcast(msg,exceptId){
    const raw=msg;
    for(const s of this.sockets)if(s.readyState===1&&s.id!==exceptId)this._send(s,raw);
  }
  _roomMsg(){
    const r=this.room;
    this._broadcast({t:S.ROOM,code:r.code,hostId:r.hostId,phase:r.phase,map:r.map,
      sizes:{A:LIMITS.teamSize,B:LIMITS.teamSize},roster:r.roster,
      score:r.score,left:r.duration,winKills:LIMITS.winKills});
  }
  _drop(id){
    const r=this.room,h=r.humans.get(id);
    if(!h)return;
    h.connected=false;
    if(r.hostId===id){
      const next=r.order.find(x=>r.humans.has(x)&&r.humans.get(x).connected&&x!==id);
      if(next){r.hostId=next;this._broadcast({t:S.HOST,hostId:next});}
      else this._end(null,'noHost');
    }
    this._roomMsg();
  }
  _end(win,reason){
    const r=this.room;r.phase='over';
    this._broadcast({t:S.END,win,reason,rows:r.roster,score:r.score});
  }
  _handle(sock,m){
    const r=this.room,id=sock.id,now=Date.now();
    switch(m.t){
      case C.PING:
        this._send(sock,{t:S.PONG,c:m.c,srv:now/1000});break;
      case C.CREATE:
      case C.JOIN:{
        if(m.ver&&m.ver!==PROTO){this._send(sock,{t:S.ERR,code:'proto'});break;}
        if(m.t===C.CREATE&&isMode(m.mode)){r.mode=m.mode;const lim=modeLimits(m.mode);r.teamSize=lim.teamSize;r.winKills=lim.winKills;r.duration=lim.duration;r.left=lim.duration;}
        if(Object.keys(r.humans).length>=(r.teamSize||LIMITS.teamSize)*2){this._send(sock,{t:S.ERR,code:'full'});break;}
        const team=r.count('A')<=r.count('B')?'A':'B';
        r.humans.set(id,{id,name:m.name||'Player',op:m.op||'frost',camo:m.camo||'default',
          team,ready:false,connected:true});
        r.order.push(id);
        if(!r.hostId)r.hostId=id;
        this._send(sock,{t:S.HELLO,id,proto:PROTO,team});
        this._roomMsg();break;
      }
      case C.READY:{
        const h=r.humans.get(id);if(h)h.ready=!!m.r;this._roomMsg();break;
      }
      case C.SIDE:{
        const h=r.humans.get(id);
        if(h&&m.team!==h.team&&r.count(m.team)<LIMITS.teamSize){h.team=m.team;if(m.op)h.op=m.op;}
        this._roomMsg();break;
      }
      case C.START:
      case C.REMATCH:{
        if(r.hostId!==id||r.phase==='live')break;
        r.phase='live';r.map=m.map||r.map;r.startAt=now+3000;
        r.score={A:0,B:0};r.bots=[];
        for(const team of ['A','B'])
          for(let i=r.count(team);i<LIMITS.teamSize;i++)
            r.bots.push({id:BOT_ID(team,i),team,name:`BOT-${team}${i+1}`,op:BOT_OP[team]});
        this._broadcast({t:S.START,map:r.map,startAt:r.startAt,duration:r.duration,
          winKills:LIMITS.winKills,roster:r.roster,bots:r.bots,
          difficulty:m.difficulty||'normal'});
        break;
      }
      case C.SNAP:
        this._broadcast({t:S.PEERS,st:now/1000,p:[m.s]},id);break;
      case C.BOT_SNAP:
        if(r.hostId===id)this._broadcast({t:S.BOTS,st:now/1000,b:m.b},id);
        break;
      case C.HIT:{
        const bot=String(m.target||'').startsWith('b');
        const hostSock=[...this.sockets].find(s=>s.id===r.hostId);
        const victimSock=[...this.sockets].find(s=>s.id===m.target);
        const dmg=Math.max(0,Math.min(HIT_DMG_CAP[m.w]||200,+m.dmg||0));
        if(bot&&hostSock&&r.hostId===id)
          this._send(hostSock,{t:S.HIT,bot:m.target,from:id,fromName:this.nameOf(id),
            dmg,head:m.head?1:0,w:m.w,pos:null});
        else if(!bot&&victimSock)
          this._send(victimSock,{t:S.HIT,from:id,fromName:this.nameOf(id),
            dmg,head:m.head?1:0,w:m.w,pos:null});
        break;
      }
      case C.DIED:{
        if(r.phase!=='live')break;
        const seq=m.seq|0;
        if(seq<=r.seq)break;
        r.seq=seq;
        const kt=m.killer!==id?r.count(m.killer==='A'?'A':'B'):0;
        const killerTeam=r.humans.get(m.killer)?.team||(m.killer?'B':'A');
        const victimTeam=r.humans.get(id)?.team||'A';
        if(killerTeam!==victimTeam)r.score[killerTeam]++;
        this._broadcast({t:S.KILL,killer:{id:m.killer,name:this.nameOf(m.killer)},
          victim:{id,name:this.nameOf(id)},w:m.w,head:m.head,score:{...r.score}});
        if(r.score.A>=LIMITS.winKills||r.score.B>=LIMITS.winKills)
          this._end(r.score.A>r.score.B?'A':'B','kills');
        break;
      }
      case C.BOT_DEATH:{
        if(r.hostId!==id||r.phase!=='live')break;
        const team=r.humans.get(m.killer)?.team||'A';
        r.score[team]++;
        this._broadcast({t:S.KILL,killer:{id:m.killer,name:this.nameOf(m.killer)},
          victim:{id:m.bot,name:this.nameOf(m.bot)},w:m.w,head:0,score:{...r.score}});
        if(r.score.A>=LIMITS.winKills||r.score.B>=LIMITS.winKills)
          this._end(r.score.A>r.score.B?'A':'B','kills');
        break;
      }
      case C.LEAVE:
        this._drop(id);break;
    }
  }
}

export { RATES };
