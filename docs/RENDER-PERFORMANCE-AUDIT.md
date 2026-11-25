# GUNTOGUN 渲染与性能量化审计报告

> 审计日期：2026-11-24
> 审查对象：`C:/Users/shisunbin/.local/share/opencode/worktree/2a4dd0/crisp-comet`（GUNTOGUN v1.11.0）
> 数据来源：静态代码核查 + 上一轮 opencode 会话中的浏览器实测（Three.js `renderer.info`、`?perf=1`）+ 文件体积实测
> 说明：本文的“预期收益”为基于代码路径与实测基线的工程估算，不是新跑的 A/B 基准；每项都给出可复测的验收指标。

---

## 0. 基线快照

| 指标 | 实测/代码基线 | 来源 |
|---|---|---|
| Draw calls | **89–90 / 帧**（菜单与 4v4 对局均接近） | `?perf=1` + `renderer.info.render.calls` |
| 三角面 | **约 95,000 / 帧** | `renderer.info.render.triangles` |
| 几何体 / 纹理 / 程序 | **208 / 93 / 40** | `renderer.info.memory` |
| 手动渲染 CPU 耗时 | **1.3–2.9 ms/帧**（不含完整 tick 的 AI/物理） | 浏览器 `performance.now()` 包裹 `composer.render()` |
| 有效 DPR | 高画质上限 2，动态区间 **0.7–1.0**；实测 **0.875** | `main.js:432-436,1153-1161` |
| Composer | **4 个 Pass**：2×RenderPass + UnrealBloomPass + OutputPass；HalfFloat RT，high 档 4× MSAA | `main.js:417-429` |
| 阴影 | 单方向光 **2048²**（high）/1024²（low），`autoUpdate=false`，**隔帧** `needsUpdate` | `main.js:132,1344-1346`；`world.js:147-153` |
| 地面网格 | **110×110 段 = 24,200 三角面**，占基线约 25% | `world.js:174,303` |
| 合批 | `InstancedMesh` / `BatchedMesh` / `mergeGeometries` **全部 0 命中** | 全库检索 |
| LOD / 遮挡剔除 | **0 命中**；`SkinnedMesh.frustumCulled=false` | `modelAssets.js:487` |
| 纹理 | 全部运行时 `CanvasTexture`；地面 **12 张 1024²** ≈ **48 MB** 原始像素，无 KTX2/WebP | `assets.js:753-765` |
| GLB | 4 套共享骨骼 **1,713,216 B（1.63 MiB）**，base64 内嵌膨胀到 **2.18 MiB**；HTML 总计 **3,313,405 B（3.16 MiB）** | `build.mjs:23-37`、文件实测 |
| 纹理泄漏 | 4 次进出 DM：`textures` **148 → 174 → 181 → 188 → 195**，净 **+7/局** | 上一轮浏览器实测 |
| 碰撞体 C | 约 **35–70**（lava 图约 38 个熔岩边界盒） | `world.js:addBox` 约 48 处调用 |

**总体判断**：当前瓶颈不是单点“某段代码慢”，而是三件事叠加——**逐物体提交（无合批）+ 高填充率后处理（DPR 2 / HalfFloat / Bloom）+ 高频线性射线与碰撞扫描**。内存侧存在一条明确的**每局 +7 纹理**泄漏，加载侧存在**同步生成 12 张 1024² 贴图**的首屏阻塞。

---

# 一、帧率瓶颈

## F1 静态场景未合批，逐物体提交 — 影响等级：高

**定位**：`src/world.js:62-75`（`addBox` 每次 `new BoxGeometry` + `new Mesh`）；`world.js` 中 `addBox` 约 48 处调用；全库无 `InstancedMesh`/`mergeGeometries`。角色/武器同样逐零件 Mesh（`character.js:72-77`、`weapon.js:109-117`）。

**原理**：每个 Mesh = 至少 1 次主 pass draw call；`castShadow=true` 还会让它在奇数帧的阴影 pass 再提交一次。静态掩体、集装箱、路障使用共享材质表（`assets.js:782-898`），天然适合按材质合并为 `InstancedMesh`，把“每物体一次提交”变成“每材质一次提交”，同时保留逐实例矩阵与 Raycaster 支持（`InstancedMesh.raycast` 返回 `instanceId`）。

**预期收益**：按可见静态盒约 40–60 个估算，主 pass 减少 **30–45 calls/帧**，阴影 pass 同幅度减少（摊平后再减约 15–22），合计 **89–90 → 约 45–60 calls/帧（-35%~-50%）**；中端设备 CPU 提交节省约 **1–2 ms/帧**。验收：`?perf=1` 的 `calls` ≤ 60。

```js
// world.js：把 addBox 改为按材质收集，地图构建末尾统一 flush
const _bucket = new Map(), _Y = new THREE.Vector3(0, 1, 0);
function addBox(scene, shootStatics, colliders, ctx, o) {
  const { w, h, d, x, y, z, ry = 0, mat, shadow = true, collide = true } = o;
  if (collide) colliders.push(boxAABB(x, y, z, w, h, d, ry)); // AABB 逻辑保持不变
  let b = _bucket.get(mat.uuid);
  if (!b) _bucket.set(mat.uuid, b = { mat, shadow, items: [] });
  b.items.push({ w, h, d, x, y, z, ry });
}
export function flushBoxInstances(scene, shootStatics) {
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  const p = new THREE.Vector3(), s = new THREE.Vector3();
  for (const { mat, shadow, items } of _bucket.values()) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, items.length);
    items.forEach((it, i) => {
      p.set(it.x, it.y, it.z);
      q.setFromAxisAngle(_Y, it.ry);
      s.set(it.w, it.h, it.d);
      im.setMatrixAt(i, m4.compose(p, q, s));
    });
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = shadow; im.receiveShadow = true;
    scene.add(im); shootStatics.push(im); // Raycaster 原生支持 InstancedMesh
  }
  _bucket.clear();
}
```

---

## F2 无 LOD / 无距离剔除，地面 24k 三角面白交 — 影响等级：高

**定位**：`src/world.js:174`（`PlaneGeometry(360,360,110,110)`）、`:303`（注释确认 24k-tri ground）；`modelAssets.js:487`（8 个角色的 `SkinnedMesh` 一律关闭视锥剔除）；全库无 `THREE.LOD`、无遮挡剔除。

**原理**：地面细节主要由 `assets.js:755-765` 的 1024² 法线贴图提供，几何细分到 110×110 对视觉贡献很小；角色在 30 m 外仍提交完整骨架网格，视线外的角色因 `frustumCulled=false` 也照常提交。降低地面细分 + 给骨骼网格恢复剔除（配合保守包围球）可直接减少 GPU 顶点与提交量。

**预期收益**：地面 110² → 64² 段，三角面 **24,200 → 8,192（-16,008，约占总面数 -17%）**；恢复角色视锥剔除后，背向/画面外角色最多减少 **4–8 个 skinned draw + 对应骨骼动画提交**。验收：`triangles` ≤ 80,000，`calls` 同步下降。

```js
// world.js：按画质决定地面细分，细节交给法线贴图
const seg = this.quality === 'high' ? 64 : 32;
const groundGeo = new THREE.PlaneGeometry(360, 360, seg, seg);

// modelAssets.js：恢复剔除，但给包围球留动画余量，避免"动起来就消失"
root.traverse(o => {
  if (!o.isMesh && !o.isSkinnedMesh) return;
  o.frustumCulled = true;
  if (o.isSkinnedMesh && o.computeBoundingSphere) {
    o.computeBoundingSphere();
    if (o.boundingSphere) o.boundingSphere.radius *= 1.3; // idle/受击/死亡动画余量
  }
});
```

---

## F3 DPR 2 + HalfFloat + 4× MSAA + Bloom 全分辨率 — 影响等级：高

**定位**：`src/main.js:419-428`（HalfFloat RT、`samples:4`、`UnrealBloomPass(.42,.55,.82)`）、`:432-436`（DPR 上限 high=2 / low=1）、`:1153-1161`（60 帧自适应 0.7–1.0）。

**原理**：后处理成本与像素数成正比。DPR 从 2 降到 1.5，像素数减少 `1-(1.5/2)² = 43.75%`；Bloom 是低频效果，用半分辨率 RT 计算后上采样，视觉差异极小但填充率降低约 **75%**。当前自适应分辨率只在卡顿率 >20% 时才降，属于“先卡后降”，应在移动端直接收紧上限。

**预期收益**：移动端上限 1.5 → **-44% 后处理像素**；Bloom 半分辨率 → **Bloom 开销 -75%**（估算 1–3 ms GPU/帧）；两项合计预计 **总帧时 -10%~-20%**。验收：`?perf=1` 的 slow ratio <5%，且 `?shot=combat` 截图对比无可见画质退化。

```js
// main.js _applyQuality()：移动端收紧 DPR，并强制 Bloom 走半分辨率
_applyQuality() {
  const coarse = matchMedia('(pointer:coarse)').matches;
  const cap = coarse ? 1.5 : 2;
  const pr = Math.min(devicePixelRatio || 1, cap) * (this.dynScale || 1);
  this.renderer.setPixelRatio(pr);
  this.composer.setPixelRatio(pr);          // 内部会用 CSS 尺寸 × pr 调 pass.setSize
  const w = Math.max(1, Math.round(innerWidth  * pr / 2));
  const h = Math.max(1, Math.round(innerHeight * pr / 2));
  this.bloom.setSize(w, h);                 // composer.setPixelRatio 之后覆盖为半分辨率
}
```

---

## F4 阴影 2048² / ±70 m，投影体无筛选 — 影响等级：高

**定位**：`src/world.js:147-153`（`mapSize 2048`、`left/right/top/bottom ±70`、`far=260`、`bias=-.0004`、`normalBias=.03`）；`main.js:132,1344-1346`（隔帧更新）；`modelAssets.js:309`（所有骨骼网格 `castShadow=true`）。

**原理**：阴影是本项目除 Bloom 外最大 GPU 项。2048² 深度图 = 约 **16 MB**（按 4 B/像素），1024² = 4 MB；覆盖 ±70 m 意味着 texel 密度仅约 68 texel/m，缩小到 ±45 m 反而**提升**有效精度。隔帧策略已把平均成本砍半，下一步是缩小 map 与收紧投影体。

**预期收益**：2048² → 1024² 使深度像素 **-75%**、阴影显存 **16 MB → 4 MB**，阴影 pass 估算 **-20%~-30% GPU 时间**；结合 F1 的静态投影体合批，奇数帧额外 draw 再降 15–22。验收：奇数帧 `calls` 与偶数帧差值 ≤ 20。

```js
// world.js buildWorldFor()：high 档也用 1024，收紧 frustum 后更新投影矩阵
const shadowSize = 1024; // 从 2048 下调
sun.shadow.mapSize.set(shadowSize, shadowSize);
Object.assign(sun.shadow.camera, {
  left: -45, right: 45, top: 45, bottom: -45, near: 12, far: 180,
});
sun.shadow.camera.updateProjectionMatrix();   // 改 frustum 后必须调用
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
```

---

## F5 射线检测线性扫描 + 寻路 O(C²) — 影响等级：高（尖峰）

**定位**：
- 玩家开火：`main.js:786-787,795,848,853`（每发 1–2 次 `intersectObjects(shootStatics≈50–100 mesh)`，穿透升级翻倍），射速最高 800 rpm ≈ **13.3 发/秒**。
- Bot LOS：`main.js:1368-1375` 的 `_los` 每次 `b.clone()` + 全列表求交；`heroes.js:578` 稳态约 **64 次/秒**，病态上界 **8×60=480 次/秒**。
- 寻路：`heroes.js:600-625` `_findCover` 双重 collider 循环 **O(C²)**，C≈60 时单次约 **3,600 次迭代 + ≤60 条 LOS**；`:647-670` `_cornerRoute` 叠加 `_segFree` 最坏 **O(C²×采样数)**。
- 分离：`heroes.js:357-369`（每 bot 调用，8×8）、`:1020-1032`（28 对/帧）。

**原理**：所有求交都是对未分区列表的线性扫描。用“每帧 LOS 预算 + 空间哈希网格”可把尖峰压平：预算限制最坏情况，网格把候选 collider 从 C 降到邻近 3–8 个。

**预期收益**：LOS 尖峰 **480/s → ≤240/s（-50%）**；碰撞候选 **每次 O(60) → O(3–8)（-85%以上）**，估算峰值帧时 **-1~3 ms**。验收：8 bot 同时寻路时无 >25 ms 帧（`?perf=1` slow 计数不跳）。

```js
// main.js：每帧给 AI LOS 设预算，超预算视为通视（下一帧重判），避免同帧射线风暴
_losCapped(a, b) {
  if (this._losLeft <= 0) return true;
  this._losLeft--;
  return this._los(a, b);
}
// tick() 开头：this._losLeft = 4;  传给 heroes.update 的回调用 (a,b)=>this._losCapped(a,b)
// 原 _los 中的 b.clone() 改为复用：
this._losDir.copy(b).sub(a);
const len = this._losDir.length();
if (len < .5) return true;
this.losRay.set(a, this._losDir.multiplyScalar(1 / len));
this.losRay.far = len - .3;
return this.losRay.intersectObjects(this.world.losStatics || this.world.shootStatics, false).length === 0;

// world.js：构建 collider 空间哈希，heroes/player 查询邻近格而不是全表
buildColliderGrid(colliders, cell = 8) {
  const g = new Map();
  for (const c of colliders) {
    const x0 = Math.floor(c.minX / cell), x1 = Math.floor(c.maxX / cell);
    const z0 = Math.floor(c.minZ / cell), z1 = Math.floor(c.maxZ / cell);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = x + ',' + z;
      let a = g.get(k); if (!a) g.set(k, a = []);
      a.push(c);
    }
  }
  return {
    query(x, z, r = 1) {
      const out = new Set();
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
        for (const c of g.get((Math.floor(x / cell) + i) + ',' + (Math.floor(z / cell) + j)) || []) out.add(c);
      }
      return out;
    },
  };
}
```

---

## F6 每帧无条件重计算与 DOM 写入 — 影响等级：中

**定位**：`src/main.js:1357`（`viewCam.updateProjectionMatrix()` 无条件每帧）、`:1274-1296`（`setHealth`/`crosshair`/`hint` 每帧写 DOM）、`:1335`（每帧 `getElementById('radar')`）、`:1327`（`worldAnim` 闭包每帧全执行）；`src/ui.js:369-379,543-555`（未去重的写入）。

**原理**：`updateProjectionMatrix()` 会重算投影矩阵并触发 uniform 上传；DOM `textContent`/`style` 写入触发样式重算。虽然单次很便宜，但在 60 fps 下就是每秒 60 次无意义工作。

**预期收益**：估算 **0.3–0.8 ms/帧**，并减少 GC 与 layout 抖动。验收：Chrome Performance 面板中 scripting 占比下降 3–5 个百分点。

```js
// main.js _applyCameraState()：只在 aspect/fov 变化时更新投影矩阵
const targetAspect = innerWidth / Math.max(1, innerHeight);
if (Math.abs(this.viewCam.aspect - targetAspect) > 1e-4) {
  this.viewCam.aspect = targetAspect;
  this.viewCam.updateProjectionMatrix();
}
// ui.js：给 setHealth 加 key 去重（setAmo/crosshair 已有同类实现）
setHealth(h, m) {
  const k = h + '/' + m;
  if (k === this._hpKey) return;
  this._hpKey = k;
  /* ...原有 DOM 写入... */
}
```

---

## F7 物理无固定步长、dt 直接透传 — 影响等级：中

**定位**：`src/main.js:1145`（`dtRaw = Math.min(.05, clock.getDelta())`）；所有 `update(dt)` 直接使用可变 dt；`interp.js` 只服务网络快照，不服务本地物理；无 accumulator / fixed-step。

**原理**：可变步长让碰撞推出、弹道扩散、AI 反应在不同帧率下不一致；60 fps 与 30 fps 的手感和命中不同。固定步长 + 渲染插值可让物理成本可预测，也便于做“每帧最多 N 次物理子步”的预算控制。

**预期收益**：主要是稳定性（低帧率下不再出现穿薄墙/跳跃高度漂移），CPU 总量基本不变；配合 F5 的 collider 网格，物理遍历成本可降 5–10×。验收：`?perf=1` 在人为限速 30 fps 时，跳跃高度与命中结果与 60 fps 偏差 <5%。

```js
// main.js：固定 1/60 步，最多 3 子步，渲染用 alpha 插值（位置留给 renderer）
const STEP = 1 / 60;
this._acc = Math.min(this._acc + dtRaw, STEP * 3);
while (this._acc >= STEP) {
  this.player.update(STEP, this.input, this.keys, this.time, this.audio);
  this.heroes.update(STEP, this.time, this._losCapped);
  this._acc -= STEP;
}
const alpha = this._acc / STEP;   // 需要平滑的视觉量用 alpha 插值
```

---

# 二、内存风险

## M1 每局净增 7 张纹理（GPU 孤儿） — 影响等级：高

**定位**：`src/heroes.js:34-57`（每 bot 新建 256×64 `CanvasTexture`）、`:885-897`（dispose 调用存在）；`src/modelAssets.js:482-499`（材质克隆、贴图共享）；`src/main.js:582-632,735-750`（startGame/toMenu 生命周期）。

**量化**：DM 固定 7 个 bot，与 **+7 纹理/局**精确吻合。单张 256×64 RGBA = 64 KiB（含 mipmap ≈ 85 KiB），即 **约 0.56–0.6 MiB/局**；线性外推 100 局约 **60 MiB** 显存增长，最终触发 `webglcontextlost` → 整机 reload（`main.js:136-141`）。埋点显示 7 张纹理确实调用了 `dispose()`，但 renderer 计数不降，说明**共享/独占贴图归属不清**。

**原理与修复**：按名字+阵营缓存名字牌纹理（7 bot 复用少量纹理），给贴图打 `userData.owned` 标记，释放时只处理 owned 资源；用 e2e 断言把泄漏钉死。

**预期收益**：纹理基线从 **+7/局 → 0/局**；显存节省 **0.6 MiB/局**，长时间挂机不再必然 context lost。验收：`?e2e=1` 连续 10 次进出，`textures` 增量 ≤ 2。

```js
const TAG_CACHE = new Map();
function nameTagTexture(name, faction) {
  const k = name + '|' + faction;
  let t = TAG_CACHE.get(k);
  if (!t) {
    /* ...原 canvas 绘制... */
    t = new THREE.CanvasTexture(c);
    t.userData.owned = false;      // 模块级缓存，页面卸载时统一清
    TAG_CACHE.set(k, t);
  }
  return t;
}
dispose() {
  for (const m of this.materials) m.dispose();
  // 只释放本实例独占资源；名字牌纹理来自缓存，不在这里 dispose
  this.nameTag = null;
}
```

---

## M2 爆炸 / 无人机 / 弹丸无对象池 — 影响等级：高（GC 尖峰）

**定位**：`src/effects.js:259-291,359,368,375`（每次爆炸 2 个 SphereGeometry + 3 个克隆材质 + 7 个 debris Mesh，debris **仅 remove 不 dispose**）；`src/enemies.js:69-107,203-208,411-413`（每只无人机 6–10 Mesh + 3 克隆材质，每发弹丸 1 Mesh，死亡全销毁）。粒子/曳光/弹壳已有池（`effects.js:7-149`、`weapon.js:98-103`），说明模式可复用。

**原理**：waves 模式波次刷新与手雷连爆会在同一帧创建/销毁几十个 GPU 资源，造成 GC 尖峰和驱动层分配开销。把“创建即销毁”改成“取用—归还”，并把 7 个碎片改成 `InstancedMesh` 槽位。

**预期收益**：爆炸相关分配 **归零**，GC 尖峰估算 **-70%**；无人机波次切换帧时更平稳。验收：连续 10 次爆炸，堆分配曲线无锯齿。

```js
// effects.js：固定槽位的爆炸球池
class ExplosionPool {
  constructor(scene, geo, mat, n = 8) {
    this.items = Array.from({ length: n }, () => {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false; m.life = 0; scene.add(m); return m;
    });
  }
  spawn(pos, scale, duration = .45) {
    const m = this.items.find(x => !x.visible) || this.items[0];
    m.position.copy(pos); m.scale.setScalar(scale); m.visible = true; m.life = duration;
    return m;
  }
  update(dt) {
    for (const m of this.items) if (m.visible && (m.life -= dt) <= 0) m.visible = false;
  }
}
// 碎片：预分配 7×N 的 InstancedMesh，用 setMatrixAt 写位姿，不再 new Mesh
```

---

## M3 `portraits.cache` 按组合键增长且 dispose 从未调用 — 影响等级：中

**定位**：`src/portraits.js:14,55-80,143-156`；`src/main.js:172,165`。

**原理**：key = `mode|op|camo|size|frame`，随 8 干员 × 迷彩 × 尺寸 × 画框 × 2 模式增长；每个 value 是 512² PNG dataURL（数十到数百 KB 字符串）。`dispose()` 存在但无调用点，`cache.clear()` 只丢引用、不释放离屏 WebGL 资源。

**预期收益**：LRU 上限 64 后，字符串缓存从“无界”变为 **< 20 MB 量级**。验收：反复切换干员/迷彩 200 次，`portraits.cache.size ≤ 64`。

```js
renderCached(op, camo, size, frame) {
  const k = [op.id, camo, size, frame].join('|');
  if (this.cache.has(k)) return this.cache.get(k);
  if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value); // LRU
  const v = this.render(op, camo, size, { frame });
  this.cache.set(k, v);
  return v;
}
```

---

## M4 dispose 边界脆弱、缺少 teardown — 影响等级：中

**定位**：`src/world.js:790-800`（`traverse` 无条件 `geometry.dispose()`）；`src/main.js:417-429`（无 `composer.dispose()` / `bloom.dispose()`）；`src/effects.js` 全文无 dispose 出口；`src/portraits.js:143-156` 的 dispose 无调用点。

**原理**：当前 world 几何均为现场创建、共享材质靠 `ownMats` 排除，所以没有实际误释放；但这是约定而非契约。Composer/Bloom/Effects 都是构造期单例，靠页面卸载回收，若未来做“设置切换质量重建 renderer”就会泄漏整条 RT 链。

**预期收益**：把“约定”变成“标记”，避免未来切图/重建时引入难查的 GPU 孤儿。验收：切图 20 次，`renderer.info.memory.geometries` 回到基线 ±2。

```js
// world.js：共享几何显式豁免
world.group.traverse(o => {
  if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
  if (o.isLight && o.dispose) o.dispose();
});
for (const m of world.ownMats || []) m.dispose();

// main.js：提供完整 teardown（质量切换 / context restore 时调用）
teardownRenderer() {
  this.composer?.dispose();
  this.bloom?.dispose();
  this.effects?.dispose?.();
  this.portraits?.dispose?.();
  this.renderer?.dispose();
}
```

---

## M5 定时器与监听器无卸载回收 — 影响等级：低～中

**定位**：`src/main.js:487-506`（每次请求指针锁排 2 个 `setTimeout`，无 `clearTimeout`）；`src/audio.js:228-233`（每次 `whineStop` 一个 300 ms timer）；`src/input.js:130-133` 提供 `detach()` 但全项目无调用；`main.js` 21 处 `addEventListener`、0 处 `removeEventListener`，无 `pagehide` 清理。

**原理**：单例页面生命周期内影响有限，但指针锁重试在反复重开时会堆积回调；WebAudio 常驻节点（noiseBuf、wind/rain/rumble/drone）没有 `dispose()`/`close()`。

**预期收益**：消除重试回调堆积；为将来页面内嵌/热重载留出 teardown 路径。验收：反复重开 50 次后，无残留 timer 回调日志。

```js
_requestLock() {
  clearTimeout(this._lockT1); clearTimeout(this._lockT2);
  this._lockT1 = setTimeout(/* 原 1400ms 逻辑 */, 1400);
  this._lockT2 = setTimeout(/* 原 2300ms 逻辑 */, 2300);
}
window.addEventListener('pagehide', () => {
  clearTimeout(this._lockT1); clearTimeout(this._lockT2);
  this.inputMgr.detach();
  this.audio.dispose?.();
});
```

---

# 三、加载耗时

## L1 `initAssets()` 同步生成 12 张 1024² 贴图，阻塞首帧 — 影响等级：高

**定位**：`src/main.js:164`（构造期同步 `this.assets=initAssets()`，发生在 `preloadCharacters` 与首次 `composer.render()` 之前）；`src/assets.js:753-765`（地面 3 种 ×2–3 张 1024²）、`:936-950`（广告牌 1024×512）、`:516-529`（枪械 512² 三通道）。

**量化**：12 张 1024² RGBA ≈ **48 MB** 原始像素；其中法线图经 Sobel 逐像素处理（`assets.js:31-47`），约 **12.6 M 像素**的邻域采样，中端设备估算 **100–300 ms** 主线程阻塞。

**原理与修复**：先给占位贴图（纯色/1×1 DataTexture）让菜单立即可交互，空闲时再用 Worker + OffscreenCanvas 生成并热替换；或预烘焙成压缩纹理（见 L2）。

**预期收益**：首屏可交互时间 **-100~300 ms**。验收：Performance 面板中 `initAssets` 长任务 < 50 ms。

```js
// assets.js：先占位，空闲生成，避免首帧长任务
A.ground.sand.normalMap = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
requestIdleCallback(async () => {
  const normal = await normalWorker.generate(1024, 'sand'); // OffscreenCanvas + Sobel
  A.ground.sand.normalMap = normal;
  A.ground.sand.needsUpdate = true;
}, { timeout: 2000 });
```

---

## L2 未使用 KTX2 / WebP 等压缩纹理 — 影响等级：高

**定位**：`src/assets.js:1`（"all generated on canvas, no external assets"）、`:21-28,31-47,516-529,753-765`；全库无 `KTX2Loader`、无 Basis 转码。

**原理**：CanvasTexture 以未压缩 RGBA 上传 GPU，12 张 1024² 就是 48 MB；KTX2/BasisU 在 GPU 侧保持压缩，通常 **-75%~-85%** 显存与上传带宽，还省掉运行时 Sobel/绘制的 CPU。代价是需要在单文件构建中内嵌 transcoder（JS+wasm，约数百 KB），仍需满足 <5 MB 预算（当前 3.16 MB，余量约 1.8 MB）。

**预期收益**：贴图显存 **48 MB → 约 8–12 MB（-75%~-85%）**，首屏贴图生成 CPU **接近归零**。验收：`renderer.info.memory.textures` 不变但 `performance.memory.usedJSHeapSize` 明显下降，GPU 占用用浏览器任务管理器对比。

```js
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
const ktx2 = new KTX2Loader()
  .setTranscoderPath('/basis/')       // 单文件构建时改为内嵌 base64 URL
  .detectSupport(renderer);
const sand = await ktx2.loadAsync('ground_sand.ktx2');
sand.wrapS = sand.wrapT = THREE.RepeatWrapping;
A.ground.sand.map = sand;
A.ground.sand.needsUpdate = true;
```

---

## L3 GLB base64 内嵌解码与解析抢主线程 — 影响等级：中

**定位**：`build.mjs:23-37`（4 个 GLB → 2.18 MiB base64 内嵌）；`src/modelAssets.js:75-87`（`atob` 逐字节转 `Uint8Array`）、`:123-144`（`DOMContentLoaded` 立即 `preloadCharacters`）；`src/main.js:167-175`。

**量化**：1.63 MiB 原始 GLB，base64 膨胀 ×4/3 至 **2.18 MiB**；`atob` + GLTF 解析共处理约 1.7 MB 二进制，估计 **50–150 ms** 主线程。

**原理**：菜单已用程序化角色保证可交互（`modelAssets.mode()` 默认 proc），因此 GLB 解码完全可以在 `requestIdleCallback` 里做，不必与首屏渲染抢时间。防重复加载守卫（`state.loading||state.ready`）已经存在，保持即可。

**预期收益**：首屏脚本阻塞 **-50~150 ms**，菜单交互更早可用。验收：首帧渲染前无 >50 ms 的 GLB 解码任务。

```js
// main.js：把 GLB 预加载移到空闲时段，首屏先用程序化角色
const start = () => preloadCharacters();
if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded',
    () => requestIdleCallback(start, { timeout: 3000 }), { once: true });
} else requestIdleCallback(start, { timeout: 3000 });
```

---

## L4 空 catch 让加载失败不可观测 — 影响等级：中

**定位**：`src/main.js:162`（PMREM）、`:402`（每地图环境）、`:496/498`（PointerLock Promise）；`src/ui.js:572/603/621`、`src/i18n.js:308/313/331`、`src/audio.js:173/232` 等；`src/net.js:69`（`ws.onerror=()=>{}`）。

**原理**：失败回退本身是对的（GLB → 程序化角色、PMREM → 无 IBL），但完全静默让线上“贴图没出来”“音频没启动”无法定位。统一走 `ui.debug()` 并 `console.warn`，不影响玩家但保留诊断。

**预期收益**：加载类故障定位时间从“不可查”降到“可复现”。验收：人为破坏 GLB 标签后，控制台与 UI debug 均有明确记录，且游戏仍可玩。

```js
try {
  const pmrem = new THREE.PMREMGenerator(this.renderer);
  this.scene.environment = pmrem.fromScene(new RoomEnvironment(), .04).texture;
  pmrem.dispose();
} catch (e) {
  console.warn('[env] PMREM failed, using flat lighting', e);
  this.ui.debug('ERR env map fallback', true);
}
```

---

# 四、Top5 优先级优化行动项

| 顺序 | 行动项 | 影响域 | 等级 | 预期收益 | 落地代码 |
|---|---|---|---|---|---|
| 1 | 修复 +7 纹理/局并加 e2e 断言 | 内存风险 | 高 | 显存 **0.6 MiB/局 → 0**；消除 context lost 根因 | 见下方 ① |
| 2 | 静态盒按材质 `InstancedMesh` 合批 | 帧率瓶颈 | 高 | **-30~45 calls/帧**，阴影 pass 同降 | 见 F1 代码 |
| 3 | DPR 移动端上限 1.5 + Bloom 半分辨率 | 帧率瓶颈 | 高 | **-44% 后处理像素**、**Bloom -75%** | 见 F3 代码 |
| 4 | 贴图改 KTX2 / 空闲生成，拆掉同步 48 MB Canvas | 加载耗时 | 高 | 贴图显存 **-75%~-85%**、首屏 **-100~300 ms** | 见 L1/L2 代码 |
| 5 | LOS 预算 + collider 空间哈希 | 帧率瓶颈 | 高 | 射线尖峰 **-50%**、碰撞候选 **-85%** | 见 F5 代码 |

### ① 纹理泄漏闭环（Top1 完整示例）

```js
// e2e 断言：连续 10 次进出，纹理基线不得抬升
for (let i = 0; i < 10; i++) {
  g.ui.sel.mode = 'dm'; g.ui.sel.map = 'desert';
  g.startGame();
  g.renderer.info.reset(); g.composer.render();
  const during = g.renderer.info.memory.textures;
  g.toMenu();
  g.renderer.info.reset(); g.composer.render();
  assert(g.renderer.info.memory.textures <= base + 2,
    `texture leak after cycle ${i}: ${base} -> ${g.renderer.info.memory.textures} (during ${during})`);
}
```

### ② 合批后射线兼容性（Top2 要点）

`InstancedMesh` 已被 Three.js `Raycaster` 原生支持，命中结果带 `instanceId`；现有 `main.js:786-787,848` 的 `intersectObjects` 无需改写即可继续工作，只需确保 `shootStatics` 里放的是 InstancedMesh 而不是旧的每个盒子 Mesh。

### ③ 验收门禁（加入 CI 或 `?perf=1` 自检）

```text
[ ] calls ≤ 60 / 帧（原 89–90）
[ ] triangles ≤ 80,000（原约 95,000）
[ ] 10 次进出后 textures 增量 ≤ 2（原 +70）
[ ] slow ratio（dt>25ms）< 5%
[ ] 首帧前无 >50ms 资源生成/解码任务
[ ] dist/gun-to-gun.html < 5MB（KTX2 transcoder 内嵌后仍需满足）
```

---

## 五、结论

当前实现的**正向基础**很扎实：隔帧阴影、自适应分辨率、GLB 惰性内嵌与失败回退、粒子/曳光/弹壳对象池、共享材质表、版本化 SW 缓存都已到位。真正拖住帧率的是四项“未做”：**合批、LOD/剔除、后处理分辨率控制、射线/碰撞空间分区**；真正威胁稳定性的是一项“做了但没闭环”：**名字牌纹理的释放归属**。按 Top5 顺序推进，预计可把 89–90 calls 压到 60 以内、95k 面压到 80k 以内，并把长期运行的显存增长曲线拉平。
