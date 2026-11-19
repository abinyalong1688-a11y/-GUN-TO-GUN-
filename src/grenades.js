// grenades.js —— M3-G1 手雷系统(破片 / 闪光 / 烟雾):
//   · 真实抛物线 + 地面/掩体反弹;
//   · 破片 6m AoE,闪光 LOS+距离致盲,烟雾遮蔽 AI 命中;
//   · 零外部资源,几何/材质单例复用,热路径无逐帧分配。
import * as THREE from 'three';

const DEFS={
  frag:{fuse:1.6,color:0x39452e,radius:6,damage:78},
  flash:{fuse:1.35,color:0xd8dce4,radius:10},
  smoke:{fuse:2.0,color:0x4a5560,radius:4},
};

export class Grenades{
  constructor(game,scene,effects,audio,ui){
    this.game=game;this.scene=scene;this.fx=effects;this.audio=audio;this.ui=ui;
    this.counts={frag:2,flash:2,smoke:1};
    this.list=[];
    this.smokes=[];
    this._geo=new THREE.IcosahedronGeometry(.12,1);
    this._mats={};
    for(const k in DEFS)this._mats[k]=new THREE.MeshStandardMaterial({color:DEFS[k].color,roughness:.65,metalness:.12});
    this._v=new THREE.Vector3();this._dir=new THREE.Vector3();this._tmp=new THREE.Vector3();
  }

  reset(){this.counts={frag:2,flash:2,smoke:1};this.clear();}

  /* type: frag | flash | smoke;返回是否成功投出 */
  throw(type){
    if(!DEFS[type]||this.counts[type]<=0)return false;
    const g=this.game,cam=g.camera;
    this._dir.set(0,0,-1).applyQuaternion(cam.quaternion).normalize();
    const pos=this._tmp.copy(cam.position).addScaledVector(this._dir,.6);
    const mesh=new THREE.Mesh(this._geo,this._mats[type]);
    mesh.position.copy(pos);
    this.scene.add(mesh);
    this.list.push({
      type,pos:pos.clone(),mesh,
      vel:this._dir.clone().multiplyScalar(15).add(new THREE.Vector3(0,4.2,0)),
      fuse:DEFS[type].fuse,spin:Math.random()*4+3,
    });
    this.counts[type]--;
    this.ui.setGrenades&&this.ui.setGrenades(this.counts);
    this.audio.uiClick&&this.audio.uiClick();
    return true;
  }

  update(dt){
    for(let i=this.list.length-1;i>=0;i--){
      const g=this.list[i];
      g.fuse-=dt;
      g.vel.y-=14*dt;
      g.pos.addScaledVector(g.vel,dt);
      this._bounce(g);
      g.mesh.position.copy(g.pos);
      g.mesh.rotation.x+=g.spin*dt;g.mesh.rotation.z+=g.spin*.7*dt;
      if(g.fuse<=0){
        this._explode(g);
        this.scene.remove(g.mesh);
        this.list.splice(i,1);
      }
    }
    for(let i=this.smokes.length-1;i>=0;i--){
      this.smokes[i].t-=dt;
      if(this.smokes[i].t<=0)this.smokes.splice(i,1);
    }
  }

  _bounce(g){
    if(g.pos.y<.12){
      g.pos.y=.12;
      g.vel.y*=-.35;g.vel.x*=.7;g.vel.z*=.7;
    }
    for(const c of this.game.world.colliders){
      if(g.pos.y>c.top+.12)continue;
      const cx=Math.max(c.minX,Math.min(g.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(g.pos.z,c.maxZ));
      const dx=g.pos.x-cx,dz=g.pos.z-cz,d2=dx*dx+dz*dz;
      if(d2<.0144&&d2>1e-8){
        const d=Math.sqrt(d2),nx=dx/d,nz=dz/d;
        const dot=g.vel.x*nx+g.vel.z*nz;
        if(dot<0){g.vel.x-=1.5*dot*nx;g.vel.z-=1.5*dot*nz;g.vel.x*=.7;g.vel.z*=.7;}
        g.pos.x=cx+nx*.12;g.pos.z=cz+nz*.12;
      }
    }
  }

  _explode(g){
    const D=DEFS[g.type],pos=g.pos;
    if(g.type==='frag'){
      this.fx.explosion(pos,1.2);
      this.audio.explosion(pos.distanceTo(this.game.camera.position));
      for(const e of [...this.game.enemies.list]){
        if(e.dead)continue;
        const d=e.pos.distanceTo(pos);
        if(d<D.radius)this.game.enemies.damage(e,'body',D.damage*(1-d/D.radius),pos);
      }
      for(const h of this.game.heroes.list){
        if(!h.alive||h.team==='A')continue;
        const d=h.pos.distanceTo(pos);
        if(d<D.radius)h.takeDamage(D.damage*(1-d/D.radius),this.game.playerName);
      }
    }else if(g.type==='flash'){
      this.fx.impactFlash&&this.fx.impactFlash(pos);
      this.audio.deagle&&this.audio.deagle();
      const playerPos=this.game.player.pos;
      if(pos.distanceTo(playerPos)<D.radius&&this.game._los(pos,this._v.copy(playerPos).add(new THREE.Vector3(0,1.4,0))))
        this.ui.flashWhite&&this.ui.flashWhite(.92);
      for(const e of this.game.enemies.list){
        if(pos.distanceTo(e.pos)<D.radius&&this.game._los(pos,e.pos))e.blindT=2.5;
      }
      for(const h of this.game.heroes.list){
        if(!h.alive||h.team==='A')continue;
        if(pos.distanceTo(h.pos)<D.radius&&this.game._los(pos,h.pos))h.blindT=2.5;
      }
    }else{
      this.fx.smokeCloud&&this.fx.smokeCloud(pos,D.radius);
      this.smokes.push({pos:pos.clone(),r:D.radius,t:8});
    }
  }

  /* 烟雾遮蔽判定(Bot 射击精度读取) */
  inSmoke(pos){
    for(const s of this.smokes)if(pos.distanceToSquared(s.pos)<s.r*s.r)return true;
    return false;
  }

  clear(){
    for(const g of this.list)this.scene.remove(g.mesh);
    this.list.length=0;this.smokes.length=0;
    this.ui.setGrenades&&this.ui.setGrenades(this.counts);
  }

  dispose(){
    this.clear();
    this._geo.dispose();
    for(const k in this._mats)this._mats[k].dispose();
  }
}
