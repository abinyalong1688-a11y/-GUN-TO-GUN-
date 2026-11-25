// interp.js — pure math: snapshot ring buffer, two-snapshot interpolation, clock sync (no three.js).
import { INTERP_DELAY, EXTRAP_MAX, SNAP_JUMP } from './netProtocol.js';

export class SnapshotBuffer {
  constructor(cap = 32) {
    this.cap = cap; this.buf = new Array(cap); this.n = 0; this.head = 0;
    this.dynamicDelay = null;   // optional {human,bot} overrides driven by measured RTT/jitter
  }
  clear() { this.n = 0; this.head = 0; }
  push(t, s) {
    // Out-of-order / duplicate frames are discarded (server timestamps are monotonic per sender)
    const last = this.n ? this.buf[(this.head - 1 + this.cap) % this.cap] : null;
    if (last && t <= last.t) return;
    this.buf[this.head] = { t, ...s };
    this.head = (this.head + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }
  at(i) { return this.buf[(this.head - this.n + i + this.cap) % this.cap]; }
  /* renderTime: local seconds already offset to the server clock. */
  sample(renderTime, kind = 'human') {
    if (!this.n) return null;
    const delay = (this.dynamicDelay && this.dynamicDelay[kind]) ?? INTERP_DELAY[kind] ?? INTERP_DELAY.human;
    const rt = renderTime - delay;
    const first = this.at(0), last = this.at(this.n - 1);
    if (rt <= first.t) return { ...first, extrapolated: false };
    if (rt >= last.t) {
      const ahead = rt - last.t;
      if (ahead > EXTRAP_MAX) return { ...last, extrapolated: false, frozen: true };
      // Short linear extrapolation from the last two samples
      const prev = this.n > 1 ? this.at(this.n - 2) : last;
      const dt = Math.max(1e-3, last.t - prev.t);
      const k = Math.min(ahead, EXTRAP_MAX) / dt;
      const jumped = Math.hypot(last.x - prev.x, last.z - prev.z) > SNAP_JUMP;
      if (jumped) return { ...last, extrapolated: false };
      return {
        ...last, extrapolated: true,
        x: last.x + (last.x - prev.x) * k,
        y: last.y + (last.y - prev.y) * k,
        z: last.z + (last.z - prev.z) * k,
      };
    }
    // Find the segment containing rt, then blend the two samples
    let a = first, b = last;
    for (let i = 0; i < this.n - 1; i++) {
      const p = this.at(i), q = this.at(i + 1);
      if (p.t <= rt && rt <= q.t) { a = p; b = q; break; }
    }
    const span = Math.max(1e-4, b.t - a.t);
    const f = clamp01((rt - a.t) / span);
    // Teleport / respawn: a big move in a short window snaps to the newer sample
    if (Math.hypot(b.x - a.x, b.z - a.z) > SNAP_JUMP && span < 0.2)
      return { ...b, extrapolated: false };
    return {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      z: a.z + (b.z - a.z) * f,
      yaw: lerpAngle(a.yaw, b.yaw, f),
      pitch: a.pitch + (b.pitch - a.pitch) * f,
      hp: f < 0.5 ? a.hp : b.hp,
      alive: f < 0.5 ? a.alive : b.alive,
      crouch: f < 0.5 ? a.crouch : b.crouch,
      extrapolated: false,
    };
  }
}

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

export function lerpAngle(a, b, f) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}

/* offset = serverTime - localTime; EWMA(0.9) for the offset, separate smoothing for RTT/jitter.
   serverT is epoch seconds from the Worker; nowMs / sentT are local performance/Date milliseconds. */
export class TimeSync {
  constructor() { this.offset = 0; this.rtt = 0; this.jitter = 0; this.ready = false; }
  onPong(sentT, serverT, nowMs) {
    const rtt = Math.max(0, (nowMs - sentT) / 1000);
    const off = serverT + rtt / 2 - nowMs / 1000;
    if (!this.ready) { this.offset = off; this.rtt = rtt; this.ready = true; return; }
    const d = Math.abs(off - this.offset);
    this.jitter = this.jitter * 0.9 + d * 0.1;
    this.rtt = this.rtt * 0.8 + rtt * 0.2;
    this.offset = this.offset * 0.9 + off * 0.1;
  }
  serverNow(nowMs) { return nowMs / 1000 + this.offset; }
}
