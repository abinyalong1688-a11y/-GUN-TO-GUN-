// heroes.js — realistic 3D faction characters (third person) + 4v4 bot deathmatch:
//   looks are built by character.js from operator definitions (8 operators / camos / silhouettes);
//   combat style by faction (Nova steady bursts / Rogue heavy spray); death: fall → limbs land flat → fade out → respawn.
import * as THREE from 'three';
import {t,isEN} from './i18n.js';
import {byId,byFaction,DEFAULT_OP} from './operators.js';
import {buildOperatorMeshAuto,fadeMaterials} from './character.js';
import {modelAssets} from './modelAssets.js';
import {rigInit,poseRot,posePos,poseReset} from './rig.js';

/* Compatibility layer: legacy code reads base stats per faction; the data lives in operators.js */
const _opCT=byId('frost'),_opT=byId('raven');
const _botSpeed=op=>Math.round(5.2*op.speedMul*10)/10;
export const HERO_DEFS={
  ct:{label:`${_opCT.name.en} · Nova Operator`,hp:_opCT.hp,speed:_botSpeed(_opCT),gender:_opCT.gender},
  t:{label:`${_opT.name.en} · Rogue Mercenary`,hp:_opT.hp,speed:_botSpeed(_opT),gender:_opT.gender},
};
const FACTION_HEX={ct:'#7fd4ff',t:'#ff8a6a'};
/* Bot combat style: Nova fires steady bursts, Rogue sprays hard */
const BOT_PROFILE={
  ct:{burst:3,burstT:.13,pause:1.2,missK:1.0,dmgP:6,dmgH:12,range:[7,16],reaction:.25,coverBias:.6,flankBias:.3},
  t:{burst:5,burstT:.11,pause:1.5,missK:1.35,dmgP:9,dmgH:15,range:[6,13],reaction:.18,coverBias:.4,flankBias:.6},
};

let BID=0;
const _Y=new THREE.Vector3(0,1,0),_Zc=new THREE.Vector3(0,0,1),_qLag=new THREE.Quaternion(),_qCant=new THREE.Quaternion();
const _losRay=new THREE.Raycaster(); // shared: clips miss tracers at cover (no through-wall tracers)

/* M2-A5: name tag health bar — both geometries shared at module level, materials per bot */
const TAG_BG_GEO=new THREE.PlaneGeometry(.62,.075);
const TAG_BAR_GEO=new THREE.PlaneGeometry(.58,.05).translate(.29,0,0);

function makeNameTag(name,faction){
  const c=document.createElement('canvas');c.width=256;c.height=64;
  const g=c.getContext('2d');
  g.font='bold 28px "Microsoft YaHei",sans-serif';
  g.textAlign='center';g.textBaseline='middle';
  g.shadowColor='rgba(0,0,0,.9)';g.shadowBlur=6;
  g.fillStyle=FACTION_HEX[faction];
  g.fillText(name,128,32); // faction is shown by the tag colour
  const t=new THREE.CanvasTexture(c);
  t.colorSpace=THREE.SRGBColorSpace;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:t,transparent:true,depthTest:true}));
  sp.scale.set(1.9,.44,1);
  sp.userData.tex=t;
  // Health bar sits above the name (y+.26); bg and fill are offset in z to avoid z-fighting
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
    this.hero=operator.faction;      // compatibility field: combat style / faction label follow the faction
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
    this.moveK=0;          // smoothed moving flag (blends idle / locomotion layers)
    this._lastYaw=0;this._rifleLag=0; // rifle inertia on turns
    this._headPitch=0;this._torsoYaw=0; // smoothed aim layers (character-space deltas)
    /* M2-A1 animation state machine */
    this.animState='idle';this.animT=0;
    this.aimPitch=0;this.aimYaw=0;
    this.recoilKick=0;this.reloadT=0;this.hitT=0;this.hitDir=1;
    this.magSize=operator.rifle==='awp'?10:30;this.ammo=this.magSize;
    this.moving=false;this.hasTarget=false;
    /* M2-A2 radio bark cooldown (staggered at match start to avoid spam) */
    this._barkT=1+Math.random()*4;this._lowBarked=false;
    this.blindT=0;
    /* M3-G6: cover / flanking / reactions */
    this.coverTarget=null;this.coverT=0;
    /* Stuck escape: cover movement has no strafe, so a blocker on the straight path can pin
       the bot — track progress and open a perpendicular detour when it grinds in place */
    this._stuck=0;this._stuckChk=.4;this._stuckPos=new THREE.Vector3();
    this.detourT=0;this._detourSide=0;
    this.flankDir=Math.random()>.5?1:-1;
    this.reactionT=0;this._lastTargetId=null; // last target identity — reaction re-arms when it changes
    this.difficulty=(game.settings&&game.settings.get('botDifficulty'))||'normal';
    this._coverFrom=new THREE.Vector3();this._coverTo=new THREE.Vector3();this._coverBest=new THREE.Vector3();
    this.baseArmR=[0,0,0];this.baseArmL=[0,0,0];this.baseTorsoY=0;
    this._eyeT=new THREE.Vector3();this._tPosT=new THREE.Vector3(); // hot-path vector reuse
    this._fromT=new THREE.Vector3();this._dirT=new THREE.Vector3();
    this._rifleVel=new THREE.Vector3();this._rifleSpin=new THREE.Vector3();
    this.rifleFalling=false;this.rifleHome=null;
    this.nameTag=null;
    this.buildBody();
    scene.add(this.group);
  }

  /* Character mesh built by character.js (GLB rigged body or procedural, identical contract).
     builtWith records which builder ran — the GLB preload races match start (?shot= / e2e
     boot straight into a game), and HeroTeam swaps proc-built bots once the GLB arrives. */
  buildBody(){
    const built=buildOperatorMeshAuto(this.assets,this.def,{camo:this.def.camo||'default'});
    this.builtWith=modelAssets.mode();
    this.group=built.group;
    this.parts=built.parts;
    this.materials=built.materials;
    this.headY=built.parts.headY;
    this.torso=built.parts.torso;
    this.armL=built.parts.armL;this.armR=built.parts.armR;
    this.legL=built.parts.legL;this.legR=built.parts.legR;
    this.shinL=built.parts.shinL||null;this.shinR=built.parts.shinR||null; // GLB rigs: knee-bend layer
    this.footL=built.parts.footL||null;this.footR=built.parts.footR||null;
    this.hips=built.parts.hips||null; // GLB rigs: idle weight shift + death buckle
    this.pony=built.parts.pony;
    this.gunTip=built.parts.gunTip;
    this._animParts=[this.parts.head,this.torso,this.armL,this.armR,this.legL,this.legR,
      this.shinL,this.shinR,this.footL,this.footR,this.hips,this.pony].filter(Boolean);
    for(const o of this._animParts)rigInit(o);
    this._rifleBaseQ=built.parts.rifle?built.parts.rifle.quaternion.clone():null;
    this._headPitch=0;this._torsoYaw=0;
    // Record the initial rifle-hold pose: animation offsets from this baseline, avoiding a T-pose
    if(this.armR)this.baseArmR=[this.armR.rotation.x,this.armR.rotation.y,this.armR.rotation.z];
    if(this.armL)this.baseArmL=[this.armL.rotation.x,this.armL.rotation.y,this.armL.rotation.z];
    this.baseTorsoY=this.torso?this.torso.position.y:0;
    // Hit flash only affects this character
    this.flashable=this.materials.filter(m=>m.emissive);
    // Name tag anchor (above the head); rebuilt by setOperator, which reuses the old tag
    if(!this.nameTag)this.nameTag=makeNameTag(this.name,this.faction);
    built.parts.nameTagAnchor.add(this.nameTag.group);
  }

  /* Debug / loadout swap: replace operator looks and stats in place (shared by C1 ?op= and the C5 camo preview) */
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
    this._barkT=1+Math.random()*3;this._lowBarked=false;this.blindT=0;
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

  /* C2: death — fall over in 0.7 s with the limbs landing flat, corpse gone ≈0.8 s later; respawn after 5.5 s */
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
    const y0=r.position.y; // pre-step height: tops below it are landing candidates (no tunnelling past a top in one frame)
    this._rifleVel.y-=9.8*dt;
    r.position.addScaledVector(this._rifleVel,dt);
    r.rotation.x+=this._rifleSpin.x*dt;
    r.rotation.y+=this._rifleSpin.y*dt;
    r.rotation.z+=this._rifleSpin.z*dt;
    /* Rest on whatever was underneath — crate/container tops included, not just the ground
       plane; the origin rests .06 above the surface (same offset as the ground rest), so the
       rifle never sinks half-way into the crate top. */
    let ground=.06;
    const cols=this.game.world&&this.game.world.colliders;
    if(cols)for(const c of cols)
      if(c.top<=y0&&c.top+.06>ground
        &&r.position.x>=c.minX&&r.position.x<=c.maxX
        &&r.position.z>=c.minZ&&r.position.z<=c.maxZ)ground=c.top+.06;
    if(r.position.y<=ground){
      r.position.y=ground;
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
    this.ammo=this.magSize;this.burst=0;this.flashT=0;this._lowBarked=false;this.blindT=0;
    this._restoreFlash(); // the killing hit's white flash is never restored in the death branch; restore it on respawn or the bot stays white
    this.coverTarget=null;this.coverT=0;
    if(this.nameTag&&this.nameTag.bar)this.nameTag.bar.scale.x=1;
    for(const o of this._animParts)poseReset(o);
    this._headPitch=0;this._torsoYaw=0;
    this.group.rotation.x=0;
    const base=this.team==='A'?new THREE.Vector3(0,0,24):new THREE.Vector3(0,0,-24);
    this.place(base.clone().add(new THREE.Vector3((Math.random()-.5)*8,0,(Math.random()-.5)*8)),
      this.team==='A'?Math.PI:0);
    this._collide(this.game.world.colliders); // jittered spawn can land on map geometry (caldera gate pillars)
    this._stuck=0;this.detourT=0;this._stuckChk=.4;this._stuckPos.copy(this.pos);
    this.audio.respawn();
    // Dead bots are skipped by HeroTeam.refreshModels — catch up on the GLB swap here
    if(this.builtWith!==modelAssets.mode())this.setOperator(this.def);
  }

  _restoreFlash(){
    for(const m of this.flashable){
      m.emissiveIntensity=m.userData.baseEI??0;
      if(m.userData.baseEH!=null)m.emissive.setHex(m.userData.baseEH);
    }
  }

  _collide(colliders){
    const r=.45;
    for(const c of colliders){
      if(this.pos.y>c.top)continue;
      const cx=Math.max(c.minX,Math.min(this.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(this.pos.z,c.maxZ));
      const dx=this.pos.x-cx,dz=this.pos.z-cz;
      const d2=dx*dx+dz*dz;
      if(d2>r*r)continue;
      if(d2>1e-8){
        const d=Math.sqrt(d2),push=(r-d)/d;
        this.pos.x+=dx*push;this.pos.z+=dz*push;
      }else{
        /* Center inside (or exactly on) the box: the boundary push-out above is a no-op,
           so a bot spawned or separation-shoved fully inside would stay embedded — pop it
           out to the nearest face + r. */
        const dl=this.pos.x-c.minX,dr=c.maxX-this.pos.x,dn=this.pos.z-c.minZ,df=c.maxZ-this.pos.z;
        const m=Math.min(dl,dr,dn,df);
        if(m===dr)this.pos.x=c.maxX+r;
        else if(m===dl)this.pos.x=c.minX-r;
        else if(m===df)this.pos.z=c.maxZ+r;
        else this.pos.z=c.minZ-r;
      }
    }
    const dd=Math.hypot(this.pos.x,this.pos.z);
    if(dd>52){const k=52/dd;this.pos.x*=k;this.pos.z*=k;}
  }

  update(dt,time,losCheck){
    if(this.state!=='active'){
      this.deathT+=dt;
    if(this.state==='dying'){
      // Two-stage death on rigs: stagger (hips buckle, knees fold, spine twists) → collapse.
      // The limbs straighten while the body lands, so all four end up flat on the ground;
      // the corpse then fades out quickly (gone ≈0.8 s after the limbs land).
      const k1=Math.min(1,this.deathT/.28);
      const k2raw=Math.max(0,Math.min(1,(this.deathT-.28)/.42));
      const k2=k2raw*k2raw*(3-2*k2raw); // smoothstep
      this.group.rotation.x=-Math.PI/2.2*k2;
      this.group.position.y=this.pos.y+.3*k2;
      if(this.hips){
        posePos(this.hips,0,-.22*k1,0);
        poseRot(this.hips,0,this.hitDir*.5*k1*(1-k2*.7),0);
      }
      if(this.shinL){
        const fold=.95*k1*(1-k2); // knees buckle, then fully straighten as the body lands
        poseRot(this.shinL,fold);poseRot(this.shinR,fold*.8);
      }
      if(this.legL){poseRot(this.legL,0,0,.12*k2);poseRot(this.legR,0,0,-.12*k2);} // slight sprawl
      /* Arms relax from the rifle hold back to hanging along the body (character.js rest
         angles: R(-.72,0,-.04) / L(-.85,.35,.5)) — flat on the ground once prone */
      if(this.armR)poseRot(this.armR,.72*k2,0,.04*k2);
      if(this.armL)poseRot(this.armL,.85*k2,-.35*k2,-.5*k2);
      if(k2raw>=1)this.state='dead';
    }else{
      fadeMaterials(this.materials,Math.max(0,1-(this.deathT-.7)/.8));
    }
      this._updateDroppedRifle(dt);
      if(this.deathT>this.respawnT)this.respawn();
      return;
    }
    // M2-A5: name tags fade with distance (fully visible within 30 m, hidden beyond 46 m)
    if(this.nameTag){
      const d=this.game.camera.position.distanceTo(this.pos);
      const a=Math.max(0,Math.min(1,(46-d)/16));
      this.nameTag.group.visible=a>.01;
      this.nameTag.sprite.material.opacity=a;
      this.nameTag.bg.material.opacity=a*.75;
      this.nameTag.bar.material.opacity=a*.95;
    }
    if(this._barkT>0)this._barkT-=dt;
    if(this.blindT>0)this.blindT-=dt;
    if(this.flashT>0){
      this.flashT-=dt;
      if(this.flashT<=0)this._restoreFlash();
    }
    if(this.blindT>0){
      // Flashbang blindness: like drones — loses target awareness, holds fire, coasts to a stop
      this.vel.x*=Math.max(0,1-4*dt);this.vel.z*=Math.max(0,1-4*dt);
      this.pos.x+=this.vel.x*dt;this.pos.z+=this.vel.z*dt;
      this._collide(this.game.world.colliders);
      /* Status timers keep ticking while blinded — a flash mid-reload no longer freezes the reload */
      if(this.reloadT>0)this.reloadT=Math.max(0,this.reloadT-dt);
      if(this.hitT>0)this.hitT=Math.max(0,this.hitT-dt);
      if(this.recoilKick>0)this.recoilKick=Math.max(0,this.recoilKick-dt*4.5);
      this._animate(dt,time,this.vel.length());
      this.group.position.set(this.pos.x,this.pos.y,this.pos.z);
      this.group.rotation.y=this.yaw;
      return;
    }
    // M2-A1: animation timers (no new allocations on the hot path)
    /* Live difficulty: a mid-match botDifficulty change reaches existing bots on the next frame */
    this.difficulty=(this.game.settings&&this.game.settings.get('botDifficulty'))||this.difficulty||'normal';
    if(this.reloadT>0)this.reloadT=Math.max(0,this.reloadT-dt);
    if(this.hitT>0)this.hitT=Math.max(0,this.hitT-dt);
    if(this.recoilKick>0)this.recoilKick=Math.max(0,this.recoilKick-dt*4.5);

    // Pick a target: the nearest enemy (bot or player)
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
    if(this.blindT>0)target=null; // lose the target while blinded
    const P=BOT_PROFILE[this.faction];
    if(target){
      const tid=target==='player'?'player':target.id;
      if(!hadTarget)this.bark('bark_spot');
      /* Reaction re-arms on every target change — swapping between two known enemies
         no longer skips the aim delay (and a fresh acquisition keeps the bark) */
      if(tid!==this._lastTargetId)
        this.reactionT=P.reaction*(this.difficulty==='hard'?.6:this.difficulty==='easy'?1.6:1);
      this._lastTargetId=tid;
    }else this._lastTargetId=null;
    if(this.reactionT>0)this.reactionT-=dt;
    if(target){
      const dx=tPos.x-this.pos.x,dz=tPos.z-this.pos.z;
      const wantYaw=Math.atan2(dx,dz);
      let dy=wantYaw-this.yaw;
      while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
      this.yaw+=dy*Math.min(1,6*dt);
      // Aim offset: head pitch + slight torso turn (read by the animation state machine)
      this.aimYaw=Math.max(-.6,Math.min(.6,dy));
      const dist0=Math.max(.001,Math.hypot(dx,dz));
      this.aimPitch=Math.max(-.5,Math.min(.5,Math.atan2(tPos.y-(this.pos.y+1.4),dist0)));

      // Movement: keep engagement distance + strafe + cover / flanking (M3-G6)
      this.strafeT-=dt;
      if(this.strafeT<=0){this.strafeT=1.5+Math.random()*2;this.strafeDir*=-1;}
      const dist=Math.max(.001,Math.hypot(dx,dz));
      const nx=dx/dist,nz=dz/dist;
      const approach=dist>P.range[1];
      const spd=this.speed*(approach?1:.6);
      let mx=0,mz=0;
      this.coverT-=dt;
      const needCover=this.hp/this.maxHp<.4||this.reloadT>0;
      if(!needCover)this.coverTarget=null;
      else if(!this.coverTarget||this.coverT<=0){
        this.coverTarget=this._findCover(tPos,losCheck);
        this.coverT=2.5;
      }
      if(this.coverTarget){
        const cdx=this.coverTarget.x-this.pos.x,cdz=this.coverTarget.z-this.pos.z;
        const cd=Math.max(.001,Math.hypot(cdx,cdz));
        mx=cdx/cd*spd;mz=cdz/cd*spd;
      }else{
        if(approach){mx+=nx*spd;mz+=nz*spd;}
        else if(dist<P.range[0]){mx-=nx*spd*.8;mz-=nz*spd*.8;}
        const flank=P.flankBias*(this.difficulty==='hard'?1.25:1);
        mx+=-nz*this.strafeDir*spd*(.35+flank*.5);
        mz+=nx*this.strafeDir*spd*(.35+flank*.5);
      }
      /* Sidestep while detouring: walk perpendicular to the desired direction (the bot keeps
         its side until the detour expires, then resumes the normal movement) */
      if(this.detourT>0){
        this.detourT-=dt;
        const dl=Math.max(.001,Math.hypot(mx,mz));
        const dx=mx/dl,dz=mz/dl;
        mx=-dz*this._detourSide*spd*1.2;
        mz= dx*this._detourSide*spd*1.2;
      }
      const k=Math.min(1,8*dt);
      this.vel.x+=(mx-this.vel.x)*k;
      this.vel.z+=(mz-this.vel.z)*k;
      this.pos.x+=this.vel.x*dt;
      this.pos.z+=this.vel.z*dt;
      this._collide(this.game.world.colliders);

      /* Stuck detection: full effort but no progress over a .4 s window (holding an already
         reached cover spot does not count) — open a perpendicular detour around the blocker */
      this._stuckChk-=dt;
      if(this._stuckChk<=0){
        const atGoal=this.coverTarget&&Math.hypot(this.coverTarget.x-this.pos.x,this.coverTarget.z-this.pos.z)<1;
        if(this.vel.length()>1&&!atGoal&&this.pos.distanceTo(this._stuckPos)<.12)this._stuck+=.4;
        else this._stuck=Math.max(0,this._stuck-.8);
        this._stuckPos.copy(this.pos);this._stuckChk=.4;
        if(this._stuck>=.8&&this.detourT<=0){
          this.detourT=.55+Math.random()*.3;
          if(!this._detourSide)this._detourSide=Math.random()<.5?1:-1;
          else if(Math.random()<.35)this._detourSide*=-1; // a failed detour may try the other side
          this._stuck=0;
        }
      }

      // Bursts / spray (no firing while reloading). The pause branch only opens the
      // inter-burst gap — firing there too made every "burst:N" fire N+1 rounds.
      this.fireT-=dt;
      if(this.fireT<=0&&this.reloadT<=0&&this.reactionT<=0){
        const clear=losCheck(eye,tPos);
        if(clear){
          if(this.burst<P.burst){this.burst++;this.fireT=P.burstT;this._shoot(tPos,target,dist,P);}
          else{this.burst=0;this.fireT=P.pause+Math.random()*.5;}
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

  /* M3-G6: sample a hiding spot behind cover (LOS blocked and closest to the bot) */
  _findCover(threat,losCheck){
    let best=null,bestD=1e9;
    const tx=threat.x,ty=threat.y||1.4,tz=threat.z;
    for(const c of this.game.world.colliders){
      if(c.top<1)continue;
      const cx=(c.minX+c.maxX)/2,cz=(c.minZ+c.maxZ)/2;
      let dx=cx-tx,dz=cz-tz;
      let d=Math.hypot(dx,dz);
      if(d<.01){dx=this.pos.x-tx;dz=this.pos.z-tz;d=Math.hypot(dx,dz)||1;}
      const hw=(c.maxX-c.minX)/2,hz=(c.maxZ-c.minZ)/2;
      const px=cx+dx/d*(hw+1.4),pz=cz+dz/d*(hz+1.4);
      // The spot must be inside the arena
      if(Math.hypot(px,pz)>50)continue;
      if(losCheck(this._coverFrom.set(px,1.4,pz),this._coverTo.set(tx,ty,tz)))continue;
      const dd=Math.hypot(px-this.pos.x,pz-this.pos.z);
      if(dd<bestD){bestD=dd;best=this._coverBest.set(px,0,pz);}
    }
    return best?best.clone():null;
  }

  /* M2-A2: radio barks (6 s cooldown per bot; muting is handled by the audio bus) */
  bark(key,force=false){
    if(!force&&this._barkT>0)return false;
    this._barkT=6;
    if(this.ui&&this.ui.bark)this.ui.bark(this.name,t(key),this.faction);
    if(this.audio&&this.audio.radio)this.audio.radio();
    return true;
  }

  /* M2-A1: animation state decision (separate method so e2e can verify it) */
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

  /* Ammo use: reload for 1.2 s after emptying the magazine; update blocks firing meanwhile */
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
    // Accuracy: spread grows with distance (Rogue hits harder but sloppier)
    const mk=P.missK*(this.difficulty==='hard'?.7:this.difficulty==='easy'?1.4:1);
    const smoked=this.game.grenades&&this.game.grenades.inSmoke(tPos);
    const miss=Math.random()<Math.min(.92,dist*.018*mk+.08+(smoked?.45:0));
    let end;
    if(miss){
      dir.add(new THREE.Vector3((Math.random()-.5)*.12,(Math.random()-.5)*.08,(Math.random()-.5)*.12)).normalize();
      // Clip the miss tracer at the first piece of cover so it never draws through walls
      _losRay.set(from,dir);_losRay.far=dist+4;
      const hit=_losRay.intersectObjects(this.game.world&&this.game.world.losStatics||[],false)[0];
      end=from.clone().addScaledVector(dir,hit?Math.max(1,hit.distance):dist+4);
    }else end=tPos.clone();
    this.fx.tracer(from,dir,from.distanceTo(end));
    // Hit effects come from botDamageFx / player hit feedback; the wall-clipped miss end keeps bullet holes off mid-air
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
    this.moveK+=((moving?1:0)-this.moveK)*Math.min(1,6*dt); // idle ↔ locomotion blend
    const idleK=1-this.moveK;
    // Every layer is a character-space delta on the part's rest pose (rig.js): procedural Groups
    // and GLB bones with arbitrary local frames animate identically
    if(this.legL){poseRot(this.legL,swing);poseRot(this.legR,-swing);}
    // Knee bend pulses through the swing window (heel-off → strike), ankle keeps the sole level
    if(this.shinL){
      const kneeL=this.moveK*Math.max(0,-Math.sin(this.walkT))*.85;
      const kneeR=this.moveK*Math.max(0,Math.sin(this.walkT))*.85;
      poseRot(this.shinL,kneeL);poseRot(this.shinR,kneeR);
      if(this.footL){poseRot(this.footL,-kneeL*.55);poseRot(this.footR,-kneeR*.55);}
    }
    // Idle weight shift: hips drift hip-to-hip
    if(this.hips)posePos(this.hips,idleK*Math.sin(time*.55)*.014,0,idleK*Math.sin(time*.34)*.006);
    // Walk bob + female hip sway (heavier steps at low health)
    let bob=moving?Math.abs(Math.cos(this.walkT))*.035:0;
    if(this.hp/this.maxHp<.35)bob*=1.4;
    this.group.position.y=this.pos.y+bob;
    let rz=this.group.rotation.z;
    if(this.gender==='f')rz+=(Math.sin(this.walkT)*(moving?.045:0)-rz)*Math.min(1,8*dt);
    else rz*=Math.max(0,1-8*dt);
    // Lean when hit
    if(this.hitT>0)rz+=this.hitDir*this.hitT*.3;
    this.group.rotation.z=rz;

    // Aiming: head pitch + torso yaw follow the target (smoothed)
    const k=Math.min(1,8*dt);
    this._headPitch+=(-this.aimPitch*.5-this._headPitch)*k;
    this._torsoYaw+=(this.aimYaw*.3-this._torsoYaw)*k;
    // Reload choreography phases (0 = just started, 1 = done):
    //   reach the chest rig → bring the mag up to the well → slap it home → settle
    let aR=this.recoilKick*.35,aL=this.recoilKick*.12;
    let magOut=0,reloadCant=0,lookDown=0;
    if(this.reloadT>0){
      const ph=1-this.reloadT/1.2;
      const ss=p=>{p=Math.max(0,Math.min(1,p));return p*p*(3-2*p);};
      const bell=p=>Math.sin(Math.max(0,Math.min(1,p))*Math.PI);
      const reach=ss(Math.min(1,ph/.3));                 // drop to the chest rig by 30 %
      const lift=ss(Math.max(0,Math.min(1,(ph-.5)/.3))); // swing up to the mag well 50-80 %
      aL=+.72*reach-.87*lift;
      aR=+.2*bell(Math.max(0,Math.min(1,(ph-.72)/.28))); // trigger hand presses the mag home
      reloadCant=-.38*bell(Math.min(1,ph/.9));           // the rifle rolls toward the support side
      magOut=ss(Math.min(1,ph/.42))-ss(Math.max(0,Math.min(1,(ph-.5)/.35)));
      lookDown=.32*bell(Math.min(1,Math.max(0,(ph-.1)/.8)));
    }
    if(this.parts.head)poseRot(this.parts.head,this._headPitch+lookDown);
    if(this.torso){
      // Breathing rise + locomotion forward lean + idle sway
      posePos(this.torso,0,Math.sin(time*1.8)*.003,0);
      const lean=this.moveK*Math.min(.09,Math.max(0,(spd-1.2)*.014));
      poseRot(this.torso,lean+idleK*Math.sin(time*.55+1.1)*.02,this._torsoYaw);
    }
    if(this.armR)poseRot(this.armR,aR);
    if(this.armL)poseRot(this.armL,aL);
    // Rifle inertia: the weapon trails a touch when the bot turns (held rifle only). Composed on
    // the held orientation — the GLB mount is a calibrated quaternion, not a zero euler
    let dy=this.yaw-this._lastYaw;
    dy=Math.atan2(Math.sin(dy),Math.cos(dy)); // ±π wrap must not read as a 2π/frame spin
    const yawV=dy/Math.max(dt,1e-3);
    this._lastYaw=this.yaw;
    this._rifleLag+=(Math.max(-4,Math.min(4,yawV))*.05-this._rifleLag)*Math.min(1,10*dt);
    const r=this.parts.rifle;
    if(r&&this._rifleBaseQ&&!this.rifleFalling&&r.parent!==this.scene)
      r.quaternion.copy(this._rifleBaseQ).multiply(_qLag.setFromAxisAngle(_Y,this._rifleLag))
        .multiply(_qCant.setFromAxisAngle(_Zc,reloadCant));
    // The magazine slides out and home with the support hand (tracked mag on the procedural rifle)
    const mag=r&&r.userData.mag;
    if(mag){mag.position.y=r.userData.magBase.y-.075*magOut;mag.rotation.x=r.userData.magBase.rx+.45*magOut;}
    // Ponytail follow-through (approximate hair physics)
    if(this.pony)poseRot(this.pony,-.15+Math.sin(time*1.7)*.05+(moving?swing*.18:0),0,Math.sin(time*1.3)*.06);
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
    // Free only this character's cloned materials; geometry is a shared module-level cache
    for(const m of this.materials)m.dispose();
  }
}

/* Faction team manager: 3 bot teammates on the player's faction (the player is the 4th) vs 4 enemies (8-operator roster, cycled) */
export class HeroTeam{
  constructor(game){
    this.game=game;
    this.list=[];
    // GLB preload races match start (?shot= / e2e): once the rigged models arrive,
    // rebuild any bot that fell back to the procedural builder so looks stay consistent
    modelAssets.onReady(()=>this.refreshModels());
  }
  refreshModels(){
    if(modelAssets.mode()!=='gltf')return;
    for(const h of this.list){
      if(h.builtWith!=='gltf'&&h.alive)h.setOperator(h.def);
    }
  }
  setup(playerFaction='ct',playerName='',playerOpId=DEFAULT_OP){
    this.clear();
    const g=this.game,scene=g.scene,assets=g.assets,fx=g.effects,audio=g.audio,ui=g.ui;
    const pf=playerFaction==='t'?'t':'ct';
    const ef=pf==='ct'?'t':'ct';
    // Roster has several operators per faction, so squads cycle through it (name suffixes
    // keep repeated operators distinguishable); match size stays 3 bot teammates + player vs 4 enemies.
    const cycle=(arr,n)=>arr.length?Array.from({length:n},(_,i)=>arr[i%arr.length]):[];
    const ownPool=byFaction(pf).filter(o=>o.id!==playerOpId);
    const own=cycle(ownPool.length?ownPool:byFaction(pf),3);
    const foe=cycle(byFaction(ef),4);
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
      h._collide(g.world.colliders); // match-start jitter can land on map geometry too
      this.list.push(h);
    }
  }
  clear(){
    for(const h of this.list)h.dispose();
    this.list.length=0;
  }
  update(dt,time,losCheck){
    for(const h of this.list)h.update(dt,time,losCheck);
    this._separate();
    /* Separation can shove a bot across a collider boundary (or fully inside one);
       re-run the push-out so nobody ends the frame embedded in geometry. */
    for(const h of this.list)if(h.alive)h._collide(this.game.world.colliders);
  }
  /* Soft bot-vs-bot separation: dead bodies and spawn clusters otherwise pass through each
     other (visible clipping in 4v4). Push overlapping alive pairs apart on XZ only. */
  _separate(){
    const L=this.list,R=.72;
    for(let i=0;i<L.length;i++)for(let j=i+1;j<L.length;j++){
      const a=L[i],b=L[j];
      if(!a.alive||!b.alive)continue;
      const dx=b.pos.x-a.pos.x,dz=b.pos.z-a.pos.z;
      const d2=dx*dx+dz*dz;
      if(d2>=R*R||d2<1e-6)continue;
      const d=Math.sqrt(d2),push=(R-d)/d*.5;
      a.pos.x-=dx*push;a.pos.z-=dz*push;
      b.pos.x+=dx*push;b.pos.z+=dz*push;
    }
    // The player is solid as well: bots yield fully out of the player's circle, and the player
    // gets a soft half push — walking straight through a bot is no longer possible
    if(this.game.player&&this.game.player.alive){
      const pp=this.game.player.pos;
      for(const h of L){
        if(!h.alive)continue;
        const dx=h.pos.x-pp.x,dz=h.pos.z-pp.z;
        const d2=dx*dx+dz*dz;
        if(d2<R*R&&d2>1e-6){
          const d=Math.sqrt(d2),push=(R-d)/d;
          h.pos.x+=dx*push;h.pos.z+=dz*push;
          pp.x-=dx*push*.5;pp.z-=dz*push*.5;
        }
      }
    }
  }
}
