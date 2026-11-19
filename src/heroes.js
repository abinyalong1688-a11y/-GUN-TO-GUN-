// heroes.js —— 3D 真人风阵营角色(第三人称)+ 3v3 人机乱斗:
//   外观由 character.js 按干员定义构建(8 名干员 / 迷彩 / 剪影);
//   战斗风格按阵营(CT 稳定点射 / T 猛烈扫射),死亡倒地 → 尸体淡出 → 重生。
import * as THREE from 'three';
import {t,isEN} from './i18n.js';
import {byId,byFaction,DEFAULT_OP} from './operators.js';
import {buildOperatorMesh,fadeMaterials} from './character.js';

/* 兼容层:旧逻辑按阵营读取基础属性,数据源统一在 operators.js */
const _opCT=byId('frost'),_opT=byId('raven');
const _botSpeed=op=>Math.round(5.2*op.speedMul*10)/10;
export const HERO_DEFS={
  ct:{label:`${_opCT.name.zh} · CT 特勤`,hp:_opCT.hp,speed:_botSpeed(_opCT),gender:_opCT.gender},
  t:{label:`${_opT.name.zh} · T 佣兵`,hp:_opT.hp,speed:_botSpeed(_opT),gender:_opT.gender},
};
const FACTION_HEX={ct:'#7fd4ff',t:'#ff8a6a'};
/* Bot 战斗风格:CT 稳定点射,T 猛烈扫射 */
const BOT_PROFILE={
  ct:{burst:3,burstT:.13,pause:1.2,missK:1.0,dmgP:6,dmgH:12,range:[7,16]},
  t:{burst:5,burstT:.11,pause:1.5,missK:1.35,dmgP:9,dmgH:15,range:[6,13]},
};

let BID=0;

/* M2-A5:名牌血条 —— 两片几何模块级共享,材质每 bot 独立 */
const TAG_BG_GEO=new THREE.PlaneGeometry(.62,.075);
const TAG_BAR_GEO=new THREE.PlaneGeometry(.58,.05).translate(.29,0,0);

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
  sp.userData.tex=t;
  // 血条挂在名字上方(y+.26),bg 与 fill 的 z 错开避免 z-fighting
  const group=new THREE.Group();
  const bg=new THREE.Mesh(TAG_BG_GEO,new THREE.MeshBasicMaterial({
    color:0x0a0f18,transparent:true,opacity:.75,depthTest:true,depthWrite:false}));
  bg.position.set(0,.26,.005);
  const bar=new THREE.Mesh(TAG_BAR_GEO,new THREE.MeshBasicMaterial({
    color:FACTION_HEX[faction]==='#ff8a6a'?0xff8a6a:0x7fd4ff,
    transparent:true,opacity:.95,depthTest:true,depthWrite:false}));
  bar.position.set(-.29,.26,.012);
  group.add(sp,bg,bar);
  return {group,sprite:sp,bar,bg,tex:t};
}

export class HeroBot{
  constructor(game,scene,assets,effects,audio,ui,{operator,team,name}){
    this.game=game;this.scene=scene;this.assets=assets;this.fx=effects;this.audio=audio;this.ui=ui;
    this.id=++BID;
    this.def=operator;
    this.opId=operator.id;
    this.faction=operator.faction;
    this.hero=operator.faction;      // 兼容字段:战斗风格/阵营标签按 faction
    this.team=team;this.name=name;
    this.gender=operator.gender;
    this.hp=operator.hp;this.maxHp=operator.hp;
    this.speed=_botSpeed(operator);
    this.pos=new THREE.Vector3();
    this.vel=new THREE.Vector3();
    this.yaw=0;this.alive=true;
    this.state='active';             // active | dying | dead
    this.deathT=0;this.respawnT=0;
    this.fireT=1+Math.random();this.burst=0;
    this.flashT=0;this.strafeDir=Math.random()>.5?1:-1;this.strafeT=2+Math.random()*2;
    this.walkT=0;
    /* M2-A1 动画状态机 */
    this.animState='idle';this.animT=0;
    this.aimPitch=0;this.aimYaw=0;
    this.recoilKick=0;this.reloadT=0;this.hitT=0;this.hitDir=1;
    this.magSize=operator.rifle==='awp'?10:30;this.ammo=this.magSize;
    this.moving=false;this.hasTarget=false;
    /* M2-A2 无线电台词冷却(错开开局,避免刷屏) */
    this._barkT=1+Math.random()*4;this._lowBarked=false;
    this.baseArmR=[0,0,0];this.baseArmL=[0,0,0];this.baseTorsoY=0;
    this._eyeT=new THREE.Vector3();this._tPosT=new THREE.Vector3(); // 热路径向量复用
    this._fromT=new THREE.Vector3();this._dirT=new THREE.Vector3();
    this._rifleVel=new THREE.Vector3();this._rifleSpin=new THREE.Vector3();
    this.rifleFalling=false;this.rifleHome=null;
    this.nameTag=null;
    this.buildBody();
    scene.add(this.group);
  }

  /* 角色网格由 character.js 构建(几何共享 / 每角色一套材质) */
  buildBody(){
    const built=buildOperatorMesh(this.assets,this.def,{camo:this.def.camo||'default'});
    this.group=built.group;
    this.parts=built.parts;
    this.materials=built.materials;
    this.headY=built.parts.headY;
    this.torso=built.parts.torso;
    this.armL=built.parts.armL;this.armR=built.parts.armR;
    this.legL=built.parts.legL;this.legR=built.parts.legR;
    this.pony=built.parts.pony;
    this.gunTip=built.parts.gunTip;
    // 记录初始持枪姿态:动画在此基准上偏移,避免 T-pose
    if(this.armR)this.baseArmR=[this.armR.rotation.x,this.armR.rotation.y,this.armR.rotation.z];
    if(this.armL)this.baseArmL=[this.armL.rotation.x,this.armL.rotation.y,this.armL.rotation.z];
    this.baseTorsoY=this.torso?this.torso.position.y:0;
    // 受击闪白只影响本角色
    this.flashable=this.materials.filter(m=>m.emissive);
    // 名牌挂点(角色头顶);setOperator 重建时复用旧名牌
    if(!this.nameTag)this.nameTag=makeNameTag(this.name,this.faction);
    built.parts.nameTagAnchor.add(this.nameTag.group);
  }

  /* 调试/换装:原地替换干员外观与属性(C1 ?op= / C5 迷彩预览共用) */
  setOperator(op){
    if(!op)return false;
    const tag=this.nameTag;
    if(tag&&tag.group.parent)tag.group.parent.remove(tag.group);
    if(this.parts.rifle&&this.parts.rifle.parent===this.scene)this.scene.remove(this.parts.rifle);
    this.scene.remove(this.group);
    for(const m of this.materials)m.dispose();
    this.def=op;this.opId=op.id;this.faction=op.faction;this.hero=op.faction;
    this.gender=op.gender;
    this.hp=this.maxHp=op.hp;
    this.speed=_botSpeed(op);
    this.state='active';this.alive=true;this.deathT=0;this.respawnT=0;
    this.animState='idle';this.animT=0;this.recoilKick=0;this.reloadT=0;this.hitT=0;
    this._barkT=1+Math.random()*3;this._lowBarked=false;
    this.magSize=op.rifle==='awp'?10:30;this.ammo=this.magSize;
    if(tag&&tag.bar)tag.bar.scale.x=1;
    this.rifleHome=null;this.rifleFalling=false;
    this.buildBody();
    if(tag)this.parts.nameTagAnchor.add(tag.group);
    this.scene.add(this.group);
    this.group.position.copy(this.pos);this.group.rotation.set(0,this.yaw,0);
    return true;
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
    if(this.nameTag&&this.nameTag.bar)
      this.nameTag.bar.scale.x=Math.max(.001,Math.min(1,this.hp/this.maxHp));
    this.flashT=.09;
    this.hitT=.35;this.hitDir=Math.random()>.5?1:-1;
    if(this.hp/this.maxHp<.35&&!this._lowBarked&&this.bark('bark_low'))this._lowBarked=true;
    for(const m of this.flashable){m.emissive.setHex(0xffffff);m.emissiveIntensity=.6;}
    if(this.hp<=0){
      this.die(fromName);
      return -1;
    }
    return this.hp;
  }

  /* C2:死亡表现 —— 倒地 0.7s → 尸体淡出 → 5.5s 重生;不再爆炸 */
  die(byName){
    if(!this.alive)return;
    this.alive=false;
    this.state='dying';
    this.deathT=0;
    this.respawnT=5.5;
    this.game.onHeroKill(byName,this);
    this.bark('bark_down',true);
    this.fx.bloodPuff(new THREE.Vector3(this.pos.x,this.pos.y+1.1,this.pos.z));
    this.dropRifle();
  }

  dropRifle(){
    const r=this.parts.rifle;
    if(!r||this.rifleFalling)return;
    this.rifleHome=this.rifleHome||{
      parent:r.parent,
      position:r.position.clone(),
      rotation:r.rotation.clone(),
      scale:r.scale.clone(),
    };
    this.scene.attach(r);
    this._rifleVel.set((Math.random()-.5)*1.2,1.6+Math.random(),(Math.random()-.5)*1.2);
    this._rifleSpin.set((Math.random()-.5)*6,(Math.random()-.5)*6,(Math.random()-.5)*6);
    this.rifleFalling=true;
  }

  _updateDroppedRifle(dt){
    if(!this.rifleFalling)return;
    const r=this.parts.rifle;
    if(!r)return;
    this._rifleVel.y-=9.8*dt;
    r.position.addScaledVector(this._rifleVel,dt);
    r.rotation.x+=this._rifleSpin.x*dt;
    r.rotation.y+=this._rifleSpin.y*dt;
    r.rotation.z+=this._rifleSpin.z*dt;
    if(r.position.y<=.06){
      r.position.y=.06;
      this._rifleVel.set(0,0,0);
      this.rifleFalling=false;
    }
  }

  _restoreRifle(){
    const r=this.parts.rifle,h=this.rifleHome;
    if(!r||!h)return;
    h.parent.add(r);
    r.position.copy(h.position);
    r.rotation.copy(h.rotation);
    r.scale.copy(h.scale);
    this.rifleFalling=false;
  }

  respawn(){
    this._restoreRifle();
    fadeMaterials(this.materials,1);
    this.alive=true;this.state='active';this.deathT=0;this.hp=this.maxHp;
    this.animState='idle';this.animT=0;this.recoilKick=0;this.reloadT=0;this.hitT=0;
    this.ammo=this.magSize;this.burst=0;this.flashT=0;this._lowBarked=false;
    if(this.nameTag&&this.nameTag.bar)this.nameTag.bar.scale.x=1;
    if(this.torso)this.torso.position.y=this.baseTorsoY;
    if(this.parts.head)this.parts.head.rotation.x=0;
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
    if(this.state!=='active'){
      this.deathT+=dt;
      if(this.state==='dying'){
        const k=Math.min(1,this.deathT/.7);
        this.group.rotation.x=-Math.PI/2.2*k;
        this.group.position.y=this.pos.y+.3*k;
        if(k>=1)this.state='dead';
      }else{
        fadeMaterials(this.materials,Math.max(0,1-(this.deathT-.7)/4));
      }
      this._updateDroppedRifle(dt);
      if(this.deathT>this.respawnT)this.respawn();
      return;
    }
    // M2-A5:名牌按距离淡出(30m 内全亮,46m 外隐藏)
    if(this.nameTag){
      const d=this.game.camera.position.distanceTo(this.pos);
      const a=Math.max(0,Math.min(1,(46-d)/16));
      this.nameTag.group.visible=a>.01;
      this.nameTag.sprite.material.opacity=a;
      this.nameTag.bg.material.opacity=a*.75;
      this.nameTag.bar.material.opacity=a*.95;
    }
    if(this._barkT>0)this._barkT-=dt;
    if(this.flashT>0){
      this.flashT-=dt;
      if(this.flashT<=0)for(const m of this.flashable){
        m.emissiveIntensity=m.userData.baseEI??0;
        if(m.userData.baseEH!=null)m.emissive.setHex(m.userData.baseEH);
      }
    }
    // M2-A1:动画计时器(热路径无新分配)
    if(this.reloadT>0)this.reloadT=Math.max(0,this.reloadT-dt);
    if(this.hitT>0)this.hitT=Math.max(0,this.hitT-dt);
    if(this.recoilKick>0)this.recoilKick=Math.max(0,this.recoilKick-dt*4.5);

    // 选目标:最近的敌方(角色 或 玩家)
    const hadTarget=this.hasTarget;
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
    if(target&&!hadTarget)this.bark('bark_spot');

    const P=BOT_PROFILE[this.faction];
    if(target){
      const dx=tPos.x-this.pos.x,dz=tPos.z-this.pos.z;
      const wantYaw=Math.atan2(dx,dz);
      let dy=wantYaw-this.yaw;
      while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
      this.yaw+=dy*Math.min(1,6*dt);
      // 瞄准偏移:头部俯仰 + 躯干轻微转向(动画状态机读取)
      this.aimYaw=Math.max(-.6,Math.min(.6,dy));
      const dist0=Math.max(.001,Math.hypot(dx,dz));
      this.aimPitch=Math.max(-.5,Math.min(.5,Math.atan2(tPos.y-(this.pos.y+1.4),dist0)));

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

      // 点射/扫射(换弹期间不开火)
      this.fireT-=dt;
      if(this.fireT<=0&&this.reloadT<=0){
        const clear=losCheck(eye,tPos);
        if(clear){
          if(this.burst<P.burst){this.burst++;this.fireT=P.burstT;}
          else{this.burst=0;this.fireT=P.pause+Math.random()*.5;}
          this._shoot(tPos,target,dist,P);
        }else this.fireT=.4;
      }
    }else{
      this.aimPitch*=.9;this.aimYaw*=.9;
    }

    this.moving=this.vel.length()>.5;
    this.hasTarget=!!target;
    this._decideAnim(target,dt);
    this._animate(dt,time,this.vel.length());
    this.group.position.set(this.pos.x,this.group.position.y,this.pos.z);
    this.group.rotation.y=this.yaw;
  }

  /* M2-A2:电台台词(每 bot 6s 冷却,静音由音频总线处理) */
  bark(key,force=false){
    if(!force&&this._barkT>0)return false;
    this._barkT=6;
    if(this.ui&&this.ui.bark)this.ui.bark(this.name,t(key),this.faction);
    if(this.audio&&this.audio.radio)this.audio.radio();
    return true;
  }

  /* M2-A1:动画状态决策(独立方法便于 e2e 验证) */
  _decideAnim(target,dt=.016){
    let st;
    if(this.state!=='active')st=this.state;
    else if(this.reloadT>0)st='reload';
    else if(this.hitT>0)st='hit';
    else if(this.recoilKick>.2)st='fire';
    else if(this.moving)st='walk';
    else if(target)st='aim';
    else st='idle';
    if(st!==this.animState){this.animState=st;this.animT=0;}
    else this.animT+=dt;
    return st;
  }

  /* 弹匣消耗:打空后 1.2s 换弹,期间由 update 屏蔽开火 */
  _consumeAmmo(){
    this.ammo--;
    this.recoilKick=1;
    if(this.ammo<=0){
      this.ammo=this.magSize;
      this.reloadT=1.2;
      this.burst=0;
      this.fireT=1.2;
      this.bark('bark_reload');
    }
  }

  _shoot(tPos,target,dist,P){
    this._consumeAmmo();
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
        this.game.damagePlayerFromBot(P.dmgP,this.name,this.pos);
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
    // 行走起伏 + 女性髋部摆动(低血量步伐加重)
    let bob=moving?Math.abs(Math.cos(this.walkT))*.035:0;
    if(this.hp/this.maxHp<.35)bob*=1.4;
    this.group.position.y=this.pos.y+bob;
    let rz=this.group.rotation.z;
    if(this.gender==='f')rz+=(Math.sin(this.walkT)*(moving?.045:0)-rz)*Math.min(1,8*dt);
    else rz*=Math.max(0,1-8*dt);
    // 受击侧倾
    if(this.hitT>0)rz+=this.hitDir*this.hitT*.3;
    this.group.rotation.z=rz;

    // 呼吸:躯干微起伏(基准值来自 buildBody,避免累积漂移)
    if(this.torso)this.torso.position.y=this.baseTorsoY+Math.sin(time*1.8)*.003;
    // 瞄准:头部俯仰 + 躯干跟随(平滑)
    const k=Math.min(1,8*dt);
    if(this.parts.head){
      const want=-this.aimPitch*.5;
      this.parts.head.rotation.x+=(want-this.parts.head.rotation.x)*k;
    }
    if(this.torso){
      const want=this.aimYaw*.3;
      this.torso.rotation.y+=(want-this.torso.rotation.y)*k;
    }
    // 持枪基准姿态 + 后坐 / 换弹叠加
    if(this.armR)this.armR.rotation.x=this.baseArmR[0]+this.recoilKick*.35;
    if(this.armL)this.armL.rotation.x=this.baseArmL[0]+this.recoilKick*.12;
    if(this.reloadT>0){
      const ph=1-this.reloadT/1.2;
      const a=Math.sin(ph*Math.PI)*.8;
      if(this.armL)this.armL.rotation.x=this.baseArmL[0]-a;
      if(this.armR)this.armR.rotation.x=this.baseArmR[0]-a*.35;
    }
    // 马尾随动(发丝物理近似)
    if(this.pony){
      this.pony.rotation.x=-.15+Math.sin(time*1.7)*.05+(moving?swing*.18:0);
      this.pony.rotation.z=Math.sin(time*1.3)*.06;
    }
    this.group.rotation.y=this.yaw;
  }

  dispose(){
    this.scene.remove(this.group);
    if(this.parts.rifle&&this.parts.rifle.parent===this.scene)this.scene.remove(this.parts.rifle);
    if(this.nameTag){
      if(this.nameTag.tex)this.nameTag.tex.dispose();
      if(this.nameTag.sprite&&this.nameTag.sprite.material)this.nameTag.sprite.material.dispose();
      if(this.nameTag.bg&&this.nameTag.bg.material)this.nameTag.bg.material.dispose();
      if(this.nameTag.bar&&this.nameTag.bar.material)this.nameTag.bar.material.dispose();
      this.nameTag=null;
    }
    // 只释放本角色克隆材质;几何体为模块级共享缓存
    for(const m of this.materials)m.dispose();
  }
}

/* 阵营队伍管理器:玩家所在阵营 2 名队友 vs 敌对阵营 3 名敌人(8 干员不重样) */
export class HeroTeam{
  constructor(game){
    this.game=game;
    this.list=[];
  }
  setup(playerFaction='ct',playerName='',playerOpId=DEFAULT_OP){
    this.clear();
    const g=this.game,scene=g.scene,assets=g.assets,fx=g.effects,audio=g.audio,ui=g.ui;
    const pf=playerFaction==='t'?'t':'ct';
    const ef=pf==='ct'?'t':'ct';
    const own=byFaction(pf).filter(o=>o.id!==playerOpId).slice(0,2);
    const foe=byFaction(ef).slice(0,3);
    const used=new Set([playerName]);
    const nm=o=>{
      let n=isEN()?o.name.en:o.name.zh;
      if(used.has(n)){let i=2;while(used.has(n+' '+i))i++;n=n+' '+i;}
      used.add(n);
      return n;
    };
    const defs=[
      ...own.map(o=>({operator:o,team:'A'})),
      ...foe.map(o=>({operator:o,team:'B'})),
    ];
    for(const d of defs){
      const base=d.operator;
      const op=g.camoFor?{...base,camo:g.camoFor(base)}:{...base};
      const h=new HeroBot(g,scene,assets,fx,audio,ui,{operator:op,team:d.team,name:nm(base)});
      const b=d.team==='A'?new THREE.Vector3(0,0,24):new THREE.Vector3(0,0,-24);
      h.place(b.clone().add(new THREE.Vector3((Math.random()-.5)*10,0,(Math.random()-.5)*10)),
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
