import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildWorld, MAPS } from '../src/world.js';
import { findSafeSpawn, spawnPointClear } from '../src/spawn.js';

function assets() {
  const mat = new THREE.MeshBasicMaterial();
  const tex = new THREE.Texture();
  return {
    mats: new Proxy({}, { get: () => mat }),
    ground: new Proxy({}, { get: () => mat }),
    containers: new Proxy({}, { get: () => mat }),
    tex: new Proxy({}, { get: () => tex }),
  };
}

function rng(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

test('player and bot spawn sampling stays clear on every map, including dense caldera bases', () => {
  for (const key of Object.keys(MAPS)) {
    const world = buildWorld(new THREE.Scene(), assets(), 'high', key);
    for (const [team, base] of Object.entries({ A: new THREE.Vector3(0, 0, 24), B: new THREE.Vector3(0, 0, -24) })) {
      for (let seed = 1; seed <= 40; seed++) {
        const p = findSafeSpawn(base, world.colliders, { jitter: team === 'A' ? 5 : 4, random: rng(seed) });
        assert.ok(spawnPointClear(p.x, p.z, world.colliders, .45, 1.8, 52),
          `${key} ${team} seed ${seed} spawned at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
      }
    }
  }
});
