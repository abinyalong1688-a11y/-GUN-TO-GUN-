// world.js — four maps: Desert Outpost / Snow Keep / Snow Town / Lava Ruins (parameterised worlds, swappable as a whole)
import * as THREE from 'three';

export const MAPS={
  desert:{
    name:'Desert Outpost · Sunset',
    sky:{top:[.10,.14,.30],mid:[.55,.34,.40],hor:[1.06,.68,.38],low:[.28,.20,.17],glow:[1.0,.86,.62],stars:0},
    sunDir:[-.82,.30,-.28],sunColor:0xffb36b,sunI:7.5,
    hemi:[0x51608f,0x8a5c38,1.35],fill:[0x6a7ab8,.5],
    fog:[0xcf9460,.0068],
    ground:'sand',rock:'rock',
    containers:['olive','rust'],
    amb:'dust',
  },
  snow:{
    name:'Snow Keep · Night',
    sky:{top:[.05,.07,.16],mid:[.16,.22,.36],hor:[.55,.66,.82],low:[.30,.34,.42],glow:[.9,.95,1.05],stars:1},
    sunDir:[.55,.42,.35],sunColor:0xbfd4ff,sunI:5.8,  // moonlight
    hemi:[0x7288b0,0x4a5868,1.4],fill:[0x8aa0c8,.45],
    fog:[0xaebfd4,.0082],
    ground:'snow',rock:'rock',
    containers:['arctic','charcoal'],
    amb:'snow',
  },
  snowtown:{
    name:'Snow Town · Daylight',
    // Brightness must match the bloom threshold (.82): hor/glow once sat near pure white and blew out the whole screen (the map looked "inverted")
    sky:{top:[.20,.30,.46],mid:[.42,.53,.67],hor:[.60,.66,.74],low:[.40,.45,.52],glow:[.92,.95,1.0],stars:0},
    sunDir:[.42,.58,.25],sunColor:0xf4f7ff,sunI:3.4,  // high-angle winter daylight
    hemi:[0xbcc9da,0x8b93a0,.95],fill:[0xd8e2ee,.3],
    fog:[0xa2b3c3,.0080],
    ground:'snow',rock:'rock',
    containers:['arctic','rust'],
    amb:'snow',classic:true,
  },
  ember:{
    name:'Lava Ruins · Ember',
    sky:{top:[.02,.015,.03],mid:[.10,.04,.04],hor:[.75,.22,.08],low:[.16,.07,.05],glow:[1.0,.5,.25],stars:1},
    sunDir:[.2,.5,.6],sunColor:0xff7a40,sunI:2.6,
    hemi:[0x3a2028,0x5a1c0c,1.0],fill:[0xff8a50,.35],
    fog:[0x2c1510,.0105],
    ground:'basalt',rock:'rockDark',
    containers:['emberTrim','charcoal'],
    amb:'ember',lava:true,
  },
};

function addBox(scene,shootStatics,colliders,{w,h,d,mat,x,y,z,ry=0,surface='concrete',collide=true,shadow=true}){
  const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);
  m.position.set(x,y,z);m.rotation.y=ry;
  m.castShadow=shadow;m.receiveShadow=true;
  m.userData.surface=surface;
  scene.add(m);shootStatics.push(m);
  if(collide){
    // Axis-aligned bounds of a rotated box: w projects onto X, d onto Z (the old code always put the long side on X, so lengthwise containers had colliders turned 90°)
    const c=Math.abs(Math.cos(ry)),s=Math.abs(Math.sin(ry));
    const hx=c*w*.5+s*d*.5,hz=s*w*.5+c*d*.5;
    colliders.push({minX:x-hx,maxX:x+hx,minZ:z-hz-.01,maxZ:z+hz+.01,top:y+h/2});
  }
  return m;
}

export function buildWorld(scene,assets,quality,mapKey='desert'){
  const map=MAPS[mapKey]||MAPS.desert;
  const world=new THREE.Group();
  scene.add(world);
  const colliders=[],shootStatics=[],worldAnim=[];
  const ownMats=[]; // materials created by this build (freed with the geometry on map switch; shared asset materials excluded)
  const M=assets.mats;

  /* ------- Sky (parameterised) ------- */
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
      uTime:{value:0},
    },
    vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`
      uniform vec3 sunDir,cTop,cMid,cHor,cLow,cGlow;uniform float uStars,uTime;varying vec3 vDir;
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
        float s2=max(dot(d,sunDir),0.0);
        c+=cGlow*(pow(s2,700.0)*4.0+pow(s2,48.0)*.7+pow(s2,7.0)*.3);
        gl_FragColor=vec4(c,1.0);
      }`
  });
  const sky=new THREE.Mesh(new THREE.SphereGeometry(480,32,20),skyMat);
  sky.renderOrder=-10;sky.frustumCulled=false;
  world.add(sky);
  ownMats.push(skyMat);
  worldAnim.push(t=>{skyMat.uniforms.uTime.value=t;});

  scene.fog=new THREE.FogExp2(...map.fog);

  /* ------- Lighting ------- */
  const sun=new THREE.DirectionalLight(map.sunColor,map.sunI);
  sun.position.copy(sunDir).multiplyScalar(120);
  sun.castShadow=true;
  sun.shadow.mapSize.set(quality==='high'?2048:1024,quality==='high'?2048:1024);
  const sc=sun.shadow.camera;
  sc.left=-70;sc.right=70;sc.top=70;sc.bottom=-70;sc.near=10;sc.far=260;
  sun.shadow.bias=-.0004;sun.shadow.normalBias=.03;
  world.add(sun,sun.target);
  world.add(new THREE.HemisphereLight(...map.hemi));
  const fill=new THREE.DirectionalLight(...map.fill);
  fill.position.set(60,40,80);
  world.add(fill);

  /* ------- Ground ------- */
  const groundGeo=new THREE.PlaneGeometry(360,360,110,110);
  groundGeo.rotateX(-Math.PI/2);
  {
    const p=groundGeo.attributes.position;
    const ns=(x,z)=>Math.sin(x*.045)*Math.cos(z*.038)+Math.sin(x*.11+z*.07)*.5;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i),z=p.getZ(i),r=Math.hypot(x,z);
      let h=ns(x,z)*.5;
      if(r>64)h+=Math.pow((r-64)/70,1.6)*(5+ns(x*.5+9,z*.5-4)*4.5);
      p.setY(i,h);
    }
    p.needsUpdate=true;
    groundGeo.computeVertexNormals();
  }
  const ground=new THREE.Mesh(groundGeo,assets.ground[map.ground]);
  ground.receiveShadow=true;ground.userData.surface=map.ground==='basalt'?'concrete':'sand';
  world.add(ground);shootStatics.push(ground);

  // Distant terrain mounds
  for(let i=0;i<7;i++){
    const a=i/7*Math.PI*2+.4,r=86+((i*53)%30);
    const mound=new THREE.Mesh(new THREE.SphereGeometry(20+(i%3)*9,16,12),assets.ground[map.ground]);
    mound.position.set(Math.cos(a)*r,-2,Math.sin(a)*r);
    mound.scale.y=.28;
    world.add(mound);
  }

  /* ------- Rocks ------- */
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

  /* ------- Outpost cover ------- */
  const contMats=map.containers.map(k=>assets.containers[k]);
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

  /* ------- Watchtower ------- */
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

  /* ------- Radar dish ------- */
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

  /* ------- Lamp posts ------- */
  function lamp(x,z,ry){
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(.06,.08,4.6,8),M.metal);
    pole.position.set(x,2.3,z);pole.castShadow=true;
    pole.userData.surface='metal';
    world.add(pole);shootStatics.push(pole);
    const head=new THREE.Mesh(new THREE.BoxGeometry(.5,.14,.3),M.metal);
    head.position.set(x+Math.sin(ry)*.3,4.6,z+Math.cos(ry)*.3);head.rotation.y=ry;
    world.add(head);
    const bulb=new THREE.Mesh(new THREE.SphereGeometry(.09,8,8),new THREE.MeshBasicMaterial({color:mapKey==='ember'?0xff8a40:0xffd9a0}));
    bulb.position.set(x+Math.sin(ry)*.5,4.5,z+Math.cos(ry)*.5);
    world.add(bulb);
    ownMats.push(bulb.material);
    const light=new THREE.PointLight(mapKey==='ember'?0xff6a30:0xffc890,26,16,2);
    light.position.copy(bulb.position);light.position.y-=.1;
    world.add(light);
  }
  lamp(-6,7,.7);lamp(8,-2,2.4);

  /* ------- Command tent ------- */
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

  /* ------- Classic snow-town set pieces (Snow Town only) ------- */
  if(map.classic){
    // Two-tier crate formations (stacked cover)
    const stack=(x,z,ry,n=2)=>{
      for(let i=0;i<n;i++)
        addBox(world,shootStatics,colliders,{w:1.15,h:1.15,d:1.15,mat:M.wood,x,y:.575+i*1.15,z,ry:ry+i*.13,surface:'wood',collide:i===0});
    };
    stack(-2.5,6.5,.2,2);stack(-1.2,7.4,-.35,1);
    stack(4.8,3.4,.5,2);stack(6.0,4.1,.1,1);
    stack(-12,2.5,.4,2);stack(-10.9,3.2,.05,1);
    stack(13.5,-4,.25,1);
    // Long street walls
    addBox(world,shootStatics,colliders,{w:9,h:2.6,d:.5,mat:M.concrete,x:-14,y:1.3,z:-2,ry:.28,surface:'concrete'});
    addBox(world,shootStatics,colliders,{w:7,h:2.6,d:.5,mat:M.concrete,x:14,y:1.3,z:-6,ry:-.4,surface:'concrete'});
    // Snow piles
    for(let i=0;i<10;i++){
      const a=(i*53.7)*Math.PI/180,r=12+((i*31)%26);
      const pile=new THREE.Mesh(new THREE.SphereGeometry(1+(i%3)*.5,10,8),assets.ground.snow);
      pile.position.set(Math.cos(a)*r,.1,Math.sin(a)*r);
      pile.scale.y=.42;pile.receiveShadow=true;
      world.add(pile);
    }
    // Distant cooling-tower silhouettes
    const tower=new THREE.Mesh(new THREE.CylinderGeometry(6.5,9.5,34,20,1,true),
      new THREE.MeshStandardMaterial({color:0xaab2b8,roughness:.95,side:THREE.DoubleSide}));
    tower.position.set(-55,16,-55);
    world.add(tower);
    ownMats.push(tower.material);
  }

  /* ------- Lava fissures (Ember map only) ------- */
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
      if(i%3===0){
        const l=new THREE.PointLight(0xff6a20,14,10,2);
        l.position.set(cr.position.x,1,cr.position.z);
        world.add(l);
        worldAnim.push(t=>{l.intensity=12+Math.sin(t*2.4+i)*5;});
      }
    }
  }

  /* ------- Ambient particles ------- */
  const ambN=quality==='high'?160:80;
  const ambGeo=new THREE.BufferGeometry();
  const apos=new Float32Array(ambN*3),avel=new Float32Array(ambN);
  for(let i=0;i<ambN;i++){
    const a=Math.random()*Math.PI*2,r=4+Math.random()*56;
    apos[i*3]=Math.cos(a)*r;
    apos[i*3+1]=map.amb==='ember'?.2+Math.random()*6:.3+Math.random()*5;
    apos[i*3+2]=Math.sin(a)*r;
    avel[i]=.4+Math.random()*.8;
  }
  ambGeo.setAttribute('position',new THREE.BufferAttribute(apos,3));
  const ambColor=map.amb==='snow'?0xf0f6ff:map.amb==='ember'?0xff9a50:0xffd9a8;
  const ambSize=map.amb==='snow'?.09:map.amb==='ember'?.06:.055;
  const ambPts=new THREE.Points(ambGeo,new THREE.PointsMaterial({
    color:ambColor,size:ambSize,transparent:true,opacity:map.amb==='ember'?.85:.55,
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
      else{x+=.9*.016*(1+Math.sin(t*.5+i)*.4);}
      if(map.amb==='snow'&&y<0){y=6+Math.random()*2;}
      if(map.amb==='ember'&&y>7){y=.1;}
      if(x>62)x=-62;if(x<-62)x=62;
      if(z>62)z=-62;if(z<-62)z=62;
      p.setXYZ(i,x,y,z);
    }
    p.needsUpdate=true;
  });

  /* ------- Spawn points ------- */
  const spawnPoints=[
    new THREE.Vector3(0,0,-46),
    new THREE.Vector3(46,0,0),
    new THREE.Vector3(0,0,46),
    new THREE.Vector3(-46,0,4),
  ];

  // Ray list for line-of-sight / projectiles: drops the 24k-triangle ground mesh (the ray origin is always inside its bounds, so nothing early-outs and every triangle is tested each frame)
  const losStatics=shootStatics.filter(o=>o!==ground);
  return {group:world,colliders,shootStatics,losStatics,spawnPoints,sunDir,mapKey,map,worldAnim,ownMats};
}

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
