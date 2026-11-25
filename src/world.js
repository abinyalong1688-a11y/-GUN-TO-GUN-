// world.js — four distinct arenas sharing one parametric shell:
//   desert   = Desert Outpost · Sunset   (v1.7 layout, kept verbatim)
//   snow     = Glacier Lake · Aurora     (icy night, animated aurora)
//   snowtown = Neon Docklands · Rain     (wet container port, neon signage, rain)
//   ember    = Volcano Caldera           (lava pools, basalt columns, obsidian)
// Keys are stable (menu chips / save / i18n depend on them); only layouts and dressing differ per map.
import * as THREE from 'three';
import {terrainHeight} from './terrain.js';

/* Scratch buffer for baking the authoritative LOS geometry (box = [0,cx,cz,hw,hd,ry,y0,y1],
   cyl/rock/plane → axis-aligned box [0,cx,cz,hw,hd,0,y0,y1]). buildWorld is synchronous and
   single-flight, so a module-level scratch is safe. addBox emits its exact OBB here. */
let _losGeo = [];

export const MAPS={
  desert:{
    name:'Desert Outpost · Sunset',layout:'desert',
    sky:{top:[.10,.14,.30],mid:[.55,.34,.40],hor:[1.06,.68,.38],low:[.28,.20,.17],glow:[1.0,.86,.62],stars:0},
    sunDir:[-.82,.30,-.28],sunColor:0xffb36b,sunI:7.5,
    hemi:[0x51608f,0x8a5c38,1.35],fill:[0x6a7ab8,.5],
    rim:[0x7a90c8,1.3],ibl:.55,
    fog:[0xcf9460,.0068],
    ground:'sand',rock:'rock',
    containers:['olive','rust'],
    lamp:{bulb:0xffd9a0,light:0xffc890,i:26},
    amb:'dust',
  },
  snow:{
    name:'Glacier Lake · Aurora',layout:'glacier',
    // Aurora bands add ≈.5 luminance near the zenith — everything else stays well under the Bloom threshold (.82)
    sky:{top:[.02,.03,.09],mid:[.05,.08,.17],hor:[.13,.20,.32],low:[.05,.07,.11],glow:[.85,.92,1.05],stars:1,aurora:1},
    sunDir:[-.45,.52,.25],sunColor:0xa8c4e8,sunI:5.0,  // cold moonlight
    hemi:[0x3c5a80,0x1a2634,1.15],fill:[0x5a7aa8,.4],
    rim:[0x4fd4a0,1.2],ibl:.45,
    fog:[0x0d1723,.0072],
    ground:'ice',rock:'rockDark',
    containers:['arctic','charcoal'],
    lamp:{bulb:0xbfe4ff,light:0x8fc4ea,i:22},
    amb:'snow',wind:.07,
  },
  snowtown:{
    name:'Neon Docklands · Rain',layout:'docks',
    sky:{top:[.02,.03,.06],mid:[.05,.07,.11],hor:[.12,.15,.20],low:[.04,.05,.07],glow:[.35,.42,.55],stars:0},
    sunDir:[-.3,.62,-.42],sunColor:0x93a8c8,sunI:2.3,  // moon behind rainclouds
    hemi:[0x36424f,0x12141a,.95],fill:[0x44536a,.3],
    rim:[0x4fe3ff,1.5],ibl:.4,
    fog:[0x0a0d12,.0115],
    ground:'asphalt',rock:null,mounds:false,           // urban: skyline replaces hills, no scattered boulders
    containers:['seaBlue','rust','mustard','charcoal'],
    lamp:{bulb:0xd8ecff,light:0xa8c8ee,i:30},
    amb:'rain',wind:.04,
  },
  ember:{
    name:'Volcano Caldera',layout:'caldera',
    sky:{top:[.012,.01,.02],mid:[.07,.03,.03],hor:[.55,.15,.05],low:[.10,.04,.03],glow:[.95,.40,.16],stars:1},
    sunDir:[.18,.44,.5],sunColor:0xff7a40,sunI:2.3,
    hemi:[0x38191f,0x451307,.95],fill:[0xff8a50,.3],
    rim:[0xff5a2a,1.4],ibl:.5,
    fog:[0x170a08,.0098],
    ground:'basalt',rock:'obsidian',
    containers:['emberTrim','charcoal'],
    lamp:{bulb:0xff8a40,light:0xff6a30,i:26},
    amb:'ember',lava:true,wind:.09,
  },
};

/* Spatial hash grid with 2 m cells — nearby queries for the bot navigation (collision slide,
   route clearance, local-grid A*). An object is filed in every cell its footprint overlaps, so a
   range query over the cells under a disc or segment returns everything that can touch it.
   Query cost follows the local density instead of the total count of colliders / bots. */
export class SpatialGrid{
  constructor(cell=2){this.cell=cell;this.map=new Map();this._stamp=0;this._mark=new Map();this.size=0;}
  clear(){this.map.clear();this.size=0;this._mark.clear();} // _mark keys are object refs: keep them from outliving the grid contents
  insertBox(minX,minZ,maxX,maxZ,obj){
    const cs=this.cell;
    for(let ix=Math.floor(minX/cs);ix<=Math.floor(maxX/cs);ix++)
      for(let iz=Math.floor(minZ/cs);iz<=Math.floor(maxZ/cs);iz++){
        const k=(ix+2048)*8192+(iz+2048); // cell key, valid for ±2048 cells about the origin
        const a=this.map.get(k);
        if(a)a.push(obj);else this.map.set(k,[obj]);
      }
    this.size++;
  }
  /* Fills `out` with the objects filed in the cells overlapping the square (x±r, z±r), each once */
  query(x,z,r,out){
    out.length=0;
    const cs=this.cell,s=++this._stamp;
    const x0=Math.floor((x-r)/cs),x1=Math.floor((x+r)/cs),z0=Math.floor((z-r)/cs),z1=Math.floor((z+r)/cs);
    for(let ix=x0;ix<=x1;ix++)for(let iz=z0;iz<=z1;iz++){
      const a=this.map.get((ix+2048)*8192+(iz+2048));
      if(!a)continue;
      for(const o of a)if(this._mark.get(o)!==s){this._mark.set(o,s);out.push(o);}
    }
    return out;
  }
}

/* The map's static colliders in a grid. Rebuilt on the next query if the collider list grew
   (or was swapped for another array) since the last build. */
export class ColliderGrid extends SpatialGrid{
  constructor(colliders,cell=2){super(cell);this.colliders=colliders;this.n=-1;}
  query(x,z,r,out){
    if(this.n!==this.colliders.length){
      this.clear();
      for(const c of this.colliders)this.insertBox(c.minX,c.minZ,c.maxX,c.maxZ,c);
      this.n=this.colliders.length;
    }
    return super.query(x,z,r,out);
  }
}

function addBox(scene,shootStatics,colliders,{w,h,d,mat,x,y,z,ry=0,surface='concrete',collide=true,shadow=true}){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  m.position.set(x,y,z);m.rotation.y=ry;
  m.castShadow=shadow;m.receiveShadow=true;
  m.userData.surface=surface;
  m.userData.losBox=true;                 // exact OBB already emitted below — skip the AABB fallback
  scene.add(m);shootStatics.push(m);
  // Integer centimetres (and milliradians) keep the wire upload well under the 4096 B message cap.
  _losGeo.push([0, Math.round(x*100), Math.round(z*100), Math.round(w/2*100), Math.round(d/2*100), Math.round(ry*1000), Math.round((y-h/2)*100), Math.round((y+h/2)*100)]);
  if(collide){
    // Axis-aligned bounds of a rotated box: w projects onto X, d onto Z (the old code always put the long side on X, so lengthwise containers had colliders turned 90°)
    const c=Math.abs(Math.cos(ry)),s=Math.abs(Math.sin(ry));
    const hx=c*w*.5+s*d*.5,hz=s*w*.5+c*d*.5;
    // Keep the AABB for cheap height/support queries, plus the true OBB for horizontal push-out.
    colliders.push({x,z,w,d,ry,minX:x-hx,maxX:x+hx,minZ:z-hz-.01,maxZ:z+hz+.01,top:y+h/2});
  }
  return m;
}

export function buildWorld(scene,assets,quality,mapKey='desert'){
  const map=MAPS[mapKey]||MAPS.desert;
  const world=new THREE.Group();
  scene.add(world);
  const colliders=[],shootStatics=[],worldAnim=[];
  _losGeo.length=0;                     // start a fresh authoritative LOS geometry pass
  const ownMats=[]; // materials created by this build (freed with the geometry on map switch; shared asset materials excluded)
  const M=assets.mats;
  const ctx={world,colliders,shootStatics,worldAnim,ownMats,M,assets,quality,map,mapKey};

  /* ------- Sky (parameterised; aurora bands for the glacier night) ------- */
  const sunDir=new THREE.Vector3(...map.sunDir).normalize();
  const skyMat=new THREE.ShaderMaterial({
    side:THREE.BackSide,depthWrite:false,fog:false,
    uniforms:{
      sunDir:{value:sunDir},
      cTop:{value:new THREE.Vector3(...map.sky.top)},
      cMid:{value:new THREE.Vector3(...map.sky.mid)},
      cHor:{value:new THREE.Vector3(...map.sky.hor)},
      cLow:{value:new THREE.Vector3(...map.sky.low)},
      cGlow:{value:new THREE.Vector3(...map.sky.glow)},
      uStars:{value:map.sky.stars},
      uAurora:{value:map.sky.aurora||0},
      uTime:{value:0},
    },
    vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`
      uniform vec3 sunDir,cTop,cMid,cHor,cLow,cGlow;uniform float uStars,uAurora,uTime;varying vec3 vDir;
      float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
      void main(){
        vec3 d=normalize(vDir);
        vec3 c;
        if(d.y>0.0){
          c=mix(cHor,cMid,smoothstep(0.0,0.22,d.y));
          c=mix(c,cTop,smoothstep(0.18,0.65,d.y));
        }else{
          c=mix(cHor,cLow,smoothstep(0.0,-0.25,d.y));
        }
        // Stars
        if(uStars>0.5&&d.y>0.08){
          vec3 sp=floor(d*220.0);
          float s=hash(sp);
          float tw=0.75+0.25*sin(uTime*2.0+s*40.0);
          c+=vec3(.9,.95,1.05)*smoothstep(0.996,1.0,s)*tw*smoothstep(0.08,0.3,d.y);
        }
        // Aurora: two sinuous curtains drifting around the sky, green core fading to violet
        if(uAurora>0.5&&d.y>0.12){
          float az=atan(d.x,d.z);
          float w1=0.5+0.5*sin(az*3.0+uTime*.35+sin(az*5.0-uTime*.5)*1.2);
          float band1=exp(-pow((d.y-0.34-0.10*w1)/0.13,2.0));
          float w2=0.5+0.5*sin(az*2.0-uTime*.22+2.6);
          float band2=exp(-pow((d.y-0.55-0.12*w2)/0.16,2.0));
          vec3 ac=mix(vec3(.10,.85,.42),vec3(.35,.45,.85),0.5+0.5*sin(az*1.3+uTime*.15));
          float flick=0.72+0.28*sin(uTime*1.1+az*7.0);
          c+=ac*(band1*0.62+band2*0.38)*flick*smoothstep(0.12,0.3,d.y);
        }
        float s2=max(dot(d,sunDir),0.0);
        c+=cGlow*(pow(s2,700.0)*4.0+pow(s2,48.0)*.7+pow(s2,7.0)*.3);
        gl_FragColor=vec4(c,1.0);
      }`
  });
  const sky=new THREE.Mesh(new THREE.SphereGeometry(480,32,20),skyMat);
  sky.name='sky'; // exposed for the PMREM environment bake (main.js _refreshEnvironment)
  sky.renderOrder=-10;sky.frustumCulled=false;
  world.add(sky);
  ownMats.push(skyMat);
  worldAnim.push(t=>{skyMat.uniforms.uTime.value=t;});

  scene.fog=new THREE.FogExp2(...map.fog);

  /* ------- Lighting ------- */
  const sun=new THREE.DirectionalLight(map.sunColor,map.sunI);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow=true;
  // 1024² over a tighter ±45 m frustum keeps roughly the same texel density as 2048²/±70,
  // at one quarter of the depth-buffer memory and bandwidth.
  sun.shadow.mapSize.set(1024,1024);
  const sc=sun.shadow.camera;
  sc.left=-45;sc.right=45;sc.top=45;sc.bottom=-45;sc.near=12;sc.far=180;
  sc.updateProjectionMatrix();
  sun.shadow.bias=-.0004;sun.shadow.normalBias=.03;
  world.add(sun,sun.target);
  world.add(new THREE.HemisphereLight(...map.hemi));
  const fill=new THREE.DirectionalLight(...map.fill);
  fill.position.set(60,40,80);
  world.add(fill);
  // Backlight rim: opposite the sun azimuth, no shadow — lifts character silhouettes off the
  // background (cinematic edge light; also grazes container edges, which reads as atmosphere)
  if(map.rim){
    const [rc,ri]=map.rim;
    const rim=new THREE.DirectionalLight(rc,ri);
    rim.position.copy(sunDir).multiplyScalar(-90);
    rim.position.y=Math.abs(rim.position.y)+40;
    rim.castShadow=false;
    world.add(rim);
  }

  /* ------- Ground (geometry identical on every map so movement physics stays uniform) -------
     The walkable disc is exactly flat: movement uses y=0, so any rendered rise inside the arena
     would bury the characters' boots (the rig has no foot IK to compensate). Dunes stay outside
     the r=56 player boundary. */
  // 110² segments = 24k triangles; the flat walkable disc does not need that density.
  // Normal maps carry the detail, so 64² is visually equivalent with -17k triangles.
  const groundSeg=quality==='high'?64:32;
  const groundGeo=new THREE.PlaneGeometry(360,360,groundSeg,groundSeg);
  groundGeo.rotateX(-Math.PI/2);
  {
    const p=groundGeo.attributes.position;
    for(let i=0;i<p.count;i++)p.setY(i,terrainHeight(p.getX(i),p.getZ(i)));
    p.needsUpdate=true;
    groundGeo.computeVertexNormals();
  }
  const ground=new THREE.Mesh(groundGeo,assets.ground[map.ground]);
  ground.receiveShadow=true;ground.userData.surface=map.ground==='sand'?'sand':'concrete';
  world.add(ground);shootStatics.push(ground);

  /* ------- Distant terrain: mounds, or a city skyline on the docks ------- */
  if(map.mounds!==false){
    for(let i=0;i<7;i++){
      const a=i/7*Math.PI*2+.4,r=86+((i*53)%30);
      const mound=new THREE.Mesh(new THREE.SphereGeometry(20+(i%3)*9,16,12),assets.ground[map.ground]);
      mound.position.set(Math.cos(a)*r,-2,Math.sin(a)*r);
      mound.scale.y=.28;
      world.add(mound);
    }
  }

  /* ------- Scattered rocks / shards (mat per map; docks is urban and skips them) ------- */
  if(map.rock){
    const rockGeo=new THREE.DodecahedronGeometry(1,0);
    for(let i=0;i<14;i++){
      const a=(i*137.5)*Math.PI/180,r=22+((i*67)%24);
      const rock=new THREE.Mesh(rockGeo,M[map.rock]);
      rock.position.set(Math.cos(a)*r,.1+(i%3)*.15,Math.sin(a)*r);
      rock.scale.set(.7+(i%4)*.5,.5+(i%3)*.4,.7+(i%2)*.6);
      rock.rotation.y=i;rock.castShadow=true;rock.receiveShadow=true;
      rock.userData.surface='concrete';
      world.add(rock);shootStatics.push(rock);
      if(i%3===0)colliders.push({minX:rock.position.x-1,maxX:rock.position.x+1,minZ:rock.position.z-1,maxZ:rock.position.z+1,top:1});
    }
  }

  /* ------- AbinStudio sponsor billboards (all four maps: emissive art, shootable with bullet holes) ------- */
  {
    const adGeo=new THREE.PlaneGeometry(6,3);
    const adMat=new THREE.MeshBasicMaterial({map:assets.tex.ad});
    const adBackMat=new THREE.MeshBasicMaterial({map:assets.tex.adBack});
    ownMats.push(adMat,adBackMat); // freed together with the world on map switch
    const postGeo=new THREE.CylinderGeometry(.09,.12,3.2,8);
    const frame=new THREE.BoxGeometry(6.2,3.2,.08);
    const spots=[[17,14],[-17,-14],[-16,12]];
    for(const [x,z] of spots){
      const ry=Math.atan2(-x,-z); // face the arena centre
      const grp=new THREE.Group();
      const board=new THREE.Mesh(adGeo,adMat);
      board.position.y=2.6;
      board.userData.surface='metal';
      grp.add(board);
      const back=new THREE.Mesh(adGeo,adBackMat); // separate content on the back face
      back.position.set(0,2.6,-.12);
      back.rotation.y=Math.PI;
      back.userData.surface='metal';
      grp.add(back);
      const beam=new THREE.Mesh(frame,M.metal);
      beam.position.set(0,2.6,-.05);
      grp.add(beam);
      for(const sd of[-1,1]){
        const post=new THREE.Mesh(postGeo,M.metal);
        post.position.set(sd*2.6,1.6,0);
        post.castShadow=true;
        post.userData.surface='metal';
        grp.add(post);
        shootStatics.push(post);
      }
      grp.position.set(x,0,z);
      grp.rotation.y=ry;
      world.add(grp);
      shootStatics.push(board);
      // Thin panel collider
      const hw=Math.abs(Math.cos(ry))*3+Math.abs(Math.sin(ry))*.1;
      const hd=Math.abs(Math.sin(ry))*3+Math.abs(Math.cos(ry))*.1;
      colliders.push({minX:x-hw,maxX:x+hw,minZ:z-hd,maxZ:z+hd,top:4.2});
    }
  }

  /* ------- Ambient particles: dust / snowfall / rain / embers ------- */
  const ambN=(quality==='high'?160:80)*(map.amb==='rain'?2:1);
  const ambGeo=new THREE.BufferGeometry();
  const apos=new Float32Array(ambN*3),avel=new Float32Array(ambN);
  for(let i=0;i<ambN;i++){
    const a=Math.random()*Math.PI*2,r=4+Math.random()*56;
    apos[i*3]=Math.cos(a)*r;
    if(map.amb==='rain'){apos[i*3+1]=Math.random()*12;avel[i]=6+Math.random()*5;}
    else{apos[i*3+1]=map.amb==='ember'?.2+Math.random()*6:.3+Math.random()*5;avel[i]=.4+Math.random()*.8;}
    apos[i*3+2]=Math.sin(a)*r;
  }
  ambGeo.setAttribute('position',new THREE.BufferAttribute(apos,3));
  const ambColor=map.amb==='snow'?0xf0f6ff:map.amb==='ember'?0xff9a50:map.amb==='rain'?0x9fc0e8:0xffd9a8;
  const ambSize=map.amb==='snow'?.09:map.amb==='ember'?.06:map.amb==='rain'?.05:.055;
  const ambPts=new THREE.Points(ambGeo,new THREE.PointsMaterial({
    color:ambColor,size:ambSize,transparent:true,opacity:map.amb==='ember'?.85:map.amb==='rain'?.4:.55,
    blending:THREE.AdditiveBlending,depthWrite:false}));
  ambPts.frustumCulled=false;
  world.add(ambPts);
  ownMats.push(ambPts.material);
  worldAnim.push(t=>{
    const p=ambGeo.attributes.position;
    for(let i=0;i<ambN;i++){
      let y=p.getY(i),x=p.getX(i),z=p.getZ(i);
      if(map.amb==='snow'){y-=avel[i]*.016;x+=Math.sin(t*.8+i)*.01;}
      else if(map.amb==='ember'){y+=avel[i]*.012;x+=Math.sin(t*1.2+i)*.006;}
      else if(map.amb==='rain'){y-=avel[i]*.016;x+=(.6+Math.sin(t*.4+i)*.3)*.016;if(y<0)y=10+Math.random()*4;}
      else{x+=.9*.016*(1+Math.sin(t*.5+i)*.4);}
      if(map.amb==='snow'&&y<0){y=6+Math.random()*2;}
      if(map.amb==='ember'&&y>7){y=.1;}
      if(x>62)x=-62;if(x<-62)x=62;
      if(z>62)z=-62;if(z<-62)z=62;
      p.setXYZ(i,x,y,z);
    }
    p.needsUpdate=true;
  });

  /* ------- Per-map layout ------- */
  (LAYOUTS[map.layout]||LAYOUTS.desert)(ctx);

  /* ------- Spawn points ------- */
  const spawnPoints=[
    new THREE.Vector3(0,0,-46),
    new THREE.Vector3(46,0,0),
    new THREE.Vector3(0,0,46),
    new THREE.Vector3(-46,0,4),
  ];

  // Ray list for line-of-sight / projectiles: drops the 24k-triangle ground mesh (the ray origin is always inside its bounds, so nothing early-outs and every triangle is tested each frame)
  const losStatics=shootStatics.filter(o=>o!==ground);

  // Authoritative LOS geometry for the server: boxes already emitted their exact OBB in addBox.
  // Everything else is approximated, and the approximation matters — a bounding AABB around a
  // cylinder or a rock dome rejects shots the player can plainly see past. Round props are baked
  // as the vertical cylinder primitive the LOS engine already understands; flat props (billboards,
  // signs) keep their yaw so the panel is thin in its own plane; only true boxes fall back to AABB.
  world.updateMatrixWorld(true);
  const MIN=.06;
  const scale=new THREE.Vector3(), quat=new THREE.Quaternion(), pos=new THREE.Vector3();
  for(const m of losStatics){
    if(m.userData.losBox)continue;
    const b=new THREE.Box3().setFromObject(m);
    if(b.isEmpty())continue;
    const cx=(b.min.x+b.max.x)/2, cz=(b.min.z+b.max.z)/2;
    const y0=Math.round(b.min.y*100), y1=Math.round(b.max.y*100);
    const g=m.geometry, P=g.parameters||{};
    let r=0;
    if(g.type==='CylinderGeometry') r=Math.max(P.radiusTop||0,P.radiusBottom||0);
    else if(g.type==='SphereGeometry') r=P.radius||0;
    m.matrixWorld.decompose(pos,quat,scale);
    if(r>0){
      // Round footprint: use the mean of the two horizontal scales (props are not squashed).
      const rr=Math.max(r*Math.max(scale.x,scale.z),MIN);
      _losGeo.push([1, Math.round(cx*100), Math.round(cz*100), Math.round(rr*100), y0, y1]);
      continue;
    }
    if(g.type==='PlaneGeometry'||g.type==='BoxGeometry'){
      const e=new THREE.Euler().setFromQuaternion(quat,'YXZ');
      const yaw=Math.round(e.y*1000);
      const hw=Math.max((b.max.x-b.min.x)/2, MIN), hz=Math.max((b.max.z-b.min.z)/2, MIN);
      _losGeo.push([0, Math.round(cx*100), Math.round(cz*100), Math.round(hw*100), Math.round(hz*100), yaw, y0, y1]);
      continue;
    }
    // Faceted rocks / domes: the AABB is the safe approximation, but never thinner than MIN.
    _losGeo.push([0, Math.round(cx*100), Math.round(cz*100),
      Math.round(Math.max((b.max.x-b.min.x)/2,MIN)*100), Math.round(Math.max((b.max.z-b.min.z)/2,MIN)*100),
      0, y0, y1]);
  }
  const losGeo=_losGeo.slice();
  return {group:world,colliders,colliderGrid:new ColliderGrid(colliders),shootStatics,losStatics,losGeo,spawnPoints,sunDir,mapKey,map,worldAnim,ownMats,sky,ground};
}

/* Street lamp (shared shape, per-map palette from MAPS[mapKey].lamp) */
function lamp(ctx,x,z,ry){
  const {world,shootStatics,ownMats,M,map}=ctx;
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.06,.08,4.6,8),M.metal);
  pole.position.set(x,2.3,z);pole.castShadow=true;
  pole.userData.surface='metal';
  world.add(pole);shootStatics.push(pole);
  const head=new THREE.Mesh(new THREE.BoxGeometry(.5,.14,.3),M.metal);
  head.position.set(x+Math.sin(ry)*.3,4.6,z+Math.cos(ry)*.3);head.rotation.y=ry;
  world.add(head);
  const bulb=new THREE.Mesh(new THREE.SphereGeometry(.09,8,8),new THREE.MeshBasicMaterial({color:map.lamp.bulb}));
  bulb.position.set(x+Math.sin(ry)*.5,4.5,z+Math.cos(ry)*.5);
  world.add(bulb);
  ownMats.push(bulb.material);
  const light=new THREE.PointLight(map.lamp.light,map.lamp.i,16,2);
  light.position.copy(bulb.position);light.position.y-=.1;
  world.add(light);
}

/* ================= Per-map layouts ================= */
const LAYOUTS={

  /* Desert Outpost — the v1.7 cover layout, kept verbatim (map 1 is preserved by design) */
  desert(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,mapKey}=ctx;
    const contMats=ctx.map.containers.map(k=>ctx.assets.containers[k]);

    /* Outpost cover */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[0],x:-8.5,y:1.3,z:-4,ry:.22,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[0],x:-8.3,y:3.9,z:-3.7,ry:.26,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[1],x:6.5,y:1.3,z:-9,ry:-.18,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:2.44,h:2.6,d:6.1,mat:contMats[1],x:12,y:1.3,z:5,ry:.1,surface:'metal'});

    const hescoDef=[[-7,-15],[-4.6,-15],[-2.2,-15],[2.2,-15],[4.6,-15],[7,-15],[9.4,-15],[-7,15],[7,15],[-9.4,13],[-9.4,10.6],[9.4,12],[9.4,9.6]];
    for(const [x,z] of hescoDef)
      addBox(world,shootStatics,colliders,{w:2.2,h:1.35,d:1.35,mat:M.hesco,x,y:.675,z,ry:(x%3)*.06,surface:'concrete'});

    addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x:3.5,y:.55,z:8.5,ry:.5,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x:-4.5,y:.55,z:9.5,ry:-.3,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:1.4,h:.8,d:1.4,mat:M.concrete,x:0,y:.4,z:-7,ry:.1,surface:'concrete'});

    for(let i=0;i<7;i++){
      const a=Math.PI*.72+i*Math.PI*.09;
      addBox(world,shootStatics,colliders,{w:1.1,h:.55,d:.8,mat:M.hesco,x:Math.cos(a)*7.4,y:.275,z:Math.sin(a)*7.4-1,ry:-a+Math.PI/2,surface:'concrete',collide:false});
      addBox(world,shootStatics,colliders,{w:1.1,h:.55,d:.8,mat:M.hesco,x:Math.cos(a)*7.4+.4,y:.82,z:Math.sin(a)*7.4-.8,ry:-a+Math.PI/2+.2,surface:'concrete',collide:false});
    }

    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:1.8,y:.55,z:4.2,ry:.4,surface:'wood'});
    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:2.9,y:.55,z:3.6,ry:.1,surface:'wood'});
    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:2.3,y:1.65,z:3.9,ry:.7,surface:'wood',collide:false});

    const barrelGeo=new THREE.CylinderGeometry(.42,.42,1.1,14);
    for(const [x,z,mi] of [[10.6,2.4,0],[11.5,2.9,1],[11,-.6,1]]){
      const b=new THREE.Mesh(barrelGeo,contMats[mi]);
      b.position.set(x,.55,z);b.castShadow=b.receiveShadow=true;
      b.userData.surface='metal';
      world.add(b);shootStatics.push(b);
    }
    colliders.push({minX:10.2,maxX:12,minZ:-1,maxZ:3.4,top:1.1});

    /* Watchtower */
    {
      const tx=17,tz=-13;
      const legGeo=new THREE.CylinderGeometry(.09,.12,5.2,8);
      for(const [dx,dz] of [[-1.1,-1.1],[1.1,-1.1],[-1.1,1.1],[1.1,1.1]]){
        const leg=new THREE.Mesh(legGeo,M.metal);
        leg.position.set(tx+dx,2.6,tz+dz);leg.castShadow=true;
        leg.userData.surface='metal';
        world.add(leg);shootStatics.push(leg);
      }
      const plat=new THREE.Mesh(new THREE.BoxGeometry(3,.18,3),M.wood);
      plat.position.set(tx,5.2,tz);plat.castShadow=plat.receiveShadow=true;
      world.add(plat);
      const cab=new THREE.Mesh(new THREE.BoxGeometry(2.6,1,2.6),contMats[0]);
      cab.position.set(tx,5.8,tz);cab.castShadow=true;
      world.add(cab);
      const roof=new THREE.Mesh(new THREE.ConeGeometry(2.3,1.2,4),contMats[1]);
      roof.position.set(tx,7,tz);roof.rotation.y=Math.PI/4;roof.castShadow=true;
      world.add(roof);
      const ant=new THREE.Mesh(new THREE.CylinderGeometry(.02,.02,2.4,6),M.metal);
      ant.position.set(tx+1,8.2,tz);world.add(ant);
      const beacon=new THREE.Mesh(new THREE.SphereGeometry(.09,8,8),new THREE.MeshBasicMaterial({color:0xff3a2a}));
      beacon.position.set(tx+1,9.4,tz);world.add(beacon);
      ownMats.push(beacon.material);
      colliders.push({minX:tx-1.3,maxX:tx+1.3,minZ:tz-1.3,maxZ:tz+1.3,top:5.2});
      worldAnim.push(t=>{beacon.material.color.setHex(Math.sin(t*3)>0?0xff3a2a:0x571512);});
    }

    /* Radar dish */
    {
      const px=-15,pz=-9;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.12,.16,3.4,8),M.metal);
      pole.position.set(px,1.7,pz);pole.castShadow=true;world.add(pole);
      const dish=new THREE.Mesh(new THREE.SphereGeometry(1.3,16,10,0,Math.PI*2,0,Math.PI*.36),M.metal);
      dish.position.set(px,4,pz);dish.rotation.x=-.9;dish.castShadow=true;
      dish.userData.surface='metal';
      world.add(dish);shootStatics.push(dish);
      worldAnim.push(t=>{dish.rotation.y=Math.sin(t*.6)*1.2;});
      colliders.push({minX:px-.8,maxX:px+.8,minZ:pz-.8,maxZ:pz+.8,top:3.4});
    }

    lamp(ctx,-6,7,.7);lamp(ctx,8,-2,2.4);

    /* Command tent */
    {
      const tx=-2,tz=-10.5;
      const g1=new THREE.Mesh(new THREE.BoxGeometry(5,.1,3.4),M.concrete);
      g1.position.set(tx,.05,tz);g1.receiveShadow=true;world.add(g1);
      const roof=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.7,5,3,1,false,0,Math.PI),M.hesco);
      roof.rotation.z=Math.PI/2;roof.rotation.y=Math.PI/2;
      roof.position.set(tx,1.1,tz);roof.scale.set(1,.72,1);
      roof.castShadow=roof.receiveShadow=true;
      roof.userData.surface='concrete';
      world.add(roof);shootStatics.push(roof);
      colliders.push({minX:tx-2.4,maxX:tx+2.4,minZ:tz-1.6,maxZ:tz+1.6,top:1.9});
    }
  },

  /* Glacier Lake — "crevasse ridge": a diagonal wall of glacial ice ridges west of centre, a fractured
     ice maze to the north, a half-sunken wreck in the north-west and an open iceberg plain to the east */
  glacier(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,assets}=ctx;
    const contMats=ctx.map.containers.map(k=>assets.containers[k]);

    /* Diagonal ice ridge (three long walls stepping NW→SE, west of the arena centre) */
    for(const [x,z] of [[-11,-4.5],[-7.5,-1],[-5,3]])
      addBox(world,shootStatics,colliders,{w:7,h:2.2,d:1.4,mat:M.ice,x,y:1.1,z,ry:.45,surface:'ice'});

    /* Fractured ice maze to the north */
    addBox(world,shootStatics,colliders,{w:2.6,h:1.7,d:2,mat:M.ice,x:-3,y:.85,z:-12,ry:.3,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2,h:2.6,d:2,mat:M.ice,x:2,y:1.3,z:-14,ry:-.2,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.4,h:1.5,d:2.2,mat:M.ice,x:6,y:.75,z:-11,ry:.55,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.2,h:1.8,d:1.8,mat:M.ice,x:-8,y:.9,z:-15,ry:.1,surface:'ice'});

    /* Half-sunken supply wreck, NW corner */
    addBox(world,shootStatics,colliders,{w:7,h:1.6,d:3,mat:contMats[1],x:-18,y:.7,z:-7,ry:.9,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:3,h:1.8,d:2.4,mat:contMats[0],x:-18.6,y:2.3,z:-7.8,ry:1.05,surface:'metal'});

    /* Open iceberg plain to the east */
    addBox(world,shootStatics,colliders,{w:3.2,h:2.2,d:2.6,mat:M.ice,x:10,y:1.1,z:-4,ry:.15,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.4,h:1.6,d:2,mat:M.ice,x:9,y:.8,z:8,ry:-.35,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2,h:2.8,d:2,mat:M.ice,x:13,y:1.4,z:2,ry:.05,surface:'ice'});

    /* Frozen supply crates (the ~1.1 m climbable tier) */
    const stack=(x,z,ry,n=2)=>{
      for(let i=0;i<n;i++)
        addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x,y:.575+i*1.15,z,ry:ry+i*.13,surface:'wood',collide:i===0});
    };
    stack(5,6,.3,2);stack(11,-8,-.2,2);
    stack(-3,8,.1,1);stack(-1.8,9,-.4,1);
    stack(3.5,-13,.4,1);

    /* Frozen trapper hut, north-east */
    {
      const hx=14,hz=-12;
      addBox(world,shootStatics,colliders,{w:3,h:2.3,d:2.6,mat:M.wood,x:hx,y:1.15,z:hz,ry:-.3,surface:'wood'});
      const roof=new THREE.Mesh(new THREE.ConeGeometry(2.3,1.3,4),contMats[0]);
      roof.position.set(hx,2.95,hz);roof.rotation.y=Math.PI/4;roof.castShadow=true;
      world.add(roof);
    }

    /* Signal mast, west edge, cold blinking beacon */
    {
      const px=-20,pz=7;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.08,.11,5.4,8),M.metal);
      pole.position.set(px,2.7,pz);pole.castShadow=true;world.add(pole);
      const beacon=new THREE.Mesh(new THREE.SphereGeometry(.1,8,8),new THREE.MeshBasicMaterial({color:0x7fd4ff}));
      beacon.position.set(px,5.7,pz);world.add(beacon);
      ownMats.push(beacon.material);
      colliders.push({minX:px-.5,maxX:px+.5,minZ:pz-.5,maxZ:pz+.5,top:5.4});
      worldAnim.push(t=>{beacon.material.color.setHex(Math.sin(t*2.2)>0?0x7fd4ff:0x16324a);});
    }

    /* Snow drifts */
    for(let i=0;i<10;i++){
      const a=(i*53.7)*Math.PI/180,r=12+((i*31)%26);
      const pile=new THREE.Mesh(new THREE.SphereGeometry(1+(i%3)*.5,10,8),assets.ground.snow);
      pile.position.set(Math.cos(a)*r,.1,Math.sin(a)*r);
      pile.scale.y=.42;pile.receiveShadow=true;
      world.add(pile);
    }

    /* Distant icebergs */
    for(const [x,z,s] of [[-52,-40,13],[48,-52,11],[-38,58,15],[58,42,12]]){
      const berg=new THREE.Mesh(new THREE.DodecahedronGeometry(1,0),M.ice);
      berg.position.set(x,2,z);
      berg.scale.set(s,s*.68,s*.8);
      berg.rotation.y=x;
      world.add(berg);
    }

    lamp(ctx,-13,6,.7);lamp(ctx,7,10,2.4);
  },

  /* Neon Docklands — "container canyon": two parallel container walls form a rain-slick street through the
     middle of the yard with staggered crossings, a stacking yard to the north, a loading-dock platform to the
     south, neon signage mounted inside the canyon, and the gantry crane parked to the east */
  docks(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,assets}=ctx;
    const [seaBlue,rust,mustard,charcoal]=ctx.map.containers.map(k=>assets.containers[k]);

    /* Canyon west wall (lengthwise containers, one staggered crossing gap) */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:-3,y:1.3,z:-13,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:-3,y:1.3,z:-6.9,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:-3,y:3.9,z:-6.9,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-3,y:1.3,z:-.2,ry:Math.PI/2,surface:'metal'});
    /* Canyon east wall (3-high tower north of the wide east crossing, single layers south of it) */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:charcoal,x:5,y:1.3,z:-12,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:5,y:3.9,z:-12,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:5,y:6.5,z:-12,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:5,y:1.3,z:1.8,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:5,y:1.3,z:8.5,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:5,y:3.9,z:8.5,ry:Math.PI/2,surface:'metal'});

    /* North stacking yard */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:-12,y:1.3,z:-12,ry:.15,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-11.7,y:3.9,z:-11.8,ry:.2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:10,y:1.3,z:-15,ry:-.1,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:charcoal,x:10.3,y:3.9,z:-14.7,ry:-.06,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-16,y:1.3,z:-3,ry:1.35,surface:'metal'});

    /* South loading-dock platform (climbable, ~1.1 m) + yard crates */
    addBox(world,shootStatics,colliders,{w:10,h:1.1,d:3,mat:M.concrete,x:-2,y:.55,z:10.5,ry:.06,surface:'concrete'});
    const stack=(x,z,ry,n=2)=>{
      for(let i=0;i<n;i++)
        addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x,y:.575+i*1.15,z,ry:ry+i*.13,surface:'wood',collide:i===0});
    };
    stack(8,8.5,.3,2);stack(9.3,9.1,-.2,1);
    stack(-8,6,.1,1);stack(13,-1,.4,2);

    /* Jersey barriers in the street and yards */
    for(const [x,z,ry] of [[1,-6,.4],[-6,1,-.2],[8,6.5,.1],[1,-13,-.3],[-11,3,.9]])
      addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x,y:.55,z,ry,surface:'concrete'});

    /* Neon signage mounted inside the canyon (panel + emissive face, shootable) */
    const sign=(mat,x,z,ry,{w=2.6,h=1.3,y=1.5,collide=true}={})=>{
      const back=new THREE.Mesh(new THREE.BoxGeometry(w+.14,h+.14,.12),charcoal);
      back.position.set(x,y,z);back.rotation.y=ry;
      back.castShadow=true;back.userData.surface='metal';
      world.add(back);
      const face=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);
      face.position.set(x+Math.sin(ry)*.07,y,z+Math.cos(ry)*.07);
      face.rotation.y=ry;
      face.userData.surface='metal';
      world.add(face);shootStatics.push(face);
      if(collide){
        const hx=Math.abs(Math.cos(ry))*w*.5+.1,hz=Math.abs(Math.sin(ry))*w*.5+.1;
        colliders.push({minX:x-hx,maxX:x+hx,minZ:z-hz,maxZ:z+hz,top:y+h*.5+.2});
      }
    };
    sign(M.neonDock,-1.45,-13,Math.PI/2-.25);   // west wall, tilted into the street
    sign(M.neonCargo,3.5,1.8,-Math.PI/2+.25);   // east wall, tilted into the street
    sign(M.neonDock,10,-13.3,-.04,{y:1.5});     // north yard stack, facing down the street
    {
      const px=-6,pz=-16.5,ry=Math.atan2(6,16.5);
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.09,.12,4.4,8),M.metal);
      pole.position.set(px,2.2,pz);pole.castShadow=true;world.add(pole);
      sign(M.neonFerry,px+Math.sin(ry)*.1,pz+Math.cos(ry)*.1,ry,{y:3.6,collide:false}); // pole-mounted, walk under it
    }

    /* Floodlight masts */
    const mast=(x,z,flicker)=>{
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.14,.2,7.2,8),M.metal);
      pole.position.set(x,3.6,z);pole.castShadow=true;
      pole.userData.surface='metal';
      world.add(pole);shootStatics.push(pole);
      const head=new THREE.Mesh(new THREE.BoxGeometry(1.6,.3,.5),M.metal);
      head.position.set(x,7,z);world.add(head);
      for(const sd of[-1,1]){
        const bulb=new THREE.Mesh(new THREE.SphereGeometry(.13,8,8),new THREE.MeshBasicMaterial({color:0xdcecff}));
        bulb.position.set(x+sd*.55,6.82,z+.1);
        world.add(bulb);ownMats.push(bulb.material);
      }
      const light=new THREE.PointLight(0xbfd4ff,34,20,2);
      light.position.set(x,6.7,z);
      world.add(light);
      colliders.push({minX:x-.4,maxX:x+.4,minZ:z-.4,maxZ:z+.4,top:7.2});
      if(flicker)worldAnim.push(t=>{light.intensity=30+(Math.sin(t*13)>.86?-16:0)+Math.sin(t*2.1)*3;});
    };
    mast(-14,8,true);mast(12,-2,false);

    /* Gantry crane silhouette parked east of the yard */
    {
      const cx=28,cz=-16;
      const legGeo=new THREE.BoxGeometry(1.2,16,1.2);
      for(const [dx,dz] of [[-9,-3],[9,-3],[-9,3],[9,3]]){
        const leg=new THREE.Mesh(legGeo,M.metal);
        leg.position.set(cx+dx,8,cz+dz);leg.castShadow=true;
        world.add(leg);
        colliders.push({minX:cx+dx-.8,maxX:cx+dx+.8,minZ:cz+dz-.8,maxZ:cz+dz+.8,top:16});
      }
      const beam=new THREE.Mesh(new THREE.BoxGeometry(26,1.6,2.4),M.metal);
      beam.position.set(cx,16.4,cz);beam.castShadow=true;
      world.add(beam);
      const trolley=new THREE.Mesh(new THREE.BoxGeometry(2,1.2,1.6),M.droneDark);
      trolley.position.set(cx+4,15.2,cz);world.add(trolley);
    }

    /* Dark skyline with blinking rooftop beacons */
    {
      const facade=new THREE.MeshStandardMaterial({color:0x1a1f28,roughness:.9,metalness:.05});
      ownMats.push(facade);
      const spots=[[-58,26,16,15,22],[62,-34,20,13,26],[52,48,14,12,18],[-64,-52,18,11,24],[38,66,16,10,20],[-40,64,13,9,16],[70,10,15,12,23]];
      let bi=0;
      for(const [x,z,w,h,d] of spots){
        const bld=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),facade);
        bld.position.set(x,h/2-2,z);
        world.add(bld);
        if(bi%2===0){
          const bc=new THREE.Mesh(new THREE.SphereGeometry(.35,6,6),new THREE.MeshBasicMaterial({color:0xff3355}));
          bc.position.set(x,h+.4,z);
          world.add(bc);ownMats.push(bc.material);
          const phase=bi*1.3;
          worldAnim.push(t=>{bc.material.color.setHex(Math.sin(t*1.6+phase)>0?0xff3355:0x3a0e18);});
        }
        bi++;
      }
    }

    /* Reflective rain puddles (y follows the ground noise so they never sink under the undulation) */
    {
      const ns=(x,z)=>Math.sin(x*.045)*Math.cos(z*.038)+Math.sin(x*.11+z*.07)*.5;
      const puddleMat=new THREE.MeshStandardMaterial({color:0x0d1016,roughness:.14,metalness:.35});
      ownMats.push(puddleMat);
      for(const [x,z,r] of [[-1,-6,1.9],[4,-1,1.5],[-5,3,1.8],[5,10.5,2],[-6,-8,1.6],[8,-6,1.7],[0,14,1.8]]){
        const pd=new THREE.Mesh(new THREE.CircleGeometry(r,18),puddleMat);
        pd.rotation.x=-Math.PI/2;
        pd.position.set(x,ns(x,z)*.5+.03,z);
        world.add(pd);
      }
    }

    lamp(ctx,-10,13,.7);lamp(ctx,9,3,2.4);
  },

  /* Volcano Caldera — "lava river crossing": a molten river snakes down the west side of the crater floor,
     forded by two rock-slab bridges (the southern one under a basalt arch); basalt column fields hold the
     east side and gate pillars mark the northern approach */
  caldera(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,assets,map}=ctx;
    const contMats=ctx.map.containers.map(k=>assets.containers[k]);

    /* Lava river: a chain of rimmed pools snaking north→south west of the arena centre.
       The northmost pool stays south of z≈19.5 — the shared team bases/respawn jitter
       (z=±24±4..10) must stay clear of map geometry on every layout. */
    const ns=(x,z)=>Math.sin(x*.045)*Math.cos(z*.038)+Math.sin(x*.11+z*.07)*.5;
    const river=[[-6,-18,3],[-7,-11,3.4],[-6,-3,3.2],[-8,4,3.2],[-6,11,3.4],[-4,15.5,3]];
    const lavaMat=new THREE.MeshStandardMaterial({
      map:assets.tex.lavaPool,emissiveMap:assets.tex.lavaPool,
      emissive:0xffffff,emissiveIntensity:1.15,roughness:1,metalness:0});
    ownMats.push(lavaMat);
    let lightI=0;
    for(const [px,pz,r] of river){
      const pool=new THREE.Mesh(new THREE.CircleGeometry(r,26),lavaMat);
      pool.rotation.x=-Math.PI/2;
      pool.position.set(px,ns(px,pz)*.5-.05,pz);
      world.add(pool);
      const rimN=Math.round(r*2);
      for(let i=0;i<rimN;i++){
        const a=i/rimN*Math.PI*2,rx=px+Math.cos(a)*(r+.8),rz=pz+Math.sin(a)*(r+.8);
        addBox(world,shootStatics,colliders,{w:2.6,h:1,d:1.6,mat:M.column,x:rx,y:ns(rx,rz)*.5+.35,z:rz,ry:a+Math.PI/2,surface:'concrete'});
      }
      if(lightI%2===0){ // keep the light budget sane: every other pool glows
        const l=new THREE.PointLight(0xff6a20,20,16,2);
        l.position.set(px,1.4,pz);
        world.add(l);
        worldAnim.push(t=>{l.intensity=17+Math.sin(t*2.2+px)*6;});
      }
      lightI++;
    }
    worldAnim.push(t=>{ // slow crust drift (shared texture; all pools scroll together)
      lavaMat.map.offset.set(t*.014%1,t*.009%1);
    });

    /* Rock-slab bridges across the river (jumpable ledges) */
    for(const [bx,bz,ry] of [[-6.5,-11,0],[-6.5,11,Math.PI/2]])
      addBox(world,shootStatics,colliders,{w:4.5,h:.9,d:3.4,mat:M.column,x:bx,y:.45,z:bz,ry,surface:'concrete'});

    /* Basalt arch spanning the south bridge */
    {
      for(const sd of[-1,1]){
        const col=new THREE.Mesh(new THREE.CylinderGeometry(.8,1,3.8,7),M.column);
        col.position.set(-6.5+sd*3.6,1.9,11);
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='concrete';
        world.add(col);shootStatics.push(col);
      }
      const lintel=new THREE.Mesh(new THREE.BoxGeometry(8.6,1,1.7),M.column);
      lintel.position.set(-6.5,4.2,11);lintel.castShadow=true;
      lintel.userData.surface='concrete';
      world.add(lintel);shootStatics.push(lintel);
      colliders.push({minX:-10.9,maxX:-2.1,minZ:10.1,maxZ:11.9,top:3.8});
    }

    /* East basalt column fields (hex prisms) */
    const colGeo=new THREE.CylinderGeometry(.85,1,1,6);
    const cluster=(cx,cz,list)=>{
      let top=0;
      for(const [dx,dz,h] of list){
        const col=new THREE.Mesh(colGeo,M.column);
        col.scale.y=h;
        col.position.set(cx+dx,h/2,cz+dz);
        col.rotation.y=dx*1.7;
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='concrete';
        world.add(col);shootStatics.push(col);
        top=Math.max(top,h);
      }
      colliders.push({minX:cx-1.6,maxX:cx+1.6,minZ:cz-1.6,maxZ:cz+1.6,top:top});
    };
    cluster(10,-8,[[0,0,4.2],[1.3,.5,3.1],[-.9,1.2,2.4],[.5,-1.1,3.6]]);
    cluster(14,2,[[0,0,3.4],[1.2,.7,2.3],[-.8,-.9,2.9]]);
    cluster(8,10,[[0,0,4.5],[1.1,-.8,2.8],[-.9,.9,3.2]]);
    cluster(18,-3,[[0,0,2.6],[.9,.9,1.9]]);

    /* Northern gate pillars */
    for(const [x,z] of [[-2,-22],[7,-20]]){
      const col=new THREE.Mesh(new THREE.CylinderGeometry(1,1.2,4.5,6),M.column);
      col.position.set(x,2.25,z);
      col.castShadow=col.receiveShadow=true;
      col.userData.surface='concrete';
      world.add(col);shootStatics.push(col);
      colliders.push({minX:x-1.2,maxX:x+1.2,minZ:z-1.2,maxZ:z+1.2,top:4.5});
    }

    /* Scorched supply cache south-east + crates (the ~1.1 m climbable tier) */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[0],x:4,y:1.3,z:16,ry:.2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[1],x:-11,y:1.3,z:19,ry:-.15,surface:'metal'});
    for(const [x,z,ry] of [[-1,-6,.4],[12,-3,.1],[-13,-2,-.3],[10,14,.5]]){
      addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x,y:.575,z,ry,surface:'wood'});
    }

    /* Obsidian slabs */
    for(const [x,z,s,ry] of [[5,-13,2.2,.4],[16,7,2.4,-.3],[-14,8,2,.9],[0,20,2,-.6]]){
      const slab=new THREE.Mesh(new THREE.DodecahedronGeometry(1,0),M.obsidian);
      slab.position.set(x,.6,z);
      slab.scale.set(s,s*.5,s*.7);
      slab.rotation.y=ry;slab.castShadow=slab.receiveShadow=true;
      slab.userData.surface='concrete';
      world.add(slab);shootStatics.push(slab);
      colliders.push({minX:x-s*.6,maxX:x+s*.6,minZ:z-s*.6,maxZ:z+s*.6,top:1.4});
    }

    /* Lava fissures (thin glowing cracks + flickering light) */
    if(map.lava){
      const crackMat=new THREE.MeshBasicMaterial({color:0xff5a18});
      ownMats.push(crackMat);
      const crackGeo=new THREE.PlaneGeometry(1,1);
      for(let i=0;i<10;i++){
        const a=i*73.4*Math.PI/180,r=10+((i*37)%30);
        const len=3+(i%4)*3;
        const cr=new THREE.Mesh(crackGeo,crackMat);
        cr.rotation.x=-Math.PI/2;cr.rotation.z=(i*1.7)%Math.PI;
        cr.position.set(Math.cos(a)*r,.03,Math.sin(a)*r);
        cr.scale.set(len,.8+(i%3)*.4,1);
        world.add(cr);
        if(i%4===0){
          const l=new THREE.PointLight(0xff6a20,14,10,2);
          l.position.set(cr.position.x,1,cr.position.z);
          world.add(l);
          worldAnim.push(t=>{l.intensity=12+Math.sin(t*2.4+i)*5;});
        }
      }
    }

    /* The volcano cone on the horizon, crater glowing */
    {
      const cone=new THREE.Mesh(new THREE.ConeGeometry(26,30,24),M.column);
      cone.position.set(0,13,-88);
      world.add(cone);
      const rim=new THREE.Mesh(new THREE.CircleGeometry(7,20),new THREE.MeshBasicMaterial({color:0xff5a18}));
      rim.rotation.x=Math.PI/2; // face up out of the crater
      rim.position.set(0,27.4,-88);
      world.add(rim);
      ownMats.push(rim.material);
      worldAnim.push(t=>{rim.material.color.setHSL(.05,1,.45+.12*Math.sin(t*1.3));});
    }

    lamp(ctx,11,-11,.7);lamp(ctx,-13,14,2.4);
  },
};

/* Map switch: destroy the old world (geometry + materials created for this map; ambient Points geometry is freed too) */
export function disposeWorld(scene,world){
  if(!world)return;
  scene.remove(world.group);
  world.group.traverse(o=>{
    if(o.geometry)o.geometry.dispose();
    if(o.isLight&&o.dispose)o.dispose(); // free the sun's shadow map (2048² on high quality)
  });
  for(const m of world.ownMats||[])m.dispose();
  scene.fog=null;
}
