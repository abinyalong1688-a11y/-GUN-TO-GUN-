# GUNTOGUN 前端代码质量审计报告

> 审计日期：2026-11-24
> 审查对象：`C:/Users/shisunbin/.local/share/opencode/worktree/2a4dd0/crisp-comet`（GUNTOGUN v1.11.0，对应仓库 `D:/software develop/网页游戏《GUNTOGUN》`）
> 审计方式：静态代码审查（39 个 JS 模块 / 19 个测试文件）+ 复现 opencode 上一轮会话中的浏览器实测数据
> 范围边界：以客户端前端为主；因“网络数据包伪造 / 命中判定客户端权威性”属于指定审查维度，联机服务端 `server/worker.js`、`server/room.js` 一并纳入，并单独标注责任方。

---

## 一、技术栈判定（对应审查维度“请指定”）

| 项 | 判定 | 证据 |
|---|---|---|
| 渲染引擎 | **Three.js r170**（`three@^0.170.0`） | `package.json`、`import * as THREE from 'three'` |
| 物理引擎 | **无 Cannon/Ammo**，自研 AABB + 圆碰撞 + Raycaster | `src/player.js:81-108`、`src/world.js:62-74`、`src/main.js:786-789` |
| 语言 | **原生 JavaScript ESM，无 TypeScript、无 JSDoc 类型标注** | 全仓无 `.ts`、无 `@type` |
| 构建/运行 | esbuild 单文件构建 + Cloudflare Durable Object 联机 + PWA | `build.mjs`、`server/wrangler.toml`、`src/sw.js` |
| 测试 | `node:test` 19 文件 / 113 用例 + 游戏内 `?selftest` 70 项 + `?e2e=1` | `tests/`、`src/main.js:1500+`、`.github/workflows/ci.yml` |

---

## 二、执行摘要

**综合评分：7.0 / 10**（可玩性与工程基建扎实，安全与资源生命周期未达生产级）

- 共记录 **17 项问题**：P0 × 2、P1 × 6、P2 × 9。
- 上一轮 opencode 会话因免费额度中断在“纹理泄漏定位”环节，本报告补齐该调查，并给出可复测的量化数据。
- 已确认 **不存在** XSS 漏网（昵称、房间码、记分板全部转义）；循环依赖为 0；单文件体积门禁、CI、70 项浏览器自检均有效。
- 最需要立刻处理的三件事见文末 **Top3**。

---

## 三、问题清单

## P0 · 高危阻断

### P0-1 联机命中包完全客户端权威，服务端不校验目标/存活/武器/频率
**定位**：`server/worker.js:145-148`（`case C.HIT` 仅检查 joined）、`server/worker.js:188-206`（`relayHit`）；`src/netMatch.js:213-220`（客户端 `requestHit`）；`src/netProtocol.js:38-40`（`HIT_DMG_CAP`）、`:66-67`（`isValidMsg` 只检查 `t`）。

**描述**：攻击者加入房间后可直接构造 `c:hit` 帧，把任意 human id 或 `b*`（bot id）写进 `target`。服务端只做 `+m.dmg||0` 与 `HIT_DMG_CAP[m.w] || 200` 的夹取，不验证：射手是否存活（`pending` 快照的 `flags & ALIVE` 被丢弃）、目标是否存在且存活、武器是否属于射手当前配枪、射手与目标的距离/视线、命中间隔。字段 `dmgAt` 只在 `worker.js:42` 初始化，全生命周期从未读写，是死代码；唯一限流是 32 msg/s 的通用令牌桶，按 AWP 350 上限计算，理论上 1 秒可打掉 11,200 点血。

**影响范围**：所有在线对战；任意参与者可瞬间击杀全场玩家、给 bot 目标注入假伤害，比赛公平性完全失效。前端 `?server=` 可指向任意服务器（`src/net.js:7-15`），恶意服还可直接下发超大/NaN 伤害（见 P1-6）。

**修复方案**：服务端建立最小权威性校验，顺序为：房间阶段 → 射手存活 → 目标存在且存活 → 武器白名单 → 射速间隔 → seq 去重 → 距离/视线 → 夹取伤害。

```js
case C.HIT: {
  if (!at.joined || this.state.phase !== 'live') return;
  const shooter = this.pending.get(at.id);
  const snap = shooter && decodePeer(shooter.p);
  if (!snap || !(snap.flags & PEER_FLAGS.ALIVE)) return;   // 死者不能开火
  const target = this.state.humans[m.target];
  if (!target || !target.alive) return;                    // 目标存在性
  const w = WEAPON_DEFS[m.w];
  if (!w) return;                                          // 武器白名单
  const now = Date.now();
  if (now - at.dmgAt < (60 / w.rpm) * 1000 * 0.8) return;  // 射速下限
  if (m.seq <= (this.seenHit[at.id] || 0)) return;         // 重放保护
  this.seenHit[at.id] = m.seq; at.dmgAt = now;
  // 距离/视线用与客户端共享的 collider 集合做射线，之后再 clamp 并转发
  return this.relayHit(at, m, snap);
}
```

---

### P0-2 `C.BOT_DEATH` 可无限刷分并在一帧内结束比赛
**定位**：`server/worker.js:164-177`；`server/room.js:98-104`（`isBotVictim` 分支与结束判定）；`src/netProtocol.js:8`（`winKills=25`）。

**描述**：`C.BOT_DEATH` 只校验发送者是 host。服务端不检查 `m.bot` 是否属于 `state.bots`、该 bot 是否还活着、`killer` 是否等于上报者，`seq` 被硬编码为 `0`，直接跳过 `room.js:92-96` 的去重。因此 host 可以任意字符串 `bxxx` 为 victim、以自己为 killer 重复加分，直到触发 `winKills=25` 结束比赛并判己方获胜。

**影响范围**：所有联机房间；房主可单方面操纵比分与胜负。即使房主是“可信玩家”，其客户端被攻破后同样可利用。

**修复方案**：服务端维护 bot 存活状态；校验 victim 存在且 alive、killer 为上报者本人、seq 有效且递增；击杀后由服务端置 bot dead 并广播。

```js
case C.BOT_DEATH: {
  if (!at.joined || this.state.hostId !== at.id || this.state.phase !== 'live') return;
  const victim = this.state.bots[m.bot];
  if (!victim || !victim.alive) return;
  if (m.killer !== at.id) return;
  const seq = m.seq | 0;
  if (seq <= (this.seenBotDeath[at.id] || 0)) return;
  this.seenBotDeath[at.id] = seq;
  victim.alive = false;                 // 服务端状态权威
  const r = R.recordKill(this.state, { killerId:at.id, victimId:m.bot,
    killerName:this.nameOf(at.id), victimName:victim.name, weapon:m.w, seq });
  ...
}
```

---

## P1 · 中危严重

### P1-1 玩家死亡后仍可开火并造成真实伤害（已浏览器复现）
**定位**：`src/main.js:1185`、`src/main.js:1216-1220`、`src/main.js:1280-1294`；`src/weapon.js:606-611`；`src/input.js:111-120`；`src/main.js:770-783`。

**描述**：`tick()` 的 `active` 只判断 `state === playing | dying`，门控仅 `_uiLock`，不含 `player.alive`。竞技场死亡分支设置 `dmRespawnT=2.5` 并主动置 `_suppressPauseOnce=true`（目的只是跳过暂停），既不清理 `input.firing`，也不阻止 `weapon.update`；`weapon.js:608` 的 `canFire` 只看换弹/弹药/冲刺。上一轮实测：死亡后 1.3 秒内连开 4 枪，弹匣 30→26；另一次 0.67 秒内 8 枪，30→22。

**影响范围**：单人 DM 可在死亡回放期间击杀敌人；联机模式下死亡玩家仍可发 `c:hit`（与 P0-1 叠加），属于可利用的竞技漏洞。

**修复方案**：在两处同时加生命状态门控，并在死亡时清空输入锁存。

```js
// main.js tick
if (!this._uiLock && this.player.alive) {
  this.player.update(...);
  this.weapon.update(...);
}
// main.js 死亡分支
this.input.firing = false; this._mouseFire = false;
this.weapon.cancelFire?.();

// weapon.js
const canFire = !this.reloading && s.ammo > 0 && !player.sprinting && player.alive !== false;
```

---

### P1-2 后坐力只作用于相机，弹道使用未叠加的 player.pitch/yaw
**定位**：`src/main.js:1254-1266`（`camera.rotation.x += kick`）；`src/main.js:775-783`（弹道用 `pl.yaw/pl.pitch`）；`src/weapon.js:618-623,651-655`（camKick 增量与衰减）；`src/player.js:187-191`（权威角度每帧重置相机）。

**描述**：代码注释明确这是“射击用权威角度、视觉用相机后坐力”的行业取舍，因此属于设计决策而非纯 bug；但 `camKick` 在连发时会收敛到增量≈衰减的平衡点，实测约 1.6°，即 10 m 处约 28 cm、30 m 处约 84 cm 的准星-落点偏差。当前实现既没有后坐力回正（recoil recovery）反馈给玩家，也没有把视觉偏移反映到命中判定，玩家感知为“明明瞄准了却打空”。

**影响范围**：全模式全自动武器手感与命中预期；AWP/爆头判定尤甚。

**修复方案**：二选一并写进设计文档：① 弹道方向叠加 `camKick`（真正“所见即所得”）；② 保持权威角度，但把相机后坐力限制在纯视觉小量并加入可见的枪口上跳/回落动画，且弹道扩散随连发上升。下面给出方案①的最小改法。

```js
// fire(dir) 之前，把当前视觉后坐力折算进弹道
const kick = this.weapon.camKick || 0, kickY = this.weapon.camKickYaw || 0;
const pitch = clamp(pl.pitch + kick, -1.553, 1.553);
const yaw   = pl.yaw + kickY;
const sp = Math.sin(pitch), cp = Math.cos(pitch);
const sy = Math.sin(yaw),   cy = Math.cos(yaw);
dir.set(-sy * cp, sp, -cy * cp).normalize();
```

---

### P1-3 纹理泄漏：每局净增约 7 张，菜单基线持续抬升（补齐中断调查）
**定位**：`src/heroes.js:34-57`（`makeNameTag` 每 bot 新建 256×64 `CanvasTexture`）、`:885-897`（`dispose` 释放 tex/材质）；`src/main.js:582-632,735-750`（startGame/toMenu 均 `heroes.clear()`）；`src/modelAssets.js:482-499`（实例克隆材质、纹理共享）。

**描述**：上一轮浏览器实测（4 次 DM 进出循环）：菜单 `renderer.info.memory.textures` 为 148 → 174 → 181 → 188 → 195，稳定 **+7/局**；单局开始时 +11，退出仅 -4。埋点显示每局确实有 7 张 256×64 CanvasTexture 被 `dispose()` 调用，但 GPU 计数未相应下降；进一步实验显示角色材质引用的共享贴图在 `clear()` 后仍被渲染器计数（手工 dispose 会让计数从 170 掉到 142，但那会错误释放共享缓存）。结论：**名字牌纹理与角色材质贴图的释放归属不清晰**，代码中虽有 `dispose()` 调用，但渲染器计数证明并未完整回收；根因需按下面方法在目标机器复测确认，不应简单把共享贴图全部 dispose。

**影响范围**：长时间挂机/反复重开后纹理与显存单调增长，低端移动设备会触发 WebGL context lost（当前策略是整机 reload，`main.js:135-141`）。

**修复方案**：名字牌按 `(name, faction)` 做模块级缓存，7 个 bot 共用少量纹理；把 per-instance 与 shared 贴图用 `userData.owned` 标记，释放时只处理 owned；在 `?e2e=1` 增加 10 次进出后 `textures <= baseline + 2` 的断言。

```js
const TAG_TEX = new Map();                       // 模块级缓存
function nameTagTexture(name, faction) {
  const key = name + '|' + faction;
  let t = TAG_TEX.get(key);
  if (!t) { /* ...画 canvas... */ t = new THREE.CanvasTexture(c); TAG_TEX.set(key, t); }
  return t;
}
// dispose 中只释放本实例独占资源；共享贴图在页面卸载时统一清空
dispose() {
  for (const m of this.materials) m.dispose();
  if (this.ownedTextures) for (const t of this.ownedTextures) t.dispose();
  this.nameTag = null;
}
```

---

### P1-4 命中盒与模型不符：颈部缝隙、蹲伏标志被忽略
**定位**：`src/heroes.js:184-189`（`hitSpheres` 头球 `r=.16`，身体球 `y+.95, r=.42`）；`src/main.js:760-768`（`_raySphere`）；`src/netProtocol.js:55`（`PEER_FLAGS.CROUCH`）、`src/netMatch.js:184-187`（发送）、`src/remotePlayers.js:50-53`（解码）、`src/heroes.js:819-867`（`_updateNet` 未读取 `crouch`）。

**描述**：头球底部约 1.44–1.48 m，身体球顶部 1.37 m，中间存在 **7–11 cm 的颈部命中缝隙**；身体球半径 .42 m 明显宽于肩宽，擦身而过也会判定命中。`CROUCH` 标志从协议到插值层一路保留，但 `heroes._updateNet` 只消费 x/y/z/yaw/pitch/hp/alive，远程蹲伏玩家外观仍站立、判定盒仍是站立高度（约 1.6 m 头位）。

**影响范围**：所有射击命中公平性；联机远端蹲伏玩家可被“站在原地”的判定盒击中，爆头率异常。

**修复方案**：用骨架锚点生成分段胶囊（头/躯干/四肢），按 `crouch` 调整锚点高度与 `_animate` 姿态；至少先保证头球与身体球在颈部连续（`body.r` 或 `body.c.y` 动态覆盖）。

```js
hitSpheres() {
  const crouch = this.netDriven && this._netState?.crouch ? .42 : 0; // 蹲伏降低 0.42m
  const hy = (this.headY || 1.6) - crouch;
  const by = .95 - crouch * .8;
  const br = Math.max(.42, hy - .16 - (by - .10)); // 头球底与身体球顶相接，消除颈部缝
  return [
    { c: _v1.set(this.pos.x, this.pos.y + hy, this.pos.z), r: .16, part: 'head' },
    { c: _v2.set(this.pos.x, this.pos.y + by, this.pos.z), r: br,  part: 'body' },
  ];
}
```

---

### P1-5 位置包完全客户端权威，无速度/边界合理性校验
**定位**：`server/worker.js:130-139`（`C.SNAP` 原样存 `m.s` 并广播）；`src/remotePlayers.js:44-55`（`decodePeer` 后直接入 `netBuf`）；`src/netProtocol.js:58-64`（仅量化，不 clamp）。

**描述**：服务端不校验坐标范围、单帧位移、垂直速度；客户端收到后只做插值（`SNAP_JUMP=8` 是视觉处理，不是安全校验）。恶意客户端可瞬移、飞行、穿墙到任意位置。

**影响范围**：联机模式的移动公平性；与 P0-1 组合可形成“透视+瞬移+瞬杀”完整作弊链。

**修复方案**：服务端做轻量物理合理性校验（速度上限、竞技场半径、Y 范围、最大高度），违例丢弃并降级；客户端对超大跳变直接忽略而非插值。

```js
const MAX_STEP = 7.8 * 0.12 + 0.6;              //  sprint 上限 × 最大快照间隔 + 容差
const prev = this.pending.get(at.id)?.p;
if (prev) {
  const d = Math.hypot(p.x - prev[1], p.y - prev[2], p.z - prev[3]) / 100;
  if (d > MAX_STEP) return;                      // 丢弃瞬移包
}
if (Math.hypot(p.x / 100, p.z / 100) > 57 || p.y / 100 < -1 || p.y / 100 > 12) return;
```

---

### P1-6 `S.HIT` 伤害前端零校验，NaN 可导致目标永久无敌
**定位**：`src/netMatch.js:73-76`（`g.damagePlayer(m.dmg, ...)` 原样透传）；`src/main.js:978-983`（`player.damage(dmg, ...)`）；`src/player.js:45-49`（`health = Math.max(0, health - n)`）。

**描述**：客户端完全信任服务端下发的 `dmg`。正规服务端在 `worker.js:190` 已 clamp 且把 NaN 归零，因此官方链路安全；但 `?server=` 可指向任意地址，恶意或被劫持服务端下发 `dmg: NaN` 时，`Math.max(0, NaN) = NaN`，玩家血量变 NaN 且 `health <= 0` 永远为 false，进入无法被击杀的卡状态；下发超大值则一击必杀。

**影响范围**：使用自定义服务器的联机对局；属于纵深防御缺失（主责服务端，前端次责）。

**修复方案**：接收端做有限数值与武器上限双重校验。

```js
c.on(S.HIT, m => {
  if (!Number.isFinite(m.dmg) || m.dmg < 0) return;
  const cap = HIT_DMG_CAP[m.w] || 200;
  if (m.bot) { applyHitToBot(g, m, Math.min(m.dmg, cap)); return; }
  g.damagePlayer(Math.min(m.dmg, cap), { id:m.from, name:m.fromName, pos:m.pos }, m.head, m.w);
});
```

---

## P2 · 低危优化

### P2-1 `Game` 上帝类与重复碰撞实现
**定位**：`src/main.js:56-2523`（单类约 2467 行）；`src/player.js:81-108` 与 `src/heroes.js:316-352`（两份圆-AABB 推出）；`src/player.js:54-65` 与 `:68-79`（`_supportY` / `_landingY` 近似重复）。

**描述**：39 个模块构成单向 DAG、无循环依赖，分层本身健康；但 `Game` 同时承担渲染初始化、射击射线、网络编排、主循环与 1000+ 行内嵌自检，任何改动都需要读完整文件。玩家与 Bot 的碰撞解算各写一份，半径与边界常量不一致（.4/.45、56/52），是缺陷易发点。项目无 TS/JSDoc，类型约定全靠命名与运行时防御。

**影响范围**：可维护性与回归风险；新功能交付速度。

**修复方案**：按 `GameLoop`、`CombatSystem`、`NetSession`、`SceneManager`、`Diagnostics` 拆分；把圆-AABB 提取到 `src/collision.js` 共用；至少给公开 API 补 JSDoc 类型。

```js
// src/collision.js
export function pushCircleOutAABB(pos, r, b) {
  const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
  let dx = pos.x - cx, dz = pos.z - cz, d = Math.hypot(dx, dz);
  if (d >= r) return false;
  if (d < 1e-6) { /* 沿最浅轴弹出 */ return true; }
  const k = (r - d) / d;
  pos.x += dx * k; pos.z += dz * k;
  return true;
}
```

---

### P2-2 热路径仍有 Vector3 分配
**定位**：`src/weapon.js:672`（`HIP_POS.clone().lerp(ADS_POS, ...)` 每帧）、`:700-712`（枪口闪光时 `tip.clone()`）、`:519-522`（`muzzleLocal` getter）；`src/heroes.js:184-189`（每次射线检测 new 2 个 Vector3）。

**描述**：项目已建立复用向量体系（`_sd/_sr/_muzzle/_pierceO` 等，`main.js:199-200`），但上述位置仍产生短生命周期对象。800 rpm × 9 个目标 × 2 球 ≈ 每秒数百次分配，年轻代 GC 压力可测。

**影响范围**：低端设备帧时间抖动；与“零分配热路径”的代码注释不符。

**修复方案**：模块级 scratch 向量，`copy().lerp()` 替代 `clone()`，`hitSpheres(out)` 写入调用方数组。

```js
const _target = new THREE.Vector3(), _tipW = new THREE.Vector3();
// update()
_target.copy(HIP_POS).lerp(ADS_POS, this.adsAmt);
// muzzle flash
this.flashLight.position.copy(this.group.localToWorld(_tipW.copy(tip)));
```

---

### P2-3 换弹中切枪留下“弹匣弹出/支援手下移”的姿态残留
**定位**：`src/weapon.js:489-503`（`switchTo` 直接 `reloading=false`）、`:593-598`（换弹动画改写 `ud.mag.position/rotation`、`ud.armSupport`）、`:504-516`（`_equip` 不复位）。

**描述**：换弹动画到一半切枪时，`drop` 停在 0~1 之间；切回该枪后弹匣仍处于下拉位置、支援手仍在下方，直到下一次完整换弹才恢复。

**影响范围**：视觉一致性；近距离观察明显。

**修复方案**：在 `_equip` 里显式复位每把枪的局部姿态。

```js
_equip(slot, instant) {
  // ...existing...
  for (const d of this.defs) {
    const ud = this.models[d.id]?.userData;
    if (ud?.mag && ud.magBase) {
      ud.mag.position.y = ud.magBase.y;
      ud.mag.rotation.z = ud.magBase.rz;
    }
    if (ud?.armSupport) { ud.armSupport.position.set(0, 0, 0); ud.armSupport.rotation.z = 0; }
  }
}
```

---

### P2-4 旋转盒用外接 AABB，角落出现隐形碰撞；disposeWorld 释放边界模糊
**定位**：`src/world.js:62-74`（`addBox` 的 `hx/hz` 为旋转盒投影）、`:249-251`（薄板同类近似）、`:790-800`（`disposeWorld` 遍历释放全部 geometry）。

**描述**：旋转盒的外接 AABB 大于真实 OBB，玩家会在视觉空白角落被挡住。当前 `world.group` 内几何均为现场 `new`，`ownMats` 也正确排除了共享材质，所以尚未发现误释放实例；但 `traverse` 无条件 `geometry.dispose()` 是脆弱约定，未来若把共享几何挂进 group 即会破坏其他场景。

**影响范围**：地图碰撞精度；资源管理可维护性。

**修复方案**：对明显旋转的盒子改用 OBB/SAT 或退化为多个小 AABB；给共享几何加 `userData.shared = true`，`disposeWorld` 跳过。

```js
if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
```

---

### P2-5 无页面可见性暂停；WebGL 上下文丢失靠整页重载
**定位**：`src/main.js:135-141`（`webglcontextlost` → 1.2s 后 `location.reload()`）；`src/input.js:111-120`（仅 `pointerlockchange`）；全仓无 `visibilitychange` / `webglcontextrestored`。

**描述**：桌面切标签通常因指针锁丢失而暂停，但 fallbackAim/触屏模式没有指针锁，切后台不会暂停游戏与音频；`clock.getDelta()` 上限 .05（`main.js:1145`）只防大步长，不解决后台继续跑逻辑。上下文丢失注释称“restored 后自动恢复”，实际实现是强制刷新，玩家进度（尤其联机对局）会丢失。

**影响范围**：移动端/无指针锁场景；联机掉线体验。

**修复方案**：监听 `visibilitychange` 暂停并静音；`webglcontextrestored` 走重建资源路径，仅在重建失败时才降级 reload。

```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden && g.state === 'playing') g.pause();
});
canvas.addEventListener('webglcontextrestored', () => g.rebuildAfterContextRestore());
```

---

### P2-6 移动端缺刘海屏安全区；存在静默 catch
**定位**：`src/template.html:5`（viewport 无 `viewport-fit=cover`）；全仓无 `env(safe-area-inset-*)`；`src/net.js:69`（`ws.onerror=()=>{}`）、`src/main.js:157-162,390-402` 等空 catch。

**描述**：触屏摇杆/按钮（`input-touch.js:26-160`、≥50px 命中区）做得完整，但 iPhone 刘海/手势条区域未做 safe-area 避让；多处空 catch 让加载失败、音频初始化失败、PMREM 失败无声无息，排查困难。

**影响范围**：移动端可操作性；线上问题定位效率。

**修复方案**：viewport 加 `viewport-fit=cover`，关键 UI 用 `padding: env(safe-area-inset-*)`；空 catch 至少 `console.warn` 并上报 UI debug。

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```
```css
#touch-ui { padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right);
            padding-bottom: env(safe-area-inset-bottom); }
```

---

### P2-7 HUD 每帧 DOM 写入未去重
**定位**：`src/ui.js:374-379`（`setHealth`）、`:369-373`（`setDmScore`）、`:410-413`（`hint`）、`:543-555`（`update` 每帧写 opacity）；对比已去重的 `:341-344`（`setAmo`）、`:381-386`（`crosshair`）。`src/main.js:1356-1357` 每帧 `viewCam.updateProjectionMatrix()`。

**描述**：`setAmo`/`crosshair` 已经用 key 去重，说明团队知道该模式；其余 HUD 路径仍在每帧写 `textContent`/`style`，并伴随 `performance.now()` 调用。单次开销很小，但在 30fps 移动端与 8 bot AI 叠加时会放大主线程负担。

**影响范围**：低端设备帧稳定性。

**修复方案**：对 setHealth/setDmScore 加 `_key` 缓存；`viewCam` 仅在 fov/宽高变化后更新投影矩阵。

```js
setHealth(h, m) {
  const k = h + '/' + m;
  if (k === this._hpKey) return;
  this._hpKey = k;
  // ...原有 DOM 写入...
}
```

---

### P2-8 存档与调试钩子的低危硬化
**定位**：`src/save.js:85`（`camo:o.camo||'default'` 未白名单）、`:90`（unlocks 仅校验 `typeof x==='string'`）；`src/i18n.js:344`（无条件 `window.__i18n`）；`src/main.js:58-69,110-114,345-351`（`?e2e/?shot/?portraits/?net=loopback` 暴露 `window.__game`）。

**描述**：存档主结构校验（`v===2`、数值非负整数、daily 清洗）做得不错，但 camo/unlocks 无白名单，脏数据会在 UI 中产生异常文案；调试全局仅在 query 参数下暴露，且只影响本地单机表现，服务端计分仍权威，风险有限；`__i18n` 无条件暴露只是 debug probe。

**影响范围**：本地存档鲁棒性；轻量反调试。

**修复方案**：camo 用 `CAMOS` 键白名单，unlocks 用已知 id 集合过滤；生产构建移除/冻结调试全局。

```js
const camo = CAMOS[o.camo] ? o.camo : 'default';
d.unlocks = [...new Set(j.unlocks.filter(x => KNOWN_UNLOCKS.has(x)))];
```

---

### P2-9 Draw call 与 AI 成本的观测项（当前可接受，仅作容量预警）
**定位**：`src/main.js:417-428`（composer）、`:1345-1346`（隔帧阴影）、`:1151-1161`（`?perf=1` 与动态分辨率）；全仓无 `InstancedMesh`/`mergeGeometries`；`src/heroes.js:357-369,508,552-578,1008-1016`（O(n²) 分离 + 每 bot 射线）。

**描述**：实测菜单/对战约 **89–90 draw calls/帧、约 95k 三角面、208 geometries、93 textures、40 programs**，隔帧阴影节省约半个 shadow pass，`?perf=1` 与自适应像素比（0.7–1.0）已具备。当前规模健康；但每个箱子/角色部件都是独立 Mesh，Bot 数或地图物件翻倍时 draw call 会线性上升。

**影响范围**：未来扩军到 10v10 或更大地图时的容量上限。

**修复方案**：先用 `?perf=1` 建立基线阈值；对重复箱子用 `InstancedMesh`，对角色静态部件做 `mergeGeometries`；AI 的 O(n²) 分离用空间哈希网格。

---

## 四、已确认有效的实践（不作为问题）

- **XSS 防护成立**：`escHTML`（`src/util.js:3-5`）覆盖昵称、击杀信息、记分板、MVP（`src/netLobby.js:107-117`、`src/ui.js:419,437,575-579`、`src/main.js:1042,1061,1124`）；`sanitizeName`（`src/netProtocol.js:43-47`）在服务端二次清洗；`i18n.js:351` 的 `innerHTML` 只接收静态字典。未发现绕过路径。
- **依赖方向健康**：39 个模块单向 DAG，0 循环依赖。
- **测试与门禁**：19 文件 / 113 个 `node:test` 用例，游戏内 70 项 `?selftest`，CI 跑 `npm ci → npm test → npm run build` 并检查单文件 < 5MB。
- **加载策略**：4 个共享 GLB 以惰性 `<script>` 内嵌（`build.mjs:29-37`），失败静默回退程序化角色（`modelAssets.js:123-143`）。
- **基础降级**：WebGL2 检测、AudioContext 前缀兼容、PointerLock `unadjustedMovement` 三层回退、service worker 协议判断。

---

## 五、代码质量综合评分

| 维度 | 分数 | 说明 |
|---|---|---|
| 代码规范与架构 | 7.0 | 模块 DAG 清晰、注释有效，但 God Class 与重复碰撞逻辑明显，无类型系统 |
| 核心玩法逻辑 | 6.5 | 武器/弹道状态机完整，但死亡仍可开火、准星-弹道分离、命中盒粗糙 |
| 物理与碰撞 | 7.0 | 重力/跳跃/蹲伏参数合理，Bot 卡墙恢复完善；AABB 近似与无 CCD 是短板 |
| 渲染与资源管理 | 6.5 | 流式 GLB、隔帧阴影、卸载路径齐备；纹理泄漏 +7/局未闭环 |
| 运行时性能 | 7.5 | `?perf=1`、自适应分辨率、draw call ~90；HUD 与热路径小对象有优化空间 |
| 安全与合规 | 4.5 | XSS 到位，但联机命中/击杀/位置三处完全客户端权威，服务端几无校验 |
| 鲁棒性与兼容 | 7.0 | 全局错误捕获、context-lost 提示、触屏完整；无 visibility 暂停、无安全区 |

**综合：7.0 / 10** — 单人和离线体验达到可发布水准；联机竞技在服务端权威校验补齐前不建议公开部署。

---

## 六、Top3 优先级改进项

1. **补齐联机服务端权威校验（P0-1 + P0-2 + P1-5）**：命中/击杀/位置三类消息加入阶段、存活、目标、武器白名单、射速、seq、速度上限校验，删除 `dmgAt` 死代码或真正启用。这是唯一会导致比赛可被单方面操纵的一组问题。
2. **修复死亡后开火与命中盒一致性（P1-1 + P1-4）**：`canFire` 与 `tick` 同时加 `player.alive` 门控并清理输入；命中盒改为连续分段并让 `CROUCH` 真正驱动姿态与判定。这两项直接决定射击公平性。
3. **闭环纹理泄漏并建立回归门禁（P1-3 + P2-2）**：名字牌纹理改为模块级缓存、明确 owned/shared 释放归属；在 `?e2e=1` 增加 10 次进出后 `renderer.info.memory.textures` 不增长的断言，避免长期运行后 context lost。

---

## 七、复测清单（修复后验收）

```text
[ ] npm test 全绿；npm run build 单文件 < 5MB
[ ] ?e2e=1：新增 dead-no-fire / hit-crouch / texture-stable 断言全过
[ ] ?shot=combat / dm / over 无回归；4 地图 × 5/15/30m 截图无颈部穿透
[ ] ?perf=1：连续 5 分钟 8-bot 对局，slow ratio < 5%，max < 50ms
[ ] 联机：伪造 c:hit / c:botDeath / c:snap 的测试脚本被服务端拒绝
[ ] 移动端：横屏 + 刘海机安全区，切后台自动暂停，回前台无大步长跳变
```
