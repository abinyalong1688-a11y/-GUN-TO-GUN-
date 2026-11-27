import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildWorld } from '../src/world.js';
import { Pickups } from '../src/pickups.js';
import { circleOverlapsCollider } from '../src/collision.js';

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

function setup(map) {
  const scene = new THREE.Scene();
  const world = buildWorld(scene, assets(), 'high', map);
  const game = {
    world, scene,
    player: { pos: new THREE.Vector3(0, 0, 30) },
    weapon: { addReserve() {} },
  };
  const pickups = new Pickups(game, scene, { impact() {} }, { pickup() {} }, {});
  return { game, pickups };
}

test('a drop anchors to the rendered platform/container top, not a fixed y=.5', () => {
  const { pickups } = setup('snowtown');
  const platform = pickups.game.world.group.getObjectByName('world-box--2.00-0.55-10.50');
  assert.ok(platform);
  const p = pickups.spawn(new THREE.Vector3(-2, 0, 10.5), 'med');
  near(p.baseY, 1.6);
  near(p.pos.y, 1.6);
  pickups.update(1 / 60, pickups.game.player);
  assert.ok(p.pos.y > 1.49 && p.pos.y < 1.71, 'bob must stay above the platform');

  const { pickups: desert } = setup('desert');
  const container = desert.spawn(new THREE.Vector3(-8.5, 2.5, -4), 'ammo');
  near(container.baseY, 5.7); // topmost container in the two-high stack
});

test('magnet movement cannot pull a pickup through cover', () => {
  const { game, pickups } = setup('desert');
  const barrier = game.world.colliders.find(c => Math.abs(c.x - 3.5) < .01 && Math.abs(c.z - 8.5) < .01);
  assert.ok(barrier);
  const p = pickups.spawn(new THREE.Vector3(barrier.x, 0, barrier.z), 'boost');
  // Force the invalid state the magnet used to create, then verify the shared push-out repairs it.
  p.pos.set(barrier.x, .5, barrier.z);
  pickups._keepClear(p);
  assert.equal(circleOverlapsCollider(p.pos.x, p.pos.z, .22, barrier), false);

  const co = Math.cos(barrier.ry), si = Math.sin(barrier.ry);
  p.pos.set(barrier.x - si * .9, .5, barrier.z - co * .9);
  pickups._anchor(p);
  game.player.pos.set(barrier.x + si * .9, 0, barrier.z + co * .9);
  pickups.update(1 / 60, game.player);
  assert.equal(circleOverlapsCollider(p.pos.x, p.pos.z, .22, barrier), false,
    'pickup crossed the barrier during one magnet step');
});

function near(a, b) { assert.ok(Math.abs(a - b) < .002, `${a} != ${b}`); }
