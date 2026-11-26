// 影响图（Influence Map）+ 死亡热图：把"哪里有火力""哪里刚死过人"变成可查询的标量场
// 进攻路线评分、防守位置评分、A* 危险代价都从这里取数
import { clamp } from './util.js';

export class InfluenceMap {
  constructor(nav) {
    this.nav = nav;
    const n = nav.cols * nav.rows;
    this.atk = new Float32Array(n);     // A 队火力覆盖强度
    this.def = new Float32Array(n);     // B 队火力覆盖强度
    this.deathA = new Float32Array(n);  // A 队成员死亡热
    this.deathB = new Float32Array(n);  // B 队成员死亡热
    this.unitRadius = 9;                // 单位火力影响半径（米）
  }

  /**
   * 每个战术 tick 重建一次（增量更新会留下"残影"，重建更简单也更准）
   * @param {Array<{team:string,x:number,z:number,strength?:number,radius?:number}>} units
   */
  rebuild(units, step = 2) {
    this.atk.fill(0); this.def.fill(0);
    for (const u of units) {
      const arr = u.team === 'A' ? this.atk : this.def;
      this._blob(arr, u.x, u.z, u.radius ?? this.unitRadius, u.strength ?? 1, step);
    }
  }

  // 以 (x,z) 为中心，在半径 r 内按视线衰减扩散；step=2 表示每 2 格采样一次，结果写入 2x2 块
  _blob(arr, x, z, r, strength, step) {
    const nav = this.nav, cols = nav.cols, rows = nav.rows;
    const [ccx, ccy] = nav.worldToCell(x, z);
    const rc = Math.ceil(r / nav.cell);
    const x0 = Math.max(0, ccx - rc), x1 = Math.min(cols - 1, ccx + rc);
    const y0 = Math.max(0, ccy - rc), y1 = Math.min(rows - 1, ccy + rc);
    const [wx, wz] = nav.cellToWorld(ccx, ccy);
    for (let cy = y0; cy <= y1; cy += step) for (let cx = x0; cx <= x1; cx += step) {
      const [px, pz] = nav.cellToWorld(cx, cy);
      const d = Math.hypot(px - wx, pz - wz) / nav.cell;
      if (d > rc) continue;
      const w = strength * (1 - d / rc) * (1 - d / rc);
      if (w <= 0.01) continue;
      if (!nav.lineOfSight(wx, wz, px, pz, 0)) continue;
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < cols && ny < rows) arr[ny * cols + nx] += w;
      }
    }
  }

  addDeath(x, z, team, amount = 1) {
    const nav = this.nav; const [cx, cy] = nav.worldToCell(x, z);
    const arr = team === 'A' ? this.deathA : this.deathB;
    // 3x3 扩散，让"附近"也带上一点危险
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy; if (!nav.inBounds(nx, ny)) continue;
      arr[ny * nav.cols + nx] += amount * (dx || dy ? 0.5 : 1);
    }
  }

  /** 死亡热按 τ 秒衰减（默认 45s） */
  update(dt, tau = 45) {
    const k = Math.exp(-dt / tau);
    for (let i = 0; i < this.deathA.length; i++) { this.deathA[i] *= k; this.deathB[i] *= k; }
  }

  _sample(arr, x, z) { const [cx, cy] = this.nav.worldToCell(x, z); return arr[cy * this.nav.cols + cx]; }
  enemyField(team) { return team === 'A' ? this.def : this.atk; }
  ownDeathField(team) { return team === 'A' ? this.deathA : this.deathB; }

  /** 队伍 team 在 (x,z) 的危险度：敌方火力 + 本队近期死亡热 × 权重 */
  danger(team, x, z, deathWeight = 0.6) {
    return this._sample(this.enemyField(team), x, z) + this._sample(this.ownDeathField(team), x, z) * deathWeight;
  }
  dangerAtCell(team, i, deathWeight = 0.6) {
    const enemy = this.enemyField(team), own = this.ownDeathField(team);
    return enemy[i] + own[i] * deathWeight;
  }
  /** A* 代价函数：危险度线性转代价（乘 scale） */
  dangerCost(team, scale = 1.2, deathWeight = 0.6) {
    const enemy = this.enemyField(team), own = this.ownDeathField(team);
    return (i) => (enemy[i] + own[i] * deathWeight) * scale;
  }
  /** 控制度：>0 A 控，<0 B 控 */
  control(x, z) { return this._sample(this.atk, x, z) - this._sample(this.def, x, z); }
  /** 取整张图的采样（调试渲染用） */
  sampleRow(arr, cy, stride = 1) { const out = []; for (let cx = 0; cx < this.nav.cols; cx += stride) out.push(arr[cy * this.nav.cols + cx]); return out; }
  static norm(v, lo = 0, hi = 1) { return clamp((v - lo) / (hi - lo), 0, 1); }
}
