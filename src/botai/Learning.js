// 自我强化层：局内博弈学习（Thompson 老虎机）、对手路线模型、交战调参器、动态难度、跨局持久化、离线 CEM
import { mulberry32, clamp } from './util.js';

// ---------- 1. Thompson Sampling 老虎机：在几种战术之间自动分配试验比例 ----------
export class ThompsonBandit {
  constructor(arms, { decay = 0.97, seed = 7 } = {}) {
    this.arms = arms.slice(); this.decay = decay; this.rng = mulberry32(seed);
    this.a = {}; this.b = {}; this.uses = {}; this.wins = {};
    for (const k of arms) { this.a[k] = 1; this.b[k] = 1; this.uses[k] = 0; this.wins[k] = 0; }
  }
  _gamma(shape) { // Marsaglia & Tsang
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d); let x, v;
    for (;;) { do { x = this.rng(); v = 1 + c * (2 * this.rng() - 1); } while (v <= 0 || Math.log(v) * v >= x * x * v * Math.log(this.rng()) / 2 + Math.log(this.rng()) - 0.5 * v * v + d - d * Math.log(v)); x = d * Math.pow(v, 3); if (x > 0) return x; }
  }
  sample(k) { return this._gamma(this.a[k]) / (this._gamma(this.a[k]) + this._gamma(this.b[k])); }
  /** 选择：α=1 的乐观初始 + 探索率 eps（避免过早锁死） */
  select(eps = 0.08) {
    if (this.rng() < eps) return this.arms[Math.floor(this.rng() * this.arms.length)];
    let best = this.arms[0], bs = -1;
    for (const k of this.arms) { const s = this.sample(k); if (s > bs) { bs = s; best = k; } }
    return best;
  }
  update(arm, reward) {
    if (!(arm in this.a)) return;
    // 非平稳环境：先衰减历史，再注入本轮
    for (const k of this.arms) { this.a[k] = 1 + (this.a[k] - 1) * this.decay; this.b[k] = 1 + (this.b[k] - 1) * this.decay; }
    this.a[arm] += Math.max(0, reward); this.b[arm] += Math.max(0, 1 - reward);
    this.uses[arm]++; if (reward >= 0.6) this.wins[arm]++;
  }
  stats() { const o = {}; for (const k of this.arms) o[k] = { mean: this.a[k] / (this.a[k] + this.b[k]), uses: this.uses[k], wins: this.wins[k] }; return o; }
  toJSON() { return { arms: this.arms, a: this.a, b: this.b, uses: this.uses, wins: this.wins }; }
  static fromJSON(j, opts) { if (!j || !j.arms) return null; const t = new ThompsonBandit(j.arms, opts); Object.assign(t.a, j.a || {}); Object.assign(t.b, j.b || {}); Object.assign(t.uses, j.uses || {}); Object.assign(t.wins, j.wins || {}); return t; }
}

// ---------- 2. 对手路线模型：敌人（尤其是真人）喜欢出现在哪 ----------
export class OpponentRouteModel {
  constructor(size = 112, bins = 8) { this.size = size; this.bins = bins; this.mass = new Float32Array(bins * bins); this.total = 0; this.lastSeen = new Map(); }
  _bin(x, z) {
    const bx = clamp(Math.floor((x / this.size + 0.5) * this.bins), 0, this.bins - 1);
    const bz = clamp(Math.floor((z / this.size + 0.5) * this.bins), 0, this.bins - 1);
    return bz * this.bins + bx;
  }
  /** 每次发现/击中/开火都投一票；同一敌人 2s 内只记一次 */
  observe(key, x, z, time, weight = 1) {
    const t = this.lastSeen.get(key) || -99; if (time - t < 2) return; this.lastSeen.set(key, time);
    this.mass[this._bin(x, z)] += weight; this.total += weight;
  }
  /** 以 (x,z) 为中心、半径 r 范围内出现概率（归一化到 0..1） */
  probNear(x, z, r = 12) {
    if (this.total <= 0) return 0;
    const b = this.size / this.bins; let s = 0;
    const bx0 = clamp(Math.floor((x - r) / b + this.bins / 2), 0, this.bins - 1), bx1 = clamp(Math.floor((x + r) / b + this.bins / 2), 0, this.bins - 1);
    const bz0 = clamp(Math.floor((z - r) / b + this.bins / 2), 0, this.bins - 1), bz1 = clamp(Math.floor((z + r) / b + this.bins / 2), 0, this.bins - 1);
    for (let j = bz0; j <= bz1; j++) for (let i = bx0; i <= bx1; i++) s += this.mass[j * this.bins + i];
    return s / this.total;
  }
  decay(k) { for (let i = 0; i < this.mass.length; i++) this.mass[i] *= k; this.total = this.mass.reduce((a, b) => a + b, 0); }
  toJSON() { return { bins: this.bins, mass: Array.from(this.mass), total: this.total }; }
  static fromJSON(j) { if (!j) return null; const m = new OpponentRouteModel(112, j.bins || 8); m.mass.set(j.mass || []); m.total = j.total || 0; return m; }
}

// ---------- 3. 交战调参器：命中率反馈 → 调整偏好交战距离 / 进攻性 ----------
export class CombatTuner {
  constructor() { this.bots = new Map(); }
  _b(id) { let b = this.bots.get(id); if (!b) { b = { shots: 0, hits: 0, hitEMA: 0.35, rangeMul: 1, aggrMul: 1, decisions: 0 }; this.bots.set(id, b); } return b; }
  /** expected：按当前参数/距离算出的理论命中率（由战斗层提供，缺省 0.3） */
  onShot(botId, hit, expected = 0.3) {
    const b = this._b(botId); b.shots++; if (hit) b.hits++;
    b.hitEMA += ((hit ? 1 : 0) - b.hitEMA) * 0.08;
    if (b.shots % 24 === 0 && b.shots > 0) {
      const ratio = b.hitEMA / Math.max(0.05, expected);
      if (ratio < 0.8) { b.rangeMul = clamp(b.rangeMul * 0.92, 0.7, 1.3); b.aggrMul = clamp(b.aggrMul * 0.95, 0.7, 1.3); }
      else if (ratio > 1.2) { b.rangeMul = clamp(b.rangeMul * 1.05, 0.7, 1.3); b.aggrMul = clamp(b.aggrMul * 1.04, 0.7, 1.3); }
      b.decisions++;
    }
  }
  rangeMul(botId) { return (this.bots.get(botId) || { rangeMul: 1 }).rangeMul; }
  aggrMul(botId) { return (this.bots.get(botId) || { aggrMul: 1 }).aggrMul; }
}

// ---------- 4. 动态难度：让真人胜率向目标靠拢（有界、慢变，避免"作弊感"） ----------
export class DifficultyController {
  constructor({ target = 0.5, lo = 0.8, hi = 1.25, step = 0.03, every = 3, humanTeam = 'A' } = {}) {
    Object.assign(this, { target, lo, hi, step, every, humanTeam }); this.winEMA = target; this.rounds = 0; this.skill = 1; this.lastRounds = [];
  }
  onRound(winner) {
    this.rounds++; const win = winner === this.humanTeam ? 1 : 0; this.lastRounds.push(win); if (this.lastRounds.length > 10) this.lastRounds.shift();
    this.winEMA += (win - this.winEMA) * 0.25;
    // The human wins more than the target → the bots get stronger (skill up); the human keeps
    // losing → they ease off (skill down). (The original sign was inverted: it punished a
    // struggling player with faster bots and went easy on whoever was winning.)
    if (this.rounds % this.every === 0) this.skill = clamp(this.skill + this.step * (this.winEMA - this.target) * 2, this.lo, this.hi);
  }
  /** 把 skill 映射为战斗参数缩放：skill>1 = 更强 */
  apply(params) {
    const s = this.skill;
    if (!params) return params;
    if (params.reaction != null) params.reaction = params.reaction / s;
    if (params.pause != null) params.pause = params.pause / s;
    if (params.aimTime != null) params.aimTime = params.aimTime / s;
    if (params.missK != null) params.missK = params.missK / s;
    if (params.senseInterval != null) params.senseInterval = Math.max(0.04, params.senseInterval / s);
    return params;
  }
  toJSON() { return { winEMA: this.winEMA, rounds: this.rounds, skill: this.skill, lastRounds: this.lastRounds }; }
  static fromJSON(j, opts) { const d = new DifficultyController(opts); if (j) { d.winEMA = j.winEMA ?? d.winEMA; d.rounds = j.rounds || 0; d.skill = j.skill || 1; d.lastRounds = j.lastRounds || []; } return d; }
}

// ---------- 5. 持久化：跨局记忆（localStorage 可用时落盘，否则仅内存） ----------
export class LearningStore {
  constructor(key = 'gtg_botai_v1') { this.key = key; this.data = { v: 1, bands: {}, opp: {}, diff: null, tuner: {} }; this.available = typeof localStorage !== 'undefined'; this.load(); }
  load() { if (!this.available) return; try { const j = JSON.parse(localStorage.getItem(this.key) || 'null'); if (j && j.v === 1) this.data = j; } catch {} }
  save() { if (!this.available) return; try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch {} }
  clear() { this.data = { v: 1, bands: {}, opp: {}, diff: null, tuner: {} }; this.save(); }
}

// ---------- 6. 离线交叉熵（CEM）：用无头沙盘批量跑局，调一组连续参数 ----------
export class CEM {
  constructor(mean, { pop = 16, elite = 4, sigma = 0.3, seed = 3 } = {}) {
    this.mean = mean.slice(); this.sigma = new Array(mean.length).fill(sigma); this.pop = pop; this.elite = elite; this.rng = mulberry32(seed); this.gen = 0;
  }
  ask() {
    const out = [];
    for (let p = 0; p < this.pop; p++) { const v = this.mean.map((m, i) => m + gaussOf(this.rng) * this.sigma[i]); out.push(v); }
    return out;
  }
  tell(scores, samples) {
    const idx = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, this.elite).map((x) => x[1]);
    for (let i = 0; i < this.mean.length; i++) {
      let m = 0; for (const j of idx) m += samples[j][i]; m /= idx.length;
      let v = 0; for (const j of idx) v += (samples[j][i] - m) ** 2; v = Math.sqrt(v / idx.length);
      this.mean[i] = m; this.sigma[i] = Math.max(0.05, v * 0.9 + 0.1 * this.sigma[i]);
    }
    this.gen++;
  }
}
function gaussOf(rng) { let u = 0, v = 0; while (!u) u = rng(); while (!v) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ---------- 门面：把以上组件按 "地图 × 模式 × 阶段" 组织起来 ----------
export class Learning {
  constructor({ store = null, humanTeam = 'A', seed = 11 } = {}) {
    this.store = store || new LearningStore();
    this.humanTeam = humanTeam; this.rng = mulberry32(seed);
    this.bands = {}; this.opp = {}; this.tuner = new CombatTuner();
    this.diff = DifficultyController.fromJSON(this.store.data.diff, { humanTeam });
    this.mapKey = 'default'; this.mode = 'dm';
    for (const [k, j] of Object.entries(this.store.data.bands || {})) this.bands[k] = ThompsonBandit.fromJSON(j, { seed });
    for (const [k, j] of Object.entries(this.store.data.opp || {})) this.opp[k] = OpponentRouteModel.fromJSON(j);
    this.roundArm = {};   // 本局各队使用的战术臂，结算时回填
  }
  setContext(mapKey, mode) { this.mapKey = mapKey; this.mode = mode; }
  bandit(team, phase, arms) { const k = `${this.mapKey}|${this.mode}|${team}|${phase}`; if (!this.bands[k]) this.bands[k] = new ThompsonBandit(arms, { seed: (this.rng() * 1e9) | 0 }); return this.bands[k]; }
  /** 选战术：返回 {arm, bandit}；把选中的臂记到 roundArm 以便局末结算 */
  chooseStrategy(team, phase, arms, eps) { const b = this.bandit(team, phase, arms); const arm = b.select(eps); this.roundArm[`${team}:${phase}`] = { arm, bandit: b }; return arm; }
  opponentModel(enemyTeam) { const k = `${this.mapKey}|${enemyTeam}`; if (!this.opp[k]) this.opp[k] = new OpponentRouteModel(); return this.opp[k]; }
  observeEnemy(enemyTeam, key, x, z, time, weight) { this.opponentModel(enemyTeam).observe(key, x, z, time, weight); }
  enemyProbNear(enemyTeam, x, z, r) { return this.opponentModel(enemyTeam).probNear(x, z, r); }
  endRound(winner, { killsA = 0, killsB = 0 } = {}) {
    for (const [k, { arm, bandit }] of Object.entries(this.roundArm)) {
      const team = k[0];
      const win = winner === team ? 1 : 0;
      const kd = clamp(((team === 'A' ? killsA - killsB : killsB - killsA) + 6) / 12, 0, 1); // 击杀差归一化到 0..1
      bandit.update(arm, 0.7 * win + 0.3 * kd);
    }
    this.roundArm = {};
    this.diff.onRound(winner);
    for (const [k, m] of Object.entries(this.opp)) m.decay(0.9); // 老信息慢慢淡忘
    this.persist();
  }
  persist() {
    this.store.data.bands = {}; for (const [k, b] of Object.entries(this.bands)) this.store.data.bands[k] = b.toJSON();
    this.store.data.opp = {}; for (const [k, m] of Object.entries(this.opp)) this.store.data.opp[k] = m.toJSON();
    this.store.data.diff = this.diff.toJSON();
    this.store.save();
  }
  /** 调试面板用 */
  report() {
    const out = { difficulty: { skill: +this.diff.skill.toFixed(3), humanWinEMA: +this.diff.winEMA.toFixed(2), rounds: this.diff.rounds }, bandits: {} };
    for (const [k, b] of Object.entries(this.bands)) out.bandits[k] = b.stats();
    const tuners = {}; for (const [id, b] of this.tuner.bots) tuners[id] = { shots: b.shots, hitEMA: +b.hitEMA.toFixed(2), rangeMul: +b.rangeMul.toFixed(2) };
    out.tuners = tuners; return out;
  }
}
