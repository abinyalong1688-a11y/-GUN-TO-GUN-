// 通用数学 / 随机 / 堆工具（无依赖，浏览器与 Node 均可用）
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

export function angNorm(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// 标准正态分布随机数（Box–Muller）
export function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// 可复现的伪随机数（回放 / 离线训练需要确定性）
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MinHeap {
  constructor(cap) { this.ids = new Int32Array(cap); this.keys = new Float32Array(cap); this.n = 0; }
  clear() { this.n = 0; }
  get size() { return this.n; }
  push(id, key) {
    if (this.n >= this.ids.length) { /* 扩容 */ const I = new Int32Array(this.ids.length * 2); I.set(this.ids); this.ids = I; const K = new Float32Array(this.keys.length * 2); K.set(this.keys); this.keys = K; }
    let i = this.n++;
    this.ids[i] = id; this.keys[i] = key;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      const ti = this.ids[p], tk = this.keys[p];
      this.ids[p] = this.ids[i]; this.keys[p] = this.keys[i];
      this.ids[i] = ti; this.keys[i] = tk;
      i = p;
    }
  }
  pop() {
    const top = this.ids[0];
    this.n--;
    if (this.n > 0) {
      this.ids[0] = this.ids[this.n]; this.keys[0] = this.keys[this.n];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < this.n && this.keys[l] < this.keys[m]) m = l;
        if (r < this.n && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        const ti = this.ids[m], tk = this.keys[m];
        this.ids[m] = this.ids[i]; this.keys[m] = this.keys[i];
        this.ids[i] = ti; this.keys[i] = tk;
        i = m;
      }
    }
    return top;
  }
}

// 按权重随机取一个下标
export function pickWeighted(weights, rng) {
  let sum = 0;
  for (const w of weights) sum += Math.max(0, w);
  if (sum <= 0) return 0;
  let r = rng() * sum;
  for (let i = 0; i < weights.length; i++) { r -= Math.max(0, weights[i]); if (r <= 0) return i; }
  return weights.length - 1;
}
