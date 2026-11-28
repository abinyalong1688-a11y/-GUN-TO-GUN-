// pickups.js — M3-G2 kill drops and pickups: ammo / medkit / damage boost / weapon:
//   · spinning glowing box + halo, 2 m magnet radius, despawns after 20 s;
//   · geometry/material singletons are shared; each pickup only creates two meshes.
import * as THREE from 'three';
import { circleOverlapsCollider, resolveCircleCollisions } from './collision.js';
import { WEAPON_DEFS } from './weapon.js';

const TYPES=['ammo','med','boost','weapon','fun'];
const COLOR={ammo:0xe8c060,med:0x7fd4a0,boost:0xef6a5a,weapon:0xf5f5f5,fun:0xffd24a};
/* How many props one Fun Brawl box hands out (funItems.js owns the ammo bags). */
const FUN_REFILL=2;

export class Pickups{
  constructor(game,scene,effects,audio,ui){
    this.game=game;this.scene=scene;this.fx=effects;this.audio=audio;this.ui=ui;
    this.list=[];
    this._geo=new THREE.BoxGeometry(.26,.26,.26);
    this._ringGeo=new THREE.TorusGeometry(.34,.022,6,18);
    this._mats={};
    for(const t of TYPES){
      this._mats[t]=new THREE.MeshStandardMaterial({
        color:COLOR[t],emissive:COLOR[t],emissiveIntensity:.85,roughness:.35,metalness:.2});
    }
    this._tmp=new THREE.Vector3();
    this._ray=new THREE.Raycaster();this._down=new THREE.Vector3(0,-1,0);this._from=new THREE.Vector3();
  }

  /* Highest rendered surface below the drop.
     Casts against the flat losStatics list (cover + ground, no sky) instead of recursing the whole
     world group: the recursive version walked the sky sphere, seven distant hills and every
     decorative mesh for each drop, which cost ~2 ms per kill — measured, and it fired on every
     death of every bot. The arena floor is flat at y=0 inside the play bound (terrain.js), so an
     empty result simply means "ground level". */
  _surfaceY(x,z){
    const w=this.game.world;
    const list=w&&(w.losStatics||w.shootStatics);
    if(!list||!list.length)return 0;
    this._ray.set(this._from.set(x,30,z),this._down);this._ray.far=60;
    const hits=this._ray.intersectObjects(list,false);
    for(const hit of hits){
      if(hit.object===w.sky)continue;
      return hit.point.y;
    }
    return 0;
  }

  _anchor(p){
    p.surfaceY=this._surfaceY(p.pos.x,p.pos.z);
    p.baseY=p.surfaceY+.5;
    p.pos.y=p.baseY;
  }

  /* Magnet movement is horizontal, but it must not drag a drop through a wall. Re-anchor after
     a push so a pickup knocked off a crate falls to the next real surface instead of hovering. */
  _keepClear(p){
    const cols=this.game.world?.colliders||[],x=p.pos.x,z=p.pos.z;
    resolveCircleCollisions(p.pos,.22,cols,.26);
    if(Math.abs(p.pos.x-x)>1e-6||Math.abs(p.pos.z-z)>1e-6)this._anchor(p);
  }

  /* A defeated opponent's primary as a weapon crate (main.dropWeaponFrom). */
  addDrop(pos,rifleId){
    if(!rifleId||!WEAPON_DEFS[rifleId])return null;
    return this.drop(pos,'weapon',rifleId);
  }

  drop(pos,type='ammo',rifleId=null){
    if(!this._mats[type])return null;
    if(type==='weapon'&&(!rifleId||!WEAPON_DEFS[rifleId]))return null;
    const g=new THREE.Group();
    const box=new THREE.Mesh(this._geo,this._mats[type]);
    const ring=new THREE.Mesh(this._ringGeo,this._mats[type]);
    ring.rotation.x=Math.PI/2;
    g.add(box,ring);
    g.position.set(pos.x,.5,pos.z);
    this.scene.add(g);
    const p={type,w:rifleId,pos:g.position,group:g,life:type==='weapon'?25:20,t:0,surfaceY:0,baseY:.5};
    this._anchor(p);
    this.list.push(p);
    return p;
  }

  _canCollect(player,p){
    const dx=player.pos.x-p.pos.x,dz=player.pos.z-p.pos.z,d=Math.hypot(dx,dz);
    if(d>=.65)return false;
    const low=Math.min(player.pos.y,p.pos.y),high=Math.max(player.pos.y,p.pos.y)+1.8;
    const steps=Math.max(1,Math.ceil(d/.12));
    for(const c of this.game.world?.colliders||[]){
      if(c.top<=low+.05||(c.bottom??0)>=high)continue;
      for(let i=0;i<=steps;i++){
        const t=i/steps;
        if(circleOverlapsCollider(p.pos.x+dx*t,p.pos.z+dz*t,.05,c))return false;
      }
    }
    return true;
  }

  update(dt,player){
    for(let i=this.list.length-1;i>=0;i--){
      const p=this.list[i];
      p.life-=dt;p.t+=dt;
      if(p.life<=0){this._remove(i);continue;}
      p.group.rotation.y+=dt*2.1;
      p.group.children[1].rotation.z+=dt*1.5;
      const d=Math.hypot(player.pos.x-p.pos.x,player.pos.z-p.pos.z);
      if(d<2){
        const dir=this._tmp.set(player.pos.x-p.pos.x,0,player.pos.z-p.pos.z);
        if(dir.length()>.55){
          p.pos.add(dir.multiplyScalar(Math.min(1,dt*7)));
          this._keepClear(p);
        }
      }
      p.pos.y=p.baseY+Math.sin(p.t*3)*.11;
      if(this._canCollect(player,p)&&this._collect(p))this._remove(i);
    }
  }

  _collect(p){
    if(p.type==='ammo')this.game.weapon.addReserve(30);
    else if(p.type==='med')this.game.player.heal(25);
    else if(p.type==='boost'){
      this.game.damageBoostT=10;
      this.game.damageBoostMul=1.5;
    }
    else if(p.type==='weapon')this.collectWeapon(p.w);
    else if(p.type==='fun')this.collectFun();
    this.fx.impact(p.pos,new THREE.Vector3(0,1,0),'metal',{decal:false});
    if(this.audio&&this.audio.pickup)this.audio.pickup();
    return true;
  }

  /* Arena weapon-drop pickup: take the dropped rifle's ammo and adopt it as the first primary
     (slot 1 cycles from there). The loadout always carries all faction primaries, so "taking
     the rifle" is a slot swap + a reserve top-up; the mag ammo state is rebuilt by setLoadout. */
  collectWeapon(rifleId){
    const w=this.game.weapon;
    if(!rifleId||!w||!w.defs)return;
    const idx=w.defs.findIndex(d=>d.id===rifleId);
    const isPrimary=idx>=0&&idx<w.primaryCount;
    if(isPrimary&&idx>0){
      const ids=w.defs.slice(0,w.primaryCount).map(d=>d.id);
      const at=ids.indexOf(rifleId);
      ids.splice(at,1);
      ids.unshift(rifleId);
      const oldReserve=w.state[idx].reserve;
      w.setLoadout(ids,0);
      w.state[0].reserve=Math.min(w.defs[0].reserve*2,oldReserve+60);
    }else if(isPrimary){
      w.state[0].reserve+=60;
    }else{
      // Not in the loadout (faction primaries cover everything) — treat as reserve ammo.
      w.addReserve(60);
    }
  }

  /* Fun Brawl prop box: tops up one random prop type (funItems.js owns the counts). */
  collectFun(){
    const f=this.game.funItems;
    if(!f||!f.counts)return;
    const keys=Object.keys(f.counts);
    if(!keys.length)return;
    const k=keys[Math.floor(Math.random()*keys.length)];
    f.counts[k]+=FUN_REFILL;
    if(this.ui&&this.ui.setFunItems)this.ui.setFunItems(f.counts);
  }

  _remove(i){
    this.scene.remove(this.list[i].group);
    this.list.splice(i,1);
  }

  clear(){
    for(const p of this.list)this.scene.remove(p.group);
    this.list.length=0;
  }

  dispose(){
    this.clear();
    this._geo.dispose();this._ringGeo.dispose();
    for(const t of TYPES)this._mats[t].dispose();
  }
}
