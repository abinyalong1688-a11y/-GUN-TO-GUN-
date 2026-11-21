// make_test_rig.mjs — generate PLACEHOLDER rigged humanoids (male / female) as GLB.
// Purpose: validate the whole GLB character pipeline (preload → bone mapping → procedural
// bone animation → portraits clone → single-file embedding) BEFORE the real Tripo models
// arrive in stage 1. These are deliberately simple rigid-segment dummies; the real models
// replace these files one-for-one (same paths, same bone naming scheme).
//
// Rig spec (what modelAssets.js expects from any rig, Tripo included):
//   · humanoid skeleton, bones named with recognisable keywords (hips/spine/chest/neck/head,
//     upperArm_L/R, lowerArm_L/R, hand_L/R, thigh_L/R, calf_L/R, foot_L/R, ponytail);
//   · faces +Z, feet on the ground, roughly 1.8 m (male) / 1.75 m (female);
//   · skinning on every mesh (here: rigid 100% weight per segment).
//
// Run: node scripts/make_test_rig.mjs   → writes assets/characters/male.glb + female.glb
import * as THREE from 'three';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
import {writeFileSync,mkdirSync} from 'fs';
import {dirname,join} from 'path';
import {fileURLToPath} from 'url';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
const OUT=join(ROOT,'assets','characters');

// GLTFExporter's binary path uses FileReader; Node has no FileReader — minimal polyfill
globalThis.FileReader=class{
  readAsArrayBuffer(blob){
    blob.arrayBuffer().then(buf=>{
      this.result=buf;
      const ev={target:this};
      this.onloadend&&this.onloadend(ev);
      this.onload&&this.onload(ev);
    });
  }
};

/* One rigid segment: primitive geometry authored in rest-pose world space, weighted 100% to one bone */
function segment(boneIndex,geo,color){
  const n=geo.attributes.position.count;
  const skinIndex=new Float32Array(n*4),skinWeight=new Float32Array(n*4);
  for(let i=0;i<n;i++){
    skinIndex[i*4]=boneIndex;skinWeight[i*4]=1;
  }
  geo.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(skinIndex,4));
  geo.setAttribute('skinWeight',new THREE.Float32BufferAttribute(skinWeight,4));
  const col=new Float32Array(n*3);
  const c=new THREE.Color(color);
  for(let i=0;i<n;i++){col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;}
  geo.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  return geo;
}

/* Cylinder segment between two rest-pose points, axis aligned to the bone chain direction */
function limbGeo(a,b,r1,r2,color){
  const dir=new THREE.Vector3().subVectors(b,a);
  const len=dir.length();
  const g=new THREE.CylinderGeometry(r2,r1,len,10);
  const q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir.clone().normalize());
  const mid=new THREE.Vector3().addVectors(a,b).multiplyScalar(.5);
  g.applyMatrix4(new THREE.Matrix4().compose(mid,q,new THREE.Vector3(1,1,1)));
  return segment(0,g,color);
}

/* Primitive placed at rest-pose world position: scale FIRST, then translate (scale would otherwise
   also rescale the translation — the classic order bug that pushed the head up to 1.93 m) */
function place(geo,sx,sy,sz,x,y,z){
  if(sx!==1||sy!==1||sz!==1)geo.scale(sx,sy,sz);
  geo.translate(x,y,z);
  return geo;
}

/* Humanoid builder. p: proportions + colours. Returns group facing +Z, feet on ground */
function buildRig(p){
  const group=new THREE.Group();
  const bones=[];
  const bone=(name,parent,x,y,z)=>{
    const b=new THREE.Bone();b.name=name;b.position.set(x,y,z);
    parent.add(b);bones.push(b);return b;
  };
  const hips=bone('hips',group,0,p.hipY,0);
  const spine=bone('spine',hips,0,.13,0);
  const chest=bone('chest',spine,0,.16,0);
  const neck=bone('neck',chest,0,.20,0);
  const head=bone('head',neck,0,.07,0);
  const pony=bone('ponytail',head,0,-.02,-.11);
  // A-pose arms: shoulder → elbow down-outward → wrist (shoulder = chest + (.12 up))
  const shX=p.shoulderX;
  const armR=bone('upperArm_R',chest,shX,.12,0);
  const foreR=bone('lowerArm_R',armR,p.foreDX,-p.foreDY,0);
  const handR=bone('hand_R',foreR,p.handDX,-p.handDY,0);
  const armL=bone('upperArm_L',chest,-shX,.12,0);
  const foreL=bone('lowerArm_L',armL,-p.foreDX,-p.foreDY,0);
  const handL=bone('hand_L',foreL,-p.handDX,-p.handDY,0);
  // Legs
  const thighR=bone('thigh_R',hips,p.hipX,-.06,0);
  const calfR=bone('calf_R',thighR,0,-p.thigh,0);
  const footR=bone('foot_R',calfR,0,-p.shin,0);
  const thighL=bone('thigh_L',hips,-p.hipX,-.06,0);
  const calfL=bone('calf_L',thighL,0,-p.thigh,0);
  const footL=bone('foot_L',calfL,0,-p.shin,0);

  const idx=Object.fromEntries(bones.map((b,i)=>[b.name,i]));
  const V3=(x,y,z)=>new THREE.Vector3(x,y,z);
  const wPos=b=>{ // rest-pose world position (group at origin)
    const v=new THREE.Vector3();b.updateWorldMatrix(true,false);v.setFromMatrixPosition(b.matrixWorld);return v;
  };
  group.updateMatrixWorld(true);

  const {torsoC,pantsC,bootC,skinC,hairC,gloveC,sleeveC}=p;
  const geos=[];
  const hipP=wPos(hips),spineTop=wPos(chest),neckP=wPos(neck);

  // Torso: lower section (hips→chest, bound spine) + upper section (chest→neck, bound chest)
  geos.push(segment(idx.spine,place(new THREE.CylinderGeometry(p.chestR,p.waistR,spineTop.y-hipP.y+.08,12),1,1,p.depth,0,(hipP.y-.02+spineTop.y+.04)/2,0),torsoC));
  geos.push(segment(idx.chest,place(new THREE.CylinderGeometry(p.shoulderR,p.chestR,neckP.y+.06-spineTop.y,12),1,1,p.depth,0,(spineTop.y-.02+neckP.y+.04)/2,0),torsoC));
  // Shoulder pads sit ON the arm bones (bound chest)
  for(const s of[-1,1]){
    const A=wPos(s>0?armR:armL);
    geos.push(segment(idx.chest,place(new THREE.SphereGeometry(p.armR*.95,10,8),1,.85,1,A.x,A.y+.02,A.z),torsoC));
  }
  // Arms: sleeve (upperArm) + forearm (skin) + glove hand
  const armSeg=(armB,foreB,handB)=>{
    const A=wPos(armB),B=wPos(foreB),C=wPos(handB);
    geos.push(segment(idx[armB.name],limbGeo(A,B,p.armR,p.armR*.86,sleeveC),0));
    geos.push(segment(idx[foreB.name],limbGeo(B,C,p.armR*.72,p.armR*.6,skinC),0));
    geos.push(segment(idx[handB.name],place(new THREE.SphereGeometry(p.armR*.72,10,8),.9,1.15,.8,C.x,C.y,C.z),gloveC));
  };
  armSeg(armR,foreR,handR);armSeg(armL,foreL,handL);
  // Legs: thigh + calf (pants) + boot box + toe cap (foot bone; boot bottom flush with ground)
  const legSeg=(thighB,calfB,footB)=>{
    const A=wPos(thighB),B=wPos(calfB),C=wPos(footB);
    geos.push(segment(idx[thighB.name],limbGeo(A,B,p.thighR,p.kneeR,pantsC),0));
    geos.push(segment(idx[calfB.name],limbGeo(B,C,p.kneeR,p.kneeR*.82,pantsC),0));
    geos.push(segment(idx[footB.name],place(new THREE.BoxGeometry(p.footW,p.footH,p.footD),1,1,1,C.x,p.footH*.5+.004,C.z+p.footD*.12),bootC));
    geos.push(segment(idx[footB.name],place(new THREE.SphereGeometry(p.footW*.5,8,6),1,.75,1,C.x,p.footH*.4,C.z+p.footD*.62),bootC));
  };
  legSeg(thighR,calfR,footR);legSeg(thighL,calfL,footL);
  // Pelvis (hips)
  geos.push(segment(idx.hips,place(new THREE.SphereGeometry(p.waistR,12,10),1,.8,p.depth,0,hipP.y+.01,0),pantsC));
  // Head: skull + nose (+Z orientation cue) + eyes + hair cap; head centre = head bone + headDY
  const headC=wPos(head).add(V3(0,p.headDY,0));
  geos.push(segment(idx.head,place(new THREE.SphereGeometry(p.headR,16,14),.95,1.08,1,headC.x,headC.y,headC.z),skinC));
  geos.push(segment(idx.head,place(new THREE.SphereGeometry(p.headR*.14,8,6),1,1,1,headC.x,headC.y-p.headR*.15,headC.z+p.headR*.92),skinC));
  for(const s of[-1,1])
    geos.push(segment(idx.head,place(new THREE.SphereGeometry(p.headR*.11,8,6),1,1,1,headC.x+s*p.headR*.4,headC.y+p.headR*.1,headC.z+p.headR*.8),0x1a1a1a));
  geos.push(segment(idx.head,place(new THREE.SphereGeometry(p.headR*1.04,14,12,0,Math.PI*2,0,Math.PI*.55),.97,1.06,.98,headC.x,headC.y,headC.z),hairC));
  // Ponytail: chain of tapering segments hanging back-down from the ponytail bone
  if(p.pony){
    let prev=wPos(pony);
    for(let i=0;i<p.pony;i++){
      const next=prev.clone().add(V3(0,-.055,.012));
      const r=Math.max(.036*(1-i/p.pony*.65),.012);
      geos.push(segment(idx.ponytail,limbGeo(prev,next,r,r*.86,hairC),0));
      prev=next;
    }
  }

  // One vertex-colour material for the whole dummy (mimics Tripo single baked material)
  const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.65,metalness:.05});
  const meshes=geos.map(g=>{
    const m=new THREE.SkinnedMesh(g,mat);
    m.castShadow=true;m.frustumCulled=false;
    return m;
  });
  // Bind all meshes to one skeleton; geometry is authored in rest-pose world space, group at origin
  const skeleton=new THREE.Skeleton(bones);
  group.updateMatrixWorld(true);
  for(const m of meshes){group.add(m);m.bind(skeleton);}
  return group;
}

const MALE={
  hipY:1.0,shoulderX:.20,foreDX:.10,foreDY:.17,handDX:.05,handDY:.13,
  hipX:.105,thigh:.44,shin:.42,chestR:.135,waistR:.115,shoulderR:.16,depth:.72,
  armR:.052,thighR:.082,kneeR:.056,footW:.095,footH:.09,footD:.215,footZ:.035,
  headR:.108,headDY:.115,pony:0,
  torsoC:0x7e2620,pantsC:0x2f2c2c,bootC:0x1a1815,skinC:0xdfab8c,hairC:0x1a130e,gloveC:0x3a3733,sleeveC:0x7e2620,
};
const FEMALE={
  ...MALE,
  hipY:.975,shoulderX:.17,foreDX:.085,foreDY:.15,handDX:.045,handDY:.115,
  hipX:.09,thigh:.42,shin:.40,chestR:.12,waistR:.098,shoulderR:.135,depth:.7,
  armR:.043,thighR:.068,kneeR:.048,footW:.082,footH:.082,footD:.2,footZ:.03,
  headR:.1,headDY:.11,pony:4,
  torsoC:0x39465c,pantsC:0x2a313e,skinC:0xf3d0b8,hairC:0x3a2418,gloveC:0x2c3138,sleeveC:0x39465c,
};

function exportRig(p,file){
  const group=buildRig(p);
  const exporter=new GLTFExporter();
  exporter.parse(group,gltf=>{
    const buf=new Uint8Array(gltf);
    writeFileSync(join(OUT,file),Buffer.from(buf));
    const box=new THREE.Box3().setFromObject(group);
    console.log(`✓ ${file}  ${(buf.length/1024).toFixed(0)} KB  height=${(box.max.y-box.min.y).toFixed(2)}m`);
  },err=>{
    console.error(`✗ ${file}:`,err);process.exit(1);
  },{binary:true});
}

mkdirSync(OUT,{recursive:true});
exportRig(MALE,'male.glb');
exportRig(FEMALE,'female.glb');
