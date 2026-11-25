# GUN TO GUN · 好友对战 5v5（在线联机）—— 代码级实施方案

- 目标仓库：`D:\software develop\网页游戏《GUNTOGUN》`（v1.10.2）
- 方案版本：2026-11-24
- 交付形态：**合并在现有主菜单**新增一个模式；**现有 4v4 离线死斗一字不动**；单文件离线版继续作为核心卖点

---

## 0. 需求与已确认决策

| 决策点 | 结论 |
|---|---|
| 好友如何加入 | 在线联机（需要服务器） |
| 服务器 | Cloudflare Workers + Durable Objects（一房一 DO） |
| 队伍规模 | 固定 5v5 |
| 规则 | 沿用死斗：3 分钟 / 先到 25 击杀 / 击杀·死亡记分 / 2.5 s 复活 |
| 真人不足 | AI 补位到 5v5 |
| 菜单 | 合并在主菜单新增模式；保留现有 4v4 离线死斗 |
| 房间 | 仅 5 位房间码，无公开匹配 |
| 分配 | 自动平衡 + 可手动换边 |
| 地图 | 房主选图 |
| 服务器地址 | 构建常量 + `?server=` + 设置面板，三种覆盖 |
| 房主掉线 | 自动移交房主；10 s 无人接管则本局结束回大厅 |

**四条硬约束**

1. 离线三个模式行为零变化：不选联机时 `net.stats.socketsOpened === 0`。
2. 全仓库仍只有一个 `Game` 实例、一个 canvas、一个 `EffectComposer`。
3. `dist` 体积预算 5 MB（当前 3.27 MB）；`server/` 代码绝不进客户端包。
4. 联机任何失败都必须能无损退回菜单，离线可继续玩。

---

## 1. 架构总览

```
客户端 A（房主 Host）                           Cloudflare                       客户端 B
───────────────────────                        ───────────                      ─────────
本地玩家模拟 ───c:snap 15 Hz────────────────►  Durable Object（每房一个）   ◄─── c:snap 15 Hz ─── 本地玩家模拟
AI 机器人模拟 ─c:botSnap 12 Hz──────────────►  · 房间名册 / 队伍 / 准备          ─s:peers 15 Hz──► 远程真人（插值）
射线命中 ──────c:hit───────────────────────►  · 击杀 / 死亡 / 计时权威           ─s:bots 12 Hz───► 机器人代理（插值）
                ◄─────s:hit（转发被击者）      · 房主选举 / 到期 / 结束
                ◄─────s:kill / s:tick / s:end
```

- **DO 不跑 three.js、不跑物理、不跑 AI**，只是房间注册表 + 消息扇出 + 权威记分板。
- **位置**：各自客户端权威。
- **伤害**：攻击方本地射线判定 → DO 转发 `s:hit` → 被击方在自己 `damagePlayer()` 内结算（沿用现有 god / invuln / HUD / 死亡流程）。
- **机器人**：只由房主模拟，12 Hz 快照复制；非房主端保留代理，随时可被选举接管。
- **击杀 / 死亡 / 计时 / 胜负 / 名册**：DO 权威。

**必须守住的现有不变量**

- `heroes.list` = 「除本地玩家外的所有战斗单位」。`fire()`（`src/main.js:656-680`）已对列表内敌人做球体射线，雷达也自动显示 → **远程真人必须放进 `heroes.list`**，不能另开渲一套。
- `damagePlayerFromBot()`（`src/main.js:825`）是所有袭入伤害的唯一入口 → **泛化它**，不要新增第二条路径。
- 无参数调用 `HeroTeam.setup(...)` 必须仍产出 **3 + 4**，保证 `tests/heroes.test.mjs:57` 与 e2e `operators-8` 继续通过。

---

## 2. 文件清单

**新增**

```
src/netProtocol.js    纯数据：消息常量 / 校验 / 量化编解码 / 上限表（Worker 也 import）
src/net.js            传输：服务器地址解析、NetClient（可注入 wsFactory）、重连、LoopbackTransport
src/interp.js         纯数学：SnapshotBuffer / sample() / TimeSync（无 three.js，可直接单测）
src/remotePlayers.js  头像工厂 + 快照落地（把 HeroBot 变成 netDriven 代理）
src/netMatch.js       会话编排（唯一允许调用 Game 内部的新模块）
src/netLobby.js       大厅 DOM 控制器
server/room.js        纯房间状态机（无 Cloudflare 依赖，Node 可单测）
server/worker.js      Worker fetch + DurableObject Room（Hibernation WebSocket 适配）
server/wrangler.toml  Cloudflare 部署配置
server/README.md      部署 / 免费额度 / 信任模型
docs/FRIENDS-5V5-ONLINE.md   本设计文档
```

**改动**

```
src/heroes.js      HeroBot 网络驱动分流、takeDamage 路由、setup 参数化、adopt、_separate 保护
src/main.js        isArena/spawns/playerTeam 派生、startGame 分支、damagePlayer 泛化、tick、netMenu、_endOnline、_boot 接线
src/ui.js          KOK 增加 online、showOnly('lobby')、setNetPill / setNetMode
src/template.html  联机 chip、#lobby 覆盖层、#net-pill、#p-leave
src/i18n.js        中/英各 ~30 个键；dm_sub 占位符化
src/style.css      大厅、连接 pill
src/input.js       ESC→netMenu、Tab 记分板、_uiLock 守卫
build.mjs          __GTG_SERVER__ define + 空值提示
package.json       version 1.11.0、server:dev / server:deploy
README.md          架构、联机部署、信任模型、e2e 数量
```

---

## 3. 新增模块（代码骨架）

### 3.1 `src/netProtocol.js`

```js
// netProtocol.js — 客户端与 Worker 共享的唯一协议定义（无依赖、无副作用）
export const PROTO = 1;

export const LIMITS = {
  maxHumans: 10,
  teamSize: 5,
  winKills: 25,
  duration: 180,
  msgPerSec: 32,          // 单连接
  bytesPerMsg: 4096,
  msgPerRoomPerSec: 300,
  nameMax: 12,
  queueMax: 64,           // 连接中最大排队消息数
};

export const RATES = { humanSnapHz: 15, botSnapHz: 12, tickHz: 1, pingHz: 1 };
export const INTERP_DELAY = { human: 0.10, bot: 0.12 };
export const EXTRAP_MAX = 0.12;
export const SNAP_JUMP = 8;            // m，200 ms 内超过直接吸附

export const ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;   // 去掉 0/O/1/I

export const C = {
  CREATE:'c:create', JOIN:'c:join', LEAVE:'c:leave', READY:'c:ready', SIDE:'c:side',
  START:'c:start', REMATCH:'c:rematch', SNAP:'c:snap', HIT:'c:hit', DIED:'c:died',
  BOT_SNAP:'c:botSnap', BOT_DEATH:'c:botDeath', FX:'c:fx', PING:'c:ping', RESERVE:'c:reserve',
};
export const S = {
  HELLO:'s:hello', ROOM:'s:room', START:'s:start', PEERS:'s:peers', BOTS:'s:bots',
  HIT:'s:hit', KILL:'s:kill', TICK:'s:tick', END:'s:end', HOST:'s:host',
  PEER_LEFT:'s:peerLeft', PEER_JOINED:'s:peerJoined', ERR:'s:err', PONG:'s:pong',
};

/* 每把枪的单发伤害上限（DO 用它钳制注入伤害；数值 = 武器基础伤害 × 2.5 暴击 × 1.2 余量） */
export const HIT_DMG_CAP = {
  m4a4:95, aug:92, awp:350, sg553:98, ak47:110, mp5:80, deagle:165, ump45:105,
};

/* 名字清洗：与 <input maxlength=10> 对齐，去掉控制字符与尖括号（防 XSS），折叠空白 */
export const sanitizeName = s => String(s ?? '')
  .replace(/[\u0000-\u001f<>]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, LIMITS.nameMax);

export const qPos = v => Math.round(v * 100) | 0;      // cm
export const dqPos = v => v / 100;
export const qAng = v => Math.round(v * 1000) / 1000;  // 3 位小数
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* 快照：单人 9 个 8 元组，量化后 < 260 B（有单测断言） */
export const PEER_FLAGS = { ALIVE:1, CROUCH:2, ADS:4, SPRINT:8 };

export function encodePeer(id, p, flags) {
  return [id, qPos(p.x), qPos(p.y), qPos(p.z), qAng(p.yaw), qAng(p.pitch), p.hp | 0, flags];
}
export function decodePeer(a) {
  return { id:a[0], x:dqPos(a[1]), y:dqPos(a[2]), z:dqPos(a[3]),
           yaw:a[4], pitch:a[5], hp:a[6], flags:a[7] };
}
export const isValidMsg = (m) =>
  m && typeof m === 'object' && typeof m.t === 'string' && m.t.length < 24;
```

### 3.2 `src/interp.js`

```js
// interp.js — 纯数学：快照环形缓冲、双快照插值、时钟同步（无 three.js）
import { INTERP_DELAY, EXTRAP_MAX, SNAP_JUMP } from './netProtocol.js';

export class SnapshotBuffer {
  constructor(cap = 32) {
    this.cap = cap; this.buf = new Array(cap); this.n = 0; this.head = 0;
  }
  clear() { this.n = 0; this.head = 0; }
  push(t, s) {                       // s = {x,y,z,yaw,pitch,hp,alive,crouch}
    // 乱序/重复帧直接丢弃
    const last = this.n ? this.buf[(this.head - 1 + this.cap) % this.cap] : null;
    if (last && t <= last.t) return;
    this.buf[this.head] = { t, ...s };
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  at(i) { return this.buf[(this.head - this.n + i + this.cap) % this.cap]; }
  /* renderTime：已扣除 offset 与插值延迟的本地时间 */
  sample(renderTime, kind = 'human') {
    if (!this.n) return null;
    const delay = INTERP_DELAY[kind] ?? INTERP_DELAY.human;
    const rt = renderTime - delay;
    const first = this.at(0), last = this.at(this.n - 1);
    if (rt <= first.t) return { ...first, extrapolated: false };
    if (rt >= last.t) {
      const ahead = rt - last.t;
      if (ahead > EXTRAP_MAX) return { ...last, extrapolated: false, frozen: true };
      // 线性外推（用最后两帧的速度）
      const prev = this.n > 1 ? this.at(this.n - 2) : last;
      const dt = Math.max(1e-3, last.t - prev.t);
      const k = Math.min(ahead, EXTRAP_MAX) / dt;
      const jumped = Math.hypot(last.x - prev.x, last.z - prev.z) > SNAP_JUMP;
      if (jumped) return { ...last, extrapolated: false };
      return {
        ...last, extrapolated: true,
        x: last.x + (last.x - prev.x) * k,
        y: last.y + (last.y - prev.y) * k,
        z: last.z + (last.z - prev.z) * k,
      };
    }
    // 二分段插值
    let a = first, b = last;
    for (let i = 0; i < this.n - 1; i++) {
      const p = this.at(i), q = this.at(i + 1);
      if (p.t <= rt && rt <= q.t) { a = p; b = q; break; }
    }
    const span = Math.max(1e-4, b.t - a.t);
    const f = (rt - a.t) / span;
    // 传送/复活：位移过大直接吸附到后一帧
    if (Math.hypot(b.x - a.x, b.z - a.z) > SNAP_JUMP && span < 0.2)
      return { ...b, extrapolated: false };
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      yaw: lerpAngle(a.yaw, b.yaw, f),
      pitch: a.pitch + (b.pitch - a.pitch) * f,
      hp: f < 0.5 ? a.hp : b.hp,
      alive: f < 0.5 ? a.alive : b.alive,
      crouch: f < 0.5 ? a.crouch : b.crouch,
      extrapolated: false,
    };
  }
}

export function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

/* 时钟同步：offset = serverTime + RTT/2，EWMA(0.9)；抖动单独平滑用于显示延迟 */
export class TimeSync {
  constructor() { this.offset = 0; this.rtt = 0; this.jitter = 0; this.ready = false; }
  onPong(sentT, serverT, nowMs) {
    const rtt = (nowMs - sentT) / 1000;
    const off = serverT + rtt / 2 - nowMs / 1000;
    if (!this.ready) { this.offset = off; this.rtt = rtt; this.ready = true; return; }
    const d = Math.abs(off - this.offset);
    this.jitter = this.jitter * 0.9 + d * 0.1;
    this.rtt = this.rtt * 0.8 + rtt * 0.2;
    this.offset = this.offset * 0.9 + off * 0.1;
  }
  serverNow(nowMs) { return nowMs / 1000 + this.offset; }
}
```

### 3.3 `src/net.js`

```js
// net.js — 传输层。默认不产生任何网络行为；只有 connect() 才开 socket。
import { C, S, PROTO, LIMITS, isValidMsg } from './netProtocol.js';
import { store } from './util.js';

/* 地址优先级：?server= > localStorage.o07_server > 构建常量 __GTG_SERVER__ > '' */
export function resolveServerUrl() {
  try {
    const q = new URLSearchParams(location.search).get('server');
    if (q) return q;
  } catch (e) {}
  const ls = store.get('o07_server');
  if (ls) return ls;
  return typeof __GTG_SERVER__ === 'string' ? __GTG_SERVER__ : '';
}
export const serverConfigured = () => !!resolveServerUrl();

const RETRY = [0.5, 1, 2, 4, 8];

export class NetClient {
  constructor({ wsFactory } = {}) {
    this.wsFactory = wsFactory || (u => new WebSocket(u));
    this.ws = null; this.queue = []; this.handlers = new Map();
    this.token = ''; this.hello = null; this.attempt = 0; this.closedByUs = false;
    this.stats = { socketsOpened: 0, bytesIn: 0, bytesOut: 0, rtt: 0 };
    this._tokens = LIMITS.msgPerSec; this._refill = 0;
    this._pingT = 0; this._retryT = 0; this.url = '';
  }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return this;
  }
  _emit(type, data) { const l = this.handlers.get(type); if (l) for (const f of l) try { f(data); } catch (e) {} }

  connect(url, hello) {
    this.url = url; this.hello = hello; this.closedByUs = false;
    return this._open();
  }
  _open() {
    this.stats.socketsOpened++;                     // 离线断言：没 connect 就一直是 0
    const ws = this.wsFactory(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      if (this.hello) this.send(this.hello.t, this.hello);
      while (this.queue.length) this.send(this.queue[0].t, this.queue.shift());
      this._emit('open');
    };
    ws.onmessage = e => {
      const raw = typeof e.data === 'string' ? e.data : '';
      this.stats.bytesIn += raw.length;
      let m; try { m = JSON.parse(raw); } catch (err) { return; }   // 畸形帧静默丢弃
      if (!isValidMsg(m)) return;
      this._emit(m.t, m);
    };
    ws.onclose = () => {
      this.ws = null;
      this._emit('close');
      if (!this.closedByUs) this._scheduleRetry();
    };
    ws.onerror = () => {};
  }
  _scheduleRetry() {
    const d = RETRY[Math.min(this.attempt++, RETRY.length - 1)];
    this._retryT = d;
    this._emit('reconnecting', { in: d, attempt: this.attempt });
    setTimeout(() => { if (!this.closedByUs) this._open(); }, d * 1000);
  }
  _allow(bytes) {                                    // 32 msg/s + 4 KB 令牌桶
    const now = performance.now();
    this._tokens = Math.min(LIMITS.msgPerSec, this._tokens + (now - this._refill) / 1000 * LIMITS.msgPerSec);
    this._refill = now;
    if (this._tokens < 1 || bytes > LIMITS.bytesPerMsg) return false;
    this._tokens -= 1; return true;
  }
  send(type, payload = {}) {
    const msg = { ...payload, t: type };
    if (this.ws && this.ws.readyState === 1) {
      const raw = JSON.stringify(msg);
      if (!this._allow(raw.length)) return false;
      this.stats.bytesOut += raw.length;
      try { this.ws.send(raw); return true; } catch (e) { return false; }
    }
    if (this.queue.length < LIMITS.queueMax) this.queue.push(msg);
    return false;
  }
  ping() { this.send(C.PING, { c: Date.now() }); }
  close() { this.closedByUs = true; this.queue.length = 0; try { this.ws && this.ws.close(); } catch (e) {} this.ws = null; }
}

/* 内存双端：?net=loopback 与 e2e 用它驱动完整的大厅/对局流程（无需服务器） */
export class LoopbackTransport {
  constructor() { this.server = null; this.client = null; }
  attach(serverImpl) { this.server = serverImpl; }
  createClient() {
    const c = new NetClient({ wsFactory: () => this._fakeSocket() });
    return c;
  }
  _fakeSocket() { /* 手写 readyState/send/onmessage 的最小实现，把 send 转给 serverImpl 回调 */ }
}
```

`__GTG_SERVER__` 由 `build.mjs` 的 `define` 注入；未注入时 `typeof` 判断为 `'undefined'`，返回 `''`。

### 3.4 `src/remotePlayers.js`

```js
// remotePlayers.js — 远程真人 / 被复制的机器人：建 HeroBot 代理、落地快照、迁移接管
import { HeroBot } from './heroes.js';
import { byId, DEFAULT_OP } from './operators.js';
import { SnapshotBuffer } from './interp.js';
import { decodePeer } from './netProtocol.js';

/* 由 s:start 的 roster/bots 建代理并挂到 heroes.list（通过 adopt，不走 setup 的全清空） */
export function spawnCombatants(game, { humans = [], bots = [] }) {
  const made = [];
  for (const h of humans) {
    const op = { ...(byId(h.op) || byId(DEFAULT_OP)), camo: h.camo || 'default' };
    const b = new HeroBot(game, game.scene, game.assets, game.effects, game.audio, game.ui, {
      operator: op, team: h.team, name: h.name,
      netId: h.id, netDriven: true, kind: 'human',
      spawnBase: game.spawns[h.team],
    });
    b.netBuf = new SnapshotBuffer(32);
    game.heroes.adopt(b); made.push(b);
  }
  for (const h of bots) {
    const op = { ...(byId(h.op) || byId(DEFAULT_OP)), camo: h.camo || 'default' };
    const b = new HeroBot(game, game.scene, game.assets, game.effects, game.audio, game.ui, {
      operator: op, team: h.team, name: h.name,
      netId: h.id, netDriven: true, kind: 'bot',
      spawnBase: game.spawns[h.team],
    });
    b.netBuf = new SnapshotBuffer(32);
    game.heroes.adopt(b); made.push(b);
  }
  return made;
}

/* s:peers / s:bots 落地：按 netId 找代理，写入缓冲 */
export function applyPeers(game, serverT, peers) {
  for (const a of peers) {
    const d = decodePeer(a);
    const h = game.heroes.byNetId(d.id);
    if (!h || !h.netBuf) continue;
    h.netBuf.push(serverT, {
      x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
      hp: d.hp, alive: !!(d.flags & 1), crouch: !!(d.flags & 2),
    });
  }
}

/* 房主迁移：把快照代理就地转为本地模拟（位置/血量保持，AI 计时器重置） */
export function promoteToSimulated(h) {
  if (!h || !h.netDriven) return;
  h.netDriven = false;
  h.kind = h.kind === 'human' ? 'bot' : h.kind;
  h.netBuf = null;
  h.alive = true; h.state = 'active'; h.deathT = 0; h.hp = h.maxHp;
  h.fireT = 1 + Math.random(); h.reactionT = 0; h.burst = 0;
  h._route = null; h.coverTarget = null; h.coverT = 0; h._stuckT = 0;
  h.group.visible = true;
  h.group.rotation.set(0, h.yaw, 0);
}
```

### 3.5 `src/netMatch.js`

```js
// netMatch.js — 唯一的会话编排层（大厅 → 开局 → 对局 → 结束）
import { C, S, ROOM_CODE_RE, LIMITS, HIT_DMG_CAP, PEER_FLAGS, encodePeer, clamp } from './netProtocol.js';
import { TimeSync } from './interp.js';
import { NetClient, resolveServerUrl } from './net.js';
import { spawnCombatants, applyPeers, promoteToSimulated } from './remotePlayers.js';
import { byFaction, DEFAULT_OP } from './operators.js';

export const PHASE = { IDLE:'idle', CONNECTING:'connecting', LOBBY:'lobby', STARTING:'starting', LIVE:'live', OVER:'over', RECONNECTING:'reconnecting' };

export class NetMatch {
  constructor(game) {
    this.game = game;
    this.phase = PHASE.IDLE;
    this.room = null;              // 最近一次 s:room
    this.isHost = false;
    this.me = null;                // {id, name, team}
    this.state = {};               // 本地玩家上行快照状态
    this.clock = new TimeSync();
    this.left = 0; this.startAt = 0;
    this.renderTimeOffset = 0;
    this.left_ = 0;
    this.client = new NetClient();
    this._snapAcc = 0; this._botAcc = 0; this._tickAcc = 0;
    this._wire();
  }
  get active() { return this.phase === PHASE.LIVE || this.phase === PHASE.STARTING; }

  _wire() {
    const c = this.client, g = this.game;
    c.on(S.HELLO, m => { this.me = { id: m.id, name: g.playerName, team: 'A' }; this.me.id = m.id; this.clock.offset = 0; });
    c.on(S.ROOM, m => { this.room = m; this.isHost = m.hostId === this.me?.id; this._applyRoomToLobby(); });
    c.on(S.START, m => { this._pending = m; this.phase = PHASE.STARTING; g.ui.hideLobby(); g._pendingNet = this.prepareMatch(m); g.startGame(); });
    c.on(S.PEERS, m => { this.clock.serverNow(performance.now()); applyPeers(g, m.t, m.p); });
    c.on(S.BOTS, m => { applyPeers(g, m.t, m.b); });
    c.on(S.HIT, m => { g.damagePlayer(m.dmg, { id: m.from, name: m.fromName, pos: m.pos }, m.head); });
    c.on(S.KILL, m => { this._onKill(m); });
    c.on(S.TICK, m => { this.left = m.left; this.clock.onPong(m.c, m.t, Date.now()); });
    c.on(S.END, m => { this.phase = PHASE.OVER; g._endOnline(m); });
    c.on(S.HOST, m => { this.isHost = m.hostId === this.me?.id; if (this.isHost) this.becomeHost(); });
    c.on(S.PONG, m => this.clock.onPong(m.c, m.srv, Date.now()));
    c.on('reconnecting', d => { this.phase = PHASE.RECONNECTING; this.game.ui.setNetPill('bad', 'Reconnecting ' + d.attempt); });
    c.on('close', () => { if (this.phase === PHASE.LIVE) this.game.ui.setNetPill('bad', 'Disconnected'); });
  }

  /* ---------- 大厅 ---------- */
  async openLobby() {
    const url = resolveServerUrl();
    if (!url) { this.game.ui.lobbyError('net_server_unset'); return; }
    this.phase = PHASE.CONNECTING;
    this.client.connect(url, { t: C.CREATE, name: this.game.playerName, op: this.game.ui.sel.operator,
      camo: this.game.ui.sel.camo, map: this.game.ui.sel.map, ver: PROTO });
  }
  createRoom() { this.client.send(C.CREATE, { name: this.game.playerName, op: this.game.ui.sel.operator, camo: this.game.ui.sel.camo, map: this.game.ui.sel.map }); }
  joinRoom(code) { if (!ROOM_CODE_RE.test(code)) return this.game.ui.lobbyError('net_bad_code');
    this.client.send(C.JOIN, { code, name: this.game.playerName, op: this.game.ui.sel.operator, camo: this.game.ui.sel.camo }); }
  setReady(v) { this.client.send(C.READY, { r: v ? 1 : 0 }); }
  setSide(team) { this.client.send(C.SIDE, { team, op: this.game.ui.sel.operator }); }
  start() { if (this.isHost) this.client.send(C.START, {}); }
  rematch() { if (this.isHost) this.client.send(C.REMATCH, {}); }
  leave() { this.client.send(C.LEAVE, {}); this.client.close(); this._reset(); }

  /* ---------- 开局 ---------- */
  prepareMatch(m) {
    const me = m.roster.find(r => r.id === this.me.id) || { team: 'A' };
    this.me.team = me.team;
    this.startAt = m.startAt; this.left = m.duration;
    return {
      team: me.team,
      faction: me.team === 'A' ? 'ct' : 't',
      map: m.map,
      rows: [], timer: m.duration, winKills: m.winKills,
      setup: {
        sizes: { A: LIMITS.teamSize, B: LIMITS.teamSize },
        humans: {
          A: m.roster.filter(r => r.team === 'A' && r.id !== this.me.id).length,
          B: m.roster.filter(r => r.team === 'B' && r.id !== this.me.id).length,
        },
        playerTeam: me.team,
        roster: m.roster.filter(r => r.id !== this.me.id).map(r => ({ netId: r.id, name: r.name, op: r.op, camo: r.camo, team: r.team })),
        bots: m.bots || [],
      },
    };
  }

  /* ---------- 每帧 ---------- */
  tick(dt) {
    if (!this.active) return;
    const g = this.game;
    // 3 s 倒计时冻结
    this.left = Math.max(0, this.startAt - this.clock.serverNow(performance.now()) + (this.room?.duration || 0));
    // 上行快照 15 Hz
    this._snapAcc += dt;
    if (this._snapAcc >= 1 / 15) {
      this._snapAcc = 0;
      const pl = g.player, w = g.weapon;
      const flags = (pl.alive ? PEER_FLAGS.ALIVE : 0) | (pl.crouching ? PEER_FLAGS.CROUCH : 0)
        | (w.adsAmt > .5 ? PEER_FLAGS.ADS : 0) | (pl.sprinting ? PEER_FLAGS.SPRINT : 0);
      this.client.send(C.SNAP, {
        s: encodePeer(this.me.id, { x: pl.pos.x, y: pl.pos.y, z: pl.pos.z, yaw: pl.yaw, pitch: pl.pitch, hp: pl.health }, flags),
      });
    }
    // 房主机器人快照 12 Hz
    if (this.isHost) {
      this._botAcc += dt;
      if (this._botAcc >= 1 / 12) {
        this._botAcc = 0;
        const bots = g.heroes.list.filter(h => !h.netDriven)
          .map(h => [h.netId, Math.round(h.pos.x * 100), Math.round(h.pos.y * 100), Math.round(h.pos.z * 100),
                     Math.round(h.yaw * 1000), Math.round(h.hp), h.alive ? 1 : 0]);
        this.client.send(C.BOT_SNAP, { b: bots });
      }
    }
    this._tickAcc += dt;
    if (this._tickAcc >= 1) { this._tickAcc = 0; this.client.ping(); }
  }

  /* ---------- 伤害 / 击杀路由 ---------- */
  requestHit(victimHero, dmg, fromName, head) {
    if (!this.active) return;
    const cap = HIT_DMG_CAP[this.game.weapon.def?.id] || 200;
    this.client.send(C.HIT, { target: victimHero.netId, dmg: Math.min(dmg, cap), head: head ? 1 : 0, w: this.game.weapon.def?.id });
  }
  reportLocalDeath(killerNetId, weaponId) {
    if (!this.active) return;
    this.client.send(C.DIED, { killer: killerNetId, w: weaponId, seq: ++this._seq });
  }
  reportBotDeath(botHero, killerNetId) {
    if (!this.active || !this.isHost) return;
    this.client.send(C.BOT_DEATH, { bot: botHero.netId, killer: killerNetId });
  }
  /* DO 广播的击杀：唯一更新 dm.scores / killfeed 的地方（联机模式） */
  _onKill(m) {
    const g = this.game, s = g.dm?.scores;
    if (!s) return;
    const k = g.heroes.byNetId(m.killer?.id) || (m.killer?.id === this.me.id ? 'me' : null);
    const rowK = [...s.values()].find(r => r.id === m.killer?.id) || s.get(m.killer?.name);
    const rowV = [...s.values()].find(r => r.id === m.victim?.id) || s.get(m.victim?.name);
    if (rowK) rowK.kills++; if (rowV) rowV.deaths++;
    g.ui.killFeed(m.killer?.name || '?', m.victim?.name || '?', g.t('kill_verb'), m.killer?.id === this.me.id);
    if (g.dm && m.score) { g.dm.score = m.score; g.ui.setDmScore(m.score.A, m.score.B, g.dm.timer); }
  }

  becomeHost() {
    const g = this.game;
    for (const h of g.heroes.list) if (h.netDriven && h.kind === 'bot') promoteToSimulated(h);
    g.ui.setNetPill('ok', 'HOST');
  }
  stepDown() { this.isHost = false; }

  renderTime(kind) { return performance.now() / 1000; }
  _applyRoomToLobby() { this.game.ui.updateLobby(this.room, this.me?.id); }
  _reset() { this.phase = PHASE.IDLE; this.room = null; this.isHost = false; this.left = 0; }
  get left() { return this._left; }
  set left(v) { this._left = v; }
}
```

### 3.6 `src/netLobby.js`

```js
import { escHTML } from './util.js';
import { t } from './i18n.js';
import { ROOM_CODE_RE } from './netProtocol.js';

export class NetLobby {
  constructor(game, on) { /* on = {create, join, ready, side, start, leave, solo, close} */
    this.game = game; this.on = on;
    this.el = { root: document.getElementById('lobby') /* 子节点同模式 */ };
    this.bind();
  }
  show() { this.el.root.classList.remove('hidden'); this.render(); }
  hide() { this.el.root.classList.add('hidden'); }
  error(key) { /* 在 #lobby-status 输出 t(key)，红字 */ }
  render(room, meId) {
    // 名册两列，全部名字走 escHTML；房主按钮仅 isHost 可见
    const cols = { A: [], B: [] };
    for (const r of room?.roster || []) cols[r.team].push(r);
    /* ...生成 DOM，队伍列用 .team-a/.team-b，准备态用 .ready ... */
  }
  updatePill(state, text) { /* 连接状态 */ }
  bind() { /* 房间码输入自动大写 + 过滤 [^A-HJ-NP-Z2-9]，复制邀请链接 ?room=CODE */ }
  inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }
}
```

### 3.7 `server/room.js`（纯函数，Node 可单测）

```js
// room.js — 房间状态机。无 Cloudflare / 无 DOM 依赖，可直接 node --test。
import { LIMITS, sanitizeName } from '../src/netProtocol.js';

export function createRoom(code, now) {
  return { v:1, code, phase:'lobby', hostId:null, map:'desert', bots:[],
    createdAt:now, startAt:0, left:0, winKills:LIMITS.winKills,
    humans:{}, order:[], score:{A:0,B:0}, seq:0 };
}

const count = (s, team) => Object.values(s.humans).filter(h => h.team === team).length;

export function uniqueName(s, name) {
  const base = sanitizeName(name) || 'Player';
  const taken = new Set(Object.values(s.humans).map(h => h.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 50; i++) {
    const n = `${base} ${i}`;
    if (!taken.has(n.toLowerCase())) return n;
  }
  return base + ' ' + Date.now().toString(36).slice(-3);
}

export function join(s, { id, name, op, camo, token }, now) {
  if (s.humans[id]) return { ok:true, host: s.hostId === id };      // 重连
  if (Object.keys(s.humans).length >= LIMITS.maxHumans) return { err:'full' };
  const team = count(s,'A') <= count(s,'B') ? 'A' : 'B';            // 自动平衡
  if (count(s, team) >= LIMITS.teamSize) return { err:'full' };
  s.humans[id] = { id, name:uniqueName(s, name), op, camo, team, ready:false, connected:true, joinedAt:now, token };
  s.order.push(id);
  if (!s.hostId) s.hostId = id;
  return { ok:true, team };
}

export function setSide(s, id, team) {
  const h = s.humans[id]; if (!h) return { err:'unknown' };
  if (s.phase !== 'lobby') return { err:'locked' };
  if (count(s, team) >= LIMITS.teamSize) return { err:'teamFull' };
  h.team = team; return { ok:true };
}

export function setReady(s, id, ready) { const h = s.humans[id]; if (!h) return { err:'unknown' }; h.ready = !!ready; return { ok:true }; }

export function start(s, now, { map, difficulty } = {}) {
  if (!s.hostId) return { err:'noHost' };
  s.phase = 'live';
  s.map = map || s.map;
  s.startAt = now + 3000;
  s.left = LIMITS.duration;
  s.score = { A:0, B:0 };
  s.bots = [];
  for (const team of ['A','B']) {
    const filled = count(s, team);
    for (let i = filled; i < LIMITS.teamSize; i++)
      s.bots.push({ id:`b${team}${i}`, team, name:`BOT-${team}${i+1}`, op: team === 'A' ? 'm4a4' : 'ak47' });
  }
  return { ok:true };
}

export function recordKill(s, { killerId, victimId, killerName, victimName, weapon, head }) {
  const k = s.humans[killerId], v = s.humans[victimId];
  if (!k && !killerName) return { err:'unknown' };
  if (v) { if (!v.alive !== false) {} }                              // 存活态由客户端维护
  const team = (k && k.team) || (v && (v.team === 'A' ? 'B' : 'A'));
  if (team) s.score[team] = Math.min(LIMITS.teamSize * LIMITS.winKills, s.score[team] + 1);
  s.seq++;
  const end = (s.score.A >= s.winKills || s.score.B >= s.winKills)
    ? (s.score.A > s.score.B ? 'A' : 'B') : null;
  return { ok:true, score:{ ...s.score }, end };
}

export function tick(s, now) {
  if (s.phase !== 'live') return { left:0 };
  s.left = Math.max(0, LIMITS.duration - (now - s.startAt) / 1000);
  if (s.left <= 0) { s.phase = 'over'; return { end:'time' }; }
  return { left:s.left };
}

export function promoteHost(s) {
  const next = s.order.find(id => s.humans[id] && s.humans[id].connected && id !== s.hostId);
  s.hostId = next || null;
  return s.hostId;
}

export const toJSON = s => JSON.stringify(s);
export const fromJSON = o => JSON.parse(o);
```

### 3.8 `server/worker.js` + `wrangler.toml`

```js
// worker.js — Worker 入口 + Durable Object 房间（Hibernation WebSocket API）
import * as R from './room.js';
import { C, S, PROTO, LIMITS } from '../src/netProtocol.js';

const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'content-type' };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type':'application/json', ...CORS } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/rooms' && req.method === 'POST') {
      for (let i = 0; i < 5; i++) {
        const code = randomCode();
        const id = env.ROOMS.idFromName(code);
        const r = await env.ROOMS.get(id).fetch('https://do/reserve', { method:'POST' });
        if (r.ok) return json({ code });
      }
      return json({ error:'busy' }, 503);
    }
    const m = url.pathname.match(/^\/rooms\/([A-HJ-NP-Z2-9]{5})\/ws$/);
    if (m) {
      const id = env.ROOMS.idFromName(m[1]);
      return env.ROOMS.get(id).fetch(req);
    }
    return json({ error:'notFound' }, 404);
  },
};

function randomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 与 ROOM_CODE_RE 一致
  let s = ''; const b = new Uint8Array(5); crypto.getRandomValues(b);
  for (const v of b) s += A[v % A.length];
  return s;
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.state = R.createRoom('', Date.now());
    this.pending = new Map();      // id → 最近快照（用于房主校验/迁移）
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/reserve') {
      if (this.ctx.getWebSockets().length) return new Response('busy', { status:409 });
      this.state.code = url.searchParams.get('code') || this.state.code;
      await this.ctx.storage.put('room', R.toJSON(this.state));
      this.ctx.storage.setAlarm(Date.now() + 3600_000);
      return new Response('ok');
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected ws', { status:426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), joined:false });
    return new Response(null, { status:101, webSocket:client });
  }
  webSocketMessage(ws, raw) {
    const at = ws.deserializeAttachment();
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    const now = Date.now();
    switch (m.t) {
      case C.PING: return ws.send(JSON.stringify({ t:S.PONG, c:m.c, srv:now/1000 }));
      case C.JOIN: case C.CREATE: {
        if (m.ver && m.ver !== PROTO) return ws.send(JSON.stringify({ t:S.ERR, code:'proto' }));
        const r = R.join(this.state, { ...m, id: at.id }, now);
        if (r.err) return ws.send(JSON.stringify({ t:S.ERR, code:r.err }));
        ws.serializeAttachment({ ...at, joined:true });
        ws.send(JSON.stringify({ t:S.HELLO, id:at.id, proto:PROTO }));
        return this.broadcastRoom();
      }
      case C.READY: R.setReady(this.state, at.id, m.r); return this.broadcastRoom();
      case C.SIDE: R.setSide(this.state, at.id, m.team); return this.broadcastRoom();
      case C.START: {
        if (this.state.hostId !== at.id) return;
        R.start(this.state, now, { map:m.map });
        return this.broadcast({ t:S.START, map:this.state.map, startAt:now+3000, duration:LIMITS.duration,
          winKills:this.state.winKills, roster:this.roster(), bots:this.state.bots });
      }
      case C.SNAP: this.pending.set(at.id, { at:now, p:m.s }); return this.broadcast({ t:S.PEERS, t0:now/1000, p:[m.s] }, at.id);
      case C.BOT_SNAP: return this.broadcast({ t:S.BOTS, t0:now/1000, b:m.b }, at.id);
      case C.HIT: {
        const target = this.state.humans[m.target]; if (!target) return;
        const ws2 = this.wsOf(m.target); if (ws2) ws2.send(JSON.stringify({ t:S.HIT, from:at.id, fromName:this.nameOf(at.id), dmg:m.dmg, head:m.head, w:m.w }));
        return;
      }
      case C.DIED: {
        const r = R.recordKill(this.state, { killerId:m.killer, victimId:at.id, killerName:this.nameOf(m.killer), victimName:this.nameOf(at.id), weapon:m.w, head:m.head });
        this.broadcast({ t:S.KILL, killer:{ id:m.killer, name:this.nameOf(m.killer) }, victim:{ id:at.id, name:this.nameOf(at.id) }, w:m.w, head:m.head, score:r.score });
        if (r.end) this.endMatch(r.end, 'kills');
        return;
      }
      case C.BOT_DEATH: {
        const r = R.recordKill(this.state, { killerId:m.killer, victimId:m.bot, killerName:this.nameOf(m.killer), victimName:'BOT', weapon:m.w });
        this.broadcast({ t:S.KILL, killer:{ id:m.killer, name:this.nameOf(m.killer) }, victim:{ id:m.bot, name:'BOT' }, w:m.w, score:r.score });
        if (r.end) this.endMatch(r.end, 'kills');
        return;
      }
      case C.LEAVE: return this.drop(at.id);
      case C.REMATCH: if (this.state.hostId === at.id) { R.start(this.state, now, {}); this.broadcast({ t:S.START, /* ... */ }); } return;
    }
  }
  webSocketClose(ws) { const at = ws.deserializeAttachment(); this.drop(at.id); }
  webSocketError(ws) { const at = ws.deserializeAttachment(); this.drop(at.id); }
  drop(id) {
    const h = this.state.humans[id]; if (!h) return;
    h.connected = false;
    if (this.state.hostId === id) {
      const next = R.promoteHost(this.state);
      if (next) this.broadcast({ t:S.HOST, hostId:next });
      else this.endMatch(null, 'noHost');
    }
    this.ctx.storage.put('room', R.toJSON(this.state));
    this.broadcastRoom();
  }
  endMatch(win, reason) {
    this.state.phase = 'over';
    this.broadcast({ t:S.END, win, reason, rows:this.roster(), score:this.state.score });
  }
  broadcast(msg, exceptId) {
    const raw = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const at = ws.deserializeAttachment();
      if (exceptId && at.id === exceptId) continue;
      try { ws.send(raw); } catch {}
    }
  }
  broadcastRoom() {
    this.broadcast({ t:S.ROOM, code:this.state.code, hostId:this.state.hostId, phase:this.state.phase,
      map:this.state.map, sizes:{ A:LIMITS.teamSize, B:LIMITS.teamSize },
      roster:this.roster(), score:this.state.score, left:this.state.left, winKills:this.state.winKills });
  }
  roster() { return Object.values(this.state.humans).map(h => ({ id:h.id, name:h.name, op:h.op, camo:h.camo, team:h.team, ready:h.ready, host:h.id===this.state.hostId, connected:h.connected })); }
  nameOf(id) { return this.state.humans[id]?.name || 'BOT'; }
  wsOf(id) { return this.ctx.getWebSockets().find(ws => ws.deserializeAttachment().id === id); }
  async alarm() { R.tick(this.state, Date.now()); await this.ctx.storage.put('room', R.toJSON(this.state)); }
}
```

```toml
# server/wrangler.toml
name = "guntogun-rooms"
main = "worker.js"
compatibility_date = "2025-09-01"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]

[vars]
PROTO = "1"
```

> `server/README.md` 必写：`npx wrangler dev --local`、`npx wrangler deploy`、`GTG_SERVER=wss://<worker>.workers.dev npm run build`、免费额度与消息量估算、https→wss 混合内容限制、信任模型（房间码制、无排位）。

---

## 4. 现有文件逐处改动

### 4.1 `src/heroes.js`

**(a) `HeroBot` 构造（:83）追加字段**

```js
constructor(game, scene, assets, effects, audio, ui, { operator, team, name, netId = 0, netDriven = false, kind = 'bot', spawnBase = null }) {
  ...
  this.kind = kind;            // 'bot' | 'human'
  this.netId = netId;          // 网络 id（0 = 本地 AI）
  this.netDriven = netDriven;  // true = 位置由快照驱动
  this.netBuf = null;          // interp.SnapshotBuffer
  this.spawnBase = spawnBase;  // 复活基点（null = game.spawns[team]）
}
```

**(b) `update()`（:584）首行分流**

```js
update(dt, time, losCheck) {
  if (this.netDriven) return this._updateNet(dt, time);
  ...原有逻辑不变
}
```

**(c) 新增 `_updateNet / _netDie / _netRevive`**（放 `_animate` 之后）

```js
_updateNet(dt, time) {
  const s = this.netBuf && this.netBuf.sample(this.game.netMatch.renderTime(this.kind), this.kind);
  if (!s) { this.group.visible = false; return; }
  const dx = s.x - this.pos.x, dz = s.z - this.pos.z;
  this.vel.set(dt > 0 ? dx / dt : 0, 0, dt > 0 ? dz / dt : 0);
  this.pos.set(s.x, s.y, s.z); this.yaw = s.yaw;
  const alive = !!s.alive, wasAlive = this.alive;
  if (wasAlive && !alive) this._netDie();
  if (!wasAlive && alive) this._netRevive();
  this.alive = alive;
  if (this.hp !== s.hp && this.nameTag && this.nameTag.bar)
    this.nameTag.bar.scale.x = Math.max(.001, Math.min(1, s.hp / this.maxHp));
  this.hp = s.hp;
  const spd = this.vel.length();
  this.moving = spd > .5;
  this.group.visible = true;
  this._animate(dt, time, spd);
  this.group.position.set(this.pos.x, this.pos.y, this.pos.z);
  this.group.rotation.set(alive ? 0 : -Math.PI / 2.2, this.yaw, 0);
}
_netDie() {
  if (this.state === 'dying' || this.state === 'dead') return;
  this.alive = false; this.state = 'dying'; this.deathT = 0; this.dropRifle();
}
_netRevive() { this.state = 'active'; this.deathT = 0; this._restoreFlash(); this.group.visible = true; }
```

**(d) `die()`（:235）** 在**任何记分回调之前**短路远程代理：

```js
die(byName, headshot = false) {
  if (!this.alive) return;
  if (this.netDriven) { this._netDie(); return; }   // 远程死亡由 DO 的 s:kill 广播，本地不记分
  ...原有逻辑
}
```

**(e) `takeDamage()`（:218）** 顶部路由：

```js
if (this.netDriven) {
  if (this.game.netMatch) this.game.netMatch.requestHit(this, n, fromName, headshot);
  return -1;                                       // 本地不改血，等被击方确认
}
```

**(f) 目标选择（:669）** 只改一处条件（本地玩家可能在 B 队）：

```js
if (this.team !== this.game.playerTeam && this.game.player.alive) { ...'player' 哨兵不变... }
```

**(g) `_shoot()`（:1055）** 不改：`target.takeDamage` 对 netDriven 自动走网络；`target === 'player'` 分支保留（本地玩家不在 `heroes.list`）。

**(h) `_separate()`（:1244）** 任一方 netDriven 时只推非 netDriven 的那一个（代理位置是别人权威的）；玩家推挤段同样跳过 netDriven。

**(i) `respawn()`（:297-325）** 基点改为：

```js
const base = this.spawnBase || (this.game.spawns ? this.game.spawns[this.team] : (this.team === 'A' ? _BASE_A : _BASE_B));
```

**(j) `HeroTeam.setup()` 参数化（:1192）**

```js
setup(playerFaction = 'ct', playerName = '', playerOpId = DEFAULT_OP, opts = {}) {
  const hasOpts = opts && (opts.sizes || opts.roster || opts.bots || opts.humans || opts.playerTeam);
  if (!hasOpts) { /* 原分支原样保留：3 + 4，保证 tests/heroes.test.mjs:57、e2e operators-8 */ }
  const { sizes = { A: 4, B: 4 }, humans = { A: 0, B: 0 }, playerTeam = 'A',
          roster = [], bots = [] } = opts;
  // 远程真人（来自服务器名册）
  for (const r of roster) { /* 建 HeroBot({netDriven:true, kind:'human', netId:r.netId}) → list.push */ }
  // 房主模拟的 AI
  for (const b of bots) { /* 建 HeroBot({netDriven:!isHost, kind:'bot', netId:b.netId, spawnBase:game.spawns[b.team]}) */ }
  // 仍然缺人的位置（单人训练 / 非房主本地 AI 兜底）：
  //   botsPerTeam[t] = sizes[t] - humans[t] - (playerTeam === t ? 1 : 0)
  // 名字进入同一个 used 集合去重（远程真人先占名）
}
```

**(k) 新增 `HeroTeam.adopt(hero)`**：`this.list.push(hero); return hero;`（不清空；中途加入 / 房主迁移用）。

**(l) 新增 `HeroTeam.byNetId(id)`**：`return this.list.find(h => h.netId === id) || null;`

**(m) `HeroTeam.update()`（:1229）**

```js
for (const h of this.list) h.netDriven ? h._updateNet(dt, time) : h.update(dt, time, losCheck);
this._separate();
for (const h of this.list) if (h._sepDirty) { h._sepDirty = false; if (h.alive && !h.netDriven) h._collide(this.game.world.colliders); }
```

### 4.2 `src/main.js`

| 位置 | 改动 |
|---|---|
| 构造（:52-89） | 加 `this.netMatch = null; this.spawns = { A: new THREE.Vector3(0,0,24), B: new THREE.Vector3(0,0,-24) }; this._uiLock = false;`；`this.playerTeam` 移到 `startGame()` 派生 |
| 新助手 | `isArena() { return ['dm','koth','online'].includes(this.mode); }`；替换 :807/:836/:996/:1022/:1078/:1105 的 `mode==='dm'||mode==='koth'` |
| `startGame()`（:474） | 抽 `_resetForMatch()`（:486-518 公共部分）与 `_seedMatch({rows,timer,winKills})`；新增 `mode==='online'` 分支：读 `this._pendingNet` → `playerTeam = pm.team`、`playerFaction = pm.faction`、地图 `pm.map`、`heroes.setup(pm.faction, name, opId, pm.setup)`、`spawnCombatants(this, pm.setup)`；联机跳过教程 |
| `fire()`（:623） | 保留射线；`playerTeam` 过滤已正确（派生后） |
| `onHeroKill()`（:806） | 首行 `if (this.netMatch && this.netMatch.active) return;`（DO 广播 `s:kill` 后由 `netMatch._onKill` 写分与 killfeed） |
| `damagePlayerFromBot()`（:825） | 改名 `damagePlayer(dmg, from, head)`，保留旧名 `damagePlayerFromBot(dmg, name, pos) { return this.damagePlayer(dmg, { name, pos }); }`；`from = { id, name, pos }`；god/invuln/HUD/lastKiller/spectate 全保留；死亡时：离线走原记分，联机调 `netMatch.reportLocalDeath(from.id, this.weapon.def.id)` |
| `_factionLabels()`（:873） | 联机固定 `{ A: t('faction_ct'), B: t('faction_t') }`；离线保持按 `playerFaction` 翻转 |
| `_checkDmWin()`（:878） | 首行 `if (this.netMatch && this.netMatch.active) return;` |
| `_endDm()` / `_endMode()` | 抽 `_resultBoard()`；新增 `_endOnline({ win, rows, score })`：同样 `showOver`，但**不写 `o07_best`、不提交 leaderboard**，按钮「返回房间 / 主菜单」 |
| `_awardProgress()`（:926） | 接受 `{ score, skipBest }`；联机只用 DO 击杀数发 XP |
| `tick()`（:960） | ① 计时：联机不本地递减，用 `netMatch.left`；② `this.netMatch?.tick(dt)`；③ `heroes.update` 前置 `netSim` 判断；④ 复活点 `this.spawns[this.playerTeam]`；⑤ `if (this._uiLock)` 时跳过 `player.update / weapon.update`（远端仍插值）；⑥ 开局 3 s 倒计时冻结输入 |
| `_boot()`（:93-300） | `m-start`：`sel.mode === 'online'` → `netMatch.openLobby()`；否则原 `startGame()`；接线 `?room=`、`?server=`、`?net=loopback`、`?shot=online|online-remotes`；`p-leave` 按钮 → `netMatch.leave()` |
| 新增 `netMenu()` | 联机 ESC：`state='paused'` + `_uiLock=true` + 清 `keys/_mouseFire/_mouseAds/input`；展示 `pause_net_note`（对局继续，你的角色原地待命） |
| `pause()/resume()/toMenu()` | `toMenu()` 先 `this.netMatch?.leave()`；`resume()` 清 `_uiLock`；`pause()` 联机时改调 `netMenu()` |

### 4.3 `src/ui.js`

- `:70` `KOK = ['waves','dm','koth','online']`
- `:305` `showOnly` 支持 `'lobby'`；`setDmMode(true)` 用于 online
- 新增 `setNetPill(state, text)`（`#net-pill`，state ∈ ok/bad/warn）
- 新增 `setNetMode(on)`（暂停面板换文案与按钮）
- 新增 `updateLobby(room, meId)` / `lobbyError(key)` / `hideLobby()`
- `killFeed`（:396）：武器名为空时不输出 `[weapon]` 括号
- `scoreboard`（:415）：行可带 `ping`；名字继续 `escHTML`

### 4.4 `src/template.html`

```html
<!-- #m-modes 末尾新增（4v4 死斗 chip 原样保留） -->
<div class="chip" data-mode="online">Friends 5v5 · Online</div>

<!-- #hud 右上角 -->
<div id="net-pill" class="hidden"></div>

<!-- #pause 内新增 -->
<button id="p-leave" class="btn hidden" data-i="pause_leave">LEAVE MATCH</button>

<!-- 新覆盖层（与 #menu/#pause 同级） -->
<div id="lobby" class="overlay hidden">
  <div class="lobby-box">
    <div class="lobby-head"><span data-i="lobby_title">FRIENDS 5v5</span><span id="lobby-pill"></span></div>
    <div id="lobby-status"></div>
    <div id="lobby-home">
      <button id="lobby-create" class="btn-primary" data-i="lobby_create">CREATE ROOM</button>
      <input id="lobby-code" maxlength="5" placeholder="ROOM CODE">
      <button id="lobby-join" class="btn" data-i="lobby_join">JOIN</button>
      <button id="lobby-solo" class="btn" data-i="lobby_solo">SOLO TRAINING (AI 5v5)</button>
    </div>
    <div id="lobby-room" class="hidden">
      <div class="lobby-code"><b id="lobby-code-val"></b><button id="lobby-copy" data-i="lobby_copy">COPY LINK</button></div>
      <div class="lobby-teams"><div class="team-a" id="lobby-team-a"></div><div class="team-b" id="lobby-team-b"></div></div>
      <div class="lobby-actions">
        <select id="lobby-map"></select>
        <button id="lobby-ready" class="btn" data-i="lobby_ready">READY</button>
        <button id="lobby-start" class="btn-primary hidden" data-i="lobby_start">START</button>
        <button id="lobby-leave" class="btn" data-i="lobby_leave">LEAVE</button>
      </div>
    </div>
  </div>
</div>
```

### 4.5 `src/i18n.js`

zh / en 各新增（键名一致，新增测试 `tests/i18n-parity` 校验）：

```
mode_online, lobby_title, lobby_create, lobby_join, lobby_code_ph, lobby_copy, lobby_ready,
lobby_unready, lobby_start, lobby_leave, lobby_teams, lobby_host, lobby_waiting, lobby_solo,
net_connecting, net_connected, net_reconnecting, net_lost, net_server_unset, net_full,
net_bad_code, net_proto, pause_net_note, pause_leave, sb_ping, online_start, online_sub,
online_over_kicker
```

同时把 `dm_sub`（当前写死“3v3 / First to 25 kills”）改为占位符化：`'对局开始 · {a}v{b} · 3 分钟 · 先到 {k} 击杀'`，供 4v4 死斗与 5v5 联机共用。

### 4.6 `src/input.js`

- `pointerlockchange`（:109）：`if (g.netMatch?.active && g.state === 'playing') { g.netMenu(); return; }`
- `Tab`（:42）：`['dm','koth','online'].includes(g.mode)`
- keydown / mousedown / mousemove / wheel 首行 `if (g._uiLock) return;`

### 4.7 `build.mjs` / `package.json`

```js
// build.mjs
define: {
  'process.env.NODE_ENV': '"production"',
  __GTG_SERVER__: JSON.stringify(process.env.GTG_SERVER || ''),
},
// 构建末尾
if (!process.env.GTG_SERVER) console.log('· GTG_SERVER 未设置：联机模式会提示「服务器未配置」，离线玩法不受影响');
```

```json
{
  "version": "1.11.0",
  "scripts": {
    "server:dev": "npx wrangler dev --local --config server/wrangler.toml",
    "server:deploy": "npx wrangler deploy --config server/wrangler.toml"
  }
}
```

（`wrangler` 不加入 `dependencies`，用 `npx` 按需拉取，避免增大游戏构建依赖。）

---

## 5. 协议表

### 客户端 → DO

| type | 字段 | 频率 | 体积 |
|---|---|---|---|
| `c:create` | `name, op, camo, map, ver` | 一次 | ~80 B |
| `c:join` | `code, name, op, camo, token?` | 一次 / 重连 | ~80 B |
| `c:ready` | `r:0|1` | 点击 | 20 B |
| `c:side` | `team:'A'|'B', op` | 点击 | 40 B |
| `c:start` | `{}`（仅房主） | 点击 | 10 B |
| `c:rematch` | `{}`（仅房主） | 点击 | 10 B |
| `c:snap` | `s:[id,x,y,z,yaw,pitch,hp,flags]` | **15 Hz** | 60–90 B |
| `c:hit` | `target:<id>, dmg, head, w` | 事件 | ~50 B |
| `c:died` | `killer:<id>, head, w, seq` | 事件 | ~50 B |
| `c:botSnap` | `b:[[id,x,y,z,yaw,hp,alive],…]`（仅房主） | **12 Hz** | ~360 B |
| `c:botDeath` | `bot:<id>, killer:<id>`（仅房主） | 事件 | ~40 B |
| `c:fx` | `k:'shot'|'nade', x,y,z,dx,dy,dz,w`（合并 ≤20/s） | 事件 | ~60 B |
| `c:ping` | `c:timestamp` | 1 Hz | 20 B |
| `c:leave` | `{}` | 一次 | 10 B |

### DO → 客户端

| type | 字段 | 频率 |
|---|---|---|
| `s:hello` | `id, proto` | 连接时 |
| `s:room` | `code, hostId, phase, map, sizes:{A:5,B:5}, roster[], score:{A,B}, left, winKills` | 加入 + 名册/阶段变化 |
| `s:start` | `map, startAt, duration, winKills, roster, bots[]` | 一次 |
| `s:peers` | `t, p:[[…],…]`（不含收件人） | 12–15 Hz |
| `s:bots` | `t, b:[[…],…]` | 12 Hz |
| `s:hit` | `from, fromName, dmg, head, w`（定向） | 事件 |
| `s:kill` | `killer, victim, w, head, score` | 事件 |
| `s:tick` | `t, left` | 1 Hz |
| `s:end` | `win, reason:'kills'|'time'|'noHost', rows, score` | 一次 |
| `s:host` | `hostId` | 选举时 |
| `s:peerLeft/Joined` | `id` | 事件 |
| `s:err` | `code:'full'|'badCode'|'proto'|'rate'|'kicked', msg` | 事件 |
| `s:pong` | `c, srv` | 1 Hz |

**带宽**：每真人约 3.5 KB/s 下行、1.5–1.9 KB/s 上行；10 人房间扇出约 30–35 KB/s。单连接 32 msg/s / 4 KB；房间 300 msg/s。

---

## 6. 队伍与玩家身份（最易踩坑处）

- **在线**：A = 新星(ct)，B = 浪人(t)，**固定**。`this.playerTeam = pm.team`，`playerFaction = team === 'A' ? 'ct' : 't'`。
- **离线**：沿用现状（A = 玩家阵营，`_factionLabels()` 翻转）。
- 换边 = 换 `ui.sel.operator` 到该阵营干员（`selectOperator` 已处理主武器回退）。
- 玩家复活点：`this.spawns[this.playerTeam]` + ±3 m 抖动（现 `main.js:1000` 硬编码 `z=24` 必须改）。
- 机器人复活点：`this.spawnBase || game.spawns[this.team]`（`heroes.js:297-325`）。
- 记分：联机时 `dm.scores` 以 DO 的 `s:room` / `s:kill` 为准镜像；key 仍是名字（DO 已去重），行内额外存 `id`。

---

## 7. 大厅与对局流程

1. **建房**：菜单选 `Friends 5v5` → DEPLOY → `#lobby`。未配置服务器：显示 `net_server_unset` + 配置方法，仍可点「单人训练（AI 补满 5v5）」。
2. **加入**：输入 5 位码，或打开邀请链接 `…?room=CODE`（自动填入并加入）。
3. **分边**：进房自动到人少一队；可点另一队换边（<5 才允许）；房主可指定他人。
4. **准备 / 开始**：真人准备 → 房主选图、选 AI 难度、START → `s:start`（`startAt = now + 3000`）→ 各端 `startGame()`，3 s 倒计时冻结输入。
5. **AI 补位**：`bots[t] = 5 - humans[t]`，房主创建并模拟，其余端建代理。
6. **对局中**：15 Hz 上行、12 Hz 机器人下行、1 Hz tick/ping；击杀由 DO 广播。
7. **中途加入**：有人离开腾出真人位才进场；否则观战，下一局入场。
8. **离开**：`c:leave`；对局中 20 s 宽限（token 续位），超时房主补 AI。
9. **房主掉线**：DO 按加入顺序推举下一名在线真人 → `s:host`；新房主 `becomeHost()` → `promoteToSimulated()` 接管所有机器人（保留位置/血量）；**10 s 无人接管** → `s:end reason:'noHost'` 回大厅。
10. **结束**：`s:end` → `_endOnline()` 结果页（同一套表格，DO 数据），「返回房间 / 主菜单」；房主可 REMATCH。

---

## 8. 反作弊边界（明确告知，可接受）

| 层 | 权威方 | 风险 |
|---|---|---|
| 位置 / 移动 | 各客户端自己 | 加速 / 瞬移 |
| 玩家血量 | 被击方客户端 | 无限血 |
| 伤害数值 | 攻击方（DO 只钳上限） | 伤害注入 |
| 机器人 | 房主 | 房主可作弊（本地模拟） |
| 击杀 / 死亡 / 计时 / 胜负 / 名册 | DO | — |
| XP / `o07_best` / 排行榜 | 本机；联机**不写 best、不提交排行榜** | 不污染离线进度 |

低成本缓解（随版本做）：`HIT_DMG_CAP` 钳制、每秒命中限流、拒绝已死/未知目标、`died` 单调 `seq` 去重、名册名唯一、仅房间码可进、单连接 32 msg/s + 4 KB 上限、房主 250 ms 命中历史校验。

---

## 9. 分阶段交付与验收

### Stage A — 可离线验证的 5v5 底座（M，约 2 天）

改动：`heroes.js` 参数化 setup / spawnBase / netDriven 骨架；`main.js` `isArena()`、`spawns`、`playerTeam` 派生、`_resetForMatch/_seedMatch`；`interp.js`；`remotePlayers.js`；`online` 模式 + 单人训练；`?shot=online|online-remotes`。

验收：
- `npm test` 旧用例全绿（默认 3+4 不变）。新增：
  - `tests/heroes.test.mjs`：`setup(...,{sizes:{A:5,B:5},playerTeam:'A'})` → 9 个、A=4/B=5、名字唯一、`spawnBase` 生效；`humans:{A:2,B:1}` → bots 2/4；本地浪人时 `playerTeam='B'`。
  - `tests/interp.test.mjs`：alpha 0/0.5/1、yaw 跨 ±π、外推钳制、>8 m 吸附、`TimeSync` EWMA。
- `?e2e=1` 新增：`online-5v5-ai`、`online-rogue-side`、`remote-avatar-interp`、`remote-avatar-hit-routes`、`net-zero-offline`。
- 回归必须绿：`operators-8`、`bot-separate-4v4`、`bot-spawn-4maps`、`memory-stable`。

### Stage B — 房间服务 + 大厅（L，约 5 天）

改动：`netProtocol.js`、`server/{room.js,worker.js,wrangler.toml,README.md}`、`net.js`、`netLobby.js`、`#lobby`、`?room=`。

验收：
- 新 `tests/netRoom.test.mjs`：建房/加入、房间码正则、重名去重、自动平衡与 5 人上限、满员、准备→开始、bot 数、`recordKill` 钳制与 seq 去重、超时、房主选举、`toJSON/fromJSON` 往返。
- 新 `tests/netClient.test.mjs`（假 `wsFactory`）：URL 优先级、连接中入队、退避序列、token 重连、未 `connect()` 时 `socketsOpened === 0`、畸形帧不抛。
- `?e2e=1&net=loopback`：建房码合法 → 假对端加入 → 名册 2 → 换边 → 双方准备 → 房主开始 → 地图与 bot 数正确 → 对端离开名册缩减 → `s:host` 翻转 `isHost`。
- 手工：`npm run server:dev` + 两个浏览器 `?server=ws://127.0.0.1:8787`。

### Stage C — 对局同步（L，约 5 天）

改动：`netMatch.js` 全程、命中路由、房主命中校验、DO 击杀/计时广播、联机暂停面板、离开/再战、`_endOnline()`。

验收（`?e2e=1&net=loopback` 脚本化假对端）：
`net-snapshot-out`、`net-peer-moves`、`net-kill-relayed`、`net-local-death`、`net-host-bots`、`net-end`（`o07_best` 未变、不调 leaderboard）、`net-pause-continues`、`net-xss`。
单元：机器人代理 序列化→应用 往返；命中历史校验接受 150 ms 迟到、拒绝已死目标；量化 9 人批次 < 260 B。

### Stage D — 迁移、健壮性、文档（M，约 2.5 天）

改动：`becomeHost()`、token 续位、离场补 AI、DO 存储 / `alarm` TTL、`proto` 不匹配提示（复用 `#sw-toast`）、README/架构图、版本号。

验收：`net-host-migration`、`net-reconnect`、`net-bad-messages`、`net-rate-limit`；手工 3 浏览器杀房主标签页验证 AI 继续；`wrangler tail` 观察空置 60 s eviction。

---

## 10. 风险与对策

1. **单示例 / 单 canvas**：e2e 一律 `?net=loopback` 注入消息，绝不 new 第二个 `Game`。
2. **指针锁定需手势**：`s:start` 异步到达 → 走既有 `pointerlockerror → fallbackAim` + 3 s「点击进入」提示；倒计时冻结保证公平。
3. **ESC 自动暂停**：联机必须 `netMenu()`，否则只冻自己造成不同步；`_uiLock` 同时挡住手柄/触屏适配器写 `game.input`。
4. **复活点硬编码**：`main.js:1000`（`z=24`）与 `heroes.js:317`（±24）必须改 `spawns[team]`。
5. **`playerTeam='A'` 构造期写死**：联机必须派生，否则 `fire()` 友伤过滤把队友当敌人。
6. **名字做 Map key**：DO 去重；联机路径以 `id` 为准，名字只用于显示（全部 `escHTML`）。
7. **非确定性模拟**：不做 lockstep，只做快照；机器人难度只认房主。
8. **PWA 缓存旧 HTML 连新服务器**：`s:hello.proto` 不匹配 → 明确提示刷新，不静默失败。
9. **DO 计费 / 休眠**：10 人 15 Hz ≈ 150 msg/s/房；用 Hibernation API、1 Hz ping、只在离散事件落盘；README 写额度估算；SQLite DO 迁移按当前官方文档核对。
10. **体积**：新增客户端约 50 KB 源码 / ~18 KB min，安全；严禁 `src/` 引入 `server/room.js`。
11. **既有 e2e 反复调 `startGame()`（约 30 处）**：所有联机逻辑必须被 `this.netMatch` 守卫，离线路径零行为变化。
12. **混合内容**：GitHub Pages 是 https，只能连 `wss://`；`ws://` 仅本地开发。
13. **`o07_mode` 持久化 `online`**：刷新后停在联机 chip，大厅必须可进入且未配置服务器时给出明确提示，**不自动连接**。
14. **`_separate` / RVO 与插值体**：netDriven 条目不接受本地位移，但房主机器人的 RVO 仍要感知它们。
15. **`refreshModels`**：`adopt()` 不能让 GLB 到达后的重建绕过，远程头像同样要收敛到 GLB。

---

## 11. 提交拆分（每步绿：`npm test` + `npm run build`）

1. `docs: 好友对战 5v5 在线设计文档`
2. `feat(heroes): 队伍规模参数化、复活点、网络驱动机器人骨架` (+ tests)
3. `feat(vs): 联机 5v5 底座与单人训练（AI 补满），插值模块` (+ tests)
4. `feat(net): 协议与插值原语` (+ tests)
5. `feat(net): 远程头像渲染与快照落地，?shot=online-remotes`
6. `feat(server): 纯房间核心` (+ `tests/netRoom.test.mjs`)
7. `feat(server): Cloudflare Worker + Durable Object 适配层、wrangler 配置与部署文档`
8. `feat(net): NetClient 传输、服务器地址解析、重连` (+ tests)
9. `feat(ui): 大厅界面、?room= 深链、i18n`
10. `feat(net): 大厅→对局接线、快照交换、命中与击杀路由`
11. `feat(net): 房主机器人模拟、复制与命中校验窗口`
12. `feat(net): 房主迁移、重连续位、联机暂停面板、在线结算`
13. `chore(release): v1.11.0，README 架构与服务器文档`

---

## 12. 验证方式（本机可复现）

```bash
cd "D:/software develop/网页游戏《GUNTOGUN》"
npm test                       # 单元测试（含新增 interp / netRoom / netClient）
npm run build                  # 产出 dist/gun-to-gun.html，确认 < 5 MB
npm run serve                  # http://127.0.0.1:8137/

# 浏览器
#   ?e2e=1                 全量断言
#   ?e2e=1&net=loopback    联机断言（无需服务器）
#   ?shot=online-remotes   截图核对远程头像

npm run server:dev             # wrangler dev，另开两个浏览器窗口
# http://127.0.0.1:8137/?server=ws://127.0.0.1:8787 → 建房 / 输入房号 → 双方准备 → 开局
npm run server:deploy          # 部署到 Cloudflare
GTG_SERVER=wss://<worker>.workers.dev npm run build   # 正式构建注入服务器地址
```

**人工验收清单**

- 两个浏览器各 1 真人 + AI 补满两队，互相能看到移动 / 射击 / 死亡 / 复活。
- TAB 记分板双方数字一致；结算页数据来自服务器。
- 一人断网 5 s 能续回（token 续位）。
- 房主关标签页后对局继续（AI 由新房主接管）；10 s 内无人接管则回大厅。
- 离线三模式与刷新后离线游玩无任何变化；不选联机时无任何网络请求。
