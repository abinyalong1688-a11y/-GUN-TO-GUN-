// footAudit.js — geometric foot-vs-surface clearance audit.
//
// A collision capsule can be perfectly fine while the art still sinks into the floor. This
// module samples the *rendered* sole vertices — skinned GLB foot/toe vertices (bone weights) and
// rigid procedural boot meshes — transforms them to world space, and compares each one with the
// surface under it. Positive penetration = the mesh is below the surface.
//
// Used by the ?e2e=1 regression and by ad-hoc visual QA in the browser.

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _footSets = new WeakMap();

function footBoneSet(hero) {
  let set = _footSets.get(hero.group);
  if (set) return set;
  set = new Set();
  for (const b of [hero.footL, hero.footR]) if (b) b.traverse(o => set.add(o));
  _footSets.set(hero.group, set);
  return set;
}

/* Vertex indices whose dominant skin weight belongs to a foot / toe bone (cached per mesh). */
function footVertexIndices(mesh, bones) {
  if (mesh.userData.__footIdx && mesh.userData.__footIdxBones === bones)
    return mesh.userData.__footIdx;
  const idx = [];
  const si = mesh.geometry.attributes.skinIndex;
  const sw = mesh.geometry.attributes.skinWeight;
  if (si && sw && mesh.skeleton) {
    for (let i = 0; i < si.count; i++) {
      let bi = -1, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) { bw = w; bi = si.getComponent(i, k); }
      }
      const bone = mesh.skeleton.bones[bi];
      if (bone && bones.has(bone)) idx.push(i);
    }
  }
  mesh.userData.__footIdx = idx;
  mesh.userData.__footIdxBones = bones;
  return idx;
}

/**
 * Sample every rendered foot vertex.
 * @param {object} hero   HeroBot / remote avatar (needs group, footL, footR)
 * @param {(x:number,z:number)=>number|null} [surfaceAt]  surface height under a world point
 * @returns {{minY:number,maxY:number,count:number,maxPenetration:number,worst:object|null}}
 */
export function auditFeet(hero, surfaceAt = () => 0) {
  const group = hero.group;
  if (!group) return { minY: Infinity, maxY: -Infinity, count: 0, maxPenetration: 0, worst: null };
  group.updateMatrixWorld(true);
  const bones = footBoneSet(hero);
  const seen = new Set();
  let minY = Infinity, maxY = -Infinity, count = 0, maxPenetration = 0, worst = null;

  const visit = (mesh, indices) => {
    if (!indices.length) return;
    if (mesh.isSkinnedMesh && mesh.skeleton) mesh.skeleton.update();
    for (const i of indices) {
      mesh.getVertexPosition(i, _v);
      _v.applyMatrix4(mesh.matrixWorld);
      count++;
      if (_v.y < minY) minY = _v.y;
      if (_v.y > maxY) maxY = _v.y;
      const s = surfaceAt(_v.x, _v.z);
      if (s == null) continue;
      const pen = s - _v.y;
      if (pen > maxPenetration) {
        maxPenetration = pen;
        worst = { x: _v.x, y: _v.y, z: _v.z, surface: s, penetration: pen };
      }
    }
  };

  // 1. Skinned body: only vertices driven by the foot / toe chain.
  group.traverse(o => {
    if (!o.isSkinnedMesh || seen.has(o)) return;
    seen.add(o);
    visit(o, footVertexIndices(o, bones));
  });

  // 2. Rigid meshes parented to the foot bones / procedural boot groups (extras, sole details).
  //    Procedural rigs have no separate foot object — the boot is a child of the leg group.
  const rigidRoots = [hero.footL, hero.footR].filter(Boolean);
  if (!rigidRoots.length) for (const r of [hero.legL, hero.legR]) if (r) rigidRoots.push(r);
  for (const b of rigidRoots) {
    b.traverse(o => {
      if (!o.isMesh || o.isSkinnedMesh || seen.has(o)) return;
      seen.add(o);
      const pos = o.geometry && o.geometry.attributes.position;
      if (!pos) return;
      const idx = [];
      for (let i = 0; i < pos.count; i++) idx.push(i);
      visit(o, idx);
    });
  }

  return { minY, maxY, count, maxPenetration, worst };
}
