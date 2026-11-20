// pickups.js — M3-G2 kill drops and pickups: ammo / medkit / damage boost:
//   · spinning glowing box + halo, 2 m magnet radius, despawns after 20 s;
//   · geometry/material singletons are shared; each pickup only creates two meshes.
import * as THREE from 'three';

const TYPES=['ammo','med','boost'];
const COLOR={ammo:0xe8c060,med:0x7fd4a0,boost:0xef6a5a};

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
  }

  spawn(pos,type='ammo'){
    if(!this._mats[type])return null;
    const g=new THREE.Group();
    const box=new THREE.Mesh(this._geo,this._mats[type]);
    const ring=new THREE.Mesh(this._ringGeo,this._mats[type]);
    ring.rotation.x=Math.PI/2;
    g.add(box,ring);
    g.position.set(pos.x,.5,pos.z);
    this.scene.add(g);
    const p={type,pos:g.position,group:g,life:20,t:0};
    this.list.push(p);
    return p;
  }

  update(dt,player){
    for(let i=this.list.length-1;i>=0;i--){
      const p=this.list[i];
      p.life-=dt;p.t+=dt;
      if(p.life<=0){this._remove(i);continue;}
      p.group.rotation.y+=dt*2.1;
      p.group.children[1].rotation.z+=dt*1.5;
      p.pos.y=.5+Math.sin(p.t*3)*.11;
      const d=p.pos.distanceTo(player.pos);
      if(d<2){
        const dir=this._tmp.copy(player.pos).sub(p.pos);dir.y=0;
        if(dir.length()>.55)p.pos.add(dir.multiplyScalar(Math.min(1,dt*7)));
        else if(this._collect(p))this._remove(i);
      }
    }
  }

  _collect(p){
    if(p.type==='ammo')this.game.weapon.addReserve(30);
    else if(p.type==='med')this.game.player.heal(25);
    else if(p.type==='boost'){
      this.game.damageBoostT=10;
      this.game.damageBoostMul=1.5;
    }
    this.fx.impact(p.pos,new THREE.Vector3(0,1,0),'metal',{decal:false});
    if(this.audio&&this.audio.pickup)this.audio.pickup();
    return true;
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
