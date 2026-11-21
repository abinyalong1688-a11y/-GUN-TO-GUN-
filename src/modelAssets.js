// modelAssets.js — GLB character asset pipeline (AI-generated rigged models):
//   preloadCharacters()  start loading male/female GLB once at boot; embedded data URLs in
//                        the single-file build (window.__GTG_GLB__), relative fetch in dev.
//   cloneCharacter(g)    instance a normalized template via SkeletonUtils.clone, with
//                        per-instance cloned materials (hit flash / corpse fade stay independent).
//   mode()               'gltf' when models are ready and not forced off → character.js
//                        dispatches to the GLB builder; any failure silently falls back to
//                        the procedural builder (?model=proc forces it, ?model=gltf forces on).
//
// Rig requirements (documented in scripts/make_test_rig.mjs, same contract as Tripo output):
//   · humanoid skeleton with recognisable bone keywords (hips / spine / chest / neck / head /
//     upperArm · lowerArm · hand · thigh · calf · foot + optional ponytail), any naming style
//     (upperArm_L, LeftArm, arm_l, mixamorig:LeftArm …) — resolved by ALIAS matching below;
//   · any bind orientation / scale — corrected at load: model is re-oriented to face +Z,
//     rescaled to the operator height, feet placed on y=0 (per guizang skill: measure, never assume).
// Each mapped bone records its bind-pose euler in userData.restE — HeroBot adds animation
// deltas on top of it, so rigs with non-identity rest rotations still animate correctly.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/* ---- mode switch (?model=proc|gltf; default auto: gltf when ready, proc as fallback) ---- */
let forced='auto';
if(typeof location!=='undefined'){
  const q=new URLSearchParams(location.search).get('model');
  if(q==='proc'||q==='gltf')forced=q;
}

/* ---- load state ---- */
const state={
  ready:false,failed:false,loading:false,
  models:{},                 // gender → {root,bones,headY,profile}
  onReadyCbs:[],
};

export const modelAssets={
  mode(){
    if(forced==='proc')return 'proc';
    return state.ready?'gltf':'proc';
  },
  isReady(){return state.ready;},
  error(){return state.error||null;},
  onReady(cb){state.ready?cb():state.onReadyCbs.push(cb);},
  cloneCharacter(gender){
    const m=state.models[gender==='f'?'female':'male'];
    if(!m)throw new Error(`[modelAssets] model not loaded: ${gender}`);
    return cloneInstance(m);
  },
  debug(){ // console helper: dump bone mapping (?model=gltf + this in devtools)
    for(const g of Object.keys(state.models)){
      const m=state.models[g];
      console.table(Object.entries(m.bones).map(([k,b])=>({slot:k,bone:b.name,y:b.getWorldPosition(new THREE.Vector3()).y.toFixed(2)})));
    }
  },
};

/* ---- GLB sources: embedded (single-file build) → dev fetch fallback ---- */
function glbSource(gender){
  const embedded=(typeof window!=='undefined')&&window.__GTG_GLB__&&window.__GTG_GLB__[gender];
  if(embedded)return Promise.resolve(embedded);
  return Promise.resolve(`assets/characters/${gender}.glb`);
}
function toArrayBuffer(src){
  if(src.startsWith('data:')){
    const b64=src.slice(src.indexOf(',')+1);
    const bin=atob(b64);
    const buf=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)buf[i]=bin.charCodeAt(i);
    return Promise.resolve(buf.buffer);
  }
  return fetch(src).then(r=>{
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  });
}
/* One loader, meshopt-capable: compressed GLBs (EXT_meshopt_compression) need the decoder.
   Cache the SETUP PROMISE, not the instance — male/female load concurrently and the second
   caller must not get an instance whose setMeshoptDecoder() hasn't run yet. */
let _loaderP=null;
function loader(){
  if(!_loaderP){
    _loaderP=(async()=>{
      const l=new GLTFLoader();
      try{
        await MeshoptDecoder.ready;
        l.setMeshoptDecoder(MeshoptDecoder);
      }catch(e){
        state.error='meshopt decoder init failed: '+String((e&&e.message)||e);
      }
      return l;
    })();
  }
  return _loaderP;
}

export function preloadCharacters(){
  if(state.loading||state.ready)return;
  state.loading=true;
  const load=async gender=>{
    const buf=await toArrayBuffer(await glbSource(gender));
    const l=await loader();
    const gltf=await new Promise((res,rej)=>l.parse(buf,'',gltf=>res(gltf),rej));
    state.models[gender]=normalizeTemplate(gender,gltf.scene);
  };
  Promise.all([load('male'),load('female')])
    .then(()=>{
      state.ready=true;state.loading=false;
      console.log(`[modelAssets] GLB characters ready (${Object.keys(state.models).join(', ')})`);
      for(const cb of state.onReadyCbs)cb();
      state.onReadyCbs.length=0;
    })
    .catch(err=>{
      state.failed=true;state.loading=false;state.ready=false;
      state.error=String((err&&err.message)||err);
      console.warn('[modelAssets] GLB load failed — staying on procedural characters:',err);
    });
}

/* ---- bone name resolution: normalized keyword matching, any naming convention ---- */
const norm=n=>n.toLowerCase().replace(/[^a-z0-9]/g,'');
const SLOT_RULES=[
  {slot:'pony', re:/ponytail|pony|hairback|hairb/},
  {slot:'head', re:/head/},
  {slot:'neck', re:/neck/},
  {slot:'forearm', re:/lowerarm|forearm|elbow/},
  {slot:'upperarm', re:/upperarm|uparm|shoulder|clavicle|arm/},
  {slot:'hand', re:/hand|wrist|palm/},
  {slot:'calf', re:/calf|lowerleg|shin|knee/},
  {slot:'thigh', re:/thigh|upleg|upperleg|leg|femur/},
  {slot:'foot', re:/foot|ankle|toe|ball/},
  {slot:'spine', re:/spine|chest|torso|body/},
  {slot:'hips', re:/hips|pelvis|root/},
];
function classify(name){
  const n=norm(name);
  for(const {slot,re} of SLOT_RULES){
    if(re.test(n))return slot;
  }
  return null;
}
function boneSide(name){
  const n=norm(name);
  if(/left/.test(n))return -1;
  if(/right/.test(n))return 1;
  if(/(^|[^a-z])l($|[0-9])/.test(n)||/l$/.test(n))return -1;
  if(/(^|[^a-z])r($|[0-9])/.test(n)||/r$/.test(n))return 1;
  return 0;
}

/* ---- per-gender rig profile: hold pose / attachment anchors (tuned against ?portraits) ---- */
const PROFILES={
  male:{
    height:1.80,headDY:.115,headR:.108,
    hold:{armR:{x:-1.05,y:-.1,z:-.25},foreR:{x:-.75,y:0,z:0},armL:{x:-1.05,y:.55,z:1.0},foreL:{x:-.9,y:0,z:0}},
    rifle:{pos:[0,-.11,.06],rot:[1.7,0,0],scale:1},
  },
  female:{
    height:1.75,headDY:.11,headR:.1,
    hold:{armR:{x:-1.0,y:-.1,z:-.25},foreR:{x:-.7,y:0,z:0},armL:{x:-1.0,y:.55,z:.95},foreL:{x:-.85,y:0,z:0}},
    rifle:{pos:[0,-.1,.05],rot:[1.65,0,0],scale:.94},
  },
};

/* Load-time normalisation: orientation → scale → ground → bone map → rest pose → hold pose */
function normalizeTemplate(gender,scene){
  const profile=PROFILES[gender]||PROFILES.male;
  const wrapper=new THREE.Group();
  wrapper.name=`char_${gender}`;
  wrapper.add(scene);

  // 1. Orientation: derive facing from the two thigh bones (never assume the exporter's convention)
  scene.updateMatrixWorld(true);
  const bones=[];
  scene.traverse(o=>{if(o.isBone||o.isObject3D&&o.type==='Bone')bones.push(o);});
  if(!bones.length){ // unrigged mesh — still usable as a static dummy, but flag it
    console.warn('[modelAssets] no bones found in',gender);
  }
  const find=(slot,side)=>{
    for(const b of bones){
      if(classify(b.name)===slot&&(side===0||boneSide(b.name)===side||boneSide(b.name)===0&&side!==0&&bonesWithSide(slot,bones).length<2))return b;
    }
    return null;
  };
  const bonesWithSide=(slot,list)=>list.filter(b=>classify(b.name)===slot&&boneSide(b.name)!==0);
  const tR=find('thigh',1),tL=find('thigh',-1);
  if(tR&&tL){
    const pR=new THREE.Vector3(),pL=new THREE.Vector3();
    tR.getWorldPosition(pR);tL.getWorldPosition(pL);
    const right=pR.sub(pL);right.y=0;
    if(right.lengthSq()>1e-6){
      const fwd=new THREE.Vector3().crossVectors(right,new THREE.Vector3(0,1,0)).normalize();
      wrapper.rotation.y=-Math.atan2(fwd.x,fwd.z);
    }
  }
  scene.updateMatrixWorld(true);

  // 2. Scale to operator height, 3. feet on the ground
  const box=new THREE.Box3().setFromObject(wrapper);
  const h=box.max.y-box.min.y;
  if(h>1e-3){
    const s=profile.height/h;
    wrapper.scale.setScalar(s);
    wrapper.updateMatrixWorld(true);
    const box2=new THREE.Box3().setFromObject(wrapper);
    wrapper.position.y=-box2.min.y;
  }
  wrapper.updateMatrixWorld(true);

  // 4. Bone map for the animation contract (spine chain: first = spine, last = chest)
  const pick=(slot,side)=>{
    let best=null;
    for(const b of bones){
      if(classify(b.name)!==slot)continue;
      const s=boneSide(b.name);
      if(side!==0&&s!==0&&s!==side)continue;
      if(side!==0&&s===0&&best)continue; // keep the first side-annotated candidate
      if(!best)best=b;
    }
    return best;
  };
  const spines=bones.filter(b=>classify(b.name)==='spine');
  const map={
    hips:pick('hips',0),
    spine:spines[0]||null,
    chest:spines.length>1?spines[spines.length-1]:(spines[0]||null),
    neck:pick('neck',0),
    head:pick('head',0),
    pony:find('pony',0),
    armR:pick('upperarm',1),armL:pick('upperarm',-1),
    foreR:pick('forearm',1),foreL:pick('forearm',-1),
    handR:pick('hand',1),handL:pick('hand',-1),
    legR:pick('thigh',1),legL:pick('thigh',-1),
    calfR:pick('calf',1),calfL:pick('calf',-1),
    footR:pick('foot',1),footL:pick('foot',-1),
  };
  if(!map.head||!map.legR)console.warn('[modelAssets] bone mapping incomplete for',gender,map);

  // 5. Rest pose: bind-pose euler + local position per mapped bone (animation deltas stack on top)
  for(const b of Object.values(map)){
    if(b){
      b.userData.restE={x:b.rotation.x,y:b.rotation.y,z:b.rotation.z};
      b.userData.restP=b.position.clone();
    }
  }

  // 6. Rifle-hold base pose (baseArmR/L in HeroBot capture these; recoil/reload layer on top)
  const H=profile.hold;
  for(const [key,bone] of [['armR',map.armR],['foreR',map.foreR],['armL',map.armL],['foreL',map.foreL]]){
    if(bone&&H[key])bone.rotation.set(H[key].x,H[key].y,H[key].z);
  }

  // 7. Head centre anchor (headgear / face attachments pivot around the skull centre)
  let headY=profile.height-.13;
  if(map.head){
    const hp=new THREE.Vector3();map.head.getWorldPosition(hp);
    headY=hp.y+profile.headDY;
    const anchor=new THREE.Group();
    anchor.name='headAnchor';
    anchor.position.set(0,profile.headDY,0);
    map.head.add(anchor);
    map.headAnchor=anchor;
  }

  wrapper.updateMatrixWorld(true);
  const inst={root:wrapper,bones:map,headY,profile};
  inst.clone=()=>cloneInstance(inst);
  return inst;
}

/* ---- instance: SkeletonUtils.clone + per-instance material clones ---- */
function cloneInstance(inst){
  const root=SkeletonUtils.clone(inst.root);
  // Map bones by name (names survive the clone)
  const map={};
  root.traverse(o=>{if(o.isBone)map[o.name]=o;});
  const bones={};
  for(const [slot,b] of Object.entries(inst.bones)){
    if(b instanceof THREE.Object3D)bones[slot]=map[b.name]||null;
  }
  bones.headAnchor=root.getObjectByName('headAnchor')||null;
  // Per-instance material clones: textures stay shared (GPU memory once), colours flash/fade independently
  const materials=[];
  const seen=new Map();
  root.traverse(o=>{
    if(!o.isMesh&&!o.isSkinnedMesh)return;
    const assign=m=>{
      let c=seen.get(m);
      if(!c){c=m.clone();seen.set(m,c);materials.push(c);}
      o.material=c;
    };
    Array.isArray(o.material)?o.material.forEach(assign):assign(o.material);
  });
  return {root,bones,materials,headY:inst.headY,profile:inst.profile};
}
