// botCombat.js — pure combat maths shared by the bots: target priority, ballistic lead,
// accuracy, and cover-point generation/evaluation.
//
// Everything here is deliberately free of scene/DOM dependencies so it can be unit-tested in
// Node and reused by the offline evolution tool. The world is described as plain AABB/OBB
// colliders ({minX,maxX,minZ,maxZ,top,bottom,x,z,w,d,ry}), as produced by world.js.

import * as THREE from 'three';
import { circleOverlapsCollider } from './collision.js';

const BULLET_SPEED = 110; // m/s — matches the bots' fast tracer feel (not a real projectile)

/* ------------------------------------------------------------------ target priority */

/**
 * Score a remembered enemy. Visible targets dominate; among equals the bot prefers close,
 * wounded, recently-damaging and already-tracked targets (the brief's rankTarget rules).
 */
export function scoreTarget(entry, botPos, now, currentId = null) {
  if (!entry) return -Infinity;
  const dist = Math.hypot(entry.pos.x - botPos.x, entry.pos.z - botPos.z);
  const hpFrac = entry.maxHp > 0 ? Math.max(0, Math.min(1, entry.hp / entry.maxHp)) : 1;
  let score = 0;
  score += entry.visible ? 20 : 0;
  score += (1 - hpFrac) * 10;
  score += 12 / (1 + dist * .12);
  if (entry.id === currentId) score += 4; // hysteresis: no target ping-pong while strafing
  if (!entry.visible) score += (entry.confidence || 0) * 2;
  if (entry.source === 'damage') score += 2; // the guy who just shot me is a priority
  if (entry.lastSeen >= 0 && now - entry.lastSeen < 1) score += 1.5;
  return score;
}

/* ------------------------------------------------------------------ ballistics / aim */

/** Where to aim so a fast tracer meets a moving target (lead × difficulty). */
export function leadPoint(from, targetPos, targetVel, lead = 1, out = new THREE.Vector3()) {
  out.copy(targetPos);
  if (!targetVel || lead <= 0) return out;
  const dx = targetPos.x - from.x, dz = targetPos.z - from.z;
  const dist = Math.hypot(dx, dz);
  const flight = dist / BULLET_SPEED;
  out.x += targetVel.x * flight * lead;
  out.z += targetVel.z * flight * lead;
  return out;
}

/**
 * Probability of a miss for one shot. This is the single difficulty dial the acceptance
 * tests measure: base accuracy, range falloff, target motion, aim settling, smoke, and
 * moving-while-firing all push it up. Result is clamped so no bot is ever a laser or a
 * stormtrooper.
 */
export function shotMissChance(params, opts = {}) {
  const dist = Math.max(0, opts.dist || 0);
  const speed = Math.max(0, opts.targetSpeed || 0);
  const settle = Math.max(0, Math.min(1, opts.settle == null ? 1 : opts.settle));
  let miss = (1 - params.accuracy) * (params.missK || 1);
  miss += Math.max(0, dist - 10) * .010 * (params.missK || 1);
  miss += Math.min(.20, speed * .010);
  miss += (1 - settle) * .10;
  miss += opts.smoke ? .35 : 0;
  miss += opts.moving ? .02 : 0;
  miss += opts.targetLow ? .03 : 0;
  return Math.max(.02, Math.min(.92, miss));
}

/**
 * Visual aim offset for one frame: a fresh target is acquired with a wide error that decays
 * as the bot settles (aimTime). Units are metres at the target, so a near target looks like a
 * big correction and a far one like a small one.
 */
export function aimErrorOffset(params, settle, dist, out = new THREE.Vector3()) {
  const spread = ((1 - settle) * (params.settleError || 0) + (params.aimJitter || 0)) * Math.max(1, dist * .04);
  out.set((Math.random() - .5) * spread, (Math.random() - .5) * spread * .7, (Math.random() - .5) * spread);
  return out;
}

/* ------------------------------------------------------------------ firing line */

/**
 * Find the nearest living teammate (or the player, when allied) standing on the 2D segment
 * from `from` to `to`. Bots hold fire instead of shooting through a friendly body.
 * Returns {entity, t} where t is the normalized position along the segment, or null.
 */
export function teammateBlockingShot(bot, from, to, radius = .55) {
  const game = bot && bot.game;
  if (!game) return null;
  const dx = to.x - from.x, dz = to.z - from.z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-6) return null;
  let best = null, bestT = Infinity;
  const test = (entity, x, z, r) => {
    const t = ((x - from.x) * dx + (z - from.z) * dz) / len2;
    if (t <= .04 || t >= .98) return; // at the muzzle / behind the target: not a blocker
    const cx = from.x + dx * t, cz = from.z + dz * t;
    if (Math.hypot(x - cx, z - cz) > r) return;
    if (t < bestT) { bestT = t; best = {entity, t}; }
  };
  const heroes = game.heroes && game.heroes.list;
  if (Array.isArray(heroes)) {
    for (const h of heroes) {
      if (h === bot || !h.alive || h.team !== bot.team) continue;
      test(h, h.pos.x, h.pos.z, radius);
    }
  }
  const pl = game.player;
  const team = game.playerTeam || 'A';
  if (pl && pl.alive && team === bot.team) test('player', pl.pos.x, pl.pos.z, .45);
  return best;
}

/* ------------------------------------------------------------------ cover */

const COVER_MARGIN = 1.35;
const COVER_MIN_TOP = 1.2;

/** True when the 2D segment a→b crosses a tall-enough box (a wall between us and the threat). */
export function segmentBlocked(ax, az, bx, bz, colliders, minTop = COVER_MIN_TOP, ignore = null) {
  for (const c of colliders) {
    if (c === ignore || c.top < minTop || (c.bottom != null && c.bottom >= 1.8)) continue;
    let lax = ax, laz = az, lbx = bx, lbz = bz, hx = (c.maxX - c.minX) / 2, hz = (c.maxZ - c.minZ) / 2;
    if (c.ry && c.w && c.d) {
      const co = Math.cos(c.ry), si = Math.sin(c.ry);
      lax = (ax - c.x) * co - (az - c.z) * si; laz = (ax - c.x) * si + (az - c.z) * co;
      lbx = (bx - c.x) * co - (bz - c.z) * si; lbz = (bx - c.x) * si + (bz - c.z) * co;
      hx = c.w / 2; hz = c.d / 2;
    } else {
      const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
      lax -= cx; laz -= cz; lbx -= cx; lbz -= cz;
    }
    const dx = lbx - lax, dz = lbz - laz;
    let t0 = 0, t1 = 1;
    for (const [p, d, half] of [[lax, dx, hx], [laz, dz, hz]]) {
      if (Math.abs(d) < 1e-9) { if (p < -half || p > half) { t0 = 1; t1 = 0; break; } continue; }
      let ta = (-half - p) / d, tb = (half - p) / d;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) break;
    }
    if (t1 - t0 > 1e-4) return true;
  }
  return false;
}

export function isPointClear(x, z, colliders, radius = .46) {
  for (const c of colliders) {
    if (c.bottom != null && c.bottom >= 1.8) continue;
    // Bots cannot climb, so even a waist-high crate is an obstacle for navigation and a
    // hiding spot placed inside one is unreachable. Rotated boxes use their true footprint.
    if (circleOverlapsCollider(x, z, radius, c)) return false;
  }
  return true;
}

/**
 * Candidate hiding spots derived from the map's colliders. Cached on the world object and
 * rebuilt when the collider list changes (e2e pushes temporary boxes into it). Each box
 * contributes four face-centre and four corner points pushed a body-width clear of its faces.
 */
export function coverPointsFor(world) {
  if (!world || !Array.isArray(world.colliders)) return [];
  const cols = world.colliders.filter(c => c.bottom == null || c.bottom < 1.8);
  const sig = coverSignature(cols);
  if (world._botCoverCache && world._botCoverSig === sig) return world._botCoverCache;
  const pts = [];
  const seen = new Set();
  const push = (x, z) => {
    if (Math.hypot(x, z) > 50) return;
    if (!isPointClear(x, z, cols)) return;
    const key = Math.round(x * 2) + ',' + Math.round(z * 2);
    if (seen.has(key)) return;
    seen.add(key);
    pts.push({x, z});
  };
  for (const c of cols) {
    if (c.top < COVER_MIN_TOP) continue;
    const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2;
    const hw = (c.maxX - c.minX) / 2 + COVER_MARGIN;
    const hd = (c.maxZ - c.minZ) / 2 + COVER_MARGIN;
    push(cx + hw, cz); push(cx - hw, cz); push(cx, cz + hd); push(cx, cz - hd);
    push(cx + hw, cz + hd); push(cx - hw, cz + hd); push(cx + hw, cz - hd); push(cx - hw, cz - hd);
    if (pts.length >= 900) break;
  }
  world._botCoverSig = sig;
  world._botCoverCache = pts;
  return pts;
}

function coverSignature(cols) {
  const n = cols.length;
  if (!n) return '0';
  const a = cols[0], b = cols[n - 1];
  return n + '|' + a.minX + ',' + a.minZ + '|' + b.maxX + ',' + b.maxZ + '|' + b.top;
}

/**
 * Cover quality: blocks the threat (+), sits near the preferred stand-off distance from the
 * threat, and stays close to the bot. `blocked` may be precomputed cheaply (2D) or via LOS.
 */
export function scoreCoverPoint(point, {botPos, threatPos, coverBias = .7, preferCoverDist = 13, blocked = false}) {
  const dThreat = Math.hypot(point.x - threatPos.x, point.z - threatPos.z);
  const dBot = Math.hypot(point.x - botPos.x, point.z - botPos.z);
  let score = blocked ? 12 * coverBias : 0;
  score -= Math.abs(dThreat - preferCoverDist) * .35;
  score -= dBot * .12;
  if (dThreat < 4.5) score -= 6; // too close to the threat to be a hiding spot
  return score;
}

/**
 * Pick the best reachable cover spot against one threat.
 * Cheap 2D blocking ranks candidates first; only the best few get a real LOS raycast, which
 * keeps the per-frame cost of cover selection bounded on every map.
 */
export function findBestCover(bot, threatPos, losCheck) {
  const world = bot.game && bot.game.world;
  if (!world || !threatPos) return null;
  const pts = coverPointsFor(world);
  if (!pts.length) return null;
  const cols = world.colliders;
  const params = bot.brain ? bot.brain.params : null;
  const coverBias = params && params.coverBias != null ? params.coverBias : .7;
  const preferCoverDist = params && params.preferCoverDist != null ? params.preferCoverDist : 13;
  const threat = {x: threatPos.x, z: threatPos.z};
  const eye = {x: bot.pos.x, y: bot.pos.y + 1.4, z: bot.pos.z};
  const tEye = {x: threatPos.x, y: 1.4, z: threatPos.z};
  const top = [];
  const TOP_N = 6;
  for (const p of pts) {
    const dBot = Math.hypot(p.x - bot.pos.x, p.z - bot.pos.z);
    if (dBot < 1.2 || dBot > 26) continue;
    const dThreat = Math.hypot(p.x - threat.x, p.z - threat.z);
    if (dThreat < 4.5) continue;
    const blocked = segmentBlocked(p.x, p.z, threat.x, threat.z, cols);
    const score = scoreCoverPoint(p, {botPos: bot.pos, threatPos: threat, coverBias, preferCoverDist, blocked});
    // Keep the best TOP_N cheap candidates, insertion-sorted (small fixed array, no sort alloc).
    if (top.length < TOP_N) {
      top.push({p, score, blocked});
      top.sort((a, b) => b.score - a.score);
    } else if (score > top[TOP_N - 1].score) {
      top[TOP_N - 1] = {p, score, blocked};
      top.sort((a, b) => b.score - a.score);
    }
  }
  // `top` is already sorted best-first, so the first candidate that actually hides the bot is
  // the answer. The cheap 2D test filters out exposed spots before the (costlier) LOS raycast;
  // only genuinely blocked candidates get a ray.
  for (const cand of top) {
    if (!cand.blocked && !losCheck) continue;
    if (losCheck && !cand.blocked) continue;
    if (losCheck && losCheck(eye, tEye)) continue; // visible → not cover
    return new THREE.Vector3(cand.p.x, 0, cand.p.z);
  }
  return null;
}
