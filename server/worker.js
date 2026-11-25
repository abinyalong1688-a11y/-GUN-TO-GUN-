// worker.js — Cloudflare Worker entry + Durable Object room (Hibernation WebSocket API).
// The DO is a room registry / message fan-out / authoritative scoreboard. No three.js, no physics, no AI.
import * as R from './room.js';
import { C, S, PROTO, LIMITS, MODE, HIT_DMG_CAP, WEAPON_DMG, HEAD_MUL, WORLD_MAX_BOXES, LOS_MAX_DIST, PEER_FLAGS, GRENADE_KIND, GRENADE_DMG_CAP, BOT_RESPAWN_MS, LOS_SPREAD, LOS_HEAD, MAP_HASHES, mapHashValue, isMode, decodePeer, isValidMsg } from '../src/netProtocol.js';
import { losBlocked, hashGeo } from './los.js';

const CORS = {
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'content-type',
  'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
};
const json = (o, st=200) => new Response(JSON.stringify(o), {
  status:st, headers:{'Content-Type':'application/json',...CORS},
});
const CODE_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // matches ROOM_CODE_RE
function randomCode(){
  const b=new Uint8Array(5); crypto.getRandomValues(b);
  let s=''; for(const v of b)s+=CODE_ALPHABET[v%CODE_ALPHABET.length];
  return s;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers:CORS });
    const url = new URL(req.url);
    if (url.pathname === '/rooms' && req.method === 'POST') {
      // Reserve a fresh code: its DO must be currently empty (no live sockets).
      for (let i=0;i<5;i++) {
        const code = randomCode();
        const id = env.ROOMS.idFromName(code);
        const res = await env.ROOMS.get(id).fetch('https://do/reserve?code='+code, { method:'POST' });
        if (res.ok) return json({ code });
      }
      return json({ error:'busy' }, 503);
    }
    const m = url.pathname.match(/^\/rooms\/([A-HJ-NP-Z2-9]{5})\/ws$/);
    if (m) return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    return json({ error:'notFound' }, 404);
  },
};

const RATE = LIMITS.msgPerSec;
function freshAttachment(id){ return { id, token:crypto.randomUUID(), joined:false, tokens:RATE, refill:Date.now(), dmgAt:0 }; }

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.pending = new Map();     // id → {at, p} latest quantised snapshot (hit origin / liveness)
    // Hibernation: restore the authoritative room state before any event is delivered.
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get('room');
      this.state = stored ? R.fromJSON(stored)
        : R.createRoom('', Date.now());
    });
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/reserve') {
      if (this.ctx.getWebSockets().length) return new Response('busy', { status:409 });
      this.state.code = url.searchParams.get('code') || this.state.code;
      await this.save();
      // Empty rooms self-expire after 60 s (alarm also drives the 1 Hz match tick once live).
      await this.ctx.storage.setAlarm(Date.now()+60_000);
      return new Response('ok', { headers:CORS });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status:426 });
    if (this.ctx.getWebSockets().length >= LIMITS.maxHumans) return new Response('full', { status:409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(freshAttachment(crypto.randomUUID()));
    return new Response(null, { status:101, webSocket:client });
  }

  async save(){ await this.ctx.storage.put('room', R.toJSON(this.state)); }

  webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!isValidMsg(m)) return;
    const at = this.attachment(ws);
    if (!this.allow(at, raw.length)) return ws.send(JSON.stringify({ t:S.ERR, code:'rate' }));
    const now = Date.now();
    switch (m.t) {
      case C.HELLO: {
        // Reconnect resume: adopt the client's previous seat token (if any) and echo it back.
        const token = typeof m.token === 'string' && m.token.length < 64 ? m.token : at.token;
        this.attachment(ws, { ...at, token });
        return this.send(ws, { t:S.HELLO, id:this.attachment(ws).id, proto:PROTO,
                               team:this.state.humans[this.attachment(ws).id]?.team || 'A', token });
      }
      case C.PING:
        return this.send(ws, { t:S.PONG, c:m.c, srv:now/1000 });
      case C.CREATE:
      case C.JOIN: {
        if (m.ver && m.ver !== PROTO) return this.send(ws, { t:S.ERR, code:'proto' });
        // The creator picks the mode; joining clients adopt whatever the room already has.
        if (m.t === C.CREATE && isMode(m.mode)) R.setMode(this.state, m.mode);
        const token = m.token || at.token;
        const r = R.join(this.state, { ...m, id:at.id, token }, now);
        if (r.err) return this.send(ws, { t:S.ERR, code:r.err });
        this.attachment(ws, { ...at, joined:true, token });
        this.state.noHostAt = 0;
        if (r.rejoin && at.id !== this.state.hostId) {
          // The old socket (if still open) must not keep acting as a player
          for (const other of this.ctx.getWebSockets())
            if (other !== ws && this.attachment(other).id === at.id)
              this.attachment(other, { ...this.attachment(other), id:'stale-'+at.id });
        }
        this.send(ws, { t:S.HELLO, id:at.id, proto:PROTO, team:r.team, token });
        this.broadcastRoom();
        return this.save();
      }
      case C.READY: {
        if (!at.joined) return;
        R.setReady(this.state, at.id, m.r); this.broadcastRoom(); return this.save();
      }
      case C.SIDE: {
        if (!at.joined) return;
        const r = R.setSide(this.state, at.id, m.team);
        if (r.ok && m.op && this.state.humans[at.id]) this.state.humans[at.id].op = m.op;
        this.broadcastRoom(); return this.save();
      }
      case C.MODE: {
        // Only the host may pick, and only before anyone else is seated: the mode decides the
        // team size, and a late switch would silently change everyone else's match.
        if (!at.joined || this.state.hostId !== at.id) return;
        if (R.setMode(this.state, m.mode).err) return this.send(ws, { t:S.ERR, code:'mode' });
        this.broadcastRoom();
        return this.save();
      }
      case C.START: {
        if (!at.joined || this.state.hostId !== at.id || this.state.phase === 'live') return;
        R.start(this.state, now, { map:m.map, difficulty:m.difficulty });
        this.broadcast(this.startPayload());
        this.ctx.storage.setAlarm(now+1000);
        return this.save();
      }
      case C.REMATCH: {
        if (!at.joined || this.state.hostId !== at.id || this.state.phase !== 'over') return;
        // Rematch keeps the mode and map; the world geometry is re-uploaded by the host.
        this.state.phase = 'lobby';
        this.state.worldGeo = null; this.state.worldMap = '';
        R.start(this.state, now, {});
        this.broadcast(this.startPayload());
        this.ctx.storage.setAlarm(now+1000);
        return this.save();
      }
      case C.SNAP: {
        if (!at.joined || this.state.phase !== 'live' || !Array.isArray(m.s)) return;
        const p=m.s;
        if(p.length!==8||p[0]!==at.id||p.slice(1).some(v=>typeof v!=='number'||!Number.isFinite(v)))return;
        const x=p[1]/100,y=p[2]/100,z=p[3]/100;
        if(Math.hypot(x,z)>57||y<-1||y>12||p[6]<0||p[6]>200||(p[7]&~15))return;
        const prev=this.pending.get(at.id);
        if(prev){
          const d=Math.hypot(x-prev.p[1]/100,y-prev.p[2]/100,z-prev.p[3]/100);
          // Time-aware speed limit: sprint is 7.8 m/s, so 12 m/s + 0.35 m of jitter margin
          // still allows laggy/reordered samples but blocks map-wide teleports.
          const dt=Math.min(.5,Math.max(.05,(now-prev.at)/1000));
          if(d>0.35+12*dt)return;
        }
        // Keep a short history for future lag-compensation checks (≤500 ms).
        const h=at.history||(at.history=[]);
        h.push({t:now,x,y,z,yaw:p[4]});
        while(h.length&&now-h[0].t>500)h.shift();
        this.attachment(ws,{...at,history:h});
        this.pending.set(at.id, { at:now, p:m.s });
        // Broadcast every snapshot at most once per ~66 ms (15 Hz), not per raw message
        if (!this._snapAt || now-this._snapAt >= 60) {
          this._snapAt = now;
          this.broadcast({ t:S.PEERS, st:now/1000, p:[...this.pending.values()].map(x=>x.p) }, at.id);
        }
        return;
      }
      case C.BOT_SNAP: {
        if (!at.joined || this.state.hostId !== at.id || !Array.isArray(m.b)) return;
        // The server's bot.alive is authoritative: a snapshot may carry a respawn (0→1), but it
        // must not resurrect a bot the server has already marked dead, which allowed the host to
        // farm the same bot's death over and over (one kill per C.BOT_DEATH report).
        if (!this.respawned) this.respawned = {};
        for(const snap of m.b){
          const bot=Array.isArray(snap)&&(this.state.bots||[]).find(b=>b.id===snap[0]);
          if(!bot||typeof snap[6]!=='number') continue;
          const alive=!!snap[6];
          if(bot.alive && !alive) bot.alive=false;            // server-side death stays dead
          else if(!bot.alive && alive){
            // Respawn is rate-limited per bot: at most once every 3 s, and only after a death.
            const last=this.respawned[bot.id]||0;
            if(now-last>=BOT_RESPAWN_MS){bot.alive=true;this.respawned[bot.id]=now;}
          }
        }
        this.broadcast({ t:S.BOTS, st:now/1000, b:m.b }, at.id);
        return;
      }
      case C.WORLD: {
        // Only the host uploads, and only geometry whose hash matches the arena baked into the
        // build (MAP_HASHES). "First upload wins" let anyone define an empty map and switch every
        // wall check off for the room; a host-only rule still let a hacked host do the same.
        if (!at.joined || this.state.phase !== 'live' || at.id !== this.state.hostId) return;
        if (typeof m.map !== 'string' || m.map !== this.state.map || !Array.isArray(m.boxes)) return;
        if (m.boxes.length < 1 || m.boxes.length > WORLD_MAX_BOXES) return;
        const boxes = this.sanitizeWorld(m.boxes);
        if (!boxes) return;
        const expected = MAP_HASHES[m.map];
        if (!expected || hashGeo(boxes) !== mapHashValue(expected)) {
          at.worldMismatch = (at.worldMismatch || 0) + 1;
          this.attachment(ws, at);
          return;                                  // untrusted geometry: ignore it
        }
        if (!this.state.worldGeo || this.state.worldMap !== m.map) {
          this.state.worldGeo = boxes;
          this.state.worldMap = m.map;
          return this.save();
        }
        return;
      }
      case C.HIT: {
        if (!at.joined || this.state.phase !== 'live') return;
        // Bots are `b<team><n>` from the server roster, but human seat ids are UUIDs that may
        // also begin with 'b' — so the bot test must be a roster lookup, never a prefix test.
        // (With a prefix test, a victim whose UUID started with 'b' was scored as a bot and
        // skipped the LOS check entirely.)
        const isBot = this.isBotId(m.target);
        const shooter=this.pending.get(at.id);
        if (!shooter || !(shooter.p[7]&PEER_FLAGS.ALIVE)) return;   // dead shooters cannot hit
        if (!(m.w in HIT_DMG_CAP)) return;                          // weapon whitelist
        if (typeof m.dmg!=='number'||!Number.isFinite(m.dmg)||m.dmg<=0) return;
        const seq=Math.max(0,Math.min(1e9,m.seq|0));
        if (seq<=((this.seenHit||(this.seenHit={}))[at.id]||0)) return;
        if (now-at.dmgAt<60) return;                                // minimum fire interval
        // Authoritative adjudication — the server recomputes damage and rejects wall shots.
        // The client-supplied m.dmg is treated only as a "hit request", never as truth.
        // A frag is thrown at a spot, not aimed at a body: the thrower's own falloff value is
        // bounded by the grenade cap, and LOS is not evaluated from the thrower's position.
        const isFrag = m.w === GRENADE_KIND;
        let dmg;
        if (isFrag) {
          dmg = Math.min(m.dmg, GRENADE_DMG_CAP);
          if (dmg <= 0) return;
        } else if (isBot) {
          // Bot target: authoritative damage only (bot position lives on the host client).
          dmg = (WEAPON_DMG[m.w] || 0) * (m.head ? HEAD_MUL : 1);
          if (dmg <= 0) return;
        } else {
          const v = this.validateHit(at, m);
          if (!v.ok) return;
          dmg = v.dmg;
        }
        // Rolling 1 s damage budget: even a scripted client cannot delete a full team instantly
        const win=at.dmgWin||(at.dmgWin={t:now,sum:0});
        if(now-win.t>1000){win.t=now;win.sum=0;}
        if(win.sum+dmg>600) return;
        win.sum+=dmg;
        this.seenHit[at.id]=seq;at.dmgAt=now;
        this.attachment(ws,at);                                     // persist dmgAt
        // C.DIED is only honoured for a shooter that actually hit this victim a moment ago.
        if (!isBot) {
          const on = (this.hitOn = this.hitOn || {});
          on[m.target] = { by:at.id, t:now };
        }
        return this.relayHit(at, m, dmg);
      }
      case C.DIED: {
        if (!at.joined || this.state.phase !== 'live') return;
        // The victim only reports that it died; the killer must be corroborated by an earlier
        // hit, otherwise a client could hand 25 free kills to the enemy team by dying on cue.
        const killerId = this.creditKiller(at.id, m.killer);
        if (!killerId) return;
        const seq = Math.max(0, Math.min(1e9, m.seq|0));
        const r = R.recordKill(this.state, {
          killerId, victimId:at.id, killerName:this.nameOf(killerId),
          victimName:this.nameOf(at.id), weapon:m.w, head:m.head, seq,
        });
        if (r.err) return;                       // duplicate / unknown killer: no kill broadcast
        this.broadcast({ t:S.KILL,
          killer:{ id:killerId, name:this.nameOf(killerId) },
          victim:{ id:at.id, name:this.nameOf(at.id) },
          w:m.w, head:m.head, score:r.score });
        if (r.end) this.endMatch(r.end, 'kills');
        return this.save();
      }
      case C.BOT_DEATH: {
        if (!at.joined || this.state.hostId !== at.id || this.state.phase !== 'live') return;
        const bot=(this.state.bots||[]).find(b=>b.id===m.bot);
        // The host reports deaths of bots it simulates. The killer must be the host itself, a
        // bot, or a human whose hit this connection relayed recently (remotePlayers.js reports
        // the full {id,name} object, which used to stringify to "[object Object]" and be dropped).
        const killerId = this.creditBotKiller(at.id, m.bot, m.killer);
        if (!bot || !bot.alive || !killerId) return;
        const seq=Math.max(0,Math.min(1e9,m.seq|0));
        if (seq<=((this.seenBotDeath||(this.seenBotDeath={}))[at.id]||0)) return;
        this.seenBotDeath[at.id]=seq;
        bot.alive=false;                         // server-side bot state is authoritative
        // Start the respawn cooldown at the moment of death, so the first snapshot after a kill
        // cannot immediately resurrect the bot (that was the farming loop).
        (this.respawned=this.respawned||{})[bot.id]=now;
        const r = R.recordKill(this.state, {
          killerId, victimId:m.bot, killerName:this.nameOf(killerId),
          victimName:this.nameOf(m.bot), weapon:m.w, head:0, seq,
        });
        if (r.err) return;
        this.broadcast({ t:S.KILL,
          killer:{ id:killerId, name:this.nameOf(killerId) },
          victim:{ id:m.bot, name:this.nameOf(m.bot) },
          w:m.w, head:0, score:r.score });
        if (r.end) this.endMatch(r.end, 'kills');
        return this.save();
      }
      case C.LEAVE:
        return this.drop(at.id);
      case C.POINT: {
        // koth only, host only: the host is the node that actually simulates the point.
        if (!at.joined || this.state.phase !== 'live' || this.state.hostId !== at.id) return;
        if (this.state.mode !== 'koth') return;
        const n = Math.max(1, Math.min(10, m.n | 0 || 1));
        let last = null;
        for (let i = 0; i < n && !last?.end; i++) last = R.addPoint(this.state, m.team);
        if (!last || last.err) return;
        this.broadcast({ t:S.SCORE, score:last.score, left:this.state.left });
        if (last.end) this.endMatch(last.end, 'point');
        return this.save();
      }
      case C.FX: {
        if (!at.joined) return;
        const { t: _ignored, ...fx } = m;          // spreading m after t would restore 'c:fx'
        return this.broadcast({ ...fx, t:S.FX }, at.id);
      }
    }
  }

  /* Damage is now authoritative: the DO recomputes it from weapon base damage × headshot
     multiplier, then delivers it. Human victims settle HP in their own damagePlayer();
     bot victims are simulated by the host. */
  relayHit(at, m, dmg) {
    const target = this.state.humans[m.target];
    const shooter = this.pending.get(at.id);
    const pos = shooter ? decodePeer(shooter.p) : null;
    const payload = {
      from:at.id, fromName:this.nameOf(at.id), dmg, head:m.head ? 1 : 0,
      w:m.w, pos:pos ? { x:pos.x, y:pos.y, z:pos.z } : null,
    };
    if (target) {
      const ws = this.wsOf(m.target);
      if (ws) this.send(ws, { t:S.HIT, ...payload });
      return;
    }
    if (this.isBotId(m.target)) {
      const host = this.wsOf(this.state.hostId);
      if (host) this.send(host, { t:S.HIT, bot:m.target, ...payload });
      // Remember who shot this bot: C.BOT_DEATH is only accepted for a shooter that hit it.
      const shots = (at.botShots = at.botShots || {});
      shots[m.target] = { by:at.id, t:Date.now() };
      this.attachment(ws, at);
    }
  }

  /* True only for an id present in this room's bot roster (see C.HIT). */
  isBotId(id) {
    return !!id && (this.state.bots || []).some(b => b.id === id);
  }

  /* Killer ids arrive either as a string, an id object ({id,name}) or a nested object; normalise. */
  normalizeKiller(k) {
    if (typeof k === 'string') return k;
    if (k && typeof k === 'object' && typeof k.id === 'string') return k.id;
    return '';
  }

  /* A death report must be backed by an earlier hit from the same shooter on that victim
     within the grace window — otherwise a client could hand 25 free kills to the enemy team. */
  creditKiller(victimId, reported) {
    const k = this.normalizeKiller(reported);
    if (!k) return '';
    const t = (this.hitOn || (this.hitOn = {}))[victimId];
    if (t && t.by === k && Date.now() - t.t < 10_000) return k;
    return '';
  }

  /* Bot deaths may be reported by the host for itself, for a bot, or for a human that recently
     landed a hit on that bot (relayHit records those). */
  creditBotKiller(hostId, botId, reported) {
    const k = this.normalizeKiller(reported);
    if (k === hostId || this.isBotId(k)) return k;
    const t = (this.botShots || {})[botId];
    if (t && t.by === k && Date.now() - t.t < 10_000) return k;
    return '';
  }

  /* Human-target hit adjudication: the target must be online, alive, in range, and visible
     (the shooter→target segment must not pierce any baked wall). Damage is recomputed. */
  validateHit(at, m) {
    const sh = this.pending.get(at.id);
    if (!sh) return { ok:false };
    const sp = decodePeer(sh.p);
    const t = this.pending.get(m.target);
    if (!t) return { ok:false };
    const tp = decodePeer(t.p);
    if (!(tp.flags & PEER_FLAGS.ALIVE)) return { ok:false };
    const ox = sp.x, oz = sp.z;
    const oy = sp.y + ((sp.flags & PEER_FLAGS.CROUCH) ? 1.0 : 1.6);
    const tx = tp.x, tz = tp.z;
    if (!this.state.worldGeo) return { ok:false };   // no trusted map yet — refuse, never guess
    const ty = tp.y + (m.head ? 1.6 : 0.95);
    if (Math.hypot(tx - ox, ty - oy, tz - oz) > LOS_MAX_DIST) return { ok:false };
    // The client's hit spheres have a body radius of ~0.42 m, while a single centre-line LOS
    // check is a pixel test: legitimate torso shots at the edge of a wall corner were rejected.
    // Test a small pattern around the aim point instead — a shot is legal when ANY of them is
    // clear, which keeps the wall-shot guarantee (all blocked → rejected) but stops false hits.
    const cy = tp.y + ((tp.flags & PEER_FLAGS.CROUCH) ? 0.72 : 0.95);
    // Head claims get a tight pattern only: accepting a headshot on a clear torso would let a
    // client aim at the chest and claim the 2× head multiplier.
    const aim = m.head
      ? [[tx, ty, tz], [tx + LOS_HEAD, ty, tz], [tx - LOS_HEAD, ty, tz],
         [tx, ty, tz + LOS_HEAD], [tx, ty, tz - LOS_HEAD]]
      : [[tx, ty, tz], [tx, cy, tz], [tx + LOS_SPREAD, ty, tz], [tx - LOS_SPREAD, ty, tz],
         [tx, ty, tz + LOS_SPREAD], [tx, ty, tz - LOS_SPREAD]];
    const visible = aim.some(([px, py, pz]) =>
      !losBlocked(this.state.worldGeo, ox, oy, oz, px, py, pz));
    if (!visible) return { ok:false };
    const dmg = (WEAPON_DMG[m.w] || 0) * (m.head ? HEAD_MUL : 1);
    return dmg > 0 ? { ok:true, dmg } : { ok:false };
  }

  /* Validate a client geometry upload: box [0,…×8] or cylinder [1,…×6], integer centimetres
     (ry in milliradians), finite, sane bounds. Converts to metres for the LOS engine. */
  sanitizeWorld(raw) {
    const out = [];
    for (const g of raw) {
      if (!Array.isArray(g) || (g[0] !== 0 && g[0] !== 1)) return null;
      const n = g[0] === 0 ? 8 : 6;
      if (g.length !== n) return null;
      for (let i = 0; i < n; i++) if (typeof g[i] !== 'number' || !Number.isFinite(g[i])) return null;
      if (Math.abs(g[1]) > 10000 || Math.abs(g[2]) > 10000) return null;   // 100 m in cm
      if (g[0] === 0) {
        if (g[3] < 0 || g[4] < 0 || g[6] > g[7] || Math.abs(g[5]) > 6283) return null;
        out.push([0, g[1]/100, g[2]/100, g[3]/100, g[4]/100, g[5]/1000, g[6]/100, g[7]/100]);
      } else {
        if (g[3] < 0 || g[4] > g[5]) return null;
        out.push([1, g[1]/100, g[2]/100, g[3]/100, g[4]/100, g[5]/100]);
      }
    }
    return out;
  }

  webSocketClose(ws) { const at=this.attachment(ws); if (at) this.drop(at.id); }
  webSocketError(ws) { const at=this.attachment(ws); if (at) this.drop(at.id); }

  attachment(ws, patch) {
    if (patch) { ws.serializeAttachment(patch); return patch; }
    return ws.deserializeAttachment() || freshAttachment('unknown');
  }
  allow(at, bytes) {
    const now = Date.now();
    at.tokens = Math.min(RATE, at.tokens + (now-at.refill)/1000*RATE);
    at.refill = now;
    if (bytes > LIMITS.bytesPerMsg || at.tokens < 1) return false;
    at.tokens -= 1;
    return true;
  }

  drop(id) {
    const h = this.state.humans[id];
    if (!h) return;
    h.connected = false;
    this.pending.delete(id);                  // never broadcast stale snapshots from a dropped peer
    if (this.seenHit) delete this.seenHit[id];
    if (this.seenBotDeath) delete this.seenBotDeath[id];
    if (this.state.hostId === id) {
      const next = R.promoteHost(this.state);
      if (next) {
        // The promoted client promotes its bot proxies to local simulation
        for (const ws of this.ctx.getWebSockets()) {
          const at = this.attachment(ws);
          if (at.id === next) this.send(ws, { t:S.HOST, hostId:next });
        }
      } else {
        // Grace period: a reconnecting player may still claim the host token within 10 s.
        this.state.noHostAt = Date.now() + 10_000;
        this.ctx.storage.setAlarm(Date.now() + 1000);
      }
    }
    this.broadcastRoom();
    this.save();
  }

  endMatch(win, reason) {
    this.state.phase = 'over';
    this.broadcast({ t:S.END, win, reason, rows:this.scoreRows(), score:this.state.score });
    this.save();
  }

  send(ws, msg){ try { ws.send(JSON.stringify(msg)); } catch {} }
  broadcast(msg, exceptId) {
    const raw = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const at = this.attachment(ws);
      if (exceptId && at.id === exceptId) continue;
      try { ws.send(raw); } catch {}
    }
  }
  broadcastRoom() {
    this.broadcast({ t:S.ROOM, code:this.state.code, hostId:this.state.hostId,
      phase:this.state.phase, mode:this.state.mode, map:this.state.map, difficulty:this.state.difficulty,
      sizes:{ A:this.state.teamSize, B:this.state.teamSize }, roster:this.roster(),
      score:this.state.score, left:this.state.left, winKills:this.state.winKills,
      duration:this.state.duration });
  }
  /* s:start carries everything the clients need to build the same match. */
  startPayload() {
    return { t:S.START, mode:this.state.mode, map:this.state.map, startAt:this.state.startAt,
      duration:this.state.duration, winKills:this.state.winKills, teamSize:this.state.teamSize,
      roster:this.roster(), bots:this.state.bots, difficulty:this.state.difficulty };
  }
  roster() {
    return Object.values(this.state.humans).map(h => ({
      id:h.id, name:h.name, op:h.op, camo:h.camo, team:h.team,
      ready:h.ready, host:h.id===this.state.hostId, connected:h.connected,
    }));
  }
  /* Result-screen rows: every human plus the bots that actually scored, with real K/D. */
  scoreRows() {
    const rows = this.roster().map(r => {
      const kd = (this.state.kills || {})[r.id] || {};
      return { ...r, kills:kd.kills | 0, deaths:kd.deaths | 0 };
    });
    for (const [id, kd] of Object.entries(this.state.kills || {})) {
      if (this.state.humans[id]) continue;
      rows.push({ id, name:kd.name || this.nameOf(id), team:kd.team, kills:kd.kills | 0, deaths:kd.deaths | 0, host:false, connected:false });
    }
    return rows;
  }
  nameOf(id) {
    if (!id) return '';
    if (this.state.humans[id]) return this.state.humans[id].name;
    const b = (this.state.bots || []).find(x => x.id === id);
    return b ? b.name : 'BOT';
  }
  wsOf(id) {
    return this.ctx.getWebSockets().find(ws => this.attachment(ws).id === id) || null;
  }

  async alarm() {
    const now = Date.now();
    if (this.state.noHostAt && now >= this.state.noHostAt && !this.state.hostId) {
      this.state.noHostAt = 0;
      return this.endMatch(null, 'noHost');
    }
    const r = R.tick(this.state, now);
    if (this.state.phase === 'live') {
      this.broadcast({ t:S.TICK, st:Date.now()/1000, left:r.left });
      // Periodic full room resync fixes any score drift from a dropped S.KILL frame.
      if ((this._tickN = (this._tickN || 0) + 1) % 5 === 0) this.broadcastRoom();
      await this.ctx.storage.setAlarm(Date.now()+1000);
    } else if (r.end === 'time') {
      this.endMatch(null, 'time');
      await this.ctx.storage.setAlarm(Date.now()+3600_000);
    } else {
      // Empty / finished room: keep the code reserved a while longer, then let the DO evict.
      await this.ctx.storage.setAlarm(Date.now()+3600_000);
    }
    await this.save();
  }
}
