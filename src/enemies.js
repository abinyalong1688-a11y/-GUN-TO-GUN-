// enemies.js — three drone classes: WASP kamikaze / REAPER roaming shooter / WARDEN heavy suppressor
// Performance: geometry cached and shared per type (no allocation spike on spawn), hot-path vectors reused
import * as THREE from 'three';

const UP=new THREE.Vector3(0,1,0);
const BOLT_GEO=new THREE.SphereGeometry(.08,8,8),BOLT_GEO_BIG=new THREE.SphereGeometry(.12,8,8);

const TYPES={
  WASP:{hp:70,speed:6.8,score:100,radius:.55,alt:2.2,scale:.8},
  REAPER:{hp:150,speed:4.2,score:200,radius:.8,alt:2.8,scale:1.15},
  WARDEN:{hp:330,speed:2.1,score:400,radius:1.1,alt:2.4,scale:1.7},
};

let UID=0;

/* Shared geometry cached per type (reused by every drone instance; only materials are freed on destroy) */
const _geoCache={};
function typeGeos(type){
  if(_geoCache[type])return _geoCache[type];
  const s=TYPES[type].scale;
  const G={};
  if(type==='WASP'){
    G.body=new THREE.SphereGeometry(.22,10,8);
    G.plate=new THREE.BoxGeometry(.34,.06,.4);
  }else if(type==='REAPER'){
    G.body=new THREE.CapsuleGeometry(.18,.36,4,10);
    G.wing=new THREE.BoxGeometry(.7,.05,.26);
    G.gun=new THREE.CylinderGeometry(.03,.03,.3,8);
  }else{
    G.body=new THREE.BoxGeometry(.72,.5,.8);
    G.armor1=new THREE.BoxGeometry(.9,.16,.9);
    G.armor2=new THREE.BoxGeometry(.86,.14,.86);
    G.gun=new THREE.CylinderGeometry(.05,.05,.5,8);
  }
  G.core=new THREE.SphereGeometry(type==='WASP'?.09:type==='REAPER'?.13:.19,10,10);
  G.arm=new THREE.BoxGeometry(.5*s,.03,.05*s);
  G.rotor=new THREE.CircleGeometry(.16*s,12);
  G.ant=new THREE.CylinderGeometry(.008,.008,.3*s,4);
  // Shared detail parts: rotor hubs / core guard rings / glowing sensor windows
  G.hub=new THREE.CylinderGeometry(.05*s,.055*s,.05*s,8);
  G.collar=new THREE.TorusGeometry(type==='WASP'?.12:type==='REAPER'?.165:.24,.022,8,18);
  G.visor=new THREE.BoxGeometry(type==='WASP'?.14:type==='REAPER'?.22:.42,type==='WARDEN'?.06:.04,.02);
  if(type==='WASP'){
    G.fin=new THREE.BoxGeometry(.2,.02,.09);        // attitude fins
    G.claw=new THREE.BoxGeometry(.035,.13,.035);    // landing claws
    G.nozzle=new THREE.CylinderGeometry(.05,.065,.08,8); // rear nozzle
  }else if(type==='REAPER'){
    G.pod=new THREE.BoxGeometry(.09,.09,.16);       // wingtip sensor pods
    G.muzzle=new THREE.BoxGeometry(.05,.05,.04);    // muzzle
  }else{
    G.skirt=new THREE.BoxGeometry(.46,.3,.06);      // side skirts
    G.shield=new THREE.BoxGeometry(.15,.2,.04);     // gun shields
  }
  return _geoCache[type]=G;
}

export class Enemies{
  constructor(scene,assets,effects,audio,ui){
    this.scene=scene;this.A=assets;this.fx=effects;this.audio=audio;this.ui=ui;
    this.list=[];this.projectiles=[];
    this.onKill=null;this.onPlayerHit=null;
    /* Co-op networking: the host simulates every drone. Each drone gets a wire id (`d:<n>`) so a
       client can ask the host to apply a hit (C.HIT target `d:<n>`), and the host mirrors the
       roster to the room. `authoritative=false` turns local damage into a request. */
    this.authoritative=true;
    this.mirror=false;      // true on a co-op guest: drones are drawn, never simulated here
    this.onSpawn=null;      // (descriptor) => void, host only
    this.onKillNet=null;    // (descriptor) => void, host only
    this.netIdSeq=0;
    this.ray=new THREE.Raycaster();
    this._tmp=new THREE.Vector3();
    this._t1=new THREE.Vector3();this._t2=new THREE.Vector3();this._t3=new THREE.Vector3();
    this._wp=new THREE.Vector3();this._wp2=new THREE.Vector3();
    this._seg=new THREE.Raycaster();
  }

  spawn(type,pos,{hpScale=1,entering=true,decor=false}={}){
    const T=TYPES[type];
    const e={
      id:++UID,type,T,decor,
      hp:T.hp*hpScale,maxHp:T.hp*hpScale,
      pos:pos.clone(),vel:new THREE.Vector3(),
      alt:T.alt*(0.8+Math.random()*.5),
      phase:Math.random()*Math.PI*2,
      state:'enter',stateT:0,
      fireT:1+Math.random()*1.5,burst:0,
      orbitDir:Math.random()>.5?1:-1,
      smokeT:0,flashT:0,blindT:0,dead:false,
      group:new THREE.Group(),
      parts:[],
    };
    this.buildBody(e);
    e.group.position.copy(pos);
    if(entering){e.pos.y+=7+Math.random()*3;e.group.position.y=e.pos.y;}
    else{e.state='active';e.group.position.y=pos.y;}
    e.group.userData.enemyRef=e;
    if(e.decor){e.decorA=Math.atan2(pos.z,pos.x);e.decorR=Math.max(20,Math.hypot(pos.x,pos.z));}
    this.scene.add(e.group);
    this.list.push(e);
    if(!decor){
      e.netId='d:'+(++this.netIdSeq);
      if(this.authoritative&&this.onSpawn)this.onSpawn(this.describe(e));
    }
    return e;
  }

  buildBody(e){
    const g=e.group,M=this.A.mats;
    const bodyMat=M.droneBody.clone(),darkMat=M.droneDark.clone(),armorMat=M.droneArmor.clone();
    e.mats=[bodyMat,darkMat,armorMat];
    const s=e.T.scale;
    const G=typeGeos(e.type);
    const add=(geo,mat,x,y,z,part='body')=>{
      const m=new THREE.Mesh(geo,mat);
      m.position.set(x*s,y*s,z*s);
      m.castShadow=true;
      m.userData.part=part;
      g.add(m);e.parts.push(m);
      return m;
    };
    // Main body (shared geometry)
    if(e.type==='WASP'){
      add(G.body,bodyMat,0,0,0);
      add(G.plate,darkMat,0,-.06,0);
    }else if(e.type==='REAPER'){
      add(G.body,bodyMat,0,0,0);
      add(G.wing,darkMat,0,.02,0);
      add(G.gun,darkMat,0,-.14,.18,Math.PI/2); // under-slung gun
    }else{
      add(G.body,bodyMat,0,0,0);
      add(G.armor1,armorMat,0,.3,0);
      add(G.armor2,armorMat,0,-.3,0);
      add(G.gun,darkMat,-.14,-.2,.34,Math.PI/2);
      add(G.gun,darkMat,.14,-.2,.34,Math.PI/2);
    }
    // Red core (weak point) + guard ring
    const core=add(G.core,M.core.clone(),0,e.type==='WARDEN'?.05:0,e.type==='WARDEN'?.44:.26,'core');
    e.core=core;
    add(G.collar,darkMat,0,e.type==='WARDEN'?.05:0,e.type==='WARDEN'?.44:.26);
    // Glowing sensor windows (threat-ID lights)
    add(G.visor,M.droneAccent,0,e.type==='WASP'?.09:e.type==='REAPER'?.1:.12,e.type==='WASP'?.17:e.type==='REAPER'?.15:.4);
    // Type-specific details
    if(e.type==='WASP'){
      for(const sx of[-1,1])add(G.fin,bodyMat,sx*.24,.06,-.04,0,0,-sx*.35);   // attitude fins
      for(const sx of[-1,1])add(G.claw,darkMat,sx*.1,-.2,.03,.15);            // landing claws
      add(G.nozzle,darkMat,0,0,-.24,Math.PI/2);                               // rear nozzle
    }else if(e.type==='REAPER'){
      for(const sx of[-1,1])add(G.pod,darkMat,sx*.32,.02,0);                  // wingtip sensor pods
      add(G.muzzle,darkMat,0,-.14,.3);                                        // muzzle
    }else{
      for(const sx of[-1,1])add(G.skirt,armorMat,sx*.42,0,-.02,0,0,-sx*.22);  // side skirts
      for(const sx of[-1,1])add(G.shield,darkMat,sx*.14,-.2,.36);             // gun shields
    }
    // Four arms + rotors (with hubs)
    e.rotors=[];
    e.disposeMats=[core.material];
    const positions=[[-1,-1],[1,-1],[-1,1],[1,1]];
    for(const [sx,sz] of positions){
      const arm=new THREE.Mesh(G.arm,darkMat);
      arm.position.set(sx*.28*s,0,sz*.28*s);
      arm.rotation.y=Math.atan2(sz,sx);
      arm.castShadow=true;arm.userData.part='body';
      g.add(arm);
      const rotor=new THREE.Mesh(G.rotor,M.rotor.clone());
      rotor.position.set(sx*.5*s,.03*s,sz*.5*s);
      rotor.rotation.x=-Math.PI/2;
      rotor.userData.part='body';
      g.add(rotor);
      e.rotors.push(rotor);e.disposeMats.push(rotor.material);
      const hub=new THREE.Mesh(G.hub,darkMat);
      hub.position.set(sx*.5*s,.055*s,sz*.5*s);
      hub.castShadow=true;hub.userData.part='body';
      g.add(hub);
    }
    // Tail antenna
    const ant=new THREE.Mesh(G.ant,darkMat);
    ant.position.set(0,.25*s,-.1*s);ant.userData.part='body';
    g.add(ant);
    e.bodyMats=[bodyMat,darkMat,armorMat];
  }

  /* Hit entry point, returns {killed, crit} */
  damage(e,part,dmg,hitPos){
    if(e.dead)return{dead:true};
    // Co-op client (not the host): forward the hit instead of settling HP locally, otherwise the
    // two clients would disagree about which drones are alive.
    if(!this.authoritative){
      this.requestDamage(e,part,dmg,hitPos);
      return{forwarded:true,crit:part==='core'};
    }
    const crit=part==='core';
    const d=dmg*(crit?2.5:1);
    e.hp-=d;
    e.flashT=.09;
    if(e.state==='enter')e.state='active';
    this.fx.impact(hitPos,UP,'metal',{decal:false});
    for(const m of e.bodyMats){m.emissive.setHex(0xffffff);m.emissiveIntensity=.55;}
    if(e.hp<=0){
      this.kill(e,crit);
      return{killed:true,crit};
    }
    return{killed:false,crit,dmg:d};
  }

  /* Wire descriptor for a drone: enough for a remote client to draw it without simulating it. */
  describe(e){
    return [e.netId,e.type,Math.round(e.pos.x*100),Math.round(e.pos.y*100),Math.round(e.pos.z*100),
      Math.round(e.maxHp),e.decor?1:0];
  }
  /* Non-host clients draw drones from the host's roster; damage is a request, never applied. */
  requestDamage(e,part,dmg,hitPos){
    if(e.dead||this.authoritative)return false;
    if(this.onRequestHit)this.onRequestHit(e.netId,part,dmg);
    this.fx.impact(hitPos,UP,'metal',{decal:false});
    return true;
  }
  kill(e,crit,noScore=false){
    if(e.dead)return;
    e.dead=true;
    if(this.authoritative&&this.onKillNet&&!e.decor)this.onKillNet(this.describe(e));
    this.fx.explosion(e.pos,e.T.scale*1.1);
    // Volume falls off with distance to the player (camera), not to the world origin
    this.audio.explosion(this.camPos?e.pos.distanceTo(this.camPos):e.pos.length());
    if(!noScore&&this.onKill)this.onKill(e,crit);
    this.scene.remove(e.group);
    e.mats.forEach(m=>m.dispose());
    for(const m of e.disposeMats||[])m.dispose(); // cloned per-drone materials (core / rotors)
    const i=this.list.indexOf(e);
    if(i>=0)this.list.splice(i,1);
    // Stop the dive whine (if no drone is diving)
    if(!this.list.some(x=>x.state==='dive'))this.audio.whineStop();
  }

  spawnBolt(from,dir,dmg,speed,big=false){
    // Shared geometry and material: bolts never change their material; the old code created geometry per shot and never freed it (GPU buffers kept growing)
    const m=new THREE.Mesh(big?BOLT_GEO_BIG:BOLT_GEO,big?this.A.mats.boltW:this.A.mats.boltR);
    m.position.copy(from);
    this.scene.add(m);
    this.projectiles.push({mesh:m,vel:dir.clone().multiplyScalar(speed),dmg,life:4.5});
    this.audio.boltShoot();
  }

  _steer(e,target,dt,maxSpeed,accel=3.2){
    const des=this._tmp.copy(target).sub(e.pos);
    const d=des.length();
    if(d>.001)des.multiplyScalar(maxSpeed/d);
    e.vel.lerp(des,Math.min(1,accel*dt));
    // Obstacle repulsion (below cover height)
    for(const c of this._colliders){
      if(e.pos.y>c.top+.5)continue;
      const cx=Math.max(c.minX,Math.min(e.pos.x,c.maxX));
      const cz=Math.max(c.minZ,Math.min(e.pos.z,c.maxZ));
      const dx=e.pos.x-cx,dz=e.pos.z-cz;
      const d2=dx*dx+dz*dz;
      if(d2<2.6&&d2>1e-6){
        const dd=Math.sqrt(d2),f=(1.7-dd)/dd*8;
        e.vel.x+=dx*f*dt*10;e.vel.z+=dz*f*dt*10;
      }
    }
    e.pos.addScaledVector(e.vel,dt);
    if(e.pos.y<1.1)e.pos.y=1.1;
    if(e.pos.y>6.5)e.pos.y=6.5;
    const r=Math.hypot(e.pos.x,e.pos.z);
    if(r>60){const k=60/r;e.pos.x*=k;e.pos.z*=k;}
  }

  update(dt,player,colliders,time,game){
    this._colliders=colliders;
    if(game&&game.camera)this.camPos=game.camera.position;
    const eye=player.eye;
    let nearest=999,diveNearest=999;

    for(let i=this.list.length-1;i>=0;i--){
      const e=this.list[i];
      e.stateT+=dt;

      // Decor drones: circle-patrol the main menu, never attack
      if(e.decor){
        const a=e.decorA+time*.1;
        const target=new THREE.Vector3(Math.cos(a)*e.decorR,e.alt+Math.sin(time*.8+e.phase)*.6,Math.sin(a)*e.decorR);
        this._steer(e,target,dt,3.5,2);
        if(e.vel.lengthSq()>.3){
          const yaw=Math.atan2(e.vel.x,e.vel.z);
          let dy=yaw-e.group.rotation.y;
          while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
          e.group.rotation.y+=dy*Math.min(1,5*dt);
        }
        e.group.position.set(e.pos.x,e.pos.y+Math.sin(time*2.2+e.phase)*.16,e.pos.z);
        for(const r of e.rotors)r.rotation.z+=dt*36;
        continue;
      }

      // Entry descent
      if(e.state==='enter'){
        e.pos.y-=(5.5)*dt;
        if(e.pos.y<=e.alt)e.state='active';
        e.group.position.copy(e.pos);
        for(const r of e.rotors)r.rotation.z+=dt*(30*e.stateT);
        continue;
      }
      // Hover bob
      const bob=Math.sin(time*2.2+e.phase)*.16;
      // M3-G1: flashbang blindness — wander randomly and hold fire
      if(e.blindT>0){
        e.blindT-=dt;
        const ta=this._t3.set(e.pos.x+(Math.random()-.5)*6,e.alt,e.pos.z+(Math.random()-.5)*6);
        this._steer(e,ta,dt,e.T.speed*.55);
        e.group.position.set(e.pos.x,e.pos.y+bob,e.pos.z);
        for(const r of e.rotors)r.rotation.z+=dt*24;
        continue;
      }
      // Mirrored (co-op guest): the host owns position, HP and firing. Animate only.
      if(this.mirror){
        e.group.position.set(e.pos.x,e.pos.y+bob,e.pos.z);
        for(const r of e.rotors)r.rotation.z+=dt*38;
        if(e.fireT>0)e.fireT-=dt;
        if(e.flashT>0){e.flashT-=dt;if(e.flashT<=0)for(const m of e.bodyMats)m.emissiveIntensity=0;}
        continue;
      }
      const toPlayer=e.pos.distanceTo(eye);
      nearest=Math.min(nearest,toPlayer); // (only non-decor drones get here)
      // Red core breathing pulse (idle; REAPER charge-up overrides it with a bright value in its branch)
      e.core.material.emissiveIntensity=2.2+Math.sin(time*5+e.phase)*.55;

      let target;
      if(e.type==='WASP'){
        if(e.state!=='dive'&&toPlayer<10){
          e.state='dive';
          this.audio.whineStart();
        }
        if(e.state==='dive'){
          diveNearest=Math.min(diveNearest,toPlayer);
          target=this._t1.copy(eye);e.vel.multiplyScalar(Math.max(0,1-.5*dt));
          this._steer(e,target,dt,e.T.speed*1.9,6);
          e.group.lookAt(eye);
          if(toPlayer<1.7){
            // Detonate
            player.damage(16*Math.max(.4,1-toPlayer/8),time);
            if(this.onPlayerHit)this.onPlayerHit(e.pos);
            e.dead=false;
            this.kill(e,false,true);
            continue;
          }
        }else{
          target=this._t1.copy(eye);target.y=e.alt;
          this._steer(e,target,dt,e.T.speed);
        }
      }else if(e.type==='REAPER'){
        if(toPlayer>17){target=this._t1.copy(eye);target.y=e.alt;this._steer(e,target,dt,e.T.speed);}
        else{
          // Orbit
          const ang=Math.atan2(e.pos.z-eye.z,e.pos.x-eye.x)+e.orbitDir*dt*.55;
          target=this._t1.copy(eye).add(this._t2.set(Math.cos(ang)*14.5,0,Math.sin(ang)*14.5));
          target.y=e.alt+Math.sin(time+e.phase)*.4;
          this._steer(e,target,dt,e.T.speed*1.15,4);
        }
        // Fire
        e.fireT-=dt;
        if(e.fireT<.45)e.core.material.emissiveIntensity=4.5; // charge-up tell
        if(e.fireT<=0){
          e.fireT=1.55+Math.random()*.5;
          e.core.material.emissiveIntensity=2.4;
          const from=this._wp;e.core.getWorldPosition(from);
          const dir=this._t2.copy(eye).sub(from).normalize();
          dir.x+=(Math.random()-.5)*.04;dir.y+=(Math.random()-.5)*.04;
          this.spawnBolt(from,dir.normalize(),8,24,false);
        }
      }else{ // WARDEN
        if(toPlayer>9.5){target=this._t1.copy(eye);target.y=e.alt;this._steer(e,target,dt,e.T.speed);}
        else{
          target=this._t1.copy(e.pos);
          this._steer(e,target,dt,0);
        }
        e.fireT-=dt;
        if(e.fireT<=0&&toPlayer<26){
          if(e.burst<2){
            e.burst++;e.fireT=.16;
            const from=this._wp;e.core.getWorldPosition(from);
            const dir=this._t2.copy(eye).sub(from).normalize();
            dir.x+=(Math.random()-.5)*.06;dir.y+=(Math.random()-.5)*.05;
            this.spawnBolt(from,dir.normalize(),12,17,true);
          }else{e.burst=0;e.fireT=3.4+Math.random()*.8;}
        }
      }

      // Heading & attitude: face the velocity direction
      if(e.vel.lengthSq()>.3){
        const yaw=Math.atan2(e.vel.x,e.vel.z);
        let dy=yaw-e.group.rotation.y;
        while(dy>Math.PI)dy-=Math.PI*2;while(dy<-Math.PI)dy+=Math.PI*2;
        e.group.rotation.y+=dy*Math.min(1,6*dt);
        e.group.rotation.x=-Math.min(.4,Math.max(-.4,e.vel.y*.06));
        e.group.rotation.z=Math.sin(time*1.7+e.phase)*.05;
      }
      e.group.position.set(e.pos.x,e.pos.y+bob,e.pos.z);
      // Rotors
      for(const r of e.rotors)r.rotation.z+=dt*(38+Math.sin(time*3+e.phase)*3);
      // Hit-flash recovery
      if(e.flashT>0){
        e.flashT-=dt;
        if(e.flashT<=0)for(const m of e.bodyMats){m.emissiveIntensity=0;}
      }
      // Trail smoke at low health
      if(e.hp<e.maxHp*.4){
        e.smokeT-=dt;
        if(e.smokeT<=0){
          e.smokeT=.13;
          this.fx.droneSmoke(this._t3.set(e.pos.x,e.pos.y-.2,e.pos.z));
        }
      }
    }

    // Audio tension
    if(this.audio.ok){
      this.audio.setDrone(Math.max(0,1-nearest/30));
      if(this.list.some(x=>x.state==='dive'))
        this.audio.whineSet(Math.max(0,1-diveNearest/16),420+(16-Math.min(16,diveNearest))*38);
    }

    // Bolts (host/offline only — a mirrored client takes bolt damage through the host's s:hit)
    if(this.mirror){this.projectiles.length&&this.clearBolts();return;}
    const seg=this._seg;
    for(let i=this.projectiles.length-1;i>=0;i--){
      const b=this.projectiles[i];
      b.life-=dt;
      const prev=this._wp.copy(b.mesh.position);
      b.mesh.position.addScaledVector(b.vel,dt);
      let kill=false;
      // Hit the player
      const chest=this._t1.copy(eye);chest.y-=.35;
      if(b.mesh.position.distanceTo(chest)<.55&&player.alive){
        player.damage(b.dmg,time);
        if(this.onPlayerHit)this.onPlayerHit(b.mesh.position);
        kill=true;
      }else{
        // Hit cover
        const dir=this._t2.copy(b.mesh.position).sub(prev);
        const len=dir.length();
        if(len>1e-6){
          seg.set(prev,dir.normalize());seg.far=len+.1;
          const hits=seg.intersectObjects(game.world.losStatics||game.world.shootStatics,false);
          if(hits.length){
            const h=hits[0];
            const n=h.face?h.face.normal.clone().transformDirection(h.object.matrixWorld):UP;
            this.fx.impact(h.point,n,h.object.userData.surface||'concrete');
            kill=true;
          }
        }
        if(b.mesh.position.y<0.05){this.fx.impact(b.mesh.position,UP,'sand');kill=true;}
      }
      if(kill||b.life<=0){
        this.scene.remove(b.mesh);
        this.projectiles.splice(i,1);
      }
    }
  }

  clearBolts(){ for(const b of this.projectiles)this.scene.remove(b.mesh); this.projectiles.length=0; }

  clearAll(){
    for(const e of [...this.list]){
      this.scene.remove(e.group);
      e.mats.forEach(m=>m.dispose());
      for(const m of e.disposeMats||[])m.dispose();
    }
    this.list.length=0;
    for(const b of this.projectiles)this.scene.remove(b.mesh);
    this.projectiles.length=0;
    this.audio.whineStop();
  }
}
