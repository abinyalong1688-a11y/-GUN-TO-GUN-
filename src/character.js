// character.js —— 干员角色网格构建(游戏内 / 立绘 / 击杀卡 / MVP 共用):
//   buildOperatorMesh(assets, def, {camo}) → {group, parts, materials, dispose}
//   fadeMaterials / setEmissive
// 设计:
//   · 几何体模块级缓存,所有角色共享(dispose 不释放几何);
//   · 每个角色只克隆一套材质(12 个),受击闪白/尸体淡出互不影响;
//   · 面部材质共享且不参与闪白/淡出,避免跨角色串色;
//   · C1 形状编码:CT 头盔/耳麦/方袋,T 头巾/毛线帽/护目镜/斜挂;
//   · C6 武器外观:m4a4/ak47/aug/sg553/mp5/awp 六种剪影。
import * as THREE from 'three';
import {paletteFor} from './operators.js';

/* ============ 几何缓存 ============ */
const GEO=new Map();
const geo=(key,make)=>{
  let g=GEO.get(key);
  if(!g){g=make();GEO.set(key,g);}
  return g;
};
const sphere=(r,ws=18,hs=14)=>geo(`s|${r}|${ws}|${hs}`,()=>new THREE.SphereGeometry(r,ws,hs));
const cyl=(rt,rb,h,seg=12)=>geo(`c|${rt}|${rb}|${h}|${seg}`,()=>new THREE.CylinderGeometry(rt,rb,h,seg));
const box=(w,h,d)=>geo(`b|${w}|${h}|${d}`,()=>new THREE.BoxGeometry(w,h,d));
const cone=(r,h,seg=10)=>geo(`o|${r}|${h}|${seg}`,()=>new THREE.ConeGeometry(r,h,seg));
const torus=(r,t,rs=8,ts=20,arc=Math.PI*2)=>geo(`t|${r}|${t}|${rs}|${ts}|${arc}`,()=>new THREE.TorusGeometry(r,t,rs,ts,arc));
const lathe=(key,prof,seg=24)=>geo(`l|${key}`,()=>new THREE.LatheGeometry(prof.map(([r,y])=>new THREE.Vector2(r,y)),seg));

/* ============ 材质 ============ */
function tint(src,color,{emissive=null,ei=0}={}){
  const m=src.clone();
  if(color!=null)m.color.setHex(color);
  if(emissive!=null&&m.emissive){m.emissive.setHex(emissive);m.emissiveIntensity=ei;}
  return m;
}

/* 每角色一套材质:12 个克隆 + 5 个共享面部材质 */
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
    // 面部材质:全角色共享,不参与受击闪白/尸体淡出
    sclera:base.sclera,iris:base.iris,brow:base.brow,lipsF:base.lipsF,lipsM:base.lipsM,
  };
  // 强调色基础自发光:受击闪白结束后由 HeroBot 恢复
  M.accent.userData.baseEH=P.accent;
  M.accent.userData.baseEI=.9;
  const materials=[
    M.skin,M.hair,M.jacket,M.pants,M.armor,M.accent,
    M.boot,M.glove,M.gunDark,M.gunWood,M.gunPoly,M.clothDark,
  ];
  return {M,materials};
}

/* ============ 网格工具 ============ */
function mesh(parent,g,mat,x,y,z,rx=0,ry=0,rz=0,sx=1,sy=1,sz=1){
  const m=new THREE.Mesh(g,mat);
  m.position.set(x,y,z);m.rotation.set(rx,ry,rz);m.scale.set(sx,sy,sz);
  m.castShadow=true;
  parent.add(m);
  return m;
}

/* 人脸(头心局部坐标,朝向 +z):眉 / 眼睑+眼白+虹膜 / 鼻 / 唇 / 耳 */
function makeFace(H,M,{fem}){
  const skin=M.skin;
  for(const s of[-1,1]){
    mesh(H,sphere(.018,10,8),M.sclera,s*.041,.016,.086,0,0,0,.95,.62,.5);
    mesh(H,sphere(.0125,10,8),M.iris,s*.041,.016,.0995);
    // 上眼睑:肤色压住眼白上缘,形成自然眼型
    mesh(H,box(.05,.016,.02),skin,s*.041,.034,.088,0,0,-s*(fem?.1:.06));
    const bw=fem?{w:.04,h:.007,a:.22}:{w:.048,h:.011,a:.1};
    mesh(H,box(bw.w,bw.h,.012),M.brow,s*.043,.058,.087,0,0,-s*bw.a);
  }
  mesh(H,cone(.011,.044,8),skin,0,-.008,.098,Math.PI/2);
  if(fem)mesh(H,box(.038,.011,.013),M.lipsF,0,-.048,.09,0,0,0,1,1,.9);
  else mesh(H,box(.034,.008,.012),M.lipsM,0,-.048,.088);
  for(const s of[-1,1])mesh(H,sphere(.02,8,8),skin,s*.094,0,-.003,0,0,0,.5,1,.7);
}

/* ============ 头饰(C1 形状编码) ============ */
function makeHeadgear(H,M,def,fem){
  const gear=def.headgear||'headset';
  if(gear==='helmet'){
    // CT 头盔:低圆顶 + 折边 + 顶部识别条
    mesh(H,sphere(.114,18,12),M.armor,0,.028,-.006,0,0,0,1.03,.8,1.04);
    mesh(H,cyl(.109,.114,.022,18),M.clothDark,0,.068,-.004);
    mesh(H,box(.026,.016,.10),M.accent,0,.106,-.01);
    mesh(H,box(.03,.05,.06),M.gunDark,-.096,-.005,-.03); // 侧挂电台
  }else if(gear==='beanie'){
    // T 毛线帽:软顶 + 折边
    mesh(H,sphere(.113,16,12),M.clothDark,0,.032,-.004,0,0,0,1.02,.84,1.02);
    mesh(H,cyl(.108,.113,.03,18),M.armor,0,.076,-.002);
  }else if(gear==='shemagh'){
    // T 头巾:包住头顶与下颌 + 前额布条 + 侧垂尾
    mesh(H,sphere(.116,16,12),M.clothDark,0,.022,-.008,0,0,0,1.03,.9,1.03);
    mesh(H,box(.17,.055,.03),M.armor,0,.038,.088,-.08);
    mesh(H,box(.05,.2,.018),M.jacket,.085,-.105,-.015,.12,0,.22);
    mesh(H,box(.038,.13,.016),M.armor,-.088,-.075,-.02,.1,0,-.18);
  }else if(gear==='goggles'){
    // T 护目镜:束带 + 双镜片(强调色发光)
    mesh(H,box(.19,.032,.02),M.clothDark,0,.032,.09);
    for(const s of[-1,1])mesh(H,sphere(.038,12,8),M.accent,s*.045,.03,.096,0,0,0,1.12,.72,.42);
    mesh(H,box(.03,.02,.02),M.gunDark,0,.032,.108);
  }else{
    // CT 战术耳麦 + 通话麦
    mesh(H,torus(.104,.007,8,20,Math.PI),M.gunDark,0,.005,0);
    for(const s of[-1,1])mesh(H,cyl(.026,.026,.016,10),M.gunDark,s*.10,0,0,0,0,Math.PI/2);
    mesh(H,box(.01,.01,.065),M.gunDark,-.095,-.045,.035,.3,.4,0);
  }
}

/* ============ 发型 ============ */
function makeHairFemale(H,M,def){
  const hair=M.hair;
  mesh(H,sphere(.107,18,12),hair,0,.03,-.01,0,0,0,1.04,.88,1.0);
  mesh(H,sphere(.104,16,12),hair,0,-.01,-.045,0,0,0,1.1,.95,.9);
  mesh(H,box(.15,.05,.038),hair,0,.066,.068,-.5);
  if(def.hair==='bob'){
    // 齐颌短发:两侧发束 + 后颈内扣
    for(const s of[-1,1])mesh(H,sphere(.045,10,8),hair,s*.088,-.06,.02,0,0,-s*.08,.8,2.0,.9);
    mesh(H,sphere(.085,12,10),hair,0,-.085,-.055,0,0,0,1.15,.7,.7);
  }else{
    // 低马尾(随步态摆动)
    mesh(H,sphere(.026,8,8),hair,-.082,-.06,.045,0,0,.12,1,2.6,.8);
    mesh(H,sphere(.026,8,8),hair,.082,-.06,.045,0,0,-.12,1,2.6,.8);
  }
}
function makePony(H,M,parts){
  const pony=new THREE.Group();pony.position.set(0,-.02,-.11);H.add(pony);parts.pony=pony;
  const hair=M.hair;
  mesh(pony,sphere(.048,10,8),hair,0,-.01,-.02,0,0,0,1,1.3,1);
  mesh(pony,sphere(.037,10,8),hair,0,-.12,-.05,0,0,0,1,1.5,1);
  mesh(pony,sphere(.027,10,8),hair,0,-.25,-.04,0,0,0,1,1.6,1);
}

/* ============ 剪影配件(C1) ============ */
function addExtras(group,parts,M,def){
  const ex=def.extras||[];
  if(ex.includes('armband')){
    for(const arm of [parts.armR,parts.armL])
      if(arm)mesh(arm,cyl(.049,.049,.034,12),M.accent,0,-.045,0);
  }
  if(ex.includes('kneepads')){
    for(const leg of [parts.legL,parts.legR])
      if(leg)mesh(leg,box(.1,.1,.06),M.armor,0,-.42,.06);
  }
  if(ex.includes('holster')){
    if(parts.legR){
      mesh(parts.legR,box(.06,.15,.05),M.glove,.066,-.17,.02);
      mesh(parts.legR,box(.05,.03,.05),M.gunDark,.066,-.10,.02);
    }
  }
  if(ex.includes('backpack')){
    mesh(group,box(.25,.3,.12),M.armor,0,1.22,-.14);
    mesh(group,box(.2,.08,.13),M.clothDark,0,1.06,-.14);
    mesh(group,box(.045,.12,.02),M.accent,-.075,1.2,-.205);
  }
}

/* ============ 步枪外观(C6) ============ */
function makeRifle(kind,M){
  const g=new THREE.Group();
  const B=(...a)=>mesh(g,...a);
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
    // 无托结构:短机匣 + 一体握把 + 顶部瞄准镜
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
    // 紧凑冲锋枪:短枪身 + 直弹匣 + 前护木
    B(box(.05,.075,.24),dark,0,.005,-.02);
    B(cyl(.026,.026,.14,12),poly,0,.006,.15,Math.PI/2);
    B(cyl(.01,.01,.10,10),dark,0,.018,.27,Math.PI/2);
    B(box(.028,.13,.045),dark,0,-.085,.02,.05);
    B(box(.038,.05,.12),poly,0,-.006,-.22);
    B(box(.03,.05,.10),poly,0,.005,-.30);
    B(box(.014,.045,.012),dark,0,.045,.32);
    tipZ=.35;
  }else if(kind==='awp'){
    // 重狙:长枪管 + 大镜 + 拉栓 + 拇指孔枪托
    B(box(.052,.08,.34),poly,0,.005,-.04);
    B(cyl(.014,.014,.38,12),dark,0,.018,.30,Math.PI/2);
    B(cyl(.018,.018,.06,12),dark,0,.018,.50,Math.PI/2);
    B(box(.05,.075,.16),poly,0,.0,-.28);
    B(box(.034,.10,.055),dark,0,-.075,.0);
    B(box(.03,.02,.18),poly,0,.085,-.02);
    B(cyl(.028,.028,.16,12),dark,0,.115,-.02,Math.PI/2);
    B(cyl(.036,.036,.025,12),dark,0,.115,.065,Math.PI/2);
    B(cyl(.036,.036,.025,12),dark,0,.115,-.105,Math.PI/2);
    B(box(.01,.01,.07),dark,.045,.03,-.06,0,0,.3); // 拉栓
    tipZ=.53;
  }else{
    // M4A4:提把 + 三角形护木 + 弯弹匣
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

/* ============ 女性模特级身形(1.75m,腿长过半) ============ */
function buildFemale(ctx){
  const {group,M,def,parts}=ctx;
  const skin=M.skin,jacket=M.jacket,armor=M.armor,boot=M.boot,glove=M.glove;

  /* --- 头(中心 1.60):椭圆颅骨 + 精致五官 --- */
  const H=new THREE.Group();H.position.set(0,1.60,0);group.add(H);parts.head=H;parts.headY=1.60;
  mesh(H,sphere(.102,20,16),skin,0,0,.004,0,0,0,.95,1.12,1.0);
  makeFace(H,M,{fem:true});
  makeHairFemale(H,M,def);
  if(def.hair==='ponytail')makePony(H,M,parts);
  makeHeadgear(H,M,def,true);

  /* --- 颈 + 躯干(Lathe 曲面:肩-胸-腰-臀曲线,scale.z=0.72 椭圆截面) --- */
  mesh(group,cyl(.03,.035,.09),skin,0,1.47,0);
  const prof=[[.001,.845],[.128,.86],[.134,.93],[.098,1.06],[.124,1.16],[.15,1.32],[.146,1.40],[.092,1.455]];
  const torso=new THREE.Mesh(lathe('f',prof),jacket);
  torso.scale.z=.72;torso.castShadow=true;group.add(torso);parts.torso=torso;
  mesh(group,sphere(.048,12,10),jacket,-.05,1.30,.078,0,0,0,1,.85,.7);
  mesh(group,sphere(.048,12,10),jacket,.05,1.30,.078,0,0,0,1,.85,.7);
  // 腰带 / 背心插板(窄版,露出夹克色)/ 弹匣袋 / 对讲机
  mesh(group,cyl(.109,.109,.03,20),M.gunDark,0,.945,0,0,0,0,1,1,.72);
  mesh(group,box(.22,.19,.03),armor,0,1.27,.10);
  mesh(group,box(.22,.19,.03),armor,0,1.27,-.082);
  mesh(group,box(.045,.06,.02),M.gunDark,-.045,1.21,.118);
  mesh(group,box(.045,.06,.02),M.gunDark,.045,1.21,.118);
  mesh(group,box(.032,.055,.016),M.gunDark,-.088,1.16,.105,0,0,-.2);

  /* --- 臂(袖+露肤前臂+战术手套,持枪锁定) --- */
  const mkArm=side=>{
    const p=new THREE.Group();p.position.set(side*.148,1.395,0);group.add(p);
    mesh(p,cyl(.045,.038,.24),jacket,0,-.115,0);
    mesh(p,cyl(.034,.028,.17),skin,0,-.29,.015);
    mesh(p,sphere(.033,10,8),glove,0,-.385,.03);
    return p;
  };
  parts.armL=mkArm(-1);parts.armR=mkArm(1);

  /* --- 腿(长腿比例:髋 .90 落地,占身高 51%) --- */
  const mkLeg=side=>{
    const p=new THREE.Group();p.position.set(side*.082,.90,0);group.add(p);
    mesh(p,cyl(.068,.054,.44),jacket,0,-.22,0);
    mesh(p,cyl(.05,.043,.36),jacket,0,-.585,.01);
    mesh(p,box(.082,.082,.20),boot,0,-.855,.03);
    return p;
  };
  parts.legL=mkLeg(-1);parts.legR=mkLeg(1);
  addExtras(group,parts,M,def);

  /* --- 主武器(阵营制式,枪口 +z 前向,gunTip 挂枪身) --- */
  const rifle=makeRifle(def.rifle,M);
  rifle.group.position.set(.10,1.20,.16);
  rifle.group.scale.setScalar(.94);
  group.add(rifle.group);parts.rifle=rifle.group;
  const gunTip=new THREE.Object3D();
  gunTip.position.set(0,.02,rifle.tipZ);
  rifle.group.add(gunTip);parts.gunTip=gunTip;
  parts.armR.rotation.set(-.72,0,-.04);
  parts.armL.rotation.set(-.85,.35,.5);
}

/* ============ 男性硬朗帅气(1.80m,V 型身躯) ============ */
function buildMale(ctx){
  const {group,M,def,parts}=ctx;
  const skin=M.skin,jacket=M.jacket,pants=M.pants,armor=M.armor,hair=M.hair,boot=M.boot,glove=M.glove;

  /* --- 头(中心 1.64):方正颅骨 + 方下巴 + 粗直眉 --- */
  const H=new THREE.Group();H.position.set(0,1.64,0);group.add(H);parts.head=H;parts.headY=1.64;
  mesh(H,sphere(.106,20,16),skin,0,0,.004,0,0,0,1.0,1.1,1.02);
  mesh(H,box(.06,.04,.06),skin,0,-.065,.028);          // 方下颌
  makeFace(H,M,{fem:false});
  // 短发:贴合头型的短发顶盖(前缘微翘不压眉)+ 后脑铲青
  mesh(H,sphere(.114,18,12),hair,0,.022,-.01,-.18,0,0,1.03,.94,1.05);
  mesh(H,sphere(.095,14,10),hair,0,-.005,-.07,0,0,0,1.12,.72,.6);
  if(def.hair==='ponytail')makePony(H,M,parts);
  makeHeadgear(H,M,def,false);

  /* --- 颈 + 躯干(宽肩窄腰 V 型) --- */
  mesh(group,cyl(.045,.052,.10),skin,0,1.50,0);
  const prof=[[.001,.86],[.145,.88],[.128,.98],[.125,1.06],[.148,1.20],[.168,1.34],[.166,1.43],[.095,1.49]];
  const torso=new THREE.Mesh(lathe('m',prof),jacket);
  torso.scale.z=.74;torso.castShadow=true;group.add(torso);parts.torso=torso;
  // 衣领;T 阵营开襟+黑 T+X 胸挂,CT 合领+前拉链
  mesh(group,box(.16,.04,.02),jacket,0,1.475,.115);
  if(def.faction!=='ct'){
    mesh(group,box(.11,.16,.02),M.clothDark,0,1.36,.127);
    mesh(group,box(.045,.36,.018),armor,-.075,1.22,.128,0,0,.45);
    mesh(group,box(.045,.36,.018),armor,.075,1.22,.128,0,0,-.45);
  }else{
    mesh(group,box(.014,.3,.014),M.clothDark,0,1.30,.122);
  }

  /* --- 臂(宽肩厚臂,挽袖露肤,战术手套) --- */
  const mkArm=side=>{
    const p=new THREE.Group();p.position.set(side*.165,1.42,0);group.add(p);
    mesh(p,cyl(.055,.047,.25),jacket,0,-.12,0);
    mesh(p,cyl(.045,.038,.18),skin,0,-.30,.02);
    mesh(p,sphere(.043,12,10),glove,0,-.40,.03);
    return p;
  };
  parts.armL=mkArm(-1);parts.armR=mkArm(1);

  /* --- 腿 --- */
  const mkLeg=side=>{
    const p=new THREE.Group();p.position.set(side*.088,.88,0);group.add(p);
    mesh(p,cyl(.08,.058,.42),pants,0,-.21,0);
    mesh(p,cyl(.056,.048,.38),pants,0,-.55,.01);
    mesh(p,box(.095,.09,.215),boot,0,-.835,.035);
    return p;
  };
  parts.legL=mkLeg(-1);parts.legR=mkLeg(1);
  addExtras(group,parts,M,def);

  /* --- 主武器(阵营制式,枪口 +z) --- */
  const rifle=makeRifle(def.rifle,M);
  rifle.group.position.set(.10,1.19,.16);
  group.add(rifle.group);parts.rifle=rifle.group;
  const gunTip=new THREE.Object3D();
  gunTip.position.set(0,.02,rifle.tipZ);
  rifle.group.add(gunTip);parts.gunTip=gunTip;
  parts.armR.rotation.set(-.70,0,-.04);
  parts.armL.rotation.set(-.82,.35,.5);
}

/* ============ 对外接口 ============ */
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

/* 尸体淡出:opacity 1→0;完全透明后关闭 depthWrite 避免遮挡 */
export function fadeMaterials(materials,opacity){
  const o=Math.max(0,Math.min(1,opacity));
  for(const m of materials){
    m.transparent=o<1;
    m.opacity=o;
    m.depthWrite=o>=1;
  }
}

/* 受击闪白 / 强调色发光 */
export function setEmissive(materials,hex,intensity){
  for(const m of materials){
    if(!m.emissive)continue;
    m.emissive.setHex(hex);
    m.emissiveIntensity=intensity;
  }
}
