// modes.js — King of the Hill: a hill of radius 8 m, two teams contest it, first to 200 points wins.
//
// Hill placement: pickHill() finds the most open ground near the middle of the map (the old code
// pinned the hill to the origin, where several maps keep containers / pillars — most of the
// capture zone was inside geometry). It is a pure function of the static collider list, so every
// client of an online match computes the same spot.
// Pacing: 1 point per second of ownership (+2 while contested). 200 points ≈ 3½ minutes of
// holding, inside the 4-minute match clock; before this it was 10 points per second, i.e. a
// 150-point match that could end in 15 seconds.
//
// Offline this class owns the score. Online it only *evaluates* the capture: the host sends a
// point tick to the Durable Object (room.addPoint) and the DO's s:score is the single source of
// truth, so two clients can never disagree about who is standing on the point.
import * as THREE from 'three';
import {t} from './i18n.js';

export class GameMode{
  constructor(game){this.game=game;this.active=false;}
  start(){this.active=true;}
  update(dt){}
  end(){this.active=false;}
}

export const KOTH_RADIUS = 8;
export const KOTH_WIN = 200;
export const KOTH_RATE = 1;        // points per second while one team owns the hill
export const KOTH_CONTEST_BONUS = 2;

/* Signed distance to a box footprint: > 0 outside, < 0 inside. Rotated cover uses its true OBB. */
function boxDistance(x,z,c){
  if(c.ry&&c.w&&c.d){
    const co=Math.cos(c.ry),si=Math.sin(c.ry),dx=x-c.x,dz=z-c.z;
    const lx=dx*co-dz*si,lz=dx*si+dz*co,hw=c.w*.5,hd=c.d*.5;
    const qx=Math.max(-hw,Math.min(hw,lx)),qz=Math.max(-hd,Math.min(hd,lz));
    const ox=lx-qx,oz=lz-qz;
    if(ox||oz)return Math.hypot(ox,oz);
    return -Math.min(hw-Math.abs(lx),hd-Math.abs(lz));
  }
  const dx=Math.max(c.minX-x,0,x-c.maxX),dz=Math.max(c.minZ-z,0,z-c.maxZ);
  if(dx>0||dz>0)return Math.hypot(dx,dz);
  return -Math.min(x-c.minX,c.maxX-x,z-c.minZ,c.maxZ-z);
}
/* Most open spot near the arena centre. Candidates on a `step` grid within ±`span`; each scores
   by its clearance to the nearest obstacle (capped at the hill radius) minus a small pull toward
   the centre, so an equally open site closer to the middle wins. Deterministic. */
export function pickHill(colliders,{radius=KOTH_RADIUS,cx=0,cz=0,span=30,step=2,minTop=.32,spawns=[],spawnClearance=1.5}={}){
  // Only things nobody can walk over count as obstacles. A 1 m bank rock is not a step-up
  // (.32 m), and an overhead lintel is not a ground obstacle.
  const solid=colliders.filter(c=>(c.top==null||c.top>minTop)&&(c.bottom==null||c.bottom<1.8));
  let best=null,bestScore=-Infinity;
  for(let z=cz-span;z<=cz+span+1e-6;z+=step)for(let x=cx-span;x<=cx+span+1e-6;x+=step){
    if(spawns.some(p=>Math.hypot(x-p.x,z-p.z)<radius+spawnClearance))continue;
    let clear=radius;
    for(const c of solid){const d=boxDistance(x,z,c);if(d<clear){clear=d;if(clear<=-radius)break;}}
    const score=Math.min(clear,radius)*10-Math.hypot(x-cx,z-cz);
    if(score>bestScore+1e-9){bestScore=score;best={x,z,clearance:clear};}
  }
  return best||{x:cx,z:cz,clearance:0};
}

export class KothMode extends GameMode{
  constructor(game){
    super(game);
    this.pos=new THREE.Vector3(0,0,0);
    this.radius=KOTH_RADIUS;
    this.capture=0;   // -1 ~ 1, positive means team A
    this.owner=null;
    this.score={A:0,B:0};
    this.winScore=KOTH_WIN;
    this.done=false;
    this.online=false;     // true => the DO owns the score (see update)
    this.marker=null;      // ground ring + beam (showMarker), visuals only
    this.lastTickTeam=null;
  }

  reset(){
    this.capture=0;this.owner=null;
    this.score={A:0,B:0};this.done=false;this.lastTickTeam=null;this._tick=0;
    if(this.game.ui&&this.game.ui.hideKoth)this.game.ui.hideKoth();
  }

  start(){
    super.start();
    this.reset();
    this.place();
    this.showMarker();
  }

  /* Put the hill on open ground (see pickHill). Without a world (unit tests) it stays at the origin. */
  place(){
    const g=this.game,w=this.game&&this.game.world;
    const colliders=w&&(w.colliders||w.kothColliders);
    if(colliders&&colliders.length){
      const spawns=[...(g?.spawns?Object.values(g.spawns):[]),...(g?.player?[g.player.pos]:[])];
      const spot=pickHill(colliders,{radius:this.radius,spawns});
      this.pos.set(spot.x,0,spot.z);
      this.clearance=spot.clearance;
    }else this.pos.set(0,0,0);
    // The arena is flat inside its play bound (terrain.ARENA_FLAT_RADIUS), so y = ground level.
    this._syncMarker();
    return this.pos;
  }

  /* Ground ring + light pillar so the hill can actually be found: cyan = NOVA owns it,
     orange = ROGUE, white = neutral / being flipped. Pure visuals — nothing gameplay reads them. */
  showMarker(){
    const g=this.game;
    if(!g||!g.scene||this.marker)return;
    const grp=new THREE.Group();
    grp.name='koth-hill';
    // depthTest:false keeps the capture ring readable where a low rock/kerb sits inside the
    // hill (ember's lava rim): pickHill deliberately allows standable bumps, so a purely
    // depth-tested y=.06 ring would vanish under them and hide the objective boundary.
    const ringMat=new THREE.MeshBasicMaterial({color:0xdbe6f4,transparent:true,opacity:.75,
      side:THREE.DoubleSide,depthWrite:false,depthTest:false});
    const ring=new THREE.Mesh(new THREE.RingGeometry(this.radius-.45,this.radius,72),ringMat);
    ring.rotation.x=-Math.PI/2;ring.position.y=.06;ring.renderOrder=5;
    const innerMat=ringMat.clone();innerMat.opacity=.22;
    const disc=new THREE.Mesh(new THREE.CircleGeometry(this.radius-.45,72),innerMat);
    disc.rotation.x=-Math.PI/2;disc.position.y=.05;disc.renderOrder=4;
    const beamMat=new THREE.MeshBasicMaterial({color:0xdbe6f4,transparent:true,opacity:.10,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide});
    const beam=new THREE.Mesh(new THREE.CylinderGeometry(1.6,2.2,80,24,1,true),beamMat);
    beam.position.y=40;beam.renderOrder=6;
    grp.add(disc,ring,beam);
    grp.position.copy(this.pos);
    g.scene.add(grp);
    this.marker={grp,ringMat,innerMat,beamMat};
  }
  _syncMarker(){
    const m=this.marker;
    if(!m)return;
    m.grp.position.copy(this.pos);
    if(this._markerOwner!==this.owner){
      this._markerOwner=this.owner;
      const c=this.owner==='A'?0x7fd4ff:this.owner==='B'?0xff8a6a:0xdbe6f4;
      for(const mat of [m.ringMat,m.innerMat,m.beamMat])mat.color.setHex(c);
    }
  }

  hideMarker(){
    const m=this.marker;
    if(!m)return;
    if(m.grp.parent)m.grp.parent.remove(m.grp);
    m.grp.traverse(o=>{if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});
    this.marker=null;this._markerOwner=null;
  }

  _inside(pos){
    const dx=pos.x-this.pos.x,dz=pos.z-this.pos.z;
    return dx*dx+dz*dz<=this.radius*this.radius;
  }

  update(dt){
    if(!this.active||this.done)return;
    const g=this.game;
    if(this.marker)this._syncMarker();
    let a=0,b=0;
    if(g.player.alive&&this._inside(g.player.pos))a++;
    for(const h of g.heroes.list){
      if(!h.alive||!this._inside(h.pos))continue;
      if(h.team==='A')a++;else b++;
    }
    const diff=a-b;
    if(diff>0)this.capture=Math.min(1,this.capture+dt*.32*Math.min(3,diff));
    else if(diff<0)this.capture=Math.max(-1,this.capture+dt*.32*Math.max(-3,diff));
    if(this.capture>=1)this.owner='A';
    else if(this.capture<=-1)this.owner='B';

    this.lastTickTeam=null;
    const shown=this.online?((g.dm&&g.dm.score)||this.score):this.score; // online mirrors the DO; local KOTH owns the points
    if(this.owner){
      if(this.online){
        // Host only: one point per second of ownership (KOTH_RATE). The DO ignores anyone else.
        this._tick=(this._tick||0)+dt;
        if(this._tick>=1/KOTH_RATE){this._tick-=1/KOTH_RATE;this.lastTickTeam=this.owner;}
        g.ui.setKoth(this.owner,(this.capture+1)/2,Math.floor(shown.A||0),Math.floor(shown.B||0));
        return;
      }
      this.score[this.owner]+=dt*KOTH_RATE;
      if(a>0&&b>0)this.score[this.owner]+=dt*KOTH_CONTEST_BONUS; // contested: faster scoring
      if(this.score[this.owner]>=this.winScore){
        this.done=true;
        g.ui.banner(this.owner==='A'?t('koth_win'):t('koth_lose'),t('koth_name'));
        if(g._endMode)g._endMode(this.owner==='A');
      }
    }
    g.ui.setKoth(this.owner,(this.capture+1)/2,Math.floor(shown.A||0),Math.floor(shown.B||0));
  }

  end(){super.end();this.hideMarker();if(this.game&&this.game.ui)this.game.ui.hideKoth();}
}
