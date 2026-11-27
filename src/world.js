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
  m.name=`world-box-${x.toFixed(2)}-${y.toFixed(2)}-${z.toFixed(2)}`;
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
    colliders.push({x,z,w,d,ry,minX:x-hx,maxX:x+hx,minZ:z-hz-.01,maxZ:z+hz+.01,bottom:y-h/2,top:y+h/2});
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
  const mounds=[];
  if(map.mounds!==false){
    for(let i=0;i<7;i++){
      const a=i/7*Math.PI*2+.4,r=86+((i*53)%30),radius=20+(i%3)*9;
      // The caldera already owns the northern horizon; a generic mound there merged into it.
      if(mapKey==='ember'&&Math.abs(Math.atan2(Math.sin(a+Math.PI/2),Math.cos(a+Math.PI/2)))<.45)continue;
      const mound=new THREE.Mesh(new THREE.SphereGeometry(radius,16,12),assets.ground[map.ground]);
      mound.position.set(Math.cos(a)*r,-2,Math.sin(a)*r);
      mound.scale.y=.28;
      world.add(mound);mounds.push({x:mound.position.x,z:mound.position.z,r:radius});
    }
  }
  ctx.mounds=mounds;

  /* ------- Scattered rocks / shards (mat per map; docks is urban and skips them) ------- */
  if(map.rock){
    const rockGeo=new THREE.DodecahedronGeometry(1,0);
    for(let i=0;i<14;i++){
      const a=(i*137.5)*Math.PI/180,r=22+((i*67)%24);
      const rock=new THREE.Mesh(rockGeo,M[map.rock]);
      rock.name='scattered-rock';
      rock.position.set(Math.cos(a)*r,.1+(i%3)*.15,Math.sin(a)*r);
      rock.scale.set(.7+(i%4)*.5,.5+(i%3)*.4,.7+(i%2)*.6);
      rock.rotation.y=i;rock.castShadow=true;rock.receiveShadow=true;
      rock.userData.surface='concrete';
      world.add(rock);shootStatics.push(rock);
      const bounds=new THREE.Box3().setFromObject(rock);
      colliders.push({minX:bounds.min.x,maxX:bounds.max.x,minZ:bounds.min.z,maxZ:bounds.max.z,bottom:0,top:bounds.max.y});
    }
  }

  /* ------- AbinStudio sponsor billboards (all four maps: emissive art, shootable with bullet holes) ------- */
  {
    const adGeo=new THREE.PlaneGeometry(6,3);
    const adMat=new THREE.MeshBasicMaterial({map:assets.tex.ad});
    const adBackMat=new THREE.MeshBasicMaterial({map:assets.tex.adBack});
    ownMats.push(adMat,adBackMat); // freed together with the world on map switch
    const postGeo=new THREE.CylinderGeometry(.09,.12,3.2,8);
    // The frame overhangs the artwork, so its supports sit outside the printable faces instead
    // of stabbing through the front/back billboards.
    const frame=new THREE.BoxGeometry(6.8,3.2,.08);
    const spots=mapKey==='ember'?[[17,14],[-17,-14],[-19,13]]
      :mapKey==='snowtown'?[[20,14],[-20,-18],[-19,14]]
      :[[17,14],[-17,-14],[-16,12]];
    for(const [x,z] of spots){
      const ry=Math.atan2(-x,-z); // face the arena centre
      const grp=new THREE.Group();
      grp.name=`sponsor-${x}-${z}`;
      const board=new THREE.Mesh(adGeo,adMat);
      board.name='sponsor-front';
      board.position.y=2.6;
      board.userData.surface='metal';
      grp.add(board);
      const back=new THREE.Mesh(adGeo,adBackMat); // separate content on the back face
      back.name='sponsor-back';
      back.position.set(0,2.6,-.12);
      back.rotation.y=Math.PI;
      back.userData.surface='metal';
      grp.add(back);
      const beam=new THREE.Mesh(frame,M.metal);
      beam.name='sponsor-frame';
      beam.position.set(0,2.6,-.05);
      grp.add(beam);
      for(const sd of[-1,1]){
        const post=new THREE.Mesh(postGeo,M.metal);
        post.name='sponsor-post';
        post.position.set(sd*3.25,1.6,0);
        post.castShadow=true;
        post.userData.surface='metal';
        grp.add(post);
        shootStatics.push(post);
      }
      grp.position.set(x,0,z);
      grp.rotation.y=ry;
      world.add(grp);
      shootStatics.push(board,back);
      // Thin panel collider. Keep the supports inside the same footprint.
      const hw=Math.abs(Math.cos(ry))*3.4+Math.abs(Math.sin(ry))*.12;
      const hd=Math.abs(Math.sin(ry))*3.4+Math.abs(Math.cos(ry))*.12;
      colliders.push({x,z,w:6.8,d:.24,ry,minX:x-hw,maxX:x+hw,minZ:z-hd,maxZ:z+hd,bottom:1.1,top:4.2});
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
  const {world,shootStatics,colliders,ownMats,M,map}=ctx;
  const pole=new THREE.Mesh(new THREE.CylinderGeometry(.06,.08,4.6,8),M.metal);
  pole.name='street-lamp-pole';
  pole.position.set(x,2.3,z);pole.castShadow=true;
  pole.userData.surface='metal';
  world.add(pole);shootStatics.push(pole);
  colliders.push({minX:x-.1,maxX:x+.1,minZ:z-.1,maxZ:z+.1,bottom:0,top:4.6});
  const head=new THREE.Mesh(new THREE.BoxGeometry(.5,.14,.3),M.metal);
  head.name='street-lamp-head';head.userData.visualOnly=true;
  head.position.set(x+Math.sin(ry)*.3,4.67,z+Math.cos(ry)*.3);head.rotation.y=ry; // bottom = pole top 4.6
  world.add(head);
  const bulb=new THREE.Mesh(new THREE.SphereGeometry(.09,8,8),new THREE.MeshBasicMaterial({color:map.lamp.bulb}));
  bulb.name='street-lamp-bulb';bulb.userData.visualOnly=true;
  bulb.position.set(x+Math.sin(ry)*.5,4.51,z+Math.cos(ry)*.5); // top = head bottom 4.6
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
      // Keep the ring east of the container stack; the old centre put four bags inside it.
      addBox(world,shootStatics,colliders,{w:1.1,h:.55,d:.8,mat:M.hesco,x:Math.cos(a)*7.4+2.5,y:.275,z:Math.sin(a)*7.4-1,ry:-a+Math.PI/2,surface:'concrete'});
      // Small offset keeps the upper bag supported (>70% footprint, <20% / 0.4 m overhang);
      // the old 0.4 m x-offset left only 40–61% contact area.
      addBox(world,shootStatics,colliders,{w:1.1,h:.55,d:.8,mat:M.hesco,x:Math.cos(a)*7.4+2.62,y:.825,z:Math.sin(a)*7.4-.95,ry:-a+Math.PI/2+.05,surface:'concrete'});
    }

    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:1.8,y:.55,z:4.2,ry:.4,surface:'wood'});
    // Second crate pushed 21 cm east: its rotated AABB (hx .60) shaved 22 cm into the
    // first crate's AABB (hx .72); the OBBs missed, but the collider pair is flagged.
    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:3.11,y:.55,z:3.6,ry:.1,surface:'wood'});
    // Top crate centred on the (3.11,3.6) base. The old (2.3,3.9) position bridged two
    // independent bases; centring it on the east base also keeps the (0,7)→(6,-8) sight-line open.
    addBox(world,shootStatics,colliders,{w:1.1,h:1.1,d:1.1,mat:M.wood,x:3.11,y:1.65,z:3.6,ry:.1,surface:'wood'});

    const barrelGeo=new THREE.CylinderGeometry(.42,.42,1.1,14);
    // Middle barrel nudged 7 cm west: at x 10.1 its AABB reached 10.52 and clipped the
    // (12,5) container's rotated AABB (minX 10.48). Real drums never touched.
    for(const [x,z,mi] of [[9.2,2.4,0],[10.03,2.9,1],[9.6,-.6,1]]){
      const b=new THREE.Mesh(barrelGeo,contMats[mi]);
      b.name='supply-barrel';
      b.position.set(x,.55,z);b.castShadow=b.receiveShadow=true;
      b.userData.surface='metal';
      world.add(b);shootStatics.push(b);
      colliders.push({minX:x-.42,maxX:x+.42,minZ:z-.42,maxZ:z+.42,bottom:0,top:1.1});
    }

    /* Watchtower */
    {
      const tx=17,tz=-13;
      const legGeo=new THREE.CylinderGeometry(.09,.12,5.11,8);
      for(const [dx,dz] of [[-1.1,-1.1],[1.1,-1.1],[-1.1,1.1],[1.1,1.1]]){
        const leg=new THREE.Mesh(legGeo,M.metal);
        leg.name='watchtower-leg';
        leg.position.set(tx+dx,2.555,tz+dz);leg.castShadow=true;
        leg.userData.surface='metal';
        world.add(leg);shootStatics.push(leg);
        colliders.push({minX:tx+dx-.12,maxX:tx+dx+.12,minZ:tz+dz-.12,maxZ:tz+dz+.12,bottom:0,top:5.11});
      }
      const plat=new THREE.Mesh(new THREE.BoxGeometry(3,.18,3),M.wood);
      plat.name='watchtower-platform';plat.position.set(tx,5.2,tz);plat.castShadow=plat.receiveShadow=true;
      world.add(plat);
      colliders.push({x:tx,z:tz,w:3,d:3,ry:0,minX:tx-1.5,maxX:tx+1.5,minZ:tz-1.5,maxZ:tz+1.5,bottom:5.11,top:5.29});
      const cab=new THREE.Mesh(new THREE.BoxGeometry(2.6,1,2.6),contMats[0]);
      cab.name='watchtower-cab';cab.position.set(tx,5.8,tz);cab.castShadow=true;
      world.add(cab);
      colliders.push({x:tx,z:tz,w:2.6,d:2.6,ry:0,minX:tx-1.3,maxX:tx+1.3,minZ:tz-1.3,maxZ:tz+1.3,bottom:5.3,top:6.3});
      const roof=new THREE.Mesh(new THREE.ConeGeometry(2.3,1.2,4),contMats[1]);
      roof.name='watchtower-roof';roof.userData.visualOnly=true;
      roof.position.set(tx,6.9,tz);roof.rotation.y=Math.PI/4;roof.castShadow=true;
      world.add(roof);
      const ant=new THREE.Mesh(new THREE.CylinderGeometry(.02,.02,2.4,6),M.metal);
      ant.name='watchtower-antenna';ant.userData.visualOnly=true;
      ant.position.set(tx,8.7,tz);world.add(ant); // base = roof apex (7.5 m), centred on the tower
      const beacon=new THREE.Mesh(new THREE.SphereGeometry(.09,8,8),new THREE.MeshBasicMaterial({color:0xff3a2a}));
      beacon.name='watchtower-beacon';beacon.userData.visualOnly=true;
      beacon.position.set(tx,9.99,tz);world.add(beacon); // bottom = antenna top 9.9
      ownMats.push(beacon.material);

      worldAnim.push(t=>{beacon.material.color.setHex(Math.sin(t*3)>0?0xff3a2a:0x571512);});
    }

    /* Radar dish */
    {
      const px=-15,pz=-9;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.12,.16,3.4,8),M.metal);
      pole.name='radar-pole';pole.position.set(px,1.7,pz);pole.castShadow=true;world.add(pole);
      const dish=new THREE.Mesh(new THREE.SphereGeometry(1.3,16,10,0,Math.PI*2,0,Math.PI*.36),M.metal);
      dish.name='radar-dish';dish.userData.visualOnly=true;
      dish.position.set(px,4,pz);dish.rotation.x=-.9;dish.castShadow=true;
      dish.userData.surface='metal';
      world.add(dish);shootStatics.push(dish);
      worldAnim.push(t=>{dish.rotation.y=Math.sin(t*.6)*1.2;});
      colliders.push({minX:px-.18,maxX:px+.18,minZ:pz-.18,maxZ:pz+.18,bottom:0,top:3.4});
    }

    // East lamp moved to x 8.45: its pole AABB sat inside the 3-drum cluster's shared
    // collider (x 6.3..8.2), although the real drums were 0.95 m away.
    lamp(ctx,-6,7,.7);lamp(ctx,8.45,-2,2.4);

    /* Command tent */
    {
      const tx=-2,tz=-10.5;
      const g1=new THREE.Mesh(new THREE.BoxGeometry(5,.1,3.4),M.concrete);
      g1.name='command-tent-foundation';g1.userData.visualOnly=true;
      g1.position.set(tx,.05,tz);g1.receiveShadow=true;world.add(g1);
      const roof=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.7,5,3,1,false,0,Math.PI),M.hesco);
      roof.name='command-tent-roof';
      roof.rotation.z=Math.PI/2;
      roof.position.set(tx,1.1,tz);roof.scale.set(1,1,1);
      roof.castShadow=roof.receiveShadow=true;
      roof.userData.surface='concrete';
      world.add(roof);shootStatics.push(roof);
      // The arch roof's lower edge is y=1.1; four thin posts connect it to the 0.1 m
      // foundation instead of leaving the curved roof floating. They are visual/LOS supports
      // (listed by the validator); the tent keeps its original solid collider.
      const tentPostGeo=new THREE.CylinderGeometry(.055,.07,1,8);
      for(const dx of[-2.35,2.35])for(const dz of[-1.55,1.55]){
        const post=new THREE.Mesh(tentPostGeo,M.metal);
        post.name='command-tent-post';post.userData.visualOnly=true;post.userData.surface='metal';
        post.position.set(tx+dx,.6,tz+dz);post.castShadow=true;
        world.add(post);shootStatics.push(post);
      }
      colliders.push({minX:tx-2.5,maxX:tx+2.5,minZ:tz-1.7,maxZ:tz+1.7,bottom:0,top:2.57});
    }

    /* v1.14 cover pass: the old layout left three sight-lines open from base to base.
       A broken centre wall now cuts the N–S lane, waist-high drums give mid-field peek cover,
       and a camo-net platform rewards the west flank with a climbable sniper perch. */
    // Broken wall across the middle (two segments with a gap at x≈-1.4..2.0):
    // shades the west push lane and the centre-east crossing while leaving the KOTH
    // capture point, the separation cluster at the origin, the east flick lane and the
    // pre-existing crate cluster near (2.3,3.9) clear.
    // West segment pushed to (-6,5): at (-3.2,3.4) it sat inside the sandbag/hesco ring
    // band (r 7.4 from (2.5,-1)) — the ring's 145.8° bags at (-3.6,3.2)/(-3.2,3.4) ran
    // straight through it.
    addBox(world,shootStatics,colliders,{w:3.6,h:2.3,d:.8,mat:M.concrete,x:-6,y:1.15,z:5,ry:.06,surface:'concrete'});
    // Pale plank-textured panel moved 30 cm north (5.2 → 5.5): its south face at 4.67 m
    // overlapped the crate at (1.8,4.2) by 28 cm and the stacked crate by 3 cm.
    addBox(world,shootStatics,colliders,{w:3.4,h:2.3,d:.8,mat:M.concrete,x:3.9,y:1.15,z:5.5,ry:-.08,surface:'concrete'});
    // Waist-high drum cluster mid-east (peek cover for the push through the gap); the solo
    // drum sits south of the pre-existing barrel row (its collider spans x 10.2..12, z -1..3.4)
    for(const [x,z,mi] of [[6.8,-2.4,0],[7.7,-2.9,1],[7.2,-1.4,1],[10.9,-2.6,0]]){
      const b=new THREE.Mesh(barrelGeo,contMats[mi]);
      b.position.set(x,.55,z);b.castShadow=b.receiveShadow=true;
      b.userData.surface='metal';
      world.add(b);shootStatics.push(b);
    }
    colliders.push({minX:6.3,maxX:8.2,minZ:-3.4,maxZ:-.9,top:1.1});
    colliders.push({minX:10.4,maxX:11.4,minZ:-3.1,maxZ:-2.1,top:1.1});
    // Camo-net platform on the west lane: tier2 is a half-slab offset north (tier1 keeps a
    // standable ring — the old same-footprint stack left nothing to stand on at 1.10), and the
    // rail runs at 1.6 so the E–W sight-line stays open over the post top.
    addBox(world,shootStatics,colliders,{w:2.4,h:1.1,d:2.4,mat:M.wood,x:-14,y:.55,z:0,surface:'wood'});
    addBox(world,shootStatics,colliders,{w:2.4,h:1.1,d:1.3,mat:M.wood,x:-14,y:1.65,z:-.55,surface:'wood'});
    // Rail sits on the tier2 top (2.2 m) with 3 cm horizontal bearing; the old bottom
    // at 1.7 m floated beside the slab. Its north overhang is intentional guard-rail geometry.
    const camoRail=addBox(world,shootStatics,colliders,{w:.14,h:1.2,d:2.4,mat:M.metal,x:-12.75,y:2.8,z:0,surface:'metal'});
    camoRail.name='camo-platform-rail';camoRail.userData.assemblyRole='rail';
    // Paired hesco ears around the platform: a low shoot-over lip to the south, a blocker to the north
    addBox(world,shootStatics,colliders,{w:2.2,h:1.35,d:1.35,mat:M.hesco,x:-14,y:.675,z:3.2,ry:.15,surface:'concrete'});
    // North ear shifted to x -13.5: at -11.6 it ran into the container stack's west end (x ≤ -11.75).
    addBox(world,shootStatics,colliders,{w:2.2,h:1.35,d:1.35,mat:M.hesco,x:-13.5,y:.675,z:-5.4,ry:-.4,surface:'concrete'});
  },

  /* Glacier Lake — "crevasse ridge": a diagonal wall of glacial ice ridges west of centre, a fractured
     ice maze to the north, a half-sunken wreck in the north-west and an open iceberg plain to the east */
  glacier(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,assets,mounds}=ctx;
    const contMats=ctx.map.containers.map(k=>assets.containers[k]);

    /* Diagonal ice ridge (three long walls stepping NW→SE, west of the arena centre).
       The 7 m walls have a 4.33 m deep rotated AABB; the old 3.5 m z steps made their
       AABBs overlap by 0.8 m. End walls were spread to 3.9 m steps — the wall OBBs
       never intersected, but the collider pairs tripped the 2 cm audit. */
    for(const [x,z] of [[-13,-5.4],[-9.5,-1],[-9,3.7]])
      addBox(world,shootStatics,colliders,{w:7,h:2.2,d:1.4,mat:M.ice,x,y:1.1,z,ry:.45,surface:'ice'});

    /* Fractured ice maze to the north */
    addBox(world,shootStatics,colliders,{w:2.6,h:1.7,d:2,mat:M.ice,x:-3,y:.85,z:-12,ry:.3,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2,h:2.6,d:2,mat:M.ice,x:2,y:1.3,z:-14,ry:-.2,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.4,h:1.5,d:2.2,mat:M.ice,x:6,y:.75,z:-11,ry:.55,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.2,h:1.8,d:1.8,mat:M.ice,x:-8,y:.9,z:-15,ry:.1,surface:'ice'});

    /* Half-sunken supply wreck, NW corner */
    addBox(world,shootStatics,colliders,{w:7,h:1.6,d:3,mat:contMats[1],x:-20,y:.7,z:-7,ry:.9,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:3,h:1.8,d:2.4,mat:contMats[0],x:-20.6,y:2.4,z:-7.8,ry:1.05,surface:'metal'});

    /* Open iceberg plain to the east */
    addBox(world,shootStatics,colliders,{w:3.2,h:2.2,d:2.6,mat:M.ice,x:12,y:1.1,z:-4,ry:.15,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.4,h:1.6,d:2,mat:M.ice,x:9,y:.8,z:8,ry:-.35,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2,h:2.8,d:2,mat:M.ice,x:13,y:1.4,z:2,ry:.05,surface:'ice'});

    /* Frozen supply crates (the ~1.1 m climbable tier) */
    const stack=(x,z,ry,n=2)=>{
      for(let i=0;i<n;i++)
        // 18 cm offset stays below the 20% / 0.4 m overhang limit and keeps >70% footprint
        // overlap; the old 90 cm stair offset left the upper crate mostly unsupported.
        addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x:x+(i?.18:0),y:.575+i*1.15,z,ry:ry+i*.13,surface:'wood'});
    };
    stack(5,6,.3,2);stack(11,-8,-.2,2);
    // North-east crate moved to (-1.6,9.2): its AABB shaved 18 cm × 40 cm into the
    // (-3,8) crate; the OBBs were clear, the collider pair was not.
    stack(-3,8,.1,1);stack(-1.6,9.2,-.4,1);
    stack(4,-16.5,.4,1);

    /* Frozen trapper hut, north-east */
    {
      const hx=14,hz=-12;
      const cabin=addBox(world,shootStatics,colliders,{w:3,h:2.3,d:2.6,mat:M.wood,x:hx,y:1.15,z:hz,ry:-.3,surface:'wood'});
      cabin.name='trapper-hut-cabin';
      // The detached roof panel is stored on the ground east of the hut (base on the floor,
      // not on the cabin): base y=0, apex 1.3, and 46 cm of world-AABB clearance to the cabin.
      const roof=new THREE.Mesh(new THREE.ConeGeometry(1.8,1.3,4),contMats[0]);
      const roofSide=3.6*Math.SQRT1_2, roofRy=cabin.rotation.y+Math.PI/4;
      const roofX=hx+4.3,roofZ=hz;
      roof.name='trapper-hut-roof';roof.position.set(roofX,.65,roofZ);roof.rotation.y=roofRy;roof.castShadow=roof.receiveShadow=true;
      world.add(roof);
      const rh=roofSide*.5,rc=Math.abs(Math.cos(roofRy)),rs=Math.abs(Math.sin(roofRy));
      const rxa=rc*rh+rs*rh,rza=rs*rh+rc*rh;
      colliders.push({x:roofX,z:roofZ,w:roofSide,d:roofSide,ry:roofRy,minX:roofX-rxa,maxX:roofX+rxa,minZ:roofZ-rza,maxZ:roofZ+rza,bottom:0,top:1.3});
    }

    /* Signal mast, west edge, cold blinking beacon */
    {
      const px=-20,pz=7;
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.08,.11,5.4,8),M.metal);
      pole.name='signal-mast';pole.position.set(px,2.7,pz);pole.castShadow=true;world.add(pole);
      const beacon=new THREE.Mesh(new THREE.SphereGeometry(.1,8,8),new THREE.MeshBasicMaterial({color:0x7fd4ff}));
      beacon.name='signal-beacon';beacon.userData.visualOnly=true;
      beacon.position.set(px,5.5,pz);world.add(beacon);
      ownMats.push(beacon.material);
      colliders.push({minX:px-.14,maxX:px+.14,minZ:pz-.14,maxZ:pz+.14,bottom:0,top:5.4});
      worldAnim.push(t=>{beacon.material.color.setHex(Math.sin(t*2.2)>0?0x7fd4ff:0x16324a);});
    }

    /* Snow drifts */
    for(let i=0;i<10;i++){
      if(i===6)continue; // deterministic drift at (12.64,-9.81) intersected the trapper hut
      const a=(i*53.7)*Math.PI/180,r=12+((i*31)%26);
      const radius=1+(i%3)*.5,x=Math.cos(a)*r,z=Math.sin(a)*r;
      const pile=new THREE.Mesh(new THREE.CircleGeometry(radius,18),assets.ground.snow);
      pile.name='snow-drift';pile.rotation.x=-Math.PI/2;pile.scale.set(1,.75,1);
      pile.position.set(x,terrainHeight(x,z)+.018,z);pile.receiveShadow=true;
      world.add(pile);
    }

    /* v1.14 cover pass: the east plain and the E–W centre lane were rifle-ranges.
       An ice arch blocks the centre view, a broken serac wall hides the north-east push,
       and two snow walls give the lake shore waist-high peek cover. */
    // Ice arch across the east lane (columns + lintel, walkable under, shootable over).
    // Kept clear of the KOTH capture point (0,0), the spawn gates, the frozen crate stack
    // at (11,-8) and the iceberg at (10,-4): the first cut welded the arch's slab into
    // that iceberg into one solid 4 m wall. Collision follows the visual opening (two pillar
    // discs, no lintel collider — the lintel underside sits at 3.7).
    // Moved to z -16: at -10.4 the pillars shaved the audit's rock at (6,-11) and the
    // trapper hut roof at (14,-12), and the lintel clipped the roof cone.
    {
      for(const sd of[-1,1]){
        const col=new THREE.Mesh(new THREE.CylinderGeometry(.7,.85,3.2,7),M.ice);
        col.name='ice-arch-pillar';
        col.position.set(10.5+sd*3,1.6,-17);
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='ice';
        world.add(col);shootStatics.push(col);
        colliders.push({minX:10.5+sd*3-.9,maxX:10.5+sd*3+.9,minZ:-17.8,maxZ:-16.2,top:3.2});
      }
      const lintel=new THREE.Mesh(new THREE.BoxGeometry(7.6,1,1.5),M.ice);
      lintel.name='ice-arch-lintel';lintel.userData.visualOnly=true;
      // y 3.7: the lintel rests exactly on the pillar tops (3.2) — the old y 3.6 centre
      // embedded it 0.1 m into both pillars.
      lintel.position.set(10.5,3.7,-17);lintel.castShadow=true;
      lintel.userData.surface='ice';
      world.add(lintel);shootStatics.push(lintel);
    }
    // Broken serac wall north-east (staggered blocks with a crouch gap).
    // Pushed out to the arena rim: the first cut sat at (10,-1.5)/(7.6,-3), inside the
    // KOTH candidate zone — the hill then lost its ≥7.5 clearance to the audit's ice ridge.
    // Positions verified against pickHill (clearance 7.95 at (2,-2)) and every nearby prop.
    addBox(world,shootStatics,colliders,{w:3.2,h:2.1,d:1,mat:M.ice,x:14.5,y:1.05,z:-8.5,ry:-.5,surface:'ice'});
    addBox(world,shootStatics,colliders,{w:2.2,h:1.7,d:1,mat:M.ice,x:10,y:.85,z:-12.5,ry:.25,surface:'ice'});
    // Lake-shore snow walls (waist-high peek cover, E–W lanes). Snow-block material:
    // the shared ground texture repeats at 36 m/tile and would smear on a 4 m box.
    // Kept ≥10 m off the centre so the KOTH hill keeps its clearance.
    if(!M.snowBlock)M.snowBlock=new THREE.MeshStandardMaterial({color:0xe8f0f8,roughness:.85,metalness:0});
    ownMats.push(M.snowBlock);
    addBox(world,shootStatics,colliders,{w:4,h:.9,d:1,mat:M.snowBlock,x:0,y:.45,z:11,ry:.12,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:4,h:.9,d:1,mat:M.snowBlock,x:-9,y:.45,z:-11,ry:-.2,surface:'concrete'});

    /* Distant icebergs. Nudge them inward/around any generic mound instead of letting two
       unrelated horizon solids interpenetrate. */
    for(const [x,z,s] of [[-52,-40,13],[48,-52,11],[-38,58,15],[58,42,12]]){
      let bx=x,bz=z,found=false;
      const baseR=Math.hypot(x,z),baseA=Math.atan2(z,x);
      placement:for(const dr of [0,-6,-12,6,12])for(const da of [0,.14,-.14,.28,-.28]){
        const r=Math.max(60,baseR+dr),a=baseA+da,px=Math.cos(a)*r,pz=Math.sin(a)*r;
        if(mounds.some(m=>Math.hypot(px-m.x,pz-m.z)<m.r+s*1.4+8))continue;
        bx=px;bz=pz;found=true;break placement;
      }
      if(!found)continue;
      const berg=new THREE.Mesh(new THREE.DodecahedronGeometry(1,0),M.ice);
      berg.name='distant-iceberg';berg.position.set(bx,2,bz);
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
    const westNorth=addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:-3,y:1.3,z:-13,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:-3,y:1.3,z:-6.9,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:-3,y:3.9,z:-6.9,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-3,y:1.3,z:-.2,ry:Math.PI/2,surface:'metal'});
    /* Canyon east wall (3-high tower north of the wide east crossing, single layers south of it) */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:charcoal,x:5,y:1.3,z:-12,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:5,y:3.9,z:-12,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:5,y:6.5,z:-12,ry:Math.PI/2,surface:'metal'});
    const eastMid=addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:5,y:1.3,z:1.8,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:5,y:1.3,z:8.5,ry:Math.PI/2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:5,y:3.9,z:8.5,ry:Math.PI/2,surface:'metal'});

    /* North stacking yard */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:rust,x:-12,y:1.3,z:-12,ry:.15,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-11.7,y:3.9,z:-11.8,ry:.2,surface:'metal'});
    const northLower=addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:seaBlue,x:10,y:1.3,z:-15,ry:-.1,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:charcoal,x:10.3,y:3.9,z:-14.7,ry:-.06,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:mustard,x:-16,y:1.3,z:-3,ry:1.35,surface:'metal'});

    /* South loading-dock platform (climbable, ~1.1 m) + yard crates */
    addBox(world,shootStatics,colliders,{w:10,h:1.1,d:3,mat:M.concrete,x:-2,y:.55,z:10.5,ry:.06,surface:'concrete'});
    const stack=(x,z,ry,n=2)=>{
      for(let i=0;i<n;i++)
        // 18 cm offset stays below the 20% / 0.4 m overhang limit and keeps >70% footprint
        // overlap; the old 90 cm stair offset left the upper crate mostly unsupported.
        addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x:x+(i?.18:0),y:.575+i*1.15,z,ry:ry+i*.13,surface:'wood'});
    };
    stack(8,8.5,.3,2);stack(10.2,9.4,-.2,1);
    stack(-8,6,.1,1);stack(13,-1,.4,2);

    /* Jersey barriers in the street and yards */
    for(const [x,z,ry] of [[1,-6,.4],[-6,1,-.2],[8,6.5,.1],[1,-13,-.3],[-11,3,.9]])
      addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x,y:.55,z,ry,surface:'concrete'});

    /* Neon signage (panel + emissive face, shootable). Wall-mounted panels are positioned
       in the container's local frame: rear face = corrugation peak + 3 cm, same yaw. */
    const sign=(mat,x,z,ry,{w=2.6,h=1.3,y=1.5,collide=true,name='neon-sign-back'}={})=>{
      const back=new THREE.Mesh(new THREE.BoxGeometry(w+.14,h+.14,.12),charcoal);
      back.name=name;back.position.set(x,y,z);back.rotation.y=ry;
      back.castShadow=true;back.userData.surface='metal';
      world.add(back);shootStatics.push(back);
      const face=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);
      face.name=name+'-face';face.position.set(x+Math.sin(ry)*.07,y,z+Math.cos(ry)*.07);
      face.rotation.y=ry;face.userData.surface='metal';face.userData.visualOnly=true;
      world.add(face);shootStatics.push(face);
      if(!collide)back.userData.visualOnly=true; // pole/wall-mounted panel: support owns collision
      if(collide){
        const cw=(w+.14)*.5,cd=.06,hx=Math.abs(Math.cos(ry))*cw+Math.abs(Math.sin(ry))*cd,hz=Math.abs(Math.sin(ry))*cw+Math.abs(Math.cos(ry))*cd;
        colliders.push({x,z,w:w+.14,d:.12,ry,minX:x-hx,maxX:x+hx,minZ:z-hz,maxZ:z+hz,bottom:y-h*.5-.07,top:y+h*.5+.07});
      }
      return back;
    };
    const mountSign=(mat,box,face,y,name)=>{
      const targetRy=box.rotation.y;
      // Panel local +z is always the artwork side; for a '-z' container face it must point
      // outward too, so the panel yaw is target yaw + π (this is what the old east sign got wrong).
      const panelRy=face==='+z'?targetRy:targetRy+Math.PI;
      const normal=new THREE.Vector3(0,0,face==='+z'?1:-1).applyAxisAngle(new THREE.Vector3(0,1,0),targetRy);
      const halfDepth=box.geometry.parameters.depth*.5;
      const centre=box.position.clone().addScaledVector(normal,halfDepth+.09); // 3 cm wave + 6 cm half plate
      const back=sign(mat,centre.x,centre.z,panelRy,{y,collide:false,name});
      back.userData.mount={type:'container-face',target:box,face,wave:.03,plate:.12,panelRy};
      back.userData.visualOnly=true; // container owns collision; panel remains in LOS
      return back;
    };
    mountSign(M.neonDock,westNorth,'+z',1.3,'mounted-sign-west');
    mountSign(M.neonCargo,eastMid,'-z',1.3,'mounted-sign-east');
    mountSign(M.neonDock,northLower,'+z',1.3,'mounted-sign-north');
    {
      const px=-6,pz=-16.5,ry=Math.atan2(6,16.5);
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.09,.12,4.4,8),M.metal);
      pole.name='neon-sign-pole';pole.position.set(px,2.2,pz);pole.castShadow=true;world.add(pole);
      colliders.push({minX:px-.14,maxX:px+.14,minZ:pz-.14,maxZ:pz+.14,bottom:0,top:4.4});
      sign(M.neonFerry,px+Math.sin(ry)*.1,pz+Math.cos(ry)*.1,ry,{y:3.6,collide:false}); // pole-mounted, walk under it
    }

    /* Floodlight masts */
    const mast=(x,z,flicker)=>{
      const pole=new THREE.Mesh(new THREE.CylinderGeometry(.14,.2,7.2,8),M.metal);
      pole.name='floodlight-pole';pole.position.set(x,3.6,z);pole.castShadow=true;
      pole.userData.surface='metal';
      world.add(pole);shootStatics.push(pole);
      const head=new THREE.Mesh(new THREE.BoxGeometry(1.6,.3,.5),M.metal);
      head.name='floodlight-head';head.userData.visualOnly=true;
      head.position.set(x,7.35,z);world.add(head); // bottom = pole top 7.2
      for(const sd of[-1,1]){
        const bulb=new THREE.Mesh(new THREE.SphereGeometry(.13,8,8),new THREE.MeshBasicMaterial({color:0xdcecff}));
        bulb.name='floodlight-bulb';bulb.userData.visualOnly=true;
        bulb.position.set(x+sd*.55,7.07,z+.1); // top = head bottom 7.2
        world.add(bulb);ownMats.push(bulb.material);
      }
      const light=new THREE.PointLight(0xbfd4ff,34,20,2);
      light.position.set(x,7.17,z);
      world.add(light);
      colliders.push({minX:x-.4,maxX:x+.4,minZ:z-.4,maxZ:z+.4,top:7.2});
      if(flicker)worldAnim.push(t=>{light.intensity=30+(Math.sin(t*13)>.86?-16:0)+Math.sin(t*2.1)*3;});
    };
    // East mast moved 20 cm west: its 0.8 m AABB overlapped the (13,-1) crate tier by
    // 15 cm even though the pole was 1.4 m from the crate centre.
    mast(-14,8,true);mast(11.8,-2,false);

    /* Gantry crane silhouette parked east of the yard */
    {
      const cx=28,cz=-16;
      const legGeo=new THREE.BoxGeometry(1.2,16,1.2);
      for(const [dx,dz] of [[-9,-3],[9,-3],[-9,3],[9,3]]){
        const leg=new THREE.Mesh(legGeo,M.metal);
        leg.name='gantry-leg';leg.position.set(cx+dx,8,cz+dz);leg.castShadow=true;
        world.add(leg);
        colliders.push({minX:cx+dx-.8,maxX:cx+dx+.8,minZ:cz+dz-.8,maxZ:cz+dz+.8,top:16});
      }
      // 7.2 m depth covers both leg rows (z -19.6..-12.4), so the beam actually lands on
      // all four legs instead of floating between two 2.4 m-wide rows.
      const beam=new THREE.Mesh(new THREE.BoxGeometry(26,1.6,7.2),M.metal);
      beam.name='gantry-beam';beam.userData.visualOnly=true;beam.position.set(cx,16.8,cz);beam.castShadow=true; // bottom = leg top 16
      world.add(beam);
      const trolley=new THREE.Mesh(new THREE.BoxGeometry(2,1.2,1.6),M.droneDark);
      trolley.name='gantry-trolley';trolley.userData.visualOnly=true;trolley.position.set(cx+4,15.4,cz);world.add(trolley); // top = beam bottom 16
    }

    /* Dark skyline with blinking rooftop beacons */
    {
      const facade=new THREE.MeshStandardMaterial({color:0x1a1f28,roughness:.9,metalness:.05});
      ownMats.push(facade);
      const spots=[[-58,26,16,15,22],[62,-34,20,13,26],[52,48,14,12,18],[-64,-52,18,11,24],[30,70,16,10,20],[-40,64,13,9,16],[70,10,15,12,23]];
      let bi=0;
      for(const [x,z,w,h,d] of spots){
        const bld=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),facade);
        bld.position.set(x,h/2-2,z);
        world.add(bld);
        if(bi%2===0){
          const bc=new THREE.Mesh(new THREE.SphereGeometry(.35,6,6),new THREE.MeshBasicMaterial({color:0xff3355}));
          bc.position.set(x,h-1.65,z); // roof top is h-2; beacon radius .35 rests on it
          world.add(bc);ownMats.push(bc.material);
          const phase=bi*1.3;
          worldAnim.push(t=>{bc.material.color.setHex(Math.sin(t*1.6+phase)>0?0xff3355:0x3a0e18);});
        }
        bi++;
      }
    }

    /* Reflective rain puddles. The playable ground is flat; use the same terrain source as the
       ground mesh so a future boundary change cannot leave puddles sunk or hovering. */
    {
      const puddleMat=new THREE.MeshStandardMaterial({color:0x0d1016,roughness:.14,metalness:.35});
      ownMats.push(puddleMat);
      for(const [x,z,r] of [[-1,-6,1.9],[4,-1,1.5],[-5,3,1.8],[5,10.5,2],[-6,-8,1.6],[8,-6,1.7],[0,14,1.8]]){
        const pd=new THREE.Mesh(new THREE.CircleGeometry(r,18),puddleMat);
        pd.name='rain-puddle';
        pd.rotation.x=-Math.PI/2;
        pd.position.set(x,terrainHeight(x,z)+.025,z);
        world.add(pd);
      }
    }

    /* v1.14 cover pass: the main street was a 26 m shooting gallery. A staggered crossing
       container splits the lane, the dock office gives the west yard a climbable vantage,
       and jersey twins slow the north push.
       Climb tiers are h=1.10: the discrete jump integration tops out at 1.11 m at 60 fps,
       a 1.15 crate is 4 cm out of reach on EVERY frame rate. */
    // Crossing barrier mid-street (slab wall: split the lane, jump-up peek platform).
    // Kept out of the street's jersey barriers (1,-6) / (1,-13) and the canyon walls.
    addBox(world,shootStatics,colliders,{w:2.44,h:2.2,d:3,mat:charcoal,x:1.2,y:1.1,z:-9.4,ry:.06,surface:'metal'});
    // Step box to climb the wall. Sits in the 1.27 m gap between the crossing wall and the
    // (5,-12) container stack, ry 0 so its corners clear both; at (2.8,-12.5) it clipped the
    // jersey at (1,-13), at (3.8,-12.4) it ran into the container.
    addBox(world,shootStatics,colliders,{w:1.15,h:1.1,d:1.15,mat:M.wood,x:3.14,y:.55,z:-11.5,surface:'wood',collide:true}); // step box to climb the wall
    // Dock office cabin in the west yard (climbable crate tier up to its roof); crate2
    // leans clear of the cabin AABB (same-height collider overlap reads as a seam)
    addBox(world,shootStatics,colliders,{w:3,h:2.2,d:2.4,mat:seaBlue,x:-17.5,y:1.1,z:9,ry:.2,surface:'metal'});
    // Both tiers shifted 20 cm south: they sat 9 cm / 4 cm inside the cabin's AABB.
    // The climb-to-roof gap stays <10 cm; the (-14,8) mast keeps a 11 cm clearance.
    addBox(world,shootStatics,colliders,{w:1.15,h:1.1,d:1.15,mat:M.wood,x:-15.2,y:.55,z:6.8,ry:-.2,surface:'wood'});
    addBox(world,shootStatics,colliders,{w:1.15,h:1.1,d:1.15,mat:M.wood,x:-15.2,y:1.65,z:6.8,ry:.1,surface:'wood',collide:true});
    // Jersey speed bumps at the street mouths: one at the north bend (off-centre, keeps a
    // ≥2 m lane), one at the south mouth — they slow pushes, never seal the street.
    // North one moved to (0.5,-15.9): at (-1.15,-14.8) it ran into the tilted neon-sign
    // backing plate at (-1.3,-13) and the west-wall box at (-3,-13).
    addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x:0.5,y:.55,z:-15.9,ry:.12,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:2.2,h:1.1,d:1.1,mat:M.concrete,x:1.6,y:.55,z:-2.2,ry:.25,surface:'concrete'});

    lamp(ctx,-10,13,.7);lamp(ctx,9,3,2.4);
  },

  /* Volcano Caldera — "lava river crossing": a molten river snakes down the west side of the crater floor,
     forded by two rock-slab bridges (the southern one under a basalt arch); basalt column fields hold the
     east side and gate pillars mark the northern approach */
  caldera(ctx){
    const {world,shootStatics,colliders,worldAnim,ownMats,M,assets,map}=ctx;
    const contMats=ctx.map.containers.map(k=>assets.containers[k]);

    /* Lava river: one continuous ribbon, not overlapping circles. Coplanar pool discs z-fought
       in their overlaps and the old noise-based Y positions sank parts below the flattened floor.
       Both the ribbon and its bank rocks now follow terrainHeight(), the ground's source of truth. */
    const river=[[-8,-18,3],[-9,-11,3.4],[-8,-3,3.2],[-10,4,3.2],[-8,11,3.4],[-4,15.5,3]];
    const riverCurve=new THREE.CatmullRomCurve3(river.map(([x,z])=>new THREE.Vector3(x,0,z)),false,'centripetal');
    const riverWidth=t=>{
      const f=Math.max(0,Math.min(river.length-1,t*(river.length-1)));
      const i=Math.min(river.length-2,Math.floor(f));
      return THREE.MathUtils.lerp(river[i][2],river[i+1][2],f-i);
    };
    const lavaMat=new THREE.MeshStandardMaterial({
      map:assets.tex.lavaPool,emissiveMap:assets.tex.lavaPool,
      emissive:0xffffff,emissiveIntensity:1.15,roughness:1,metalness:0});
    ownMats.push(lavaMat);
    const RIVER_SEG=84,rv=new Float32Array((RIVER_SEG+1)*2*3),ruv=new Float32Array((RIVER_SEG+1)*2*2),ri=[];
    for(let i=0;i<=RIVER_SEG;i++){
      const t=i/RIVER_SEG,p=riverCurve.getPoint(t),tan=riverCurve.getTangent(t).normalize();
      const nx=-tan.z,nz=tan.x,w=riverWidth(t);
      for(let side=0;side<2;side++){
        const s=side===0?1:-1,x=p.x+nx*w*s,z=p.z+nz*w*s,k=(i*2+side)*3;
        rv[k]=x;rv[k+1]=terrainHeight(x,z)+.025;rv[k+2]=z;
        ruv[(i*2+side)*2]=x*.12;ruv[(i*2+side)*2+1]=z*.12;
      }
      if(i<RIVER_SEG){const a=i*2;ri.push(a,a+2,a+1,a+1,a+2,a+3);}
    }
    const lavaGeo=new THREE.BufferGeometry();
    lavaGeo.setAttribute('position',new THREE.BufferAttribute(rv,3));
    lavaGeo.setAttribute('uv',new THREE.BufferAttribute(ruv,2));
    lavaGeo.setIndex(ri);lavaGeo.computeVertexNormals();
    const lava=new THREE.Mesh(lavaGeo,lavaMat);lava.name='lava-river';world.add(lava);
    for(let i=0;i<river.length;i+=2){
      const [px,pz]=river[i],l=new THREE.PointLight(0xff6a20,20,16,2);
      l.position.set(px,1.4,pz);world.add(l);
      worldAnim.push(t=>{l.intensity=17+Math.sin(t*2.2+px)*6;});
    }
    worldAnim.push(t=>{lavaMat.map.offset.set(t*.014%1,t*.009%1);});

    /* Bank rocks are spaced along the ribbon rather than packed as intersecting 2.6 m boxes.
       Leave real openings at both bridges, the arch pillars and the northern gate. */
    const north=riverCurve.getPoint(.2),northTan=riverCurve.getTangent(.2).normalize();
    const south=riverCurve.getPoint(.6),southTan=riverCurve.getTangent(.6).normalize();
    const northRy=Math.atan2(-northTan.z,northTan.x),southRy=Math.atan2(-southTan.z,southTan.x);
    // 8.5 m spans the local river width plus a safe landing on both banks.
    const bridges=[[north.x,north.z,northRy,8.5,2.8],[south.x,south.z,southRy,8.5,2.8]];
    const archPillars=[-1,1].map(sd=>({x:south.x+Math.sin(southRy)*3*sd,z:south.z+Math.cos(southRy)*3*sd}));
    const inBridge=(x,z,margin)=>bridges.some(([bx,bz,ry,w,d])=>{
      const dx=x-bx,dz=z-bz,co=Math.cos(ry),si=Math.sin(ry);
      return Math.abs(dx*co-dz*si)<w*.5+margin&&Math.abs(dx*si+dz*co)<d*.5+margin;
    });
    const bankCenters=[];
    for(let i=0;i<=RIVER_SEG;i+=4){
      const t=i/RIVER_SEG,p=riverCurve.getPoint(t),tan=riverCurve.getTangent(t).normalize();
      const nx=-tan.z,nz=tan.x,w=riverWidth(t),ry=Math.atan2(-tan.z,tan.x);
      for(const side of[-1,1]){
        const x=p.x+nx*(w+.62)*side,z=p.z+nz*(w+.62)*side;
        if(inBridge(x,z,1.15))continue;
        if(archPillars.some(p=>Math.hypot(x-p.x,z-p.z)<2.15))continue;
        if(Math.hypot(x+2,z+22)<2.1||Math.hypot(x-7,z+20)<2.1)continue;
        // Keep the northern supply container's AABB clear of the last river bend.
        if(Math.hypot(x+11,z-19)<4.6)continue;
        // Circumradius is .80 m; 1.95 m centre spacing also clears the AABBs of
        // differently-rotated neighbours (1.65 m left several 3–46 cm overlaps).
        if(bankCenters.some(p=>Math.hypot(x-p.x,z-p.z)<1.95))continue;
        bankCenters.push({x,z});
        addBox(world,shootStatics,colliders,{w:1.25,h:1,d:1,mat:M.column,x,y:.5,z,ry,surface:'concrete'});
      }
    }

    /* Rock-slab bridges follow the local river tangent and reach both banks. */
    for(const [bx,bz,ry,w,d] of bridges){
      const bridge=addBox(world,shootStatics,colliders,{w,h:.9,d,mat:M.column,x:bx,y:.45,z:bz,ry,surface:'concrete'});
      bridge.name='river-bridge';
    }

    /* Basalt arch follows the south bridge. Only the pillars block a grounded actor; the lintel
       is overhead geometry, not an invisible wall across the bridge. */
    {
      for(const {x,z} of archPillars){
        const col=new THREE.Mesh(new THREE.CylinderGeometry(.8,1,3.8,7),M.column);
        col.name='basalt-arch-pillar';col.position.set(x,1.9,z);
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='concrete';
        world.add(col);shootStatics.push(col);
        colliders.push({minX:x-1.05,maxX:x+1.05,minZ:z-1.05,maxZ:z+1.05,bottom:0,top:3.8});
      }
      const ry=southRy+Math.PI/2,lintel=new THREE.Mesh(new THREE.BoxGeometry(7.2,1,1.4),M.column);
      lintel.name='basalt-arch-lintel';lintel.position.set(south.x,4.3,south.z);lintel.rotation.y=ry;lintel.castShadow=true;
      lintel.userData.surface='concrete';
      world.add(lintel);shootStatics.push(lintel);
      const co=Math.abs(Math.cos(ry)),si=Math.abs(Math.sin(ry)),hw=co*3.6+si*.7,hz=si*3.6+co*.7;
      colliders.push({x:south.x,z:south.z,w:7.2,d:1.4,ry,minX:south.x-hw,maxX:south.x+hw,minZ:south.z-hz,maxZ:south.z+hz,bottom:3.8,top:4.8});
    }

    /* East basalt column fields (hex prisms). Each column owns a matching collider; the old
       cluster-sized AABB blocked the empty gaps and the crowded offsets made prisms intersect. */
    const colGeo=new THREE.CylinderGeometry(.85,1,1,6);
    const cluster=(cx,cz,list)=>{
      for(const [dx,dz,h] of list){
        const x=cx+dx,z=cz+dz,col=new THREE.Mesh(colGeo,M.column);
        col.name='basalt-column';col.scale.y=h;
        col.position.set(x,h/2,z);
        col.rotation.y=dx*1.7;
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='concrete';
        world.add(col);shootStatics.push(col);
        colliders.push({x,z,w:2,d:2,ry:col.rotation.y,minX:x-1,maxX:x+1,minZ:z-1,maxZ:z+1,bottom:0,top:h});
      }
    };
    // Offset columns widened from 1.8/1.9 m to 2.05/2.15 m: their 2×2 box colliders
    // overlapped the centre prism by 10–20 cm. The hex prisms themselves were clear.
    cluster(10,-8,[[0,0,4.2],[2,-.2,3.1],[-2.05,1.3,2.4],[.5,-2.5,3.6]]);
    cluster(15,2,[[0,0,3.4],[2,.5,2.3],[-2.15,-.7,2.9]]);
    cluster(8,10,[[0,0,4.5],[2,-.6,2.8],[-2.05,1,3.2]]);
    cluster(18,-3,[[0,0,2.6],[2,.8,1.9]]);

    /* Northern gate pillars */
    for(const [x,z] of [[-2,-22],[7,-20]]){
      const col=new THREE.Mesh(new THREE.CylinderGeometry(1,1.2,4.5,6),M.column);
      col.name='northern-gate-pillar';col.position.set(x,2.25,z);
      col.castShadow=col.receiveShadow=true;
      col.userData.surface='concrete';
      world.add(col);shootStatics.push(col);
      colliders.push({minX:x-1.2,maxX:x+1.2,minZ:z-1.2,maxZ:z+1.2,bottom:0,top:4.5});
    }

    /* Scorched supply cache south-east + crates (the ~1.1 m climbable tier) */
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[0],x:4,y:1.3,z:16,ry:.2,surface:'metal'});
    addBox(world,shootStatics,colliders,{w:6.1,h:2.6,d:2.44,mat:contMats[1],x:-11,y:1.3,z:19,ry:-.15,surface:'metal'});
    for(const [x,z,ry] of [[0,-7,.4],[12,-3,.1],[-14,-3,-.3],[11,14,.5]]){
      addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x,y:.575,z,ry,surface:'wood'});
    }

    /* Obsidian slabs. The (16,7) slab sat against the cluster(15,2) columns' rotated OBBs —
       moved to (16,8.5) and shrunk to 2.0 so its bounds clear the columns' z reach (3.69). */
    for(const [x,z,s,ry] of [[5,-13,2.2,.4],[16,8.5,2,-.3],[-18,7,2,.9],[2.5,21,2,-.6]]){
      const slab=new THREE.Mesh(new THREE.DodecahedronGeometry(1,0),M.obsidian);
      slab.name='obsidian-slab';slab.position.set(x,.6,z);
      slab.scale.set(s,s*.5,s*.7);
      slab.rotation.y=ry;slab.castShadow=slab.receiveShadow=true;
      slab.userData.surface='concrete';
      world.add(slab);shootStatics.push(slab);
      const bounds=new THREE.Box3().setFromObject(slab);
      colliders.push({minX:bounds.min.x,maxX:bounds.max.x,minZ:bounds.min.z,maxZ:bounds.max.z,bottom:0,top:bounds.max.y});
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
        cr.name='lava-fissure';cr.rotation.x=-Math.PI/2;cr.rotation.z=(i*1.7)%Math.PI;
        const x=Math.cos(a)*r,z=Math.sin(a)*r;
        cr.position.set(x,terrainHeight(x,z)+.03,z);
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

    /* Hollow volcano on the horizon. The old glowing disc sat inside a solid cone and read as a
       yellow shelf through its tip; a lathed crater keeps the glow on a real surface. */
    {
      const profile=[[0,-2],[26,-2],[24,2],[19,12],[12,22],[8.5,26],[7.6,25.7],[7.1,24.8],[6.2,24],[0,24]]
        .map(([r,y])=>new THREE.Vector2(r,y));
      const cone=new THREE.Mesh(new THREE.LatheGeometry(profile,24),M.column);
      cone.name='volcano-cone';cone.position.set(0,0,-88);world.add(cone);
      const glowMat=new THREE.MeshBasicMaterial({color:0xff5a18});
      const crater=new THREE.Mesh(new THREE.CircleGeometry(6.2,24),glowMat);
      crater.name='volcano-crater';crater.rotation.x=-Math.PI/2;crater.position.set(0,24.03,-88);world.add(crater);
      const rim=new THREE.Mesh(new THREE.TorusGeometry(7.6,.14,6,32),glowMat);
      rim.name='volcano-glow-rim';rim.rotation.x=Math.PI/2;rim.position.set(0,25.7,-88);world.add(rim);
      ownMats.push(glowMat);
      worldAnim.push(t=>{glowMat.color.setHSL(.05,1,.45+.12*Math.sin(t*1.3));});
    }

    /* v1.14 cover pass: the east fields were open ground between column clusters. A second
       basalt arch mid-east breaks the sight-line, a slab barrier walls the fissure field,
       and pillar twins guard the northern gate approach. */
    // Second basalt arch mid-east (mirrors the south one: two pillars + lintel).
    // Collision follows the VISUAL opening: two pillar discs; no lintel collider — its
    // underside (3.7) is far above head height, the old single slab filled the walk-through
    // gap with an invisible wall while LOS baked the pillars as an openable.
    {
      for(const sd of[-1,1]){
        const col=new THREE.Mesh(new THREE.CylinderGeometry(.8,1,3.8,7),M.column);
        col.name='mid-basalt-arch-pillar';
        col.position.set(11.5+sd*3.2,1.9,4);
        col.castShadow=col.receiveShadow=true;
        col.userData.surface='concrete';
        world.add(col);shootStatics.push(col);
        colliders.push({minX:11.5+sd*3.2-1,maxX:11.5+sd*3.2+1,minZ:3,maxZ:5,top:3.8});
      }
      const lintel=new THREE.Mesh(new THREE.BoxGeometry(8,1,1.7),M.column);
      lintel.name='mid-basalt-arch-lintel';lintel.userData.visualOnly=true;
      lintel.position.set(11.5,4.3,4);lintel.castShadow=true; // bottom = pillar top 3.8
      lintel.userData.surface='concrete';
      world.add(lintel);shootStatics.push(lintel);
    }
    // Slab barrier walling the fissure field (broken: two segments + a crouch gap),
    // placed clear of the arch pillars to the east
    addBox(world,shootStatics,colliders,{w:1.4,h:1.9,d:4.5,mat:M.column,x:6,y:.95,z:-1,ry:.1,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:1.4,h:1.5,d:2.2,mat:M.column,x:8,y:.75,z:1.4,ry:-.35,surface:'concrete'});
    // Northern gate-approach pillars (waist-high, shootable cover)
    addBox(world,shootStatics,colliders,{w:1.4,h:1.1,d:1.4,mat:M.column,x:-6,y:.55,z:-19,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:1.4,h:1.1,d:1.4,mat:M.column,x:12,y:.55,z:-17.5,ry:.3,surface:'concrete'});

    // Lamp moved to (12.5,-12.5): at (11,-11) the pole landed inside the basalt column at (10.5,-10.5).
    lamp(ctx,12.5,-12.5,.7);lamp(ctx,-13,14,2.4);
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
