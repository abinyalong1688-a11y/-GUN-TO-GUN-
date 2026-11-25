# GUNTOGUN 审计整改记录（修复实施版）

对照四份审计报告（前端代码质量 / 渲染与性能 / 安全加固 / 网络同步）+ 玩法边界专项，本次在 `crisp-comet` 工作树完成了可落地的修复。
**验证基线：`node --test` 119/119 通过；`npm run build` 产出 3.16 MB 单文件（预算 4 MB）。**

## 一、玩法与物理

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 1 | Arena 死亡后永不复活（倒计时每帧被重置） | 死亡副作用用一次性 `_deathHandled` 隔离，`dmRespawnT` 只在死亡瞬间置 2.5，之后正常倒计时；复活时清标记 | `src/main.js:1258-1281`, `src/main.js:1352-1378` |
| 2 | 死亡/慢放期间仍可开火、计分 | `weapon.update` 仅在 `player.alive` 时执行；`fire()` 增加存活硬守卫 | `src/main.js:1287`, `src/main.js:827-831` |
| 3 | 换弹中切枪把弹药装到新枪 | 切枪取消当前换弹（不结算弹药），并复位弹匣/手臂姿态；换弹动画期间禁止开始换弹 | `src/weapon.js:496-520`, `src/weapon.js:561` |
| 4 | 蹲起无头顶检测，可穿入上层掩体 | `canStand()` 做水平重叠 + 高度区间检测，被挡时保持蹲伏；蹲伏请求优先 | `src/player.js:99-115` |
| 5 | 旋转盒用外接 AABB，角落有隐形碰撞 | 新增 OBB 推出：局部坐标系最近点 + 最浅面弹出；支撑/落地/头顶查询改用真实 OBB 足迹，不会站在 AABB 空角上 | `src/collision.js`, `src/world.js:62-77`, `src/player.js:56-101`, `src/heroes.js:340-360` |
| 6 | 射线起点在命中球内时返回 null，贴脸打空 | 球内起点返回 0 距离 | `src/main.js:808-820` |
| 7 | 命中盒颈部 7–11 cm 缝隙、远端蹲伏标志未使用 | 增加颈部球（r=0.09）桥接头/身；`hitSpheres` 读取快照 crouch 下移头/身/颈 | `src/heroes.js:204-219` |
| 8 | 后坐力只作用于相机，准星与弹道分离 | 弹道方向叠加当帧 `camKick/camKickYaw`，与相机视觉一致；俯仰夹紧 ±89° | `src/main.js:836-843` |
| 9 | 切后台不暂停（触屏/fallback 瞄准） | `visibilitychange` 清空输入并暂停；联机回到联机菜单避免掉线死亡 | `src/main.js:151-158` |
| 10 | WebGL 上下文丢失直接整页重载 | 先 `webglcontextrestored` 原地重建渲染器/合成器/环境贴图，5 s 未恢复才 reload | `src/main.js:138-150`, `src/main.js:780-803` |
| 11 | 同帧多手雷爆炸伤害叠加 | 每帧 `_frameHits` 去重，同一目标每帧只吃一次破片伤害 | `src/grenades.js:48-51, 93-104` |
| 12 | bot 分离把玩家推回墙内 | `_separate` 后对所有 bot 重跑一次碰撞；玩家在 bot 更新后也重跑 `_collide` | `src/heroes.js:1020-1028`, `src/main.js:1320-1323` |
| 13 | 重生点落入门柱/掩体 | 8 次抖动重试 + `_collide` + `_spawnClear()` 校验后才交还控制 | `src/main.js:805-825`, `src/main.js:1261-1268` |
| 14 | 空开局 / 非法阵营 roster 抛错 | 联机无 pending 直接回菜单；空阵营回退 `DEFAULT_OP`；bot 池空时兜底 | `src/main.js:611-618`, `src/heroes.js:996-1000` |
| 15 | 空仓必须松扳机才换弹 | 空仓即自动换弹（按住扳机也触发），空仓提示只响一次 | `src/weapon.js:653-658` |
| 16 | 射线 far=400 远超 56 m 战场 | 弹道射线 far=120，节省远距空测 | `src/main.js:851` |

## 二、网络同步与协议

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 17 | 首包到达前时钟未就绪，插值时间跳变 | 首个 `S.PEERS/S.BOTS.st` 播种 offset 并置 `ready`；PONG 再用 EWMA 校正 | `src/netMatch.js:69-83` |
| 18 | 固定插值延迟不适配 RTT/抖动 | PONG 按 `rtt*0.5 + jitter*2` 自适应，夹在 60–220 ms（bot 80–240 ms） | `src/netMatch.js:110-118` |
| 19 | 重复/乱序快照、瞬移与短外推 | 快照缓冲丢弃非单调帧；>8 m/200 ms 直接吸附；外推上限 120 ms 后冻结 | `src/interp.js:10-63` |
| 20 | 断线重连丢席位/丢房间 | HELLO 下发 token，重连携带 token + 房间码；仅未连接席位可被 token 认领 | `src/netMatch.js:39-47, 118-131`, `server/room.js:31-40` |
| 21 | 心跳无超时检测 | 4 s 无 PONG 主动触发重连 | `src/netMatch.js:211-214` |
| 22 | 主机迁移后 bot 归属错乱 | `S.HOST` 变化时 `becomeHost/stepDown`，bot 代理转本地模拟或反向 | `src/netMatch.js:95-98, 306-330` |
| 23 | 快照/命中/击杀服务端零校验 | 快照：发送者 id 必须匹配、全字段有限、地图边界、hp/flags 掩码、时间感知速度上限（0.35+12·dt m）；命中：存活、武器白名单、seq 去重、60 ms 最小间隔、1 s 600 伤害预算；bot 死亡：host、bot 存在且存活、seq 去重 | `server/worker.js:138-181, 199-217, 230-252` |
| 24 | 受害者客户端盲信 S.HIT | 校验 dmg 有限非负、按武器上限二次夹紧；`player.damage` 拒绝 NaN/Infinity/负数并单包封顶 400 | `src/netMatch.js:85-91`, `src/player.js:46-53` |
| 25 | 客户端盲信远端坐标 | `applyPeers` 丢弃非有限/越界坐标，hp 夹紧 0–200 | `src/remotePlayers.js:22-39` |

## 三、渲染与性能

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 26 | 移动端 DPR 2 + 全分辨率 Bloom | 粗指针 DPR 上限 1.5；Bloom 以 50% 分辨率渲染再上采样（填充率约 -75%） | `src/main.js:448-458` |
| 27 | 阴影每帧重算 | `shadowMap.autoUpdate=false`，隔帧 `needsUpdate`；低画质阴影 1024² | `src/main.js:133-136`, `src/main.js:1420-1422`, `src/world.js:146-150` |
| 28 | 地面 24.2k 三角面 | 平地网格 110² → 64²（低画质 32²），三角面约 -17k | `src/world.js:176-180` |
| 29 | 每帧无条件 `updateProjectionMatrix` | 仅 FOV 变化超过阈值时更新 | `src/main.js:1437-1444` |
| 30 | 视角模型每帧 Vector3 分配 | `HIP_POS.clone()` / `tip.clone()` 改为模块级 scratch | `src/weapon.js:10-15, 693, 738` |
| 31 | 每局 7 张名字牌纹理泄漏 | 名字牌 CanvasTexture 模块级缓存（同图复用），bot 销毁只释放材质；缓存上限 64，超出后不缓存并按实例释放 | `src/heroes.js:38-61, 893-899` |
| 32 | AI 视线检测无上限 | 每帧 LOS 预算 16 次；预算耗尽按“被遮挡”处理（绝不产生穿墙射击） | `src/main.js:1295, 1460-1466` |
| 33 | 加载期同步生成 1024² 贴图 | 未改（见延后项），已确认是首屏 100–300 ms 的主要阻塞 | `src/assets.js` |

## 四、安全

| # | 问题 | 修复 | 位置 |
|---|------|------|------|
| 34 | 生产包暴露 `window.__game` / `__i18n` / `__loopback`，`?e2e=1` 可改数值 | `DEBUG_HOOKS=false` 编译期剥离所有调试全局；`?server=`/localStorage 服务器地址仅调试构建可用 | `build.mjs:14-18`, `src/main.js:55,70`, `src/i18n.js:344`, `src/net.js:5-14` |
| 35 | 任意 `ws://` / 第三方服务器可被注入 | 只接受 `wss://`；`ws://localhost` 仅调试构建；生产 `?server=` 直接忽略 | `src/net.js:16-22` |
| 36 | 位置包可冒用他人 id / 瞬移 | 服务端强制 `p[0]===at.id`；时间感知速度上限 + 地图边界 + 高度夹紧 | `server/worker.js:141-149` |
| 37 | 命中包无频率/伤害上限 | 存活旗标、武器白名单、seq、60 ms 间隔、1 s 600 伤害预算 | `server/worker.js:171-183` |
| 38 | 房主伪造 bot 死亡刷分 | bot 必须存在且存活；killer 必须是房主或 bot；seq 去重；服务端写入 bot.alive | `server/worker.js:199-217` |
| 39 | 受害者可给同队刷击杀 | `recordKill` 仅在不同队伍之间计分 | `server/room.js:10-26` |
| 40 | 重连 token 可夺取在线席位 | token 仅匹配 `!connected` 的席位 | `server/room.js:31-40` |
| 41 | 存档脏数据进入运行时 | 每日任务/等级/XP 逐字段重建，非法值归零 | `src/save.js:31-46, 80-95` |

### 4.1 服务端权威命中（公开对局治本）

公开对局下，命中/伤害/穿墙三类竞技数据必须由服务端裁决，不再信任客户端。本项为公开部署的**核心加固**：

| 能力 | 实现 | 位置 |
|------|------|------|
| 权威伤害重算 | 服务端按 `武器基础伤害 × 爆头2倍` 重算，忽略客户端 `dmg`；PvE 的 boost/升级倍率联机不生效 | `src/netProtocol.js`（`WEAPON_DMG`/`HEAD_MUL`）, `server/worker.js` |
| 穿墙校验（LOS） | 客户端把地图遮挡几何烘焙成 `box`（精确 OBB）/ `cyl`，服务端做线段-旋转矩形/圆 + Y 高度区间的射线检测 | `src/world.js`（`losGeo`）, `server/los.js` |
| 命中裁决 | 目标必须在线、存活、在射程内、无遮挡，否则拒绝并重算伤害 | `server/worker.js`（`validateHit`） |
| 地图数据反篡改 | 首个上报的地图几何为权威，后续上传做 hash 比对，不一致记为作弊信号 | `server/worker.js`（`C.WORLD` + `hashGeo`） |
| 上传体积控制 | 几何量化成整数厘米（ry 毫弧度），92 盒地图 ~2.9 KB（< 4 KB 消息上限） | `src/world.js` |

**遗留**：bot 目标仅做权威伤害（bot 位置由房主模拟、服务端无权威坐标），bot 命中 LOS 需后续把 bot 模拟上移服务端；穿墙移动（位置权威）仍只做速度 clamp，未做墙体碰撞回放。

## 五、测试与构建

- 新增 `tests/collision.test.mjs`：AABB 最浅面弹出、OBB 空角可通行、旋转面推出、蹲伏头顶检测。
- 新增 `tests/los.test.mjs`：LOS 射线-AABB、旋转盒 OBB 精确性（45° 角不误判）、圆柱、Y 高度区间、`hashGeo` 反篡改、权威伤害计算。
- `tests/player.test.mjs` 增加伤害输入边界（NaN/Infinity/负数/字符串/单包 200 上限）。
- 既有 `interp` 测试覆盖重复/乱序/外推上限/瞬移吸附。
- `node --test` → **127 pass / 0 fail**；`npm run build` → **3.17 MB**（4 MB 预算内），PWA 产物正常。

## 六、明确延后项（附原因与建议）

1. **服务端权威命中/视线回放** ✅ 已实施（见 4.1）。**剩余**：bot 命中的服务端 LOS（需把 bot 模拟上移服务端，或将 bot 坐标在服务端权威化），以及穿墙移动的墙体碰撞回放。
2. **AOI / 视野裁剪**：地图半径 56 m、房间上限 10 人，任何 ≥60 m 的 AOI 都覆盖全场，收益为零；真正防透视需要服务端 LOS 可见性裁剪，已在 4.1 落地服务端 LOS 后可行，但全量坐标仍广播（对 10 人好友房影响小）。
3. **静态盒 InstancedMesh 合批**：预计 -30~45 draw calls/帧，但 `InstancedMesh` 的射线法线需要按实例矩阵修正、阴影/剔除/贴花需回归验证；当前环境无头浏览器不可用，避免未验证的渲染重构。建议在有截图回归的流水线中实施。
4. **KTX2/WebP + 贴图异步生成**：需要改资源管线与构建脚本；可先做 `requestIdleCallback` 分帧生成，首屏收益 100–300 ms。
5. **爆炸火球对象池**：每次爆炸 2 个 SphereGeometry（已正确 dispose，非泄漏），频率低；池化属微优化。
6. **房间码爆破/连接级限流**：需在 Worker 边缘按 IP 计数（Durable Object 之外），当前仅每连接 32 msg/s 令牌桶。
7. **反作弊遥测/封禁**：属于运营能力，需服务端存储与后台，非纯前端可闭环。当前已埋下 `at.worldMismatch` 等作弊信号，接入处置（shadow mode/踢人）即可用。

## 七、复验命令

```bash
node --test          # 127 tests
npm run build        # dist/gun-to-gun.html 3.17 MB
npm run serve        # 本地试玩（?e2e=1 仅在调试构建有效）
```
