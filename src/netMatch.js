// netMatch.js — the only module allowed to orchestrate a networked session (lobby → match → result).
import {
  C, S, PROTO, LIMITS, MODE, DEFAULT_MODE, isMode, modeLimits, ROOM_CODE_RE, HIT_DMG_CAP, PEER_FLAGS, INTERP_DELAY,
  GRENADE_KIND, GRENADE_DMG_CAP, encodePeer, clamp,
} from './netProtocol.js';
import { TimeSync } from './interp.js';
import { NetClient, resolveServerUrl, roomWsUrl, reserveRoomCode } from './net.js';
import {
  makeNetHero, spawnCombatants, applyPeers, applyHitToBot, promoteToSimulated,
} from './remotePlayers.js';

export const PHASE = {
  IDLE:'idle', CONNECTING:'connecting', LOBBY:'lobby', STARTING:'starting',
  LIVE:'live', OVER:'over', RECONNECTING:'reconnecting',
};

const NET_ERR = {
  full:'net_full', badCode:'net_bad_code', proto:'net_proto',
  rate:'net_rate', kicked:'net_kicked',
};

export class NetMatch {
  constructor(game, { client } = {}) {
    this.game = game;
    this.phase = PHASE.IDLE;
    this.room = null;
    this.isHost = false;
    this.me = null;                 // {id, name, team}
    this.clock = new TimeSync();
    this.left = 0; this.startAt = 0;
    this.client = client || new NetClient();
    this._snapAcc = 0; this._botAcc = 0; this._tickAcc = 0;
    this._seq = 0; this._hitSeq = 0; this._pending = null;
    this._base = '';                // ws base URL (no /rooms/... path); set by openLobby/joinRoom
    this.mode = DEFAULT_MODE;       // mirrored from S.ROOM / S.START
    this.teamSize = modeLimits(DEFAULT_MODE).teamSize;
    this.winKills = modeLimits(DEFAULT_MODE).winKills;
    this._wantedMode = '';          // menu choice, published to the DO once we are the host
    this._wire();
  }
  get active() { return this.phase === PHASE.LIVE || this.phase === PHASE.STARTING; }

  _wire() {
    const c = this.client, g = this.game;
    c.on(S.HELLO, m => {
      this.me = { id:m.id, name:g.playerName, team:m.team || 'A' };
      this._lastPong = performance.now();
      if (m.token) {                          // keep the seat across a reconnect
        this.client.token = m.token;
        try { sessionStorage.setItem('gtg_token', m.token); } catch (e) {}
      }
      g.ui.setNetPill && g.ui.setNetPill('ok', 'CONNECTED');
    });
    c.on(S.ROOM, m => {
      this.room = m;
      if (m.code) this._roomCode = m.code;
      // Host, brand-new room: publish the mode picked in the menu (the DO mirrors it back).
      if (this.isHost && m.mode !== this._wantedMode && isMode(this._wantedMode)
          && (m.roster || []).length <= 1) {
        this.client.send(C.MODE, { mode:this._wantedMode });
      }
      if (isMode(m.mode)) this.mode = m.mode;
      if (m.sizes) this.teamSize = m.sizes.A || this.teamSize;
      if (m.winKills) this.winKills = m.winKills;
      this.isHost = m.hostId === this.me?.id;
      this._syncScoreboard(m);
      // Mid-match join: a newcomer in the authoritative roster gets an avatar on every client.
      if (this.active && m.roster) {
        const newcomers = m.roster.filter(r => r.id !== this.me?.id && !g.heroes.byNetId(r.id));
        if (newcomers.length) spawnCombatants(g, { humans:newcomers, isHost:this.isHost });
      }
      this.game.ui.updateLobby && this.game.ui.updateLobby(m, this.me?.id);
    });
    c.on(S.START, m => {
      this._pending = m;
      this.phase = PHASE.STARTING;
      if (isMode(m.mode)) this.mode = m.mode;
      if (m.teamSize) this.teamSize = m.teamSize;
      if (typeof m.winKills === 'number') this.winKills = m.winKills;
      g.ui.hideLobby && g.ui.hideLobby();
      g._pendingNet = this.prepareMatch(m);
      g.startGame();
      this.phase = PHASE.LIVE;
    });
    c.on(S.PEERS, m => {
      if (!this.clock.ready && typeof m.st === 'number') {
        this.clock.offset = m.st - performance.now()/1000;
        this.clock.ready = true;                 // use the seeded offset until the first PONG
      }
      applyPeers(g, m.st, m.p);
    });
    c.on(S.BOTS, m => {
      if (!this.clock.ready && typeof m.st === 'number') {
        this.clock.offset = m.st - performance.now()/1000;
        this.clock.ready = true;                 // use the seeded offset until the first PONG
      }
      // Bot snapshots are 7-tuples [id,x,y,z,yaw,hp,alive]; pad to the 8-tuple peer format.
      const b = (m.b || []).map(a => [a[0],a[1],a[2],a[3],a[4],0,a[5],a[6] ? 1 : 0]);
      applyPeers(g, m.st, b);
    });
    c.on(S.HIT, m => {
      // Defence in depth: never let a malformed/ malicious server frame poison local HP.
      if (typeof m.dmg !== 'number' || !Number.isFinite(m.dmg) || m.dmg < 0) return;
      const capped = Math.min(m.dmg, HIT_DMG_CAP[m.w] || 200);
      if (m.bot) { applyHitToBot(g, { ...m, dmg: capped }); return; }
      g.damagePlayer(capped, { id:m.from, name:m.fromName, pos:m.pos }, m.head, m.w);
    });
    c.on(S.KILL, m => this._onKill(m));
    c.on(S.SCORE, m => {
      if (!m.score) return;
      this.roomScore = m.score;
      if (g.dm) {
        g.dm.score = m.score;
        if (typeof m.left === 'number') g.dm.timer = m.left;
      }
      const shown = typeof m.left === 'number' ? m.left : (g.dm ? g.dm.timer : 0);
      g.ui.setDmScore && g.ui.setDmScore(m.score.A | 0, m.score.B | 0, shown);
    });
    c.on(S.TICK, m => { if (typeof m.left === 'number') this.left = m.left; });
    c.on(S.END, m => { this.phase = PHASE.OVER; g._endOnline && g._endOnline(m); });
    c.on(S.HOST, m => {
      this.isHost = m.hostId === this.me?.id;
      if (this.isHost) this.becomeHost(); else this.stepDown();
    });
    c.on(S.ERR, m => {
      const key = NET_ERR[m.code] || 'net_err';
      if (g.ui.lobbyError && (this.phase === PHASE.LOBBY || this.phase === PHASE.CONNECTING))
        g.ui.lobbyError(key);
      else if (g.ui.banner) g.ui.banner(tSafe(key), '');
    });
    c.on(S.PONG, m => {
      // Sent/received timestamps are both performance.now(): interp.js derives
      // offset = serverT − performance.now()/1000, which renderTime() then reads back.
      this.clock.onPong(m.c, m.srv, performance.now());
      this._lastPong = performance.now();
      // Adapt interpolation delay to observed RTT/jitter (bounded so aim feels stable).
      const dHuman=Math.max(.06,Math.min(.22,INTERP_DELAY.human+this.clock.rtt*.5+this.clock.jitter*2));
      const dBot=Math.max(.08,Math.min(.24,INTERP_DELAY.bot+this.clock.rtt*.5+this.clock.jitter*2));
      for(const h of g.heroes.list)if(h.netBuf)h.netBuf.dynamicDelay={human:dHuman,bot:dBot};
    });
    c.on('reconnecting', d => {
      if (this.phase !== PHASE.RECONNECTING) this._preDisconnectPhase = this.phase;
      this.phase = PHASE.RECONNECTING;
      g.ui.setNetPill && g.ui.setNetPill('bad', 'RECONNECT ' + d.attempt);
    });
    c.on('open', () => {
      g.ui.setNetPill && g.ui.setNetPill('ok', 'ONLINE');
      if (this.phase === PHASE.RECONNECTING) {
        let token = this.client.token || '';
        try { token = token || sessionStorage.getItem('gtg_token') || ''; } catch (e) {}
        this.client.send(C.HELLO, { token });
        if (this._roomCode) this.joinRoom(this._roomCode);
        this.phase = this._preDisconnectPhase === PHASE.LIVE ? PHASE.LIVE :
                     this._preDisconnectPhase === PHASE.STARTING ? PHASE.STARTING : PHASE.LOBBY;
        this._lastPong = performance.now();
      }
    });
    c.on('close', () => {
      if (this.active) g.ui.setNetPill && g.ui.setNetPill('bad', 'DISCONNECTED');
    });
  }

  /* ------------------------------ lobby ------------------------------ */
  /* The Worker serves one Durable Object per room code and only upgrades WebSockets on
     /rooms/{CODE}/ws, so the code has to exist before a socket is opened.
     - openLobby(): join an existing room (deep link / typed code) or, with create, reserve one.
     - createRoom(): POST /rooms → connect to that room → send c:create. */
  async openLobby({ code, create = false } = {}) {
    const base = resolveServerUrl();
    if (!base) {
      this.game.ui.lobbyError && this.game.ui.lobbyError('net_server_unset');
      return false;
    }
    this._base = base;
    this.phase = PHASE.CONNECTING;
    this.game.ui.setNetPill && this.game.ui.setNetPill('warn', 'CONNECTING');
    let target = String(code || '').toUpperCase();
    if (!target && create) {
      target = await reserveRoomCode(base);
      if (!target) {
        this.phase = PHASE.IDLE;
        this.game.ui.lobbyError && this.game.ui.lobbyError('net_create_fail');
        this.game.ui.setNetPill && this.game.ui.setNetPill('bad', '');
        return false;
      }
    }
    if (!target) {
      // Nothing to join yet: stay on the lobby screen and let JOIN / CREATE open the socket.
      this.phase = PHASE.LOBBY;
      return true;
    }
    if (!ROOM_CODE_RE.test(target)) {
      this.phase = PHASE.IDLE;
      this.game.ui.lobbyError && this.game.ui.lobbyError('net_bad_code');
      return false;
    }
    this._roomCode = target;
    this.client.connect(roomWsUrl(base, target));
    if (create) this.client.send(C.CREATE, this._createPayload());
    else this.client.send(C.JOIN, this._joinPayload(target));
    return true;
  }
  async createRoom() {
    const base = this._base || resolveServerUrl();
    if (!base) {
      this.game.ui.lobbyError && this.game.ui.lobbyError('net_server_unset');
      return false;
    }
    this._base = base;
    if (this.client.ws) {                       // already in a room: c:create is enough
      return this.client.send(C.CREATE, this._createPayload());
    }
    return this.openLobby({ create: true });
  }
  _createPayload() {
    // The Friends 5v5 chip is the only online entry; its room is always a 5v5 dm room.
    const wanted=this.game.ui.sel.mode==='online'?'dm':this.game.ui.sel.mode;
    this._wantedMode = wanted;
    return {
      name:this.game.playerName, op:this.game.ui.sel.operator,
      camo:this.game.ui.sel.camo, map:this.game.ui.sel.map,
      mode:wanted, ver:PROTO,
    };
  }
  _joinPayload(code) {
    return {
      code, name:this.game.playerName,
      op:this.game.ui.sel.operator, camo:this.game.ui.sel.camo, ver:PROTO,
    };
  }
  joinRoom(code) {
    const c = String(code || '').toUpperCase();
    if (!ROOM_CODE_RE.test(c))
      return this.game.ui.lobbyError && this.game.ui.lobbyError('net_bad_code');
    const base = this._base || resolveServerUrl();
    if (!base) {
      this.game.ui.lobbyError && this.game.ui.lobbyError('net_server_unset');
      return false;
    }
    this._base = base;
    this._roomCode = c;
    // Already inside this room (e.g. a reconnect that called joinRoom again): just re-join.
    if (this.client.ws) return this.client.send(C.JOIN, this._joinPayload(c));
    this.phase = PHASE.CONNECTING;
    this.game.ui.setNetPill && this.game.ui.setNetPill('warn', 'CONNECTING');
    this.client.connect(roomWsUrl(base, c));
    this.client.send(C.JOIN, this._joinPayload(c));
    return true;
  }
  setReady(v) { this.client.send(C.READY, { r:v ? 1 : 0 }); }
  setSide(team) { this.client.send(C.SIDE, { team, op:this.game.ui.sel.operator }); }
  start() { if (this.isHost) this.client.send(C.START, { map:this.game.ui.sel.map }); }
  rematch() { if (this.isHost) this.client.send(C.REMATCH, {}); }
  leave() {
    this.client.send(C.LEAVE, {});
    this.client.close();
    this._reset();
    this.game.ui.setNetPill && this.game.ui.setNetPill('', '');
  }

  /* --------------------------- match setup --------------------------- */
  prepareMatch(m) {
    const mine = (m.roster || []).find(r => r.id === this.me?.id) || { team:'A' };
    this.me.team = mine.team;
    const mode = isMode(m.mode) ? m.mode : this.mode;
    const lim = modeLimits(mode);
    const size = m.teamSize || lim.teamSize;
    this.mode = mode;
    this.teamSize = size;
    this.winKills = typeof m.winKills === 'number' ? m.winKills : lim.winKills;
    this.startAt = m.startAt;
    // Duration comes from the room's mode (dm/koth).
    this.duration = (typeof m.duration === 'number' ? m.duration : lim.duration);
    this.left = this.duration;
    const roster = (m.roster || []).filter(r => r.id !== this.me?.id);
    const humans = { A:0, B:0 };
    for (const r of roster) if (r.team === 'A' || r.team === 'B') humans[r.team]++;
    // Score rows: local player + every remote human. Bots score through DO bot deaths only.
    const rows = [];
    for (const r of (m.roster || [])) {
      rows.push({
        id:r.id, name:r.name, team:r.team, kills:0, deaths:0,
        me:r.id === this.me?.id, op:r.op || 'frost',
      });
    }
    return {
      mode,
      team:mine.team,
      faction:mine.team === 'A' ? 'ct' : 't',
      map:m.map, rows, timer:this.duration, winKills:this.winKills, isHost:this.isHost,
      setup: {
        sizes:{ A:size, B:size },
        humans, playerTeam:mine.team, roster, bots:m.bots || [],
        isHost:this.isHost,
      },
    };
  }

  /* ------------------------------ per frame ------------------------------ */
  renderTime(kind = 'human') {
    // kind is kept for callers (human/bot); SnapshotBuffer.sample applies the per-kind delay.
    return performance.now()/1000 + (this.clock.ready ? this.clock.offset : 0);
  }
  tick(dt) {
    if (!this.active) return;
    // A half-open WebSocket may never fire onclose; detect it with the 1 Hz PONG.
    if (this._lastPong && performance.now() - this._lastPong > 4000) {
      this._lastPong = performance.now();
      this.client.close();                    // triggers _scheduleRetry
      return;
    }
    const g = this.game;
    if (this.startAt) {
      // Time left is derived from the room's absolute start stamp only. It used to read
      // g.dm.timer (which main.js writes back from this.left every frame), so each frame
      // subtracted the elapsed time a second time and the HUD clock hit 0 after ~2.5 s.
      const elapsed = Math.max(0, this.clock.serverNow(performance.now()) - this.startAt / 1000);
      // Clamp from above too: the 3 s countdown returns a negative elapsed for a while.
      this.left = Math.max(0, Math.min(this.duration || LIMITS.duration,
        (this.duration || LIMITS.duration) - elapsed));
    }
    this._snapAcc += dt;
    if (this._snapAcc >= 1 / RATE_SNAP) {
      this._snapAcc = 0;
      const pl = g.player, w = g.weapon;
      const flags = (pl.alive ? PEER_FLAGS.ALIVE : 0)
        | (pl.crouching ? PEER_FLAGS.CROUCH : 0)
        | (w.adsAmt > .5 ? PEER_FLAGS.ADS : 0)
        | (pl.sprinting ? PEER_FLAGS.SPRINT : 0);
      this.client.send(C.SNAP, {
        s:encodePeer(this.me.id, {
          x:pl.pos.x, y:pl.pos.y, z:pl.pos.z,
          yaw:pl.yaw, pitch:pl.pitch, hp:pl.health,
        }, flags),
      });
    }
    if (this.isHost) {
      this._botAcc += dt;
      if (this._botAcc >= 1 / RATE_BOT) {
        this._botAcc = 0;
        const b = [];
        for (const h of g.heroes.list) {
          if (h.netDriven || !h.netId || String(h.netId).startsWith('b') === false) continue;
          // yaw is a radian angle everywhere else (encodePeer uses qAng = round(v*1000)/1000);
          // sending milliradians here made every bot on the other clients face a random way.
          b.push([h.netId, Math.round(h.pos.x*100), Math.round(h.pos.y*100),
            Math.round(h.pos.z*100), Math.round(h.yaw*1000)/1000, Math.round(h.hp), h.alive ? 1 : 0]);
        }
        this.client.send(C.BOT_SNAP, { b });
      }
    }
    this._tickAcc += dt;
    if (this._tickAcc >= 1) { this._tickAcc = 0; this.client.ping(); }
  }

  /* --------------------------- damage routing --------------------------- */
  /* Upload the authoritative LOS geometry of the current map so the server can reject wall shots.
     box format: [0, cx, cz, hw, hd, ry, y0, y1] (exact OBB for boxes, AABB fallback otherwise). */
  sendWorld(map, boxes) {
    if (!this.active || !map || !Array.isArray(boxes) || !boxes.length) return false;
    return this.client.send(C.WORLD, { map, boxes });
  }
  requestHit(victim, dmg, fromName, head, source) {
    if (!this.active || !victim || !victim.netId) return false;
    const kind = (source && source.kind) || 'weapon';
    // Grenades are not the equipped gun: the DO recomputes damage from `w`, so a frag must not
    // inherit e.g. the AK's per-shot damage (a grenade passed through requestHit without a
    // source used to be re-scored as a rifle hit *and* checked for LOS from the thrower).
    if (kind === 'frag') {
      return this.client.send(C.HIT, {
        target:victim.netId, dmg:clamp(dmg, 0, GRENADE_DMG_CAP), head:0,
        w:GRENADE_KIND, seq:++this._hitSeq, src:'frag',
      });
    }
    const wid=(source&&source.w)||this.game.weapon.def?.id;
    const cap=HIT_DMG_CAP[wid]||200;
    return this.client.send(C.HIT, {
      target:victim.netId, dmg:clamp(dmg, 0, cap), head:head ? 1 : 0,
      w:wid, seq:++this._hitSeq,
      src:kind,
    });
  }
  /* koth: the host is the node that simulates the point, so it reports capture ticks. */
  reportPoint(team, n = 1) {
    if (!this.active || !this.isHost || this.mode !== MODE.KOTH) return false;
    if (team !== 'A' && team !== 'B') return false;
    return this.client.send(C.POINT, { team, n });
  }
  reportLocalDeath(killerNetId, weaponId, head) {
    if (!this.active) return false;
    return this.client.send(C.DIED, {
      killer:killerNetId || '', w:weaponId, head:head ? 1 : 0, seq:++this._seq,
    });
  }
  reportBotDeath(victim, killerNetId) {
    if (!this.active || !this.isHost || !victim || !victim.netId) return false;
    return this.client.send(C.BOT_DEATH, { bot:victim.netId, killer:killerNetId || '', w:'', seq:++this._seq });
  }

  /* DO kill broadcast is the single writer of DM scores while online. */
  _onKill(m) {
    const g = this.game, s = g.dm?.scores;
    if (!s) return;
    const kid = m.killer?.id, vid = m.victim?.id;
    const rowK = kid ? [...s.values()].find(r => r.id === kid) : null;
    const rowV = vid ? [...s.values()].find(r => r.id === vid) : null;
    if (rowK) rowK.kills++;
    if (rowV) rowV.deaths++;
    g.ui.killFeed(m.killer?.name || '?', m.victim?.name || '?',
      g.t ? g.t('kill_verb') : 'KIA', kid === this.me?.id);
    if (kid === this.me?.id) {
      g.stats.kills++;
      if (m.head) g.stats.headshots++;
    }
    if (m.score) {
      g.dm.score = m.score;
      g.ui.setDmScore(m.score.A, m.score.B, g.dm.timer);
    }
  }

  _syncScoreboard(m) {
    const g = this.game;
    if (!g.dm || !m.roster || g.mode !== 'online') return;
    for (const r of m.roster) {
      if (!g.dm.scores.has(r.name))
        g.dm.scores.set(r.name, { id:r.id, name:r.name, team:r.team, kills:0, deaths:0, me:r.id===this.me?.id });
    }
  }

  /* ------------------------------ host role ------------------------------ */
  becomeHost() {
    const g = this.game;
    for (const h of g.heroes.list)
      if (h.netDriven && h.kind === 'bot') promoteToSimulated(h);
    g.ui.setNetPill && g.ui.setNetPill('ok', 'HOST');
  }
  stepDown() {
    this.isHost = false;
    const g = this.game;
    for (const h of g.heroes.list) {
      if (!h.netDriven && h.isSimulated && String(h.netId).startsWith('b')) {
        const d = { id:h.netId, team:h.team, name:h.name, op:h.opId, camo:'default' };
        const proxy = makeNetHero(g, d, { isBot:true, isHost:false });
        proxy.pos.copy(h.pos); proxy.yaw = h.yaw; proxy.hp = h.hp; proxy.alive = h.alive;
        const i = g.heroes.list.indexOf(h);
        h.dispose(); g.heroes.list[i] = proxy;
      }
    }
  }

  _applyRoomToLobby() {
    this.game.ui.updateLobby && this.game.ui.updateLobby(this.room, this.me?.id);
  }
  _reset() {
    this.phase = PHASE.IDLE; this.room = null; this.isHost = false;
    this.left = 0; this.startAt = 0; this._seq = 0; this._pending = null;
    this._roomCode = ''; this.duration = 0;
  }
}

const RATE_SNAP = 15, RATE_BOT = 12;
const tSafe = key => key; // i18n t() is injected into game; banner text stays short on error
