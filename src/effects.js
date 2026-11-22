// effects.js — particles / two-layer tracers / impact flashes / bullet-hole decals / explosions (fireball + shockwave + debris)
import * as THREE from 'three';

const UP=new THREE.Vector3(0,1,0);

/* General-purpose GPU point-particle system */
class Particles{
  constructor(scene,capacity,tex,blending,quality=1){
    this.cap=Math.floor(capacity*quality);
    this.n=0;
    this.pos=new Float32Array(this.cap*3);
    this.col=new Float32Array(this.cap*3);
    this.size=new Float32Array(this.cap);
    this.alpha=new Float32Array(this.cap);
    this.vel=new Float32Array(this.cap*3);
    this.life=new Float32Array(this.cap);
    this.maxLife=new Float32Array(this.cap);
    this.s0=new Float32Array(this.cap);this.s1=new Float32Array(this.cap);
    this.a0=new Float32Array(this.cap);
    this.grav=new Float32Array(this.cap);
    this.drag=new Float32Array(this.cap);

    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(this.pos,3));
    g.setAttribute('aColor',new THREE.BufferAttribute(this.col,3));
    g.setAttribute('aSize',new THREE.BufferAttribute(this.size,1));
    g.setAttribute('aAlpha',new THREE.BufferAttribute(this.alpha,1));
    const m=new THREE.ShaderMaterial({
      uniforms:{map:{value:tex}},
      vertexShader:`
        attribute vec3 aColor;attribute float aSize;attribute float aAlpha;
        varying vec3 vC;varying float vA;
        void main(){
          vC=aColor;vA=aAlpha;
          vec4 mv=modelViewMatrix*vec4(position,1.0);
          gl_PointSize=aSize*(220.0/max(0.1,-mv.z));
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader:`
        uniform sampler2D map;varying vec3 vC;varying float vA;
        void main(){
          vec4 t=texture2D(map,gl_PointCoord);
          gl_FragColor=vec4(vC*t.rgb,t.a*vA);
          if(gl_FragColor.a<0.01)discard;
        }`,
      transparent:true,depthWrite:false,blending
    });
    this.mesh=new THREE.Points(g,m);
    this.mesh.frustumCulled=false;
    this.mesh.renderOrder=5;
    scene.add(this.mesh);
  }
  spawn(p,v,{life=.6,size=1,size1=.2,alpha=1,color=[1,.8,.5],gravity=0,drag=0}={}){
    if(this.n>=this.cap)return;
    const i=this.n++;
    this.pos[i*3]=p.x;this.pos[i*3+1]=p.y;this.pos[i*3+2]=p.z;
    this.vel[i*3]=v.x;this.vel[i*3+1]=v.y;this.vel[i*3+2]=v.z;
    this.life[i]=this.maxLife[i]=life;
    this.s0[i]=size;this.s1[i]=size1;this.a0[i]=alpha;
    this.col[i*3]=color[0];this.col[i*3+1]=color[1];this.col[i*3+2]=color[2];
    this.grav[i]=gravity;this.drag[i]=drag;
    this.alpha[i]=alpha;this.size[i]=size;
  }
  _swapDel(i){
    const last=--this.n;
    if(i===last)return;
    for(let k=0;k<3;k++){
      this.pos[i*3+k]=this.pos[last*3+k];this.vel[i*3+k]=this.vel[last*3+k];this.col[i*3+k]=this.col[last*3+k];
    }
    this.life[i]=this.life[last];this.maxLife[i]=this.maxLife[last];
    this.s0[i]=this.s0[last];this.s1[i]=this.s1[last];this.a0[i]=this.a0[last];
    this.grav[i]=this.grav[last];this.drag[i]=this.drag[last];
    this.alpha[i]=this.alpha[last];this.size[i]=this.size[last];
  }
  update(dt){
    for(let i=0;i<this.n;i++){
      this.life[i]-=dt;
      if(this.life[i]<=0){this._swapDel(i);i--;continue;}
      const dr=Math.max(0,1-this.drag[i]*dt);
      this.vel[i*3]*=dr;this.vel[i*3+2]*=dr;
      this.vel[i*3+1]=this.vel[i*3+1]*dr+this.grav[i]*dt;
      this.pos[i*3]+=this.vel[i*3]*dt;
      this.pos[i*3+1]+=this.vel[i*3+1]*dt;
      this.pos[i*3+2]+=this.vel[i*3+2]*dt;
      const t=1-this.life[i]/this.maxLife[i];
      this.size[i]=this.s0[i]+(this.s1[i]-this.s0[i])*t;
      this.alpha[i]=this.a0[i]*(1-t*t);
    }
    const g=this.mesh.geometry;
    g.setDrawRange(0,this.n);
    g.attributes.position.needsUpdate=true;
    g.attributes.aColor.needsUpdate=true;
    g.attributes.aSize.needsUpdate=true;
    g.attributes.aAlpha.needsUpdate=true;
  }
}

export class Effects{
  constructor(scene,assets,quality='high',camera=null){
    this.scene=scene;this.A=assets;this.camera=camera; // world camera: fades tracer heads near the lens
    const q=quality==='high'?1:.6;
    this.sparks=new Particles(scene,700*1,assets.tex.spark,THREE.AdditiveBlending,q);
    this.smoke=new Particles(scene,420,assets.tex.smoke,THREE.NormalBlending,q);
    this.dust=new Particles(scene,420,assets.tex.dust,THREE.NormalBlending,q);

    // Tracers: two layers (white-hot core + coloured glow) + a bright head sprite
    // Side-on the cylinders read as a streak; looking down the axis in first person their back faces are culled, so the head sprite keeps them readable at range
    this.tracers=[];
    const coreGeo=new THREE.CylinderGeometry(1,1,1,6,1,true);
    const glowGeo=new THREE.CylinderGeometry(3.6,3.6,1,6,1,true);
    const streak=assets.tex.streak;
    for(let i=0;i<30;i++){
      const grp=new THREE.Group();
      const core=new THREE.Mesh(coreGeo,new THREE.MeshBasicMaterial({
        color:0xfff6e8,transparent:true,opacity:.95,blending:THREE.AdditiveBlending,
        depthWrite:false,map:streak,side:THREE.DoubleSide}));
      const glow=new THREE.Mesh(glowGeo,new THREE.MeshBasicMaterial({
        color:0xffd9a0,transparent:true,opacity:.4,blending:THREE.AdditiveBlending,
        depthWrite:false,map:streak,side:THREE.DoubleSide}));
      core.renderOrder=6;glow.renderOrder=6;
      grp.add(core,glow);
      grp.visible=false;grp.frustumCulled=false;
      const head=new THREE.Sprite(new THREE.SpriteMaterial({
        map:assets.tex.spark,color:0xffd9a0,transparent:true,opacity:.9,
        blending:THREE.AdditiveBlending,depthWrite:false}));
      head.scale.setScalar(.26);head.visible=false;head.renderOrder=7;
      scene.add(grp,head);
      this.tracers.push({group:grp,core,glow,head,active:false,dir:new THREE.Vector3(),left:0,len:0,speed:420});
    }
    // Impact flash pool (additive, camera-facing, quick scale-up and fade)
    this.flashes=[];this.flashIdx=0;
    const fGeo=new THREE.PlaneGeometry(1,1);
    for(let i=0;i<12;i++){
      const m=new THREE.Mesh(fGeo,new THREE.MeshBasicMaterial({
        map:assets.tex.spark,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false}));
      m.visible=false;m.renderOrder=7;
      scene.add(m);
      this.flashes.push({mesh:m,t:1});
    }
    // Bullet holes
    this.decals=[];this.decalIdx=0;
    const dg=new THREE.PlaneGeometry(.15,.15);
    const dm=new THREE.MeshBasicMaterial({map:assets.tex.hole,transparent:true,depthWrite:false,
      polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
    for(let i=0;i<48;i++){
      const m=new THREE.Mesh(dg,dm);
      m.visible=false;m.renderOrder=2;
      scene.add(m);this.decals.push(m);
    }
    // Fireballs / shock rings / debris
    this.booms=[];this.rings=[];this.debris=[];
    this.fireMat=new THREE.MeshBasicMaterial({color:0xff9a40,transparent:true,opacity:1,blending:THREE.AdditiveBlending,depthWrite:false});
    this.fireCoreMat=new THREE.MeshBasicMaterial({color:0xfff2c8,transparent:true,opacity:1,blending:THREE.AdditiveBlending,depthWrite:false});
    const ringMat=new THREE.MeshBasicMaterial({map:assets.tex.ring,transparent:true,opacity:1,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide});
    this._ringMat=ringMat;
    this.ringGeo=new THREE.PlaneGeometry(2,2);
    this.debrisGeo=new THREE.BoxGeometry(.09,.09,.09);
    // Explosion light pool
    this.lights=[];
    for(let i=0;i<2;i++){
      const l=new THREE.PointLight(0xff8a40,0,30,2);
      scene.add(l);this.lights.push({l,decay:0});
    }
    this.onShake=null;
    this._bloodV=new THREE.Vector3(); // reused blood-mist particle velocity (deaths are off the hot path; avoids per-particle allocation)
    this._smokeP=new THREE.Vector3();this._smokeV=new THREE.Vector3();
  }

  tracer(from,dir,dist,{color=0xffd9a0,width=.03,speed=420}={}){
    const t=this.tracers.find(x=>!x.active);if(!t)return;
    t.active=true;t.dir.copy(dir);t.left=dist;t.speed=speed;
    t.len=Math.min(9,dist);
    t.group.visible=true;
    // The body trails the head: the head leaves the muzzle and vanishes exactly at the hit point after travelling dist (the old start was pushed forward by len, so the whole tracer overshot through walls)
    t.group.position.copy(from).addScaledVector(dir,-t.len/2);
    t.group.quaternion.setFromUnitVectors(UP,dir);
    t.group.scale.set(width,t.len,width);
    t.core.material.color.setHex(0xfff6e8);            // white-hot core
    t.glow.material.color.setHex(color);               // tracer-colour glow
    t.core.material.opacity=.95;                       // reset when a slot is reused (leftover negative opacity flashes black)
    t.glow.material.opacity=.4;
    t.head.material.color.setHex(color);               // head glow (visible from any angle)
    t.head.visible=true;
  }

  /* White-hot flash at the moment of impact (shared by every surface) */
  impactFlash(point,normal){
    const f=this.flashes[this.flashIdx];
    this.flashIdx=(this.flashIdx+1)%this.flashes.length;
    f.t=0;
    f.mesh.visible=true;
    f.mesh.position.copy(point).addScaledVector(normal||UP,.04);
  }

  bulletHole(point,normal){
    const m=this.decals[this.decalIdx];
    this.decalIdx=(this.decalIdx+1)%this.decals.length;
    m.visible=true;
    m.position.copy(point).addScaledVector(normal,.015);
    m.lookAt(point.clone().add(normal));
    m.rotateZ(Math.random()*Math.PI*2);
    const s=.8+Math.random()*.5;m.scale.set(s,s,1);
  }

  /* decal:false for moving targets (characters / drones / pickups) so no bullet hole is left floating in the air */
  impact(point,normal,surface,{decal=true}={}){
    const n=normal||UP;
    const N=4+Math.floor(Math.random()*4);
    if(surface==='metal'){
      for(let i=0;i<N+2;i++){
        const v=new THREE.Vector3((Math.random()-.5)*5,(Math.random()-.2)*4,(Math.random()-.5)*5).addScaledVector(n,3+Math.random()*3);
        this.sparks.spawn(point,v,{life:.3+Math.random()*.2,size:.16,size1:.02,color:[1,.85,.5],gravity:-9,alpha:1});
      }
    }else{
      const c=surface==='concrete'?[.75,.72,.68]:[.85,.68,.45];
      for(let i=0;i<N;i++){
        const v=new THREE.Vector3((Math.random()-.5)*2.4,(Math.random()-.3)*2.2,(Math.random()-.5)*2.4).addScaledVector(n,1.6+Math.random()*1.8);
        this.dust.spawn(point,v,{life:.5+Math.random()*.4,size:.9,size1:2.2,color:c,gravity:-.6,drag:2.4,alpha:.75});
      }
    }
    this.impactFlash(point,n);
    if(decal&&surface!=='sand')this.bulletHole(point,n);
  }

  /* Muzzle smoke: a wisp drifting up from the muzzle after a shot */
  muzzleSmoke(pos,{far=false}={}){
    // far: scoped shots spawn the puff metres down the aim ray — a full-size puff half a
    // metre from the camera would cover the entire scope lens
    this.smoke.spawn(pos,
      new THREE.Vector3((Math.random()-.5)*.5,.9+(Math.random()*.4),(Math.random()-.5)*.5),
      far?{life:.4+Math.random()*.2,size:.12,size1:.34,color:[.82,.8,.78],gravity:.5,drag:1.6,alpha:.22}
        :{life:.45+Math.random()*.25,size:.16,size1:.55,color:[.82,.8,.78],gravity:.5,drag:1.6,alpha:.4});
  }

  /* M3-G1: persistent smoke-grenade screen (long-lived particles spawned once, no per-frame allocation) */
  smokeCloud(pos,radius=4){
    for(let i=0;i<34;i++){
      const a=Math.random()*Math.PI*2,rr=Math.random()*radius;
      const p=this._smokeP||(this._smokeP=new THREE.Vector3());
      p.set(pos.x+Math.cos(a)*rr,.25+Math.random()*1.3,pos.z+Math.sin(a)*rr);
      this.smoke.spawn(p,
        this._smokeV.set((Math.random()-.5)*.3,.18+Math.random()*.3,(Math.random()-.5)*.3),
        {life:5+Math.random()*3,size:radius*.55,size1:radius*1.15,color:[.46,.47,.49],gravity:-.04,drag:1.4,alpha:.36});
    }
  }

  /* C2: blood mist when a human is hit (replaces the explosion used for drones) */
  bloodPuff(pos,color=0x7a1a12){
    const r=((color>>16)&255)/255,g=((color>>8)&255)/255,b=(color&255)/255;
    for(let i=0;i<10;i++){
      this._bloodV.set((Math.random()-.5)*1.6,.2+Math.random()*1.4,(Math.random()-.5)*1.6);
      this.dust.spawn(pos,this._bloodV,
        {life:.35+Math.random()*.35,size:.34,size1:.08,color:[r,g,b],gravity:-2.2,drag:1.6,alpha:.8});
    }
  }

  explosion(pos,power=1){
    // Fireball
    const fire=new THREE.Mesh(new THREE.SphereGeometry(.5*power,12,10),this.fireMat.clone());
    fire.position.copy(pos);fire.scale.setScalar(.3);
    const core=new THREE.Mesh(new THREE.SphereGeometry(.24*power,10,8),this.fireCoreMat.clone());
    core.position.copy(pos);
    this.scene.add(fire,core);
    this.booms.push({fire,core,t:0,life:.32,power});
    // Shock ring
    const ring=new THREE.Mesh(this.ringGeo,this._ringMat.clone());
    ring.position.copy(pos);
    if(pos.y<1.6){ring.position.y=.08;ring.rotation.x=-Math.PI/2;}
    ring.scale.setScalar(.4);
    this.scene.add(ring);
    this.rings.push({mesh:ring,t:0,life:.45,power});
    // Sparks
    const N=Math.floor(26*power);
    for(let i=0;i<N;i++){
      const v=new THREE.Vector3((Math.random()-.5)*2,(Math.random()-.2)*1.6,(Math.random()-.5)*2).normalize()
        .multiplyScalar((5+Math.random()*7)*power);
      this.sparks.spawn(pos,v,{life:.4+Math.random()*.5,size:.4*power,size1:.05,color:[1,.7,.3],gravity:-11,alpha:1});
    }
    // Smoke
    for(let i=0;i<12;i++){
      const v=new THREE.Vector3((Math.random()-.5)*2.2,Math.random()*2.4,(Math.random()-.5)*2.2);
      this.smoke.spawn(pos,v,{life:1.1+Math.random()*.9,size:1.1*power,size1:(3+Math.random()*2)*power,color:[.32,.3,.28],gravity:1.1,drag:1.2,alpha:.55});
    }
    // Debris
    for(let i=0;i<7;i++){
      const m=new THREE.Mesh(this.debrisGeo,this.A.mats.debris);
      m.position.copy(pos);m.castShadow=false;
      this.scene.add(m);
      this.debris.push({mesh:m,t:0,life:1.3,
        vel:new THREE.Vector3((Math.random()-.5)*8,(Math.random()*.9+.5)*7*power,(Math.random()-.5)*8),
        rot:new THREE.Vector3(Math.random()*12,Math.random()*12,Math.random()*12)});
    }
    // Light
    const lt=this.lights.find(x=>x.decay<=0)||this.lights[0];
    lt.l.position.copy(pos);lt.decay=1;
    lt.l.intensity=90*power;
    if(this.onShake)this.onShake(Math.min(.5,.16*power/Math.max(1,pos.distanceTo(this._camPos||pos)*.08)));
  }
  setCamPos(p){this._camPos=p;}

  hammerSlam(pos){
    const ring=new THREE.Mesh(this.ringGeo,this._ringMat.clone());
    ring.position.set(pos.x,.08,pos.z);
    ring.rotation.x=-Math.PI/2;
    ring.scale.setScalar(.3);
    this.scene.add(ring);
    this.rings.push({mesh:ring,t:0,life:.4,power:.8});
    for(let i=0;i<16;i++){
      const v=new THREE.Vector3((Math.random()-.5)*6,(Math.random()*.9+.4)*5,(Math.random()-.5)*6);
      this.dust.spawn(pos,v,{life:.5+Math.random()*.4,size:1,size1:2.6,color:[.8,.7,.55],gravity:-2,drag:1.5,alpha:.8});
    }
    for(let i=0;i<10;i++){
      const v=new THREE.Vector3((Math.random()-.5)*7,(Math.random()-.2)*5,(Math.random()-.5)*7);
      this.sparks.spawn(pos,v,{life:.35,size:.25,size1:.04,color:[1,.85,.5],gravity:-10,alpha:1});
    }
    const lt=this.lights.find(x=>x.decay<=0)||this.lights[0];
    lt.l.position.set(pos.x,pos.y+.6,pos.z);lt.decay=.8;
    lt.l.intensity=60;
    if(this.onShake)this.onShake(.22);
  }

  droneSmoke(pos){
    this.smoke.spawn(pos,new THREE.Vector3((Math.random()-.5)*.5,.8,(Math.random()-.5)*.5),
      {life:.8+Math.random()*.5,size:.5,size1:1.8,color:[.25,.24,.23],gravity:.8,drag:1,alpha:.4});
  }

  update(dt){
    this.sparks.update(dt);this.smoke.update(dt);this.dust.update(dt);
    // Tracers (two layers + head glow, advanced at bullet speed, fading out at the end)
    for(const t of this.tracers){
      if(!t.active)continue;
      const step=t.speed*dt;
      t.group.position.addScaledVector(t.dir,step);
      t.head.position.copy(t.group.position).addScaledVector(t.dir,t.len/2);
      t.left-=step;
      const fade=Math.max(0,Math.min(1,t.left*10)); // overshoot must not produce negative opacity
      t.core.material.opacity=.95*fade;
      t.glow.material.opacity=.4*fade;
      /* The head is a bright billboard riding the bullet tip — while it is still metres
         from the camera it covers the scope lens, so fade it in over the first few metres */
      const dCam=this.camera?t.head.position.distanceTo(this.camera.position):10;
      t.head.material.opacity=.9*fade*Math.min(1,Math.max(0,(dCam-1.8)/1.4));
      if(t.left<=0){t.active=false;t.group.visible=false;t.head.visible=false;}
    }
    // Impact flash: quick scale-up and fade, always facing the camera
    for(const f of this.flashes){
      if(f.t>=1)continue;
      f.t+=dt/.09;
      if(f.t>=1){f.mesh.visible=false;f.mesh.material.opacity=0;continue;}
      const k=f.t;
      f.mesh.scale.setScalar(.14+k*.34);
      f.mesh.material.opacity=1-k;
      f.mesh.lookAt(this._camPos||f.mesh.position);
    }
    // Fireballs
    for(let i=this.booms.length-1;i>=0;i--){
      const b=this.booms[i];b.t+=dt;
      const k=b.t/b.life;
      if(k>=1){this.scene.remove(b.fire,b.core);b.fire.geometry.dispose();b.core.geometry.dispose();b.fire.material.dispose();b.core.material.dispose();this.booms.splice(i,1);continue;}
      const s=.3+k*2.4*b.power;
      b.fire.scale.setScalar(s);b.fire.material.opacity=1-k;
      b.core.scale.setScalar(.5+k*1.3*b.power);b.core.material.opacity=(1-k)*.9;
    }
    // Shock rings
    for(let i=this.rings.length-1;i>=0;i--){
      const r=this.rings[i];r.t+=dt;
      const k=r.t/r.life;
      if(k>=1){this.scene.remove(r.mesh);r.mesh.material.dispose();this.rings.splice(i,1);continue;}
      r.mesh.scale.setScalar(.4+k*7*r.power);
      r.mesh.material.opacity=.9*(1-k);
    }
    // Debris
    for(let i=this.debris.length-1;i>=0;i--){
      const d=this.debris[i];d.t+=dt;
      if(d.t>=d.life){this.scene.remove(d.mesh);this.debris.splice(i,1);continue;}
      d.vel.y-=22*dt;
      d.mesh.position.addScaledVector(d.vel,dt);
      d.mesh.rotation.x+=d.rot.x*dt;d.mesh.rotation.y+=d.rot.y*dt;
      if(d.mesh.position.y<.06&&d.vel.y<0){d.mesh.position.y=.06;d.vel.y*=-.35;d.vel.x*=.6;d.vel.z*=.6;}
    }
    // Explosion light decay
    for(const x of this.lights){
      if(x.decay>0){x.decay-=dt*3.2;x.l.intensity=Math.max(0,x.decay)*90;}
    }
  }
}
