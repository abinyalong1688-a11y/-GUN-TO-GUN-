// botPerception.js — the "senses" layer for the deathmatch bots.
//
// A bot no longer knows where every enemy is. It sees a target only when all of these hold:
//   1. the target is within the difficulty's view range,
//   2. it is inside the view cone — except for close-proximity awareness (footsteps) and a
//      short sticky window while the bot is turning, so a target that was just visible is
//      not lost by a single frame of over-rotation,
//   3. a line-of-sight ray from the bot's eye to the target's chest is clear,
//   4. it is not hidden inside a smoke cloud (unless the bot is close enough to hear it).
// Lost targets remain in memory for `memoryTime` seconds; gunfire and taking damage inject
// approximate ("heard") positions, which is how a bot reacts to being shot from behind.
import * as THREE from 'three';

const STICKY = .35; // seconds a recently-visible target stays exempt from the FOV test

export function forwardFromYaw(yaw, out = {x: 0, z: 0}) {
  out.x = Math.sin(yaw);
  out.z = Math.cos(yaw);
  return out;
}

/* Copy a position-ish value into a Vector3 without allocating when the destination exists. */
export function copyPos(dst, src) {
  if (!src) return dst;
  dst.set(src.x || 0, src.y || 0, src.z || 0);
  return dst;
}

/* Core visibility predicate, exported so tests and tools can reason about one pair directly.
   `observer` is {pos, yaw, team, eyeY?}; `target` is {pos, point?, team, alive?}. */
export function canSee(observer, target, params, losCheck) {
  if (!observer || !target) return false;
  if (target.alive === false) return false;
  if (observer.team != null && target.team != null && observer.team === target.team) return false;
  const ox = observer.pos.x, oz = observer.pos.z;
  const tx = target.pos.x, tz = target.pos.z;
  const dx = tx - ox, dz = tz - oz;
  const dist = Math.hypot(dx, dz);
  if (dist > params.viewRange || dist < 1e-4) return dist <= 1e-4;
  // Close range: the bot hears footsteps/breathing and does not need to face the target.
  if (dist > (params.proximity || 0)) {
    const fx = Math.sin(observer.yaw || 0), fz = Math.cos(observer.yaw || 0);
    const dot = (dx * fx + dz * fz) / dist;
    if (dot < Math.cos((params.fov || params.viewFOV || 2.2) * .5)) return false;
  }
  const eyeY = observer.pos.y + (observer.eyeY != null ? observer.eyeY : 1.4);
  const point = target.point || {x: tx, y: (target.pos.y || 0) + 1.1, z: tz};
  if (!losCheck) return true;
  return !!losCheck({x: ox, y: eyeY, z: oz}, point);
}

/* One bot's memory of every enemy it has recently seen or heard. */
export class BotSensor {
  constructor() {
    this.memory = new Map();
    this._eye = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._noisy = new THREE.Vector3();
    // Optional smoke test installed by the brain: (pos) => boolean (true = obscured).
    this.obscured = null;
  }

  clear() { this.memory.clear(); }

  get(id) { return this.memory.get(id) || null; }

  drop(id) { this.memory.delete(id); }

  size() { return this.memory.size; }

  entries() { return Array.from(this.memory.values()); }

  /* Number of enemies currently in direct sight (for debug / tests). */
  visibleCount(now) {
    let n = 0;
    for (const e of this.memory.values()) if (e.visible && now - e.lastSeen <= STICKY) n++;
    return n;
  }

  /* Create the memory entry on first contact. Position is only refreshed by a live sighting
     or a fresh sound/damage cue — never by an unseen candidate walking past, or memory would
     silently become a wallhack. */
  _entry(candidate) {
    const id = candidate.id;
    let e = this.memory.get(id);
    if (!e) {
      e = {
        id,
        entity: candidate.entity,
        team: candidate.team,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        point: new THREE.Vector3(),
        visible: false,
        lastSeen: -1e9,
        lastHeard: -1e9,
        confidence: 0,
        hp: 1,
        maxHp: 1,
        source: 'none',
      };
      copyPos(e.pos, candidate.pos);
      if (candidate.vel) copyPos(e.vel, candidate.vel);
      const p = candidate.point || this._point.set(candidate.pos.x, (candidate.pos.y || 0) + 1.1, candidate.pos.z);
      copyPos(e.point, p);
      if (candidate.hp != null) e.hp = candidate.hp;
      if (candidate.maxHp != null) e.maxHp = candidate.maxHp;
      this.memory.set(id, e);
    }
    e.entity = candidate.entity;
    e.team = candidate.team;
    return e;
  }

  /**
   * Refresh every candidate. Candidates come from the game roster:
   *   {id, entity, team, pos, vel, hp, maxHp, point?}
   * Returns the live entry list (visible entries already updated this tick).
   */
  sense(bot, candidates, now, losCheck, params) {
    this.prune(now, params);
    for (const cand of candidates) {
      let e = this.memory.get(cand.id);
      const dx = cand.pos.x - bot.pos.x, dz = cand.pos.z - bot.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > params.viewRange) {
        if (e) e.visible = false;
        continue;
      }
      const close = dist <= (params.proximity || 0);
      const sticky = !!e && e.lastSeen >= 0 && now - e.lastSeen <= STICKY;
      let facing = close || sticky;
      if (!facing) {
        const dot = (dx * Math.sin(bot.yaw) + dz * Math.cos(bot.yaw)) / Math.max(dist, 1e-4);
        facing = dot >= Math.cos((params.fov || params.viewFOV || 2.2) * .5);
      }
      if (!facing) {
        // Not in the cone: keep whatever we already remember, but do not allocate a new
        // memory entry for someone the bot never saw.
        if (e) e.visible = false;
        continue;
      }
      if (!e) e = this._entry(cand);
      else e.entity = cand.entity;
      const point = cand.point || this._point.set(cand.pos.x, (cand.pos.y || 0) + 1.1, cand.pos.z);
      this._eye.set(bot.pos.x, bot.pos.y + 1.4, bot.pos.z);
      const smokeBlocked = !close && !!this.obscured && this.obscured(point);
      const visible = !smokeBlocked && (!losCheck || losCheck(this._eye, point));
      if (visible) {
        // Only a real sighting refreshes the remembered position/velocity/health.
        copyPos(e.pos, cand.pos);
        if (cand.vel) copyPos(e.vel, cand.vel);
        else e.vel.set(0, 0, 0);
        copyPos(e.point, point);
        if (cand.hp != null) e.hp = cand.hp;
        if (cand.maxHp != null) e.maxHp = cand.maxHp;
        e.visible = true;
        e.lastSeen = now;
        e.lastHeard = Math.max(e.lastHeard, now); // seeing is stronger than hearing
        e.confidence = 1;
        e.source = 'sight';
      } else {
        e.visible = false;
        if (now - e.lastSeen > params.memoryTime) {
          // Still keep a hearsay entry while it is fresh; prune() removes stale ones next tick.
          if (now - e.lastHeard > params.memoryTime) this.memory.delete(e.id);
        }
      }
    }
    return this.entries();
  }

  /* Gunfire / footsteps: remember an approximate position, never overwriting live sight. */
  hear(id, pos, now, {noise = 2.5, entity = null, team = null} = {}) {
    let e = this.memory.get(id);
    if (!e) {
      if (!entity && !team) return null;
      e = {
        id, entity, team,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), point: new THREE.Vector3(),
        visible: false, lastSeen: -1e9, lastHeard: -1e9, confidence: 0, hp: 1, maxHp: 1, source: 'none',
      };
      this.memory.set(id, e);
    }
    if (e.visible) return e; // eyes beat ears until a sensing tick marks the target hidden
    if (now < e.lastHeard) return e;
    const a = Math.random() * Math.PI * 2;
    const r = noise > 0 ? Math.random() * noise : 0;
    this._noisy.set(pos.x + Math.cos(a) * r, pos.y || 0, pos.z + Math.sin(a) * r);
    copyPos(e.pos, this._noisy);
    e.point.set(e.pos.x, e.pos.y + 1.1, e.pos.z);
    e.lastHeard = now;
    e.visible = false;
    e.confidence = .35;
    e.source = 'sound';
    return e;
  }

  /* Taking damage is a much better lead than a gunshot: near-exact direction, low noise. */
  alert(id, pos, now, {noise = .8, entity = null, team = null} = {}) {
    let e = this.memory.get(id);
    if (!e) {
      if (!entity && !team) return null;
      e = {
        id, entity, team,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(), point: new THREE.Vector3(),
        visible: false, lastSeen: -1e9, lastHeard: -1e9, confidence: 0, hp: 1, maxHp: 1, source: 'none',
      };
      this.memory.set(id, e);
    }
    if (e.visible) return e;
    const a = Math.random() * Math.PI * 2;
    const r = noise > 0 ? Math.random() * noise : 0;
    this._noisy.set(pos.x + Math.cos(a) * r, pos.y || 0, pos.z + Math.sin(a) * r);
    copyPos(e.pos, this._noisy);
    e.point.set(e.pos.x, e.pos.y + 1.1, e.pos.z);
    e.lastHeard = now;
    e.visible = false;
    e.confidence = .8;
    e.source = 'damage';
    return e;
  }

  /* Forget dead entities and anything older than the difficulty's memory window. */
  prune(now, params) {
    for (const [id, e] of this.memory) {
      if (e.entity && e.entity !== 'player' && e.entity.alive === false) { this.memory.delete(id); continue; }
      const last = Math.max(e.lastSeen, e.lastHeard);
      if (now - last > params.memoryTime) this.memory.delete(id);
    }
  }

  /* Visible entries (a target that just left the cone stops counting immediately for firing,
     but remains in memory for the search branch). */
  visible(now, maxAge = STICKY) {
    const out = [];
    for (const e of this.memory.values()) if (e.visible && now - e.lastSeen <= maxAge) out.push(e);
    return out;
  }

  /* Remembered-but-not-visible entries, freshest first. */
  suspicions(now, params) {
    const out = [];
    for (const e of this.memory.values()) {
      if (e.visible) continue;
      if (now - Math.max(e.lastSeen, e.lastHeard) <= (params ? params.memoryTime : 4)) out.push(e);
    }
    out.sort((a, b) => Math.max(b.lastSeen, b.lastHeard) - Math.max(a.lastSeen, a.lastHeard));
    return out;
  }
}
