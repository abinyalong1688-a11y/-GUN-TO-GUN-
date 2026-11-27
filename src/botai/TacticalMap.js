// 战术地图：从导航栅格离线推导掩体点、出入口、路线(Lane)、防守站位
// 全部在地图加载时烘焙一次，运行时只做查询与评分
import { dist } from './util.js';

export class TacticalMap {
  constructor(nav, inf) {
    this.nav = nav; this.inf = inf;
    this.covers = [];          // {x,z,nx,nz,exposure}  nx,nz = 背靠墙、面向开阔的法线
    this._coverBuckets = new Map();
    this.laneCache = new Map();
    this.defCache = new Map();
    this.bucketSize = 6;       // 掩体空间分桶（米）
  }

  // ---------- 掩体点 ----------
  buildCovers(step = 2) {
    const nav = this.nav, cols = nav.cols;
    this.covers.length = 0; this._coverBuckets.clear();
    for (let cy = 1; cy < nav.rows - 1; cy += step) for (let cx = 1; cx < cols - 1; cx += step) {
      const i = cy * cols + cx;
      if (nav.blocked[i]) continue;
      // 紧贴墙（1~2 格）且本身可站人
      if (nav.clear[i] < 1 || nav.clear[i] > 2.3) continue;
      let nx = 0, nz = 0, nBlocked = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const j = (cy + dy) * cols + (cx + dx);
        if (nav.inBounds(cx + dx, cy + dy) && nav.blocked[j]) { nx -= dx; nz -= dy; nBlocked++; }
      }
      if (!nBlocked) continue;
      const L = Math.hypot(nx, nz) || 1; nx /= L; nz /= L;
      const [x, z] = nav.cellToWorld(cx, cy);
      // 暴露度：12 个方向 6m 内能看出去的比例，越低掩体质量越好
      let visible = 0; const RAYS = 12;
      for (let k = 0; k < RAYS; k++) {
        const a = (k / RAYS) * Math.PI * 2;
        if (nav.lineOfSight(x, z, x + Math.cos(a) * 6, z + Math.sin(a) * 6, 1)) visible++;
      }
      const c = { x, z, nx, nz, exposure: visible / RAYS };
      this.covers.push(c);
      const key = this._bk(x, z); if (!this._coverBuckets.has(key)) this._coverBuckets.set(key, []); this._coverBuckets.get(key).push(c);
    }
    return this.covers.length;
  }
  _bk(x, z) { return `${Math.floor(x / this.bucketSize)},${Math.floor(z / this.bucketSize)}`; }
  coversNear(x, z, r) {
    const out = []; const b = this.bucketSize;
    const bx = Math.floor(x / b), by = Math.floor(z / b), rb = Math.ceil(r / b);
    for (let j = -rb; j <= rb; j++) for (let i = -rb; i <= rb; i++) {
      const arr = this._coverBuckets.get(`${bx + i},${by + j}`); if (!arr) continue;
      for (const c of arr) if (dist(c.x, c.z, x, z) <= r) out.push(c);
    }
    return out;
  }

  /**
   * 找一个能挡住来自 (tx,tz) 火力的掩体：掩体法线背离威胁 + 威胁点到掩体无视线
   */
  bestCover(x, z, tx, tz, maxDist = 12) {
    let best = null, bestS = -Infinity;
    const dxT = tx - x, dzT = tz - z; const dT = Math.hypot(dxT, dzT) || 1;
    for (const c of this.coversNear(x, z, maxDist)) {
      const d = dist(c.x, c.z, x, z); if (d < 0.8) continue;
      const toThreat = ((tx - c.x) * c.nx + (tz - c.z) * c.nz); // >0 表示掩体面朝威胁（差）
      if (toThreat > 0) continue;
      if (this.nav.lineOfSight(tx, tz, c.x, c.z, 0)) continue;  // 被威胁直接看到，不算掩体
      // 评分：近、暴露低、尽量在威胁方向的侧后方而不是正后方（避免直线后撤被打）
      const side = Math.abs(((-dzT) * (c.x - x) + dxT * (c.z - z)) / dT) / Math.max(1, d);
      const s = -d * 0.12 + (1 - c.exposure) * 1.5 + side * 0.6;
      if (s > bestS) { bestS = s; best = c; }
    }
    return best;
  }

  // ---------- 出入口 ----------
  /** 目标区域周边可行走的方向簇（用来表示"敌人可能从哪来"） */
  entrances(cx, cz, radius, maxCount = 5) {
    const pts = []; const N = 24;
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2; const x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
      if (this.nav.isFree(x, z, 1)) pts.push({ x, z, a });
    }
    // 合并相邻角度
    const clusters = [];
    for (const p of pts) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(((p.a - last.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.5) { last.n++; last.x = (last.x * (last.n - 1) + p.x) / last.n; last.z = (last.z * (last.n - 1) + p.z) / last.n; }
      else clusters.push({ x: p.x, z: p.z, a: p.a, n: 1 });
    }
    if (clusters.length > 1 && Math.abs(clusters[0].a - clusters[clusters.length - 1].a + Math.PI * 2) < 0.5) { const f = clusters.shift(); const l = clusters[clusters.length - 1]; l.x = (l.x + f.x) / 2; l.z = (l.z + f.z) / 2; }
    // 按簇大小排序，取前 maxCount
    clusters.sort((a, b) => b.n - a.n);
    return clusters.slice(0, maxCount).map((c) => ({ x: c.x, z: c.z, weight: c.n / N }));
  }

  // ---------- 路线（Lane） ----------
  /**
   * 求从 from 到 to 的 k 条"拓扑上不同"的路线：
   *   1) 直达路线；
   *   2) 经由目标区域不同出入口进入的路线（不同方向 = 天然不同的通道，侧翼/绕后就来自这里）；
   *   3) 不够 k 条时，用"惩罚已用格子"的 A* 补足。
   * 返回的每条路线都已重采样为 ~1.5m 间距的折线，便于评分、取集结点、做重叠度比较。
   */
  findLanes(from, to, k = 3, team = 'A', { radius = 8, marginCells = 1 } = {}) {
    const key = `${from[0].toFixed(1)},${from[1].toFixed(1)}|${to[0].toFixed(1)},${to[1].toFixed(1)}|${k}|${team}|${radius}`;
    if (this.laneCache.has(key)) return this.laneCache.get(key);
    const nav = this.nav; const dangerCost = this.inf.dangerCost(team, 0.8);
    const costFn = (i) => dangerCost(i);
    const cands = [];
    const direct = nav.findPath(from[0], from[1], to[0], to[1], { marginCells, costFn });
    if (direct) cands.push(resample(direct, 1.5));
    const entr = this.entrances(to[0], to[1], radius + 2, 6);
    // 去出入口的路上禁止穿越目标区域本身（否则"经南侧入口"会变成直穿据点）
    const [tcx, tcy] = nav.worldToCell(to[0], to[1]); const rc = Math.ceil((radius + 0.5) / nav.cell);
    const costVia = (i) => { const cx = i % nav.cols, cy = (i - cx) / nav.cols; return Math.hypot(cx - tcx, cy - tcy) < rc ? 80 : dangerCost(i); };
    for (const e of entr) {
      const p1 = nav.findPath(from[0], from[1], e.x, e.z, { marginCells, costFn: costVia }); if (!p1) continue;
      const p2 = nav.findPath(e.x, e.z, to[0], to[1], { marginCells, costFn }); if (!p2) continue;
      cands.push(resample(p1.concat(p2.slice(1)), 1.5));
    }
    cands.sort((a, b) => NavGrid_length(a) - NavGrid_length(b));
    const lanes = [];
    for (const c of cands) { if (lanes.length >= k) break; if (lanes.every((l) => this.laneOverlap(l, c) < 0.5)) lanes.push(c); }
    // 补足：带惩罚的 A*
    if (lanes.length < k) {
      const used = new Float32Array(nav.cols * nav.rows);
      const mark = (pts) => { for (let s = 0; s < pts.length - 1; s++) { const [ax, az] = pts[s], [bx, bz] = pts[s + 1]; const L = Math.hypot(bx - ax, bz - az); const steps = Math.max(1, Math.ceil(L / nav.cell)); for (let t = 0; t <= steps; t++) { const [cx, cy] = nav.worldToCell(ax + (bx - ax) * t / steps, az + (bz - az) * t / steps); for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const nx = cx + dx, ny = cy + dy; if (nav.inBounds(nx, ny)) used[ny * nav.cols + nx] += 1; } } } };
      for (const l of lanes) mark(l);
      while (lanes.length < k) {
        let pts = null, pen = 2;
        for (let attempt = 0; attempt < 3; attempt++) {
          pts = nav.findPath(from[0], from[1], to[0], to[1], { marginCells, costFn: (i) => used[i] * pen + dangerCost(i), smooth: false }); if (!pts) break; pts = resample(pts, 1.5);
          if (lanes.every((l) => this.laneOverlap(l, pts) < 0.5)) break; pen *= 3;
        }
        if (!pts) break; lanes.push(pts); mark(pts);
      }
    }
    this.laneCache.set(key, lanes);
    return lanes;
  }

  laneOverlap(a, b) { return Math.max(overlapOneWay(a, b), overlapOneWay(b, a)); }

  /**
   * 路线评分：安全(低危险) + 快(短) + 隐蔽(少被防守方看到) + 独立(与主路线重叠小)
   */
  scoreLane(pts, team, defPositions, w = { safe: 1.0, fast: 0.5, stealth: 0.8 }) {
    const nav = this.nav;
    let danger = 0, exposure = 0, n = 0;
    for (let i = 0; i < pts.length - 1; i += 1) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1]; const L = Math.hypot(bx - ax, bz - az); const steps = Math.max(1, Math.ceil(L / 2));
      for (let t = 0; t < steps; t++) {
        const x = ax + (bx - ax) * (t / steps), z = az + (bz - az) * (t / steps);
        danger += this.inf.danger(team, x, z); exposure += 1 - Math.min(1, this.exposureAt(x, z)); n++;
      }
    }
    danger /= Math.max(1, n); exposure /= Math.max(1, n);
    let covered = 0, m = 0;
    if (defPositions && defPositions.length) {
      for (let i = 0; i < pts.length; i += 2) { m++; const p = pts[i]; if (defPositions.some((d) => nav.lineOfSight(d.x, d.z, p[0], p[1], 0))) covered++; }
    }
    const len = NavGrid_length(pts);
    return { len, danger, exposure, coverage: m ? covered / m : 0, score: 0, __w: w };
  }
  exposureAt(x, z) { const [cx, cy] = this.nav.worldToCell(x, z); return Math.min(1, this.nav.clear[cy * this.nav.cols + cx] / 4); }

  // ---------- 防守站位 ----------
  /**
   * 为目标区域生成一组互补的防守站位：覆盖出入口、自身有掩体、彼此不重叠、有撤离路线
   */
  defensePositions(cx, cz, radius, entr, count = 6, team = 'B') {
    const key = `${cx.toFixed(1)},${cz.toFixed(1)}|${radius}|${team}|${entr.length}`;
    // Return a COPY: callers sort/splice the result (SquadDirector._planDefense did exactly
    // that and permanently consumed one anchor per plan — the cache drained over time).
    const cached = this.defCache.get(key);
    if (cached) return cached.map((p) => ({ ...p, covers: p.covers ? p.covers.slice() : [] }));
    const nav = this.nav;
    const cands = this.coversNear(cx, cz, radius + 9).filter((c) => dist(c.x, c.z, cx, cz) >= radius * 0.55 && dist(c.x, c.z, cx, cz) <= radius + 9);
    const scored = [];
    for (const c of cands) {
      // 覆盖：能看到几个出入口（加权）
      let cov = 0; for (const e of entr) if (nav.lineOfSight(c.x, c.z, e.x, e.z, 0)) cov += e.weight;
      // 逃离路线数
      let esc = 0; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; if (nav.lineOfSight(c.x, c.z, c.x + Math.cos(a) * 3, c.z + Math.sin(a) * 3, 1)) esc++; }
      // 站位本身不要太贴目标中心（防止被一锅端）
      const depth = Math.min(1, dist(c.x, c.z, cx, cz) / (radius + 4));
      const s = cov * 2 + (1 - c.exposure) * 1.2 + esc * 0.08 + depth * 0.5;
      scored.push({ x: c.x, z: c.z, nx: c.nx, nz: c.nz, coverage: cov, exposure: c.exposure, escapes: esc, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const s of scored) {
      if (picked.length >= count) break;
      if (picked.every((p) => dist(p.x, p.z, s.x, s.z) >= 3.5)) picked.push(s);
    }
    // 候选不足时补一些区域内随机可行走点
    if (picked.length < count) {
      for (let k = 0; k < 16 && picked.length < count; k++) {
        const a = Math.random() * Math.PI * 2, r = radius * (0.6 + Math.random() * 0.5);
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (nav.isFree(x, z, 1) && picked.every((p) => dist(p.x, p.z, x, z) >= 3.5)) picked.push({ x, z, nx: 0, nz: 0, coverage: 0, exposure: 1, escapes: 0, score: 0 });
      }
    }
    this.defCache.set(key, picked);
    return picked.map((p) => ({ ...p, covers: p.covers ? p.covers.slice() : [] }));
  }

  clearCache() { this.laneCache.clear(); this.defCache.clear(); }
}

function NavGrid_length(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
/** 单向重叠度：采样 a 的点到 b 折线的最小距离，<4m 视为重叠 */
function overlapOneWay(a, b) {
  let hit = 0, n = 0;
  for (let i = 0; i < a.length; i += 2) {
    n++; const p = a[i]; let dmin = Infinity;
    for (let j = 0; j < b.length - 1; j++) dmin = Math.min(dmin, pointSegDist(p[0], p[1], b[j], b[j + 1]));
    if (dmin < 4) hit++;
  }
  return n ? hit / n : 0;
}
/** 把折线重采样为固定间距（米）的点列 */
export function resample(pts, step = 1.5) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0].slice()]; let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1], [bx, bz] = pts[i]; const L = Math.hypot(bx - ax, bz - az); if (L < 1e-6) continue;
    let d = step - carry;
    while (d <= L) { const t = d / L; out.push([ax + (bx - ax) * t, az + (bz - az) * t]); d += step; }
    carry = L - (d - step);
  }
  const last = pts[pts.length - 1]; const tail = out[out.length - 1]; if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 0.3) out.push(last.slice());
  return out;
}
function pointSegDist(px, pz, a, b) {
  const vx = b[0] - a[0], vz = b[1] - a[1]; const L2 = vx * vx + vz * vz;
  let t = L2 ? ((px - a[0]) * vx + (pz - a[1]) * vz) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + vx * t), pz - (a[1] + vz * t));
}
