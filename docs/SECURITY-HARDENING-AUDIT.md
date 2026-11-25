# GUNTOGUN 前端与网络交互安全加固审计报告

> 审计日期：2026-11-25
> 审查对象：`C:/Users/shisunbin/.local/share/opencode/worktree/2a4dd0/crisp-comet`（GUNTOGUN v1.11.0，Three.js FPS + Cloudflare Durable Object 联机）
> 方式：静态源码核查（客户端 39 模块 + `server/worker.js`、`server/room.js` + 构建脚本）
> 重要背景：`README.md:83-85` 与 `docs/FRIENDS-5V5-ONLINE.md:1169-1180` 明示当前定位是“好友间、房间码、DO 只做注册/扇出/记分，不跑物理/AI”。下列风险在该信任模型下是**明示的设计取舍**；一旦公开部署、引入排行榜或匹配陌生人，即构成可完整利用的作弊链。

---

## 0. 信任模型现状（风险根因）

| 数据 | 谁计算 | 谁裁决 | 服务端是否复核 |
|---|---|---|---|
| 玩家位置/朝向/血量 | 本地客户端 | 本地客户端 | 否（`worker.js:130-139` 仅转发） |
| 命中/伤害 | 攻击方客户端 | 攻击方 + 受害方客户端 | 否（`worker.js:188-206` 只 clamp 上限） |
| Bot 命中 | 房主客户端 | 房主客户端 | 否（`remotePlayers.js:58-66`） |
| 死亡/击杀 | 受害者客户端上报 | 服务端记分 | 仅 seq 去重 + 队伍校验 |
| 比分/胜负 | 服务端 | 服务端 | 是（但上报源可被伪造） |

**一句话结论**：服务端不持有地图几何、不跑物理、不校验射击，因此**所有竞技权威都在客户端**；这不是某个单点 bug，而是协议设计属性。

---

# 一、高危漏洞

## H1 命中判定与伤害结算完全客户端权威（射击逻辑权威性 / 核心数值 / 协议）

**漏洞原理**
- `src/main.js:777-786`：射线方向取 `player.yaw/pitch`，起点取 `camera.position`；`:806-830` 用 `hitSpheres()` 求交后**直接调用** `bestHero.takeDamage(dmg,...)`；`:829` 的 `dmg=def.dmg*倍率` 全部来自本地可改对象。
- `src/netMatch.js:213-220`：`requestHit()` 只上报 `{target,dmg,head,w}`，**不含射线起点、方向、命中点、seq**。
- `server/worker.js:145-148,188-206`：`c:hit` 入口只查 `joined`；`relayHit` 仅做 `max(0,min(HIT_DMG_CAP[m.w]||200,+m.dmg||0))` 后转发。`dmgAt`（`worker.js:42`）全生命周期未读写，是死代码。
- `src/heroes.js:195` bot 命中由房主本地结算；`src/remotePlayers.js:58-66` 的 `applyHitToBot` 直接调用 `takeDamage`。

**利用路径**
1. 控制台改 `g.player.yaw/pitch` 或 `g.camera.position` 后开火 → 任意方向命中；
2. 直接构造 WebSocket 帧 `c:hit`，`target=敌人id, dmg=350, head=1, w='awp'`；按 32 msg/s 令牌桶计算，理论 **11,200 伤害/秒**；
3. 直接调用 `g.fire(0)` 绕过 `weapon.js:608` 的弹药/射速软约束；
4. 服务端没有地图几何，`c:hit` 天然可穿墙。

**危害等级**：高危（竞技公平完全失效；可瞬间清场）

**前端加固方案**
- 生产构建剥离测试全局（见 H6），`Object.freeze(WEAPON_DEFS)` 与关键倍率；
- `fire()` 入口补齐 `player.alive`、射速、弹药、目标距离、`_los` 复核；对本地 bot 与远程目标一视同仁；
- 上报前对 `dmg/head/w` 做自检并按会话密钥做轻量 HMAC（见文末体系方案）；
- 记录本地异常计数（如 1 秒内 `fire()` 调用 > 武器 rpm 允许值）并上报。

**服务端校验建议**
- 建立共享的**紧凑 2D 碰撞网格**（不需要 three.js），对每条命中做：射手存活 → 目标存在且存活 → 武器属于该玩家当局配枪 → 与 `pending` 快照距离 ≤ 武器射程 → 2D LOS 无遮挡 → 射速间隔（`dmgAt`）→ `seq` 单调去重 → 按真实武器 clamp；
- HIT 报文中要求携带 `origin/dir/hitPoint/seq/ts`，并用快照位置复核 origin 偏差；
- 未知武器不再走 `|| 200` 兜底，直接拒绝。

---

## H2 位置包无合法性校验且可冒用他人 ID（网络协议安全）

**漏洞原理**
- `server/worker.js:130-139`：`c:snap` 只检查 `Array.isArray(m.s)`，原样 `pending.set(at.id,{p:m.s})` 并约 15 Hz 全量广播；无 `phase`、数组长度/类型、坐标边界、速度、高度、血量范围、flags 合法性、快照新鲜度校验。
- `src/remotePlayers.js:47-48`：`const d=decodePeer(a); const h=game.heroes.byNetId(d.id)` —— **直接信任快照里的 id**。
- `worker.js:224-244` 的 `drop()` 未清理 `pending`，离线玩家快照会滞留。

**利用路径**
1. 把自己的 `c:snap` 中 `a[0]` 写成敌人 netId → 全场客户端把该敌人瞬移到任意坐标；
2. 每帧发送极端坐标 → 飞行、穿墙、瞬间贴近；
3. 伪造 `hp` 与 flags → 误导对方 UI/命中判断。

**危害等级**：高危（可操纵他人位置，形成“拉人”与假距离攻击）

**前端加固方案**
- `applyPeers()` 对单帧位移做上限检查（例如 `>8 m` 直接丢弃而非插值）；
- 屏幕层过滤 id 与已知 roster 不符的快照；
- 生产构建移除可直接改 `game.player.pos` 的全局入口。

**服务端校验建议**
```js
case C.SNAP: {
  if (!at.joined || this.state.phase !== 'live') return;
  const p = m.s;
  if (!Array.isArray(p) || p.length !== 8 || p.some(v => typeof v !== 'number' || !Number.isFinite(v))) return;
  if (p[0] !== at.id) return;                                   // id 必须与连接绑定
  const x = p[1]/100, y = p[2]/100, z = p[3]/100;
  if (Math.hypot(x, z) > 57 || y < -1 || y > 12) return;         // 竞技场边界
  const prev = this.pending.get(at.id);
  if (prev) {
    const d = Math.hypot(x - prev.p[1]/100, y - prev.p[2]/100, z - prev.p[3]/100);
    if (d > 7.8 * 0.12 + 0.6) return;                            // 最大速度×最大间隔+容差
  }
  if (p[6] < 0 || p[6] > 200 || (p[7] & ~15)) return;            // hp / flags 掩码
  this.pending.set(at.id, { at:now, p });
  ...
}
```
并在 `drop()` 中 `this.pending.delete(at.id)`。

---

## H3 全量坐标广播 + 名称牌/雷达无 LOS → 协议层透视（信息泄露）

**漏洞原理**
- `worker.js:130-139,253-260`：每约 66 ms 把 `[...pending.values()]` 广播给**所有** WebSocket，无 AOI/兴趣管理；`netProtocol.js:58-64` 的 `encodePeer` 含 `x/y/z/yaw/pitch/hp/flags` 全字段。
- `src/remotePlayers.js:44-55` 全量接收；`modelAssets.js:485-487` 角色 `frustumCulled=false`（渲染层也照常提交）。
- `src/heroes.js:420-427,828-834`：名称牌只按距离 30 m 全亮、46 m 隐藏，**无 LOS**。
- `src/radar.js:28-48`：雷达仅做 30 m 距离截断，直接绘制全量敌人坐标。
- 服务端不加载地图，无法计算视线（`worker.js:2` 自述）。

**利用路径**
- 直接读 WebSocket 帧或 `game.heroes.list`，得到全场敌人实时坐标、朝向、血量、蹲伏/ADS/冲刺状态 → 自制 ESP 透视；
- 即使不篡改客户端，原生雷达和墙后名称牌本身就是距离制透视。

**危害等级**：高危（信息优势可直接转化为命中率优势）

**前端加固方案**
- 名称牌与雷达增加与 `main.js:1368-1375 _los` 相同的遮挡检查；雷达对敌人只显示“最近可见位置”；
- 敌方快照在 UI 层降频/降精度使用，内部对象仍可保留完整数据，但避免直接渲染墙体后目标；
- 这部分只能改善普通玩家体验，**不能阻止脚本读取网络帧**。

**服务端校验建议**
- 引入轻量兴趣管理：队友全量；敌人按“2D 网格 LOS + 距离”决定是否下发，且降频到 2–4 Hz、位置量化到 0.5–1 m；
- `hp` 仅对队友或刚命中者下发；`yaw/pitch` 对敌人只下发粗略朝向；
- 服务端持有简化 2D 墙体网格（几十 KB）即可，不需要 three.js。

---

## H4 击杀/刷分上报可伪造（DIED / BOT_DEATH）

**漏洞原理**
- `worker.js:149-163` 的 `c:died`：victim 恒为 `at.id`（上报者本人），`seq` 由客户端 `++`（`netMatch.js:224`）；`room.js:92-96` 只按 victim 去重，递增 seq 可反复“被杀”。队伍校验（`room.js:100`）挡住了给队友刷分，但可给敌人送分。
- `worker.js:164-177` 的 `c:botDeath`：仅校验 host 身份，`seq:0` 硬编码跳过去重，不校验 bot 存在/存活、killer 是否本人；`room.js:98-104` 的 `startsWith('b')` 分支可直接加分，`winKills=25` 触发终局。

**利用路径**
- 普通玩家持续上报 `c:died` 给任意敌人刷 25 杀；
- 房主一帧内连发 25 条 `c:botDeath` 直接判己方胜。

**危害等级**：高危（胜负可被单方面操纵）

**前端加固方案**
- `reportBotDeath()` 只由真实 bot 死亡事件触发（客户端已如此，但恶意房主可绕过）；对击杀事件做本地一致性检查。

**服务端校验建议**
- `c:died` 由服务端维护 `alive` 状态与 `lastDeathAt`，拒绝重复死亡，victim/killer 关系由服务端命中事件驱动；
- `c:botDeath` 校验 `m.bot ∈ state.bots && alive`、`killer === at.id`、`seq>0` 且单调，击杀后立即置 bot dead；
- 对短时间内集中到达的击杀做速率熔断。

---

## H5 `?server=` 任意服务器 + 接收侧伤害无上限 + wss 未强制（Web 安全 / 协议）

**漏洞原理**
- `src/net.js:7-15`：`resolveServerUrl()` 优先级为 `?server=` > `localStorage.o07_server` > 构建常量 `__GTG_SERVER__`，无 scheme/host 白名单；`:22` 直接 `new WebSocket(u)`，`ws://` 可用。
- `src/netMatch.js:73-76`：`s:hit` 收到后原样 `g.damagePlayer(m.dmg,...)`；`main.js:978-983` → `player.js:45-49` 无 `Number.isFinite` 与上限校验，`NaN` 会让 `health=NaN` 且永不死亡。

**利用路径**
- 诱导点击 `?server=ws://evil.example` → 恶意服下发 `dmg:99999` 秒杀，或 `dmg:NaN` 让玩家进入无敌卡死；也可伪造 `s:kill/s:end/s:host`；
- 公网使用 `ws://` 时中间人可篡改任意对局数据。

**危害等级**：高危（会话劫持 / 一击必杀 / 状态卡死）

**前端加固方案**
- 生产环境拒绝非 `wss:` 的地址（仅 `localhost`/`127.0.0.1` 开发例外）；
- `?server=` 仅在开发构建生效，正式构建使用编译期注入的固定地址；清除/忽略 `o07_server`；
- 接收端做纵深校验：`Number.isFinite(m.dmg)`、`0 <= m.dmg <= HIT_DMG_CAP[m.w]`，否则丢弃并计数上报。

**服务端校验建议**
- WebSocket 升级时校验 `Origin` 白名单与 TLS；连接颁布服务端签发的短期 token；
- 对每房间下发会话密钥，客户端 HMAC 业务报文（见文末体系）；
- 记录非法 `server` 参数命中事件用于运营告警。

---

## H6 核心数值全部内存可控 + 调试全局无条件暴露（核心数值安全 / 客户端防护）

**漏洞原理**
- `src/player.js:24,45-51`：`health/maxHealth/alive/god` 为普通字段；`src/weapon.js:81,15-48`：`state`/`WEAPON_DEFS` 普通对象；`main.js:829,613` 直接读取。
- `main.js:58-69`：URL 带 `?shot`/`?selftest`/`?e2e`/`?roster`/`?portraits`/`?pad` 任一非空参数即 `window.__game=this`；`:345-351` 暴露 `__GTG_DEBUG__`；`i18n.js:344` 的 `window.__i18n` **每次加载都暴露**。
- 无 `Object.freeze`、无 checksum、无定时自校验、无反调试、无异常上报；`build.mjs:5-18` 仅 `minify:true`，无 sourcemap 但也无混淆/加密。

**利用路径**
- 加 `?e2e=1` 后控制台执行 `g.player.god=true; g.player.health=999; g.weapon.defs[0].dmg=9999; g.weapon.defs[0].rpm=6000`；
- 单机立即无敌/秒杀；联机中 `god=true` 会直接丢弃 `s:hit`（`main.js:979`）且不发 `c:died`，服务端无法判定其死亡。

**危害等级**：高危（单机完全破坏；联机形成免伤）

**前端加固方案**
- 用 esbuild `define` 在正式构建中把调试钩子编译为空：`DEBUG_HOOKS:false`；`if(DEBUG_HOOKS) window.__game=this`，生产包彻底移除；
- 冻结静态数值表：`Object.freeze(WEAPON_DEFS.map(Object.freeze))`，运行时倍率放进闭包而非公开字段；
- 关键字段做轻量自校验（例如每 2 秒比对 `health <= maxHealth`、`ammo <= mag`），异常时重置并上报；
- 轻量混淆/字符串表可以提高逆向门槛，但**不能作为主要防线**。

**服务端校验建议**
- 不信任客户端自报 hp：服务端维护权威 `alive` 状态；长时间未收到某玩家的死亡却收到其 hp=0 快照时标记异常；
- 建立“伤害事件 → 血量变化 → 死亡上报”的事件链一致性检查，缺链即判异常。

---

## H7 协议无签名 / 无时间戳窗口 / 无违规处置（系统性）

**漏洞原理**
- `netProtocol.js:66-67` 的 `isValidMsg` 只判断 `m.t` 是字符串且长度 <24；`worker.js:76-80` `JSON.parse` 后才做 4096 字节检查；
- 全仓无 HMAC/签名/nonce；`m.ver` 可选（`worker.js:85-88`），可省略绕过；
- 超频只 `ERR rate` 不 `ws.close()`（`worker.js:80`）；全服务端无 `ban/kick`、无结构化日志；客户端 `NET_ERR.kicked` 是空壳（`netMatch.js:19`）。

**利用路径**
- 任意构造/重放历史合法帧（如重复的 `c:create`、`c:died`）；
- 持续超频发包只收到错误，不会被断开，可长期骚扰。

**危害等级**：高危（所有上层校验缺失时的系统性兜底失效）

**前端加固方案**
- 客户端对发出的关键帧附 `seq/ts/sig`，收到 `ERR rate/kicked` 时退避并提示；
- 对异常服务端帧（字段缺失/签名错误）做丢弃与上报。

**服务端校验建议**
- 按消息类型做 schema 校验（白名单字段、类型、范围）；解析前限制原始字节数；
- 服务端时间窗口 ±2s + 每类型单调 seq + 会话密钥 HMAC-SHA256（WebCrypto，客户端开销可忽略）；
- 违规分级处置：警告 → 丢弃 → 踢出 → 临时封禁，并记录结构化日志（连接 id、房间、消息类型、违规原因）。

---

# 二、中危风险

## M1 `token` 认领可越权夺取席位/房主
**原理**：`server/room.js:31-40` 信任客户端 `m.token` 认领断线席位（含 host），`worker.js:88/90` 原样存入；客户端从不生成 token（`net.js:24` 为 `''`），属潜伏后门。`room.js:116-120` 的 `promoteHost` 按 `order` 自动推广，`worker.js:237-239` 有 10 s `noHostAt` 宽限。
**利用路径**：构造 `c:create/c:join` 带已知或可猜 token → 认领他人席位/房主。
**前端加固**：客户端绝不发送自定义 token；退避重连使用服务端签发的短 token。
**服务端校验**：token 由服务端 `crypto.randomUUID()` 生成并 HMAC 签名，绑定连接指纹与席位，断线重连需同一 IP 或二次确认；禁止客户端指定 `hostId`。

## M2 房间码爆破 / 建连无节流
**原理**：`worker.js:14-19` 用 `crypto.getRandomValues` 生成 5 位 32 进制码（32^5≈3.36e7，随机性到位），但 `:35-36` 对任意符合正则的 code 直接路由/创建 DO；加入无 per-IP 次数限制，令牌桶按连接计可开新连接绕过。
**利用路径**：批量遍历房间码进入他人房间观战/作弊。
**前端加固**：分享链接不暴露过多信息；被踢后指数退避重连。
**服务端校验**：per-IP 建连/入房尝试计数与退避；房间码设置有效期；对异常高频尝试封禁 IP/段。

## M3 存档与本地设置的低危篡改面
**原理**：`save.js:5` 键 `o07_save_v2`，`:73-109` 只做非负截断与字段重建，`unlocks`（`:90`）只校验字符串、`camo`（`:85`）无白名单；`net.js:12` 读取 `o07_server`。无 token/口令入库（这是好的）。
**利用路径**：改 `o07_best_wave` 解锁迷彩、改 `unlocks` 注入异常字符串；污染 `o07_server` 指向恶意服（与 H5 叠加）。
**前端加固**：unlocks/camo 用已知集合过滤；生产构建忽略 `o07_server`；不在 localStorage 存放任何身份/服务器凭据。
**服务端校验**：入房消息本就不带存档字段（`netMatch.js:114-127`），保持；对 `op/camo` 做白名单，避免异常值进入 roster。

## M4 调试钩子与构建产物可逆向
**原理**：`build.mjs:5-18` 仅 esbuild minify；`dist/gun-to-gun.html` 为单行可读 JS，字符串（如 `o07_save_v2`、干员 id）明文保留；全库无反调试、无完整性校验、无异常上报。
**利用路径**：定位 `__game`、`WEAPON_DEFS`、`HIT_DMG_CAP` 等关键符号并直接修改/重放。
**前端加固**：见 H6（生产剥离钩子）+ 轻量字符串混淆 + 启动时校验关键函数 `toString()` 长度（象征性）；**明确认知：Web 端无法可靠防篡改，重点必须放在服务端权威**。
**服务端校验**：以服务端状态为准，客户端仅表现层；对异常行为做统计检测而非依赖客户端完整性。

## M5 IP 国家探测与隐私
**原理**：`main.js:340` 默认调用 `detectIPCountry()` 向 `https://ipwho.is/` 请求，`i18n.js:335` 将国家码存入 `o07_ipcc`，无显式同意选项。
**利用路径**：第三方 IP 探测泄露用户网络位置；不影响玩法但属隐私风险。
**前端加固**：改为 opt-in 或移除；如需语言自动切换，用 `navigator.language`。
**服务端校验**：无；若自建语言服务，避免第三方请求。

---

# 三、低危加固

## L1 XSS 出口已防护，但保持警惕
`util.js:3-5` 的 `escHTML` 覆盖 `netLobby.js:107-117`、`ui.js:419,437,575-581`、`main.js:1042,1061,1124` 等全部用户可控出口；服务端 `netProtocol.js:43-47 sanitizeName` 二次清洗。**未发现可利用 XSS**。保留 `i18n.js:351` 的静态字典 `innerHTML` 时，确保字典不可被外部覆盖；生产构建冻结 `__i18n` 或移除。

## L2 静默 catch 与无 teardown
`main.js:117-121,353-362` 的错误看门狗只展示不上报；`worker.js:77`、`net.js:60` 解析失败静默；`input.js:130-133` 提供 `detach()` 但无调用点。建议统一 `console.warn + ui.debug + 可选上报`，并为页面卸载/质量切换补齐 teardown。属可观测性加固，非直接安全漏洞。

## L3 记分板信息暴露控制良好
`ui.js:433-441` 只显示名称/阵营/击杀/死亡，不显示血量；名称经 `escHTML`。保持现状，不要在记分板加入实时 HP。

---

# 四、适配 Web 端的轻量化反作弊体系建设方案

> 设计原则：**不追求客户端不可篡改（Web 上做不到），而是让“篡改能被发现、发现能处置、处置成本可控”**。服务端不引入 three.js，只增加几 KB 的 2D 网格与百行级统计。

## 4.1 四层结构

| 层 | 措施 | 成本 | 能挡住什么 |
|---|---|---|---|
| L0 构建发布 | 生产 `define DEBUG_HOOKS=false`；剥离 `?shot/?e2e` 全局；冻结静态表；轻混淆 | 构建期一次性 | 控制台一键改数值/看内部状态 |
| L1 会话身份 | 服务端签发 HMAC token，绑定连接/席位；强制 wss + Origin 白名单；`?server=` 仅开发可用 | 低 | 任意服务器劫持、token 认领越权 |
| L2 协议校验 | 按类型 schema；解析前字节限制；`ts ±2s` + 单调 seq + HMAC-SHA256；违规踢出 | 低（WebCrypto 原生） | 伪造帧、重放、字段越界 |
| L3 行为检测 | 服务端滑动窗口统计移速/射速/伤害/LOS/击杀链；2D 网格 LOS；分级处置 | 中（无需 3D） | 瞬移、超速、穿墙命中、刷分 |

## 4.2 关键实现示例

**① 客户端轻量签名（WebCrypto，仅关键帧）**
```js
// 会话建立后由服务端下发 sessionKey（16 字节随机）
async function signFrame(frame, seq) {
  const body = JSON.stringify({ ...frame, seq, ts: Date.now() });
  const key = await crypto.subtle.importKey('raw', sessionKey, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return { body, sig: btoa(String.fromCharCode(...sig)) };
}
// 仅对 c:snap / c:hit / c:died / c:botDeath 签名；心跳/加入不签，控制开销
```
服务端校验 `abs(now-ts) <= 2000ms`、`seq > lastSeq[at.id][type]`、HMAC 一致，否则丢弃并计违规分。

**② 服务端行为评分（无 3D，只用快照 + 简化网格）**
```js
const win = at.behavior || (at.behavior = { hits:[], snaps:[], score:0 });
function onHit(at, m, now) {
  win.hits.push(now);
  win.hits = win.hits.filter(t => now - t < 1000);
  if (win.hits.length > 16) win.score += 2;                  // 超 16 发/秒
  if (!grid.los(m.fromPos, m.targetPos)) win.score += 5;     // 2D 网格 LOS
  if (win.score >= 10) kick(at, 'behavior');
}
function onSnap(at, p, now) {
  const prev = win.snaps.at(-1);
  if (prev) {
    const d = dist(p, prev.p) / Math.max(.01, (now - prev.t) / 1000);
    if (d > 9) win.score += 3;                               // >9 m/s（sprint 7.8 + 容差）
  }
  win.snaps.push({ p, t: now });
  if (win.snaps.length > 10) win.snaps.shift();
}
```
`grid.los()` 用服务端持有的 **AABB 墙体数组**（由客户端构建时导出一份紧凑 JSON，约几十 KB）做线段相交，不需要 three.js。

**③ 违规处置梯度**
```text
score 1–4   ：静默记录 + 服务端降低该玩家的快照广播优先级
score 5–9   ：丢弃其 c:hit / c:botDeath，UI 提示 "connection unstable"
score ≥10   ：ws.close(4001,'anti-cheat') + 结构化日志 + 同 IP 短时封禁
```
先在 **shadow mode**（只记录不处置）跑 1–2 周校准阈值，避免误封。

**④ 信息泄露的轻量缓解**
- 服务端保存每个玩家“最近可见位置”，敌人快照按 2D LOS 网格 + 40 m 距离决定下发；不可见时降频到 1 Hz 且量化到 1 m；
- `hp` 只对队友与近期命中者下发；`yaw/pitch` 对敌人只发 8 方向量化值；
- 客户端雷达/名称牌同步加 LOS 过滤，保证普通玩家不依赖脚本也有公平体验。

## 4.3 落地顺序（建议 4 个迭代）

1. **止血（最高收益/最低成本）**：`c:hit` 全链路校验 + `c:snap` id/边界/速度校验 + `BOT_DEATH` seq 与 bot 存在性校验；生产剥离调试全局。
2. **传输安全**：强制 wss + Origin 校验 + 服务端签发 token + 接收侧 `S.HIT` 数值校验 + 违规踢人日志。
3. **协议硬化**：schema 校验、时间戳窗口、HMAC 签名、每类型 seq。
4. **行为与信息控制**：2D 网格 LOS、行为评分、AOI 广播、shadow mode 调参后启用处置。

---

## 五、结论

XSS、名字清洗、host 权限服务端设定、存档无凭据持久化这几项是**已经做对**的；但只要服务端仍“不跑物理、不跑 AI、只转发”，命中、位置、死亡三类核心数据就完全可被客户端伪造，透视则是协议层固有属性。Web 端可行的路线不是把客户端锁死，而是用**服务端轻量权威（2D 网格 + 统计）+ 会话签名 + 分级处置**把作弊成本抬到远高于收益，同时保持现有单文件、好友房、低延迟的体验。
