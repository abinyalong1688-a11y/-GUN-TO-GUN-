import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import { buildWorld, MAPS } from '../src/world.js';
import { terrainHeight } from '../src/terrain.js';
import { circleOverlapsCollider } from '../src/collision.js';
import { Player } from '../src/player.js';
import { pickHill, KOTH_RADIUS } from '../src/modes.js';

const MAP_KEYS = Object.keys(MAPS);

function stubAssets() {
  const mat = new THREE.MeshBasicMaterial();
  const tex = new THREE.Texture();
  return {
    mats: new Proxy({}, { get: () => mat }),
    ground: new Proxy({}, { get: () => mat }),
    containers: new Proxy({}, { get: () => mat }),
    tex: new Proxy({}, { get: () => tex }),
  };
}

function build(key) {
  return buildWorld(new THREE.Scene(), stubAssets(), 'high', key);
}

function meshes(world) {
  const out = [];
  world.group.updateMatrixWorld(true);
  world.group.traverse(o => {
    if (!o.isMesh || o === world.sky || o === world.ground) return;
    const box = new THREE.Box3().setFromObject(o);
    const center = box.getCenter(new THREE.Vector3());
    if (Math.hypot(center.x, center.z) > 58 || box.min.y > 16) return;
    o.geometry.computeBoundingBox();
    const obb = new OBB().fromBox3(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    out.push({ mesh: o, box, center, obb });
  });
  return out;
}

function named(world, name) {
  const out = [];
  world.group.traverse(o => { if (o.name === name) out.push(o); });
  return out;
}

function near(actual, expected, epsilon = 0.025) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} (±${epsilon})`);
}

test('all four maps build deterministic, finite collision geometry', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    assert.ok(world.colliders.length > 10, `${key} should have solid cover`);
    assert.equal(world.spawnPoints.length, 4);
    for (const c of world.colliders) {
      for (const v of [c.minX, c.maxX, c.minZ, c.maxZ, c.bottom ?? 0, c.top]) {
        assert.ok(Number.isFinite(v), `${key} has a non-finite collider value`);
      }
      assert.ok(c.maxX >= c.minX && c.maxZ >= c.minZ && c.top >= (c.bottom ?? 0));
    }
    for (const p of world.spawnPoints) {
      near(p.y, terrainHeight(p.x, p.z));
      for (const c of world.colliders) {
        assert.equal(circleOverlapsCollider(p.x, p.z, 0.45, c), false,
          `${key} spawn ${p.x},${p.z} overlaps a collider`);
      }
    }
  }
});

test('player collision converges from every authored wall face and dense overlap', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    const player = new Player(new THREE.PerspectiveCamera(), world.colliders);
    const solid = world.colliders.filter(c => c.top > .32 && (c.bottom ?? 0) < 1.8);
    for (const c of solid) {
      const cx = (c.minX + c.maxX) / 2, cz = (c.minZ + c.maxZ) / 2, r = player.radius - .03;
      for (const [x, z] of [[c.minX-r,cz],[c.maxX+r,cz],[cx,c.minZ-r],[cx,c.maxZ+r]]) {
        player.pos.set(x, 0, z); player._collide();
        for (const other of solid)
          assert.equal(circleOverlapsCollider(player.pos.x, player.pos.z, player.radius, other), false,
            `${key} residual penetration at ${player.pos.x.toFixed(2)},${player.pos.z.toFixed(2)}`);
      }
    }
  }
});

test('KOTH avoids both team spawn envelopes and non-stepable cover on every map', () => {
  const spawns = [new THREE.Vector3(0, 0, 24), new THREE.Vector3(0, 0, -24)];
  for (const key of MAP_KEYS) {
    const world = build(key);
    const hill = pickHill(world.colliders, { radius: KOTH_RADIUS, spawns });
    assert.ok(hill.clearance >= KOTH_RADIUS - .5, `${key} hill clearance ${hill.clearance}`);
    for (const s of spawns)
      assert.ok(Math.hypot(hill.x - s.x, hill.z - s.z) >= KOTH_RADIUS + 1.4,
        `${key} hill overlaps a spawn envelope`);
  }
});

test('rendered ground triangles stay flat all the way to the player boundary on every quality tier', () => {
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const from = new THREE.Vector3();
  for (const quality of ['low', 'high']) {
    const world = buildWorld(new THREE.Scene(), stubAssets(), quality, 'desert');
    world.group.updateMatrixWorld(true);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 72) {
      for (const r of [0, 20, 40, 52, 55.5, 56]) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        ray.set(from.set(x, 30, z), down); ray.far = 60;
        const hit = ray.intersectObject(world.ground, false)[0];
        assert.ok(hit, `${quality} ground missing at ${x},${z}`);
        near(hit.point.y, 0, 1e-6);
      }
    }
  }
});

test('ground-following decals use terrainHeight instead of the removed noise field', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    for (const o of named(world, 'rain-puddle')) near(o.position.y - terrainHeight(o.position.x, o.position.z), 0.025);
    for (const o of named(world, 'lava-fissure')) near(o.position.y - terrainHeight(o.position.x, o.position.z), 0.03);
    for (const o of named(world, 'snow-drift')) {
      const box = new THREE.Box3().setFromObject(o);
      assert.ok(box.max.y <= 0.061, `${key} snow drift is tall enough to sink boots (${box.max.y})`);
    }
    const lava = named(world, 'lava-river');
    assert.equal(lava.length, key === 'ember' ? 1 : 0);
    if (lava.length) {
      const p = lava[0].geometry.attributes.position;
      for (let i = 0; i < p.count; i++) near(p.getY(i) - terrainHeight(p.getX(i), p.getZ(i)), 0.025);
    }
  }
});

test('every map box has a matching solid collider, including stacked crates and sandbags', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    const boxes = meshes(world).filter(m => m.mesh.name.startsWith('world-box-'));
    assert.ok(boxes.length > 10);
    for (const { mesh, box, center } of boxes) {
      assert.ok(world.colliders.some(c =>
        center.x >= c.minX - 0.02 && center.x <= c.maxX + 0.02 &&
        center.z >= c.minZ - 0.02 && center.z <= c.maxZ + 0.02 &&
        Math.abs(c.top - box.max.y) < 0.02),
      `${key} box ${mesh.name} has no collider at its rendered top ${box.max.y}`);
    }
  }
});

test('rocks, barrels, columns and obsidian slabs collide at their rendered top', () => {
  const solidNames = new Set(['scattered-rock', 'supply-barrel', 'basalt-column', 'obsidian-slab', 'street-lamp-pole']);
  for (const key of MAP_KEYS) {
    const world = build(key);
    for (const { mesh, box, center } of meshes(world)) {
      if (!solidNames.has(mesh.name)) continue;
      assert.ok(world.colliders.some(c =>
        center.x >= c.minX - 0.02 && center.x <= c.maxX + 0.02 &&
        center.z >= c.minZ - 0.02 && center.z <= c.maxZ + 0.02 &&
        Math.abs(c.top - box.max.y) < 0.03),
      `${key} ${mesh.name} at ${center.x},${center.z} has collider top mismatch`);
    }
  }
});

test('sponsor supports do not intersect either printed face', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    const all = meshes(world);
    const posts = all.filter(m => m.mesh.name === 'sponsor-post');
    const faces = all.filter(m => m.mesh.name === 'sponsor-front' || m.mesh.name === 'sponsor-back');
    assert.equal(posts.length, 6, `${key} should have three two-post billboards`);
    assert.equal(faces.length, 6);
    for (const p of posts) for (const f of faces) {
      assert.equal(p.obb.intersectsOBB(f.obb, 1e-6), false,
        `${key} sponsor support intersects ${f.mesh.name}`);
    }
  }
});

test('the caldera arch is passable underneath and its lintel is overhead-only', () => {
  const world = build('ember');
  const lintel = named(world, 'basalt-arch-lintel');
  assert.equal(lintel.length, 1);
  const overhead = world.colliders.find(c => c.bottom >= 3.7 && c.top <= 4.9 &&
    circleOverlapsCollider(lintel[0].position.x, lintel[0].position.z, .01, c));
  assert.ok(overhead, 'lintel needs an overhead collider');
  const player = new Player(new THREE.PerspectiveCamera(), world.colliders);
  const bridgeRy = lintel[0].rotation.y - Math.PI / 2;
  const ux = Math.cos(bridgeRy), uz = -Math.sin(bridgeRy);
  for (let d = -4; d <= 4.001; d += .25) {
    player.pos.set(lintel[0].position.x + ux * d, 0.9, lintel[0].position.z + uz * d);
    player._collide();
    near(player.pos.x, lintel[0].position.x + ux * d, 0.001);
    near(player.pos.z, lintel[0].position.z + uz * d, 0.001);
  }
});

test('distant icebergs, skyline buildings and the volcano do not merge into unrelated scenery', () => {
  const overlaps = (a, b) => {
    a.geometry.computeBoundingBox(); b.geometry.computeBoundingBox();
    const oa = new OBB().fromBox3(a.geometry.boundingBox).applyMatrix4(a.matrixWorld);
    const ob = new OBB().fromBox3(b.geometry.boundingBox).applyMatrix4(b.matrixWorld);
    return oa.intersectsOBB(ob, 1e-6);
  };
  for (const key of MAP_KEYS) {
    const world = build(key);
    world.group.updateMatrixWorld(true);
    const all = [];
    world.group.traverse(o => { if (o.isMesh && o !== world.sky && o !== world.ground) all.push(o); });
    const mounds = all.filter(o => o.geometry.type === 'SphereGeometry' && o.geometry.parameters.radius > 10);
    for (const berg of all.filter(o => o.name === 'distant-iceberg'))
      for (const mound of mounds) assert.equal(overlaps(berg, mound), false, `${key} iceberg intersects a mound`);
    const volcano = all.find(o => o.name === 'volcano-cone');
    if (volcano) for (const mound of mounds) assert.equal(overlaps(volcano, mound), false, 'volcano intersects a mound');
    if (key === 'snowtown') {
      const buildings = all.filter(o => o.geometry.type === 'BoxGeometry' && o.position.y < 0 && Math.hypot(o.position.x, o.position.z) > 58);
      for (let i = 0; i < buildings.length; i++) for (let j = 0; j < i; j++)
        assert.equal(overlaps(buildings[i], buildings[j]), false, 'skyline buildings intersect');
    }
  }
});

test('separate map props do not interpenetrate (intentional assembled fixtures excluded)', () => {
  for (const key of MAP_KEYS) {
    const world = build(key);
    const all = meshes(world).filter(m => m.mesh.name !== 'lava-river');
    const bad = [];
    for (let i = 0; i < all.length; i++) {
      const a = all[i];
      for (let j = 0; j < i; j++) {
        const b = all[j];
        const x = Math.min(a.box.max.x, b.box.max.x) - Math.max(a.box.min.x, b.box.min.x);
        const y = Math.min(a.box.max.y, b.box.max.y) - Math.max(a.box.min.y, b.box.min.y);
        const z = Math.min(a.box.max.z, b.box.max.z) - Math.max(a.box.min.z, b.box.min.z);
        if (x <= 0.02 || y <= 0.02 || z <= 0.02 || !a.obb.intersectsOBB(b.obb, 1e-6)) continue;
        const an = a.mesh.name, bn = b.mesh.name;
        // Posts seated in their frame, lamp/crane/mast hardware and pole-mounted signs are
        // deliberately joined assemblies, not accidental prop intersections.
        if ((an === 'sponsor-post' && bn === 'sponsor-frame') || (bn === 'sponsor-post' && an === 'sponsor-frame')) continue;
        if ((an === 'neon-sign-pole' && bn.startsWith('neon-sign-')) || (bn === 'neon-sign-pole' && an.startsWith('neon-sign-'))) continue;
        if (Math.max(a.center.y, b.center.y) > 4) continue;
        const highMastJoint = Math.max(a.box.min.y, b.box.min.y) > 3 &&
          Math.hypot(a.center.x - b.center.x, a.center.z - b.center.z) < 0.35;
        if (highMastJoint) continue;
        bad.push(`${an || a.mesh.geometry.type}@${a.center.x.toFixed(2)},${a.center.z.toFixed(2)} × ${bn || b.mesh.geometry.type}@${b.center.x.toFixed(2)},${b.center.z.toFixed(2)}`);
      }
    }
    assert.deepEqual(bad, [], `${key} has intersecting props:\n${bad.join('\n')}`);
  }
});

test('static colliders never overlap by more than 2 cm on any map', () => {
  const TH = 0.02;
  for (const key of MAP_KEYS) {
    const { colliders } = build(key);
    const bad = [];
    for (let i = 0; i < colliders.length; i++) for (let j = 0; j < i; j++) {
      const a = colliders[i], b = colliders[j];
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oy = Math.min(a.top, b.top) - Math.max(a.bottom ?? 0, b.bottom ?? 0);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      if (ox > TH && oy > TH && oz > TH) bad.push(
        `#${i}@${((a.minX+a.maxX)/2).toFixed(2)},${((a.minZ+a.maxZ)/2).toFixed(2)} × ` +
        `#${j}@${((b.minX+b.maxX)/2).toFixed(2)},${((b.minZ+b.maxZ)/2).toFixed(2)} ` +
        `${ox.toFixed(3)}×${oy.toFixed(3)}×${oz.toFixed(3)}`);
    }
    assert.deepEqual(bad, [], `${key} collider overlaps >2 cm:\n${bad.join('\n')}`);
  }
});
