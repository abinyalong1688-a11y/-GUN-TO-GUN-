import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Enemies } from '../src/enemies.js';
import { circleOverlapsCollider } from '../src/collision.js';

test('drone sweep cannot tunnel through a thin static collider', () => {
  const wall = { minX: -.1, maxX: .1, minZ: -3, maxZ: 3, bottom: 0, top: 3 };
  const e = { T: { radius: .5 }, pos: new THREE.Vector3(-2, 2, 0) };
  const enemies = Object.create(Enemies.prototype);
  enemies._colliders = [wall];
  e.pos.x = 2;
  enemies._resolveStatic(e, -2, 0);
  assert.equal(circleOverlapsCollider(e.pos.x, e.pos.z, .5, wall), false);
  assert.ok(Math.abs(e.pos.x) >= .6, `drone crossed the wall to ${e.pos.x}`);
});

test('drone collision respects overhead geometry', () => {
  const lintel = { minX: -2, maxX: 2, minZ: -2, maxZ: 2, bottom: 3.8, top: 4.8 };
  const e = { T: { radius: .5 }, pos: new THREE.Vector3(0, 2, 0) };
  const enemies = Object.create(Enemies.prototype);
  enemies._colliders = [lintel];
  enemies._resolveStatic(e);
  assert.equal(e.pos.x, 0);
  assert.equal(e.pos.z, 0);
});
