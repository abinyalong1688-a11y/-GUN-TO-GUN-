// assets.js —— 程序化贴图与共享材质(全部 Canvas 生成,零外部资源)
import * as THREE from 'three';
import {isEN} from './i18n.js';

/* ---------- 工具 ---------- */
function makeRng(seed){let s=seed>>>0;return()=>{s=(s*1664525+1013904223)>>>0;return s/4294967296;};}

function valueNoise(seed){
  const rng=makeRng(seed),G=64,grid=new Float32Array(G*G);
  for(let i=0;i<G*G;i++)grid[i]=rng();
  return (x,y)=>{
    const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const sm=a=>a*a*(3-2*a);
    const x0=((xi%G)+G)%G,x1=(x0+1)%G,y0=((yi%G)+G)%G,y1=(y0+1)%G;
    const u=sm(xf),v=sm(yf);
    const a=grid[y0*G+x0],b=grid[y0*G+x1],c=grid[y1*G+x0],d=grid[y1*G+x1];
    return a*(1-u)*(1-v)+b*u*(1-v)+c*(1-u)*v+d*u*v;
  };
}

function canvasTex(size,draw,{repeat=1,srgb=true}={}){
  const c=document.createElement('canvas');c.width=c.height=size;
  const g=c.getContext('2d');draw(g,size);
  const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(repeat,repeat);
  t.anisotropy=8;if(srgb)t.colorSpace=THREE.SRGBColorSpace;
  return t;
}

// 由高度图生成法线贴图(Sobel)
function heightToNormal(heightCanvas,strength=1){
  const w=heightCanvas.width,h=heightCanvas.height;
  const src=heightCanvas.getContext('2d').getImageData(0,0,w,h).data;
  const out=document.createElement('canvas');out.width=w;out.height=h;
  const g=out.getContext('2d'),img=g.createImageData(w,h),d=img.data;
  const H=(x,y)=>src[(((y+h)%h)*w+((x+w)%w))*4]/255;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const dx=(H(x+1,y)-H(x-1,y))*strength,dy=(H(x,y+1)-H(x,y-1))*strength;
    const n=new THREE.Vector3(-dx,-dy,1).normalize();
    const i=(y*w+x)*4;
    d[i]=(n.x*.5+.5)*255;d[i+1]=(n.y*.5+.5)*255;d[i+2]=(n.z*.5+.5)*255;d[i+3]=255;
  }
  g.putImageData(img,0,0);
  const t=new THREE.CanvasTexture(out);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;
  return t;
}

/* ---------- 地表高度/贴图生成器(每张地图一套) ---------- */
const noiseSand=valueNoise(101),noiseConcrete=valueNoise(202),noiseMetal=valueNoise(303),noiseSnow=valueNoise(404),noiseBasalt=valueNoise(505);

function drawSand(g,S){
  g.fillStyle='#c69a62';g.fillRect(0,0,S,S);
  for(let i=0;i<520;i++){ // 大块色斑
    const v=noiseSand(i*3.7,i*1.3),r=8+Math.random()*60;
    g.fillStyle=`rgba(${v>.5?214:158},${v>.5?152:110},${v>.5?98:64},${.05+Math.random()*.08})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,r,0,7);g.fill();
  }
  g.strokeStyle='rgba(140,100,60,.11)';g.lineWidth=1.3; // 风纹
  for(let i=0;i<70;i++){
    const y=Math.random()*S;g.beginPath();
    for(let x=0;x<=S;x+=6)g.lineTo(x,y+Math.sin(x*.05+i)*4+Math.random()*2);
    g.stroke();
  }
  for(let i=0;i<1600;i++){ // 细砂粒
    const l=Math.random();
    g.fillStyle=l>.6?'rgba(60,42,28,.3)':'rgba(238,208,164,.28)';
    g.fillRect(Math.random()*S,Math.random()*S,1.3,1.3);
  }
}

function drawSnow(g,S){
  g.fillStyle='#dfe8f2';g.fillRect(0,0,S,S);
  for(let i=0;i<420;i++){
    const v=noiseSnow(i*2.1,i*3.3),r=10+Math.random()*70;
    g.fillStyle=v>.55?'rgba(255,255,255,.5)':'rgba(160,180,205,.13)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,r,0,7);g.fill();
  }
  g.strokeStyle='rgba(140,165,195,.18)';g.lineWidth=1.6; // 吹雪垄
  for(let i=0;i<40;i++){
    const y=Math.random()*S;g.beginPath();
    for(let x=0;x<=S;x+=7)g.lineTo(x,y+Math.sin(x*.045+i*2)*6);
    g.stroke();
  }
  for(let i=0;i<700;i++){
    g.fillStyle=Math.random()>.5?'rgba(255,255,255,.6)':'rgba(150,172,200,.2)';
    g.fillRect(Math.random()*S,Math.random()*S,1.6,1.6);
  }
  // 融雪露底
  for(let i=0;i<50;i++){
    g.fillStyle='rgba(110,120,110,.14)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,3+Math.random()*14,0,7);g.fill();
  }
}

function drawBasalt(g,S){
  g.fillStyle='#3a3536';g.fillRect(0,0,S,S);
  for(let i=0;i<500;i++){
    const v=noiseBasalt(i*1.7,i*2.9);
    g.fillStyle=v>.5?'rgba(90,84,86,.25)':'rgba(16,14,15,.3)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,6+Math.random()*36,0,7);g.fill();
  }
  // 熔岩裂纹
  for(let i=0;i<16;i++){
    let x=Math.random()*S,y=Math.random()*S;
    g.strokeStyle=`rgba(${220+Math.random()*35},${90+Math.random()*60},30,.75)`;g.lineWidth=1.6+Math.random()*2;
    g.shadowColor='rgba(255,120,30,.9)';g.shadowBlur=8;
    g.beginPath();g.moveTo(x,y);
    for(let k=0;k<8;k++){x+=(Math.random()-.5)*60;y+=(Math.random()-.5)*60;g.lineTo(x,y);}
    g.stroke();g.shadowBlur=0;
  }
  // 火渣点
  for(let i=0;i<500;i++){
    g.fillStyle=Math.random()>.7?'rgba(255,140,40,.5)':'rgba(10,8,9,.4)';
    g.fillRect(Math.random()*S,Math.random()*S,1.4,1.4);
  }
}

function drawConcrete(g,S){
  g.fillStyle='#8e8a82';g.fillRect(0,0,S,S);
  for(let i=0;i<700;i++){
    const v=noiseConcrete(i*1.1,i*2.3);
    g.fillStyle=`rgba(${v>.5?255:60},${v>.5?255:58},${v>.5?250:54},${.035+Math.random()*.05})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,2+Math.random()*26,0,7);g.fill();
  }
  g.strokeStyle='rgba(40,38,34,.32)';g.lineWidth=1; // 细裂缝
  for(let i=0;i<9;i++){
    let x=Math.random()*S,y=Math.random()*S;g.beginPath();g.moveTo(x,y);
    for(let k=0;k<10;k++){x+=(Math.random()-.5)*30;y+=Math.random()*14;g.lineTo(x,y);}
    g.stroke();
  }
  // 板缝
  g.strokeStyle='rgba(30,28,26,.4)';g.lineWidth=2.5;
  for(let i=1;i<4;i++){g.beginPath();g.moveTo(0,i*S/4);g.lineTo(S,i*S/4);g.stroke();}
  const gr=g.createLinearGradient(0,S,0,S*.6);
  gr.addColorStop(0,'rgba(50,45,38,.3)');gr.addColorStop(1,'rgba(50,45,38,0)');
  g.fillStyle=gr;g.fillRect(0,S*.6,S,S*.4);
}

function drawMetal(g,S){
  g.fillStyle='#565a60';g.fillRect(0,0,S,S);
  for(let y=0;y<S;y++){
    const v=noiseMetal(y*.9,3.3);
    g.fillStyle=`rgba(${v>.5?230:30},${v>.5?230:32},${v>.5?235:36},.045)`;
    g.fillRect(0,y,S,1);
  }
  // 面板拼缝 + 铆钉
  g.strokeStyle='rgba(20,22,26,.55)';g.lineWidth=2;
  for(let i=1;i<3;i++){g.beginPath();g.moveTo(0,i*S/3);g.lineTo(S,i*S/3);g.stroke();}
  g.fillStyle='rgba(30,32,36,.6)';
  for(let x=10;x<S;x+=28)for(let i=0;i<3;i++)g.fillRect(x,10+i*S/3,2.5,2.5);
  g.strokeStyle='rgba(25,26,30,.5)';
  for(let i=0;i<30;i++){
    const y=Math.random()*S;g.beginPath();g.moveTo(Math.random()*S,y);g.lineTo(Math.random()*S,y+(Math.random()-.5)*6);g.stroke();
  }
  for(let i=0;i<90;i++){
    g.fillStyle=`rgba(140,70,40,${.05+Math.random()*.13})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,1+Math.random()*8,0,7);g.fill();
  }
}

function drawContainer(color,dark,opts={}){
  return (g,S)=>{
    g.fillStyle=color;g.fillRect(0,0,S,S);
    const rib=S/16;
    for(let x=0;x<S;x+=rib){
      const lg=g.createLinearGradient(x,0,x+rib,0);
      lg.addColorStop(0,dark);lg.addColorStop(.4,'rgba(255,255,255,.10)');
      lg.addColorStop(.6,color);lg.addColorStop(1,dark);
      g.fillStyle=lg;g.fillRect(x,0,rib,S);
    }
    // 顶部积雪盖
    if(opts.snowCap){
      const gr=g.createLinearGradient(0,S*.5,0,S);
      gr.addColorStop(0,'rgba(235,242,250,0)');gr.addColorStop(.5,'rgba(235,242,250,.75)');gr.addColorStop(1,'rgba(225,235,246,.95)');
      g.fillStyle=gr;g.fillRect(0,S*.5,S,S*.5);
    }
    for(let i=0;i<220;i++){
      g.fillStyle=`rgba(90,50,28,${.05+Math.random()*.12})`;
      g.beginPath();g.arc(Math.random()*S,Math.random()*S,1+Math.random()*9,0,7);g.fill();
    }
    const gr2=g.createLinearGradient(0,S*.72,0,S);
    gr2.addColorStop(0,'rgba(45,30,20,0)');gr2.addColorStop(1,'rgba(45,30,20,.42)');
    g.fillStyle=gr2;g.fillRect(0,S*.72,S,S*.28);
    g.strokeStyle='rgba(20,16,12,.6)';g.lineWidth=3;g.strokeRect(1.5,1.5,S-3,S-3);
  };
}

function drawHesco(g,S){
  g.fillStyle='#a89270';g.fillRect(0,0,S,S);
  for(let i=0;i<700;i++){
    const v=Math.random();
    g.fillStyle=v>.5?'rgba(60,48,30,.14)':'rgba(230,210,170,.1)';
    g.fillRect(Math.random()*S,Math.random()*S,2+Math.random()*6,1+Math.random()*3);
  }
  g.strokeStyle='rgba(70,56,36,.5)';g.lineWidth=2;
  for(let y=S/4;y<S;y+=S/4){g.beginPath();g.moveTo(0,y);g.lineTo(S,y);g.stroke();}
  g.strokeStyle='rgba(60,48,32,.8)';g.lineWidth=5;g.strokeRect(2.5,2.5,S-5,S-5);
}

function drawWood(g,S){
  g.fillStyle='#8a6a44';g.fillRect(0,0,S,S);
  for(let y=0;y<S;y+=S/6){
    const v=Math.random()*.12;
    g.fillStyle=`rgba(${v>.06?255:60},${v>.06?230:44},${v>.06?190:30},.22)`;
    g.fillRect(0,y,S,S/6);
    g.strokeStyle='rgba(50,34,18,.7)';g.lineWidth=2;
    g.strokeRect(1,y+1,S-2,S/6-2);
  }
  g.strokeStyle='rgba(60,42,22,.5)';
  for(let i=0;i<50;i++){
    const y=Math.random()*S;g.beginPath();g.moveTo(0,y);g.bezierCurveTo(S*.3,y+3,S*.6,y-3,S,y);g.stroke();
  }
}

function drawGunMetal(g,S){
  g.fillStyle='#1e2126';g.fillRect(0,0,S,S);
  // 横向拉丝
  for(let i=0;i<160;i++){
    const y=Math.random()*S,x=Math.random()*S,len=S*(.2+Math.random()*.8);
    g.strokeStyle=Math.random()>.5?'rgba(255,255,255,.045)':'rgba(0,0,0,.06)';
    g.lineWidth=.8+Math.random();
    g.beginPath();g.moveTo(x,y);g.lineTo(x+len,y+(Math.random()-.5)*2);g.stroke();
  }
  // 面板缝(暗缝+高光棱边)
  g.strokeStyle='rgba(8,9,11,.75)';g.lineWidth=2;
  g.beginPath();g.moveTo(0,S*.33);g.lineTo(S,S*.33);g.moveTo(0,S*.72);g.lineTo(S,S*.72);g.stroke();
  g.strokeStyle='rgba(255,255,255,.06)';g.lineWidth=1;
  g.beginPath();g.moveTo(0,S*.33+2);g.lineTo(S,S*.33+2);g.moveTo(0,S*.72+2);g.lineTo(S,S*.72+2);g.stroke();
  // 螺丝
  for(let i=0;i<10;i++){
    const x=8+Math.random()*(S-16),y=8+Math.random()*(S-16);
    g.fillStyle='rgba(0,0,0,.55)';g.beginPath();g.arc(x,y,2.4,0,7);g.fill();
    g.fillStyle='rgba(200,210,220,.35)';g.beginPath();g.arc(x-.6,y-.6,1.1,0,7);g.fill();
  }
  // 磨损亮斑
  for(let i=0;i<40;i++){
    g.fillStyle=`rgba(160,168,178,${.04+Math.random()*.07})`;
    g.fillRect(Math.random()*S,Math.random()*S,2+Math.random()*8,1+Math.random()*2);
  }
  // 油渍
  for(let i=0;i<26;i++){
    g.fillStyle='rgba(10,10,12,.12)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,2+Math.random()*7,0,7);g.fill();
  }
}

function drawPolymer(g,S,base){
  g.fillStyle=base;g.fillRect(0,0,S,S);
  // 颗粒防滑纹
  for(let i=0;i<2400;i++){
    g.fillStyle=Math.random()>.5?`rgba(255,255,255,${.02+Math.random()*.04})`:`rgba(0,0,0,${.03+Math.random()*.05})`;
    g.fillRect(Math.random()*S,Math.random()*S,1.2,1.2);
  }
  // 注塑合模线
  g.strokeStyle='rgba(0,0,0,.28)';g.lineWidth=2;
  g.beginPath();g.moveTo(0,S*.5);g.lineTo(S,S*.5);g.stroke();
  // 导轨横条
  g.fillStyle='rgba(0,0,0,.2)';
  for(let y=S*.08;y<S*.92;y+=S*.09)g.fillRect(0,y,S,2);
  // 使用磨损
  for(let i=0;i<30;i++){
    g.fillStyle=`rgba(230,225,210,${.03+Math.random()*.05})`;
    g.fillRect(Math.random()*S,Math.random()*S,3+Math.random()*10,1+Math.random()*1.5);
  }
}

function drawGoldTrim(g,S){
  g.fillStyle='#d8a850';g.fillRect(0,0,S,S);
  // 金面流动条纹
  for(let i=0;i<60;i++){
    const y=Math.random()*S;
    g.strokeStyle=`rgba(${Math.random()>.5?255:150},${Math.random()>.5?220:110},70,${.08+Math.random()*.1})`;
    g.lineWidth=1+Math.random()*2;
    g.beginPath();g.moveTo(0,y);
    for(let x=0;x<=S;x+=8)g.lineTo(x,y+Math.sin(x*.06+i)*2);
    g.stroke();
  }
  // 划痕
  for(let i=0;i<18;i++){
    g.strokeStyle='rgba(120,80,20,.35)';g.lineWidth=1;
    g.beginPath();g.moveTo(Math.random()*S,Math.random()*S);g.lineTo(Math.random()*S,Math.random()*S);g.stroke();
  }
}

function drawEnergyCells(g,S,rgb){
  g.fillStyle='#0b0e13';g.fillRect(0,0,S,S);
  const cell=S/6;
  for(let y=0;y<6;y++)for(let x=0;x<6;x++){
    const a=.55+Math.random()*.45;
    g.fillStyle=`rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    g.fillRect(x*cell+cell*.18,y*cell+cell*.18,cell*.64,cell*.64);
    g.fillStyle='rgba(0,0,0,.45)';
    g.fillRect(x*cell+cell*.3,y*cell+cell*.3,cell*.4,cell*.4);
  }
}

function drawBulletHole(g,S){
  g.clearRect(0,0,S,S);
  const cx=S/2,cy=S/2;
  let gr=g.createRadialGradient(cx,cy,S*.08,cx,cy,S*.48);
  gr.addColorStop(0,'rgba(30,24,18,.55)');gr.addColorStop(1,'rgba(30,24,18,0)');
  g.fillStyle=gr;g.beginPath();g.arc(cx,cy,S*.48,0,7);g.fill();
  gr=g.createRadialGradient(cx,cy,0,cx,cy,S*.2);
  gr.addColorStop(0,'rgba(8,6,5,.95)');gr.addColorStop(.7,'rgba(20,16,12,.8)');gr.addColorStop(1,'rgba(20,16,12,0)');
  g.fillStyle=gr;g.beginPath();g.arc(cx,cy,S*.2,0,7);g.fill();
  g.strokeStyle='rgba(15,12,10,.7)';g.lineWidth=1.2;
  for(let i=0;i<7;i++){
    const a=Math.random()*Math.PI*2,l=S*(.12+Math.random()*.16);
    g.beginPath();g.moveTo(cx,cy);g.lineTo(cx+Math.cos(a)*l,cy+Math.sin(a)*l);g.stroke();
  }
}

function drawMuzzle(g,S){
  g.clearRect(0,0,S,S);
  const cx=S/2;
  let gr=g.createRadialGradient(cx,cx,0,cx,cx,S*.5);
  gr.addColorStop(0,'rgba(255,250,230,1)');gr.addColorStop(.25,'rgba(255,190,90,.9)');
  gr.addColorStop(.6,'rgba(255,120,40,.35)');gr.addColorStop(1,'rgba(255,80,20,0)');
  g.fillStyle=gr;g.beginPath();
  for(let i=0;i<10;i++){
    const a=i/10*Math.PI*2,r=i%2?S*.5:S*.22;
    g.lineTo(cx+Math.cos(a)*r,cx+Math.sin(a)*r);
  }
  g.closePath();g.fill();
}

function drawSoft(g,S,inner,mid){
  g.clearRect(0,0,S,S);
  const gr=g.createRadialGradient(S/2,S/2,0,S/2,S/2,S/2);
  gr.addColorStop(0,inner);gr.addColorStop(.5,mid);gr.addColorStop(1,'rgba(0,0,0,0)');
  g.fillStyle=gr;g.beginPath();g.arc(S/2,S/2,S/2,0,7);g.fill();
}

function drawRingTex(g,S){
  g.clearRect(0,0,S,S);
  const gr=g.createRadialGradient(S/2,S/2,S*.22,S/2,S/2,S*.5);
  gr.addColorStop(0,'rgba(255,200,120,0)');gr.addColorStop(.55,'rgba(255,200,120,.9)');gr.addColorStop(1,'rgba(255,150,70,0)');
  g.fillStyle=gr;g.beginPath();g.arc(S/2,S/2,S/2,0,7);g.fill();
}

function drawNameTag(g,S){
  g.clearRect(0,0,S,S);
}

/* ---------- 输出 ---------- */
export const A={};
export function initAssets(){
  // --- 三种地表(1024 高清 + 法线) ---
  function groundMat(draw,normStrength,repeat){
    const c=document.createElement('canvas');c.width=c.height=1024;
    draw(c.getContext('2d'),1024);
    const map=new THREE.CanvasTexture(c);
    map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(repeat,repeat);
    map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;
    const normal=heightToNormal(c,normStrength);normal.repeat.set(repeat,repeat);
    return new THREE.MeshStandardMaterial({map,normalMap:normal,normalScale:new THREE.Vector2(.65,.65),roughness:.96,metalness:.02});
  }
  A.ground={
    sand:groundMat(drawSand,2.0,10),
    snow:groundMat(drawSnow,1.2,10),
    basalt:groundMat(drawBasalt,2.6,10),
  };

  const energyTexBlue=canvasTex(128,(g,S)=>drawEnergyCells(g,S,[64,196,255]));
  const energyTexPurple=canvasTex(128,(g,S)=>drawEnergyCells(g,S,[186,112,255]));

  const M={
    concrete:new THREE.MeshStandardMaterial({map:canvasTex(512,drawConcrete,{repeat:2}),roughness:.92,metalness:.02}),
    metal:new THREE.MeshStandardMaterial({map:canvasTex(512,drawMetal,{repeat:1}),roughness:.42,metalness:.78}),
    hesco:new THREE.MeshStandardMaterial({map:canvasTex(512,drawHesco,{repeat:1}),roughness:.95,metalness:0}),
    wood:new THREE.MeshStandardMaterial({map:canvasTex(256,drawWood,{repeat:1}),roughness:.9,metalness:0}),
    rock:new THREE.MeshStandardMaterial({color:0x7a6a58,roughness:1,metalness:0,flatShading:true}),
    rockDark:new THREE.MeshStandardMaterial({color:0x453f41,roughness:1,metalness:0,flatShading:true}),
    // 枪械表面:程序化金属/聚合物贴图(拉丝·面板缝·螺丝·磨损·防滑纹)
    gunDark:new THREE.MeshStandardMaterial({map:canvasTex(256,drawGunMetal),roughness:.42,metalness:.7}),
    gunPoly:new THREE.MeshStandardMaterial({map:canvasTex(256,(g,S)=>drawPolymer(g,S,'#2c2f34')),roughness:.72,metalness:.12}),
    gunFDE:new THREE.MeshStandardMaterial({map:canvasTex(256,(g,S)=>drawPolymer(g,S,'#6e5a42')),roughness:.75,metalness:.08}),
    gunBrass:new THREE.MeshStandardMaterial({color:0xc8a050,roughness:.35,metalness:.9,emissive:0x664410,emissiveIntensity:.25}),
    // 夸张武器:能量部件用发光栅格贴图(map 与 emissiveMap 同源,暗底不发光)
    energyBlue:new THREE.MeshStandardMaterial({map:energyTexBlue,emissiveMap:energyTexBlue,emissive:0xffffff,emissiveIntensity:1.0,roughness:.4,metalness:.6}),
    energyPurple:new THREE.MeshStandardMaterial({map:energyTexPurple,emissiveMap:energyTexPurple,emissive:0xffffff,emissiveIntensity:.85,roughness:.4,metalness:.6}),
    goldTrim:new THREE.MeshStandardMaterial({map:canvasTex(256,drawGoldTrim),roughness:.3,metalness:.95,emissive:0x9a6a18,emissiveIntensity:.3}),
    // 英雄
    queenArmor:new THREE.MeshStandardMaterial({color:0x8a2626,roughness:.5,metalness:.55}),
    queenGold:new THREE.MeshStandardMaterial({color:0xe0b25a,roughness:.3,metalness:.9}),
    skin:new THREE.MeshStandardMaterial({color:0xe8b898,roughness:.85,metalness:0}),
    hairBlack:new THREE.MeshStandardMaterial({color:0x181414,roughness:.9,metalness:0}),
    suitDark:new THREE.MeshStandardMaterial({color:0x232830,roughness:.7,metalness:.15}),
    vestGray:new THREE.MeshStandardMaterial({color:0x3a4250,roughness:.75,metalness:.2}),
    shades:new THREE.MeshStandardMaterial({color:0x0c0e12,roughness:.2,metalness:.8}),
    // CS 阵营角色
    ctFatigue:new THREE.MeshStandardMaterial({color:0x46536b,roughness:.78,metalness:.1}),
    ctArmor:new THREE.MeshStandardMaterial({color:0x2b3140,roughness:.72,metalness:.25}),
    ctHelmet:new THREE.MeshStandardMaterial({color:0x454f61,roughness:.6,metalness:.3}),
    tJacket:new THREE.MeshStandardMaterial({color:0x7e2620,roughness:.8,metalness:.05}),
    tPants:new THREE.MeshStandardMaterial({color:0x2f2c2c,roughness:.82,metalness:.05}),
    tRig:new THREE.MeshStandardMaterial({color:0x1e1c1c,roughness:.8,metalness:.15}),
    balaclava:new THREE.MeshStandardMaterial({color:0x17171c,roughness:.85,metalness:0}),
    beanie:new THREE.MeshStandardMaterial({color:0x565a60,roughness:.9,metalness:0}),
    // 3D 真人风角色:肤色 / 发色 / 五官 / 靴具
    skinF:new THREE.MeshStandardMaterial({color:0xf3d0b8,roughness:.45,metalness:0}),
    skinM:new THREE.MeshStandardMaterial({color:0xdfab8c,roughness:.55,metalness:0}),
    skinN:new THREE.MeshStandardMaterial({color:0xd8a687,roughness:.55,metalness:0}),
    sclera:new THREE.MeshStandardMaterial({color:0xf6f3f0,roughness:.25}),
    iris:new THREE.MeshStandardMaterial({color:0x33241c,roughness:.3}),
    brow:new THREE.MeshStandardMaterial({color:0x2a1a12,roughness:.8}),
    hairF:new THREE.MeshStandardMaterial({color:0x3a2418,roughness:.82}),
    hairM:new THREE.MeshStandardMaterial({color:0x1a130e,roughness:.85}),
    lipsF:new THREE.MeshStandardMaterial({color:0xc25a4c,roughness:.4}),
    lipsM:new THREE.MeshStandardMaterial({color:0xb4826a,roughness:.6}),
    clothDark:new THREE.MeshStandardMaterial({color:0x191719,roughness:.75}),
    gloveDark:new THREE.MeshStandardMaterial({color:0x3a3733,roughness:.6,metalness:.05}),
    bootDark:new THREE.MeshStandardMaterial({color:0x1a1815,roughness:.45,metalness:.08}),
    armSleeve:new THREE.MeshStandardMaterial({color:0x2a2e36,roughness:.7}),
    // C1/C3:阵营识别件(臂章发光 / 头盔 / 头巾 / 镜片 / 第一人称袖套手套)
    ctAccent:new THREE.MeshStandardMaterial({color:0x2b3140,emissive:0x7fd4ff,emissiveIntensity:.9,roughness:.6}),
    tAccent:new THREE.MeshStandardMaterial({color:0x3a201a,emissive:0xff8a6a,emissiveIntensity:.9,roughness:.6}),
    helmet:new THREE.MeshStandardMaterial({color:0x454f61,roughness:.58,metalness:.3}),
    shemagh:new THREE.MeshStandardMaterial({color:0x5a2a24,roughness:.92,metalness:0}),
    goggleGlass:new THREE.MeshStandardMaterial({color:0x101820,emissive:0x7fd4ff,emissiveIntensity:1.2,roughness:.2,metalness:.6}),
    armSleeveCT:new THREE.MeshStandardMaterial({color:0x3d4a5e,roughness:.7}),
    armSleeveT:new THREE.MeshStandardMaterial({color:0x5a2420,roughness:.75}),
    gloveCT:new THREE.MeshStandardMaterial({color:0x2c3138,roughness:.55,metalness:.05}),
    gloveT:new THREE.MeshStandardMaterial({color:0x3a2e26,roughness:.6,metalness:.05}),
    // CS 枪械木件 / 不锈钢件
    gunWood:new THREE.MeshStandardMaterial({color:0x6b4a2a,roughness:.68,metalness:.05}),
    gunSteel:new THREE.MeshStandardMaterial({color:0x9aa2ac,roughness:.35,metalness:.85}),
    droneBody:new THREE.MeshStandardMaterial({color:0x3c4148,roughness:.38,metalness:.72}),
    droneDark:new THREE.MeshStandardMaterial({color:0x22262c,roughness:.5,metalness:.6}),
    droneArmor:new THREE.MeshStandardMaterial({color:0x555b62,roughness:.55,metalness:.5}),
    droneAccent:new THREE.MeshStandardMaterial({color:0x1c1206,emissive:0xff7a28,emissiveIntensity:1.6,roughness:.4}),
    rotor:new THREE.MeshStandardMaterial({color:0x14161a,roughness:.6,metalness:.4,transparent:true,opacity:.55,side:THREE.DoubleSide}),
    core:new THREE.MeshStandardMaterial({color:0x30080a,emissive:0xff2a1e,emissiveIntensity:2.4,roughness:.3,metalness:.2}),
    boltR:new THREE.MeshBasicMaterial({color:0xff8830}),
    boltW:new THREE.MeshBasicMaterial({color:0xff4430}),
    debris:new THREE.MeshStandardMaterial({color:0x24262a,roughness:.8,metalness:.4}),
    lava:new THREE.MeshBasicMaterial({color:0xff5a18}),
  };
  A.mats=M;

  A.containers={
    olive:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#5e6248','rgba(30,32,22,.85)')),roughness:.6,metalness:.35}),
    rust:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#8a4f38','rgba(40,18,10,.85)')),roughness:.68,metalness:.3}),
    arctic:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#4a5a66','rgba(15,20,26,.85)',{snowCap:true})),roughness:.5,metalness:.3}),
    charcoal:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#3a3438','rgba(12,10,12,.85)')),roughness:.6,metalness:.4}),
    emberTrim:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#4a2c24','rgba(14,8,6,.85)')),roughness:.6,metalness:.35,emissive:0x9a2a08,emissiveIntensity:.12}),
  };

  A.tex={
    hole:canvasTex(64,drawBulletHole,{srgb:false}),
    flash:canvasTex(128,drawMuzzle,{srgb:false}),
    spark:canvasTex(64,(g,S)=>drawSoft(g,S,'rgba(255,240,200,1)','rgba(255,170,70,.5)'),{srgb:false}),
    smoke:canvasTex(64,(g,S)=>drawSoft(g,S,'rgba(200,200,200,.55)','rgba(160,160,160,.22)'),{srgb:false}),
    dust:canvasTex(64,(g,S)=>drawSoft(g,S,'rgba(215,180,130,.6)','rgba(190,160,120,.25)'),{srgb:false}),
    snow:canvasTex(64,(g,S)=>drawSoft(g,S,'rgba(255,255,255,1)','rgba(230,240,255,.7)'),{srgb:false}),
    ember:canvasTex(64,(g,S)=>drawSoft(g,S,'rgba(255,200,110,1)','rgba(255,90,30,.6)'),{srgb:false}),
    ring:canvasTex(128,drawRingTex,{srgb:false}),
    // 曳光弹拖尾:尾端透明 → 头部白热(cylinder v 轴向 = 弹道前进方向)
    streak:canvasTex(64,(g,S)=>{
      const gr=g.createLinearGradient(0,S,0,0);
      gr.addColorStop(0,'rgba(255,255,255,0)');
      gr.addColorStop(.5,'rgba(255,224,180,.3)');
      gr.addColorStop(.82,'rgba(255,240,215,.8)');
      gr.addColorStop(1,'rgba(255,255,255,1)');
      g.fillStyle=gr;g.fillRect(0,0,S,S);
    },{srgb:false}),
  };
  // AbinStudio 广告贴图(赞助位:品牌 + AI 短剧制作 + 网址;中英双语,refreshAd 重绘)
  function drawAdFront(g,W,H){
    const bg=g.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#0e1424');bg.addColorStop(1,'#1a2236');
    g.fillStyle=bg;g.fillRect(0,0,W,H);
    g.strokeStyle='rgba(120,160,255,.55)';g.lineWidth=8;g.strokeRect(10,10,W-20,H-20);
    g.fillStyle='rgba(80,140,255,.92)';
    g.beginPath();g.arc(W*.12,H*.42,48,0,7);g.fill();
    g.fillStyle='#0e1424';
    g.beginPath();g.moveTo(W*.12-14,H*.42-24);g.lineTo(W*.12+22,H*.42);g.lineTo(W*.12-14,H*.42+24);g.closePath();g.fill();
    g.fillStyle='#eef3ff';
    g.font='bold 88px "Segoe UI",Arial,sans-serif';
    g.fillText('AbinStudio',W*.21,H*.46);
    g.fillStyle='#8fb6ff';
    g.font='bold 50px "Microsoft YaHei","Segoe UI",sans-serif';
    g.fillText(isEN()?'AI Short-Drama Studio · One-Click':'AI 短剧制作 · 一键成片',W*.22,H*.64);
    g.fillStyle='#ffd166';
    g.font='bold 56px Consolas,monospace';
    g.fillText('app.agents100.com',W*.22,H*.85);
  }
  function drawAdBack(g,W,H){
    const bg=g.createLinearGradient(0,0,0,H);
    bg.addColorStop(0,'#101728');bg.addColorStop(1,'#182034');
    g.fillStyle=bg;g.fillRect(0,0,W,H);
    g.strokeStyle='rgba(255,209,102,.55)';g.lineWidth=8;g.strokeRect(10,10,W-20,H-20);
    g.textAlign='center';
    g.fillStyle='#eef3ff';
    g.font='bold 76px "Segoe UI",Arial,sans-serif';
    g.fillText('AbinStudio',W/2,H*.33);
    g.fillStyle='#8fb6ff';
    g.font='bold 46px "Microsoft YaHei","Segoe UI",sans-serif';
    g.fillText(isEN()?'AI Short-Drama Studio · One-Click':'AI 短剧制作 · 一键成片',W/2,H*.48);
    g.fillStyle='#ffd166';
    g.font='bold 74px Consolas,monospace';
    g.fillText('app.agents100.com',W/2,H*.75);
    g.textAlign='left';
  }
  function makeAdCanvas(draw){
    const c=document.createElement('canvas');c.width=1024;c.height=512;
    draw(c.getContext('2d'),1024,512);
    const tex=new THREE.CanvasTexture(c);
    tex.colorSpace=THREE.SRGBColorSpace;tex.anisotropy=8;
    return {tex,canvas:c};
  }
  const adF=makeAdCanvas(drawAdFront);
  const adB=makeAdCanvas(drawAdBack);
  A.tex.ad=adF.tex;
  A.tex.adBack=adB.tex;
  // 语言切换后重绘广告贴图
  A.refreshAd=()=>{
    drawAdFront(adF.canvas.getContext('2d'),1024,512);
    drawAdBack(adB.canvas.getContext('2d'),1024,512);
    adF.tex.needsUpdate=true;
    adB.tex.needsUpdate=true;
  };
  return A;
}
