// 全局导航栅格：把 AABB 碰撞盒烘焙成可行走栅格 + 清晰度(clearance)，提供 A*、视线、平滑
// 适配 GUN TO GUN：地图是半径 52 的圆形竞技场，碰撞体为 {minX,maxX,minZ,maxZ,top}
import { MinHeap, clamp } from './util.js';

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.41421356], [1, -1, 1.41421356], [-1, 1, 1.41421356], [-1, -1, 1.41421356],
];

export class NavGrid {
  /**
   * @param {number} size   世界边长（米），需覆盖整个竞技场
   * @param {number} cell   栅格边长（米）
   * @param {number} radius Bot 半径（米），用于膨胀碰撞盒
   */
  constructor(size = 112, cell = 0.5, radius = 0.45, circleBound = 52) {
    this.size = size; this.cell = cell; this.radius = radius; this.bound = circleBound;
    this.cols = Math.round(size / cell); this.rows = this.cols;
    this.ox = -size / 2; this.oz = -size / 2;
    const n = this.cols * this.rows;
    this.blocked = new Uint8Array(n);      // 1 = 不可走
    this.clear = new Float32Array(n);      // 距最近障碍的距离（格）
    this.g = new Float32Array(n); this.f = new Float32Array(n);
    this.parent = new Int32Array(n); this.stamp = new Uint32Array(n); this.closedStamp = new Uint32Array(n);
    this._stamp = 0; this.heap = new MinHeap(n * 4 + 16);
    this.lastStats = { iter: 0, expanded: 0 };
  }

  idx(cx, cy) { return cy * this.cols + cx; }
  inBounds(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows; }
  worldToCell(x, z) {
    return [clamp(Math.floor((x - this.ox) / this.cell), 0, this.cols - 1), clamp(Math.floor((z - this.oz) / this.cell), 0, this.rows - 1)];
  }
  cellToWorld(cx, cy) { return [this.ox + (cx + 0.5) * this.cell, this.oz + (cy + 0.5) * this.cell]; }

  /** 用 AABB 列表烘焙栅格。colliders: [{minX,maxX,minZ,maxZ,top}] */
  rasterize(colliders) {
    const { cols, rows, cell, ox, oz, blocked } = this;
    blocked.fill(0);
    const r = this.radius;
    const limit2 = (this.bound - r) * (this.bound - r);
    for (let cy = 0; cy < rows; cy++) {
      const z = oz + (cy + 0.5) * cell;
      for (let cx = 0; cx < cols; cx++) {
        const x = ox + (cx + 0.5) * cell;
        if (x * x + z * z > limit2) { blocked[cy * cols + cx] = 1; continue; }
        for (let k = 0; k < colliders.length; k++) {
          const c = colliders[k];
          if (c.top !== undefined && c.top < 0.25) continue; // 过矮的贴地物不挡路
          const nx = clamp(x, c.minX, c.maxX), nz = clamp(z, c.minZ, c.maxZ);
          const dx = x - nx, dz = z - nz;
          if (dx * dx + dz * dz < r * r) { blocked[cy * cols + cx] = 1; break; }
        }
      }
    }
    this.computeClearance();
  }

  /** 两遍 chamfer 距离变换：每个格到最近障碍的格距 */
  computeClearance(maxCells = 6) {
    const { cols, rows, blocked, clear } = this;
    const INF = 1e6;
    for (let i = 0; i < clear.length; i++) clear[i] = blocked[i] ? 0 : INF;
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      const i = cy * cols + cx; if (clear[i] === 0) continue;
      let b = clear[i];
      if (cx > 0) b = Math.min(b, clear[i - 1] + 1);
      if (cy > 0) b = Math.min(b, clear[i - cols] + 1);
      if (cx > 0 && cy > 0) b = Math.min(b, clear[i - cols - 1] + 1.4142);
      if (cx < cols - 1 && cy > 0) b = Math.min(b, clear[i - cols + 1] + 1.4142);
      clear[i] = b;
    }
    for (let cy = rows - 1; cy >= 0; cy--) for (let cx = cols - 1; cx >= 0; cx--) {
      const i = cy * cols + cx; let b = clear[i];
      if (cx < cols - 1) b = Math.min(b, clear[i + 1] + 1);
      if (cy < rows - 1) b = Math.min(b, clear[i + cols] + 1);
      if (cx < cols - 1 && cy < rows - 1) b = Math.min(b, clear[i + cols + 1] + 1.4142);
      if (cx > 0 && cy < rows - 1) b = Math.min(b, clear[i + cols - 1] + 1.4142);
      clear[i] = b;
    }
    for (let i = 0; i < clear.length; i++) clear[i] = Math.min(clear[i], maxCells);
  }

  /** marginCells：额外要求的空隙（格），0 表示刚好能过 */
  walkable(cx, cy, marginCells = 0) {
    if (!this.inBounds(cx, cy)) return false;
    const i = cy * this.cols + cx;
    return !this.blocked[i] && this.clear[i] >= marginCells;
  }
  isFree(x, z, marginCells = 0) { const [cx, cy] = this.worldToCell(x, z); return this.walkable(cx, cy, marginCells); }

  /** 视线检测（半格步进采样，足够稳定，且与游戏内 _segFree 语义一致） */
  lineOfSight(x0, z0, x1, z1, marginCells = 0) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(d / (this.cell * 0.5)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const [cx, cy] = this.worldToCell(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      if (!this.walkable(cx, cy, marginCells)) return false;
    }
    return true;
  }

  /** 最近可行走格（环形扩张搜索） */
  nearestFree(cx, cy, marginCells = 0, maxR = 24) {
    if (this.walkable(cx, cy, marginCells)) return [cx, cy];
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (this.walkable(cx + dx, cy + dy, marginCells)) return [cx + dx, cy + dy];
      }
    }
    return null;
  }

  /**
   * A* 寻路。costFn(cellIndex) 返回额外代价（0 = 无），可用来表达危险区/拥挤/已被友军走过的路线
   * @returns {Array<[x,z]>|null} 世界坐标折线（已做视线平滑）
   */
  findPath(x0, z0, x1, z1, { marginCells = 1, costFn = null, maxIter = 40000, smooth = true } = {}) {
    const { cols } = this;
    let [scx, scy] = this.worldToCell(x0, z0); let [tcx, tcy] = this.worldToCell(x1, z1);
    const s = this.nearestFree(scx, scy, marginCells); const t = this.nearestFree(tcx, tcy, marginCells);
    if (!s || !t) return null;
    [scx, scy] = s; [tcx, tcy] = t;
    const stamp = ++this._stamp; if (this._stamp > 0xfffffff0) { this.stamp.fill(0); this.closedStamp.fill(0); this._stamp = stamp; }
    const { g, f, parent, stamp: st, closedStamp, heap } = this;
    heap.clear();
    const si = scy * cols + scx, ti = tcy * cols + tcx;
    const h = (cx, cy) => { const dx = Math.abs(cx - tcx), dy = Math.abs(cy - tcy); return (dx + dy) - 0.5857864 * Math.min(dx, dy); };
    g[si] = 0; st[si] = stamp; parent[si] = -1; heap.push(si, h(scx, scy));
    let iter = 0, expanded = 0, found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (closedStamp[cur] === stamp) continue;
      closedStamp[cur] = stamp; expanded++;
      if (cur === ti) { found = true; break; }
      if (++iter > maxIter) break;
      const cx = cur % cols, cy = (cur - cx) / cols;
      for (let k = 0; k < 8; k++) {
        const [dx, dy, w] = DIRS[k];
        const nx = cx + dx, ny = cy + dy;
        if (!this.walkable(nx, ny, marginCells)) continue;
        if (dx && dy && (!this.walkable(cx + dx, cy, marginCells) || !this.walkable(cx, cy + dy, marginCells))) continue; // 禁止切角
        const ni = ny * cols + nx;
        if (closedStamp[ni] === stamp) continue;
        const extra = costFn ? costFn(ni) : 0;
        const ng = g[cur] + w * (1 + Math.max(0, extra));
        if (st[ni] !== stamp || ng < g[ni]) { st[ni] = stamp; g[ni] = ng; parent[ni] = cur; heap.push(ni, ng + h(nx, ny)); }
      }
    }
    this.lastStats = { iter, expanded };
    if (!found) return null;
    const cells = []; for (let c = ti; c !== -1 && c !== si; c = parent[c]) cells.push(c); cells.push(si); cells.reverse();
    const pts = cells.map((c) => { const cx = c % cols; return this.cellToWorld(cx, (c - cx) / cols); });
    pts[0] = [x0, z0]; pts[pts.length - 1] = [x1, z1];
    return smooth ? this.smooth(pts, marginCells) : resampleCells(pts);
  }

  /** 拉绳平滑：尽量跳过中间点（要求视线可通且留有余量） */
  smooth(pts, marginCells = 0) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]]; let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      for (; j > i + 1; j--) if (this.lineOfSight(pts[i][0], pts[i][1], pts[j][0], pts[j][1], marginCells)) break;
      out.push(pts[j]); i = j;
    }
    return out;
  }

  static pathLength(pts) { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; }
}

/** 未平滑的格点折线太密，按 ~1.5m 抽稀 */
function resampleCells(pts) {
  const out = [pts[0]]; let acc = 0;
  for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); if (acc >= 1.5 || i === pts.length - 1) { out.push(pts[i]); acc = 0; } }
  return out;
}
