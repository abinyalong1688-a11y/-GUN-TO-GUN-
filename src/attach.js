// attach.js — attachment integrity: a weapon is one assembly, not a cloud of parts.
//
// Every mesh of a weapon model is grouped by AABB contact (transitive): touching boxes weld
// two parts into the same island. A weapon is healthy when it is ONE island — any extra
// island is an accessory that floats off the gun body (a scope with no riser, a butt plate
// hovering behind the stock, a front sight above the barrel...).
//
// Used by tests/weapon-attach.test.mjs (unit report) and the ?e2e=1 in-browser assertion.
// First-person arms are marked userData.fpArm and excluded: they deliberately reach in from
// off-screen and are not gun parts. The magazine is checked in its rest pose — the reload
// animation pulls it out on purpose.
import * as THREE from 'three';

function meshBox(mesh,rootInv){
  const g=mesh.geometry;
  if(!g.boundingBox)g.computeBoundingBox();
  return new THREE.Box3().copy(g.boundingBox).applyMatrix4(mesh.matrixWorld).applyMatrix4(rootInv);
}

function gap(a,b){
  const dx=Math.max(0,a.min.x-b.max.x,b.min.x-a.max.x);
  const dy=Math.max(0,a.min.y-b.max.y,b.min.y-a.max.y);
  const dz=Math.max(0,a.min.z-b.max.z,b.min.z-a.max.z);
  return Math.hypot(dx,dy,dz);
}

/* Meshes that make up the gun itself (first-person arms excluded) */
export function gunMeshes(root){
  const out=[];
  root.traverse(o=>{if(o.isMesh&&!o.userData.fpArm)out.push(o);});
  return out;
}

/* Connected components under AABB contact (tol in metres).
   Returns {ok, count, meshes, islands:[{count, gap, center, size}]} — islands are sorted
   biggest first, so islands[0] is the receiver assembly and `gap` is the clearance of every
   other island to it. `size`/`center` are in the model's local frame. */
export function attachmentIslands(root,tol=.003){
  root.updateWorldMatrix(true,true);
  const inv=new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes=gunMeshes(root);
  const boxes=meshes.map(m=>meshBox(m,inv));
  const parent=meshes.map((_,i)=>i);
  const find=i=>parent[i]===i?i:(parent[i]=find(parent[i]));
  const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent[a]=b;};
  for(let i=0;i<meshes.length;i++)
    for(let j=i+1;j<meshes.length;j++)
      if(gap(boxes[i],boxes[j])<=tol)uni(i,j);
  const groups=new Map();
  for(let i=0;i<meshes.length;i++){
    const r=find(i);
    if(!groups.has(r))groups.set(r,[]);
    groups.get(r).push(i);
  }
  const raw=[...groups.values()].map(idx=>{
    const b=new THREE.Box3();
    for(const i of idx)b.union(boxes[i]);
    return {idx,box:b};
  }).sort((a,b)=>b.idx.length-a.idx.length);
  const main=raw[0];
  const islands=raw.map((is,k)=>{
    let g=0;
    if(k>0){
      g=Infinity;
      for(const i of is.idx)for(const j of main.idx)g=Math.min(g,gap(boxes[i],boxes[j]));
    }
    return {
      count:is.idx.length,
      gap:g,
      center:is.box.getCenter(new THREE.Vector3()),
      size:is.box.getSize(new THREE.Vector3()),
    };
  });
  return {ok:raw.length===1,count:raw.length,meshes:meshes.length,islands};
}

/* Human-readable failure report (mm + local coordinates) for test/log output */
export function attachReport(report){
  return report.islands.slice(1).map((is,i)=>
    `island ${i+1}: ${is.count} mesh(es), gap ${(is.gap*1000).toFixed(1)}mm, `+
    `center ${is.center.x.toFixed(3)},${is.center.y.toFixed(3)},${is.center.z.toFixed(3)}, `+
    `size ${is.size.x.toFixed(3)}x${is.size.y.toFixed(3)}x${is.size.z.toFixed(3)}`
  ).join('\n');
}
