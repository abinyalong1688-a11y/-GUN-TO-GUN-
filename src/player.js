// player.js —— 第一人称移动:重力/跳跃/蹲伏/攀爬(可跳上木箱、集装箱)
// 真实世界物理:恒定重力加速度、起跳初速度、空中操控衰减、走出边缘自然下落
import * as THREE from 'three';

const GRAVITY=14;        // 重力加速度 m/s²(略强于 9.8,游戏手感)
const JUMP_V=5.7;        // 起跳初速度 m/s(跳高 ≈1.16m,可跃上 1.15m 木箱)
const STEP_UP=.32;       // 自动上阶高度(登上矮台阶)
const EYE_STAND=1.62, EYE_CROUCH=1.18;

export class Player{
  constructor(camera,colliders){
    this.cam=camera;
    this.colliders=colliders;
    this.pos=new THREE.Vector3(0,0,7);
    this.vel=new THREE.Vector3();
    this.velY=0;                 // 垂直速度(重力积分)
    this.grounded=true;          // 是否接地
    this.crouching=false;        // 蹲伏
    this.airborne=false;         // 悬空(影响射击精度)
    this._eye=new THREE.Vector3();
    this._forward=new THREE.Vector3();
    this.yaw=Math.PI/2+Math.PI*.15; // 初始朝向哨站内
    this.pitch=-.05;
    this.health=100;this.maxHealth=100;this.alive=true;
    this.radius=.4;this.eyeHCur=EYE_STAND;
    this.speed=5.2;this.sprintSpeed=7.8;   // 基础移速(武器负重由 weapon.speedCb 乘算)
    this.sprinting=false;this.moving=false;
    this.lastHurt=-99;this.regenDelay=5;
    this.stepT=0;this.stepAlt=false;
    this.boundsR=56;
    this.god=false; // 截图验证用无敌
  }
  reset(){
    this.pos.set(0,0,7);this.vel.set(0,0,0);
    this.velY=0;this.grounded=true;this.crouching=false;this.eyeHCur=EYE_STAND;
    this.yaw=Math.PI/2+Math.PI*.15;this.pitch=-.05;
    this.health=this.maxHealth;this.alive=true;this.lastHurt=-99;
  }
  get eye(){
    return this._eye.set(this.pos.x,this.pos.y+this.eyeHCur,this.pos.z);
  }
  forward(){
    return this._forward.set(-Math.sin(this.yaw),0,-Math.cos(this.yaw));
  }
  damage(n,now){
    if(!this.alive||this.god)return;
    this.health=Math.max(0,this.health-n);
    this.lastHurt=now;
    if(this.health<=0)this.alive=false;
  }
  heal(n){this.health=Math.min(this.maxHealth,this.health+n);}

  /* 脚下最高可站立支撑面(≤limit,含 0.32m 自动上阶) */
  _supportY(limit){
    let s=0;
    const r2=(this.radius*.85)*(this.radius*.85);
    for(const c of this.colliders){
      if(c.top>limit)continue;
      const cx=Math.max(c.minX,Math.min(this.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(this.pos.z,c.maxZ));
      const dx=this.pos.x-cx,dz=this.pos.z-cz;
      if(dx*dx+dz*dz<r2 && c.top>s)s=c.top;
    }
    return s;
  }

  /* 下落穿越判定:本帧脚起点以下、且 XZ 仍重叠的最高箱顶 */
  _landingY(prevFeet){
    let s=0;
    const r2=(this.radius*.85)*(this.radius*.85);
    for(const c of this.colliders){
      if(c.top>prevFeet)continue;
      const cx=Math.max(c.minX,Math.min(this.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(this.pos.z,c.maxZ));
      const dx=this.pos.x-cx,dz=this.pos.z-cz;
      if(dx*dx+dz*dz<r2 && c.top>s)s=c.top;
    }
    return s;
  }

  _collide(){
    const r=this.radius;
    for(const c of this.colliders){
      if(this.pos.y>=c.top-.01)continue; // 已站到其顶面之上:不再水平推挤
      const cx=Math.max(c.minX,Math.min(this.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(this.pos.z,c.maxZ));
      const dx=this.pos.x-cx,dz=this.pos.z-cz;
      const d2=dx*dx+dz*dz;
      if(d2<r*r){
        if(d2>1e-8){
          const d=Math.sqrt(d2),push=(r-d)/d;
          this.pos.x+=dx*push;this.pos.z+=dz*push;
        }else{
          // 圆心在盒内:沿最浅轴推出
          const l=this.pos.x-c.minX,rr=c.maxX-this.pos.x,t=this.pos.z-c.minZ,b=c.maxZ-this.pos.z;
          const m=Math.min(l,rr,t,b);
          if(m===l)this.pos.x=c.minX-r;else if(m===rr)this.pos.x=c.maxX+r;
          else if(m===t)this.pos.z=c.minZ-r;else this.pos.z=c.maxZ+r;
        }
      }
    }
    // 场地边界
    const d=Math.hypot(this.pos.x,this.pos.z);
    if(d>this.boundsR){
      const k=this.boundsR/d;
      this.pos.x*=k;this.pos.z*=k;
    }
  }

  update(dt,input,keys,time,audio){
    if(!this.alive)return;

    /* --- 蹲伏:降身位 / 减速 / 更稳(eye 平滑过渡) --- */
    this.crouching=keys.has('ControlLeft')||keys.has('ControlRight');
    this.eyeHCur+=((this.crouching?EYE_CROUCH:EYE_STAND)-this.eyeHCur)*Math.min(1,12*dt);

    /* --- 起跳(接地时) --- */
    if(keys.has('Space')&&this.grounded&&!this.crouching){
      this.velY=JUMP_V;
      this.grounded=false;
    }

    /* --- 重力积分 --- */
    if(!this.grounded)this.velY-=GRAVITY*dt;
    if(this.velY<-30)this.velY=-30; // 终端速度

    /* --- 移动输入 --- */
    let ix=0,iz=0;
    if(keys.has('KeyW'))iz-=1;
    if(keys.has('KeyS'))iz+=1;
    if(keys.has('KeyA'))ix-=1;
    if(keys.has('KeyD'))ix+=1;
    const moving=ix!==0||iz!==0;
    this.moving=moving;
    this.sprinting=keys.has('ShiftLeft')&&moving&&iz<=0&&!input.ads&&!this.crouching&&this.grounded;
    const crouchMul=this.crouching?.55:1;
    const spd=(this.sprinting?this.sprintSpeed:this.speed)*crouchMul*(input.ads?.62:1);
    const sinY=Math.sin(this.yaw),cosY=Math.cos(this.yaw);
    // 键盘向量 -> 世界:world = R_y(yaw) * (ix, 0, iz)
    let wx=(ix*cosY+iz*sinY),wz=(-ix*sinY+iz*cosY);
    const len=Math.hypot(wx,wz)||1;
    wx=wx/len*spd;wz=wz/len*spd;
    if(!moving){wx=0;wz=0;}
    // 平滑加速:空中操控衰减(真实惯性)
    const accel=this.grounded?10:3.2;
    const k=Math.min(1,accel*dt);
    this.vel.x+=(wx-this.vel.x)*k;
    this.vel.z+=(wz-this.vel.z)*k;
    this.pos.x+=this.vel.x*dt;
    this.pos.z+=this.vel.z*dt;
    this._collide();

    /* --- 垂直运动:重力 / 支撑面 / 落地穿越判定 / 走出边缘 --- */
    const prevFeet=this.pos.y;
    if(this.grounded){
      const support=this._supportY(this.pos.y+STEP_UP);
      if(this.pos.y<=support+.001){
        this.pos.y=support;this.velY=0;          // 吸附支撑面(含步梯上阶)
      }else if(this.pos.y>support+.02){
        this.grounded=false;this.velY=0;         // 走出边缘:开始下落
      }
    }
    if(!this.grounded){
      this.pos.y+=this.velY*dt;                  // 空中位移(重力已先行积分)
      const landY=this._landingY(prevFeet);
      if(this.velY<=0&&this.pos.y<=landY){
        this.pos.y=landY;this.velY=0;this.grounded=true; // 下落穿越箱顶/地面 → 落地
      }else if(this.pos.y<0){
        this.pos.y=0;this.velY=0;this.grounded=true;
      }
    }
    this.airborne=!this.grounded;

    // 脚步声
    const spdNow=Math.hypot(this.vel.x,this.vel.z);
    if(spdNow>1&&this.grounded){
      this.stepT+=dt*spdNow;
      if(this.stepT>2.1){this.stepT=0;this.stepAlt=!this.stepAlt;audio.step(this.stepAlt);}
    }

    // 回血
    if(time-this.lastHurt>this.regenDelay&&this.health<this.maxHealth)
      this.health=Math.min(this.maxHealth,this.health+6*dt);

    // 相机
    // 行业标准:俯仰钳制 ±89°,防止越过天顶导致画面天地颠倒、左右旋转反向
    this.pitch=Math.max(-1.553,Math.min(1.553,this.pitch));
    this.cam.position.copy(this.eye);
    this.cam.rotation.order='YXZ';
    this.cam.rotation.y=this.yaw;
    this.cam.rotation.x=this.pitch;
  }
}
