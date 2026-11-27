// collision.test.mjs — circle vs AABB / rotated-box (OBB) push-out
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {pushCircleOut, circleOverlapsCollider, resolveCircleCollisions, verticalBodyOverlap} from '../src/collision.js';
import {Player} from '../src/player.js';

const R = .4;

test('AABB: centre inside pops out along the shallowest face', () => {
  const c = {minX:-1, maxX:1, minZ:-1, maxZ:3, top:1};
  const p = new THREE.Vector3(0, 0, 2.5);            // clearly closest to the +Z face
  assert.equal(pushCircleOut(p, R, c), true);
  assert.ok(Math.abs(p.z - (3 + R)) < 1e-6, 'expected +Z pop, got z=' + p.z);
  assert.equal(p.x, 0);
});

test('AABB: outside the radius is untouched', () => {
  const c = {minX:-1, maxX:1, minZ:-1, maxZ:1, top:1};
  const p = new THREE.Vector3(2, 0, 0);
  assert.equal(pushCircleOut(p, R, c), false);
  assert.equal(p.x, 2);
});

test('OBB: the empty corner of the bounding AABB is no longer solid', () => {
  // 4 x 2 box rotated 45°: its AABB half-extent is 2.12, but the AABB corner is outside the box
  const c = {x:0, z:0, w:4, d:2, ry:Math.PI / 4, minX:-2.13, maxX:2.13, minZ:-2.13, maxZ:2.13, top:1};
  const p = new THREE.Vector3(1.95, 0, 1.95);      // inside the old AABB, outside the rotated box
  assert.equal(pushCircleOut(p, R, c), false, 'corner space must stay walkable');
  assert.equal(p.x, 1.95);
});

test('OBB: a point inside the rotated box is pushed along its local face', () => {
  const c = {x:0, z:0, w:4, d:2, ry:Math.PI / 4, minX:-2.13, maxX:2.13, minZ:-2.13, maxZ:2.13, top:1};
  const p = new THREE.Vector3(0, 0, 0);            // dead centre
  assert.equal(pushCircleOut(p, R, c), true);
  // Local half-depth is 1, so the centre exits to |local z| = 1.4
  const co = Math.cos(Math.PI / 4), si = Math.sin(Math.PI / 4);
  const lx = p.x * co - p.z * si, lz = p.x * si + p.z * co;   // world → local (three.js R_y inverse)
  assert.ok(Math.abs(Math.abs(lz) - (1 + R)) < 1e-6, 'local z=' + lz);
  assert.ok(Math.abs(lx) < 1e-6, 'local x=' + lx);
});

test('OBB: walking into a rotated face is stopped at the surface + radius', () => {
  const c = {x:0, z:0, w:4, d:2, ry:.3, minX:-2.2, maxX:2.2, minZ:-1.3, maxZ:1.3, top:1};
  // Approach along local +Z: world = (lz*si, lz*co) for lx = 0
  const co = Math.cos(.3), si = Math.sin(.3);
  const p = new THREE.Vector3(si * 1.1, 0, co * 1.1);
  assert.equal(pushCircleOut(p, R, c), true);
  const lz = p.x * si + p.z * co;
  assert.ok(Math.abs(lz - (1 + R)) < 1e-6, 'local z=' + lz);
});

/* Regression guard for the rotation convention: the collider footprint must match what
   three.js actually renders for `mesh.rotation.y = ry`. The old (wrong) convention used the
   forward matrix as the inverse, which mirrored the footprint about the box diagonal — an
   asymmetric probe point is what exposes it (symmetric ones and 45° angles cannot). */
test('OBB: footprint matches the rendered mesh for the same rotation.y', () => {
  const w = 6.1, d = 2.44, ry = 0.22;
  const c = {
    x:0, z:0, w, d, ry, top:2.6,
    minX:-(Math.abs(Math.cos(ry)) * w / 2 + Math.abs(Math.sin(ry)) * d / 2),
    maxX:Math.abs(Math.cos(ry)) * w / 2 + Math.abs(Math.sin(ry)) * d / 2,
    minZ:-(Math.abs(Math.sin(ry)) * w / 2 + Math.abs(Math.cos(ry)) * d / 2),
    maxZ:Math.abs(Math.sin(ry)) * w / 2 + Math.abs(Math.cos(ry)) * d / 2,
  };
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, 2.6, d));
  mesh.rotation.y = ry; mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  let checked = 0, mismatched = 0;
  for (let x = -4; x <= 4; x += 0.15) {
    for (let z = -3; z <= 3; z += 0.15) {
      rc.set(new THREE.Vector3(x, 20, z), down); rc.far = 40;
      const rendered = rc.intersectObject(mesh, false).length > 0;
      const collider = circleOverlapsCollider(x, z, 0.001, c);
      checked++; if (rendered !== collider) mismatched++;
    }
  }
  assert.equal(mismatched, 0, `${mismatched}/${checked} probe points disagree with the rendered mesh`);
});

test('player: cannot stand up while horizontally overlapping a low overhead collider', () => {
  const cam = new THREE.PerspectiveCamera();
  const low = {minX:-.8, maxX:.8, minZ:-.8, maxZ:.8, top:1.2}; // top is above feet, below standing eye
  const p = new Player(cam, [low]);
  p.pos.set(0, 0, 0);
  p.crouching = true;
  assert.equal(p.canStand(), false);
  p.pos.set(3, 0, 3);
  assert.equal(p.canStand(), true);
});

test('player: crouch request always wins, standing up is blocked until clear', () => {
  const cam = new THREE.PerspectiveCamera();
  const low = {minX:-.8, maxX:.8, minZ:-.8, maxZ:.8, top:1.2};
  const p = new Player(cam, [low]);
  p.pos.set(0, 0, 0);
  p.crouching = true;
  const INPUT = {ads:false}, AUDIO = {step(){}};
  p.update(.016, INPUT, new Set(), 0, AUDIO);            // no crouch key, but ceiling blocks
  assert.equal(p.crouching, true);
  p.update(.016, INPUT, new Set(['ControlLeft']), 0, AUDIO);
  assert.equal(p.crouching, true);
  p.pos.set(3, 0, 3);                                    // step clear of the low collider
  p.update(.016, INPUT, new Set(), 0, AUDIO);
  assert.equal(p.crouching, false);
});

test('neighbouring colliders converge without residual penetration or order-dependent pops', () => {
  const cols = [
    {minX:-1, maxX:1, minZ:-2, maxZ:2, bottom:0, top:3},
    {minX:.8, maxX:2.8, minZ:-2, maxZ:2, bottom:0, top:3},
  ];
  for (const order of [cols, cols.slice().reverse()]) {
    const p = new THREE.Vector3(.9, 0, 0);
    const result = resolveCircleCollisions(p, .4, order, 1.8);
    assert.equal(result.converged, true);
    assert.equal(circleOverlapsCollider(p.x, p.z, .4, cols[0]), false);
    assert.equal(circleOverlapsCollider(p.x, p.z, .4, cols[1]), false);
  }
});

test('overhead geometry is ignored by body collision but still blocks a body that intersects it', () => {
  const lintel = {minX:-2, maxX:2, minZ:-1, maxZ:1, bottom:3.8, top:4.8};
  const ground = new THREE.Vector3(0, 0, 0);
  assert.equal(verticalBodyOverlap(ground.y, 1.8, lintel), false);
  assert.equal(resolveCircleCollisions(ground, .4, [lintel], 1.8).converged, true);
  assert.equal(ground.x, 0);
  const jumper = new THREE.Vector3(0, 3.7, 0);
  assert.equal(verticalBodyOverlap(jumper.y, 1.8, lintel), true);
});

test('footprint: OBB support surface does not extend into the bounding-AABB corner', () => {
  const cam = new THREE.PerspectiveCamera();
  const c = {x:0, z:0, w:4, d:2, ry:Math.PI/4, minX:-2.13, maxX:2.13, minZ:-2.13, maxZ:2.13, top:1};
  const p = new Player(cam, [c]);
  p.pos.set(1.95, 1.2, 1.95);       // above the empty AABB corner
  assert.equal(p._supportY(2), 0, 'must not stand on air');
  p.pos.set(0, 1.2, 0);             // above the real box
  assert.equal(p._supportY(2), 1);
});
