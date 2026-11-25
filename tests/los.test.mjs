import { test } from 'node:test';
import assert from 'node:assert';
import { losBlocked, hashGeo } from '../server/los.js';
import { WEAPON_DMG, HEAD_MUL } from '../src/netProtocol.js';

/* ---- LOS: axis-aligned box ---- */
test('LOS: clear shot through empty space is not blocked', () => {
  const geo = [[0, 10, 0, 1, 1, 0, 0, 3]];               // box off to the side
  assert.equal(losBlocked(geo, 0, 1.6, 0, 0, 1.6, -20), false);
});

test('LOS: ray piercing a box is blocked', () => {
  const geo = [[0, 0, -10, 1, 1, 0, 0, 3]];
  assert.equal(losBlocked(geo, 0, 1.6, 0, 0, 1.6, -20), true);
});

test('LOS: ray passing above a low box is not blocked (Y slab)', () => {
  const geo = [[0, 0, -10, 1, 1, 0, 0, 1]];              // box top at y=1
  assert.equal(losBlocked(geo, 0, 2.5, 0, 0, 2.5, -20), false);
  assert.equal(losBlocked(geo, 0, 0.5, 0, 0, 0.5, -20), true);
});

/* ---- LOS: rotated box must use the OBB, not the AABB ---- */
test('LOS: 45° box corner is not false-blocked (exact OBB)', () => {
  // 4×4 box rotated 45°: the true footprint is a diamond, the AABB would be a 5.66×5.66 square.
  const geo = [[0, 0, 0, 2, 2, Math.PI / 4, 0, 3]];
  // (3.9, 0) lies outside the diamond corner but inside the AABB — must NOT block.
  assert.equal(losBlocked(geo, 3.9, 1.6, 0, 0, 1.6, -10), false);
  // straight through the centre IS blocked.
  assert.equal(losBlocked(geo, 0, 1.6, 0, 0, 1.6, -10), true);
});

/* ---- LOS: cylinder ---- */
test('LOS: cylinder blocks a ray through its centre, not one to the side', () => {
  const geo = [[1, 0, -10, 1, 0, 2]];                    // radius 1, y 0..2
  assert.equal(losBlocked(geo, 0, 1.6, 0, 0, 1.6, -20), true);
  assert.equal(losBlocked(geo, 1.5, 1.6, 0, 1.5, 1.6, -20), false);
});

/* ---- geometry hash (anti-tamper) ---- */
test('hashGeo: identical geometry hashes equal', () => {
  const a = [[0, 1, 2, 3, 4, 0, 0, 1], [0, 5, 6, 7, 8, 0.3, 0, 1]];
  const b = [[0, 1, 2, 3, 4, 0, 0, 1], [0, 5, 6, 7, 8, 0.3, 0, 1]];
  assert.equal(hashGeo(a), hashGeo(b));
});

test('hashGeo: a tampered box differs', () => {
  const a = [[0, 1, 2, 3, 4, 0, 0, 1]];
  const b = [[0, 1, 2, 3, 4, 0, 0, 5]];
  assert.notEqual(hashGeo(a), hashGeo(b));
});

/* ---- authoritative damage ---- */
test('authoritative damage: headshot is exactly 2× base, body is base', () => {
  assert.equal(WEAPON_DMG.awp * HEAD_MUL, 230);
  assert.equal(WEAPON_DMG.ak47 * HEAD_MUL, 72);
  assert.equal(WEAPON_DMG.deagle * HEAD_MUL, 106);
  assert.equal(WEAPON_DMG.m4a4 * 1, 31);
});

/* Regression guard: the server box rotation must agree with the client's rendered mesh.
   The old convention used the forward rotation as the inverse, mirroring the footprint;
   symmetric probes and 45° boxes cannot distinguish the two, so this uses an asymmetric box. */
test('LOS: rotated box matches the rendered mesh (rotation.y convention)', async () => {
  const THREE = await import('three');
  const w = 6.1, d = 2.44, h = 2.6, ry = 0.22;
  const geo = [[0, 0, 0, w / 2, d / 2, ry, 0, h]];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
  mesh.position.set(0, h / 2, 0); mesh.rotation.y = ry; mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  let checked = 0, mismatched = 0;
  for (let a = 0; a < 72; a++) {
    const ang = a / 72 * Math.PI * 2;
    const from = [Math.cos(ang) * 9, 1.5, Math.sin(ang) * 9];
    const to = [Math.cos(ang + Math.PI) * 9, 1.5, Math.sin(ang + Math.PI) * 9];
    const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const len = dir.length(); dir.normalize();
    rc.set(new THREE.Vector3(...from), dir, 0, len); rc.far = len;
    const rendered = rc.intersectObject(mesh, false).length > 0;
    const server = losBlocked(geo, ...from, ...to);
    checked++; if (rendered !== server) mismatched++;
  }
  assert.equal(mismatched, 0, `${mismatched}/${checked} rays disagree with the rendered mesh`);
});

/* The DO pins every C.WORLD upload to MAP_HASHES, so the table must match what world.js bakes.
   If a map layout changes without re-running scripts/bake-map-hash.mjs, every match silently
   loses its wall checks — this test is the tripwire. */
test('MAP_HASHES matches the geometry world.js bakes for each shipped map', async () => {
  const THREE = await import('three');
  const { buildWorld } = await import('../src/world.js');
  const { MAP_HASHES, mapHashValue } = await import('../src/netProtocol.js');
  const mk = () => new THREE.MeshBasicMaterial();
  const assets = {
    mats: new Proxy({}, { get: mk }), ground: new Proxy({}, { get: mk }),
    containers: new Proxy({}, { get: mk }), tex: new Proxy({}, { get: () => new THREE.Texture() }),
  };
  for (const key of ['desert','snow','snowtown','ember']) {
    const w = buildWorld(new THREE.Scene(), assets, 'high', key);
    assert.equal(hashGeo(w.losGeo), mapHashValue(MAP_HASHES[key]),
      `${key}: MAP_HASHES is stale — run node scripts/bake-map-hash.mjs --write`);
  }
});
