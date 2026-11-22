// rig.js — pose layer shared by procedural part Groups and GLB rig bones.
//   Every animation delta is expressed in CHARACTER space (the bot group's frame: +Z forward,
//   +Y up; x = pitch, y = yaw, z = roll; offsets in metres) on top of the part's rest pose.
//
//   · Procedural parts are direct children of the character group, so character space IS their
//     parent space: rest = build-time euler / position, deltas add to the euler (legacy behaviour).
//   · GLB bones have arbitrary local frames (Tripo: Root is rotated -90° about X, every bone has its
//     own roll), so writing rotation.x there rotates around a meaningless axis. modelAssets.js
//     precomputes, per mapped bone, the character axes expressed in the bone's local rest frame
//     (userData.rig.ax) and the character unit translations in the parent's local frame (rig.px);
//     a delta rotation about character axis A is then  local = restQ · Q(axLocal, θ).
import * as THREE from 'three';

const _q=new THREE.Quaternion();

/* Capture the rest pose of a procedural part (no-op for rig bones, whose rest comes from the template) */
export function rigInit(o){
  if(!o||o.userData.rig)return;
  if(!o.userData.restR)o.userData.restR={x:o.rotation.x,y:o.rotation.y,z:o.rotation.z};
  if(!o.userData.restT)o.userData.restT=o.position.clone();
}

/* Rotation = rest pose + character-space deltas (radians) */
export function poseRot(o,dx=0,dy=0,dz=0){
  if(!o)return;
  const r=o.userData.rig;
  if(r){
    o.quaternion.copy(r.restQ);
    if(dx)o.quaternion.multiply(_q.setFromAxisAngle(r.ax[0],dx));
    if(dy)o.quaternion.multiply(_q.setFromAxisAngle(r.ax[1],dy));
    if(dz)o.quaternion.multiply(_q.setFromAxisAngle(r.ax[2],dz));
    return;
  }
  rigInit(o);
  const b=o.userData.restR;
  o.rotation.set(b.x+dx,b.y+dy,b.z+dz);
}

/* Position = rest position + character-space offset (metres) */
export function posePos(o,dx=0,dy=0,dz=0){
  if(!o)return;
  const r=o.userData.rig;
  if(r){
    o.position.copy(r.restP);
    if(dx)o.position.addScaledVector(r.px[0],dx);
    if(dy)o.position.addScaledVector(r.px[1],dy);
    if(dz)o.position.addScaledVector(r.px[2],dz);
    return;
  }
  rigInit(o);
  const b=o.userData.restT;
  o.position.set(b.x+dx,b.y+dy,b.z+dz);
}

/* Back to the rest pose (respawn) */
export function poseReset(o){poseRot(o);posePos(o);}
