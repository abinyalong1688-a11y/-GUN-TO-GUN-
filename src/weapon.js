// weapon.js —— CS 武器系统:1 主武器(阵营全部 4 把随身,按 1 循环) 2 沙漠之鹰 3 军刀
// 半自动扳机 · 军刀挥砍/重刺 · viewmodel 后坐/ADS/换弹/切枪/枪口焰/抛壳
import * as THREE from 'three';
import {isEN} from './i18n.js';

const HIP_POS=new THREE.Vector3(.22,-.205,-.44);
const HIP_ROT=new THREE.Euler(0,-.07,0);
const ADS_POS=new THREE.Vector3(0,-.098,-.34);
const ADS_ROT=new THREE.Euler(0,0,0);
const SPRINT_POS=new THREE.Vector3(.18,-.3,-.4);
const SPRINT_ROT=new THREE.Euler(.32,-.5,.18);
const LOWER_POS=new THREE.Vector3(.16,-.42,-.42); // 切枪收起

/* CS 武器库(参照 CS 原作数值:威力/射速/弹匣/换弹/持枪移速) */
export const WEAPON_DEFS={
  ak47:{id:'ak47',name:'AK-47 · 7.62×39MM',slotName:'AK-47',rpm:600,dmg:36,mag:30,reserve:90,
   spreadHip:.024,spreadAds:.0075,moveSpread:.0032,heatShot:.005,heatMax:.021,
   kick:.011,kickAds:.0062,recoilV:.0125,recoilH:.005,auto:true,
   tracer:0xffc36b,tracerW:.034,tracerSpeed:460,reloadDur:2.45,speedMul:.88},
  m4a4:{id:'m4a4',name:'M4A4 · 5.56×45MM',slotName:'M4A4',rpm:666,dmg:31,mag:30,reserve:90,
   spreadHip:.02,spreadAds:.006,moveSpread:.0026,heatShot:.0036,heatMax:.016,
   kick:.0078,kickAds:.0046,recoilV:.009,recoilH:.0038,auto:true,
   tracer:0xffd9a0,tracerW:.032,tracerSpeed:470,reloadDur:3.05,speedMul:.90},
  aug:{id:'aug',name:'AUG · 5.56×45MM',slotName:'AUG',rpm:660,dmg:30,mag:30,reserve:90,
   spreadHip:.018,spreadAds:.0032,moveSpread:.0022,heatShot:.0028,heatMax:.012,
   kick:.0062,kickAds:.0026,recoilV:.0075,recoilH:.003,auto:true,
   tracer:0xd8ffc8,tracerW:.03,tracerSpeed:480,scope:true,scopeFov:30,reloadDur:3.4,speedMul:.88},
  sg553:{id:'sg553',name:'SG 553 · 5.56×45MM',slotName:'SG 553',rpm:545,dmg:32,mag:30,reserve:90,
   spreadHip:.021,spreadAds:.004,moveSpread:.0028,heatShot:.004,heatMax:.017,
   kick:.0088,kickAds:.004,recoilV:.0105,recoilH:.004,auto:true,
   tracer:0xffd27f,tracerW:.026,tracerSpeed:450,scope:true,scopeFov:34,reloadDur:3.28,speedMul:.85},
  awp:{id:'awp',name:'AWP · .338 Lapua Magnum',slotName:'AWP',rpm:41,dmg:115,mag:10,reserve:30,
   spreadHip:.06,spreadAds:.0008,moveSpread:.02,heatShot:.02,heatMax:.04,
   kick:.045,kickAds:.03,recoilV:.05,recoilH:.012,auto:false,
   tracer:0xbfe3ff,tracerW:.05,tracerSpeed:640,scope:true,scopeFov:16,reloadDur:3.6,speedMul:.80},
  mp5:{id:'mp5',name:'MP5 · 9×19MM',slotName:'MP5',rpm:800,dmg:26,mag:30,reserve:120,
   spreadHip:.016,spreadAds:.007,moveSpread:.0018,heatShot:.0026,heatMax:.012,
   kick:.0055,kickAds:.003,recoilV:.0065,recoilH:.0026,auto:true,
   tracer:0xffe2a8,tracerW:.024,tracerSpeed:420,reloadDur:2.6,speedMul:.95},
  deagle:{id:'deagle',name:'沙漠之鹰 · .50 AE',nameEn:'Desert Eagle · .50 AE',slotName:'沙漠之鹰',slotEn:'Desert Eagle',rpm:267,dmg:53,mag:7,reserve:35,
   spreadHip:.02,spreadAds:.009,moveSpread:.004,heatShot:.013,heatMax:.032,
   kick:.03,kickAds:.017,recoilV:.023,recoilH:.008,auto:false,
   tracer:0xffe9c8,tracerW:.042,tracerSpeed:540,reloadDur:2.2,speedMul:.98},
  knife:{id:'knife',name:'战术军刀 · 近战',nameEn:'Tactical Knife · Melee',slotName:'军刀',slotEn:'Knife',rpm:150,dmg:40,mag:0,reserve:0,
   spreadHip:0,spreadAds:0,moveSpread:0,heatShot:0,heatMax:0,
   kick:0,kickAds:0,recoilV:0,recoilH:0,auto:false,tracer:0,tracerW:0,melee:true,reloadDur:0,speedMul:1.06},
};

/* 按当前语言取武器名/槽位名(其余武器名本身即为英文) */
export const wName=d=>isEN()&&d.nameEn?d.nameEn:d.name;
export const wSlot=d=>isEN()&&d.slotEn?d.slotEn:d.slotName;

/* 后坐力弹道模式(确定性,可测试):第 i 发的垂直爬升 + 水平漂移(弧度)
   前几发快速爬升,随后水平正弦摆动;ADS 整体收敛。 */
export function recoilShot(def,i,ads){
  const V=def.recoilV??.01, H=def.recoilH??V*.4;
  const climb=Math.min(1,.55+i*.16);
  const up=V*climb*(ads?.55:1);
  const right=(i<4?(i-1.5)*.18:Math.sin(i*1.9))*H*(ads?.5:1);
  return {up,right};
}

export class Weapon{
  constructor(viewScene,assets,audio,ui,quality){
    this.audio=audio;this.ui=ui;this.viewScene=viewScene;this.assets=assets;
    this.group=new THREE.Group();
    viewScene.add(this.group);
    this.models={};
    this.buildAll(assets);
    this._addFPArms(); // 第一人称手臂(随枪继承开火/ADS/切枪动画)

    // 默认 CT 制式装填(开局按所选阵营 setLoadout 重设)
    this.defs=[WEAPON_DEFS.m4a4,WEAPON_DEFS.deagle,WEAPON_DEFS.knife];
    this.primaryCount=1;      // 主武器数量(1 键反复按循环切换)
    this.lastPrimary=0;       // 最近持有的主武器(从副武器/军刀按 1 直接回到它)
    this.cur=0;
    this.state=this.defs.map(d=>({ammo:d.mag,reserve:d.reserve}));
    this.reloading=false;this.reloadT=0;this._reloadSnd=0;
    this.fireT=0;this.adsAmt=0;this.heat=0;
    this.camKick=0;this.gunKickZ=0;this.gunKickRX=0;this.gunKickRY=0;this._slide=0;
    this.camKickYaw=0;this.recoilIdx=0;this.recoilReset=0;
    this.bobT=0;this._trigWasDown=false;this._adsWas=false;
    this.muzzleFlashT=0;
    this.switchT=-1;      // 切枪动画计时
    this.swingT=0;this.swingHeavy=false; // 军刀挥击动画
    // 枪口焰
    this.flash=new THREE.Mesh(new THREE.PlaneGeometry(.3,.3),
      new THREE.MeshBasicMaterial({map:assets.tex.flash,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false}));
    this.flash.visible=false;this.flash.renderOrder=20;
    this.group.add(this.flash);
    this.flashLight=new THREE.PointLight(0xffb060,0,4,2);
    viewScene.add(this.flashLight);
    // 抛壳池
    this.shells=[];
    const sg=new THREE.BoxGeometry(.012,.012,.028);
    for(let i=0;i<14;i++){
      const m=new THREE.Mesh(sg,assets.mats.gunBrass);
      m.visible=false;viewScene.add(m);
      this.shells.push({mesh:m,vel:new THREE.Vector3(),rot:new THREE.Vector3(),t:0,active:false});
    }
    this._equip(0,true);
  }

  /* ================= 模型 ================= */
  _mk(){return new THREE.Group();}
  _box(g,w,h,d,mat,x,y,z,rx=0,ry=0,rz=0){
    const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
    m.position.set(x,y,z);m.rotation.set(rx,ry,rz);
    g.add(m);return m;
  }
  _cyl(g,r,l,mat,x,y,z,rx=Math.PI/2,seg=14){
    const m=new THREE.Mesh(new THREE.CylinderGeometry(r,r,l,seg),mat);
    m.position.set(x,y,z);m.rotation.x=rx;
    g.add(m);return m;
  }

  buildAll(A){
    const M=A.mats;
    /* --- AK-47(T 制式):木护木/木托 + 弯弹匣 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.078,.26,M.gunDark,0,.01,-.04);          // 机匣
      box(.052,.022,.24,M.gunDark,0,.062,-.05);        // 机匣盖
      box(.05,.055,.17,M.gunWood,0,.002,-.25);         // 木护木
      cyl(.013,.07,M.gunDark,0,.02,-.36);              // 导气管
      cyl(.009,.2,M.gunDark,0,.02,-.46);               // 枪管
      box(.014,.055,.012,M.gunDark,0,.052,-.53);       // 准星座
      box(.026,.02,.045,M.gunDark,0,.02,-.565);        // 斜口消焰器
      box(.045,.075,.15,M.gunWood,0,-.008,.16);        // 木托
      box(.03,.09,.048,M.gunWood,0,-.082,.08,-.25);    // 握把
      const mag=this._mk();                            // 弯弹匣(两段)
      this._box(mag,.03,.1,.05,M.gunDark,0,-.05,0,.32);
      this._box(mag,.03,.085,.048,M.gunDark,0,-.115,.028,.62);
      mag.position.set(0,-.045,-.03);
      g.add(mag);g.userData.mag=mag;
      g.userData.muzzle=new THREE.Vector3(0,.02,-.6);   // 枪口端点(组内空间)
      this.models.ak47=g;
    }
    /* --- M4A4(CT 制式):全黑聚合物 + 机瞄框 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.058,.075,.30,M.gunPoly,0,-.01,-.02);
      box(.05,.045,.34,M.gunDark,0,.036,-.04);
      box(.052,.062,.30,M.gunPoly,0,0,-.30);
      box(.02,.016,.30,M.gunDark,0,.045,-.30);
      for(let i=0;i<7;i++)box(.024,.008,.012,M.gunDark,0,.053,-.19-i*.035);
      cyl(.011,.16,M.gunDark,0,.006,-.52);
      box(.024,.024,.055,M.gunDark,0,.006,-.615);
      box(.044,.06,.13,M.gunPoly,0,.005,.20);
      box(.05,.095,.032,M.gunPoly,0,-.005,.27);
      box(.03,.05,.1,M.gunDark,0,-.02,.10);
      box(.032,.105,.05,M.gunPoly,0,-.09,.075,.32);
      g.userData.mag=box(.034,.15,.075,M.gunDark,0,-.105,-.06,.14);
      box(.012,.03,.06,M.gunDark,.031,.012,-.02);
      box(.045,.02,.07,M.gunDark,0,.062,-.06);
      const sy=.098,sz=-.13,hw=.024,hh=.022,t=.006;
      box(hw*2+t,t,.05,M.gunDark,0,sy+hh,sz);
      box(hw*2+t,t,.05,M.gunDark,0,sy-hh,sz);
      box(t,hh*2,.05,M.gunDark,-hw,sy,sz);
      box(t,hh*2,.05,M.gunDark,hw,sy,sz);
      box(.028,.02,.04,M.gunDark,.026,sy-hh-.01,sz+.02);
      g.userData.muzzle=new THREE.Vector3(0,.006,-.65); // 枪口端点(组内空间)
      this.models.m4a4=g;
    }
    /* --- AWP(双阵营 selectable):长管栓动 + 大倍率镜,深绿涂装 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      if(!M.gunGreen)M.gunGreen=new THREE.MeshStandardMaterial({color:0x39463b,roughness:.6,metalness:.3});
      box(.048,.078,.40,M.gunGreen,0,0,-.05);          // 枪身
      cyl(.012,.30,M.gunDark,0,.012,-.42);             // 长枪管
      box(.016,.02,.05,M.gunDark,0,.012,-.575);        // 消焰器
      cyl(.028,.22,M.gunDark,0,.095,-.06);             // 大倍率瞄准镜
      box(.03,.03,.05,M.gunDark,0,.095,.06);           // 镜座
      cyl(.024,.01,M.shades,0,.095,.07);               // 目镜
      box(.014,.03,.06,M.gunDark,.033,.02,.02);        // 栓柄
      g.userData.mag=box(.032,.08,.08,M.gunDark,0,-.07,-.05);
      box(.045,.09,.14,M.gunGreen,0,-.005,.18);        // 托
      box(.05,.02,.1,M.gunGreen,0,.055,.17);           // 贴腮
      box(.03,.09,.045,M.gunPoly,0,-.085,.06,.15);     // 握把
      g.userData.muzzle=new THREE.Vector3(0,.012,-.6);
      this.models.awp=g;
    }
    /* --- MP5(双阵营 selectable):紧凑冲锋枪 + 曲弹匣 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.044,.068,.24,M.gunDark,0,0,-.05);           // 紧凑机匣
      box(.048,.055,.12,M.gunPoly,0,-.002,-.19);       // 护木
      cyl(.008,.1,M.gunDark,0,.006,-.30);              // 短枪管
      box(.014,.04,.012,M.gunDark,0,.042,-.34);        // 准星圈座
      const mp5mag=this._mk();                         // 曲弹匣
      this._box(mp5mag,.026,.09,.04,M.gunDark,0,-.045,0,.18);
      this._box(mp5mag,.026,.07,.038,M.gunDark,0,-.125,.02,.4);
      mp5mag.position.set(0,-.035,-.06);
      g.add(mp5mag);g.userData.mag=mp5mag;
      box(.012,.02,.16,M.gunDark,.028,.008,.06);       // 拉机柄槽
      box(.04,.07,.1,M.gunPoly,0,-.005,.14);           // 伸缩托
      box(.028,.085,.04,M.gunPoly,0,-.08,.05,.18);     // 握把
      g.userData.muzzle=new THREE.Vector3(0,.006,-.36);
      this.models.mp5=g;
    }
    /* --- SG 553(T 制式可选):紧凑突击步枪 + 一体式镜 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.078,.28,M.gunDark,0,0,-.03);            // 机匣
      box(.048,.052,.14,M.gunPoly,0,.004,-.21);        // 护木
      cyl(.01,.14,M.gunDark,0,.01,-.33);               // 枪管
      box(.02,.02,.04,M.gunDark,0,.01,-.41);           // 消焰器
      cyl(.021,.13,M.gunDark,0,.082,-.04);             // 一体式镜筒
      cyl(.017,.01,M.shades,0,.082,.045);              // 目镜
      box(.05,.06,.11,M.gunPoly,0,-.005,.15);          // 折叠托
      box(.03,.09,.045,M.gunPoly,0,-.085,.04,.15);     // 握把
      g.userData.mag=box(.03,.10,.05,M.gunDark,0,-.085,-.02,.1);
      box(.026,.065,.03,M.gunPoly,0,-.07,-.15);        // 前握把
      g.userData.muzzle=new THREE.Vector3(0,.01,-.43);
      this.models.sg553=g;
    }
    /* --- AUG(CT 制式可选):无托结构 + 一体式光学镜 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.085,.30,M.gunPoly,0,0,-.02);            // 无托机匣
      box(.046,.05,.14,M.gunPoly,0,.005,-.24);         // 前护木
      cyl(.01,.12,M.gunDark,0,.008,-.35);              // 短枪管
      box(.02,.02,.04,M.gunDark,0,.008,-.415);         // 消焰器
      cyl(.023,.15,M.gunDark,0,.085,-.03);             // 一体式瞄准镜镜筒
      box(.03,.03,.06,M.gunDark,0,.085,.04);           // 镜身座
      cyl(.019,.01,M.shades,0,.085,.055);              // 目镜(暗色玻璃)
      box(.02,.015,.12,M.gunDark,0,.052,-.14);         // 顶部导轨
      box(.03,.085,.045,M.gunPoly,0,-.085,.03,.15);    // 握把(前置)
      g.userData.mag=box(.032,.11,.05,M.gunDark,0,-.105,-.075,-.12); // 后置弹匣(bullpup 标志)
      box(.048,.075,.12,M.gunPoly,0,-.005,.16);        // 后托
      box(.026,.07,.03,M.gunPoly,0,-.075,-.17);        // 前垂直握把
      g.userData.muzzle=new THREE.Vector3(0,.008,-.44);
      this.models.aug=g;
    }
    /* --- 沙漠之鹰:大滑套 .50 AE --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a);
      const slide=box(.044,.05,.2,M.gunSteel,0,.022,-.05); // 大滑套(射击时后滑)
      g.userData.slide=slide;slide.userData.z0=-.05;
      box(.036,.036,.045,M.gunSteel,0,.022,-.175);     // 枪口块
      box(.008,.016,.012,M.gunSteel,0,.054,-.135);     // 前准星
      box(.014,.018,.012,M.gunSteel,0,.052,.03);       // 后照门
      box(.042,.05,.13,M.gunDark,0,-.018,.03);         // 下机匣
      box(.034,.1,.05,M.gunDark,0,-.09,.06,-.18);      // 握把
      box(.01,.025,.012,M.gunSteel,0,.046,.055);       // 击锤
      box(.012,.02,.05,M.gunDark,0,-.045,-.015);       // 扳机护弓
      g.userData.mag=box(.03,.055,.055,M.gunDark,0,-.075,.055,-.18);
      g.userData.muzzle=new THREE.Vector3(0,.022,-.21); // 枪口端点(组内空间)
      this.models.deagle=g;
    }
    /* --- 战术军刀 --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a);
      box(.02,.044,.095,M.gunDark,0,-.005,.055);       // 刀柄
      for(let i=0;i<3;i++)box(.023,.006,.02,M.gunPoly,0,-.02+i*.018,.075); // 缠柄
      box(.036,.014,.014,M.gunDark,0,-.005,-.005);     // 护手
      box(.007,.03,.15,M.gunSteel,0,0,-.085);          // 刀刃
      box(.007,.02,.05,M.gunSteel,0,.006,-.178,.22);   // 刀尖
      this.models.knife=g;
    }
    /* --- 通用细节件:扳机/护弓/抛壳口(长枪类) --- */
    const trigZ={ak47:.08,m4a4:.075,mp5:.05,sg553:.04,awp:.06,aug:.03};
    for(const id in trigZ){
      const g=this.models[id],z=trigZ[id];
      const box=(...a)=>this._box(g,...a);
      box(.006,.018,.006,M.gunDark,0,-.036,z-.024,.25); // 扳机
      box(.008,.005,.048,M.gunDark,0,-.055,z-.03);      // 护弓下沿
      box(.008,.032,.005,M.gunDark,0,-.038,z-.054);     // 护弓前柱
      box(.004,.016,.05,M.gunDark,(id==='ak47'?.024:.027),.018,-.01); // 抛壳口
    }
    this.group.add(this.models.ak47,this.models.m4a4,this.models.aug,this.models.sg553,
      this.models.awp,this.models.mp5,this.models.deagle,this.models.knife);
    for(const k in this.models)this.models[k].visible=false;
    this.models.m4a4.visible=true;
  }

  /* ================= 第一人称手臂 =================
     单臂 = 挽袖小臂(肤色)+ 袖口(作战服)+ 手;挂在武器模型组内,
     自动继承后坐/ADS/换弹/切枪/军刀挥砍动画。tip=握持点,entry=画面外入场点。 */
  _arm(g,tip,entry,r=.034,opts={}){
    const M=this.assets.mats;
    const dir=entry.clone().sub(tip);
    const len=dir.length();
    const dirN=dir.clone().normalize();
    const fore=new THREE.Mesh(new THREE.CylinderGeometry(r*.78,r,len,12),M.skinN.clone());
    fore.position.copy(tip).addScaledVector(dir,.45);
    fore.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dirN);
    g.add(fore);
    const slv=new THREE.Mesh(new THREE.CylinderGeometry(r*1.1,r*1.3,Math.min(.14,len*.45),12),M.armSleeve.clone());
    slv.position.copy(tip).addScaledVector(dir,.82);
    slv.quaternion.copy(fore.quaternion);
    g.add(slv);
    /* 战术手套:掌体 + 四指横排包裹 + 拇指(组空间:指节朝 -z 包住握把前缘) */
    const glove=M.gloveDark.clone();
    const fist=new THREE.Group();
    const palm=new THREE.Mesh(new THREE.BoxGeometry(r*1.55,r*2.0,r*1.1),glove);
    palm.position.y=r*.1;fist.add(palm);
    for(let i=0;i<4;i++){
      const f=new THREE.Mesh(new THREE.BoxGeometry(r*1.5,r*.48,r*.75),glove);
      f.position.set(0,r*.68-i*r*.5,-r*.7);f.rotation.x=-.16;
      fist.add(f);
    }
    const th=new THREE.Mesh(new THREE.BoxGeometry(r*.48,r*1.0,r*.62),glove);
    th.position.set((opts.side||-1)*r*.9,r*.25,-r*.3);th.rotation.z=.55*(opts.side||-1);
    fist.add(th);
    // 腕口
    const cuff=new THREE.Mesh(new THREE.BoxGeometry(r*1.7,r*.5,r*1.2),M.armSleeve.clone());
    cuff.position.y=r*1.15;fist.add(cuff);
    fist.position.copy(tip);
    fist.position.z+=r*.4; // 拳体后移露出指节,别埋进握把
    fist.rotation.x=opts.tilt!=null?opts.tilt:.15;
    g.add(fist);
  }
  _addFPArms(){
    // 步枪:右手握把 + 左手压护木上沿(双手均为战术手套,袖口在画面边缘内)
    for(const id of['ak47','m4a4']){
      const g=this.models[id];
      this._arm(g,new THREE.Vector3(.012,-.075,.08),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(g,new THREE.Vector3(-.005,-.012,-.24),new THREE.Vector3(-.14,-.22,-.04),.038,{tilt:1.0,side:1});
    }
    // AUG:握把 + 前垂直握把
    {
      const ag=this.models.aug;
      this._arm(ag,new THREE.Vector3(.01,-.075,.05),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(ag,new THREE.Vector3(-.005,-.062,-.16),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.95,side:1});
    }
    // SG 553:握把 + 前握把
    {
      const sg=this.models.sg553;
      this._arm(sg,new THREE.Vector3(.01,-.078,.045),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(sg,new THREE.Vector3(-.005,-.062,-.145),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.95,side:1});
    }
    // AWP:右手握把 + 左手托护木前部
    {
      const aw=this.models.awp;
      this._arm(aw,new THREE.Vector3(.012,-.08,.06),new THREE.Vector3(.13,-.25,.18),.035,{tilt:.12,side:-1});
      this._arm(aw,new THREE.Vector3(-.008,-.024,-.2),new THREE.Vector3(-.14,-.24,-.04),.038,{tilt:.95,side:1});
    }
    // MP5:右手握把 + 左手托护木
    {
      const m5=this.models.mp5;
      this._arm(m5,new THREE.Vector3(.01,-.072,.05),new THREE.Vector3(.13,-.25,.18),.035,{tilt:.12,side:-1});
      this._arm(m5,new THREE.Vector3(-.008,-.058,-.18),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.9,side:1});
    }
    // 沙鹰:双手合握
    const dg=this.models.deagle;
    this._arm(dg,new THREE.Vector3(.01,-.075,.06),new THREE.Vector3(.13,-.24,.26),.032,{tilt:.12,side:-1});
    this._arm(dg,new THREE.Vector3(.045,-.058,.02),new THREE.Vector3(-.12,-.22,.14),.03,{tilt:.5,side:1});
    // 军刀:单手反握
    this._arm(this.models.knife,new THREE.Vector3(0,-.045,.05),new THREE.Vector3(.13,-.22,.24),.033,{tilt:.45,side:-1});
  }

  /* ================= 装填(阵营定装:全部主武器随身) ================= */
  setLoadout(primaryIds,startIndex=0){
    const list=(Array.isArray(primaryIds)?primaryIds:[primaryIds])
      .map(id=>WEAPON_DEFS[id]).filter(Boolean);
    if(!list.length)list.push(WEAPON_DEFS.m4a4);
    this.defs=[...list,WEAPON_DEFS.deagle,WEAPON_DEFS.knife];
    this.primaryCount=list.length;
    this.state=this.defs.map(d=>({ammo:d.mag,reserve:d.reserve}));
    this.reloading=false;
    this.cur=Math.min(startIndex,this.primaryCount-1);
    this.lastPrimary=this.cur;
    this._equip(this.cur,true);
    this.ui.setSlotNames(this.defs.map(wSlot));
  }

  /* ================= 切换(CS 槽位语义) =================
     1 = 主武器槽:已在主武器上时反复按在 4 把之间循环;在副武器/军刀上按 1 回到最近主武器
     2 = 沙漠之鹰  3 = 军刀  滚轮 = 全部武器顺序切换 */
  switchTo(idx){
    if(idx<0||idx>=this.defs.length)return;
    if(this.switchT>=0)return;
    let target=idx;
    if(idx===0&&this.primaryCount>1){
      // 主武器槽:同槽循环
      target=this.cur<this.primaryCount?(this.cur+1)%this.primaryCount:this.lastPrimary;
      if(target===this.cur)return;
    }
    if(target===this.cur)return;
    this.switchT=0;
    this._pending=target;
    this.reloading=false;
    this.audio.reload(2);
  }
  _equip(idx,instant){
    this.cur=idx;
    if(idx<this.primaryCount)this.lastPrimary=idx;
    for(const k in this.models)this.models[k].visible=false;
    this.models[this.defs[idx].id].visible=true;
    if(instant)this.group.position.copy(HIP_POS);
    this.ui.weaponSlots(idx);
    const d=this.defs[idx],s=this.state[idx];
    this.ui.setAmmo(d.melee?-1:s.ammo,d.melee?0:s.reserve,this.reloading,wName(d));
    this.recoilIdx=0;this.camKickYaw=0;
    // 武器负重移速(CS 机制:持重武器移动更慢)
    this.speedCb&&this.speedCb(d.speedMul||1);
  }
  get def(){return this.defs[this.cur];}
  get st(){return this.state[this.cur];}
  get muzzleLocal(){
    // 相机空间近似:枪组实时位姿 + 枪口端点(随 ADS/后坐/呼吸摆动同步变化)
    return this.muzzleCameraLocal(new THREE.Vector3());
  }
  muzzleCameraLocal(target){
    // 可传入复用向量,热路径零分配
    const d=this.def;
    if(d.melee)return target.copy(this.group.position);
    const tip=this.models[d.id].userData.muzzle;
    return tip?target.copy(this.group.position).add(tip):target.copy(this.group.position);
  }

  spreadRad(player){
    const d=this.def;
    let s=this.adsAmt>.7?d.spreadAds:d.spreadHip;
    s+=(1-this.adsAmt)*Math.min(.016,player.vel.length()*d.moveSpread);
    if(player.airborne)s+=.045;   // 跳跃中精准度崩坏(CS 机制)
    if(player.crouching)s*=.62;   // 蹲伏更稳
    s+=this.heat;
    return s;
  }

  startReload(){
    if(this.def.melee)return;
    const s=this.st;
    if(this.reloading||s.ammo>=this.def.mag||s.reserve<=0)return;
    this.reloading=true;this.reloadT=0;this._reloadSnd=0;
  }

  finishReload(){
    const s=this.st;
    const need=this.def.mag-s.ammo;
    const take=Math.min(need,s.reserve);
    s.ammo+=take;s.reserve-=take;
    this.reloading=false;
  }

  _swing(heavy,fireCb){
    const d=this.def;
    this.fireT=heavy?1.0:60/d.rpm;
    this.swingT=1;this.swingHeavy=heavy;
    this.audio.knifeSwing();
    fireCb(0,{melee:true,heavy});
  }

  update(dt,input,player,cam,time,fireCb){
    // 切枪动画
    if(this.switchT>=0){
      this.switchT+=dt;
      const half=.16;
      if(this.switchT<half){
        const k=this.switchT/half;
        this.group.position.lerpVectors(HIP_POS,LOWER_POS,k);
      }else if(this.switchT<half*2){
        if(this._pending!==undefined&&this._pending!==this.cur){this._equip(this._pending);this._pending=undefined;}
        const k=(this.switchT-half)/half;
        this.group.position.lerpVectors(LOWER_POS,HIP_POS,k);
      }else{
        this.group.position.copy(HIP_POS);
        this.switchT=-1;
      }
      this.ui.reloadRing(-1);
      // 切枪期间不射击
      this.camKick*=Math.max(0,1-7*dt);
      this.gunKickZ*=Math.max(0,1-9*dt);this.gunKickRX*=Math.max(0,1-9*dt);this.gunKickRY*=Math.max(0,1-7*dt);
      this.camKickYaw*=Math.max(0,1-6*dt);
      this._slide=Math.max(0,this._slide-dt*9);
      this._trigWasDown=!!input.firing;this._adsWas=!!input.ads;
      return;
    }

    const d=this.def,s=this.st;

    // ADS(军刀无瞄准)
    const wantAds=input.ads&&!d.melee&&!this.reloading&&!player.sprinting;
    this.adsAmt+=((wantAds?1:0)-this.adsAmt)*Math.min(1,10*dt);

    // 换弹
    const rdur=d.reloadDur/(this.reloadSpeedMul||1);
    if(this.reloading){
      this.reloadT+=dt;
      const ph=this.reloadT/rdur;
      if(ph>.12&&this._reloadSnd===0){this.audio.reload(0);this._reloadSnd=1;this.models[d.id].userData.mag.position.y-=.05;this.models[d.id].userData.mag.rotation.z=.3;}
      if(ph>.5&&this._reloadSnd===1){this.audio.reload(1);this._reloadSnd=2;this.models[d.id].userData.mag.position.y+=.05;this.models[d.id].userData.mag.rotation.z=0;}
      if(ph>.82&&this._reloadSnd===2){this.audio.reload(2);this._reloadSnd=3;}
      this.ui.reloadRing(Math.min(1,ph));
      if(this.reloadT>=rdur){this.finishReload();this.ui.reloadRing(-1);}
    }else this.ui.reloadRing(-1);

    // 开火
    this.fireT-=dt;
    if(d.melee){
      // 军刀:左键挥砍(40)/ 右键重刺(65)
      const slash=input.firing&&!this._trigWasDown;
      const stab=input.ads&&!this._adsWas;
      if(slash&&this.fireT<=0)this._swing(false,fireCb);
      else if(stab&&this.fireT<=0)this._swing(true,fireCb);
    }else{
      const canFire=!this.reloading&&s.ammo>0&&!player.sprinting;
      const trig=input.firing&&s.ammo>0;
      const wantFire=d.auto?trig:(trig&&!this._trigWasDown); // 半自动:扳机沿触发
      if(wantFire&&canFire&&this.fireT<=0){
        this.fireT=60/d.rpm;
        s.ammo--;
        this.heat=Math.min(d.heatMax,this.heat+d.heatShot);
        const ads=this.adsAmt;
        this.camKick+= ads>.7?d.kickAds:d.kick;
        // 后坐力弹道模式:确定性垂直爬升 + 水平漂移(CS 风格压枪)
        const rec=recoilShot(d,this.recoilIdx,ads>.7);
        this.camKick+=rec.up;
        this.camKickYaw+=rec.right;
        this.recoilIdx=Math.min(40,this.recoilIdx+1);
        this.recoilReset=.35;
        this.gunKickZ=Math.min(.07,this.gunKickZ+(d.id==='deagle'?.03:.018));
        this.gunKickRX=Math.min(.12,this.gunKickRX+(d.id==='deagle'?.05:.03));
        this.gunKickRY+=(Math.random()-.5)*(d.id==='deagle'?.05:.02); // 随机水平甩动
        this.gunKickRY=Math.max(-.07,Math.min(.07,this.gunKickRY));
        if(d.id==='deagle')this._slide=1; // 套筒后滑
        this.muzzleFlashT=d.id==='deagle'?.05:.045;
        this._ejectShell();
        if(d.id==='deagle')this.audio.deagle();
        else this.audio.shot();
        fireCb(this.spreadRad(player));
      }
      if(!input.firing&&s.ammo===0&&!this._emptyClicked){
        this._emptyClicked=true;this.audio.empty();
        this.startReload();
      }
      if(input.firing)this._emptyClicked=false;
      this.heat=Math.max(0,this.heat-dt*.010);
      // 停火后弹道模式复位
      if(input.firing)this.recoilReset=.35;
      else{
        this.recoilReset-=dt;
        if(this.recoilReset<=0)this.recoilIdx=0;
      }
    }
    this._trigWasDown=!!input.firing;
    this._adsWas=!!input.ads;

    // 后坐恢复
    this.camKick*=Math.max(0,1-7*dt);
    this.gunKickZ*=Math.max(0,1-9*dt);
    this.gunKickRX*=Math.max(0,1-9*dt);
    this.gunKickRY*=Math.max(0,1-7*dt);
    this.camKickYaw*=Math.max(0,1-6*dt);
    this._slide=Math.max(0,this._slide-dt*9);

    // 姿态
    const spd=player.vel.length();
    if(spd>.5)this.bobT+=dt*spd*1.9;
    const bobA=(1-this.adsAmt*.85)*(player.sprinting?.35:1);
    const bx=Math.cos(this.bobT)*.006*bobA;
    const by=Math.sin(this.bobT*2)*.005*bobA;

    const pos=this.group.position,rot=this.group.rotation;
    if(player.sprinting&&this.adsAmt<.4){
      pos.lerp(SPRINT_POS,Math.min(1,8*dt));
      rot.x+=(SPRINT_ROT.x-rot.x)*Math.min(1,8*dt);
      rot.y+=(SPRINT_ROT.y-rot.y)*Math.min(1,8*dt);
      rot.z+=(SPRINT_ROT.z-rot.z)*Math.min(1,8*dt);
    }else{
      const target=HIP_POS.clone().lerp(ADS_POS,this.adsAmt);
      pos.lerp(target,Math.min(1,12*dt));
      rot.x+=((HIP_ROT.x+(1-this.adsAmt)*-.02)-rot.x)*Math.min(1,12*dt);
      rot.y+=((HIP_ROT.y*(1-this.adsAmt))-rot.y)*Math.min(1,12*dt);
      rot.z+=(0-rot.z)*Math.min(1,12*dt);
    }
    pos.x+=bx;pos.y+=by;
    pos.z+=this.gunKickZ;
    rot.x-=this.gunKickRX;
    rot.y+=this.gunKickRY;
    // 套筒后滑(沙鹰)
    const slide=this.models[d.id].userData.slide;
    if(slide)slide.position.z=slide.userData.z0+this._slide*.06;
    if(this.reloading){
      const ph=this.reloadT/rdur;
      rot.z+=Math.sin(ph*Math.PI)*.5;
      rot.x+=Math.sin(ph*Math.PI*2)*.06;
    }
    // 军刀挥击动画
    if(this.swingT>0){
      this.swingT=Math.max(0,this.swingT-dt*(this.swingHeavy?1.6:2.6));
      const a=Math.sin(this.swingT*Math.PI);
      if(this.swingHeavy){pos.z-=a*.22;rot.x-=a*.5;}
      else{pos.z-=a*.1;rot.z-=a*.85;rot.x+=a*.18;}
    }

    // 枪口焰(对准真实枪口端点,组内空间)
    if(this.muzzleFlashT>0){
      this.muzzleFlashT-=dt;
      const tip=this.models[d.id].userData.muzzle;
      if(tip){
        this.flash.visible=true;
        this.flash.position.copy(tip);
        this.flash.position.z-=.035; // 略前伸,避免被准星遮住
        this.flash.rotation.z=Math.random()*Math.PI*2;
        const sc=d.id==='deagle'?.62:.95;
        const fs=(0.85+Math.random()*.5)*sc;
        this.flash.scale.set(fs,fs,1);
        this.flash.material.color.setHex(0xfff2dc);
        this.flashLight.position.copy(this.group.localToWorld(tip.clone()));
        this.flashLight.intensity=d.id==='deagle'?10:8;
      }else this.flash.visible=false;
    }else{
      this.flash.visible=false;
      this.flashLight.intensity*=Math.max(0,1-25*dt);
    }

    // 抛壳
    for(const sh of this.shells){
      if(!sh.active)continue;
      sh.t+=dt;
      if(sh.t>.8){sh.active=false;sh.mesh.visible=false;continue;}
      sh.vel.y-=9.8*dt;
      sh.mesh.position.addScaledVector(sh.vel,dt);
      sh.mesh.rotation.x+=sh.rot.x*dt;sh.mesh.rotation.y+=sh.rot.y*dt;
    }

    this.ui.setAmmo(d.melee?-1:s.ammo,d.melee?0:s.reserve,this.reloading,wName(d));
    this.ui.weaponSlots(this.cur);
  }

  /* 语言切换后刷新当前武器文案 */
  refreshLang(){
    const d=this.def,s=this.st;
    this.ui.setSlotNames(this.defs.map(wSlot));
    this.ui.setAmmo(d.melee?-1:s.ammo,d.melee?0:s.reserve,this.reloading,wName(d));
  }

  _ejectShell(){
    const s=this.shells.find(x=>!x.active);if(!s)return;
    s.active=true;s.t=0;s.mesh.visible=true;
    s.mesh.position.set(.031,.012,-.02);
    s.mesh.scale.setScalar(1);
    s.vel.set(.14+Math.random()*.08,.14+Math.random()*.06,-.02+Math.random()*.05);
    s.rot.set(14+Math.random()*10,10+Math.random()*8,8+Math.random()*6);
  }

  resetAmmo(){
    this.state.forEach((st,i)=>{st.ammo=this.defs[i].mag;st.reserve=this.defs[i].reserve;});
    this.reloading=false;this._equip(0,true);
  }
  addReserve(n){
    this.defs.forEach((d,i)=>{
      if(!d.melee)this.state[i].reserve=Math.min(999,this.state[i].reserve+n);
    });
  }
}
