// heroes.js —— 3D 真人风阵营角色(第三人称):
//   女性 CT 特勤「霜华」:模特级身形 · 长发马尾 · 精致五官 · 战术耳麦
//   男性 T 佣兵「赤鸦」:硬朗帅气 · V 型身躯 · 挽袖红夹克 · 短发
// + 3v3 人机乱斗对战(走位/点射扫射风格/重生/名牌)
import * as THREE from 'three';
import {isEN} from './i18n.js';

export const HERO_DEFS={
  ct:{label:'霜华 · CT 特勤',hp:115,speed:5.2,gender:'f'},
  t:{label:'赤鸦 · T 佣兵',hp:100,speed:5.8,gender:'m'},
};
const FACTION_HEX={ct:'#7fd4ff',t:'#ff8a6a'};
/* Bot 战斗风格:CT 稳定点射,T 猛烈扫射 */
const BOT_PROFILE={
  ct:{burst:3,burstT:.13,pause:1.2,missK:1.0,dmgP:6,dmgH:12,range:[7,16]},
  t:{burst:5,burstT:.11,pause:1.5,missK:1.35,dmgP:9,dmgH:15,range:[6,13]},
};
/* 名册(性别混编,双方阵营都有男女干员;中英呼号) */
const BOT_NAMES={
  ct:[{n:'夜莺',nEn:'Nightingale',g:'f'},{n:'雪狼',nEn:'Snowwolf',g:'m'},{n:'雨燕',nEn:'Swift',g:'f'},{n:'雷豹',nEn:'Thunder',g:'m'}],
  t:[{n:'秃鹫',nEn:'Vulture',g:'m'},{n:'火狐',nEn:'Fox',g:'f'},{n:'豺狼',nEn:'Jackal',g:'m'},{n:'黑蛇',nEn:'Viper',g:'f'}],
};

let BID=0;

function makeNameTag(name,faction){
  const c=document.createElement('canvas');c.width=256;c.height=64;
  const g=c.getContext('2d');
  g.font='bold 28px "Microsoft YaHei",sans-serif';
  g.textAlign='center';g.textBaseline='middle';
  g.shadowColor='rgba(0,0,0,.9)';g.shadowBlur=6;
  g.fillStyle=FACTION_HEX[faction];
  g.fillText((faction==='ct'?'CT·':'T·')+name,128,32);
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,transparent:true,depthTest:true}));
  sp.scale.set(1.9,.44,1);
  sp.position.y=2.0;
  return sp;
}

export class HeroBot{
  constructor(game,scene,assets,effects,audio,ui,{hero,team,name,gender}){
    this.game=game;this.scene=scene;this.assets=assets;this.fx=effects;this.audio=audio;this.ui=ui;
    this.id=++BID;
    this.hero=hero;this.team=team;this.name=name;
    const D=HERO_DEFS[hero];
    this.gender=gender||D.gender||'f';
    this.hp=D.hp;this.maxHp=D.hp;this.speed=D.speed;
    this.pos=new THREE.Vector3();
    this.vel=new THREE.Vector3();
    this.yaw=0;this.alive=true;
    this.fireT=1+Math.random();this.burst=0;
    this.respawnT=0;
    this.flashT=0;this.strafeDir=Math.random()>.5?1:-1;this.strafeT=2+Math.random()*2;
    this.walkT=0;
    this._eyeT=new THREE.Vector3();this._tPosT=new THREE.Vector3(); // 热路径向量复用
    this._fromT=new THREE.Vector3();this._dirT=new THREE.Vector3();
    this.group=new THREE.Group();
    this.buildBody();
    this.group.add(makeNameTag(name,hero));
    scene.add(this.group);
  }

  /* ============ 通用网格工具 ============ */
  _mesh(parent,geo,mat,x,y,z,rx=0,ry=0,rz=0,sx=1,sy=1,sz=1){
    const m=new THREE.Mesh(geo,mat.clone());
    m.position.set(x,y,z);m.rotation.set(rx,ry,rz);m.scale.set(sx,sy,sz);
    m.castShadow=true;
    parent.add(m);return m;
  }
  _sphere(r,ws=18,hs=14){return new THREE.SphereGeometry(r,ws,hs);}
  _cyl(rt,rb,h,seg=12){return new THREE.CylinderGeometry(rt,rb,h,seg);}
  _box(w,h,d){return new THREE.BoxGeometry(w,h,d);}
  _cone(r,h,seg=10){return new THREE.ConeGeometry(r,h,seg);}
  _torus(r,t,rs=8,ts=20,arc=Math.PI*2){return new THREE.TorusGeometry(r,t,rs,ts,arc);}

  /* 人脸(头心局部坐标,朝向 +z):眉 / 眼睑+眼白+虹膜 / 鼻 / 唇 / 耳 */
  _makeFace(H,M,{fem}){
    const skin=fem?M.skinF:M.skinM;
    for(const s of[-1,1]){
      this._mesh(H,this._sphere(.018,10,8),M.sclera,s*.041,.016,.086,0,0,0,.95,.62,.5);
      this._mesh(H,this._sphere(.0125,10,8),M.iris,s*.041,.016,.0995);
      // 上眼睑:肤色压住眼白上缘,形成自然眼型
      this._mesh(H,this._box(.05,.016,.02),skin,s*.041,.034,.088,0,0,-s*(fem?.1:.06));
      const bw=fem?{w:.04,h:.007,a:.22}:{w:.048,h:.011,a:.1};
      this._mesh(H,this._box(bw.w,bw.h,.012),M.brow,s*.043,.058,.087,0,0,-s*bw.a);
    }
    this._mesh(H,this._cone(.011,.044,8),skin,0,-.008,.098,Math.PI/2);
    if(fem)this._mesh(H,this._box(.038,.011,.013),M.lipsF,0,-.048,.09,0,0,0,1,1,.9);
    else this._mesh(H,this._box(.034,.008,.012),M.lipsM,0,-.048,.088);
    for(const s of[-1,1])this._mesh(H,this._sphere(.02,8,8),skin,s*.094,0,-.003,0,0,0,.5,1,.7);
  }

  /* 步枪(枪口朝 +z = 角色面向;kind: 'ak47'|'m4a4') */
  _mkRifle(kind){
    const M=this.assets.mats;
    const g=new THREE.Group();
    const wood=kind==='ak47';
    this._mesh(g,this._box(.05,.075,.34),M.gunDark,0,0,-.02);                    // 机匣
    this._mesh(g,this._box(.046,.05,.16),wood?M.gunWood:M.gunPoly,0,.005,.14);   // 护木
    this._mesh(g,this._cyl(.011,.011,.18,10),M.gunDark,0,.018,.28,Math.PI/2);    // 枪管
    this._mesh(g,this._box(.014,.05,.012),M.gunDark,0,.045,.34);                 // 准星
    this._mesh(g,this._box(.04,.06,.13),wood?M.gunWood:M.gunPoly,0,-.008,-.24);  // 枪托
    this._mesh(g,this._box(.028,.10,.05),M.gunDark,0,-.075,.02,wood?.4:.15);     // 弹匣
    return g;
  }

  /* ============ 女性模特级身形(1.75m,腿长过半) ============ */
  _buildFemale(M,look){
    const g=this.group;
    const skin=M.skinF,jacket=look.jacket,armor=look.plate,hair=M.hairF,boot=M.bootDark,glove=M.gloveDark;

    /* --- 头(中心 1.60):椭圆颅骨 + 精致五官 --- */
    const H=new THREE.Group();H.position.set(0,1.60,0);g.add(H);this.headY=1.60;
    this._mesh(H,this._sphere(.102,20,16),skin,0,0,.004,0,0,0,.95,1.12,1.0);
    this._makeFace(H,M,{fem:true});
    // 发型:顶盖 + 后脑 + 刘海 + 侧长发 + 低马尾(随步态摆动)
    this._mesh(H,this._sphere(.107,18,12),hair,0,.03,-.01,0,0,0,1.04,.88,1.0);
    this._mesh(H,this._sphere(.104,16,12),hair,0,-.01,-.045,0,0,0,1.1,.95,.9);
    this._mesh(H,this._box(.15,.05,.038),hair,0,.066,.068,-.5);
    this._mesh(H,this._sphere(.026,8,8),hair,-.082,-.06,.045,0,0,.12,1,2.6,.8);
    this._mesh(H,this._sphere(.026,8,8),hair,.082,-.06,.045,0,0,-.12,1,2.6,.8);
    const pony=new THREE.Group();pony.position.set(0,-.02,-.11);H.add(pony);this.pony=pony;
    this._mesh(pony,this._sphere(.048,10,8),hair,0,-.01,-.02,0,0,0,1,1.3,1);
    this._mesh(pony,this._sphere(.037,10,8),hair,0,-.12,-.05,0,0,0,1,1.5,1);
    this._mesh(pony,this._sphere(.027,10,8),hair,0,-.25,-.04,0,0,0,1,1.6,1);
    // 战术耳麦 + 通话麦(露出面容与发型,干员气质)
    this._mesh(H,this._torus(.104,.007,8,20,Math.PI),M.gunDark,0,.005,0);
    for(const s of[-1,1])this._mesh(H,this._cyl(.026,.026,.016,10),M.gunDark,s*.10,0,0,0,0,Math.PI/2);
    this._mesh(H,this._box(.01,.01,.065),M.gunDark,-.095,-.045,.035,.3,.4,0);

    /* --- 颈 + 躯干(Lathe 曲面:肩-胸-腰-臀曲线,scale.z=0.72 椭圆截面) --- */
    this._mesh(g,this._cyl(.03,.035,.09),skin,0,1.47,0);
    const prof=[[.001,.845],[.128,.86],[.134,.93],[.098,1.06],[.124,1.16],[.15,1.32],[.146,1.40],[.092,1.455]];
    const torso=new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r,y])=>new THREE.Vector2(r,y)),24),jacket.clone());
    torso.scale.z=.72;torso.castShadow=true;g.add(torso);this.torso=torso;
    this._mesh(g,this._sphere(.048,12,10),jacket,-.05,1.30,.078,0,0,0,1,.85,.7);
    this._mesh(g,this._sphere(.048,12,10),jacket,.05,1.30,.078,0,0,0,1,.85,.7);
    // 腰带 / 背心插板(窄版,露出夹克色)/ 弹匣袋 / 对讲机
    this._mesh(g,this._cyl(.109,.109,.03,20),M.gunDark,0,.945,0,0,0,0,1,1,.72);
    this._mesh(g,this._box(.22,.19,.03),armor,0,1.27,.10);
    this._mesh(g,this._box(.22,.19,.03),armor,0,1.27,-.082);
    this._mesh(g,this._box(.045,.06,.02),M.gunDark,-.045,1.21,.118);
    this._mesh(g,this._box(.045,.06,.02),M.gunDark,.045,1.21,.118);
    this._mesh(g,this._box(.032,.055,.016),M.gunDark,-.088,1.16,.105,0,0,-.2);

    /* --- 臂(袖+露肤前臂+战术手套,持枪锁定) --- */
    const mkArm=side=>{
      const p=new THREE.Group();p.position.set(side*.148,1.395,0);g.add(p);
      this._mesh(p,this._cyl(.045,.038,.24),jacket,0,-.115,0);
      this._mesh(p,this._cyl(.034,.028,.17),skin,0,-.29,.015);
      this._mesh(p,this._sphere(.033,10,8),glove,0,-.385,.03);
      return p;
    };
    this.armL=mkArm(-1);this.armR=mkArm(1);

    /* --- 腿(长腿比例:髋 .90 落地,占身高 51%) --- */
    const mkLeg=side=>{
      const p=new THREE.Group();p.position.set(side*.082,.90,0);g.add(p);
      this._mesh(p,this._cyl(.068,.054,.44),jacket,0,-.22,0);
      this._mesh(p,this._cyl(.05,.043,.36),jacket,0,-.585,.01);
      this._mesh(p,this._box(.082,.082,.20),boot,0,-.855,.03);
      return p;
    };
    this.legL=mkLeg(-1);this.legR=mkLeg(1);

    /* --- 主武器(阵营制式,枪口 +z 前向,gunTip 挂枪身) --- */
    const rifle=this._mkRifle(look.rifle);
    rifle.position.set(.10,1.20,.16);
    rifle.scale.setScalar(.94);
    g.add(rifle);
    this.gunTip=new THREE.Object3D();
    this.gunTip.position.set(0,.02,.44);
    rifle.add(this.gunTip);
    this.armR.rotation.set(-.72,0,-.04);
    this.armL.rotation.set(-.85,.35,.5);
  }

  /* ============ 男性硬朗帅气(1.80m,V 型身躯) ============ */
  _buildMale(M,look){
    const g=this.group;
    const skin=M.skinM,jacket=look.jacket,pants=look.pants,hair=M.hairM,boot=M.bootDark,glove=M.gloveDark;

    /* --- 头(中心 1.64):方正颅骨 + 方下巴 + 粗直眉 --- */
    const H=new THREE.Group();H.position.set(0,1.64,0);g.add(H);this.headY=1.64;
    this._mesh(H,this._sphere(.106,20,16),skin,0,0,.004,0,0,0,1.0,1.1,1.02);
    this._mesh(H,this._box(.06,.04,.06),skin,0,-.065,.028);          // 方下颌
    this._makeFace(H,M,{fem:false});
    // 短发:贴合头型的短发顶盖(前缘微翘不压眉)+ 后脑铲青
    this._mesh(H,this._sphere(.114,18,12),hair,0,.022,-.01,-.18,0,0,1.03,.94,1.05);
    this._mesh(H,this._sphere(.095,14,10),hair,0,-.005,-.07,0,0,0,1.12,.72,.6);

    /* --- 颈 + 躯干(宽肩窄腰 V 型) --- */
    this._mesh(g,this._cyl(.045,.052,.10),skin,0,1.50,0);
    const prof=[[.001,.86],[.145,.88],[.128,.98],[.125,1.06],[.148,1.20],[.168,1.34],[.166,1.43],[.095,1.49]];
    const torso=new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r,y])=>new THREE.Vector2(r,y)),24),jacket.clone());
    torso.scale.z=.74;torso.castShadow=true;g.add(torso);this.torso=torso;
    // 衣领;T 阵营开襟+黑 T+X 胸挂,CT 合领+前拉链
    this._mesh(g,this._box(.16,.04,.02),jacket,0,1.475,.115);
    if(this.hero!=='ct'){
      this._mesh(g,this._box(.11,.16,.02),M.clothDark,0,1.36,.127);
      this._mesh(g,this._box(.045,.36,.018),M.tRig,-.075,1.22,.128,0,0,.45);
      this._mesh(g,this._box(.045,.36,.018),M.tRig,.075,1.22,.128,0,0,-.45);
    }else{
      this._mesh(g,this._box(.014,.3,.014),M.clothDark,0,1.30,.122);
    }

    /* --- 臂(宽肩厚臂,挽袖露肤,战术手套) --- */
    const mkArm=side=>{
      const p=new THREE.Group();p.position.set(side*.165,1.42,0);g.add(p);
      this._mesh(p,this._cyl(.055,.047,.25),jacket,0,-.12,0);
      this._mesh(p,this._cyl(.045,.038,.18),skin,0,-.30,.02);
      this._mesh(p,this._sphere(.043,12,10),glove,0,-.40,.03);
      return p;
    };
    this.armL=mkArm(-1);this.armR=mkArm(1);

    /* --- 腿 --- */
    const mkLeg=side=>{
      const p=new THREE.Group();p.position.set(side*.088,.88,0);g.add(p);
      this._mesh(p,this._cyl(.08,.058,.42),pants,0,-.21,0);
      this._mesh(p,this._cyl(.056,.048,.38),pants,0,-.55,.01);
      this._mesh(p,this._box(.095,.09,.215),boot,0,-.835,.035);
      return p;
    };
    this.legL=mkLeg(-1);this.legR=mkLeg(1);

    /* --- 主武器(阵营制式,枪口 +z) --- */
    const rifle=this._mkRifle(look.rifle);
    rifle.position.set(.10,1.19,.16);
    g.add(rifle);
    this.gunTip=new THREE.Object3D();
    this.gunTip.position.set(0,.02,.44);
    rifle.add(this.gunTip);
    this.armR.rotation.set(-.70,0,-.04);
    this.armL.rotation.set(-.82,.35,.5);
  }

  buildBody(){
    const M=this.assets.mats;
    // 服装/枪械跟随阵营(同阵营男女着装统一,队伍辨识清晰)
    const ct=this.hero==='ct';
    const look={
      jacket:ct?M.ctFatigue:M.tJacket,
      pants:ct?M.ctFatigue:M.tPants,
      plate:ct?M.ctArmor:M.tRig,
      rifle:ct?'m4a4':'ak47',
    };
    if(this.gender==='f')this._buildFemale(M,look);
    else this._buildMale(M,look);
    // 收集本角色克隆材质(受击闪白只影响自己)
    this.flashable=[];
    this.group.traverse(o=>{if(o.isMesh&&o.material&&o.material.emissive)this.flashable.push(o.material);});
  }

  place(pos,yaw){
    this.pos.copy(pos);this.yaw=yaw;
    this.group.position.copy(pos);
    this.group.rotation.y=yaw;
  }

  hitSpheres(){
    return [
      {c:new THREE.Vector3(this.pos.x,this.pos.y+(this.headY||1.6),this.pos.z),r:.16,part:'head'},
      {c:new THREE.Vector3(this.pos.x,this.pos.y+.95,this.pos.z),r:.42,part:'body'},
    ];
  }

  takeDamage(n,fromName){
    if(!this.alive)return -1;
    this.hp-=n;
    this.flashT=.09;
    for(const m of this.flashable){m.emissive.setHex(0xffffff);m.emissiveIntensity=.6;}
    if(this.hp<=0){
      this.die(fromName);
      return -1;
    }
    return this.hp;
  }

  die(byName){
    this.alive=false;
    this.respawnT=3.5;
    this.game.onHeroKill(byName,this);
    this.fx.explosion(new THREE.Vector3(this.pos.x,this.pos.y+1,this.pos.z),.5);
    this.group.rotation.x=-Math.PI/2.2;
    this.group.position.y=this.pos.y+.3;
  }

  respawn(){
    this.alive=true;this.hp=this.maxHp;
    this.group.rotation.x=0;
    const base=this.team==='A'?new THREE.Vector3(0,0,24):new THREE.Vector3(0,0,-24);
    this.place(base.clone().add(new THREE.Vector3((Math.random()-.5)*8,0,(Math.random()-.5)*8)),
      this.team==='A'?Math.PI:0);
    this.audio.respawn();
  }

  _collide(colliders){
    const r=.45;
    for(const c of colliders){
      if(this.pos.y>c.top)continue;
      const cx=Math.max(c.minX,Math.min(this.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(this.pos.z,c.maxZ));
      const dx=this.pos.x-cx,dz=this.pos.z-cz;
      const d2=dx*dx+dz*dz;
      if(d2<r*r&&d2>1e-8){
        const d=Math.sqrt(d2),push=(r-d)/d;
        this.pos.x+=dx*push;this.pos.z+=dz*push;
      }
    }
    const dd=Math.hypot(this.pos.x,this.pos.z);
    if(dd>52){const k=52/dd;this.pos.x*=k;this.pos.z*=k;}
  }

  update(dt,time,losCheck){
    if(!this.alive){
      this.respawnT-=dt;
      this.group.position.y=Math.max(this.pos.y+.3-dt*.2,this.pos.y+.1);
      if(this.respawnT<=0)this.respawn();
      return;
    }
    if(this.flashT>0){
      this.flashT-=dt;
      if(this.flashT<=0)for(const m of this.flashable)m.emissiveIntensity=0;
    }

    // 选目标:最近的敌方(角色 或 玩家)
    let target=null,tDist=1e9;
    const eye=this._eyeT.set(this.pos.x,this.pos.y+1.4,this.pos.z);
    for(const h of this.game.heroes.list){
      if(h.team===this.team||!h.alive)continue;
      const d=this.pos.distanceTo(h.pos);
      if(d<tDist){tDist=d;target=h;this._tPosT.set(h.pos.x,h.pos.y+1.1,h.pos.z);}
    }
    if(this.team==='B'&&this.game.player.alive){
      const pe=this.game.player.eye;
      const d=this.pos.distanceTo(this.game.player.pos);
      if(d<tDist){tDist=d;target='player';this._tPosT.copy(pe);}
    }
    const tPos=this._tPosT;

    const P=BOT_PROFILE[this.hero];
    if(target){
      const dx=tPos.x-this.pos.x,dz=tPos.z-this.pos.z;
      const wantYaw=Math.atan2(dx,dz);
      let dy=wantYaw-this.yaw;
      while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
      this.yaw+=dy*Math.min(1,6*dt);

      // 走位:保持交战距离 + 横向游走
      this.strafeT-=dt;
      if(this.strafeT<=0){this.strafeT=1.5+Math.random()*2;this.strafeDir*=-1;}
      const dist=Math.max(.001,Math.hypot(dx,dz));
      const nx=dx/dist,nz=dz/dist;
      const approach=dist>P.range[1];
      const spd=this.speed*(approach?1:.6);
      let mx=0,mz=0;
      if(approach){mx+=nx*spd;mz+=nz*spd;}
      else if(dist<P.range[0]){mx-=nx*spd*.8;mz-=nz*spd*.8;}
      mx+=-nz*this.strafeDir*spd*.55;mz+=nx*this.strafeDir*spd*.55;
      const k=Math.min(1,8*dt);
      this.vel.x+=(mx-this.vel.x)*k;
      this.vel.z+=(mz-this.vel.z)*k;
      this.pos.x+=this.vel.x*dt;
      this.pos.z+=this.vel.z*dt;
      this._collide(this.game.world.colliders);

      // 点射/扫射
      this.fireT-=dt;
      if(this.fireT<=0){
        const clear=losCheck(eye,tPos);
        if(clear){
          if(this.burst<P.burst){this.burst++;this.fireT=P.burstT;}
          else{this.burst=0;this.fireT=P.pause+Math.random()*.5;}
          this._shoot(tPos,target,dist,P);
        }else this.fireT=.4;
      }
    }

    this._animate(dt,time,this.vel.length());
    this.group.position.set(this.pos.x,this.group.position.y,this.pos.z);
    this.group.rotation.y=this.yaw;
  }

  _shoot(tPos,target,dist,P){
    const from=this._fromT;
    this.gunTip.getWorldPosition(from);
    const dir=this._dirT.copy(tPos).sub(from).normalize();
    // 命中精度:距离越远越散(T 更猛但更糙)
    const miss=Math.random()<Math.min(.6,dist*.018*P.missK+.08);
    if(miss)dir.add(new THREE.Vector3((Math.random()-.5)*.12,(Math.random()-.5)*.08,(Math.random()-.5)*.12)).normalize();
    const end=miss
      ?from.clone().addScaledVector(dir,dist+4)
      :tPos.clone();
    this.fx.tracer(from,dir,from.distanceTo(end));
    this.fx.impact(end,new THREE.Vector3(0,1,0),'metal');
    this.audio.botShot(this.game.player.pos.distanceTo(this.pos));
    if(!miss){
      if(target==='player'){
        this.game.damagePlayerFromBot(P.dmgP,this.name);
      }else{
        target.takeDamage(P.dmgH,this.name);
        this.game.botDamageFx(target,tPos);
      }
    }
  }

  _animate(dt,time,spd){
    const moving=spd>.5;
    if(moving)this.walkT+=dt*spd*2.1;
    const swing=moving?Math.sin(this.walkT)*.6:0;
    if(this.legL){this.legL.rotation.x=swing;this.legR.rotation.x=-swing;}
    // 行走起伏 + 女性髋部摆动
    const bob=moving?Math.abs(Math.cos(this.walkT))*.035:0;
    this.group.position.y=this.pos.y+bob;
    let rz=this.group.rotation.z;
    if(this.gender==='f')rz+=(Math.sin(this.walkT)*(moving?.045:0)-rz)*Math.min(1,8*dt);
    else rz*=Math.max(0,1-8*dt);
    this.group.rotation.z=rz;
    // 马尾随动(发丝物理近似)
    if(this.pony){
      this.pony.rotation.x=-.15+Math.sin(time*1.7)*.05+(moving?swing*.18:0);
      this.pony.rotation.z=Math.sin(time*1.3)*.06;
    }
    this.group.rotation.y=this.yaw;
  }

  dispose(){
    this.scene.remove(this.group);
    this.group.traverse(o=>{
      if(o.isMesh)o.geometry.dispose();
      if(o.isSprite&&o.material.map)o.material.map.dispose();
    });
  }
}

/* 阵营队伍管理器:玩家所在阵营 vs 敌对阵营(性别混编) */
export class HeroTeam{
  constructor(game){
    this.game=game;
    this.list=[];
  }
  setup(playerFaction='ct',playerName=''){
    this.clear();
    const g=this.game,scene=g.scene,assets=g.assets,fx=g.effects,audio=g.audio,ui=g.ui;
    const pf=HERO_DEFS[playerFaction]?playerFaction:'ct';
    const ef=pf==='ct'?'t':'ct';
    const nm=b=>isEN()&&b.nEn?b.nEn:b.n;
    const pool=f=>BOT_NAMES[f].filter(b=>nm(b)!==playerName);
    const own=pool(pf),foe=pool(ef);
    const defs=[
      {hero:pf,team:'A',name:nm(own[0]),gender:own[0].g},
      {hero:pf,team:'A',name:nm(own[1]),gender:own[1].g},
      {hero:ef,team:'B',name:nm(foe[0]),gender:foe[0].g},
      {hero:ef,team:'B',name:nm(foe[1]),gender:foe[1].g},
      {hero:ef,team:'B',name:nm(foe[2]),gender:foe[2].g},
    ];
    for(const d of defs){
      const h=new HeroBot(g,scene,assets,fx,audio,ui,d);
      const base=d.team==='A'?new THREE.Vector3(0,0,24):new THREE.Vector3(0,0,-24);
      h.place(base.clone().add(new THREE.Vector3((Math.random()-.5)*10,0,(Math.random()-.5)*10)),
        d.team==='A'?Math.PI:0);
      this.list.push(h);
    }
  }
  clear(){
    for(const h of this.list)h.dispose();
    this.list.length=0;
  }
  update(dt,time,losCheck){
    for(const h of this.list)h.update(dt,time,losCheck);
  }
}
