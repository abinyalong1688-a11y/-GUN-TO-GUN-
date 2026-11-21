// character.js — operator mesh builder (shared by in-game bots, portraits, kill cards and MVP):
//   buildOperatorMesh(assets, def, {camo}) → {group, parts, materials, dispose}
//   fadeMaterials / setEmissive
// Design:
//   · Geometries are cached at module level and shared by every character (dispose never frees them);
//   · each character clones exactly one material set (12), so hit flashes / corpse fades stay independent;
//   · face materials are shared and never flash or fade, so colours cannot bleed across characters;
//   · C1 silhouette coding: Nova helmet / headset / square pouches, Rogue shemagh / beanie / goggles / cross rig;
//   · C6 weapon silhouettes: m4a4 / ak47 / aug / sg553 / mp5 / awp (Longbow);
//   · only large body parts cast shadows — face and small trim pieces are detail meshes (shadow-pass budget).
import * as THREE from 'three';
import {paletteFor} from './operators.js';
import {modelAssets} from './modelAssets.js';

/* ============ Geometry cache ============ */
const GEO=new Map();
const geo=(key,make)=>{
  let g=GEO.get(key);
  if(!g){g=make();GEO.set(key,g);}
  return g;
};
const sphere=(r,ws=18,hs=14)=>geo(`s|${r}|${ws}|${hs}`,()=>new THREE.SphereGeometry(r,ws,hs));
const cyl=(rt,rb,h,seg=12)=>geo(`c|${rt}|${rb}|${h}|${seg}`,()=>new THREE.CylinderGeometry(rt,rb,h,seg));
const box=(w,h,d)=>geo(`b|${w}|${h}|${d}`,()=>new THREE.BoxGeometry(w,h,d));
const torus=(r,t,rs=8,ts=20,arc=Math.PI*2)=>geo(`t|${r}|${t}|${rs}|${ts}|${arc}`,()=>new THREE.TorusGeometry(r,t,rs,ts,arc));
const lathe=(key,prof,seg=24)=>geo(`l|${key}`,()=>new THREE.LatheGeometry(prof.map(([r,y])=>new THREE.Vector2(r,y)),seg));

/* ============ Materials ============ */
function tint(src,color,{emissive=null,ei=0}={}){
  const m=src.clone();
  if(color!=null)m.color.setHex(color);
  if(emissive!=null&&m.emissive){m.emissive.setHex(emissive);m.emissiveIntensity=ei;}
  return m;
}

/* One material set per character: 12 clones + 5 shared face materials */
function makeMaterials(base,def,camo){
  const P=paletteFor(def,camo);
  const skinBase=def.gender==='f'?base.skinF:base.skinM;
  const hairBase=def.gender==='f'?base.hairF:base.hairM;
  const jacketBase=def.faction==='ct'?base.ctFatigue:base.tJacket;
  const pantsBase=def.faction==='ct'?base.ctFatigue:base.tPants;
  const armorBase=def.faction==='ct'?base.ctArmor:base.tRig;

  const M={
    skin:tint(skinBase,P.skin),
    hair:tint(hairBase,P.hair),
    jacket:tint(jacketBase,P.jacket),
    pants:tint(pantsBase,P.cloth),
    armor:tint(armorBase,P.armor),
    accent:tint(base.armSleeve,P.accent,{emissive:P.accent,ei:.9}),
    boot:base.bootDark.clone(),
    glove:base.gloveDark.clone(),
    gunDark:base.gunDark.clone(),
    gunWood:base.gunWood.clone(),
    gunPoly:base.gunPoly.clone(),
    clothDark:base.clothDark.clone(),
    // Face materials: shared by all characters, excluded from hit flash / corpse fade
    sclera:base.sclera,iris:base.iris,brow:base.brow,lipsF:base.lipsF,lipsM:base.lipsM,
  };
  // Base accent glow: HeroBot restores it after a hit flash
  M.accent.userData.baseEH=P.accent;
  M.accent.userData.baseEI=.9;
  const materials=[
    M.skin,M.hair,M.jacket,M.pants,M.armor,M.accent,
    M.boot,M.glove,M.gunDark,M.gunWood,M.gunPoly,M.clothDark,
  ];
  return {M,materials};
}

/* ============ Mesh helpers ============ */
function mesh(parent,g,mat,x,y,z,rx=0,ry=0,rz=0,sx=1,sy=1,sz=1){
  const m=new THREE.Mesh(g,mat);
  m.position.set(x,y,z);m.rotation.set(rx,ry,rz);m.scale.set(sx,sy,sz);
  m.castShadow=true;
  parent.add(m);
  return m;
}
/* Small detail piece: same as mesh() but kept out of the shadow pass */
function detail(...a){
  const m=mesh(...a);
  m.castShadow=false;
  return m;
}

/* Face (head-local, facing +z): brows / lids + sclera + iris / nose / lips / chin / ears */
function makeFace(H,M,{fem}){
  const skin=M.skin;
  for(const s of[-1,1]){
    detail(H,sphere(.018,10,8),M.sclera,s*.041,.016,.086,0,0,0,.95,.62,.5);
    detail(H,sphere(.0125,10,8),M.iris,s*.041,.016,.0995);
    // Upper lid: skin tone overlaps the top of the sclera for a natural eye shape
    detail(H,box(.05,.016,.02),skin,s*.041,.034,.088,0,0,-s*(fem?.1:.06));
    if(fem)detail(H,box(.05,.0045,.012),M.brow,s*.043,.0255,.0985,0,0,-s*.16); // lash line, flicked outward
    const bw=fem?{w:.04,h:.007,a:.22}:{w:.048,h:.011,a:.1};
    detail(H,box(bw.w,bw.h,.012),M.brow,s*.043,.058,.087,0,0,-s*bw.a);
    // Cheekbones: soft volume under the eyes
    detail(H,sphere(.026,10,8),skin,s*.052,-.012,.07,0,0,0,1.15,.75,.6);
  }
  // Nose: slim bridge + rounded tip (replaces the old cone)
  detail(H,sphere(.011,8,8),skin,0,.004,.097,-.25,0,0,fem?.8:1,2.1,1);
  detail(H,sphere(fem?.012:.014,10,8),skin,0,-.02,.104,0,0,0,1.15,.85,1);
  if(fem)detail(H,box(.038,.011,.013),M.lipsF,0,-.048,.09,0,0,0,1,1,.9);
  else detail(H,box(.034,.008,.012),M.lipsM,0,-.048,.088);
  // Chin: defined but soft on the female head, squarer on the male head
  detail(H,sphere(.03,10,8),skin,0,-.083,.062,0,0,0,fem?1.05:1.35,fem?.85:.9,.85);
  for(const s of[-1,1])detail(H,sphere(.02,8,8),skin,s*.094,0,-.003,0,0,0,.5,1,.7);
}

/* ============ Headgear (C1 silhouette coding) ============ */
function makeHeadgear(H,M,def,fem){
  const gear=def.headgear||'headset';
  if(gear==='helmet'){
    // Nova helmet: low dome + brim + top identification stripe
    mesh(H,sphere(.114,18,12),M.armor,0,.028,-.006,0,0,0,1.03,.8,1.04);
    detail(H,cyl(.109,.114,.022,18),M.clothDark,0,.068,-.004);
    detail(H,box(.026,.016,.10),M.accent,0,.106,-.01);
    detail(H,box(.03,.05,.06),M.gunDark,-.096,-.005,-.03); // side-mounted radio
  }else if(gear==='beanie'){
    // Rogue beanie: soft crown + folded cuff
    mesh(H,sphere(.113,16,12),M.clothDark,0,.032,-.004,0,0,0,1.02,.84,1.02);
    detail(H,cyl(.108,.113,.03,18),M.armor,0,.076,-.002);
  }else if(gear==='shemagh'){
    // Rogue shemagh: wraps crown and jaw + forehead band + hanging tails
    mesh(H,sphere(.116,16,12),M.clothDark,0,.022,-.008,0,0,0,1.03,.9,1.03);
    detail(H,box(.17,.055,.03),M.armor,0,.038,.088,-.08);
    detail(H,box(.05,.2,.018),M.jacket,.085,-.105,-.015,.12,0,.22);
    detail(H,box(.038,.13,.016),M.armor,-.088,-.075,-.02,.1,0,-.18);
  }else if(gear==='goggles'){
    // Rogue goggles: strap + twin lenses (accent glow)
    detail(H,box(.19,.032,.02),M.clothDark,0,.032,.09);
    for(const s of[-1,1])detail(H,sphere(.038,12,8),M.accent,s*.045,.03,.096,0,0,0,1.12,.72,.42);
    detail(H,box(.03,.02,.02),M.gunDark,0,.032,.108);
  }else{
    // Nova tactical headset + boom mic
    detail(H,torus(.104,.007,8,20,Math.PI),M.gunDark,0,.005,0);
    for(const s of[-1,1])detail(H,cyl(.026,.026,.016,10),M.gunDark,s*.10,0,0,0,0,Math.PI/2);
    detail(H,box(.01,.01,.065),M.gunDark,-.095,-.045,.035,.3,.4,0);
  }
}

/* ============ Hair ============ */
function makeHairFemale(H,M,def){
  const hair=M.hair;
  mesh(H,sphere(.107,18,12),hair,0,.03,-.01,0,0,0,1.04,.88,1.0);
  detail(H,sphere(.104,16,12),hair,0,-.01,-.045,0,0,0,1.1,.95,.9);
  detail(H,box(.15,.05,.038),hair,0,.066,.068,-.5);
  // Side-swept fringe: breaks the helmet-like hairline
  detail(H,sphere(.05,12,8),hair,-.035,.062,.075,-.35,0,.5,1.25,.45,.5);
  if(def.hair==='bob'){
    // Chin-length bob: side locks + tucked nape
    for(const s of[-1,1])detail(H,sphere(.045,10,8),hair,s*.088,-.06,.02,0,0,-s*.08,.8,2.0,.9);
    detail(H,sphere(.085,12,10),hair,0,-.085,-.055,0,0,0,1.15,.7,.7);
  }else{
    // Face-framing strands for the low ponytail (ponytail itself swings with the gait)
    detail(H,sphere(.026,8,8),hair,-.082,-.06,.045,0,0,.12,1,2.6,.8);
    detail(H,sphere(.026,8,8),hair,.082,-.06,.045,0,0,-.12,1,2.6,.8);
  }
}
function makePony(H,M,parts){
  const pony=new THREE.Group();pony.position.set(0,-.02,-.11);H.add(pony);parts.pony=pony;
  const hair=M.hair;
  mesh(pony,sphere(.048,10,8),hair,0,-.01,-.02,0,0,0,1,1.3,1);
  detail(pony,torus(.03,.008,6,14),M.accent,0,-.07,-.035,Math.PI/2); // hair tie
  mesh(pony,sphere(.037,10,8),hair,0,-.12,-.05,0,0,0,1,1.5,1);
  detail(pony,sphere(.027,10,8),hair,0,-.25,-.04,0,0,0,1,1.6,1);
}

/* ============ Silhouette extras (C1) ============ */
function addExtras(group,parts,M,def){
  const ex=def.extras||[];
  if(ex.includes('armband')){
    for(const arm of [parts.armR,parts.armL])
      if(arm)detail(arm,cyl(.049,.049,.034,12),M.accent,0,-.045,0);
  }
  if(ex.includes('kneepads')){
    for(const leg of [parts.legL,parts.legR])
      if(leg)detail(leg,box(.1,.1,.06),M.armor,0,-.42,.06);
  }
  if(ex.includes('holster')){
    if(parts.legR){
      detail(parts.legR,box(.06,.15,.05),M.glove,.066,-.17,.02);
      detail(parts.legR,box(.05,.03,.05),M.gunDark,.066,-.10,.02);
    }
  }
  if(ex.includes('backpack')){
    mesh(group,box(.25,.3,.12),M.armor,0,1.22,-.14);
    detail(group,box(.2,.08,.13),M.clothDark,0,1.06,-.14);
    detail(group,box(.045,.12,.02),M.accent,-.075,1.2,-.205);
  }
}

/* ============ Shared limb builders ============ */
/* Arm: deltoid cap + sleeve + rolled cuff + bare forearm + gloved hand with thumb */
function makeArm(group,M,side,{x,y,r,len,fore,hand}){
  const p=new THREE.Group();p.position.set(side*x,y,0);group.add(p);
  detail(p,sphere(r*1.1,12,10),M.jacket,0,-.012,0,0,0,0,1,1.15,1);           // deltoid
  mesh(p,cyl(r,r*.84,len),M.jacket,0,-len/2+.005,0);                          // sleeve
  detail(p,cyl(r*.92,r*.92,.032,12),M.jacket,0,-len+.01,.004);               // rolled cuff
  mesh(p,cyl(r*.76,r*.62,fore),M.skin,0,-len-fore/2+.06,.015);               // forearm
  const hy=-len-fore+.045;
  mesh(p,sphere(hand,10,8),M.glove,0,hy,.03,0,0,0,.9,1.2,.78);              // palm
  detail(p,sphere(hand*.42,8,6),M.glove,-side*hand*.8,hy+.012,.05);         // thumb
  return p;
}
/* Leg: thigh + knee + shin + boot shaft + boot with sole and rounded toe cap */
function makeLeg(group,M,mat,side,{x,y,thigh,shin,tr,sr,boot}){
  const p=new THREE.Group();p.position.set(side*x,y,0);group.add(p);
  mesh(p,cyl(tr,tr*.8,thigh),mat,0,-thigh/2,0);
  detail(p,sphere(tr*.78,10,8),mat,0,-thigh+.01,.014,0,0,0,1,1,1.05);         // knee
  const shinY=-thigh-shin/2+.035;
  mesh(p,cyl(sr,sr*.86,shin),mat,0,shinY,.01);
  const bootY=-y+boot.h/2+.004;                                                // boot sits on the ground
  detail(p,cyl(sr*.98,sr*1.02,.1,10),M.boot,0,bootY+boot.h/2+.03,.01);       // shaft
  mesh(p,box(boot.w,boot.h,boot.d),M.boot,0,bootY,boot.z);
  detail(p,sphere(boot.w*.52,10,8),M.boot,0,bootY-.008,boot.z+boot.d/2-.01,0,0,0,1,.75,1); // toe cap
  detail(p,box(boot.w+.008,.016,boot.d+.012),M.clothDark,0,-y+.008,boot.z+.004);  // sole
  return p;
}

/* ============ Rifle silhouettes (C6) ============ */
function makeRifle(kind,M){
  const g=new THREE.Group();
  let first=true;
  // Only the receiver (first piece) casts a shadow; the rest are detail meshes
  const B=(...a)=>{const m=first?mesh(g,...a):detail(g,...a);first=false;return m;};
  const dark=M.gunDark,poly=M.gunPoly,wood=M.gunWood;
  let tipZ=.44;
  if(kind==='ak47'){
    B(box(.05,.078,.30),dark,0,.01,-.03);
    B(box(.052,.022,.24),dark,0,.062,-.05);
    B(box(.05,.055,.17),wood,0,.002,-.24);
    B(cyl(.013,.013,.07,10),dark,0,.02,-.35,Math.PI/2);
    B(cyl(.009,.009,.22,10),dark,0,.02,-.47,Math.PI/2);
    B(box(.014,.055,.012),dark,0,.052,-.55);
    B(box(.04,.06,.15),wood,0,-.012,-.30);
    B(box(.028,.11,.055),dark,0,-.078,.02,.35);
    B(box(.026,.02,.045),dark,0,.02,-.575);
    tipZ=.60;
  }else if(kind==='aug'){
    // Bullpup: short receiver + integrated grip + top scope
    B(box(.052,.085,.38),poly,0,.005,-.02);
    B(box(.046,.06,.12),dark,0,.01,.18);
    B(cyl(.012,.012,.16,10),dark,0,.018,.27,Math.PI/2);
    B(box(.045,.05,.12),poly,0,-.005,-.26);
    B(box(.03,.11,.055),dark,0,-.078,.03,.18);
    B(box(.04,.04,.16),dark,0,.075,-.01);
    B(cyl(.024,.024,.13,12),dark,0,.10,-.01,Math.PI/2);
    B(cyl(.032,.032,.02,12),dark,0,.10,.07,Math.PI/2);
    tipZ=.37;
  }else if(kind==='sg553'){
    B(box(.05,.075,.28),dark,0,.008,-.03);
    B(box(.05,.05,.16),poly,0,.002,-.22);
    B(cyl(.011,.011,.20,10),dark,0,.018,-.42,Math.PI/2);
    B(box(.042,.055,.14),poly,0,-.01,-.30);
    B(box(.028,.11,.055),dark,0,-.078,.02,.3);
    B(box(.04,.04,.15),dark,0,.072,-.02);
    B(cyl(.022,.022,.12,12),dark,0,.098,-.02,Math.PI/2);
    B(box(.016,.06,.012),dark,0,.05,-.52);
    tipZ=.54;
  }else if(kind==='mp5'){
    // Compact SMG: short body + straight magazine + handguard
    B(box(.05,.075,.24),dark,0,.005,-.02);
    B(cyl(.026,.026,.14,12),poly,0,.006,.15,Math.PI/2);
    B(cyl(.01,.01,.10,10),dark,0,.018,.27,Math.PI/2);
    B(box(.028,.13,.045),dark,0,-.085,.02,.05);
    B(box(.038,.05,.12),poly,0,-.006,-.22);
    B(box(.03,.05,.10),poly,0,.005,-.30);
    B(box(.014,.045,.012),dark,0,.045,.32);
    tipZ=.35;
  }else if(kind==='awp'){
    // Longbow heavy sniper: long barrel + big scope + bolt handle + thumbhole stock
    B(box(.052,.08,.34),poly,0,.005,-.04);
    B(cyl(.014,.014,.38,12),dark,0,.018,.30,Math.PI/2);
    B(cyl(.018,.018,.06,12),dark,0,.018,.50,Math.PI/2);
    B(box(.05,.075,.16),poly,0,.0,-.28);
    B(box(.034,.10,.055),dark,0,-.075,.0);
    B(box(.03,.02,.18),poly,0,.085,-.02);
    B(cyl(.028,.028,.16,12),dark,0,.115,-.02,Math.PI/2);
    B(cyl(.036,.036,.025,12),dark,0,.115,.065,Math.PI/2);
    B(cyl(.036,.036,.025,12),dark,0,.115,-.105,Math.PI/2);
    B(box(.01,.01,.07),dark,.045,.03,-.06,0,0,.3); // bolt handle
    tipZ=.53;
  }else{
    // M4A4: carry rail + triangular handguard + curved magazine
    B(box(.05,.075,.34),dark,0,0,-.02);
    B(box(.046,.05,.16),poly,0,.005,.14);
    B(cyl(.011,.011,.18,10),dark,0,.018,.28,Math.PI/2);
    B(box(.014,.05,.012),dark,0,.045,.34);
    B(box(.04,.06,.13),poly,0,-.008,-.24);
    B(box(.028,.10,.05),dark,0,-.075,.02,.15);
    B(box(.035,.018,.12),dark,0,.058,-.02);
    tipZ=.44;
  }
  return {group:g,tipZ};
}

function mountRifle(group,parts,M,def,{y,scale=1}){
  const rifle=makeRifle(def.rifle,M);
  rifle.group.position.set(.10,y,.16);
  rifle.group.scale.setScalar(scale);
  group.add(rifle.group);parts.rifle=rifle.group;
  const gunTip=new THREE.Object3D();
  gunTip.position.set(0,.02,rifle.tipZ);
  rifle.group.add(gunTip);parts.gunTip=gunTip;
}

/* ============ Female build (1.75 m, legs over half the height) ============ */
function buildFemale(ctx){
  const {group,M,def,parts}=ctx;
  const skin=M.skin,jacket=M.jacket,armor=M.armor;

  /* --- Head (centre 1.60): oval skull + refined features --- */
  const H=new THREE.Group();H.position.set(0,1.60,0);group.add(H);parts.head=H;parts.headY=1.60;
  mesh(H,sphere(.102,20,16),skin,0,0,.004,0,0,0,.95,1.12,1.0);
  makeFace(H,M,{fem:true});
  makeHairFemale(H,M,def);
  if(def.hair==='ponytail')makePony(H,M,parts);
  makeHeadgear(H,M,def,true);

  /* --- Neck + torso (lathe profile: shoulder-bust-waist-hip curve, elliptical section scale.z=0.72) --- */
  mesh(group,cyl(.03,.036,.1),skin,0,1.47,0);
  detail(group,sphere(.07,14,10),jacket,0,1.43,-.012,0,0,0,1.75,.42,.8);     // trapezius / shoulder slope
  const prof=[[.001,.845],[.128,.86],[.134,.93],[.098,1.06],[.124,1.16],[.15,1.32],[.146,1.40],[.092,1.455]];
  const torso=new THREE.Mesh(lathe('f',prof),jacket);
  torso.scale.z=.72;torso.castShadow=true;group.add(torso);parts.torso=torso;
  detail(group,sphere(.048,12,10),jacket,-.05,1.30,.078,0,0,0,1,.85,.7);
  detail(group,sphere(.048,12,10),jacket,.05,1.30,.078,0,0,0,1,.85,.7);
  detail(group,box(.07,.03,.02),jacket,0,1.448,.07,-.35);                     // collar
  // Belt + buckle / slim vest plates (jacket colour shows through) / mag pouches / radio
  detail(group,cyl(.109,.109,.03,20),M.gunDark,0,.945,0,0,0,0,1,1,.72);
  detail(group,box(.036,.026,.01),M.accent,0,.945,.081);
  mesh(group,box(.22,.19,.03),armor,0,1.27,.10);
  mesh(group,box(.22,.19,.03),armor,0,1.27,-.082);
  detail(group,box(.045,.06,.02),M.gunDark,-.045,1.21,.118);
  detail(group,box(.045,.06,.02),M.gunDark,.045,1.21,.118);
  detail(group,box(.032,.055,.016),M.gunDark,-.088,1.16,.105,0,0,-.2);

  /* --- Arms (sleeve + bare forearm + tactical glove, locked in a rifle hold) --- */
  const arm={x:.148,y:1.395,r:.045,len:.24,fore:.17,hand:.033};
  parts.armL=makeArm(group,M,-1,arm);parts.armR=makeArm(group,M,1,arm);

  /* --- Legs (hip at .90 → 51% of body height) --- */
  const leg={x:.082,y:.90,thigh:.44,shin:.36,tr:.068,sr:.05,boot:{w:.082,h:.082,d:.20,z:.03}};
  parts.legL=makeLeg(group,M,jacket,-1,leg);parts.legR=makeLeg(group,M,jacket,1,leg);
  addExtras(group,parts,M,def);

  /* --- Primary weapon (faction issue, muzzle toward +z, gunTip on the rifle) --- */
  mountRifle(group,parts,M,def,{y:1.20,scale:.94});
  parts.armR.rotation.set(-.72,0,-.04);
  parts.armL.rotation.set(-.85,.35,.5);
}

/* ============ Male build (1.80 m, V-shaped torso) ============ */
function buildMale(ctx){
  const {group,M,def,parts}=ctx;
  const skin=M.skin,jacket=M.jacket,pants=M.pants,armor=M.armor,hair=M.hair;

  /* --- Head (centre 1.64): squared skull + strong jaw + straight heavy brows --- */
  const H=new THREE.Group();H.position.set(0,1.64,0);group.add(H);parts.head=H;parts.headY=1.64;
  mesh(H,sphere(.106,20,16),skin,0,0,.004,0,0,0,1.0,1.1,1.02);
  detail(H,box(.06,.04,.06),skin,0,-.065,.028);                // square jaw
  detail(H,box(.13,.016,.03),skin,0,.05,.084);                 // brow ridge
  makeFace(H,M,{fem:false});
  // Short hair: close-fitting crown (front edge lifted off the brows) + faded back and sideburns
  mesh(H,sphere(.114,18,12),hair,0,.022,-.01,-.18,0,0,1.03,.94,1.05);
  detail(H,sphere(.095,14,10),hair,0,-.005,-.07,0,0,0,1.12,.72,.6);
  for(const s of[-1,1])detail(H,box(.012,.045,.03),hair,s*.1,-.01,.03);
  if(def.hair==='ponytail')makePony(H,M,parts);
  makeHeadgear(H,M,def,false);

  /* --- Neck + torso (broad shoulders, narrow waist) --- */
  mesh(group,cyl(.045,.054,.10),skin,0,1.50,0);
  detail(group,sphere(.085,14,10),jacket,0,1.455,-.012,0,0,0,1.75,.45,.82);   // trapezius
  const prof=[[.001,.86],[.145,.88],[.128,.98],[.125,1.06],[.148,1.20],[.168,1.34],[.166,1.43],[.095,1.49]];
  const torso=new THREE.Mesh(lathe('m',prof),jacket);
  torso.scale.z=.74;torso.castShadow=true;group.add(torso);parts.torso=torso;
  detail(group,cyl(.13,.13,.035,20),M.gunDark,0,.95,0,0,0,0,1,1,.74);         // belt
  detail(group,box(.04,.028,.01),M.accent,0,.95,.098);                         // buckle
  // Collar; Rogue: open front + dark tee + X chest rig, Nova: closed collar + front zip
  detail(group,box(.16,.04,.02),jacket,0,1.475,.115);
  if(def.faction!=='ct'){
    detail(group,box(.11,.16,.02),M.clothDark,0,1.36,.127);
    mesh(group,box(.045,.36,.018),armor,-.075,1.22,.128,0,0,.45);
    mesh(group,box(.045,.36,.018),armor,.075,1.22,.128,0,0,-.45);
  }else{
    detail(group,box(.014,.3,.014),M.clothDark,0,1.30,.122);
  }

  /* --- Arms (broad shoulders, thick arms, rolled sleeves, tactical gloves) --- */
  const arm={x:.165,y:1.42,r:.055,len:.25,fore:.18,hand:.043};
  parts.armL=makeArm(group,M,-1,arm);parts.armR=makeArm(group,M,1,arm);

  /* --- Legs --- */
  const leg={x:.088,y:.88,thigh:.42,shin:.38,tr:.08,sr:.056,boot:{w:.095,h:.09,d:.215,z:.035}};
  parts.legL=makeLeg(group,M,pants,-1,leg);parts.legR=makeLeg(group,M,pants,1,leg);
  addExtras(group,parts,M,def);

  /* --- Primary weapon (faction issue, muzzle toward +z) --- */
  mountRifle(group,parts,M,def,{y:1.19});
  parts.armR.rotation.set(-.70,0,-.04);
  parts.armL.rotation.set(-.82,.35,.5);
}

/* ============ GLB path: AI-generated rigged body + procedural attachments ============ */
/* Same contract as buildOperatorMesh: {group,parts,materials,dispose}.
   The skinned body (bones ARE Object3Ds) plugs straight into the parts contract — HeroBot
   animates bones exactly like the procedural Groups; rifle / headgear / extras stay procedural
   (C1 silhouette coding + rifle drop physics), attached to the mapped bones. */
function mountRifleTo(group,parts,bones,M,def,profile){
  const rifle=makeRifle(def.rifle,M);
  const hand=bones.handR;
  if(hand){
    rifle.group.position.set(...profile.rifle.pos);
    rifle.group.rotation.set(...profile.rifle.rot);
    rifle.group.scale.setScalar(profile.rifle.scale);
    hand.add(rifle.group);
  }else{
    rifle.group.position.set(.10,1.20,.16);
    rifle.group.scale.setScalar(profile.rifle.scale);
    group.add(rifle.group);
  }
  parts.rifle=rifle.group;
  const gunTip=new THREE.Object3D();
  gunTip.position.set(0,.02,rifle.tipZ);
  rifle.group.add(gunTip);parts.gunTip=gunTip;
}
/* Silhouette extras in bone-local space (offsets differ from the procedural limb Groups) */
function addExtrasGLTF(parts,M,def,bones){
  const ex=def.extras||[];
  if(ex.includes('armband')){
    for(const arm of [bones.foreR,bones.foreL])
      if(arm)detail(arm,cyl(.05,.05,.034,12),M.accent,0,-.06,0);
  }
  if(ex.includes('kneepads')){
    for(const calf of [bones.calfL,bones.calfR])
      if(calf)detail(calf,box(.1,.1,.06),M.armor,0,-.02,.055);
  }
  if(ex.includes('holster')&&bones.legR){
    detail(bones.legR,box(.06,.15,.05),M.glove,.066,-.17,.02);
    detail(bones.legR,box(.05,.03,.05),M.gunDark,.066,-.10,.02);
  }
  if(ex.includes('backpack')&&bones.chest){
    detail(bones.chest,box(.25,.3,.12),M.armor,0,-.07,-.16);
    detail(bones.chest,box(.2,.08,.13),M.clothDark,0,-.23,-.16);
  }
}
export function buildOperatorMeshGLTF(assets,def,{camo='default'}={}){
  const inst=modelAssets.cloneCharacter(def.gender);
  const {M}=makeMaterials(assets.mats,def,camo);
  const group=inst.root,bones=inst.bones;
  const parts={
    head:null,torso:null,armL:null,armR:null,legL:null,legR:null,
    shinL:null,shinR:null,pony:null,rifle:null,gunTip:null,
    headY:inst.headY,nameTagAnchor:null,
  };
  parts.head=bones.head;parts.torso=bones.chest||bones.spine;
  parts.armL=bones.armL;parts.armR=bones.armR;
  parts.legL=bones.legL;parts.legR=bones.legR;
  parts.shinL=bones.calfL;parts.shinR=bones.calfR;
  parts.pony=bones.pony||null;
  mountRifleTo(group,parts,bones,M,def,inst.profile);
  if(bones.headAnchor){
    makeHeadgear(bones.headAnchor,M,def,def.gender==='f');
    if(def.hair==='ponytail'&&!bones.pony)makePony(bones.headAnchor,M,parts); // no hair bone in the rig → procedural fallback
  }
  addExtrasGLTF(parts,M,def,bones);
  const anchor=new THREE.Object3D();
  anchor.position.y=2.0;
  group.add(anchor);parts.nameTagAnchor=anchor;
  // inst.materials are already per-instance clones (textures stay shared across characters)
  const materials=inst.materials;
  const dispose=()=>{for(const m of materials)m.dispose();};
  return {group,parts,materials,dispose};
}

/* ============ Public API ============ */
/* Dispatcher used by bots / portraits: GLB when loaded (?model=gltf), procedural otherwise
   (?model=proc or load failure) — the procedural path is the permanent fallback. */
export function buildOperatorMeshAuto(assets,def,{camo='default'}={}){
  if(modelAssets.mode()==='gltf'){
    try{return buildOperatorMeshGLTF(assets,def,{camo});}
    catch(e){console.warn('[character] GLB build failed — procedural fallback:',e);}
  }
  return buildOperatorMesh(assets,def,{camo});
}
export function buildOperatorMesh(assets,def,{camo='default'}={}){
  const group=new THREE.Group();
  const {M,materials}=makeMaterials(assets.mats,def,camo);
  const parts={
    head:null,torso:null,armL:null,armR:null,legL:null,legR:null,
    pony:null,rifle:null,gunTip:null,headY:1.6,nameTagAnchor:null,
  };
  const ctx={group,M,def,parts};
  if(def.gender==='f')buildFemale(ctx);
  else buildMale(ctx);

  const anchor=new THREE.Object3D();
  anchor.position.y=2.0;
  group.add(anchor);parts.nameTagAnchor=anchor;

  const dispose=()=>{for(const m of materials)m.dispose();};
  return {group,parts,materials,dispose};
}

/* Corpse fade: opacity 1→0; depthWrite is turned off while translucent to avoid occlusion */
export function fadeMaterials(materials,opacity){
  const o=Math.max(0,Math.min(1,opacity));
  const transparent=o<1;
  for(const m of materials){
    // Toggling `transparent` changes the shader variant; without needsUpdate the program
    // keeps the opaque path and the corpse never visibly fades.
    if(m.transparent!==transparent){m.transparent=transparent;m.needsUpdate=true;}
    m.opacity=o;
    m.depthWrite=!transparent;
  }
}

/* Hit flash / accent glow */
export function setEmissive(materials,hex,intensity){
  for(const m of materials){
    if(!m.emissive)continue;
    m.emissive.setHex(hex);
    m.emissiveIntensity=intensity;
  }
}
