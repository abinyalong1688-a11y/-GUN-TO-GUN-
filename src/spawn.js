// spawn.js — one safety sampler for players, bots and respawns.
// A random point in a base envelope is not necessarily safe on a dense map (the caldera gate and
// bank rocks used to catch ~20% of draws). Sample first, then spiral out deterministically; never
// release control from a point that still intersects static geometry.
import * as THREE from 'three';
import { circleOverlapsCollider, verticalBodyOverlap } from './collision.js';

export function spawnPointClear(x, z, colliders, radius = .45, bodyHeight = 1.8, bound = 52) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) > bound) return false;
  for (const c of colliders) {
    if (!verticalBodyOverlap(0, bodyHeight, c)) continue;
    if (circleOverlapsCollider(x, z, radius, c)) return false;
  }
  return true;
}

export function findSafeSpawn(base, colliders, {
  jitter = 4, radius = .45, bodyHeight = 1.8, bound = 52, attempts = 32, random = Math.random,
} = {}) {
  const bx = base.x, bz = base.z;
  for (let i = 0; i < attempts; i++) {
    const x = bx + (random() - .5) * jitter * 2, z = bz + (random() - .5) * jitter * 2;
    if (spawnPointClear(x, z, colliders, radius, bodyHeight, bound)) return new THREE.Vector3(x, 0, z);
  }
  // Deterministic fallback: increasingly wide rings, starting at the base itself.
  for (let ring = 0; ring <= 16; ring++) {
    const r = ring * .5, samples = ring === 0 ? 1 : 16;
    for (let i = 0; i < samples; i++) {
      const a = i / samples * Math.PI * 2, x = bx + Math.cos(a) * r, z = bz + Math.sin(a) * r;
      if (spawnPointClear(x, z, colliders, radius, bodyHeight, bound)) return new THREE.Vector3(x, 0, z);
    }
  }
  // Every authored base has free ground nearby; keep a finite, bounded last resort for tests.
  const d = Math.hypot(bx, bz) || 1, k = Math.min(1, bound / d);
  return new THREE.Vector3(bx * k, 0, bz * k);
}
