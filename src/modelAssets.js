// modelAssets.js — GLB character asset pipeline (rigged models):
//   preloadCharacters()  start loading the shared rigs once at boot; inert data-URL tags in
//                        the single-file build (window.__GTG_GLB__ legacy), relative fetch in dev.
//   cloneCharacter(g)    instance a normalized template via SkeletonUtils.clone, with
//                        per-instance cloned materials (hit flash / corpse fade stay independent).
//   mode()               'gltf' when models are ready and not forced off → character.js
//                        dispatches to the GLB builder; any failure silently falls back to
//                        the procedural builder (?model=proc forces it, ?model=gltf forces on).
//
// Rig requirements (documented in scripts/make_test_rig.mjs, same contract as the production rigs):
//   · humanoid skeleton with recognisable bone keywords (hips / spine / chest / neck / head /
//     upperArm · lowerArm · hand · thigh · calf · foot + optional ponytail), any naming style
//     (upperArm_L, LeftArm, arm_l, mixamorig:LeftArm …) — resolved by ALIAS matching below;
//   · any bind orientation / scale — corrected at load: model is re-oriented to face +Z,
//     rescaled to the operator height, feet placed on y=0 (measure, never assume).
// Each mapped bone carries userData.rig (rest quaternion + character-space axes in its local
// frame) — rig.js stacks animation deltas on it, whatever the rig's local axis conventions.
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
  models:{},                 // shared model key → {root,bones,headY,profile}
  props:{},                  // 'helmet_m' / 'helmet_f' → normalized rigid template (optional)
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
  cloneCharacter(key){
    const m=state.models[key]||state.models[MODEL_MAP[key]]||state.models[MODEL_KEYS[0]];
    if(!m)throw new Error(`[modelAssets] model not loaded: ${key}`);
    return cloneInstance(m);
  },
  /* opId → shared rig key for that operator's faction + gender */
  modelFor(opId){return MODEL_MAP[opId]||MODEL_KEYS[0];},
  template(key){return state.models[key]||null;}, // dev: inspect the pre-clone template
  debug(){ // console helper: dump bone mapping (?model=gltf + this in devtools)
    for(const g of Object.keys(state.models)){
      const m=state.models[g];
      console.table(Object.entries(m.bones).filter(([,b])=>b).map(([k,b])=>({slot:k,bone:b.name,y:b.getWorldPosition(new THREE.Vector3()).y.toFixed(2)})));
    }
  },
};

/* ---- GLB sources: inert embedded tags (single-file build) → legacy global → dev fetch ----
   The build writes each shared rig into its own <script type="application/octet-stream"> tag.
   Reading only the tag we need avoids materialising a multi-megabyte JS object literal at
   parse time, and lets the main bundle start while the payload is still streaming in. */
function glbSource(name){
  if(typeof document!=='undefined'){
    const el=document.getElementById('gtg-glb-'+name);
    if(el&&el.textContent.length>64)return Promise.resolve(el.textContent.trim());
  }
  const legacy=(typeof window!=='undefined')&&window.__GTG_GLB__&&window.__GTG_GLB__[name];
  if(legacy)return Promise.resolve(legacy);
  return Promise.resolve(`assets/characters/${name}.glb`);
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

/* Cross-shared gender pools: 4 rigs, each used once per faction, so all four operators on
   a team have a different silhouette. Team identity now comes from FACTION_PALETTES
   (jacket / armour / cloth / accent), not from which rig a faction owns.
     female pool: female1  → frost (Nova), viper (Rogue)
                  female11 → swift (Nova), fox   (Rogue)
     male   pool: male1    → snowwolf (Nova), vulture (Rogue)
                  male11   → thunder  (Nova), raven   (Rogue)
   Unused source rigs stay in assets/ so the 8-rig build can be restored by changing
   this map + build.mjs SHARED_MODELS. */
const MODEL_KEYS=['female1','male1','male11','female11'];
const MODEL_MAP={
  frost:'female1',swift:'female11',snowwolf:'male1',thunder:'male11',
  raven:'male11',fox:'female11',vulture:'male1',viper:'female1',
};

export function preloadCharacters(){
  if(state.loading||state.ready)return;
  state.loading=true;
  const load=async key=>{
    const buf=await toArrayBuffer(await glbSource(key));
    const l=await loader();
    const gltf=await new Promise((res,rej)=>l.parse(buf,'',gltf=>res(gltf),rej));
    state.models[key]=normalizeTemplate(key,gltf.scene);
  };
  Promise.all(MODEL_KEYS.map(load))
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
  // clavicle before upperarm: "LeftShoulder" / "L_Clavicle" style names are the collarbone —
  // animating it instead of the upper arm hunches the whole shoulder
  {slot:'clavicle', re:/clavicle|shoulder|collar/},
  {slot:'upperarm', re:/upperarm|uparm|arm/},
  {slot:'hand', re:/hand|wrist|palm/},
  {slot:'calf', re:/calf|lowerleg|shin|knee/},
  {slot:'thigh', re:/thigh|upleg|upperleg|leg|femur/},
  {slot:'foot', re:/foot|ankle|toe|ball/},
  {slot:'spine', re:/spine|chest|torso|body/},
  {slot:'hips', re:/hips|pelvis|hip|root/},
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
  // suffix tokens first (lowerarm_r must not be caught by the /^l/ prefix below)
  if(/(^|[^a-z])l($|[0-9])/.test(n)||/l$/.test(n))return -1;
  if(/(^|[^a-z])r($|[0-9])/.test(n)||/r$/.test(n))return 1;
  // game-rig prefixes: L_Thigh → lthigh
  if(/^l/.test(n))return -1;
  if(/^r/.test(n))return 1;
  return 0;
}

/* ---- per-gender rig profile ----
   The production rigs face +X natively → yawFix turns them to the game's +Z (the thigh heuristic misfires
   on staggered stances). Everything below is CHARACTER space (+Z forward, anatomical right hand
   on -X) and solved by two-bone IK at load time, so the pose is independent of every bone's local
   axis convention. headDY/headR are only the fallback when the skull can't be measured.
   Rifle mount = the procedural one (.10,1.20,.16) mirrored onto the anatomical right; hand targets
   are rifle-local grip points (pistol grip ≈ (0,-.075,.02), handguard ≈ (0,-.03,.26)) carried into
   character space, so the hands land ON the weapon. palm = desired palm normal (trigger palm on
   the grip, support palm cupping the handguard); bind-pose palms are assumed to face the thighs
   (A-pose: right palm +X, left palm -X). handR/handL are PALM-centre goals: the IK drives the
   wrist bone, so the solve is iterated until the palm (wrist + palm length along the forearm)
   sits on the goal — the trigger palm against the grip's outer face, the support palm under the
   handguard. */
const HOLD={
  poleR:[-.6,-1,-.25],poleL:[.55,-1,-.1],       // elbows down and out
  palmR:[1,-.15,0],palmL:[-1,.2,.3],
};
const mkProfile=(height,headDY,headR,rifleScale)=>{
  const k=height/1.8,pos=[-.10*k,1.28*k,.16*k];
  const at=(x,y,z)=>[pos[0]+x*rifleScale,pos[1]+y*rifleScale,pos[2]+z*rifleScale];
  return {height,headDY,headR,yawFix:-Math.PI/2,
    hold:{...HOLD,handR:at(-.03,-.03,-.07),handL:at(0,-.005,.16),palmLen:.07*k},
    rifle:{scale:rifleScale,pos}};
};
const PROFILES={
  male:mkProfile(1.80,.075,.076,1),
  female:mkProfile(1.75,.06,.072,.94),
};

const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const wpos=o=>o.getWorldPosition(V());
/* Rotate `bone` (about its own pivot) so its world-space vector `from` lines up with `to` */
function swing(bone,from,to){
  if(from.lengthSq()<1e-10||to.lengthSq()<1e-10)return;
  const dq=new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(),to.clone().normalize());
  const wq=bone.getWorldQuaternion(new THREE.Quaternion());
  const pq=bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(pq.invert().multiply(dq.multiply(wq)));
  bone.updateMatrixWorld(true);
}
/* Analytic two-bone IK (shoulder → elbow → wrist), elbow bent toward `pole` */
function solveTwoBone(upper,fore,hand,target,pole){
  const S=wpos(upper),E=wpos(fore),W=wpos(hand);
  const a=S.distanceTo(E),b=E.distanceTo(W);
  if(a<1e-4||b<1e-4)return;
  const toT=target.clone().sub(S);
  const d=Math.max(1e-4,Math.min(toT.length(),(a+b)*.995));
  const dir=toT.normalize();
  const cosA=Math.max(-1,Math.min(1,(a*a+d*d-b*b)/(2*a*d)));
  const perp=pole.clone().addScaledVector(dir,-pole.dot(dir));
  if(perp.lengthSq()<1e-8)perp.set(0,-1,0);
  perp.normalize();
  const E2=S.clone().addScaledVector(dir,a*cosA).addScaledVector(perp,a*Math.sqrt(1-cosA*cosA));
  swing(upper,E.clone().sub(S),E2.clone().sub(S));
  const E3=wpos(fore),W3=wpos(hand);
  swing(fore,W3.clone().sub(E3),S.clone().addScaledVector(dir,d).sub(E3));
}
/* Roll the hand about the forearm axis until its palm normal (palmLocal, hand-local) faces `want` */
function twistPalm(fore,hand,palmLocal,want){
  const axis=wpos(hand).sub(wpos(fore)).normalize();
  const hq=hand.getWorldQuaternion(new THREE.Quaternion());
  const flat=v=>v.clone().addScaledVector(axis,-v.dot(axis));
  const a=flat(palmLocal.clone().applyQuaternion(hq)),b=flat(want);
  if(a.lengthSq()<1e-8||b.lengthSq()<1e-8)return;
  a.normalize();b.normalize();
  let ang=Math.acos(Math.max(-1,Math.min(1,a.dot(b))));
  if(axis.dot(V().crossVectors(a,b))<0)ang=-ang;
  const dq=new THREE.Quaternion().setFromAxisAngle(axis,ang);
  const pq=hand.parent.getWorldQuaternion(new THREE.Quaternion());
  hand.quaternion.copy(pq.invert().multiply(dq.multiply(hq)));
  hand.updateMatrixWorld(true);
}
/* Skull bounds from the skin: vertices weighted mostly to the head joint, in character space */
function measureHead(scene,head){
  const box=new THREE.Box3();let n=0;
  const v=V();
  scene.traverse(o=>{
    if(!o.isSkinnedMesh||!o.skeleton)return;
    const ji=o.skeleton.bones.indexOf(head);
    if(ji<0)return;
    const g=o.geometry,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;
    if(!si||!sw)return;
    for(let i=0;i<si.count;i++){
      let w=0;
      for(let k=0;k<4;k++)if(si.getComponent(i,k)===ji)w+=sw.getComponent(i,k);
      if(w<.5)continue;
      o.getVertexPosition(i,v);v.applyMatrix4(o.matrixWorld);
      box.expandByPoint(v);n++;
    }
  });
  return n>50?box:null;
}

/* Load-time normalisation: orientation → scale → ground → bone map → hold pose → rest frames.
   Node structure: wrapper (= the bot group, rotation/position owned by the game) →
   orienter (yawFix / scale / ground offset — the game never touches it) → model. */
/* ---- rigid helmet → head-anchor space ----
   Anchor space is the real skull (step 7 measures it per gender): origin at the skull centre,
   +Y up, +Z face. Measured head geometry in that space (male / female): hair-top +.088 / +.085,
   back of skull −.12 / −.20, face front +.09, half-width .095 / .092 incl. ears; the skull widens
   to .09 at y≈−.03 (ear line) and the brow sits at y≈+.03, z≈+.075.
   The helmet props face +X (NVG shroud + face opening verified in orthographic renders), so yaw
   −90° turns them to +Z; the prop is then scaled so its shell half-width is `halfW` and placed
   so its crown sits at `top`, shifted by `cz` front/back. Values below were fitted against the
   head-skin vertex cloud (sweep harness): the shell must clear the hair by a few mm at the
   crown while its front rim stops above the brow — a lower rim covers the eyes.
   helmet_f is the slimmer high-cut shell: same crown, narrower and shifted 4 mm back. */
const HELMET_YAW=-Math.PI/2;
const HELMET_FIT={
  helmet_m:{halfW:.121,top:.118,cz:-.008},
  helmet_f:{halfW:.113,top:.116,cz:-.004},
  // rim stays clear of the face; if a future prop has a much lower rim, raise `top`
};
function normalizeHelmet(name,scene){
  const fit=HELMET_FIT[name]||HELMET_FIT.helmet_m;
  const root=new THREE.Group();
  root.name=name;
  root.add(scene);
  scene.rotation.y=HELMET_YAW;
  root.updateMatrixWorld(true);
  const b=new THREE.Box3().setFromObject(root);
  scene.scale.multiplyScalar(fit.halfW/((b.max.x-b.min.x)/2));
  root.updateMatrixWorld(true);
  b.setFromObject(root);
  scene.position.add(new THREE.Vector3(-(b.min.x+b.max.x)/2,fit.top-b.max.y,fit.cz-(b.min.z+b.max.z)/2));
  scene.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=false;}});
  root.updateMatrixWorld(true);
  return root;
}

function normalizeTemplate(key,scene){
  const profile=key.startsWith('female')?PROFILES.female:PROFILES.male;
  const wrapper=new THREE.Group();
  wrapper.name=`char_${key}`;
  const orienter=new THREE.Group();
  orienter.name='orienter';
  wrapper.add(orienter);
  orienter.add(scene);
  scene.updateMatrixWorld(true);

  // Skeleton nodes: skin joints AND their non-joint ancestors. three.js only flags glTF skin joints
  // as Bones — the rig's real limb nodes (R_Thigh / R_Calf / R_Upperarm / R_Forearm) aren't joints,
  // only their Twist children are. Mapping the twists leaves the child chain behind (rotating
  // ForearmTwist01 bends the sleeve while R_Hand — a child of R_Forearm — stays put: floating hands).
  const inRig=new Set();
  scene.traverse(o=>{
    if(!o.isBone)return;
    for(let p=o;p&&p!==scene&&!p.isMesh;p=p.parent)inRig.add(p);
  });
  const bones=[];
  scene.traverse(o=>{if(inRig.has(o))bones.push(o);}); // parent-first order
  if(!bones.length)console.warn('[modelAssets] no bones found in',key);
  const pick=(slot,side)=>{
    let best=null,bestScore=-Infinity;
    for(const b of bones){
      if(classify(b.name)!==slot)continue;
      const s=boneSide(b.name),nm=norm(b.name);
      if(side!==0&&s!==0&&s!==side)continue;
      // annotated matching side > unannotated; the limb node beats its twist helpers;
      // the rig ROOT loses to Hip/Pelvis
      let score=(side===0)?1:(s===side?2:1);
      if(/twist|roll|helper/.test(nm))score-=1.5;
      if(slot==='hips'&&/root/.test(nm))score-=1;
      if(score>bestScore){bestScore=score;best=b;}
    }
    return best;
  };

  // 1. Orientation: facing from the two thighs, unless the profile pins it
  const tR=pick('thigh',1),tL=pick('thigh',-1);
  if(tR&&tL){
    const right=wpos(tR).sub(wpos(tL));right.y=0;
    if(right.lengthSq()>1e-6){
      const fwd=V().crossVectors(right,V(0,1,0)).normalize();
      orienter.rotation.y=-Math.atan2(fwd.x,fwd.z);
    }
  }
  if(profile.yawFix!=null)orienter.rotation.y=profile.yawFix;
  wrapper.updateMatrixWorld(true);

  // 2. Scale to operator height, 3. feet on the ground — on the ORIENTER
  const box=new THREE.Box3().setFromObject(wrapper,true);
  const h=box.max.y-box.min.y;
  let s=1;
  if(h>1e-3){
    s=profile.height/h;
    orienter.scale.setScalar(s);
    wrapper.updateMatrixWorld(true);
    orienter.position.y=-new THREE.Box3().setFromObject(wrapper,true).min.y;
  }
  wrapper.updateMatrixWorld(true);

  // 4. Bone map for the animation contract (spine chain: first = spine, last = chest)
  const spines=bones.filter(b=>classify(b.name)==='spine'&&!/twist/.test(norm(b.name)));
  const map={
    hips:pick('hips',0),
    spine:spines[0]||null,
    chest:spines.length>1?spines[spines.length-1]:(spines[0]||null),
    neck:pick('neck',0),
    head:pick('head',0),
    pony:pick('pony',0),
    armR:pick('upperarm',1),armL:pick('upperarm',-1),
    foreR:pick('forearm',1),foreL:pick('forearm',-1),
    handR:pick('hand',1),handL:pick('hand',-1),
    legR:pick('thigh',1),legL:pick('thigh',-1),
    calfR:pick('calf',1),calfL:pick('calf',-1),
    footR:pick('foot',1),footL:pick('foot',-1),
  };
  if(!map.head||!map.legR)console.warn('[modelAssets] bone mapping incomplete for',key,map);

  // 5. Rifle-hold pose: two-bone IK to character-space hand targets (scaled to body height)
  const H=profile.hold;
  if(H){
    for(const [up,fore,hand,tgt,pole,palm,bindPalmX] of [
      [map.armR,map.foreR,map.handR,H.handR,H.poleR,H.palmR,1],
      [map.armL,map.foreL,map.handL,H.handL,H.poleL,H.palmL,-1]]){
      if(!up||!fore||!hand)continue;
      // bind-pose palm normal in hand-local space, captured before the arm moves
      const palmLocal=V(bindPalmX,0,0).applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()).invert());
      const goal=V(...tgt),t=goal.clone(),poleV=V(...pole);
      for(let it=0;it<5;it++){
        solveTwoBone(up,fore,hand,t,poleV);
        const w=wpos(hand),palmC=w.clone().add(w.clone().sub(wpos(fore)).normalize().multiplyScalar(H.palmLen));
        const err=goal.clone().sub(palmC);
        if(err.lengthSq()<1e-5)break;
        t.add(err);
      }
      twistPalm(fore,hand,palmLocal,V(...palm));
    }
  }
  wrapper.updateMatrixWorld(true);

  // 6. Rest frames (post-hold): per bone, character axes in its local frame + character unit
  //    translations in its parent's frame — rig.js stacks animation deltas on these
  const rig={};
  const AX=[V(1,0,0),V(0,1,0),V(0,0,1)];
  for(const b of Object.values(map)){
    if(!b||rig[b.name])continue;
    const inv=b.getWorldQuaternion(new THREE.Quaternion()).invert();
    const pinv=new THREE.Matrix4().copy(b.parent.matrixWorld).invert();
    const o0=V().applyMatrix4(pinv);
    rig[b.name]={
      restQ:b.quaternion.clone(),restP:b.position.clone(),
      ax:AX.map(a=>a.clone().applyQuaternion(inv)),
      px:AX.map(a=>a.clone().applyMatrix4(pinv).sub(o0)),
    };
  }

  // 7. Head anchor: skull measured from the head-weighted skin (fallback: profile constants).
  //    The anchor is placed in character space (identity orientation, unit scale) so headgear
  //    built for the procedural skull (centre origin, +Z face) lands upright on the real head.
  let headY=profile.height-.13,headFit=null;
  if(map.head){
    const hp=wpos(map.head);
    const hb=measureHead(scene,map.head);
    let c,scale;
    if(hb){
      // Procedural skull: half-width ≈ .097, face front ≈ +.11 from its centre; the top offset is .10
      // (not the skull's .114) because the baked hair adds height — at .114 helmet brims cover the eyes.
      // Ears widen the measured box ~10 %; hair/ponytail only extends up/back, so anchor on the
      // top and the face front rather than the box centre.
      scale=((hb.max.x-hb.min.x)/2)*.9/.097;
      c=V((hb.min.x+hb.max.x)/2,hb.max.y-.10*scale,hb.max.z-.11*scale);
    }else{
      scale=profile.headR/.105*s;
      c=V(hp.x,hp.y+profile.headDY*s,hp.z);
    }
    headY=c.y;headFit={scale,measured:!!hb,box:hb};
    const anchor=new THREE.Group();
    anchor.name='headAnchor';
    map.head.add(anchor);
    new THREE.Matrix4().copy(map.head.matrixWorld).invert()
      .multiply(new THREE.Matrix4().makeTranslation(c.x,c.y,c.z))
      .decompose(anchor.position,anchor.quaternion,anchor.scale);
    map.headAnchor=anchor;
  }

  wrapper.updateMatrixWorld(true);
  const inst={root:wrapper,bones:map,rig,headY,headFit,profile};
  inst.clone=()=>cloneInstance(inst);
  return inst;
}

/* ---- instance: SkeletonUtils.clone + per-instance material clones ---- */
function cloneInstance(inst){
  const root=SkeletonUtils.clone(inst.root);
  // Map nodes by name (names survive the clone; the limb nodes aren't all Bones)
  const byName={};
  root.traverse(o=>{if(o.name&&!byName[o.name])byName[o.name]=o;});
  const bones={};
  for(const [slot,b] of Object.entries(inst.bones)){
    if(!(b instanceof THREE.Object3D))continue;
    const c=byName[b.name]||null;
    bones[slot]=c;
    // rest-frame data is immutable → shared by reference (Object3D.clone would JSON-copy userData)
    if(c&&inst.rig[b.name])c.userData.rig=inst.rig[b.name];
  }
  bones.headAnchor=root.getObjectByName('headAnchor')||null;
  // Per-instance material clones: textures stay shared (GPU memory once), colours flash/fade independently
  const materials=[];
  const seen=new Map();
  root.traverse(o=>{
    if(!o.isMesh&&!o.isSkinnedMesh)return;
    o.frustumCulled=false; // skinned bounds go stale after posing — the bots are always near the action anyway
    const assign=m=>{
      let c=seen.get(m);
      if(!c){
        c=m.clone();seen.set(m,c);materials.push(c);
        // hit-flash restore targets (HeroBot._restoreFlash): the material's own emissive
        if(c.emissive){c.userData.baseEH=c.emissive.getHex();c.userData.baseEI=c.emissiveIntensity;}
      }
      o.material=c;
    };
    Array.isArray(o.material)?o.material.forEach(assign):assign(o.material);
  });
  return {root,bones,materials,headY:inst.headY,headFit:inst.headFit,profile:inst.profile};
}
