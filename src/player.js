// player.js — first-person movement: gravity / jumping / crouching / climbing (hop onto crates and containers)
// Real-world physics: constant gravity, jump impulse, reduced air control, natural falls off edges
import * as THREE from 'three';
import { pushCircleOut, circleOverlapsCollider } from './collision.js';

const GRAVITY=14;        // gravity in m/s² (a bit stronger than 9.8 for game feel)
const JUMP_V=5.7;        // jump take-off speed in m/s (≈1.16 m jump, enough for a 1.15 m crate)
const STEP_UP=.32;       // automatic step-up height (low ledges)
const EYE_STAND=1.62, EYE_CROUCH=1.18;

export class Player{
  constructor(camera,colliders){
    this.cam=camera;
    this.colliders=colliders;
    this.pos=new THREE.Vector3(0,0,7);
    this.vel=new THREE.Vector3();
    this.velY=0;                 // vertical velocity (integrated gravity)
    this.grounded=true;          // standing on something
    this.crouching=false;        // crouching
    this.airborne=false;         // in the air (hurts accuracy)
    this._eye=new THREE.Vector3();
    this._forward=new THREE.Vector3();
    this.yaw=0;                     // initially facing the outpost center (-z), toward the enemy side
    this.pitch=-.05;
    this.health=100;this.maxHealth=100;this.alive=true;
    this.radius=.4;this.eyeHCur=EYE_STAND;
    this.speed=5.2;this.sprintSpeed=7.8;   // base move speed (weapon weight is applied via weapon.speedCb)
    this.sprinting=false;this.moving=false;
    this.lastHurt=-99;this.regenDelay=5;
    this.stepT=0;this.stepAlt=false;
    this.boundsR=56;
    this.god=false; // invulnerability for screenshot checks
  }
  reset(){
    this.pos.set(0,0,7);this.vel.set(0,0,0);
    this.velY=0;this.grounded=true;this.crouching=false;this.eyeHCur=EYE_STAND;
    this.yaw=0;this.pitch=-.05;
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
    // Network input is untrusted: NaN / Infinity / negative values must never poison health
    if(typeof n!=='number'||!Number.isFinite(n)||n<=0)return;
    this.health=Math.max(0,this.health-Math.min(400,n));
    this.lastHurt=now;
    if(this.health<=0)this.health=0,this.alive=false;
  }
  heal(n){this.health=Math.min(this.maxHealth,this.health+n);}

  /* Highest standable support surface under the feet (≤limit, includes the 0.32 m step-up) */
  _supportY(limit){
    let s=0;
    const r=this.radius*.85;
    for(const c of this.colliders){
      if(c.top>limit)continue;
      if(circleOverlapsCollider(this.pos.x,this.pos.z,r,c) && c.top>s)s=c.top;
    }
    return s;
  }

  /* Fall-through test: highest crate top below this frame's starting foot height that still overlaps in XZ */
  _landingY(prevFeet){
    let s=0;
    const r=this.radius*.85;
    for(const c of this.colliders){
      if(c.top>prevFeet)continue;
      if(circleOverlapsCollider(this.pos.x,this.pos.z,r,c) && c.top>s)s=c.top;
    }
    return s;
  }

  _collide(){
    const r=this.radius;
    for(const c of this.colliders){
      if(this.pos.y>=c.top-.01)continue; // already standing on top: no horizontal push
      pushCircleOut(this.pos,r,c);      // OBB-aware push-out (no invisible corner walls)
    }
    // Arena boundary
    const d=Math.hypot(this.pos.x,this.pos.z);
    if(d>this.boundsR){
      const k=this.boundsR/d;
      this.pos.x*=k;this.pos.z*=k;
    }
  }

  /* Standing up must not put the camera inside overhead geometry. */
  canStand(){
    const r=this.radius;
    for(const c of this.colliders){
      if(c.top<=this.pos.y+.05)continue;              // below our feet
      if(c.top>=this.pos.y+EYE_STAND-.1)continue;     // above our head
      if(circleOverlapsCollider(this.pos.x,this.pos.z,r,c))return false;
    }
    return true;
  }

  update(dt,input,keys,time,audio){
    if(!this.alive)return;

    /* --- Crouch: lower stance / slower / steadier (eye height eases between states) --- */
    const wantCrouch=keys.has('ControlLeft')||keys.has('ControlRight');
    if(wantCrouch||this.canStand())this.crouching=wantCrouch;  // blocked overhead: stay crouched
    this.eyeHCur+=((this.crouching?EYE_CROUCH:EYE_STAND)-this.eyeHCur)*Math.min(1,12*dt);

    /* --- Jump (when grounded) --- */
    if(keys.has('Space')&&this.grounded&&!this.crouching){
      this.velY=JUMP_V;
      this.grounded=false;
    }

    /* --- Gravity integration --- */
    if(!this.grounded)this.velY-=GRAVITY*dt;
    if(this.velY<-30)this.velY=-30; // terminal velocity

    /* --- Movement input --- */
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
    // Keyboard vector → world: world = R_y(yaw) * (ix, 0, iz)
    let wx=(ix*cosY+iz*sinY),wz=(-ix*sinY+iz*cosY);
    const len=Math.hypot(wx,wz)||1;
    wx=wx/len*spd;wz=wz/len*spd;
    if(!moving){wx=0;wz=0;}
    // Smoothed acceleration: reduced air control (real inertia)
    const accel=this.grounded?10:3.2;
    const k=Math.min(1,accel*dt);
    this.vel.x+=(wx-this.vel.x)*k;
    this.vel.z+=(wz-this.vel.z)*k;
    this.pos.x+=this.vel.x*dt;
    this.pos.z+=this.vel.z*dt;
    this._collide();

    /* --- Vertical motion: gravity / support surfaces / landing fall-through / walking off edges --- */
    const prevFeet=this.pos.y;
    if(this.grounded){
      const support=this._supportY(this.pos.y+STEP_UP);
      if(this.pos.y<=support+.001){
        this.pos.y=support;this.velY=0;          // snap to the support surface (includes step-up)
      }else if(this.pos.y>support+.02){
        this.grounded=false;this.velY=0;         // walked off an edge: start falling
      }
    }
    if(!this.grounded){
      this.pos.y+=this.velY*dt;                  // airborne displacement (gravity already integrated)
      const landY=this._landingY(prevFeet);
      if(this.velY<=0&&this.pos.y<=landY){
        this.pos.y=landY;this.velY=0;this.grounded=true; // fell through a crate top / the ground → land
      }else if(this.pos.y<0){
        this.pos.y=0;this.velY=0;this.grounded=true;
      }
    }
    this.airborne=!this.grounded;

    // Footsteps
    const spdNow=Math.hypot(this.vel.x,this.vel.z);
    if(spdNow>1&&this.grounded){
      this.stepT+=dt*spdNow;
      if(this.stepT>2.1){this.stepT=0;this.stepAlt=!this.stepAlt;audio.step(this.stepAlt);}
    }

    // Health regen
    if(time-this.lastHurt>this.regenDelay&&this.health<this.maxHealth)
      this.health=Math.min(this.maxHealth,this.health+6*dt);

    // Camera
    // Industry standard: clamp pitch to ±89° so looking past the zenith never flips the view or reverses turning
    this.pitch=Math.max(-1.553,Math.min(1.553,this.pitch));
    this.cam.position.copy(this.eye);
    this.cam.rotation.order='YXZ';
    this.cam.rotation.y=this.yaw;
    this.cam.rotation.x=this.pitch;
  }
}
