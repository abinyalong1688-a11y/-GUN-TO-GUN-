# GUNTOGUN 射击玩法 / 角色控制 / 物理碰撞逻辑审计报告

> 审计日期：2026-11-25
> 审查对象：`C:/Users/shisunbin/.local/share/opencode/worktree/2a4dd0/crisp-comet`（GUNTOGUN v1.11.0）
> 方式：静态代码核查 + 现有测试基线（`npm test`：**109/109 通过**）+ 前序会话浏览器实测复核
> 分类定义：**必现缺陷**＝满足触发条件即稳定发生；**偶现风险**＝依赖时序/随机/外部输入；**体验缺陷**＝不崩溃但行为反直觉或手感不一致。

---

## 0. 结论摘要

本次最严重的发现是一个**此前完全未被测试覆盖的必现缺陷**：

> **Arena（DM/KOTH/Online）玩家死亡后永远不会复活。**
> `main.js:1194-1209` 每帧递减 `dmRespawnT`，但同一帧 `main.js:1280-1287` 在 `player.alive===false` 时又把它重置为 `2.5`，导致倒计时归零前 `alive` 永远不会被置回 `true`。该路径没有任何单测或 e2e 断言（现有复活断言只覆盖 bot：`tests/heroes.test.mjs:313-333`、`main.js:2044-2048`）。

其他重点：死亡慢放期间仍可开火计分、手柄/触屏可在切枪动画中触发跨枪换弹、蹲起无头顶检测、旋转盒角落隐形碰撞、贴脸射线打空、准星与弹道分离、颈部命中缝隙；另有一项无敌帧防御缺口（常规路径被 `god` 兜住，属偶现风险）。

---

# 一、必现缺陷

## D1 Arena 玩家死亡后永不复活（最高优先级）

**触发条件**：任意 Arena 模式（DM / KOTH / Online）中玩家血量归零。

**现象描述**
- `main.js:1194-1196`：每帧 `dmRespawnT -= dtRaw`，到 `<=0` 才在 `1202` 设 `player.alive=true`。
- 但 `main.js:1280-1282`：同一帧只要 `player.alive===false && state==='playing'`，就无条件 `dmRespawnT=2.5`。
- 结果：每帧净变化为 `-dtRaw` 后立刻 `+2.5`，倒计时**永远到不了 0**；同时每帧重复 `ui.deathFlash()`、`audio.hurt()`、重设 `spectate`、`_suppressPauseOnce=true`，玩家被永久卡在观战态，比赛无法继续。

**影响范围**：所有玩家可死亡复活的竞技模式；核心玩法阻断。

**修复代码**
```js
// main.js —— 用一次性标记隔离“进入死亡”的副作用
// 构造与 startGame 中：this._deathHandled = false;
if (this.player.alive === false && !this._deathHandled && this.state === 'playing') {
  this._deathHandled = true;                    // 只执行一次
  if (this.isArena()) {
    this.dmRespawnT = 2.5;
    if (this.lastKiller && this.lastKiller.alive) this.spectate = { target: this.lastKiller, t: 2.5 };
    this.ui.deathFlash();
    this.audio.hurt();
    this._suppressPauseOnce = true;
    if (document.pointerLockElement) document.exitPointerLock();
  } else {
    this.state = 'dying'; this.dyingT = 1.5;
    /* ...原逻辑... */
  }
}
// 复活块内（main.js:1202 之后）：
this.player.alive = true;
this._deathHandled = false;                     // 允许下一次死亡重新进入
```
更保守的替代方案：把 `1282` 改为 `if (this.dmRespawnT <= 0) this.dmRespawnT = 2.5;`，但仍建议配合一次性标记，否则屏闪/音效/观战仍会每帧重复。

**兜底方案**：在 `?e2e=1` 增加断言——DM 开局后将 `player.health=1`、调用 `damagePlayer(5,...)`，推进 3 秒模拟后必须满足 `player.alive===true && invulnT>0`，否则测试失败。

---

## D2 死亡 / 慢放期间仍可开火并计分

**触发条件**：玩家死亡进入 `dying`（波次）或 Arena 观战窗，鼠标左键保持按住。

**现象描述**：`main.js:1185` 的 `active` 包含 `dying`，`1216-1220` 的门控只有 `_uiLock`，不含 `player.alive`；`weapon.js:608` 的 `canFire` 同样不检查存活。死亡期间仍消耗弹药、`fire()` 造成真实伤害、`stats.hits++`、联机继续发 `c:hit`。上一轮浏览器实测：死亡后 1.3 秒连开 4 枪（30→26）。

**影响范围**：单人结算分数失真；联机形成死亡后继续攻击的竞技漏洞。

**修复代码**
```js
// main.js:1216
if (!this._uiLock && this.player.alive) {
  this._fallbackEdgeRotate(dt);
  this.player.update(dt, this.input, this.keys, this.time, this.audio);
  this.weapon.update(dt, this.input, this.player, this.camera, this.time, d => this.fire(d));
}
// main.js 死亡分支（D1 的同一处）
this.input.firing = false; this._mouseFire = false;
// weapon.js:608
const canFire = !this.reloading && s.ammo > 0 && !player.sprinting && player.alive !== false;
```

**兜底方案**：`fire()` 首行加 `if (!this.player.alive) return;` 作为第二道门；即使上层状态机遗漏也不会产生伤害。

---

## D3 手柄 / 触屏在切枪动画中触发“跨枪换弹”

**触发条件**：切枪动画期间（约 0.3 s）按手柄 X 或触屏换弹键；键盘 R 因 `input.js:57` 有 `switchT<0` 保护，不受影响。

**现象描述**
- `input-gamepad.js:43` 与 `input-touch.js:103` 直接调用 `g.weapon.startReload()`，无 `switchT` 保护。
- `weapon.js:startReload()` 只检查 `reloading/ammo/reserve`，可在 `switchT>=0` 时置 `reloading=true`。
- 切枪分支 `weapon.js:556-578` 提前 `return`，`reloadT` 不推进；动画中点 `_equip()` 已把 `cur` 换成新枪；切枪结束后 `finishReload()` 使用**新枪的 `def.mag` 与 `st`** 结算，等于“在 A 枪按换弹、给 B 枪装满”。

**影响范围**：Gamepad / 移动触屏玩家；弹药经济被破坏。

**修复代码**
```js
// weapon.js startReload()
startReload() {
  const s = this.st;
  if (this.switchT >= 0) return;                    // 新增：切枪动画期间禁止发起换弹
  if (this.reloading || s.ammo >= this.def.mag || s.reserve <= 0) return;
  this.reloading = true; this.reloadT = 0; this._reloadSnd = 0;
}
// weapon.js switchTo()：切枪前把正在进行的换弹结算到原枪，避免跨枪
if (this.reloading) {
  this.finishReload();
  this.reloading = false;
  this.ui.reloadRing(-1);
}
```
同时 `_equip()` 必须复位弹匣/支援手姿态（见 D3 补充）：
```js
const ud = this.models[this.defs[slot].id]?.userData;
if (ud?.mag && ud.magBase) { ud.mag.position.y = ud.magBase.y; ud.mag.rotation.z = ud.magBase.rz; }
if (ud?.armSupport) { ud.armSupport.position.set(0, 0, 0); ud.armSupport.rotation.z = 0; }
```

**兜底方案**：在 `finishReload()` 开头断言 `this.switchT < 0`，否则直接 `this.reloading=false; return;`，宁可丢弃换弹也不跨枪结算。

---

## D4 蹲伏切站立无头顶碰撞检测

**触发条件**：在低矮掩体 / 堆叠箱下层按住 Ctrl 蹲下，然后松开 Ctrl。

**现象描述**：`player.js:114-115` 只缓动眼高（`EYE_CROUCH=1.18 → EYE_STAND=1.62`），全仓无 ceiling/overhead 检测。站起后相机直接进入上层碰撞体，出现“穿顶”视角；角色只有脚底点与眼高，没有站立胶囊高度校验。

**影响范围**：所有含低矮掩体的地图；可借此获得非预期视野（也与透视风险叠加）。

**修复代码**
```js
// player.js
tryStand() {
  const rise = EYE_STAND - this.eyeHCur;
  const ny = this.pos.y + rise;
  if (!this.canOccupy(ny)) return false;          // 头顶被挡，保持蹲伏
  this.pos.y = ny;
  return true;
}
canOccupy(feetY) {
  const headY = feetY + EYE_STAND - .1;
  for (const c of this.colliders) {
    if (c.top <= feetY + .05) continue;
    if (headY < c.top) continue;
    if (this.pos.x > c.minX - this.radius && this.pos.x < c.maxX + this.radius &&
        this.pos.z > c.minZ - this.radius && this.pos.z < c.maxZ + this.radius) return false;
  }
  return true;
}
// update() 中把 this.crouching = ... 改为：
if (keys.has('ControlLeft') || keys.has('ControlRight')) this.crouching = true;
else if (this.tryStand()) this.crouching = false;
```

**兜底方案**：若无法在一次帧内判定，至少在站起后立刻调用 `_collide()` 并把 `eyeHCur` 钳到“当前支撑面 top + EYE_CROUCH”，避免穿进上层实体。

---

## D5 复活无敌帧依赖 `god` 标志，缺少独立校验（防御缺口）

**归类说明**：常规复活路径下 `main.js:1211-1214` 会一直保持 `god=true` 直到 `invulnT<=0`，因此敌人直调 `player.damage()` 目前**仍被 `god` 拦截，不构成必现缺陷**。本项严格属于**偶现风险 / 防御缺口**（只在 `god` 与 `invulnT` 被其他路径解耦时暴露，例如调试钩子或未来改动），因与其他死亡态问题集中展示而列在此处，实际优先级按偶现风险处理。

**触发条件**：`god` 被提前清为 false 但 `invulnT>0`（如调试钩子、未来状态改动）；此时 WASP 自爆（`enemies.js:299`）或飞行弹（`enemies.js:392`）直调 `player.damage(n,time)`。

**现象描述**：`damagePlayer()`（`main.js:979`）同时检查 `god||invulnT>0`，但 `player.damage()`（`player.js:45-46`）只检查 `alive/god`，不检查 `invulnT`。一旦两者解耦，无敌期内仍会被扣血。

**影响范围**：复活保护的健壮性；waves 模式下潜在的复活即掉血。当前正式路径不受影响。

**修复代码**
```js
// enemies.js —— 统一走 Game 的受击入口
this.game.damagePlayer(16 * Math.max(.4, 1 - toPlayer / 8),
  { id: this.id, name: 'WASP', pos: this.pos }, false, 'wasp');
// flying bullet
this.game.damagePlayer(b.dmg, { id: 'drone', name: 'REAPER', pos: b.pos }, false, 'drone');

// player.js —— 即使被直调也兜底
damage(n, now, opts = {}) {
  if (!this.alive || this.god) return;
  if (opts.respectInvuln && this.invulnT > 0) return;
  this.health = Math.max(0, this.health - n);
  if (this.health <= 0) this.alive = false;
}
```

**兜底方案**：在 `player.damage()` 内增加有限数值校验 `Number.isFinite(n) && n>=0`，非法值直接返回 0，避免 NaN/负伤害。

---

## D6 旋转盒使用外接 AABB，角落出现隐形碰撞

**触发条件**：靠近带 `ry` 旋转的箱子角落（如 `world.js:336` 的 `w=6.1,d=2.44,ry=.22`）。

**现象描述**：`world.js:70-72` 用 `hx=c*w/2+s*d/2, hz=s*w/2+c*d/2` 生成外接 AABB，四个三角角落被当成实心，玩家在视觉空处被推开。

**影响范围**：掩体边缘走位、贴角卡点、射击遮挡一致性。

**修复代码**（圆 vs OBB，保留现有 collider 结构，仅在检测时旋转到局部坐标）
```js
function circleHitsOBB(pos, r, c) {
  const co = Math.cos(c.ry || 0), si = Math.sin(c.ry || 0);
  const dx = pos.x - c.x, dz = pos.z - c.z;
  const lx =  dx * co + dz * si;
  const lz = -dx * si + dz * co;
  const qx = Math.max(-c.w / 2, Math.min(c.w / 2, lx));
  const qz = Math.max(-c.d / 2, Math.min(c.d / 2, lz));
  return (lx - qx) ** 2 + (lz - qz) ** 2 < r * r;
}
// world.js addBox 同时在 collider 上保留 x/z/w/d/ry
colliders.push({ x, z, w, d, ry, minX:x-hx, maxX:x+hx, minZ:z-hz-.01, maxZ:z+hz+.01, top:y+h/2 });
```
`player._collide()` 与 `heroes._collide()` 改用 `circleHitsOBB` 后按局部最近点推出；射线列表 `shootStatics` 本身就是真实旋转 Mesh，不受影响。

**兜底方案**：若暂不引入 OBB，可把一个旋转盒拆成 2–3 个不旋转的小 AABB 覆盖真实形状，宁可留小缝也不要产生角落空气墙。

---

## D7 `_raySphere` 起点位于球内时返回 null（贴脸打空）

**触发条件**：相机距离目标头/身体球心 `< r`（r=.16/.42），例如贴身贴脸。

**现象描述**：`main.js:760-768` 只返回最近正根 `t=-b-sqrt(disc)`；起点在球内时 `t<0`，函数返回 `null`，该目标被跳过。

**影响范围**：极近距离交火（贴身、复活瞬间、bot 挤位）出现“明明贴着人却打不中”。

**修复代码**
```js
_raySphere(origin, dir, c, r) {
  const oc = _rsO.copy(origin).sub(c);
  const b = oc.dot(dir);
  const cc = oc.dot(oc) - r * r;
  if (cc <= 0) return 0;                       // 起点在球内：立即命中
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : null;
}
```

**兜底方案**：在 `fire()` 增加距离兜底——若某敌人球心到相机距离 `< r + .05`，直接视为命中该球，跳过射线求交。

---

## D8 后坐力不回写视角，准星与弹道分离

**触发条件**：全自动武器连发。

**现象描述**：`main.js:1254-1266` 把 `camKick` 叠加到 `camera.rotation`，`player.js:187-191` 下一帧又把相机重置为 `player.pitch/yaw`；`fire()`（`main.js:777-783`）只用 `player.yaw/pitch` 计算弹道，`camKick` 从不回写。连发时 `camKick` 收敛到增量≈衰减的平衡点（实测约 1.6°），30 m 处落点偏差约 84 cm。代码注释 `main.js:775` 称其为设计取舍，但玩家感知为“准星没抬、子弹却低”。

**影响范围**：所有自动武器手感与命中预期；爆头率显著下降。

**修复代码**（方案 A：所见即所得）
```js
const kick = this.weapon.camKick || 0, kickY = this.weapon.camKickYaw || 0;
const pitch = Math.max(-1.553, Math.min(1.553, pl.pitch + kick));
const yaw = pl.yaw + kickY;
const sp = Math.sin(pitch), cp = Math.cos(pitch);
const sy = Math.sin(yaw), cy = Math.cos(yaw);
dir.set(-sy * cp, sp, -cy * cp).normalize();
```
**方案 B**：保持弹道权威角度，但把相机后坐力限制为纯视觉小量，并用枪模上跳 + 准星扩散反馈；必须在设计文档中明确。

**兜底方案**：无论选哪种，都在 `?shot=recoil` 截图中同时输出 `camKick`、射线方向与落点偏移，作为回归基线。

---

## D9 命中盒颈部缝隙与蹲伏标志未使用

**触发条件**：射击目标颈部（约 1.37–1.44 m）；或联机远端玩家蹲伏。

**现象描述**：`heroes.js:184-189` 头球心约 +1.6、r=.16（底缘 1.44），身体球 y+.95、r=.42（顶缘 1.37），中间 **7–11 cm 无缝覆盖**；身体球半径 .42 明显宽于肩宽。`PEER_FLAGS.CROUCH`（`netProtocol.js:55`）经 `remotePlayers.js:50-53` 解码，但 `heroes.js:819-867 _updateNet` 从不读取，远端蹲伏玩家仍按站立双球判定。

**影响范围**：命中公平性；爆头率与“擦身中弹”异常。

**修复代码**
```js
hitSpheres() {
  const crouch = this.netDriven && this._netState?.crouch ? .42 : 0;
  const hy = (this.headY || 1.6) - crouch;
  const by = .95 - crouch * .8;
  const br = Math.max(.42, hy - .16 - (by - .10));  // 让头球底与身体球顶相接
  return [
    { c: _v1.set(this.pos.x, this.pos.y + hy, this.pos.z), r: .16, part: 'head' },
    { c: _v2.set(this.pos.x, this.pos.y + by, this.pos.z), r: br,  part: 'body' },
  ];
}
```
并在 `_updateNet()` 中读取 `s.crouch` 驱动 `_animate()` 姿态（当前 `_animate` 无蹲伏分支）。

**兜底方案**：至少把身体球半径扩大到 `hy - .16 - .95 + .02`，保证颈部连续；宁可略微扩大身体判定，也不要留空。

---

## D10 页面切后台不暂停（触屏 / fallbackAim 路径）

**触发条件**：移动端或指针锁失败后切到别的标签页。

**现象描述**：全 `src/` 无 `visibilitychange`/`document.hidden`/`blur` 监听。`input.js:111-120` 只靠 `pointerlockchange` 暂停，而 `&&!g.fallbackAim` 让 fallback 路径永不暂停；触屏模式根本不请求指针锁。切后台后世界继续推进、伤害照常结算；`dt` 被 clamp 到 .05 只防大步长，不解决后台运行。

**影响范围**：移动端与降级模式；联机玩家切后台等于挂机挨打。

**修复代码**
```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (g.state === 'playing' || g.state === 'dying')) {
    if (g.mode === 'online' && g.netMatch?.active) g.netMenu();
    else g.pause();
  }
});
```

**兜底方案**：即使不自动暂停，也在 `document.hidden` 时清空 `input.firing/keys` 并静音，避免回来瞬间连射。

---

## D11 WebGL 上下文丢失直接整页重载

**触发条件**：GPU 驱动重置、长时间纹理泄漏后 context lost。

**现象描述**：`main.js:135-141` 在 `webglcontextlost` 中显示提示后 `setTimeout(()=>location.reload(),1200)`，注释称“once restored”，但**没有 `webglcontextrestored` 监听器**。进行中的对局/房间连接丢失。

**影响范围**：所有平台，尤其低端移动设备；与纹理泄漏（+7/局）叠加后更容易触发。

**修复代码**
```js
canvas.addEventListener('webglcontextrestored', () => {
  g.rebuildAfterContextRestore();   // 重建 composer / GLB / 纹理，恢复 setAnimationLoop
});
// reload 仅作为最终兜底
canvas.addEventListener('webglcontextlost', e => {
  e.preventDefault();
  g.renderer.setAnimationLoop(null);
  g.ui.debug('ERR WebGL context lost · recovering…', true);
  g._ctxLostTimer = setTimeout(() => location.reload(), 5000);
}, false);
canvas.addEventListener('webglcontextrestored', () => clearTimeout(g._ctxLostTimer));
```

**兜底方案**：保留 5 秒后 reload，但必须先尝试恢复；同时对恢复失败做结构化日志。

---

# 二、偶现风险

## R1 B 队复活位置可能落在门柱内且无二次碰撞推挤
**触发条件**：Arena 复活时 `base ±3 m` 抖动恰好覆盖 caldera 北门柱（`world.js:724-730`，x∈[-3.2,-0.8], z∈[-23.2,-20.8]）。
**现象**：`main.js:1197-1204` 设置位置后**不调用 `_collide()`**（bot 复活在 `heroes.js:298` 有调用），下一帧最浅轴弹出把玩家弹向不确定一侧；现有测试 `main.js:2225-2226` 只验证 A 队 z=24 线。
**修复代码**
```js
const base = this.spawns[this.playerTeam] || new THREE.Vector3(0,0,24);
for (let i = 0; i < 8; i++) {
  this.player.pos.set(base.x+(Math.random()-.5)*6, 0, base.z+(Math.random()-.5)*6);
  this.player._collide(this.world.colliders);
  if (this.isSpawnClear(this.player.pos)) break;
}
```
**兜底方案**：把抖动改为先在安全圆内取点，再检测与所有 collider 的距离 ≥ `radius+.05`。

## R2 Bot 分离在玩家碰撞之后执行，可把玩家推回墙内
**触发条件**：bot 贴身把玩家往墙角挤。
**现象**：`main.js:1218` 先 `player.update()`（含 `_collide`），`1223` 后 `heroes.update()`；`heroes.js:1020-1047 _separate` 用 `pp.x-=dx*push*.5` 推玩家，而 `1016` 只对 bot 重跑 `_collide`。玩家出现贴墙抖动/被钉住；`R=.72 < player.r+.45=.85`，视觉仍有重叠。
**修复代码**
```js
// main.js heroes.update 之后
this.heroes.update(...);
this.player._collide(this.world.colliders);   // 对玩家做二次推挤
```
并把 `heroes.js:1027` 的分离半径改为 `.85`。
**兜底方案**：若二次推挤仍抖动，在 `_separate` 中对玩家推力减半（`.25`）并跳过墙体方向。

## R3 同帧多个手雷爆炸伤害叠加
**触发条件**：两枚以上手雷引信在同一帧归零。
**现象**：`grenades.js:48-61` 倒序逐个 `_explode()`，碎片 AoE 78 dmg 可叠加；同帧双雷 = 156 dmg，直接越过 100 HP。重复击杀有 `takeDamage/die` 的 `alive` 守卫，不会重复计分，但伤害数值失真。
**修复代码**
```js
_explode(g) {
  const hitThisFrame = _explodeHitSet;          // 每帧共享 Set
  for (const h of game.heroes.list) {
    if (hitThisFrame.has(h)) continue;
    if (dist(h.pos, g.pos) <= DEFS[g.type].radius) {
      hitThisFrame.add(h);
      h.takeDamage(...,'frag', g.owner);
    }
  }
}
// tick 开头：_explodeHitSet.clear();
```
**兜底方案**：对同一目标的连续伤害做 0.1 s 免疫窗口（`lastFragHitAt`）。

## R4 异常 dt 下高速穿薄墙（无 CCD）
**触发条件**：调试直接调用 `player.update(dt)` 且 dt 较大，或外部注入极高速度。
**现象**：`player.js:149-151` 只做离散位置后的圆重叠检测；sprint 7.8×.05=.39 m 加半径 .4 通常够用，但 `world.js:249-251` 的约 0.1 m 广告牌薄板在异常 dt 下可被穿过。
**修复代码**
```js
// 用线段-圆扫掠替代单点检测：在 _collide 前先按 vel*dt 采样
const steps = Math.max(1, Math.ceil(this.vel.length() * dt / (this.radius * .5)));
for (let i = 1; i <= steps; i++) {
  _sweepPos.copy(prev).addScaledVector(this.vel, dt * i / steps);
  this._collideAt(_sweepPos, colliders);
}
```
**兜底方案**：把 `dt` 上限从 .05 收紧到 .033，并对 `player.update()` 的入参做 `Number.isFinite` 与上限校验。

## R5 联机 bot 击杀 `seq:0` 可在 Host 迁移/重复上报时重复计分
**触发条件**：`c:botDeath` 上报（`worker.js:164-177` 硬编码 `seq:0`），host 变更或网络重放导致同一 bot 死亡被上报两次。
**现象**：`room.js:92` 只对 `seq>0` 去重；`room.js:98-104` 的 `isBotVictim` 分支直接加分。
**修复代码**
```js
case C.BOT_DEATH: {
  if (!at.joined || this.state.hostId !== at.id || this.state.phase !== 'live') return;
  const bot = this.state.bots[m.bot];
  if (!bot || !bot.alive || m.killer !== at.id) return;
  const seq = m.seq | 0;
  if (seq <= (this.seenBotDeath[at.id] || 0)) return;
  this.seenBotDeath[at.id] = seq;
  bot.alive = false;
  /* recordKill ... */
}
```
**兜底方案**：服务端对同一 bot id 的死亡事件做 `deadBotIds` 集合去重，且只在 `winKills` 未达成时计分。

## R6 空开局（`_pendingNet=null`）已清半场现场再回菜单
**触发条件**：`mode==='online'` 但 `startGame()` 时 `_pendingNet` 为 null（服务端 start 消息丢失/竞态）。
**现象**：`main.js:586,638-639` 的判空发生在 `598-635` 的副作用之后——`god/invulnT/dmRespawnT`、手雷/拾取、`player.reset()`、`weapon.resetAmmo()`、`enemies.clearAll()`、`heroes.clear()`、统计分数都已被清空，然后才 `toMenu()`，造成“观战中突然回菜单且现场丢失”。
**修复代码**
```js
startGame() {
  const sel = this.ui.sel;
  const pm = this.mode === 'online' ? this._pendingNet : null;
  if (this.mode === 'online' && !pm) { this.toMenu(); return; }  // 提前返回，先于所有副作用
  ...
}
```
**兜底方案**：`_pendingNet` 设置时加时间戳，超过 5 s 未消费自动失效并提示用户。

## R7 非法 setup.faction 导致 `op` 为 undefined 抛 TypeError
**触发条件**：畸形/恶意服务端 setup 的 `faction` 不在 `ct/t`。
**现象**：`main.js:592` `op=byFaction(pm.faction)[0]` 在空数组上取 `[0]` 得 `undefined`，紧接着 `593 hero=op.faction` 抛错。
**修复代码**
```js
if (pm && op.faction !== pm.faction) {
  const pool = byFaction(pm.faction);
  if (!pool.length) { this.toMenu(); return; }
  op = pool[0];
}
```
**兜底方案**：`byFaction()` 自身返回 `byFaction('ct')` 作为兜底，避免任何空数组外泄。

---

# 三、体验缺陷

## E1 台阶吸附无插值 / 边缘提前下落 / 悬空 1–2 cm 死区
**触发条件**：走过相邻不同高度的 collider（1.1 m 箱顶与 1.35 m hesco）；站在箱顶边缘。
**现象**：`player.js:154-159` 直接 `pos.y=support; velY=0`，最高 `STEP_UP=.32` 的瞬移造成可见弹跳；支撑采样半径 `radius*.85=.34 < collision radius=.4`，脚仍在箱面却提前下落；`support+.001 < pos.y <= support+.02` 分支都不进，短时悬空；走下边缘时 `grounded=false; velY=0`，重力延迟一帧。
**修复代码**
```js
// 支撑半径与碰撞半径对齐
const r2 = (this.radius * .98) ** 2;
// 台阶吸附改为插值
if (this.pos.y <= support + .001) {
  this.pos.y += (support - this.pos.y) * Math.min(1, 18 * dt); // 或保留瞬时但加缓动视觉
  this.velY = 0;
}
```
**兜底方案**：若追求确定性物理，保留瞬时吸附，但用相机 y 的独立缓动（`camY += (pos.y+eyeH-camY)*k`）消除视觉弹跳。

## E2 空仓必须松开扳机才自动换弹
**触发条件**：全自动武器按住扳机打到 0 发。
**现象**：`weapon.js:636-640` 只有 `!input.firing` 时才 `_emptyClicked` + `startReload()`，因此按住不放会一直停在空仓，需松手才换弹。
**修复代码**
```js
if (s.ammo === 0 && !this.reloading && s.reserve > 0 && !this._emptyClicked) {
  this._emptyClicked = true;
  this.audio.empty();
  this.startReload();
}
```
**兜底方案**：若刻意保留“手动松手”设计，至少在 HUD 明确提示“松开扳机换弹”。

## E3 切枪动画吃掉扳机边沿
**触发条件**：按住扳机切到半自动武器。
**现象**：`weapon.js:576` 在切枪分支 `this._trigWasDown=!!input.firing`，切完必须松开再按才能开火；全自动武器若仍按住则立刻连发（规则不一致）。
**修复代码**
```js
// 切枪结束时统一要求重新扣扳机
_equip() { ...; this._trigWasDown = true; }
```
**兜底方案**：在 UI 上显示“切枪完成，松开扳机”提示，或统一改为切枪后第一发必须重新按下。

## E4 高射速下持续对象分配与乐观 hitmark
**触发条件**：800 rpm 武器持续射击；联机命中远程玩家。
**现象**：`heroes.js:184-189` 每次 `hitSpheres()` new 2 个 Vector3（每发最多 16 个，穿透翻倍）；`main.js:826-833` 对 `netDriven` 目标仍 `stats.hits++/audio.hit()/hitmark()`，服务端若拒绝伤害仍显示命中。
**修复代码**
```js
// heroes.js：复用向量
const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3();
hitSpheres() {
  _s1.set(this.pos.x, this.pos.y + (this.headY||1.6), this.pos.z);
  _s2.set(this.pos.x, this.pos.y + .95, this.pos.z);
  return [{ c:_s1, r:.16, part:'head' }, { c:_s2, r:.42, part:'body' }];
}
// main.js：远程目标不立即记 hits/hitmark，等 s:hit 确认或保留为“乐观反馈”并文档化
```
**兜底方案**：至少把 hitmark 颜色/音效区分为“乐观命中”与“确认命中”。

## E5 无坠落伤害、步枪无距离衰减
**触发条件**：从 `top=5.2` 瞭望塔或 `top=16` 龙门吊跳下；远距离步枪命中。
**现象**：`player.damage()` 调用点只有敌人与 `damagePlayer`，无基于 `velY` 的落差伤害；`def.dmg` 与距离无关，爆炸衰减分支（`main.js:879,884`）因 `WEAPON_DEFS` 无 `explosive/blastR` 是死代码。
**修复代码**
```js
// 落地时按冲击速度扣血
if (this.velY <= -18 && this.grounded) {
  const fallDmg = Math.round((-this.velY - 18) * 3);
  g.damagePlayer(fallDmg, { id:'fall', name:'Fall', pos:this.pos }, false, 'fall');
}
```
**兜底方案**：若设计上刻意取消两者，在 README 中明确写出“无坠落伤害 / 无距离衰减”，避免被当作 bug 反复报告。

## E6 主射线 far=400 远超战场半径 56
**触发条件**：朝地图外天空/远景射击。
**现象**：`main.js:786` `ray.far=400`，天空球半径 480（`main.js:396`），远处静态物仍可被命中/遮挡；战场有效半径仅 56（`player.js:30`）。
**修复代码**
```js
this.ray.far = 120;   // 覆盖 56m 战场 + 合理余量
```
**兜底方案**：把 `bestT` 初值同步从 400 改为 120，避免穿透升级判断 `bestT<399` 永远为真。

## E7 状态枚举注释与实现不一致 / 非法 `?shot` 无提示
**触发条件**：阅读 `main.js:72` 注释（只列 menu/playing/paused/dying/over），或访问 `?shot=unknown`。
**现象**：实际还有 `tutorial/upgrade` 状态；未知 shot 参数静默停留菜单，无反馈。
**修复代码**
```js
this.state = 'menu'; // menu | playing | paused | dying | over | tutorial | upgrade
// main.js:307-315 末尾加
else if (this.shotMode) this.ui.debug('ERR unknown ?shot=' + this.shotMode, true);
```
**兜底方案**：把状态常量导出为 `STATE` 枚举并在所有赋值点使用，避免魔法字符串。

---

# 四、边界测试用例清单

> 建议全部放进 `?e2e=1` 或新增 `tests/gameplay-boundary.test.mjs`；标 ★ 的是本次新增、现有 109 个测试未覆盖的关键项。

| ID | 模块 | 用例 | 步骤 / 输入 | 预期结果 |
|---|---|---|---|---|
| T01 ★ | 状态机 | Arena 死亡复活 | DM 开局，`player.health=1`，`damagePlayer(5)`，推进 3 s | `alive===true`、`health===maxHealth`、`invulnT>0`，`_deathHandled===false` |
| T02 ★ | 状态机 | 死亡副作用只触发一次 | 同上，统计 `deathFlash`/`audio.hurt` 调用次数 | 各 1 次，不随帧数增长 |
| T03 ★ | 武器/状态 | 死亡后不能开火 | 死亡期间保持 `input.firing=true`，推进 1 s | `ammo` 不变、`fire()` 未调用、无 `c:hit` |
| T04 | 武器 | 半自动扳机边沿 | AWP 按住鼠标 2 s | 只开 1 发 |
| T05 | 武器 | 全自动射速 | MP5 按住 2 s | 发数 ≈ `2*rpm/60`，误差 < 2 发 |
| T06 | 武器 | 空仓自动换弹 | 打空后松开扳机 | 自动 `startReload()`，装填后 ammo=mag |
| T07 ★ | 武器 | 空仓按住扳机 | 打空后继续按住 1 s（修复后） | 自动换弹（或 HUD 明确提示） |
| T08 | 武器 | reserve=0 空仓 | 把 reserve 置 0 后打空 | 只播 empty 音，不换弹，ammo=0 |
| T09 ★ | 武器 | 手柄切枪中换弹 | 切枪动画 0.1 s 时触发 `startReload()` | 被拒绝；不会给新枪装满 |
| T10 | 武器 | 换弹中切枪 | 换弹 50% 时切枪 | 旧枪换弹被结算或取消，弹匣姿态复位 |
| T11 | 武器 | 同帧 R + 数字键 | 同帧发 KeyR 与 Digit2 | 只有切枪生效，不跨枪结算 |
| T12 | 武器 | 切枪后扳机 | 按住扳机切到 AWP | 必须松开再按才开火（或统一规则） |
| T13 | 武器 | rpmMul=0 / 负数 | 注入 0、-1 | 不除零、不每帧一发；负倍率被钳为合法值 |
| T14 | 武器 | resetAmmo 全枪 | 消耗多把枪弹药后 `resetAmmo()` | 所有 slot ammo=mag、reserve=初始 |
| T15 ★ | 武器 | setLoadout 中途切枪 | 切枪动画中重开局 | `switchT/_pending` 被清空，无幽灵槽位 |
| T16 | 命中 | 贴脸命中 | 相机与目标球心距离 < r | `_raySphere` 返回 0，判定命中 |
| T17 ★ | 命中 | 颈部命中 | 射线穿过 1.40 m 高度 | 命中身体（修复后不再漏判） |
| T18 ★ | 命中 | 蹲伏目标命中 | 远端 `PEER_FLAGS.CROUCH=1` | 命中盒高度下降，姿态为蹲 |
| T19 | 命中 | 静态遮挡优先 | 墙后放一个目标 | 不命中目标，命中墙 |
| T20 | 命中 | 穿透二次伤害 | pierce>0，两个目标对齐 | 第二目标伤害 = `0.6*def.dmg`，不吃爆头 |
| T21 | 命中 | 多目标取最近 | 两个目标同一直线 | 只结算更近者（+穿透规则） |
| T22 | 命中 | 爆头倍率 | 头球命中，crit 升级 0/2 | 伤害 ×2 / ×2.5，且有限数值 |
| T23 ★ | 角色 | 蹲起头顶检测 | 在低矮掩体下蹲后站起 | 保持蹲伏或眼高被钳，不穿顶 |
| T24 | 角色 | 跳蹲互斥 | 按住 Ctrl 时按 Space | 不跳；先跳后蹲允许 |
| T25 | 角色 | 空中加速度 | 空中反向输入 1 s | 速度按 `accel=3.2` 缓变，不过冲 |
| T26 | 角色 | 终端速度 | 从 16 m 高台跳下 | `velY>=-30`，落地不 NaN |
| T27 ★ | 角色 | 复活无敌 | 复活后 1 s 被 WASP 自爆命中 | 血量不减（走 `damagePlayer`） |
| T28 ★ | 角色 | 复活不卡柱 | B 队复活 100 次 | 每次位置与所有 collider 距离 ≥ .44 |
| T29 | 角色 | 边界 clamp | 强行把 pos.x 设为 100 | 极坐标 clamp 到 r=56 |
| T30 ★ | 碰撞 | 旋转盒角落 | 贴 `world.js:336` 旋转盒角落外侧 | 不被空气墙推开（修复后） |
| T31 | 碰撞 | 站立顶面不水平推 | 玩家站在箱顶 | 水平移动不被箱体重置 |
| T32 | 碰撞 | 中心陷入弹出 | `pos` 置于 collider 中心 | 沿最浅轴弹出，不 NaN |
| T33 ★ | 碰撞 | Bot 挤墙 | 贴墙时 bot 推挤玩家 | 玩家不进入墙内，无高频抖动 |
| T34 | 碰撞 | 薄板穿墙 | 以异常 dt 直调 `player.update` | 扫掠检测阻止穿越 |
| T35 ★ | 地图 | 跳图后引用 | 4 张地图来回切换 20 次 | `player.colliders === world.colliders`，无旧引用 |
| T36 | 地图 | losStatics 兜底 | 手工删掉 `losStatics` | `||shootStatics` 兜底生效，不抛错 |
| T37 ★ | 异常 | `_pendingNet=null` | online 模式清空 pending 后 startGame | 在任何字段被清空前回菜单 |
| T38 | 异常 | 非法 `?map` / `?op` / room code | 分别注入垃圾值 | 回退 desert/frost，忽略非法码，不抛错 |
| T39 | 异常 | 脏存档 | `daily.progress=null`、`unlocks` 非字符串 | `cleanDaily` 重建，不崩 |
| T40 | 异常 | 零 dt / NaN 输入 | `player.update(0)`、`weapon.update(0)`、`damage(NaN)` | 无位移/无扣血/无 NaN 状态 |
| T41 ★ | 异常 | 多手雷同帧爆炸 | 两枚手雷引信同帧归零 | 同一目标只受一次 78 dmg |
| T42 | 异常 | 同帧双方死亡 | 玩家与 bot 同帧死亡 | 结算 `_end*` 只执行一次 |
| T43 ★ | 鲁棒 | 切后台暂停 | 触屏模式 `document.hidden=true` | 自动 pause/netMenu，输入被清空 |
| T44 ★ | 鲁棒 | context restored | 触发 lost 后立即 restored | 不 reload，渲染循环恢复 |
| T45 | 反馈 | 乐观 hitmark | 联机对远程目标射击 | 文档化为乐观反馈或显示区分样式 |

---

## 五、修复顺序建议

1. **立即修**：D1（Arena 不复活）、D2（死后开火）、D3（跨枪换弹）——这三项直接破坏核心玩法与竞技公平；D5 为低成本防御加固，随本迭代一并处理即可。
2. **本迭代修**：D4（蹲起穿顶）、D6（旋转盒空气墙）、D7（贴脸打空）、D9（颈部缝隙/crouch）、R1/R2（复活与推挤出界）。
3. **下迭代修**：D8（准星/弹道，需产品决策）、D10/D11（前后台与 context）、R3-R7、E1-E7。
4. **测试门禁**：把 T01–T45 中的 ★ 项全部加入 `?e2e=1`，CI 同时跑 `npm test`（当前 109/109 通过）与浏览器自检，防止回归。
