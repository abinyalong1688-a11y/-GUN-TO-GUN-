// heroes.js — realistic 3D faction characters (third person) + offline 3v3 / online 5v5 bot deathmatch:
//   looks are built by character.js from operator definitions (8 operators / camos / silhouettes);
//   combat style by faction (Nova steady bursts / Rogue heavy spray); death: fall → limbs land flat → fade out → respawn.
import * as THREE from 'three';
import { pushCircleOut } from './collision.js';
import {t,isEN} from './i18n.js';
import {byId,byFaction,DEFAULT_OP} from './operators.js';
import {SnapshotBuffer} from './interp.js';
import {buildOperatorMeshAuto,fadeMaterials} from './character.js';
import {modelAssets} from './modelAssets.js';
import {rigInit,poseRot,posePos,poseReset} from './rig.js';
import {BotBrain} from './botBrain.js';
import {findBestCover} from './botCombat.js';
import {ColliderGrid,SpatialGrid} from './world.js';

/* Compatibility layer: legacy code reads base stats per faction; the data lives in operators.js */
const _opCT=byId('frost'),_opT=byId('raven');
const _botSpeed=op=>Math.round(5.2*op.speedMul*10)/10;
export const HERO_DEFS={
  ct:{label:`${_opCT.name.en} · Nova Operator`,hp:_opCT.hp,speed:_botSpeed(_opCT),gender:_opCT.gender},
  t:{label:`${_opT.name.en} · Rogue Mercenary`,hp:_opT.hp,speed:_botSpeed(_opT),gender:_opT.gender},
};
const FACTION_HEX={ct:'#7fd4ff',t:'#ff8a6a'};
/* Bot combat style: Nova fires steady bursts, Rogue sprays hard.
   NOTE: the live brains get their combat parameters from botConfig.getBotParams (difficulty ×
   faction × operator identity — the Longbow operator carries SNIPER_OVERRIDES there). This
   table is the pre-brain fallback only: _claimSpot reads it when a hero has no brain yet. */
const BOT_PROFILE={
  ct:{burst:3,burstT:.13,pause:1.2,missK:1.0,dmgP:6,dmgH:12,range:[7,16],reaction:.25,coverBias:.6,flankBias:.3},
  t:{burst:5,burstT:.11,pause:1.5,missK:1.35,dmgP:9,dmgH:15,range:[6,13],reaction:.18,coverBias:.4,flankBias:.6},
};

let BID=0;
const _Y=new THREE.Vector3(0,1,0),_Zc=new THREE.Vector3(0,0,1),_qLag=new THREE.Quaternion(),_qCant=new THREE.Quaternion();
const _hitC1=new THREE.Vector3(),_hitC2=new THREE.Vector3(),_hitC3=new THREE.Vector3(); // scratch: hitSpheres must not allocate per shot
const _losRay=new THREE.Raycaster(); // shared: clips miss tracers at cover (no through-wall tracers)

/* ---- Bot navigation (P0–P3): _stepMove / _slide / _avoidVel / _planPath ---- */
const SEP_R=1.05;      // soft separation radius: personal space starts closing at 1.05 m
const RVO_R=.8;        // bot-pair radius of the velocity-obstacle test (P3)
const RVO_HZ=1;        // velocity-obstacle time horizon (s)
const NAV_R=.42;       // route clearance disc (just under the .45 collide radius: grazing is passable)
const GN=20,GC=.5,GHALF=GN*GC/2; // local planning window: 20×20 cells of .5 m = 10×10 m around the bot
let NAV_FRAME=0;       // frame counter; route / cover planning is staggered over three bot groups (P2)
let TEAM_DEPTH=0;      // >0 while HeroTeam.update drives the bots (one neighbour grid per frame)
const _botGrid=new SpatialGrid(2);
let _botGridFrame=-1,_botGridList=null;
const _near=[],_nbrs=[],_sepOut=[0,0],_goal={x:0,z:0};
const _gScore=new Float32Array(GN*GN),_parent=new Int16Array(GN*GN),_shut=new Uint8Array(GN*GN),_walk=new Uint8Array(GN*GN);
/* Alive bots within r of a point — one shared 2 m grid per frame. Built on demand, so a bot
   updated outside HeroTeam.update (unit tests / e2e) takes exactly the same path. */
function botNeighbors(list,x,z,r,out){
  if(_botGridList!==list||_botGridFrame!==NAV_FRAME){
    _botGridList=list;_botGridFrame=NAV_FRAME;_botGrid.clear();
    for(const h of list)if(h.alive)_botGrid.insertBox(h.pos.x,h.pos.z,h.pos.x,h.pos.z,h);
  }
  return _botGrid.query(x,z,r,out);
}

/* M2-A5: name tag health bar — both geometries shared at module level, materials per bot */
const TAG_BG_GEO=new THREE.PlaneGeometry(.62,.075);
const TAG_BAR_GEO=new THREE.PlaneGeometry(.58,.05).translate(.29,0,0);

/* Name-tag textures are cached: 7 bots used to allocate 7 new 256x64 GPU textures per match.
   The cache is bounded — past the cap the tag is created unshared and freed with its bot, so a
   long online session with many unique names cannot grow GPU memory without limit. */
const TAG_TEX_CACHE=new Map();
const TAG_TEX_CACHE_MAX=64;
function nameTagTexture(name,faction){
  const key=name+'|'+faction;
  let t=TAG_TEX_CACHE.get(key);
  if(!t){
    const c=document.createElement('canvas');c.width=256;c.height=64;
    const g=c.getContext('2d');
    g.font='bold 28px "Microsoft YaHei",sans-serif';
    g.textAlign='center';g.textBaseline='middle';
    g.shadowColor='rgba(0,0,0,.9)';g.shadowBlur=6;
    g.fillStyle=FACTION_HEX[faction];
    g.fillText(name,128,32); // faction is shown by the tag colour
    t=new THREE.CanvasTexture(c);
    t.colorSpace=THREE.SRGBColorSpace;
    if(TAG_TEX_CACHE.size<TAG_TEX_CACHE_MAX){
      t.userData.shared=true;  // module cache: must not be disposed by a single bot
      TAG_TEX_CACHE.set(key,t);
    }
  }
  return t;
}

function makeNameTag(name,faction){
  const t=nameTagTexture(name,faction);
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
  constructor(game,scene,assets,effects,audio,ui,{operator,team,name,netId=0,netDriven=false,kind='bot',spawnBase=null,faction=null,isSimulated=false}){
    this.game=game;this.scene=scene;this.assets=assets;this.fx=effects;this.audio=audio;this.ui=ui;
    this.id=++BID;
    this.def=operator;
    this.opId=operator.id;
    this.kind=kind;                  // 'bot' | 'human'
    this.netId=netId;                // network id (0 = local AI)
    this.netDriven=netDriven;        // true = position comes from snapshots
    this.netBuf=null;                // interp.SnapshotBuffer
    this.spawnBase=spawnBase;        // respawn base (null = game.spawns[team])
    this.isSimulated=isSimulated;    // host-owned bot proxy
    this.faction=faction||operator.faction;
    this.hero=this.faction;          // compatibility field: combat style / faction label follow the faction
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
    /* Navigation (P0–P3). Stuck escape: a blocker on the walking line can pin the bot — progress
       is tracked every frame and a sideways escape opens when it grinds in place. */
    this.radius=.45;                     // static collision radius
    this.prio=1;                          // right of way this frame: 3 engaged / 2 advancing / 1 repositioning
    this.wing=this.id%3-1;                // approach line (left / centre / right): teammates fan out instead of queueing
    this.wingK=3.5+Math.random()*2;       // how far the side lines sit from the centre one (m)
    this.holdD=8;                         // personal stand-off distance from the target (m)
    this._offA=Math.random()*6.283;this._offR=1.6; // own point on a ring around the target
    this.goalX=0;this.goalZ=0;            // where the bot is walking this frame (debug / e2e)
    this.detourT=0;this._detourSide=this.id&1?1:-1;this._escTot=0;
    this._stuckT=0;this._lastEscape=-9;this._clock=0;
    this._turnT=0;                        // 0.2 s ease-in after a waypoint change
    this._route=null;this._routeT=0;this._routeGX=0;this._routeGZ=0; // waypoints around blockers
    this._blockWp=null;this._blockT=0;    // waypoint that proved unreachable → planned around
    this._dirX=0;this._dirZ=1;            // last walking direction (escape with no desired velocity)
    this._sepDirty=false;                 // moved by the hard-overlap fallback this frame
    this.flankDir=Math.random()>.5?1:-1;
    this.reactionT=0;this._lastTargetId=null; // last target identity — reaction re-arms when it changes
    this.difficulty=(game.settings&&game.settings.get('botDifficulty'))||'normal';
    /* Perception + behavior tree (botBrain.js). Installed before buildBody so the first
       update after a spawn already has senses; the brain only reads entity state. */
    this.brain=new BotBrain(this);
    this._targetId=null;
    this._jitterT=new THREE.Vector3();
    this._shotT=-99; // last gunfire time: heard by enemy bots (botBrain.js)
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
    if(this.brain)this.brain.reset();
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
    // Remote crouch is carried in PEER_FLAGS.CROUCH; use it so hitboxes match the pose.
    const crouch=(this.netDriven&&this._netState&&this._netState.crouch) ? .42 : 0;
    const hy=(this.headY||1.6)-crouch;
    const by=.95-crouch*.8;
    _hitC1.set(this.pos.x,this.pos.y+hy,this.pos.z);
    _hitC2.set(this.pos.x,this.pos.y+by,this.pos.z);
    // Small neck sphere closes the old 7–11 cm gap between head (top 1.37/1.44) and body.
    _hitC3.set(this.pos.x,this.pos.y+1.40-crouch,this.pos.z);
    return [
      {c:_hitC1,r:.16,part:'head'},
      {c:_hitC2,r:.42,part:'body'},
      {c:_hitC3,r:.09,part:'body'},
    ];
  }

  takeDamage(n,fromName,headshot=false,fromId=null,kind='weapon',fromPos=null){
    if(!this.alive)return -1;
    if(this.netDriven){
      // Remote avatar: the victim's own client settles HP. Never mutate local HP here.
      // `kind` names the damage source ('weapon' | 'frag' | {kind:'weapon',w:<rifleId>}) — the
      // DO recomputes damage from it, so a host-simulated bot's hit carries ITS rifle, never
      // the host player's currently-held gun.
      const source=typeof kind==='object'?kind:{kind};
      if(this.game.netMatch)this.game.netMatch.requestHit(this,n,fromName,headshot,source);
      return -1;
    }
    if(fromId)this._lastHitFrom=fromId;
    this.hp-=n;
    if(this.nameTag&&this.nameTag.bar)
      this.nameTag.bar.scale.x=Math.max(.001,Math.min(1,this.hp/this.maxHp));
    this.flashT=.09;
    this.hitT=.35;this.hitDir=Math.random()>.5?1:-1;
    if(this.hp/this.maxHp<.35&&!this._lowBarked&&this.bark('bark_low'))this._lowBarked=true;
    for(const m of this.flashable){m.emissive.setHex(0xffffff);m.emissiveIntensity=.6;}
    if(this.hp<=0){
      this.die(fromName,headshot,fromId);
      return -1;
    }
    // Being hit is a perception event: turn toward (and remember) the shooter even from behind.
    if(this.brain&&fromName){
      let ent=null,pos=fromPos;
      if(fromName===this.game.playerName){
        ent='player';
        pos=this.game.player.pos; // feet, not the camera: memory adds chest height itself
      }else{
        ent=this.game.heroes.list.find(h=>h.name===fromName)||null;
        if(!pos&&ent)pos=ent.pos;
      }
      if(pos)this.brain.onDamaged(pos,ent,this.game.time||0);
    }
    return this.hp;
  }

  /* C2: death — fall over in 0.7 s with the limbs landing flat, corpse gone ≈0.8 s later; respawn after 5.5 s */
  die(byName,headshot=false,fromId=null){
    if(!this.alive)return;
    if(this.netDriven){ this._netDie(); return; } // remote death comes from the DO's s:kill; no local scoring
    this.alive=false;
    this.state='dying';
    this.deathT=0;
    this.respawnT=5.5;
    this.vel.set(0,0,0); // stop dead — the corpse falls where it dropped, no slide
    this.game.onHeroKill(byName,this,headshot,fromId||this._lastHitFrom||null);
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
    this._lastTargetId=null;this._offA=null; // drop any claimed stand-off point from the last life
    this._restoreFlash(); // the killing hit's white flash is never restored in the death branch; restore it on respawn or the bot stays white
    this.coverTarget=null;this.coverT=0;
    if(this.brain)this.brain.reset();
    this.vel.set(0,0,0); // don't inherit the death-frame velocity into the new life
    /* A real side, never 0: _stepMove multiplies the sideways escape by it, so 0 would open an
       escape that moves nowhere (the old value; see _escape for the self-healing path) */
    this.strafeDir=Math.random()>.5?1:-1;this.flankDir=Math.random()>.5?1:-1;this._detourSide=this.id&1?1:-1;
    this.fireT=1+Math.random();this.burst=0;
    if(this.nameTag&&this.nameTag.bar)this.nameTag.bar.scale.x=1;
    for(const o of this._animParts)poseReset(o);
    this._headPitch=0;this._torsoYaw=0;
    this.group.rotation.x=0;this.group.rotation.z=0;
    const base=this.spawnBase || (this.game.spawns ? this.game.spawns[this.team]
      : (this.team==='A'?new THREE.Vector3(0,0,24):new THREE.Vector3(0,0,-24)));
    this.place(base.clone().add(new THREE.Vector3((Math.random()-.5)*8,0,(Math.random()-.5)*8)),
      this.team==='A'?Math.PI:0);
    this._collide(this.game.world.colliders); // jittered spawn can land on map geometry (caldera gate pillars)
    this._stuckT=0;this.detourT=0;this._escTot=0;this._turnT=0;this._blockT=0;
    this._route=null;this._routeT=0;
    this.audio.respawn();
    this._shotT=-99;
    // Dead bots are skipped by HeroTeam.refreshModels — catch up on the GLB swap here
    if(this.builtWith!==modelAssets.mode())this.setOperator(this.def);
  }

  _restoreFlash(){
    for(const m of this.flashable){
      m.emissiveIntensity=m.userData.baseEI??0;
      if(m.userData.baseEH!=null)m.emissive.setHex(m.userData.baseEH);
    }
  }

  /* Collide + slide: separate X and Z so a bot walks *along* a wall face instead of
     grinding into it. Returns {hitX, hitZ} — which axes were blocked this frame — so the
     movement code can decide a detour when both are blocked (a corner / dead-end). */
  _collide(colliders){
    const r=this.radius;
    let hitX=false,hitZ=false;
    for(const c of colliders){
      if(this.pos.y>c.top)continue;
      // OBB-aware push-out; the resulting position delta tells us which axes were blocked.
      const bx=this.pos.x,bz=this.pos.z;
      if(pushCircleOut(this.pos,r,c)){
        if(Math.abs(this.pos.x-bx)>1e-6)hitX=true;
        if(Math.abs(this.pos.z-bz)>1e-6)hitZ=true;
      }
    }
    const dd=Math.hypot(this.pos.x,this.pos.z);
    if(dd>52){const k=52/dd;this.pos.x*=k;this.pos.z*=k;}
    return {hitX,hitZ};
  }

  /* P1 — one position write per frame, fixed order; nothing edits `pos` except the single
     integrate step, so a repelled or wall-sliding bot never ping-pongs between a shove and its
     own steering:
       desired velocity → squad spacing → stuck escape → separation / RVO → smoothing →
       integrate → normal-projection slide → stuck bookkeeping */
  _stepMove(mx,mz,dt){
    const spd=this.speed,px=this.pos.x,pz=this.pos.z;
    let want=Math.hypot(mx,mz);
    const dx0=want>0?mx/want:0,dz0=want>0?mz/want:1; // true destination direction (before the escape)
    if(want<.08){mx=0;mz=0;want=0;} // P0 dead-band: micro-oscillation never reaches the position
    else{this._dirX=dx0;this._dirZ=dz0;}
    /* P2 squad spacing: a teammate just ahead (inside the walking cone) slows this bot down
       instead of letting it tailgate — the follower brakes, the leader keeps its speed */
    if(want>0){
      let k=1;
      for(const h of botNeighbors(this.game.heroes.list,px,pz,1.9,_nbrs)){
        if(h===this||h.team!==this.team||!h.alive)continue;
        const dx=h.pos.x-px,dz=h.pos.z-pz,d=Math.hypot(dx,dz);
        if(d<1.8&&dx*dx0+dz*dz0>d*.8){const s=Math.max(.2,d/1.8);if(s<k)k=s;}
      }
      if(k<1){mx*=k;mz*=k;}
    }
    /* P0.4 stuck escape: a fixed sideways velocity while the way ahead stays walled */
    if(this.detourT>0){
      this.detourT-=dt;this._escTot+=dt;
      mx=-dz0*this._detourSide*spd;mz=dx0*this._detourSide*spd;
    }
    const sep=this._avoidVel(spd);
    let wx=mx+sep[0],wz=mz+sep[1];
    const wl=Math.sqrt(wx*wx+wz*wz);
    if(wl>spd){wx*=spd/wl;wz*=spd/wl;} // avoidance redirects, it never makes a bot faster than its own speed
    const k=Math.min(1,(this._turnT>0?4:8)*dt); // a waypoint change eases the turn in over .2 s (P1)
    if(this._turnT>0)this._turnT-=dt;
    this.vel.x+=(wx-this.vel.x)*k;this.vel.z+=(wz-this.vel.z)*k;
    this.pos.x+=this.vel.x*dt;this.pos.z+=this.vel.z*dt;
    const block=this._slide(dx0*want,dz0*want); // 1 = the destination is square behind the wall

    /* Stuck detection (P0.4): pushing with no progress for .8 s — .4 s when it just escaped, a
       repeated jam escalates — opens an escape; a square-on contact opens one at once. */
    const moved=Math.hypot(this.pos.x-px,this.pos.z-pz);
    if(want>1&&this.detourT<=0&&moved<want*dt*.1)this._stuckT+=dt;
    else this._stuckT=Math.max(0,this._stuckT-dt*2);
    /* P2.4 backtracking: a route that stops paying off is abandoned and its next waypoint is
       planned around */
    if(this._stuckT>.35&&this._route&&this._route.length){
      this._blockWp={x:this._route[0].x,z:this._route[0].z};this._blockT=3;
      this._route=null;this._routeT=0;this._stuckT=0;
    }
    if(this.detourT>0)return;
    let opened=false;
    if(want>1){
      // The way ahead is still walled when an escape runs out → renew it (the sideways slide
      // continues instead of grinding back into the wall)
      const renew=this._escTot>0&&this._escTot<1.6&&block>.85;
      if(renew||block>.9||this._stuckT>=this.stuckLimit()){this._escape(dx0,dz0,!renew);opened=true;}
    }
    if(!opened)this._escTot=0;
  }

  stuckLimit(){return this._clock-this._lastEscape<1.2?.4:.8;}

  _escape(dx,dz,fresh){
    /* Side: the one with room (a 1.1 m probe), otherwise the current side is kept. `_detourSide`
       may still be 0 on a bot built before the field was fixed up (or restored from an old
       snapshot); 0 zeroes the sideways velocity in _stepMove, so the escape would reopen every
       frame and move the bot nowhere. Normalise to a real side and write the pick back, so the
       "keep the current side" branch is self-healing. */
    let cur=this._detourSide||(this.id&1?1:-1);
    const room=s=>this._ptFree(this.pos.x-dz*s*1.1,this.pos.z+dx*s*1.1);
    if(!room(cur)&&room(-cur))cur=-cur;
    this._detourSide=cur;
    this.detourT=.3;
    if(fresh)this._escTot=0;
    this._lastEscape=this._clock;this._stuckT=0;
  }

  /* Can a bot-sized disc stand at (x,z)? — escape-side probes */
  _ptFree(x,z){
    if(x*x+z*z>51.5*51.5)return false;
    for(const c of this._nearColliders(x,z,NAV_R)){
      if(c.top<=this.pos.y)continue;
      const cx=Math.max(c.minX,Math.min(x,c.maxX)),cz=Math.max(c.minZ,Math.min(z,c.maxZ));
      if((x-cx)*(x-cx)+(z-cz)*(z-cz)<NAV_R*NAV_R)return false;
    }
    return true;
  }

  /* Colliders whose footprint overlaps the square (x±r, z±r). One code path with and without a
     pre-built grid: the map's grid is reused, anything else (tests) gets one on the spot. */
  _nearColliders(x,z,r){
    const w=this.game.world,cols=w.colliders;
    let g=w.colliderGrid;
    if(!g||g.colliders!==cols){g=new ColliderGrid(cols);w.colliderGrid=g;}
    return g.query(x,z,r,_near);
  }

  /* P1 — normal-projection sliding. The contact normal is read from the circle-vs-box overlap (a
     true normal: diagonal at a corner) and only the velocity component *into* the surface is
     removed; what is left runs along the wall. Two passes handle a wall corner. Residual
     penetration is relaxed 40 % per contact per frame instead of snapping back in one frame (P0
     debounce); only a deep one is cleared at once. */
  _slide(desX,desZ){
    const r=this.radius,y=this.pos.y;
    const cols=this._nearColliders(this.pos.x,this.pos.z,r+.35);
    const dl=Math.hypot(desX,desZ);
    let block=0;
    for(let pass=0;pass<2;pass++){
      let bc=null,bnx=0,bnz=0,bpen=0,bd2=1;
      for(const c of cols){
        if(c.top<=y)continue;
        const cx=c.minX>this.pos.x?c.minX:c.maxX<this.pos.x?c.maxX:this.pos.x;
        const cz=c.minZ>this.pos.z?c.minZ:c.maxZ<this.pos.z?c.maxZ:this.pos.z;
        const dx=this.pos.x-cx,dz=this.pos.z-cz,d2=dx*dx+dz*dz;
        if(d2>=r*r)continue;
        const pen=r-Math.sqrt(d2);
        if(pen>bpen){bc=c;bpen=pen;bd2=d2;bnx=dx;bnz=dz;}
      }
      if(!bc)break;
      let nx,nz;
      if(bd2<1e-12){
        // Centre inside the box: pop to the nearest face + r (no meaningful escape axis from dead-centre)
        const dl2=this.pos.x-bc.minX,dr=bc.maxX-this.pos.x,dn=this.pos.z-bc.minZ,df=bc.maxZ-this.pos.z;
        const m=Math.min(dl2,dr,dn,df);
        if(m===dr){this.pos.x=bc.maxX+r;nx=1;nz=0;}
        else if(m===dl2){this.pos.x=bc.minX-r;nx=-1;nz=0;}
        else if(m===df){this.pos.z=bc.maxZ+r;nx=0;nz=1;}
        else{this.pos.z=bc.minZ-r;nx=0;nz=-1;}
      }else{
        const d=Math.sqrt(bd2);nx=bnx/d;nz=bnz/d;
        const k=bpen>r*.25?1:.4;
        this.pos.x+=nx*bpen*k;this.pos.z+=nz*bpen*k;
      }
      /* Velocity: drop the part going into the surface; the tangential part keeps 90 % of the
         approach speed, so a bot that hits a wall at an angle runs along it */
      const vn=this.vel.x*nx+this.vel.z*nz;
      if(vn<0){
        const s0=Math.sqrt(this.vel.x*this.vel.x+this.vel.z*this.vel.z);
        this.vel.x-=nx*vn;this.vel.z-=nz*vn;
        const s1=Math.sqrt(this.vel.x*this.vel.x+this.vel.z*this.vel.z);
        if(s1>s0*.15){const q=s0*.9/s1;this.vel.x*=q;this.vel.z*=q;}
      }
      if(dl>0){const b=-(desX*nx+desZ*nz)/dl;if(b>block)block=b;}
    }
    // Arena boundary (r=52) slides like a wall
    const dd=Math.hypot(this.pos.x,this.pos.z);
    if(dd>52){
      const k=52/dd;this.pos.x*=k;this.pos.z*=k;
      const out=(this.vel.x*this.pos.x+this.vel.z*this.pos.z)/2704;
      if(out>0){this.vel.x-=this.pos.x*out;this.vel.z-=this.pos.z*out;}
      if(dl>0){const b=(desX*this.pos.x+desZ*this.pos.z)/(dl*52);if(b>block)block=b;}
    }
    return block;
  }

  /* P1.3 soft separation + P3.1 simplified RVO (2-D, neighbours within 5 m). Pure velocity:
     the result is added to the desired velocity and resolved by the one position write in
     _stepMove. RVO projects both bots forward and, if they would touch inside the horizon, bends
     the velocity by this bot's share of the difference — more natural than a shove in multi-bot
     crossings. Right of way (P2): the lower-priority bot takes the larger share of the avoidance.
     RVO may only use what the personal-space term leaves of the half-speed budget, so a dense
     crowd never dilutes the separation that keeps bodies apart, and never flings a bot. */
  _avoidVel(spd){
    const out=_sepOut;out[0]=0;out[1]=0;
    const me=this.pos,p=this.game.player;
    const nbrs=botNeighbors(this.game.heroes.list,me.x,me.z,5.2,_nbrs);
    if(p&&p.alive)nbrs.push(p); // the player is solid: bots steer around the player, never through
    const cap=spd*.5;let sx=0,sz=0,rx=0,rz=0;
    for(let i=0;i<nbrs.length;i++){
      const o=nbrs[i];
      if(o===this||!o.alive)continue;
      const qx=me.x-o.pos.x,qz=me.z-o.pos.z,d2=qx*qx+qz*qz; // me − other
      if(d2>25||d2<1e-8)continue;
      const d=Math.sqrt(d2),op=o.prio||3;
      const yo=op/(this.prio+op); // share of the avoidance this bot takes (equal priority → ½)
      const k=(SEP_R-d)/SEP_R;
      if(k>0){const s=spd*k*yo;sx+=qx/d*s;sz+=qz/d*s;} // personal space (RVO sees nothing when both stand still)
      const ov=o.vel;
      const ux=this.vel.x-(ov?ov.x:0),uz=this.vel.z-(ov?ov.z:0),u2=ux*ux+uz*uz;
      if(u2<1e-6)continue;
      const proj=-(qx*ux+qz*uz)/u2; // time of closest approach
      if(proj<=0)continue;          // already separating
      const dc2=d2-proj*proj*u2;    // squared miss distance
      if(dc2>=RVO_R*RVO_R)continue;
      const tc=proj-Math.sqrt(RVO_R*RVO_R-dc2)/Math.sqrt(u2);
      if(tc>RVO_HZ)continue;
      const it=1/Math.max(tc,.1);
      let nx,nz;
      const dc=Math.sqrt(dc2);
      if(dc<.3&&ov&&this._dirX*ov.x+this._dirZ*ov.z<0){
        /* Dead-centre and head-on: the contact normal degenerates into the line between the two
           bots, so RVO can only brake and the pair locks face to face forever. The tie is broken
           the way people pass in a corridor — each keeps to its own right (right of the walking
           direction), the less so the wider the miss already is */
        const mix=1-dc/.3,rxv=-this._dirZ,rzv=this._dirX;
        const bx=qx/d+rxv*1.732*mix,bz=qz/d+rzv*1.732*mix,bl=Math.sqrt(bx*bx+bz*bz);
        nx=bx/bl;nz=bz/bl;
      }else{const ic=dc>1e-4?1/dc:0;nx=(qx+ux*proj)*ic;nz=(qz+uz*proj)*ic;} // contact normal (other → me)
      let ax=((RVO_R*nx-qx)*it-ux)*yo,az=((RVO_R*nz-qz)*it-uz)*yo;
      const al=Math.sqrt(ax*ax+az*az);
      if(al>cap*.5){ax*=cap*.5/al;az*=cap*.5/al;}
      rx+=ax;rz+=az;
    }
    const sl=Math.sqrt(sx*sx+sz*sz);
    if(sl>cap){sx*=cap/sl;sz*=cap/sl;}
    const rl=Math.sqrt(rx*rx+rz*rz),room=Math.max(0,cap-sl);
    if(rl>room&&rl>0){rx*=room/rl;rz*=room/rl;}
    out[0]=sx+rx;out[1]=sz+rz;return out;
  }

  update(dt,time,losCheck){
    if(this.netDriven)return this._updateNet(dt,time);
    if(!TEAM_DEPTH)NAV_FRAME++; // a bot stepped outside HeroTeam.update: its own frame
    this._clock+=dt;
    if(this._blockT>0)this._blockT=Math.max(0,this._blockT-dt); // P2.4 window: the abandoned waypoint is only avoided for 3 s
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

    /* Perception + behavior tree + combat intent (botBrain.js). The brain only publishes
       intent; navigation, collision, route recovery, animation and the shot stay here. */
    this.brain.update(dt,time,losCheck);
    this._applyBrainAim(dt);
    this._applyBrainMovement(dt);

    this.moving=this.vel.length()>.5;
    this.hasTarget=!!(this.brain&&this.brain.target);
    this._targetId=this.brain?this.brain.targetId:null;
    this._decideAnim(this.brain?this.brain.target:null,dt);
    this._animate(dt,time,this.vel.length());
    this.group.position.set(this.pos.x,this.group.position.y,this.pos.z);
    this.group.rotation.y=this.yaw;
  }

  /* Face the brain's aim point / navigation heading; head pitch and torso yaw feed the
     animation layers exactly as before (the aim is now a lead-corrected point). */
  _applyBrainAim(dt){
    const b=this.brain;
    let tx=null,ty=null,tz=null;
    if(b&&b.hasAim&&b.aimPoint){tx=b.aimPoint.x;ty=b.aimPoint.y;tz=b.aimPoint.z;}
    else if(b&&b.facePoint){tx=b.facePoint.x;ty=b.facePoint.y!=null?b.facePoint.y:this.pos.y+1.4;tz=b.facePoint.z;}
    else if(b&&b.faceYaw!=null){
      tx=this.pos.x+Math.sin(b.faceYaw)*6;tz=this.pos.z+Math.cos(b.faceYaw)*6;ty=this.pos.y+1.4;
    }else if(this.vel.lengthSq()>.09){
      tx=this.pos.x+this.vel.x;tz=this.pos.z+this.vel.z;ty=this.pos.y+1.4;
    }
    if(tx==null){this.aimYaw*=.9;this.aimPitch*=.9;return;}
    const dx=tx-this.pos.x,dz=tz-this.pos.z;
    if(Math.abs(dx)+Math.abs(dz)<1e-4)return;
    const wantYaw=Math.atan2(dx,dz);
    let dy=wantYaw-this.yaw;
    while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
    const rate=(b&&b.params&&b.params.turnRate)||6;
    this.yaw+=dy*Math.min(1,rate*dt);
    this.aimYaw=Math.max(-.6,Math.min(.6,dy));
    const dist=Math.max(.001,Math.hypot(dx,dz));
    const aimY=ty==null?this.pos.y+1.1:ty;
    this.aimPitch=Math.max(-.5,Math.min(.5,Math.atan2(aimY-(this.pos.y+1.4),dist)));
  }

  /* Apply the brain's movement intent through main's navigation stack (one position write per
     frame, squad spacing, separation/RVO, slide, stuck escape and local-grid path planning). */
  _applyBrainMovement(dt){
    const b=this.brain;
    if(!b)return;
    if(b.mode==='nav'&&b.navGoal){
      this._walkToGoal(b.navGoal,b.navSpeed,dt);
    }else if(b.mode==='combat'&&(b.moveX!==0||b.moveZ!==0)){
      this._stepMove(b.moveX,b.moveZ,dt);
    }else{
      this._stepMove(0,0,dt); // coast / slide, never keep stale velocity on record
    }
  }

  /* Navigation goal → route waypoints → desired velocity, then main's _stepMove. The route is
     re-planned on the staggered planning frame (every third bot frame) to keep the raycast cost
     bounded, and abandoned when the goal moves on or the straight line opens up. */
  _walkToGoal(goal,speedScale,dt){
    const plan=NAV_FRAME%3===this.id%3;
    let wx=goal.x,wz=goal.z;
    // An EMPTY waypoint list is "no route": it is truthy, so without this it latched forever —
    // the bot never re-planned and walked straight into whatever blocked the direct line
    // (a bot standing at its spawn for a whole match, "engaging" someone across the map).
    if(this._route&&!this._route.length)this._route=null;
    if(this._route&&this._route.length){
      wx=this._route[0].x;wz=this._route[0].z;
      if(Math.hypot(wx-this.pos.x,wz-this.pos.z)<.4){
        this._route.shift();this._turnT=.2;
        if(this._route.length){wx=this._route[0].x;wz=this._route[0].z;}
        else{wx=goal.x;wz=goal.z;}
      }
    }
    this._routeT-=dt;
    if(plan){
      if(this._route&&this._route.length&&(Math.hypot(goal.x-this._routeGX,goal.z-this._routeGZ)>2.5
        ||this._segFree(this.pos.x,this.pos.z,goal.x,goal.z)))this._route=null;
      if(!this._route&&this._routeT<=0){
        this._routeT=.35;
        if(!this._segFree(this.pos.x,this.pos.z,goal.x,goal.z)){
          this._route=this._planPath(goal.x,goal.z);
          if(this._route&&!this._route.length)this._route=null;
          // Local window too small (spawn pocket behind a building): ask the squad layer's
          // whole-map grid for a route instead of grinding into the wall forever.
          if(!this._route&&this.game.squad&&this.game.squad.route)this._route=this._globalRoute(goal.x,goal.z);
          if(this._route&&this._route.length){
            this._routeGX=goal.x;this._routeGZ=goal.z;this._turnT=.2;
            this.detourT=0;this._escTot=0; // a route supersedes the blind sideways escape
            wx=this._route[0].x;wz=this._route[0].z;
          }
        }
      }
    }
    const cdx=wx-this.pos.x,cdz=wz-this.pos.z,cd=Math.hypot(cdx,cdz);
    const arrive=Math.min(1,cd/.8); // ease into the last metre: no overshoot wobble on the spot
    const spd=this.speed*speedScale;
    if(cd>1e-4)this._stepMove(cdx/cd*spd*arrive,cdz/cd*spd*arrive,dt);
    else this._stepMove(0,0,dt);
    this.goalX=wx;this.goalZ=wz;
  }

  /* P0: personal target point. Every bot keeps its own stand-off distance and its own point on a
     ring around the target; a teammate that already claims a nearby point pushes the roll
     elsewhere, so two bots never converge on the same spot. Re-rolled on every target change. */
  _claimSpot(){
    /* Stand-off distance follows the operator's real engagement band. The brain's preset is
       the single truth (a Longbow operator holds 10–15 m here, not the faction SMG's 6–9.5);
       BOT_PROFILE stays as the fallback for brains built before loadout sync (tests). */
    const P=(this.brain&&this.brain.baseParams&&Array.isArray(this.brain.baseParams.range))
      ?this.brain.baseParams:BOT_PROFILE[this.faction];
    this.holdD=P.range[0]+Math.random()*(P.range[1]-P.range[0])*.5;
    /* Best of up to 8 draws: the point furthest from every teammate's point on this target, taken
       at once as soon as one is 1.2 m clear of all of them */
    let bestA=0,bestR=1.2,bestD=-1,bestH=null; // bestH = the closest teammate to the best draw
    for(let i=0;i<8;i++){
      const a=Math.random()*Math.PI*2,r=1.2+Math.random()*.8;
      const x=Math.cos(a)*r,z=Math.sin(a)*r;
      let d=Infinity,near=null;
      for(const h of this.game.heroes.list){
        if(h===this||h.team!==this.team||!h.alive||h._lastTargetId!==this._lastTargetId||h._offA==null)continue;
        const dj=Math.hypot(Math.cos(h._offA)*h._offR-x,Math.sin(h._offA)*h._offR-z);
        if(dj<d){d=dj;near=h;}
      }
      if(d>=1.2){this._offA=a;this._offR=r;return;}
      if(d>bestD){bestD=d;bestA=a;bestR=r;bestH=near;}
    }
    /* All 8 draws collide: fall back to the best one, but guarantee separation — slide it
       along the ring away from the nearest claim until it clears every teammate by 1.3 m
       (the RNG can converge two bots onto the same corner; the offset walk cannot). */
    const clearOfAll=(a,r)=>{
      const x=Math.cos(a)*r,z=Math.sin(a)*r;
      for(const h of this.game.heroes.list){
        if(h===this||h.team!==this.team||!h.alive||h._lastTargetId!==this._lastTargetId||h._offA==null)continue;
        if(Math.hypot(Math.cos(h._offA)*h._offR-x,Math.sin(h._offA)*h._offR-z)<1.3)return false;
      }
      return true;
    };
    if(bestH){
      const hx=Math.cos(bestH._offA)*bestH._offR,hz=Math.sin(bestH._offA)*bestH._offR;
      const bx=Math.cos(bestA)*bestR,bz=Math.sin(bestA)*bestR;
      const away=Math.atan2(bz-hz,bx-hx); // direction from the nearest claim to the draw
      // Walk the angle outward in both directions (s<8: s=8 would land back on the known
      // colliding draw), keeping the radius, until all claims clear.
      for(let s=1;s<8;s++){
        if(clearOfAll(away+s*Math.PI/4,bestR)){bestA=away+s*Math.PI/4;break;}
        if(clearOfAll(away-s*Math.PI/4,bestR)){bestA=away-s*Math.PI/4;break;}
      }
    }
    // Last resort 1: fine-grained angle sweep around the best draw.
    if(!clearOfAll(bestA,bestR)){
      for(let s=0;s<24;s++){
        const a=bestA+(s%2?1:-1)*Math.ceil(s/2)*Math.PI/12;
        if(clearOfAll(a,bestR)){bestA=a;break;}
      }
    }
    // Last resort 2: the whole ring band is saturated (rare: >5 teammates on one target).
    // Widen the radius — the outer ring geometrically holds more 1.3 m-separated points
    // (≈9 at r 2.4 vs ≈5 at r 1.2) — sweeping angle×radius until a clear slot exists.
    if(!clearOfAll(bestA,bestR)){
      outer:
      for(const r of[1.8,2.4,3.0]){
        for(let s=0;s<24;s++){
          const a=bestA+s*Math.PI/12;
          if(clearOfAll(a,r)){bestA=a;bestR=r;break outer;}
        }
      }
    }
    this._offA=bestA;this._offR=bestR;
  }

  /* M3-G6: sample a hiding spot behind cover (LOS blocked and closest to the bot).
     The candidate is pushed to the cover's *outer edge* (a full 1.4 m + half-extent out from
     the centre along the threat→cover axis), and rejected if it would land inside any other
     collider — so a bot never routes itself straight into a wall it cannot reach. */
  _findCover(threat,losCheck){
    return findBestCover(this,threat,losCheck);
  }

  /* Segment clearance: true when a bot-sized disc (.42 m, slightly under the .45 collide
     radius so grazing an edge still counts as passable) swept along a→b touches no collider.
     Only the colliders under the segment are tested (grid). */
  _segFree(ax,az,bx,bz){
    const len=Math.hypot(bx-ax,bz-az);
    const cols=this._nearColliders((ax+bx)/2,(az+bz)/2,len/2+.5);
    if(!cols.length)return true;
    const n=Math.max(1,Math.ceil(len/.3));
    for(let i=1;i<=n;i++){
      const t=i/n,px=ax+(bx-ax)*t,pz=az+(bz-az)*t;
      for(const c of cols){
        if(c.top<=this.pos.y)continue;
        const cx=Math.max(c.minX,Math.min(px,c.maxX)),cz=Math.max(c.minZ,Math.min(pz,c.maxZ));
        if((px-cx)*(px-cx)+(pz-cz)*(pz-cz)<NAV_R*NAV_R)return false;
      }
    }
    return true;
  }

  /* Path to a point the straight line cannot reach: local-grid A* first, the corner route as
     the fallback for anything a 10 m window cannot see around. */
  _planPath(gx,gz){
    return this._gridPath(gx,gz)||this._cornerRoute(gx,gz);
  }

  /* Whole-map route from the squad layer (squadAI.route → NavGrid A*), as the same waypoint
     list _walkToGoal consumes. Re-planned by the caller every .35 s while it is in use. */
  _globalRoute(gx,gz){
    const pts=this.game.squad.route(this,gx,gz);
    if(!pts||!pts.length)return null;
    // the first stretch of a smoothed path can start behind the bot: skip waypoints we already passed
    let i=0;
    while(i<pts.length-1&&Math.hypot(pts[i][0]-this.pos.x,pts[i][1]-this.pos.z)<.6)i++;
    const out=[];
    for(;i<pts.length;i++)out.push({x:pts[i][0],z:pts[i][1]});
    return out.length?out:null;
  }

  /* P3.2 local grid A*: a 10×10 m window of .5 m cells centred on the bot, rebuilt for every
     plan, so it follows the bot and needs no baked navmesh. Returns world-space waypoints, or
     null when there is no way through inside the window. */
  _gridPath(gx,gz){
    const px=this.pos.x,pz=this.pos.z,y=this.pos.y;
    const ox=Math.floor((px-GHALF)/GC)*GC,oz=Math.floor((pz-GHALF)/GC)*GC;
    const tx=Math.min(Math.max(gx,ox+.25),ox+GN*GC-.25),tz=Math.min(Math.max(gz,oz+.25),oz+GN*GC-.25);
    const cols=this._nearColliders(px,pz,GHALF+1);
    const bw=this._blockT>0?this._blockWp:null; // P2.4: a waypoint that proved unreachable
    _walk.fill(0);
    const free=ix=>{ // 0 unknown / 1 free / 2 blocked
      const w=_walk[ix];
      if(w)return w===1;
      const cx=ix%GN,cz=(ix-cx)/GN,x=ox+(cx+.5)*GC,z=oz+(cz+.5)*GC;
      let ok=x*x+z*z<51.5*51.5&&!(bw&&(bw.x-x)*(bw.x-x)+(bw.z-z)*(bw.z-z)<.36);
      if(ok)for(const c of cols){
        if(c.top<=y)continue;
        const ax=c.minX>x?c.minX:c.maxX<x?c.maxX:x,az=c.minZ>z?c.minZ:c.maxZ<z?c.maxZ:z;
        if((x-ax)*(x-ax)+(z-az)*(z-az)<NAV_R*NAV_R){ok=false;break;}
      }
      _walk[ix]=ok?1:2;
      return ok;
    };
    const cellOf=(x,z)=>Math.max(0,Math.min(GN-1,Math.floor((z-oz)/GC)))*GN
      +Math.max(0,Math.min(GN-1,Math.floor((x-ox)/GC)));
    const s=cellOf(px,pz);
    let g=cellOf(tx,tz);
    if(!free(g)){ // the goal cell is blocked (or the goal lies outside the window): nearest free cell
      let bd=1e9;
      for(let ix=0;ix<GN*GN;ix++){
        if(!free(ix))continue;
        const cx=ix%GN,cz=(ix-cx)/GN,dx=ox+(cx+.5)*GC-tx,dz=oz+(cz+.5)*GC-tz,d=dx*dx+dz*dz;
        if(d<bd){bd=d;g=ix;}
      }
      if(bd===1e9||g===s)return null;
    }
    _gScore.fill(Infinity);_shut.fill(0);_parent.fill(-1);
    _gScore[s]=0;
    const open=[s];
    while(open.length){
      let bi=0;
      for(let i=1;i<open.length;i++)if(_gScore[open[i]]<_gScore[open[bi]])bi=i;
      const cur=open[bi];open[bi]=open[open.length-1];open.pop();
      if(cur===g)break;
      if(_shut[cur])continue;
      _shut[cur]=1;
      const cx=cur%GN,cz=(cur-cx)/GN;
      for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dz)continue;
        const nx=cx+dx,nz=cz+dz;
        if(nx<0||nx>=GN||nz<0||nz>=GN)continue;
        const ni=nz*GN+nx;
        if(_shut[ni]||!free(ni))continue;
        if(dx&&dz&&(!free(cz*GN+nx)||!free(nz*GN+cx)))continue; // no corner cutting
        const ng=_gScore[cur]+(dx&&dz?.7071:1)*GC;
        if(ng<_gScore[ni]){_gScore[ni]=ng;_parent[ni]=cur;open.push(ni);}
      }
    }
    if(g!==s&&_parent[g]<0)return null;
    const cells=[];
    for(let c=g;c>=0;c=_parent[c]){cells.push(c);if(c===s)break;}
    if(cells[cells.length-1]!==s)return null;
    cells.reverse();
    const pts=[{x:px,z:pz}];
    for(let i=1;i<cells.length;i++){const c=cells[i],cx=c%GN;pts.push({x:ox+(cx+.5)*GC,z:oz+((c-cx)/GN+.5)*GC});}
    /* String pulling: keep only the waypoints where the path has to turn (clearance-checked) */
    const out=[];
    for(let i=0;i<pts.length-1;){
      let j=pts.length-1;
      while(j>i+1&&!this._segFree(pts[i].x,pts[i].z,pts[j].x,pts[j].z))j--;
      out.push(pts[j]);i=j;
    }
    return out.length?out:null;
  }

  /* Corner route around blocking boxes — the fallback for walls longer than the local grid
     window. Candidate corners are the collider corners inflated by the bot radius, restricted
     to the start→goal corridor.
     P1.5: sorted by the angle to the goal direction (the most on-the-way corner first) and every
     leg is clearance-checked, so a corner hidden behind another box is never chosen.
     P2.4: a beam search chains up to four corners, which carries a bot around several boxes in
     a row. Deterministic — no random side picks. Returns null when nothing connects. */
  _cornerRoute(gx,gz){
    const px=this.pos.x,pz=this.pos.z,y=this.pos.y;
    if(this._segFree(px,pz,gx,gz))return null;
    const e=this.radius+.1;
    const mnx=Math.min(px,gx)-4,mxx=Math.max(px,gx)+4,mnz=Math.min(pz,gz)-4,mxz=Math.max(pz,gz)+4;
    const cand=[];
    for(const c of this.game.world.colliders){
      if(c.top<=y)continue;
      if(c.maxX+e<mnx||c.minX-e>mxx||c.maxZ+e<mnz||c.minZ-e>mxz)continue;
      for(const [x,z] of [[c.minX-e,c.minZ-e],[c.minX-e,c.maxZ+e],[c.maxX+e,c.minZ-e],[c.maxX+e,c.maxZ+e]]){
        // The playfield ends at r=52 (the slide clamps there), so a corner outside it is no
        // waypoint at all — the local grid already refuses cells past 51.5 m; match that here.
        if(x*x+z*z>51.5*51.5)continue;
        cand.push([x,z]);
      }
    }
    if(!cand.length)return null;
    const ga=Math.atan2(gx-px,gz-pz);
    const off=c=>{const a=Math.atan2(c[0]-px,c[1]-pz)-ga;return Math.abs(Math.atan2(Math.sin(a),Math.cos(a)));};
    cand.sort((a,b)=>off(a)-off(b));
    let frontier=[{x:px,z:pz,path:[],len:0}];
    const seen=new Uint8Array(cand.length);
    for(let depth=0;depth<4&&frontier.length;depth++){
      const next=[];
      for(const n of frontier)for(let i=0;i<cand.length;i++){
        if(seen[i])continue;
        const [x,z]=cand[i];
        if(!this._segFree(n.x,n.z,x,z))continue;
        seen[i]=1;
        const path=[...n.path,{x,z}];
        if(this._segFree(x,z,gx,gz))return path;
        next.push({x,z,path,len:n.len+Math.hypot(x-n.x,z-n.z)});
      }
      next.sort((a,b)=>a.len-b.len);
      frontier=next.slice(0,6);
    }
    return null;
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

  _shoot(aimPoint,target,dist,P,miss){
    this._consumeAmmo();
    const from=this._fromT;
    this.gunTip.getWorldPosition(from);
    const dir=this._dirT.copy(aimPoint).sub(from).normalize();
    let end;
    if(miss){
      const j=this._jitterT.set((Math.random()-.5)*.12,(Math.random()-.5)*.08,(Math.random()-.5)*.12);
      dir.add(j).normalize();
      // Clip the miss tracer at the first piece of cover so it never draws through walls
      _losRay.set(from,dir);_losRay.far=dist+4;
      const hit=_losRay.intersectObjects(this.game.world&&this.game.world.losStatics||[],false)[0];
      end=from.clone().addScaledVector(dir,hit?Math.max(1,hit.distance):dist+4);
    }else end=aimPoint.clone();
    // M-G whiz-by: a miss that passes close to the player gets the ear-feeling it lacks.
    // The occlusion test is muzzle→PLAYER (the old muzzle→end check was always true: end is
    // by construction the first cover hit, so the whole segment to it is clear).
    if(miss&&target==='player'&&this.audio&&this.audio.whiz){
      const pl=this.game.player.pos;
      const proj=(pl.x-from.x)*dir.x+(pl.z-from.z)*dir.z; // player projected onto the shot line (2D; height is not what makes a whiz)
      if(proj>1&&proj<dist+4){ // only while the round actually passes the player, not long after
        const cx=from.x+dir.x*proj,cz=from.z+dir.z*proj;
        const near=Math.hypot(pl.x-cx,pl.z-cz);
        if(near<2.6&&this.game._los&&this.game._los(from,{x:pl.x,y:pl.y+1.2,z:pl.z})){
          this.audio.whiz(near);
          if(this.game.shake!=null)this.game.shake=Math.max(this.game.shake,.06*(1-near/2.6)); // tiny flinch, no damage
        }
      }
    }
    this.fx.tracer(from,dir,from.distanceTo(end));
    this.audio.botShot(this.game.player.pos.distanceTo(this.pos));
    this._shotT=this.game.time||0;
    if(this.game.squad)this.game.squad.onBotShot(this,target,dist,!miss);
    if(!miss){
      if(target==='player'){
        this.game.damagePlayerFromBot(P.dmgP,this.name,this.pos);
      }else{
        // source.w pins the weapon the SERVER recomputes damage from: without it a host-simulated
        // bot hitting a remote human inherits the host player's currently-held gun (WEAPON_DMG
        // would score an AK-wielding host's vulture at 115/hit instead of the rifle it carries).
        target.takeDamage(P.dmgH,this.name,false,this.netId||this.name,
          {kind:'weapon',w:this.def&&this.def.rifle},this.pos);
        this.game.botDamageFx(target,aimPoint);
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

  /* ---------------- network-driven avatars (remote humans / replicated bots) ---------------- */
  _updateNet(dt,time){
    const match=this.game.netMatch;
    const rt=match?match.renderTime(this.kind):time;
    const s=this.netBuf&&this.netBuf.sample(rt,this.kind);
    if(!s){this.group.visible=false;return;}
    this._netState=s;                       // hitSpheres reads crouch from here
    this.group.scale.y=s.crouch ? .72 : 1;  // minimal crouch pose for remote avatars
    const dx=s.x-this.pos.x,dz=s.z-this.pos.z;
    this.vel.set(dt>0?dx/dt:0,0,dt>0?dz/dt:0);
    this.pos.set(s.x,s.y,s.z);
    this.yaw=s.yaw;
    if(this.nameTag){
      const d=this.game.camera.position.distanceTo(this.pos);
      const a=Math.max(0,Math.min(1,(46-d)/16));
      this.nameTag.group.visible=a>.01;
      this.nameTag.sprite.material.opacity=a;
      this.nameTag.bg.material.opacity=a*.75;
      this.nameTag.bar.material.opacity=a*.95;
    }
    const wasAlive=this.alive,alive=!!s.alive;
    if(wasAlive&&!alive)this._netDie();
    if(!wasAlive&&alive)this._netRevive();
    this.alive=alive;
    if(this.nameTag&&this.nameTag.bar)
      this.nameTag.bar.scale.x=Math.max(.001,Math.min(1,(s.hp||0)/this.maxHp));
    this.hp=s.hp;
    if(!alive){
      // Mirror the local death collapse so remote corpses look identical (no local scoring).
      this.deathT+=dt;
      const k1=Math.min(1,this.deathT/.28);
      const kraw=Math.max(0,Math.min(1,(this.deathT-.28)/.42));
      const k2=kraw*kraw*(3-2*kraw);
      this.group.rotation.x=-Math.PI/2.2*k2;
      this.group.rotation.y=this.yaw;
      this.group.position.set(this.pos.x,this.pos.y+.3*k2,this.pos.z);
      if(this.hips){posePos(this.hips,0,-.22*k1,0);poseRot(this.hips,0,this.hitDir*.5*k1*(1-k2*.7),0);}
      if(this.shinL){const fold=.95*k1*(1-k2);poseRot(this.shinL,fold);poseRot(this.shinR,fold*.8);}
      if(this.armR)poseRot(this.armR,.72*k2,0,.04*k2);
      if(this.armL)poseRot(this.armL,.85*k2,-.35*k2,-.5*k2);
      if(this.deathT>.7)fadeMaterials(this.materials,Math.max(0,1-(this.deathT-.7)/.8));
      this._updateDroppedRifle(dt);
      this.group.visible=this.deathT<1.55;
      return;
    }
    this.state='active';
    this.moving=this.vel.length()>.5;
    this._animate(dt,time,this.vel.length());
    this.group.position.set(this.pos.x,this.pos.y,this.pos.z);
    this.group.rotation.set(0,this.yaw,0);
    this.group.visible=true;
  }
  _netDie(){
    if(this.state==='dying'||this.state==='dead')return;
    this.alive=false;this.state='dying';this.deathT=0;
    this.vel.set(0,0,0);
    this.dropRifle();
    this.fx.bloodPuff&&this.fx.bloodPuff(new THREE.Vector3(this.pos.x,this.pos.y+1.1,this.pos.z));
  }
  _netRevive(){
    this._restoreRifle();
    fadeMaterials(this.materials,1);
    this._restoreFlash();
    for(const o of this._animParts)poseReset(o);
    this.state='active';this.deathT=0;this.hp=this.maxHp;
    this.group.rotation.x=0;this.group.visible=true;
    if(this.nameTag&&this.nameTag.bar)this.nameTag.bar.scale.x=1;
  }

  dispose(){
    this.scene.remove(this.group);
    if(this.parts.rifle&&this.parts.rifle.parent===this.scene)this.scene.remove(this.parts.rifle);
    if(this.nameTag){
      if(this.nameTag.tex&&!this.nameTag.tex.userData.shared)this.nameTag.tex.dispose();
      if(this.nameTag.sprite&&this.nameTag.sprite.material)this.nameTag.sprite.material.dispose();
      if(this.nameTag.bg&&this.nameTag.bg.material)this.nameTag.bg.material.dispose();
      if(this.nameTag.bar&&this.nameTag.bar.material)this.nameTag.bar.material.dispose();
      this.nameTag=null;
    }
    // Free only this character's cloned materials; geometry is a shared module-level cache
    for(const m of this.materials)m.dispose();
  }
}

/* Faction team manager: offline 3v3 (2 bot teammates + the player vs 3 enemies); online/training 5v5 via opts (8-operator roster, cycled) */
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
  setup(playerFaction='ct',playerName='',playerOpId=DEFAULT_OP,opts={}){
    this.clear();
    const g=this.game,scene=g.scene,assets=g.assets,fx=g.effects,audio=g.audio,ui=g.ui;
    const hasOpts=!!opts&&!!(opts.sizes||opts.roster||opts.bots||opts.humans||opts.playerTeam);
    const place=(h,team,spread=10)=>{
      const base=h.spawnBase||(g.spawns?g.spawns[team]:new THREE.Vector3(0,0,team==='A'?24:-24));
      h.place(base.clone().add(new THREE.Vector3((Math.random()-.5)*spread,0,(Math.random()-.5)*spread)),
        team==='A'?Math.PI:0);
      h._collide(g.world.colliders); // jittered spawn can land on map geometry (caldera gate pillars)
    };
    if(!hasOpts){
      // Offline deathmatch / KOTH (3v3): 2 bot teammates + the player vs 3 enemies.
      const pf=playerFaction==='t'?'t':'ct';
      const ef=pf==='ct'?'t':'ct';
      const cycle=(arr,n)=>arr.length?Array.from({length:n},(_,i)=>arr[i%arr.length]):[];
      const ownPool=byFaction(pf).filter(o=>o.id!==playerOpId);
      const own=cycle(ownPool.length?ownPool:byFaction(pf),2);
      const foe=cycle(byFaction(ef),3);
      const used=new Set([playerName]);
      const nm=o=>{
        let n=isEN()?o.name.en:o.name.zh;
        if(used.has(n)){let i=2;while(used.has(n+' '+i))i++;n=n+' '+i;}
        used.add(n);
        return n;
      };
      for(const d of [...own.map(o=>({operator:o,team:'A'})),...foe.map(o=>({operator:o,team:'B'}))]){
        const base=d.operator;
        const op=g.camoFor?{...base,camo:g.camoFor(base)}:{...base};
        const h=new HeroBot(g,scene,assets,fx,audio,ui,{operator:op,team:d.team,name:nm(base)});
        place(h,d.team);
        this.list.push(h);
      }
      return;
    }
    /* Online / training 5v5: remote humans + host-replicated bots + local AI fill. */
    const {
      sizes={A:5,B:5}, humans={A:0,B:0}, playerTeam='A',
      roster=[], bots=[], isHost=false, online=false,
    }=opts;
    const pf=online?(playerTeam==='A'?'ct':'t'):(playerFaction==='t'?'t':'ct');
    const ef=pf==='ct'?'t':'ct';
    const teamFaction=team=>team===playerTeam?pf:ef;
    const used=new Set([playerName]);
    const nm=o=>{
      let n=isEN()?o.name.en:o.name.zh;
      if(used.has(n)){let i=2;while(used.has(n+' '+i))i++;n=n+' '+i;}
      used.add(n);return n;
    };
    for(const r of roster){
      const base=byId(r.op)||byId(DEFAULT_OP);
      const fac=teamFaction(r.team);
      const op={...base,camo:r.camo||'default',faction:fac};
      const h=new HeroBot(g,scene,assets,fx,audio,ui,{
        operator:op,team:r.team,name:r.name||nm(base),faction:fac,
        netId:r.netId||r.id,netDriven:true,kind:'human',
        spawnBase:g.spawns?g.spawns[r.team]:null,
      });
      h.netBuf=new SnapshotBuffer(32);
      place(h,r.team);this.list.push(h);used.add(h.name);
    }
    for(const b of bots){
      const base=byId(b.op)||byId(DEFAULT_OP);
      const fac=teamFaction(b.team);
      const op={...base,camo:'default',faction:fac};
      const h=new HeroBot(g,scene,assets,fx,audio,ui,{
        operator:op,team:b.team,name:b.name||nm(base),faction:fac,
        netId:b.id,netDriven:!isHost,kind:'bot',isSimulated:!!isHost,
        spawnBase:g.spawns?g.spawns[b.team]:null,
      });
      if(h.netDriven)h.netBuf=new SnapshotBuffer(32);
      place(h,b.team);this.list.push(h);used.add(h.name);
    }
    for(const team of ['A','B']){
      const botsHere=this.list.filter(h=>h.team===team&&h.kind==='bot').length;
      const need=(sizes[team]||0)-(humans[team]||0)-(playerTeam===team?1:0)-botsHere;
      if(need<=0)continue;
      const f=teamFaction(team);
      const pool=byFaction(f).filter(o=>o.id!==playerOpId);
      const poolAll=byFaction(f);
      const src=pool.length?pool:(poolAll.length?poolAll:[byId(DEFAULT_OP)]);
      for(let i=0;i<need;i++){
        const base=src[i%src.length];
        const op=g.camoFor?{...base,camo:g.camoFor(base),faction:f}:{...base,faction:f};
        const h=new HeroBot(g,scene,assets,fx,audio,ui,{operator:op,team,name:nm(base),faction:f});
        place(h,team);this.list.push(h);
      }
    }
  }
  adopt(hero){ this.list.push(hero); return hero; }
  byNetId(id){ return this.list.find(h=>h.netId===id&&h.netId) || null; }
  clear(){
    for(const h of this.list)h.dispose();
    this.list.length=0;
  }
  update(dt,time,losCheck){
    NAV_FRAME++; // one neighbour grid for the whole frame
    TEAM_DEPTH++;
    try{
      for(const h of this.list){
        if(h.netDriven)h._updateNet(dt,time); // remote avatars consume snapshots, never local AI
        else h.update(dt,time,losCheck);
      }
    }finally{TEAM_DEPTH--;}
    this._separate();
    /* The overlap fallback can shove a bot across a collider boundary (or fully inside one);
       re-run the push-out on exactly those bots so nobody ends the frame embedded in geometry. */
    for(const h of this.list)if(h.alive&&!h.netDriven&&h._sepDirty){h._sepDirty=false;h._collide(this.game.world.colliders);}
  }
  /* Hard-overlap fallback (last resort, P1 keeps it idle in normal play): movement itself is
     resolved at the velocity level, so this only fires when bots already overlap — spawn clusters
     and dead bodies — where a positional split is the only way out. Dead bodies and spawn
     clusters otherwise pass through each other (visible clipping in 3v3). Overlapping alive
     pairs are pushed apart on XZ only; the lower-priority bot takes the larger share (P2). */
  _separate(){
    const L=this.list,R=.72;
    for(let i=0;i<L.length;i++)for(let j=i+1;j<L.length;j++){
      const a=L[i],b=L[j];
      // A net-driven proxy belongs to another client: never displace it locally.
      if(!a.alive||!b.alive||a.netDriven||b.netDriven)continue;
      const dx=b.pos.x-a.pos.x,dz=b.pos.z-a.pos.z;
      const d2=dx*dx+dz*dz;
      if(d2>=R*R||d2<1e-6)continue;
      const d=Math.sqrt(d2),push=(R-d)/d,ta=(a.prio||1)+ (b.prio||1),ka=(b.prio||1)/ta;
      a.pos.x-=dx*push*ka;a.pos.z-=dz*push*ka;
      b.pos.x+=dx*push*(1-ka);b.pos.z+=dz*push*(1-ka);
      a._sepDirty=b._sepDirty=true;
    }
    // The player is solid as well: bots yield fully out of the player's circle, and the player
    // gets a soft half push — walking straight through a bot is no longer possible
    if(this.game.player&&this.game.player.alive){
      const pp=this.game.player.pos;
      for(const h of L){
        if(!h.alive||h.netDriven)continue;
        const dx=h.pos.x-pp.x,dz=h.pos.z-pp.z;
        const d2=dx*dx+dz*dz;
        if(d2<R*R&&d2>1e-6){
          const d=Math.sqrt(d2),push=(R-d)/d;
          h.pos.x+=dx*push;h.pos.z+=dz*push;h._sepDirty=true;
          pp.x-=dx*push*.5;pp.z-=dz*push*.5;
        }
      }
    }
  }
}
