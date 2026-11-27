// weapon.js — weapon system: 1 primary (all 4 faction primaries carried, press 1 to cycle) 2 Desert Eagle 3 UMP-45 backup SMG
// semi-auto / full-auto triggers · viewmodel recoil / ADS / reload / switching / muzzle flash / shell ejection
import * as THREE from 'three';
import {isEN} from './i18n.js';

const HIP_POS=new THREE.Vector3(.22,-.205,-.44);
const HIP_ROT=new THREE.Euler(0,-.07,0);
const ADS_POS=new THREE.Vector3(0,-.098,-.34);
const ADS_ROT=new THREE.Euler(0,0,0);
const SPRINT_POS=new THREE.Vector3(.18,-.3,-.4);
/* Hot-path scratch: the view-model pose/muzzle run every frame and used to allocate a
   Vector3 per frame (HIP_POS.clone(), tip.clone()), which fed the GC on long sessions. */
const _hipPos=new THREE.Vector3();
const _muzzleWorld=new THREE.Vector3();
const SPRINT_ROT=new THREE.Euler(.32,-.5,.18);
const LOWER_POS=new THREE.Vector3(.16,-.42,-.42); // lowered while switching

/* Weapon table (stats modelled on the real-world guns: damage / fire rate / magazine / reload / move speed while held) */
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
  awp:{id:'awp',name:'LONGBOW · .338 Lapua Magnum',slotName:'LONGBOW',rpm:41,dmg:115,mag:10,reserve:30,
   spreadHip:.042,spreadAds:.0008,moveSpread:.014,heatShot:.004,heatMax:.008,
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
  ump45:{id:'ump45',name:'UMP-45 · .45 ACP',slotName:'UMP-45',rpm:600,dmg:34,mag:25,reserve:75,
   spreadHip:.019,spreadAds:.0068,moveSpread:.0022,heatShot:.0034,heatMax:.015,
   kick:.0078,kickAds:.0044,recoilV:.0102,recoilH:.0042,auto:true,
   tracer:0xffd7a2,tracerW:.027,tracerSpeed:440,reloadDur:2.9,speedMul:.97,adsLift:.043},
};
// Static balance table must not be mutable from the console; clones made by setLoadout stay editable.
for(const d of Object.values(WEAPON_DEFS))Object.freeze(d);
Object.freeze(WEAPON_DEFS);

/* Weapon / slot name for the current language (the other weapon names are already English) */
export const wName=d=>isEN()&&d.nameEn?d.nameEn:d.name;
export const wSlot=d=>isEN()&&d.slotEn?d.slotEn:d.slotName;

/* Recoil pattern (deterministic, testable): vertical climb + horizontal drift (radians) of shot i
   climbs quickly over the first shots, then sways horizontally; ADS tightens the whole pattern. */
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
    this.faction='ct';
    this.armMats={sleeve:assets.mats.armSleeveCT,glove:assets.mats.gloveCT,skin:assets.mats.skinM};
    this._armSleeves=[];this._armGloves=[];this._armSkins=[]; // first-person arm material clones (C3 recolour per faction)
    this.group=new THREE.Group();
    viewScene.add(this.group);
    this.models={};
    this.buildAll(assets);
    this._addFPArms(); // first-person arms (inherit the gun's fire / ADS / switch animations)

    // Default Nova loadout (setLoadout resets it for the chosen faction at match start)
    this.defs=[WEAPON_DEFS.m4a4,WEAPON_DEFS.deagle,WEAPON_DEFS.ump45];
    this.primaryCount=1;      // number of primaries (pressing 1 repeatedly cycles them)
    this.lastPrimary=0;       // last primary held (1 returns straight to it from the pistol / SMG)
    this.cur=0;
    this.state=this.defs.map(d=>({ammo:d.mag,reserve:d.reserve}));
    this.reloading=false;this.reloadT=0;this._reloadSnd=0;
    this.fireT=0;this.adsAmt=0;this.heat=0;
    this.recoilMul=1;this.reloadSpeedMul=1;this.rpmMul=1;
    this.camKick=0;this.gunKickZ=0;this.gunKickRX=0;this.gunKickRY=0;this._slide=0;
    this.camKickYaw=0;this.recoilIdx=0;this.recoilReset=0;
    this.bobT=0;this._trigWasDown=false;
    this._shotBuf=0;      // semi-auto: seconds left on a queued shot (see update())
    this.muzzleFlashT=0;
    this.switchT=-1;      // weapon switch animation timer
    // Muzzle flash
    this.flash=new THREE.Mesh(new THREE.PlaneGeometry(.3,.3),
      new THREE.MeshBasicMaterial({map:assets.tex.flash,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,depthTest:false}));
    this.flash.visible=false;this.flash.renderOrder=20;
    this.group.add(this.flash);
    this.flashLight=new THREE.PointLight(0xffb060,0,4,2);
    viewScene.add(this.flashLight);
    // Shell casing pool
    this.shells=[];
    const sg=new THREE.BoxGeometry(.012,.012,.028);
    for(let i=0;i<14;i++){
      const m=new THREE.Mesh(sg,assets.mats.gunBrass);
      m.visible=false;viewScene.add(m);
      this.shells.push({mesh:m,vel:new THREE.Vector3(),rot:new THREE.Vector3(),t:0,active:false});
    }
    this._equip(0,true);
  }

  /* ================= Models ================= */
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
    /* --- AK-47 (Rogue issue): wooden handguard / stock + curved magazine --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.078,.26,M.gunDark,0,.01,-.04);          // receiver
      box(.052,.022,.24,M.gunDark,0,.062,-.05);        // dust cover
      box(.05,.055,.17,M.gunWood,0,.002,-.25);         // wooden handguard
      cyl(.013,.07,M.gunDark,0,.02,-.36);              // gas tube
      cyl(.009,.2,M.gunDark,0,.02,-.46);               // barrel
      box(.014,.055,.012,M.gunDark,0,.052,-.53);       // front sight block
      box(.026,.02,.045,M.gunDark,0,.02,-.565);        // slant muzzle brake
      box(.045,.075,.15,M.gunWood,0,-.008,.16);        // wooden stock
      box(.03,.09,.048,M.gunWood,0,-.082,.08,-.25);    // grip
      const mag=this._mk();                            // curved magazine (two segments)
      this._box(mag,.03,.1,.05,M.gunDark,0,-.05,0,.32);
      this._box(mag,.03,.085,.048,M.gunDark,0,-.115,.028,.62);
      mag.position.set(0,-.025,-.03);
      g.add(mag);g.userData.mag=mag;
      g.userData.muzzle=new THREE.Vector3(0,.02,-.6);   // muzzle point (group space)
      this.models.ak47=g;
    }
    /* --- M4A4 (Nova issue): all-black polymer + iron sight frame --- */
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
      g.userData.muzzle=new THREE.Vector3(0,.006,-.65); // muzzle point (group space)
      this.models.m4a4=g;
    }
    /* --- Longbow (both factions): long bolt-action barrel + high-power scope, olive drab --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      if(!M.gunGreen)M.gunGreen=new THREE.MeshStandardMaterial({color:0x39463b,roughness:.6,metalness:.3});
      box(.048,.078,.40,M.gunGreen,0,0,-.05);          // body
      cyl(.012,.34,M.gunDark,0,.012,-.42);             // long barrel (reaches into the receiver)
      box(.016,.02,.05,M.gunDark,0,.012,-.575);        // flash hider
      cyl(.028,.22,M.gunDark,0,.095,-.06);             // high-power scope
      box(.03,.03,.05,M.gunDark,0,.095,.06);           // scope mount
      box(.03,.032,.05,M.gunDark,0,.051,-.16);         // front scope riser (receiver → tube)
      box(.03,.032,.05,M.gunDark,0,.051,.055);         // rear scope riser
      cyl(.024,.01,M.shades,0,.095,.07);               // eyepiece
      box(.014,.03,.06,M.gunDark,.033,.02,.02);        // bolt handle
      // Details: elevation / windage turrets + bolt knob
      this._box(g,.014,.014,.014,M.gunDark,0,.129,-.06);
      this._box(g,.012,.012,.014,M.gunDark,.034,.095,-.06);
      const boltBall=new THREE.Mesh(new THREE.SphereGeometry(.011,10,8),M.gunDark);
      boltBall.position.set(.033,.02,.052);g.add(boltBall);
      g.userData.mag=box(.032,.08,.08,M.gunDark,0,-.07,-.05);
      box(.045,.09,.14,M.gunGreen,0,-.005,.18);        // stock
      box(.05,.02,.1,M.gunGreen,0,.048,.17);           // cheek rest
      box(.03,.09,.045,M.gunPoly,0,-.085,.06,.15);     // grip
      g.userData.muzzle=new THREE.Vector3(0,.012,-.6);
      this.models.awp=g;
    }
    /* --- MP5 (both factions): compact SMG + curved magazine --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.044,.068,.24,M.gunDark,0,0,-.05);           // compact receiver
      box(.048,.055,.12,M.gunPoly,0,-.002,-.19);       // handguard
      cyl(.008,.1,M.gunDark,0,.006,-.30);              // short barrel
      box(.03,.04,.012,M.gunDark,0,.03,-.34);          // front sight ring base (hood sits on the barrel)
      const mp5mag=this._mk();                         // curved magazine
      this._box(mp5mag,.026,.09,.04,M.gunDark,0,-.045,0,.18);
      this._box(mp5mag,.026,.07,.038,M.gunDark,0,-.125,.02,.4);
      mp5mag.position.set(0,-.035,-.06);
      g.add(mp5mag);g.userData.mag=mp5mag;
      box(.012,.02,.16,M.gunDark,.028,.008,.06);       // charging handle slot
      box(.04,.07,.1,M.gunPoly,0,-.005,.14);           // collapsible stock
      box(.028,.085,.04,M.gunPoly,0,-.08,.05,.18);     // grip
      g.userData.muzzle=new THREE.Vector3(0,.006,-.36);
      this.models.mp5=g;
    }
    /* --- SG 553 (Rogue option): compact assault rifle + integrated scope --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.078,.28,M.gunDark,0,0,-.03);            // receiver
      box(.048,.052,.14,M.gunPoly,0,.004,-.21);        // handguard
      cyl(.01,.14,M.gunDark,0,.01,-.33);               // barrel
      box(.02,.02,.04,M.gunDark,0,.01,-.41);           // flash hider
      cyl(.021,.13,M.gunDark,0,.082,-.04);             // integrated scope tube
      box(.03,.032,.14,M.gunDark,0,.048,-.03);         // scope mount rail (receiver → tube)
      cyl(.017,.01,M.shades,0,.082,.03);               // eyepiece
      box(.05,.06,.11,M.gunPoly,0,-.005,.15);          // folding stock
      box(.03,.09,.045,M.gunPoly,0,-.085,.04,.15);     // grip
      g.userData.mag=box(.03,.10,.05,M.gunDark,0,-.085,-.02,.1);
      box(.026,.065,.03,M.gunPoly,0,-.07,-.15);        // foregrip
      g.userData.muzzle=new THREE.Vector3(0,.01,-.43);
      this.models.sg553=g;
    }
    /* --- AUG (Nova option): bullpup + integrated optic --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.085,.30,M.gunPoly,0,0,-.02);            // bullpup receiver
      box(.046,.05,.14,M.gunPoly,0,.005,-.24);         // front handguard
      cyl(.01,.12,M.gunDark,0,.008,-.35);              // short barrel
      box(.02,.02,.04,M.gunDark,0,.008,-.415);         // flash hider
      cyl(.023,.15,M.gunDark,0,.085,-.03);             // integrated scope tube
      box(.03,.03,.06,M.gunDark,0,.085,.04);           // scope body mount
      cyl(.019,.01,M.shades,0,.085,.055);              // eyepiece (dark glass)
      box(.02,.015,.12,M.gunDark,0,.052,-.14);         // top rail
      box(.03,.085,.045,M.gunPoly,0,-.085,.03,.15);    // grip (forward)
      g.userData.mag=box(.032,.11,.05,M.gunDark,0,-.09,-.075,-.12); // rear magazine (bullpup signature)
      box(.048,.075,.12,M.gunPoly,0,-.005,.16);        // butt
      box(.026,.07,.03,M.gunPoly,0,-.075,-.17);        // vertical foregrip
      g.userData.muzzle=new THREE.Vector3(0,.008,-.44);
      this.models.aug=g;
    }
    /* --- Desert Eagle: large-slide .50 AE --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a);
      const slide=box(.044,.05,.2,M.gunSteel,0,.022,-.05); // large slide (cycles back when firing)
      g.userData.slide=slide;slide.userData.z0=-.05;
      // Slide serrations (attached to the slide so they follow the recoil animation)
      for(let i=0;i<3;i++)for(const sx of[-1,1])
        this._box(slide,.004,.036,.006,M.gunDark,sx*.0225,.022,.02-i*.014);
      box(.036,.036,.045,M.gunSteel,0,.022,-.172);     // muzzle block
      box(.008,.016,.012,M.gunSteel,0,.054,-.135);     // front sight
      box(.014,.018,.012,M.gunSteel,0,.052,.03);       // rear sight
      box(.042,.05,.13,M.gunDark,0,-.018,.03);         // lower frame
      box(.034,.1,.05,M.gunDark,0,-.09,.06,-.18);      // grip
      box(.01,.025,.012,M.gunSteel,0,.046,.055);       // hammer
      box(.012,.02,.05,M.gunDark,0,-.045,-.015);       // trigger guard
      g.userData.mag=box(.03,.055,.055,M.gunDark,0,-.075,.055,-.18);
      g.userData.muzzle=new THREE.Vector3(0,.022,-.21); // muzzle point (group space)
      this.models.deagle=g;
    }
    /* --- UMP-45 (both factions): compact .45 SMG, straight magazine + folding stock --- */
    {
      const g=this._mk();
      const box=(...a)=>this._box(g,...a),cyl=(...a)=>this._cyl(g,...a);
      box(.05,.075,.24,M.gunPoly,0,0,-.04);            // boxy polymer receiver
      box(.03,.012,.20,M.gunDark,0,.043,-.04);         // top rail (sits on the receiver)
      // Rear sight: an open frame (not a solid block) so the front post stays visible in ADS
      box(.026,.005,.012,M.gunDark,0,.047,.028);       // frame bottom
      box(.026,.005,.012,M.gunDark,0,.072,.028);       // frame top
      box(.005,.03,.012,M.gunDark,-.0105,.0595,.028);  // frame left post
      box(.005,.03,.012,M.gunDark,.0105,.0595,.028);   // frame right post
      box(.012,.028,.014,M.gunDark,0,.055,-.142);      // front sight post
      box(.046,.052,.13,M.gunPoly,0,-.002,-.215);      // handguard
      cyl(.009,.10,M.gunDark,0,.008,-.32);             // short barrel
      box(.02,.02,.03,M.gunDark,0,.008,-.372);         // muzzle collar
      box(.038,.05,.06,M.gunPoly,0,-.05,-.055);        // magwell
      const mag=this._mk();                            // straight .45 magazine
      this._box(mag,.03,.11,.05,M.gunDark,0,-.055,0,.1);
      this._box(mag,.032,.006,.052,M.gunDark,0,-.105,0); // base plate
      mag.position.set(0,-.055,-.05);
      g.add(mag);g.userData.mag=mag;
      box(.032,.10,.045,M.gunPoly,0,-.075,.062,.18);   // pistol grip
      box(.008,.005,.055,M.gunDark,0,-.062,.006);      // trigger guard bottom
      box(.008,.028,.006,M.gunDark,0,-.048,-.02);      // guard front post
      box(.006,.016,.006,M.gunDark,0,-.045,-.002,.2);  // trigger
      box(.008,.02,.14,M.gunPoly,-.017,.005,.15);      // folding stock rail L
      box(.008,.02,.14,M.gunPoly,.017,.005,.15);       // folding stock rail R
      box(.05,.07,.014,M.gunPoly,0,0,.226);            // butt plate
      box(.004,.016,.05,M.gunDark,.027,.015,-.02);     // ejection port
      box(.012,.012,.04,M.gunDark,-.03,.02,-.03);      // charging handle
      g.userData.muzzle=new THREE.Vector3(0,.008,-.39);
      this.models.ump45=g;
    }
    /* --- Shared details: trigger / guard / ejection port (long guns) --- */
    const trigZ={ak47:.08,m4a4:.075,mp5:.05,sg553:.04,awp:.06,aug:.03};
    for(const id in trigZ){
      const g=this.models[id],z=trigZ[id];
      const box=(...a)=>this._box(g,...a);
      box(.006,.018,.006,M.gunDark,0,-.036,z-.024,.25); // trigger
      box(.008,.005,.048,M.gunDark,0,-.055,z-.03);      // guard bottom
      box(.008,.032,.005,M.gunDark,0,-.038,z-.054);     // guard front post
      box(.004,.016,.05,M.gunDark,(id==='ak47'?.024:.027),.018,-.01); // ejection port
    }
    /* --- Extra detail: magazine ribs / front sight wings / butt plates --- */
    const ribs={ak47:[.034,.05],m4a4:[.036,.06],awp:[.034,.064],mp5:[.03,.036],sg553:[.032,.042],aug:[.034,.042]};
    for(const id in ribs){
      const mag=this.models[id].userData.mag;
      if(!mag)continue;
      const [w,d]=ribs[id];
      this._box(mag,w,.005,d,M.gunDark,0,.03,0);   // magazine top rib
      this._box(mag,w,.005,d,M.gunDark,0,-.03,0);  // magazine bottom rib
    }
    // AK-47 front sight wings
    this._box(this.models.ak47,.004,.028,.02,M.gunDark,-.009,.056,-.53);
    this._box(this.models.ak47,.004,.028,.02,M.gunDark,.009,.056,-.53);
    // MP5 front sight ring wings
    this._box(this.models.mp5,.004,.02,.02,M.gunDark,-.013,.046,-.34);
    this._box(this.models.mp5,.004,.02,.02,M.gunDark,.013,.046,-.34);
    // M4A4 / AK-47 butt plates
    this._box(this.models.m4a4,.05,.08,.014,M.gunPoly,0,-.005,.292);
    this._box(this.models.ak47,.047,.08,.012,M.gunDark,0,-.008,.24);
    this.group.add(this.models.ak47,this.models.m4a4,this.models.aug,this.models.sg553,
      this.models.awp,this.models.mp5,this.models.deagle,this.models.ump45);
    for(const k in this.models)this.models[k].visible=false;
    this.models.m4a4.visible=true;
  }

  /* ================= First-person arms =================
     One arm = full sleeve (uniform) + gloved hand with only the fingertips showing; parented inside
     the weapon model group, so it inherits recoil / ADS / reload / switch animations.
     tip = grip point, entry = off-screen entry point. */
  _arm(g,tip,entry,r=.034,opts={}){
    const M=this.assets.mats;
    // The support arm gets its own group (userData.armSupport) so the reload choreography can
    // drop it away from the handguard and bring it back to the mag well
    const sup=opts.support?new THREE.Group():null;
    if(sup)g.add(sup);
    const add=o=>(sup||g).add(o);
    const dir=entry.clone().sub(tip);
    const len=dir.length();
    const dirN=dir.clone().normalize();
    const skinMat=M.skinN.clone();
    this._armSkins.push(skinMat);
    const fore=new THREE.Mesh(new THREE.CylinderGeometry(r*.78,r,len,12),skinMat);
    fore.position.copy(tip).addScaledVector(dir,.45);
    fore.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dirN);
    add(fore);
    /* The sleeve runs from the entry point down to the wrist and meets the fist's cuff — the
       operator design shows gloved fingertips only. The old rolled sleeve left the whole
       forearm bare, which read as a bright skin blob over the handguard. */
    const sleeveMat=M.armSleeve.clone();
    this._armSleeves.push(sleeveMat);
    const slv=new THREE.Mesh(new THREE.CylinderGeometry(r*1.3,r*1.05,len*.92,12),sleeveMat);
    slv.position.copy(tip).addScaledVector(dir,.5);
    slv.quaternion.copy(fore.quaternion);
    add(slv);
    /* Tactical glove: palm + four wrapped fingers in a row + thumb (group space: knuckles toward -z around the front of the grip).
       Gloved like the operator outfits — only the fingertips break the guard's silhouette (no bare cuff-to-palm skin). */
    const glove=M.gloveDark.clone();
    this._armGloves.push(glove);
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
    // Wrist cuff
    const cuff=new THREE.Mesh(new THREE.BoxGeometry(r*1.7,r*.5,r*1.2),sleeveMat);
    cuff.position.y=r*1.15;fist.add(cuff);
    fist.position.copy(tip);
    fist.position.z+=r*.4; // move the fist back to show the knuckles instead of burying them in the grip
    if(opts.support){
      /* A centred support fist sits fully inside the guard (same size) and its fingers never
         break the silhouette. Nudge it up-forward so just the fingertip boxes crest the
         guard's top face — the character design shows gloved fingertips, not a bare fist. */
      fist.position.y+=r*.55;
      fist.position.z-=r*.45;
    }
    fist.rotation.x=opts.tilt!=null?opts.tilt:.15;
    add(fist);
    // Attachment-integrity check (src/attach.js) ignores the arms: they reach in from
    // off-screen on purpose and are not part of the gun assembly.
    for(const o of [fore,slv,fist])o.traverse(c=>{if(c.isMesh)c.userData.fpArm=true;});
    if(sup)g.userData.armSupport=sup;
  }
  _addFPArms(){
    // Per-model mag baselines for the reload choreography (continuous slide, not threshold nudges)
    for(const id in this.models){const ud=this.models[id].userData;if(ud.mag)ud.magBase={y:ud.mag.position.y,rz:ud.mag.rotation.z};}
    // Rifles: right hand on the grip + left hand over the handguard (both gloved; cuffs stay inside the frame edge)
    for(const id of['ak47','m4a4']){
      const g=this.models[id];
      this._arm(g,new THREE.Vector3(.012,-.075,.08),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(g,new THREE.Vector3(-.005,-.012,-.24),new THREE.Vector3(-.14,-.22,-.04),.038,{tilt:1.0,side:1,support:true});
    }
    // AUG: grip + vertical foregrip
    {
      const ag=this.models.aug;
      this._arm(ag,new THREE.Vector3(.01,-.075,.05),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(ag,new THREE.Vector3(-.005,-.062,-.16),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.95,side:1,support:true});
    }
    // SG 553: grip + foregrip
    {
      const sg=this.models.sg553;
      this._arm(sg,new THREE.Vector3(.01,-.078,.045),new THREE.Vector3(.13,-.25,.18),.036,{tilt:.12,side:-1});
      this._arm(sg,new THREE.Vector3(-.005,-.062,-.145),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.95,side:1,support:true});
    }
    // Longbow: right hand on the grip + left hand under the front of the handguard
    {
      const aw=this.models.awp;
      this._arm(aw,new THREE.Vector3(.012,-.08,.06),new THREE.Vector3(.13,-.25,.18),.035,{tilt:.12,side:-1});
      this._arm(aw,new THREE.Vector3(-.008,-.024,-.2),new THREE.Vector3(-.14,-.24,-.04),.038,{tilt:.95,side:1,support:true});
    }
    // MP5: right hand on the grip + left hand under the handguard
    {
      const m5=this.models.mp5;
      this._arm(m5,new THREE.Vector3(.01,-.072,.05),new THREE.Vector3(.13,-.25,.18),.035,{tilt:.12,side:-1});
      this._arm(m5,new THREE.Vector3(-.008,-.058,-.18),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.9,side:1,support:true});
    }
    // Desert Eagle: two-handed grip
    const dg=this.models.deagle;
    this._arm(dg,new THREE.Vector3(.01,-.075,.06),new THREE.Vector3(.13,-.24,.26),.032,{tilt:.12,side:-1});
    this._arm(dg,new THREE.Vector3(.045,-.058,.02),new THREE.Vector3(-.12,-.22,.14),.03,{tilt:.5,side:1,support:true});
    // UMP-45: right hand on the grip + left hand under the short handguard
    {
      const u=this.models.ump45;
      this._arm(u,new THREE.Vector3(.01,-.078,.062),new THREE.Vector3(.13,-.25,.18),.035,{tilt:.12,side:-1});
      this._arm(u,new THREE.Vector3(-.005,-.03,-.215),new THREE.Vector3(-.13,-.22,-.02),.037,{tilt:.95,side:1,support:true});
    }
  }

  /* C3: first-person arms recoloured by operator faction / gender (Nova blue-grey / Rogue dark red; female skin tone).
     Maps follow the faction bases too — the clone carries the old map, so reassign + needsUpdate (shader variant). */
  setFaction(op){
    if(!op)return;
    const A=this.assets.mats;
    this.faction=op.faction==='t'?'t':'ct';
    const sleeve=this.faction==='ct'?A.armSleeveCT:A.armSleeveT;
    const glove=this.faction==='ct'?A.gloveCT:A.gloveT;
    const skin=op.gender==='f'?A.skinF:A.skinM;
    this.armMats={sleeve,glove,skin};
    const remap=(m,src)=>{
      m.color.copy(src.color);
      m.roughness=src.roughness;m.metalness=src.metalness;
      m.envMapIntensity=src.envMapIntensity;
      const map=src.map||null,nMap=src.normalMap||null,rMap=src.roughnessMap||null;
      if(m.map!==map||m.normalMap!==nMap||m.roughnessMap!==rMap)m.needsUpdate=true;
      m.map=map;m.normalMap=nMap;m.roughnessMap=rMap;
    };
    for(const m of this._armSleeves)remap(m,sleeve);
    for(const m of this._armGloves)remap(m,glove);
    for(const m of this._armSkins)remap(m,skin);
  }

  /* ================= Loadout (faction issue: every primary carried) ================= */
  setLoadout(primaryIds,startIndex=0){
    const list=(Array.isArray(primaryIds)?primaryIds:[primaryIds])
      .map(id=>WEAPON_DEFS[id]).filter(Boolean);
    if(!list.length)list.push(WEAPON_DEFS.m4a4);
    this.defs=[...list,WEAPON_DEFS.deagle,WEAPON_DEFS.ump45];
    this.primaryCount=list.length;
    this.state=this.defs.map(d=>({ammo:d.mag,reserve:d.reserve}));
    this.reloading=false;
    this.cur=Math.min(startIndex,this.primaryCount-1);
    this.lastPrimary=this.cur;
    this._equip(this.cur,true);
    this.ui.setSlotNames(this.defs.map(wSlot));
  }

  /* ================= Switching (slot semantics) =================
     1 = primary slot: pressing it on a primary cycles through all 4; from the pistol / SMG it returns to the last primary
     2 = Desert Eagle  3 = UMP-45  wheel = cycle through every weapon */
  switchTo(idx){
    if(idx<0||idx>=this.defs.length)return;
    if(this.switchT>=0)return;
    let target=idx;
    if(idx===0&&this.primaryCount>1){
      // Primary slot: cycle within the slot
      target=this.cur<this.primaryCount?(this.cur+1)%this.primaryCount:this.lastPrimary;
      if(target===this.cur)return;
    }
    if(target===this.cur)return;
    // Switching cancels an in-progress reload on the CURRENT weapon (CS-style): ammo is
    // not transferred to the new weapon, and re-selecting does not grant an instant mag.
    if(this.reloading){
      this.reloading=false;
      this.reloadT=0;
      this._reloadSnd=0;
      this.ui.reloadRing(-1);
    }
    this.switchT=0;
    this._pending=target;
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
    this.ui.setAmmo(s.ammo,s.reserve,this.reloading,wName(d));
    // Reset reload-pose leftovers when a reload was interrupted by a switch.
    for(const key in this.models){
      const ud=this.models[key].userData;
      if(ud&&ud.mag&&ud.magBase){ud.mag.position.y=ud.magBase.y;ud.mag.rotation.z=ud.magBase.rz;}
      if(ud&&ud.armSupport){ud.armSupport.position.set(0,0,0);ud.armSupport.rotation.z=0;}
    }
    this.recoilIdx=0;this.camKickYaw=0;
    // Weapon weight affects move speed (heavier weapons move slower)
    this.speedCb&&this.speedCb(d.speedMul||1);
  }
  get def(){return this.defs[this.cur];}
  get st(){return this.state[this.cur];}
  get muzzleLocal(){
    // Camera-space approximation: live gun group pose + muzzle point (follows ADS / recoil / sway)
    return this.muzzleCameraLocal(new THREE.Vector3());
  }
  muzzleCameraLocal(target){
    // Accepts a reusable vector: zero allocation on the hot path
    const d=this.def;
    const tip=this.models[d.id].userData.muzzle;
    return tip?target.copy(this.group.position).add(tip):target.copy(this.group.position);
  }

  spreadRad(player){
    const d=this.def;
    /* Blend hip → ADS by the actual zoom amount instead of a hard `adsAmt > .7` switch. The
       old binary test made every shot taken mid-scope (adsAmt .25–.7, i.e. the whole raise /
       lower transition and any moment the scope is eased) inherit the FULL hip cone. For the
       sniper that cone is .06 rad ≈ 1.2 m at 20 m against a .42 m torso, which is why "aiming"
       and "hip firing" both felt like the rifle never hit anything. */
    const k=Math.max(0,Math.min(1,(this.adsAmt-.25)/.55)); // 0 at ≤.25 (pure hip) → 1 at ≥.8
    let s=d.spreadHip+(d.spreadAds-d.spreadHip)*k;
    s+=(1-this.adsAmt)*Math.min(.016,player.vel.length()*d.moveSpread);
    if(player.airborne)s+=.045;   // accuracy collapses while jumping
    if(player.crouching)s*=.62;   // crouching is steadier
    s+=this.heat;
    return s;
  }

  startReload(){
    if(this.switchT>=0)return;            // never start a reload during the switch animation
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

  update(dt,input,player,cam,time,fireCb){
    // Switch animation
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
      // No firing while switching
      this.camKick*=Math.max(0,1-7*dt);
      this.gunKickZ*=Math.max(0,1-9*dt);this.gunKickRX*=Math.max(0,1-9*dt);this.gunKickRY*=Math.max(0,1-7*dt);
      this.camKickYaw*=Math.max(0,1-6*dt);
      this._slide=Math.max(0,this._slide-dt*9);
      // A click made during the swap still counts for a semi-auto: queue it for after the swap
      // (same remaining-cooldown rule as the firing block below, so a Longbow click is not lost)
      if(!this.def.auto&&input.firing&&!this._trigWasDown)
        this._shotBuf=Math.max(this._shotBuf,Math.max(.25,this.fireT+.05));
      this._trigWasDown=!!input.firing;
      return;
    }

    const d=this.def,s=this.st;

    // ADS
    const wantAds=input.ads&&!this.reloading&&!player.sprinting;
    this.adsAmt+=((wantAds?1:0)-this.adsAmt)*Math.min(1,10*dt);

    // Reload
    const rdur=d.reloadDur/(this.reloadSpeedMul||1);
    if(this.reloading){
      this.reloadT+=dt;
      const ph=this.reloadT/rdur;
      const ss=p=>{p=Math.max(0,Math.min(1,p));return p*p*(3-2*p);};
      // The magazine slides out and home continuously (was two discrete threshold nudges)
      const drop=ss(Math.min(1,ph/.3))-ss(Math.max(0,Math.min(1,(ph-.55)/.3)));
      const ud=this.models[d.id].userData;
      if(ud.mag&&ud.magBase){ud.mag.position.y=ud.magBase.y-.075*drop;ud.mag.rotation.z=ud.magBase.rz+.36*drop;}
      // The support hand drops away with the mag and comes back up to the well
      const sup=ud.armSupport;
      if(sup){sup.position.y=-.105*drop;sup.position.z=.055*drop;sup.rotation.z=-.26*drop;}
      if(ph>.12&&this._reloadSnd===0){this.audio.reload(0);this._reloadSnd=1;}
      if(ph>.5&&this._reloadSnd===1){this.audio.reload(1);this._reloadSnd=2;}
      if(ph>.82&&this._reloadSnd===2){this.audio.reload(2);this._reloadSnd=3;}
      this.ui.reloadRing(Math.min(1,ph));
      if(this.reloadT>=rdur){this.finishReload();this.ui.reloadRing(-1);}
    }else this.ui.reloadRing(-1);

    // Fire
    this.fireT-=dt;
    const canFire=!this.reloading&&s.ammo>0&&!player.sprinting;
    const trig=input.firing&&s.ammo>0;
    const wantFire=d.auto?trig:(trig&&!this._trigWasDown); // semi-auto: fires on the trigger edge
    /* Semi-auto: a click that lands during the bolt/recoil cooldown used to be dropped outright,
       so rapid clicks produced nothing at all — the rifle felt like it "never fired". Queue ONE
       shot instead. The window has to span the REMAINING cooldown (the Longbow bolt is 1.46 s),
       so it is stretched to fireT+ε rather than a fixed 0.25 s that expired before the bolt did.
       The bolt pace itself is unchanged: the queued shot leaves the moment the cycle ends. */
    if(!d.auto&&wantFire&&canFire&&this.fireT>0)this._shotBuf=Math.max(this._shotBuf,this.fireT+.05);
    if(this._shotBuf>0)this._shotBuf-=dt;
    const buffered=!d.auto&&this._shotBuf>0&&canFire&&this.fireT<=0;
    if((wantFire&&canFire&&this.fireT<=0)||buffered){
      this._shotBuf=0;
      // Carry over last frame's overshoot (at most one frame) so the fire rate is not rounded down by the frame rate (MP5 @60fps back from ~720 to 800 rpm)
      this.fireT=Math.max(this.fireT,-dt)+60/(d.rpm*(this.rpmMul||1));
      s.ammo--;
      this.heat=Math.min(d.heatMax,this.heat+d.heatShot);
      const ads=this.adsAmt;
      const rm=this.recoilMul||1;
      this.camKick+=(ads>.7?d.kickAds:d.kick)*rm;
      // Recoil pattern: deterministic vertical climb + horizontal drift (learnable spray control)
      const rec=recoilShot(d,this.recoilIdx,ads>.7);
      this.camKick+=rec.up*rm;
      this.camKickYaw+=rec.right*rm;
      this.recoilIdx=Math.min(40,this.recoilIdx+1);
      this.recoilReset=.35;
      this.gunKickZ=Math.min(.07,this.gunKickZ+(d.id==='deagle'?.03:.018));
      this.gunKickRX=Math.min(.12,this.gunKickRX+(d.id==='deagle'?.05:.03));
      this.gunKickRY+=(Math.random()-.5)*(d.id==='deagle'?.05:.02); // random horizontal flick
      this.gunKickRY=Math.max(-.07,Math.min(.07,this.gunKickRY));
      if(d.id==='deagle')this._slide=1; // slide cycles back
      this.muzzleFlashT=d.id==='deagle'?.05:.045;
      this._ejectShell();
      if(d.id==='deagle')this.audio.deagle();
      else this.audio.shot();
      fireCb(this.spreadRad(player));
    }
    if(s.ammo===0&&!this.reloading&&this.switchT<0&&!this._emptyClicked){
      this._emptyClicked=true;this.audio.empty();
      this.startReload();                    // auto-reload even while the trigger is held
    }
    if(s.ammo>0)this._emptyClicked=false;
    this.heat=Math.max(0,this.heat-dt*.010);
    // Reset the recoil pattern once firing stops
    if(input.firing)this.recoilReset=.35;
    else{
      this.recoilReset-=dt;
      if(this.recoilReset<=0)this.recoilIdx=0;
    }
    this._trigWasDown=!!input.firing;

    // Recoil recovery
    this.camKick*=Math.max(0,1-7*dt);
    this.gunKickZ*=Math.max(0,1-9*dt);
    this.gunKickRX*=Math.max(0,1-9*dt);
    this.gunKickRY*=Math.max(0,1-7*dt);
    this.camKickYaw*=Math.max(0,1-6*dt);
    this._slide=Math.max(0,this._slide-dt*9);

    // Pose
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
      const target=_hipPos.copy(HIP_POS).lerp(ADS_POS,this.adsAmt);
      // Optional per-weapon ADS lift: raises the viewmodel so the iron sights (lower than the
      // M4's tall frame) sit on the crosshair instead of a few centimetres below it.
      if(d.adsLift)target.y+=d.adsLift*this.adsAmt;
      pos.lerp(target,Math.min(1,12*dt));
      rot.x+=((HIP_ROT.x+(1-this.adsAmt)*-.02)-rot.x)*Math.min(1,12*dt);
      rot.y+=((HIP_ROT.y*(1-this.adsAmt))-rot.y)*Math.min(1,12*dt);
      rot.z+=(0-rot.z)*Math.min(1,12*dt);
    }
    pos.x+=bx;pos.y+=by;
    pos.z+=this.gunKickZ;
    rot.x-=this.gunKickRX;
    rot.y+=this.gunKickRY;
    // Slide recoil (Desert Eagle)
    const slide=this.models[d.id].userData.slide;
    if(slide)slide.position.z=slide.userData.z0+this._slide*.06;
    if(this.reloading){
      const ph=this.reloadT/rdur;
      const bell=p=>Math.sin(Math.max(0,Math.min(1,p))*Math.PI);
      const slap=bell(Math.max(0,Math.min(1,(ph-.78)/.22)));
      rot.z+=bell(ph)*.22;            // cant toward the mag well
      rot.y+=bell(ph)*.08;            // yaw presenting the well
      rot.x+=bell(ph)*.07+slap*.09;   // tip up + dip on the slap
      pos.y-=slap*.014;               // the slap jolts the gun down a touch
    }

    // Muzzle flash (aligned to the real muzzle point, group space)
    const scopedHide=d.scope&&this.adsAmt>.5; // scoped: the gun body is hidden — the flash plane and its point light would only wash out the lens
    if(this.muzzleFlashT>0){
      this.muzzleFlashT-=dt;
      const tip=this.models[d.id].userData.muzzle;
      if(tip&&!scopedHide){
        this.flash.visible=true;
        this.flash.position.copy(tip);
        this.flash.position.z-=.035; // nudged forward so the crosshair does not hide it
        this.flash.rotation.z=Math.random()*Math.PI*2;
        const sc=d.id==='deagle'?.62:.95;
        const fs=(0.85+Math.random()*.5)*sc;
        this.flash.scale.set(fs,fs,1);
        this.flash.material.color.setHex(0xfff2dc);
        this.flashLight.position.copy(this.group.localToWorld(_muzzleWorld.copy(tip)));
        this.flashLight.intensity=d.id==='deagle'?10:8;
      }else this.flash.visible=false;
    }else{
      this.flash.visible=false;
      this.flashLight.intensity*=Math.max(0,1-25*dt);
    }
    if(scopedHide)this.flashLight.intensity=0; // no warm wash over the scope view

    // Shell ejection
    for(const sh of this.shells){
      if(!sh.active)continue;
      sh.t+=dt;
      if(sh.t>.8){sh.active=false;sh.mesh.visible=false;continue;}
      sh.vel.y-=9.8*dt;
      sh.mesh.position.addScaledVector(sh.vel,dt);
      sh.mesh.rotation.x+=sh.rot.x*dt;sh.mesh.rotation.y+=sh.rot.y*dt;
    }

    this.ui.setAmmo(s.ammo,s.reserve,this.reloading,wName(d));
    this.ui.weaponSlots(this.cur);
  }

  /* Refresh the current weapon's labels after a language switch */
  refreshLang(){
    const d=this.def,s=this.st;
    this.ui.setSlotNames(this.defs.map(wSlot));
    this.ui.setAmmo(s.ammo,s.reserve,this.reloading,wName(d));
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
    this.reloading=false;
    this.switchT=-1;this._pending=undefined;   // no ghost slot after restarting mid-switch
    this.fireT=0;this.camKick=0;this.camKickYaw=0;this.heat=0;
    this._shotBuf=0;this._trigWasDown=false;   // a queued semi shot must not survive a restart
    this._equip(0,true);
  }
  addReserve(n){
    this.defs.forEach((d,i)=>{
      this.state[i].reserve=Math.min(999,this.state[i].reserve+n);
    });
  }
}
