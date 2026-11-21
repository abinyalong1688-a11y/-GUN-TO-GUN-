// assets.js — procedural textures and shared materials (all generated on canvas, no external assets)
import * as THREE from 'three';
import {isEN} from './i18n.js';

/* ---------- Helpers ---------- */
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

// Normal map from a height map (Sobel)
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

/* ---------- Ground height/texture generators (one set per map) ---------- */
const noiseSand=valueNoise(101),noiseConcrete=valueNoise(202),noiseMetal=valueNoise(303),noiseSnow=valueNoise(404),noiseBasalt=valueNoise(505),noiseIce=valueNoise(606),noiseAsphalt=valueNoise(707);

function drawSand(g,S){
  g.fillStyle='#c69a62';g.fillRect(0,0,S,S);
  for(let i=0;i<520;i++){ // large colour blotches
    const v=noiseSand(i*3.7,i*1.3),r=8+Math.random()*60;
    g.fillStyle=`rgba(${v>.5?214:158},${v>.5?152:110},${v>.5?98:64},${.05+Math.random()*.08})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,r,0,7);g.fill();
  }
  g.strokeStyle='rgba(140,100,60,.11)';g.lineWidth=1.3; // wind ripples
  for(let i=0;i<70;i++){
    const y=Math.random()*S;g.beginPath();
    for(let x=0;x<=S;x+=6)g.lineTo(x,y+Math.sin(x*.05+i)*4+Math.random()*2);
    g.stroke();
  }
  for(let i=0;i<1600;i++){ // fine sand grains
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
  g.strokeStyle='rgba(140,165,195,.18)';g.lineWidth=1.6; // wind-blown snow ridges
  for(let i=0;i<40;i++){
    const y=Math.random()*S;g.beginPath();
    for(let x=0;x<=S;x+=7)g.lineTo(x,y+Math.sin(x*.045+i*2)*6);
    g.stroke();
  }
  for(let i=0;i<700;i++){
    g.fillStyle=Math.random()>.5?'rgba(255,255,255,.6)':'rgba(150,172,200,.2)';
    g.fillRect(Math.random()*S,Math.random()*S,1.6,1.6);
  }
  // Melt patches showing the ground underneath
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
  // Lava cracks
  for(let i=0;i<16;i++){
    let x=Math.random()*S,y=Math.random()*S;
    g.strokeStyle=`rgba(${220+Math.random()*35},${90+Math.random()*60},30,.75)`;g.lineWidth=1.6+Math.random()*2;
    g.shadowColor='rgba(255,120,30,.9)';g.shadowBlur=8;
    g.beginPath();g.moveTo(x,y);
    for(let k=0;k<8;k++){x+=(Math.random()-.5)*60;y+=(Math.random()-.5)*60;g.lineTo(x,y);}
    g.stroke();g.shadowBlur=0;
  }
  // Cinder specks
  for(let i=0;i<500;i++){
    g.fillStyle=Math.random()>.7?'rgba(255,140,40,.5)':'rgba(10,8,9,.4)';
    g.fillRect(Math.random()*S,Math.random()*S,1.4,1.4);
  }
}

/* Glacier-lake ice sheet (map 2 "Glacier Lake"): pale blue-white, branching pressure cracks + wind ridges.
   Triple-channel: cracks recessed in height, glossier in roughness (moonlight sheen reads on the sheet) */
function drawIce(g,h,r,S){
  g.fillStyle='#d3e2ee';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(150);r.fillRect(0,0,S,S);
  for(let i=0;i<420;i++){
    const v=noiseIce(i*2.3,i*3.1),r2=10+Math.random()*60;
    g.fillStyle=v>.55?'rgba(255,255,255,.5)':'rgba(140,175,205,.14)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,r2,0,7);g.fill();
  }
  // Pressure cracks: wide dark fracture + thin bright glint beside it, recessed in height
  for(let i=0;i<26;i++){
    let x=Math.random()*S,y=Math.random()*S;
    const pts=[[x,y]];
    for(let k=0;k<7;k++){x+=(Math.random()-.5)*90;y+=(Math.random()-.5)*90;pts.push([x,y]);}
    g.strokeStyle='rgba(80,125,165,.4)';g.lineWidth=2+Math.random()*2.5;
    g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)g.lineTo(px,py);g.stroke();
    g.strokeStyle='rgba(225,242,252,.5)';g.lineWidth=1;
    g.beginPath();g.moveTo(pts[0][0]+2,pts[0][1]+2);for(const [px,py] of pts)g.lineTo(px+2,py+2);g.stroke();
    h.strokeStyle=gv(86);h.lineWidth=3;
    h.beginPath();h.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)h.lineTo(px,py);h.stroke();
    r.strokeStyle=gv(210);r.lineWidth=3;
    r.beginPath();r.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)r.lineTo(px,py);r.stroke();
  }
  // Wind-blown snow ridges (raised, matte)
  for(let i=0;i<30;i++){
    const y=Math.random()*S;
    g.strokeStyle='rgba(255,255,255,.4)';g.lineWidth=3+Math.random()*5;
    g.beginPath();
    for(let x=0;x<=S;x+=8)g.lineTo(x,y+Math.sin(x*.04+i*2)*7);
    g.stroke();
    h.strokeStyle=gv(150);g.lineWidth=4;
    h.beginPath();
    for(let x=0;x<=S;x+=8)h.lineTo(x,y+Math.sin(x*.04+i*2)*7);
    h.stroke();
    r.strokeStyle=gv(185);
    r.beginPath();
    for(let x=0;x<=S;x+=8)r.lineTo(x,y+Math.sin(x*.04+i*2)*7);
    r.stroke();
  }
  // Frost sparkle specks (glinty)
  for(let i=0;i<600;i++){
    g.fillStyle='rgba(255,255,255,.5)';g.fillRect(Math.random()*S,Math.random()*S,1.4,1.4);
    r.fillStyle=gv(60);g.fillRect(Math.random()*S,Math.random()*S,1.4,1.4);
  }
}

/* Wet asphalt (map 3 "Neon Docklands"): near-black aggregate + faded lane paint; puddles are dark in the
   roughness canvas so they go glossy and catch the neon/lamp speculars */
function drawAsphalt(g,h,r,S){
  g.fillStyle='#1f2126';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(225);r.fillRect(0,0,S,S);
  for(let i=0;i<640;i++){
    const v=noiseAsphalt(i*1.9,i*2.7);
    g.fillStyle=v>.5?'rgba(120,126,136,.13)':'rgba(6,7,9,.3)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,3+Math.random()*26,0,7);g.fill();
    h.fillStyle=gv(v>.5?133:122);g.beginPath();g.arc(Math.random()*S,Math.random()*S,3+Math.random()*26,0,7);h.fill();
  }
  for(let i=0;i<1400;i++){ // aggregate specks
    const l=Math.random();
    g.fillStyle=l>.5?'rgba(150,155,165,.25)':'rgba(0,0,0,.4)';
    g.fillRect(Math.random()*S,Math.random()*S,1.2,1.2);
  }
  // Faded lane paint (raised, worn)
  const paint=(y,c)=>{g.fillStyle=c;g.fillRect(S*.06,y,S*.88,7);
    h.fillStyle=gv(140);h.fillRect(S*.06,y,S*.88,7);
    r.fillStyle=gv(170);r.fillRect(S*.06,y,S*.88,7);};
  paint(S*.24,'rgba(196,166,66,.3)');paint(S*.68,'rgba(210,214,220,.22)');paint(S*.82,'rgba(196,166,66,.22)');
  // Puddles: dark + glossy (low roughness), slight rim highlight
  for(let i=0;i<14;i++){
    const x=Math.random()*S,y=Math.random()*S,rx=14+Math.random()*46,ry=rx*(.4+Math.random()*.4);
    g.fillStyle='rgba(8,10,14,.55)';g.beginPath();g.ellipse(x,y,rx,ry,Math.random()*3,0,7);g.fill();
    g.strokeStyle='rgba(190,205,220,.14)';g.lineWidth=1.2;
    g.beginPath();g.ellipse(x,y,rx,ry,0,0,7);g.stroke();
    r.fillStyle=gv(48);g.beginPath();g.ellipse(x,y,rx,ry,0,0,7);r.fill();
  }
}

/* Glacial ice block cover (map 2): pale blue with internal fracture lines, semi-gloss */
function drawIceBlock(g,h,r,S){
  g.fillStyle='#b9d4e6';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(105);r.fillRect(0,0,S,S);
  for(let i=0;i<380;i++){
    const v=Math.random();
    g.fillStyle=v>.5?'rgba(255,255,255,.16)':'rgba(110,150,185,.12)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,4+Math.random()*24,0,7);g.fill();
  }
  // Internal fractures: bright glint line next to a recessed seam
  for(let i=0;i<16;i++){
    let x=Math.random()*S,y=Math.random()*S;const pts=[[x,y]];
    for(let k=0;k<6;k++){x+=(Math.random()-.5)*70;y+=(Math.random()-.5)*70;pts.push([x,y]);}
    g.strokeStyle='rgba(235,248,255,.55)';g.lineWidth=1.5;
    g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)g.lineTo(px,py);g.stroke();
    h.strokeStyle=gv(90);h.lineWidth=2.5;
    h.beginPath();h.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)h.lineTo(px,py);h.stroke();
  }
  // Chipped edges / frost wear
  for(let i=0;i<30;i++){
    const x=Math.random()*S,y=Math.random()*S,w=3+Math.random()*12;
    g.fillStyle='rgba(240,250,255,.3)';g.fillRect(x,y,w,1.5);
    r.fillStyle=gv(60);g.fillRect(x,y,w,1.5);
  }
}

/* Lava pool surface (map 4 "Volcano Caldera"): dark crust plates with glowing molten cracks between them.
   One canvas feeds map AND emissiveMap — crust stays dark, cracks glow */
function drawLavaPool(g,S){
  g.fillStyle='#150a07';g.fillRect(0,0,S,S);
  // Crust plates
  for(let i=0;i<46;i++){
    const v=Math.random();
    g.fillStyle=v>.5?'rgba(60,30,18,.55)':'rgba(20,10,8,.7)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,14+Math.random()*44,0,7);g.fill();
  }
  // Molten cracks (wide glow + white-hot core)
  for(let i=0;i<22;i++){
    let x=Math.random()*S,y=Math.random()*S;
    const pts=[[x,y]];
    for(let k=0;k<6;k++){x+=(Math.random()-.5)*110;y+=(Math.random()-.5)*110;pts.push([x,y]);}
    g.shadowColor='rgba(255,120,30,.95)';g.shadowBlur=12;
    g.strokeStyle='rgba(255,110,25,.9)';g.lineWidth=3+Math.random()*4;
    g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)g.lineTo(px,py);g.stroke();
    g.shadowBlur=0;
    g.strokeStyle='rgba(255,230,170,.9)';g.lineWidth=1.4;
    g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(const [px,py] of pts)g.lineTo(px,py);g.stroke();
  }
  // Cinder specks
  for(let i=0;i<400;i++){
    g.fillStyle=Math.random()>.6?'rgba(255,150,50,.55)':'rgba(0,0,0,.5)';
    g.fillRect(Math.random()*S,Math.random()*S,1.6,1.6);
  }
}

/* Neon sign (map 3 "Neon Docklands"): dark panel + tube border + glowing lettering (bilingual).
   Same canvas feeds map AND emissiveMap — the panel stays dark, tubes glow and bloom gently */
function drawNeon(g,S,color,main,sub){
  g.fillStyle='#0a0c12';g.fillRect(0,0,S,S);
  const gr=g.createLinearGradient(0,0,0,S);
  gr.addColorStop(0,'rgba(26,32,44,.9)');gr.addColorStop(1,'rgba(12,14,20,.9)');
  g.fillStyle=gr;g.fillRect(0,0,S,S);
  // Tube border (double stroke: wide glow + bright core)
  g.shadowColor=color;g.shadowBlur=14;
  g.strokeStyle=color;g.lineWidth=4;g.strokeRect(10,10,S-20,S-20);
  g.shadowBlur=0;
  g.strokeStyle='rgba(255,255,255,.75)';g.lineWidth=1.4;g.strokeRect(10,10,S-20,S-20);
  // Lettering
  g.textAlign='center';
  g.shadowColor=color;g.shadowBlur=12;
  g.fillStyle=color;
  g.font=`bold ${S*.24}px "Segoe UI","Microsoft YaHei",Arial,sans-serif`;
  g.fillText(main,S/2,S*.44);
  g.fillStyle='rgba(255,255,255,.92)';
  g.font=`bold ${S*.13}px Consolas,"Microsoft YaHei",monospace`;
  g.fillText(sub,S/2,S*.72);
  g.shadowBlur=0;
  g.textAlign='left';
}

function drawConcrete(g,S){
  g.fillStyle='#8e8a82';g.fillRect(0,0,S,S);
  for(let i=0;i<700;i++){
    const v=noiseConcrete(i*1.1,i*2.3);
    g.fillStyle=`rgba(${v>.5?255:60},${v>.5?255:58},${v>.5?250:54},${.035+Math.random()*.05})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,2+Math.random()*26,0,7);g.fill();
  }
  g.strokeStyle='rgba(40,38,34,.32)';g.lineWidth=1; // hairline cracks
  for(let i=0;i<9;i++){
    let x=Math.random()*S,y=Math.random()*S;g.beginPath();g.moveTo(x,y);
    for(let k=0;k<10;k++){x+=(Math.random()-.5)*30;y+=Math.random()*14;g.lineTo(x,y);}
    g.stroke();
  }
  // Plank seams
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
  // Panel seams + rivets
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
    // Snow cap on top
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

/* ---------- Character outfit maps: NEUTRAL grey canvases so the per-operator palette tint
   (material.color × map) keeps its hue; the relief / roughness variation adds the "not plastic".
   Same one-brain-three-maps trick as the weapon factory above. ---------- */
function drawCloth(g,h,r,S){
  g.fillStyle='#e6e2da';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(198);r.fillRect(0,0,S,S);
  // Thread weave: fine cross-hatch with height relief
  const st=Math.max(2,Math.round(S/96));
  for(let y=0;y<S;y+=st){
    g.strokeStyle=`rgba(90,84,74,${.05+Math.random()*.07})`;g.lineWidth=1;
    g.beginPath();g.moveTo(0,y+.5);g.lineTo(S,y+.5);g.stroke();
    h.strokeStyle=gv(118);h.beginPath();h.moveTo(0,y+.5);h.lineTo(S,y+.5);h.stroke();
  }
  for(let x=0;x<S;x+=st){
    g.strokeStyle=`rgba(255,252,244,${.04+Math.random()*.06})`;
    g.beginPath();g.moveTo(x+.5,0);g.lineTo(x+.5,S);g.stroke();
    h.strokeStyle=gv(138);h.beginPath();h.moveTo(x+.5,0);h.lineTo(x+.5,S);h.stroke();
  }
  // Fibre noise
  for(let i=0;i<S*30;i++){
    const x=Math.random()*S,y=Math.random()*S,hi=Math.random()>.5;
    g.fillStyle=hi?`rgba(255,250,240,${.03+Math.random()*.05})`:`rgba(70,64,56,${.03+Math.random()*.05})`;
    g.fillRect(x,y,1.4,1.4);
  }
  // Stress creases: soft diagonal ridges, smoother where the fabric rubs
  for(let i=0;i<10;i++){
    const x=Math.random()*S,y=Math.random()*S,len=S*(.15+Math.random()*.3),ang=(Math.random()-.5)*.9;
    g.strokeStyle=`rgba(60,54,46,${.05+Math.random()*.06})`;g.lineWidth=2+Math.random()*3;
    g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(ang)*len,y+Math.sin(ang)*len);g.stroke();
    r.strokeStyle=gv(160);r.lineWidth=2.5;
    r.beginPath();r.moveTo(x,y);r.lineTo(x+Math.cos(ang)*len,y+Math.sin(ang)*len);r.stroke();
  }
  // Grime blotches (rougher, darker)
  for(let i=0;i<26;i++){
    g.fillStyle=`rgba(52,44,34,${.04+Math.random()*.07})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,2+Math.random()*9,0,7);g.fill();
  }
}

function drawArmorPanel(g,h,r,S){
  g.fillStyle='#cfd2d6';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(150);r.fillRect(0,0,S,S);
  // Composite panel seams: recessed gap + bright worn edge
  for(const fy of[.18,.5,.82]){
    g.strokeStyle='rgba(20,22,26,.5)';g.lineWidth=2;
    g.beginPath();g.moveTo(0,S*fy);g.lineTo(S,S*fy);g.stroke();
    g.strokeStyle='rgba(255,255,255,.14)';g.lineWidth=1;
    g.beginPath();g.moveTo(0,S*fy+2);g.lineTo(S,S*fy+2);g.stroke();
    h.strokeStyle=gv(70);h.lineWidth=2.5;
    h.beginPath();h.moveTo(0,S*fy);h.lineTo(S,S*fy);h.stroke();
    r.strokeStyle=gv(170);r.lineWidth=2.5;
    r.beginPath();r.moveTo(0,S*fy);r.lineTo(S,S*fy);r.stroke();
  }
  for(const fx of[.3,.72]){
    g.strokeStyle='rgba(20,22,26,.4)';g.lineWidth=2;
    g.beginPath();g.moveTo(S*fx,0);g.lineTo(S*fx,S);g.stroke();
    h.strokeStyle=gv(80);h.lineWidth=2.5;
    h.beginPath();h.moveTo(S*fx,0);h.lineTo(S*fx,S);h.stroke();
  }
  // Attachment bolts: raised and polished
  for(let i=0;i<14;i++){
    const x=6+Math.random()*(S-12),y=6+Math.random()*(S-12);
    g.fillStyle='rgba(0,0,0,.4)';g.beginPath();g.arc(x,y,2.6,0,7);g.fill();
    g.fillStyle='rgba(235,240,246,.5)';g.beginPath();g.arc(x-.8,y-.8,1.2,0,7);g.fill();
    h.fillStyle=gv(190);h.beginPath();g.arc(x,y,2.6,0,7);h.fill();
    r.fillStyle=gv(70);h.beginPath();h.arc(x,y,2.6,0,7);h.fill();
  }
  // Scrapes through the coating: brighter composite, smoother
  for(let i=0;i<34;i++){
    const x=Math.random()*S,y=Math.random()*S,len=3+Math.random()*14,ang=Math.random()*Math.PI;
    g.strokeStyle=`rgba(240,243,248,${.06+Math.random()*.1})`;g.lineWidth=1+Math.random()*1.6;
    g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(ang)*len,y+Math.sin(ang)*len);g.stroke();
    r.strokeStyle=gv(90);r.lineWidth=1.5;
    r.beginPath();r.moveTo(x,y);r.lineTo(x+Math.cos(ang)*len,y+Math.sin(ang)*len);r.stroke();
  }
}

function drawLeather(g,h,r,S){
  g.fillStyle='#cfc8c0';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(170);r.fillRect(0,0,S,S);
  // Pebbled grain: dense random cells
  for(let i=0;i<S*22;i++){
    const x=Math.random()*S,y=Math.random()*S,rad=1+Math.random()*3,hi=Math.random()>.5;
    g.strokeStyle=hi?`rgba(255,248,238,${.05+Math.random()*.08})`:`rgba(40,34,28,${.05+Math.random()*.09})`;
    g.lineWidth=.8+Math.random();
    g.beginPath();g.arc(x,y,rad,Math.random()*7,Math.random()*7+2);g.stroke();
    h.strokeStyle=gv(hi?140:112);h.beginPath();h.arc(x,y,rad,0,7);h.stroke();
  }
  // Crease folds: recessed wavy lines, rougher edges
  for(let i=0;i<16;i++){
    const x=Math.random()*S,y=Math.random()*S,len=S*(.1+Math.random()*.25),ang=Math.random()*Math.PI;
    g.strokeStyle=`rgba(30,24,20,${.08+Math.random()*.1})`;g.lineWidth=1.5+Math.random()*2;
    g.beginPath();g.moveTo(x,y);g.quadraticCurveTo(x+len/2,y+(Math.random()-.5)*6,x+len,y);g.stroke();
    h.strokeStyle=gv(70);h.lineWidth=2;
    h.beginPath();h.moveTo(x,y);h.lineTo(x+len,y);h.stroke();
    r.strokeStyle=gv(150);r.lineWidth=2;
    r.beginPath();r.moveTo(x,y);r.lineTo(x+len,y);r.stroke();
  }
  // Handled polish spots: smoother, faint sheen
  for(let i=0;i<10;i++){
    const x=Math.random()*S,y=Math.random()*S;
    g.fillStyle=`rgba(255,244,224,${.03+Math.random()*.05})`;
    g.beginPath();g.arc(x,y,4+Math.random()*8,0,7);g.fill();
    r.fillStyle=gv(85);r.beginPath();g.arc(x,y,5+Math.random()*7,0,7);r.fill();
  }
}

function drawSkin(g,h,r,S){
  g.fillStyle='#fff6ee';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(150);r.fillRect(0,0,S,S);
  // Pore noise
  for(let i=0;i<S*26;i++){
    const x=Math.random()*S,y=Math.random()*S;
    g.fillStyle=`rgba(190,130,100,${.02+Math.random()*.04})`;
    g.fillRect(x,y,1,1);
    r.fillStyle=gv(135+Math.random()*30);r.fillRect(x,y,1,1);
  }
  // Warm mottling (cheeks / nose feel without UV knowledge — blotches read as natural tone)
  for(let i=0;i<14;i++){
    g.fillStyle=`rgba(255,110,80,${.02+Math.random()*.035})`;
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,3+Math.random()*10,0,7);g.fill();
  }
  // Smoother sheen patches (T-zone / knuckles)
  for(let i=0;i<8;i++){
    r.fillStyle=gv(100+Math.random()*40);
    r.beginPath();
    r.arc(Math.random()*S,Math.random()*S,5+Math.random()*9,0,7);
    r.fill();
  }
}

/* ---------- Weapon material factory: colour / height / roughness drawn with the same strokes ----------
   One brush paints three maps at once → map + normalMap (relief) + roughnessMap (worn spots are smoother);
   roughness canvas brightness ≈ roughness×255, multiplied by the material roughness to get the target feel */
const gv=v=>`rgb(${v},${v},${v})`;
function weaponMat(size,draw,{metal,rough,envInt=1,nStr=1.2,color=null}={}){
  const mk=()=>{const c=document.createElement('canvas');c.width=c.height=size;return c;};
  const c=mk(),h=mk(),r=mk();
  draw(c.getContext('2d'),h.getContext('2d'),r.getContext('2d'),size);
  const tex=c2=>{const t=new THREE.CanvasTexture(c2);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=8;return t;};
  const map=tex(c);map.colorSpace=THREE.SRGBColorSpace;
  const m=new THREE.MeshStandardMaterial({map,normalMap:heightToNormal(h,nStr),
    normalScale:new THREE.Vector2(1,1),roughnessMap:tex(r),roughness:rough,
    metalness:metal,envMapIntensity:envInt});
  // Neutral canvases (character outfits) rely on material.color for their base tint —
  // weapon canvases paint their own colours and leave color at white
  if(color!=null)m.color.setHex(color);
  return m;
}

function drawGunMetal(g,h,r,S){
  g.fillStyle='#1e2126';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(107);r.fillRect(0,0,S,S);
  // Horizontal brushing (slight colour + height variation)
  for(let i=0;i<220;i++){
    const y=Math.random()*S,x=Math.random()*S,len=S*(.2+Math.random()*.8),hi=Math.random()>.5;
    const a=.03+Math.random()*.04,w=.8+Math.random();
    g.strokeStyle=hi?`rgba(255,255,255,${a})`:`rgba(0,0,0,${a})`;
    g.lineWidth=w;g.beginPath();g.moveTo(x,y);g.lineTo(x+len,y+(Math.random()-.5)*2);g.stroke();
    h.strokeStyle=gv(hi?136:120);h.lineWidth=w;
    h.beginPath();h.moveTo(x,y);h.lineTo(x+len,y+(Math.random()-.5)*2);h.stroke();
  }
  // Panel seams: dark gap + highlighted edge / height: recessed / roughness: burred edges
  for(const fy of[.33,.72]){
    g.strokeStyle='rgba(8,9,11,.75)';g.lineWidth=2;
    g.beginPath();g.moveTo(0,S*fy);g.lineTo(S,S*fy);g.moveTo(0,S*.72);g.lineTo(S,S*.72);g.stroke();
    g.strokeStyle='rgba(255,255,255,.06)';g.lineWidth=1;
    g.beginPath();g.moveTo(0,S*fy+2);g.lineTo(S,S*fy+2);g.stroke();
    h.strokeStyle=gv(58);h.lineWidth=2.5;
    h.beginPath();h.moveTo(0,S*fy);h.lineTo(S,S*fy);h.stroke();
    r.strokeStyle=gv(150);r.lineWidth=2.5;
    r.beginPath();r.moveTo(0,S*fy);r.lineTo(S,S*fy);r.stroke();
  }
  // Screws: raised + polished (smoother)
  for(let i=0;i<12;i++){
    const x=8+Math.random()*(S-16),y=8+Math.random()*(S-16);
    g.fillStyle='rgba(0,0,0,.55)';g.beginPath();g.arc(x,y,3,0,7);g.fill();
    g.fillStyle='rgba(205,212,222,.5)';g.beginPath();g.arc(x-.7,y-.7,1.5,0,7);g.fill();
    h.fillStyle=gv(205);h.beginPath();h.arc(x,y,3,0,7);h.fill();
    r.fillStyle=gv(55);r.beginPath();r.arc(x,y,3,0,7);r.fill();
  }
  // Wear spots: bare metal showing through (smoother, brighter)
  for(let i=0;i<46;i++){
    const x=Math.random()*S,y=Math.random()*S,w=2+Math.random()*9,ht=1+Math.random()*2;
    g.fillStyle=`rgba(168,175,186,${.05+Math.random()*.08})`;g.fillRect(x,y,w,ht);
    r.fillStyle=gv(45);r.fillRect(x,y,w,ht);
  }
  // Oil stains
  for(let i=0;i<26;i++){
    g.fillStyle='rgba(10,10,12,.12)';
    g.beginPath();g.arc(Math.random()*S,Math.random()*S,2+Math.random()*7,0,7);g.fill();
  }
}

function drawPolymer(g,h,r,S,base){
  g.fillStyle=base;g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(183);r.fillRect(0,0,S,S);
  // Grip stippling: noise + raised dots
  for(let i=0;i<2600;i++){
    const x=Math.random()*S,y=Math.random()*S,hi=Math.random()>.5;
    g.fillStyle=hi?`rgba(255,255,255,${.02+Math.random()*.04})`:`rgba(0,0,0,${.03+Math.random()*.05})`;
    g.fillRect(x,y,1.4,1.4);
    h.fillStyle=gv(hi?152:104);h.fillRect(x,y,1.4,1.4);
    r.fillStyle=gv(hi?205:163);r.fillRect(x,y,1.4,1.4);
  }
  // Injection-mould parting lines (recessed)
  g.strokeStyle='rgba(0,0,0,.28)';g.lineWidth=2;
  g.beginPath();g.moveTo(0,S*.5);g.lineTo(S,S*.5);g.stroke();
  h.strokeStyle=gv(70);h.lineWidth=2.5;
  h.beginPath();h.moveTo(0,S*.5);h.lineTo(S,S*.5);h.stroke();
  // Rail cross-slots (raised)
  g.fillStyle='rgba(0,0,0,.2)';
  h.fillStyle=gv(170);
  for(let y=S*.08;y<S*.92;y+=S*.09){g.fillRect(0,y,S,2);h.fillRect(0,y,S,2.5);}
  // Handling wear (polished, smoother)
  for(let i=0;i<30;i++){
    const x=Math.random()*S,y=Math.random()*S,w=3+Math.random()*10;
    g.fillStyle=`rgba(232,226,214,${.04+Math.random()*.06})`;g.fillRect(x,y,w,1+Math.random()*1.5);
    r.fillStyle=gv(120);r.fillRect(x,y,w,1+Math.random()*1.5);
  }
}

function drawGoldTrim(g,h,r,S){
  g.fillStyle='#d8a850';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(77);r.fillRect(0,0,S,S);
  // Flowing gold streaks
  for(let i=0;i<70;i++){
    const y=Math.random()*S,hi=Math.random()>.5;
    g.strokeStyle=`rgba(${hi?255:150},${hi?220:110},70,${.08+Math.random()*.1})`;
    g.lineWidth=1+Math.random()*2;
    g.beginPath();g.moveTo(0,y);
    for(let x=0;x<=S;x+=8)g.lineTo(x,y+Math.sin(x*.06+i)*2);
    g.stroke();
    h.strokeStyle=gv(hi?138:118);
    h.beginPath();h.moveTo(0,y);
    for(let x=0;x<=S;x+=8)h.lineTo(x,y+Math.sin(x*.06+i)*2);
    h.stroke();
  }
  // Scratches (brighter, smoother)
  for(let i=0;i<18;i++){
    const x=Math.random()*S,y=Math.random()*S;
    g.strokeStyle='rgba(120,80,20,.35)';g.lineWidth=1;
    g.beginPath();g.moveTo(x,y);g.lineTo(Math.random()*S,Math.random()*S);g.stroke();
    r.fillStyle=gv(45);r.fillRect(x,y,2,2);
  }
}

/* Wood furniture (AK-47): vertical grain grooves + varnish highlights (not to be confused with the scene's drawWood) */
function drawGunWood(g,h,r,S){
  g.fillStyle='#6b4a2a';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(173);r.fillRect(0,0,S,S);
  for(let i=0;i<60;i++){
    const x=Math.random()*S,w=1+Math.random()*3,dark=Math.random()>.45;
    const path=gg=>{gg.beginPath();gg.moveTo(x,0);
      for(let y=0;y<=S;y+=S/8)gg.lineTo(x+Math.sin(y*.05+i)*3+(Math.random()-.5)*2,y);gg.stroke();};
    g.strokeStyle=dark?`rgba(58,38,20,${.25+Math.random()*.3})`:`rgba(150,108,64,${.2+Math.random()*.25})`;
    g.lineWidth=w;path(g);
    h.strokeStyle=gv(dark?96:152);h.lineWidth=w;path(h);
    r.strokeStyle=gv(dark?200:150);r.lineWidth=w;path(r);
  }
  for(let i=0;i<6;i++){
    const x=Math.random()*S;
    g.fillStyle='rgba(255,230,190,.05)';g.fillRect(x,0,S*.06,S);
    r.fillStyle=gv(140);r.fillRect(x,0,S*.06,S);
  }
}

/* Stainless parts (Desert Eagle): fine brushing + machined cross-cuts */
function drawSteel(g,h,r,S){
  g.fillStyle='#9aa2ac';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(90);r.fillRect(0,0,S,S);
  for(let i=0;i<300;i++){
    const y=Math.random()*S,hi=Math.random()>.5,a=.04+Math.random()*.05;
    g.strokeStyle=(hi?'rgba(255,255,255,':'rgba(40,44,50,')+a+')';
    g.lineWidth=.7+Math.random();
    g.beginPath();g.moveTo(0,y);g.lineTo(S,y+(Math.random()-.5)*1.5);g.stroke();
    h.strokeStyle=gv(hi?134:122);
    h.beginPath();h.moveTo(0,y);h.lineTo(S,y+(Math.random()-.5)*1.5);h.stroke();
    r.strokeStyle=gv(60+Math.random()*70);
    r.beginPath();r.moveTo(0,y);r.lineTo(S,y+(Math.random()-.5)*1.5);r.stroke();
  }
  h.fillStyle=gv(118);
  for(let y=0;y<S;y+=3)h.fillRect(0,y,S,1);
}

/* Olive drab paint (Longbow): matte noise + scratches down to bare metal */
function drawGreen(g,h,r,S){
  g.fillStyle='#39463b';g.fillRect(0,0,S,S);
  h.fillStyle=gv(128);h.fillRect(0,0,S,S);
  r.fillStyle=gv(158);r.fillRect(0,0,S,S);
  for(let i=0;i<1800;i++){
    const x=Math.random()*S,y=Math.random()*S,hi=Math.random()>.5;
    g.fillStyle=hi?`rgba(255,255,255,${.02+Math.random()*.03})`:`rgba(0,0,0,${.03+Math.random()*.05})`;
    g.fillRect(x,y,1.6,1.6);
    h.fillStyle=gv(hi?140:116);h.fillRect(x,y,1.6,1.6);
  }
  for(let i=0;i<26;i++){
    const x=Math.random()*S,y=Math.random()*S,len=6+Math.random()*30,a=Math.random()*Math.PI;
    g.strokeStyle='rgba(122,130,120,.5)';g.lineWidth=1+Math.random()*1.2;
    g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*len,y+Math.sin(a)*len);g.stroke();
    r.fillStyle=gv(70);r.fillRect(x,y,3,2);
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

/* ---------- Output ---------- */
export const A={};
export function initAssets(){
  // --- Three ground types (1024 high-res + normals) ---
  function groundMat(draw,normStrength,repeat){
    const c=document.createElement('canvas');c.width=c.height=1024;
    draw(c.getContext('2d'),1024);
    const map=new THREE.CanvasTexture(c);
    map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(repeat,repeat);
    map.colorSpace=THREE.SRGBColorSpace;map.anisotropy=8;
    const normal=heightToNormal(c,normStrength);normal.repeat.set(repeat,repeat);
    return new THREE.MeshStandardMaterial({map,normalMap:normal,normalScale:new THREE.Vector2(.65,.65),roughness:.96,metalness:.02});
  }
  // Triple-channel ground (colour + height + roughness in one brush pass) at tiling resolution
  function groundTriple(draw,repeat,{metal=.02,rough=.96,nStr=1}={}){
    const m=weaponMat(1024,draw,{metal,rough,nStr});
    m.map.repeat.set(repeat,repeat);
    m.normalMap.repeat.set(repeat,repeat);
    m.roughnessMap.repeat.set(repeat,repeat);
    return m;
  }
  A.ground={
    sand:groundMat(drawSand,2.0,10),
    snow:groundMat(drawSnow,1.2,10),
    basalt:groundMat(drawBasalt,2.6,10),
    ice:groundTriple(drawIce,10,{rough:.6,nStr:1.4}),          // glacier lake sheet: moonlit sheen
    asphalt:groundTriple(drawAsphalt,10,{metal:.08,rough:.92,envInt:.7,nStr:.8}), // wet dock yard
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
    // Gun surfaces: 512 three-channel textures (colour + normal + roughness) — seams / screws / brushing / wear have real relief under IBL
    gunDark:weaponMat(512,drawGunMetal,{metal:.7,rough:.42,envInt:1.0,nStr:1.3}),
    gunPoly:weaponMat(512,(g,h,r,S)=>drawPolymer(g,h,r,S,'#2c2f34'),{metal:.12,rough:.72,envInt:.55,nStr:.9}),
    gunFDE:weaponMat(512,(g,h,r,S)=>drawPolymer(g,h,r,S,'#6e5a42'),{metal:.08,rough:.75,envInt:.5,nStr:.9}),
    gunBrass:new THREE.MeshStandardMaterial({color:0xc8a050,roughness:.35,metalness:.9,emissive:0x664410,emissiveIntensity:.25}),
    // Stylised weapons: energy parts use a glowing grid texture (map and emissiveMap share a source; dark areas do not glow)
    energyBlue:new THREE.MeshStandardMaterial({map:energyTexBlue,emissiveMap:energyTexBlue,emissive:0xffffff,emissiveIntensity:1.0,roughness:.4,metalness:.6}),
    energyPurple:new THREE.MeshStandardMaterial({map:energyTexPurple,emissiveMap:energyTexPurple,emissive:0xffffff,emissiveIntensity:.85,roughness:.4,metalness:.6}),
    goldTrim:weaponMat(512,drawGoldTrim,{metal:.95,rough:.3,envInt:1.1,nStr:.8}),
    // Heroes
    queenArmor:new THREE.MeshStandardMaterial({color:0x8a2626,roughness:.5,metalness:.55}),
    queenGold:new THREE.MeshStandardMaterial({color:0xe0b25a,roughness:.3,metalness:.9}),
    skin:new THREE.MeshStandardMaterial({color:0xe8b898,roughness:.85,metalness:0}),
    hairBlack:new THREE.MeshStandardMaterial({color:0x181414,roughness:.9,metalness:0}),
    suitDark:new THREE.MeshStandardMaterial({color:0x232830,roughness:.7,metalness:.15}),
    vestGray:new THREE.MeshStandardMaterial({color:0x3a4250,roughness:.75,metalness:.2}),
    shades:new THREE.MeshStandardMaterial({color:0x0c0e12,roughness:.2,metalness:.8}),
    // Faction characters — outfits use neutral three-channel maps (cloth weave / armour panels),
    // palette tinting multiplies on top; the color param keeps the original base hue pre-tint
    ctFatigue:weaponMat(256,drawCloth,{metal:.08,rough:.95,envInt:.25,nStr:.55,color:0x46536b}),
    ctArmor:weaponMat(256,drawArmorPanel,{metal:.3,rough:.8,envInt:.5,nStr:1.1,color:0x2b3140}),
    ctHelmet:new THREE.MeshStandardMaterial({color:0x454f61,roughness:.6,metalness:.3}),
    tJacket:weaponMat(256,drawCloth,{metal:.04,rough:.95,envInt:.2,nStr:.55,color:0x7e2620}),
    tPants:weaponMat(256,drawCloth,{metal:.04,rough:.95,envInt:.2,nStr:.55,color:0x2f2c2c}),
    tRig:weaponMat(256,drawArmorPanel,{metal:.2,rough:.85,envInt:.4,nStr:1.1,color:0x1e1c1c}),
    balaclava:new THREE.MeshStandardMaterial({color:0x17171c,roughness:.85,metalness:0}),
    beanie:new THREE.MeshStandardMaterial({color:0x565a60,roughness:.9,metalness:0}),
    // Realistic 3D characters: skin pore map / hair / facial features / leather boots+gloves
    skinF:weaponMat(256,drawSkin,{metal:0,rough:.62,envInt:.3,nStr:.35,color:0xf3d0b8}),
    skinM:weaponMat(256,drawSkin,{metal:0,rough:.7,envInt:.3,nStr:.35,color:0xdfab8c}),
    skinN:weaponMat(256,drawSkin,{metal:0,rough:.62,envInt:.3,nStr:.35,color:0xd8a687}),
    sclera:new THREE.MeshStandardMaterial({color:0xf6f3f0,roughness:.25}),
    iris:new THREE.MeshStandardMaterial({color:0x33241c,roughness:.3}),
    brow:new THREE.MeshStandardMaterial({color:0x2a1a12,roughness:.8}),
    hairF:new THREE.MeshStandardMaterial({color:0x3a2418,roughness:.82}),
    hairM:new THREE.MeshStandardMaterial({color:0x1a130e,roughness:.85}),
    lipsF:new THREE.MeshStandardMaterial({color:0xc25a4c,roughness:.4}),
    lipsM:new THREE.MeshStandardMaterial({color:0xb4826a,roughness:.6}),
    clothDark:weaponMat(256,drawCloth,{metal:.02,rough:.95,envInt:.15,nStr:.5,color:0x191719}),
    gloveDark:weaponMat(256,drawLeather,{metal:.04,rough:.92,envInt:.25,nStr:.75,color:0x3a3733}),
    bootDark:weaponMat(256,drawLeather,{metal:.06,rough:.95,envInt:.3,nStr:.75,color:0x1a1815}),
    armSleeve:weaponMat(256,drawCloth,{metal:.05,rough:.9,envInt:.3,nStr:.55,color:0x2a2e36}),
    // C1/C3: faction identifiers (glowing armband / helmet / shemagh / lenses / first-person sleeves and gloves)
    ctAccent:new THREE.MeshStandardMaterial({color:0x2b3140,emissive:0x7fd4ff,emissiveIntensity:.9,roughness:.6}),
    tAccent:new THREE.MeshStandardMaterial({color:0x3a201a,emissive:0xff8a6a,emissiveIntensity:.9,roughness:.6}),
    helmet:new THREE.MeshStandardMaterial({color:0x454f61,roughness:.58,metalness:.3}),
    shemagh:new THREE.MeshStandardMaterial({color:0x5a2a24,roughness:.92,metalness:0}),
    goggleGlass:new THREE.MeshStandardMaterial({color:0x101820,emissive:0x7fd4ff,emissiveIntensity:1.2,roughness:.2,metalness:.6}),
    armSleeveCT:weaponMat(256,drawCloth,{metal:.05,rough:.9,envInt:.3,nStr:.55,color:0x3d4a5e}),
    armSleeveT:weaponMat(256,drawCloth,{metal:.05,rough:.92,envInt:.3,nStr:.55,color:0x5a2420}),
    gloveCT:weaponMat(256,drawLeather,{metal:.04,rough:.92,envInt:.25,nStr:.75,color:0x2c3138}),
    gloveT:weaponMat(256,drawLeather,{metal:.04,rough:.92,envInt:.25,nStr:.75,color:0x3a2e26}),
    // Gun wood / stainless / olive drab paint (three-channel textures)
    gunWood:weaponMat(512,drawGunWood,{metal:.05,rough:.68,envInt:.4,nStr:.8}),
    gunSteel:weaponMat(512,drawSteel,{metal:.85,rough:.35,envInt:1.3,nStr:.5}),
    gunGreen:weaponMat(512,drawGreen,{metal:.25,rough:.62,envInt:.7,nStr:.7}),
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
    // Map-specific: glacier ice blocks / obsidian shards / dock neon signs
    ice:weaponMat(512,drawIceBlock,{metal:.05,rough:.34,nStr:.9}),
    obsidian:new THREE.MeshStandardMaterial({color:0x0e0c14,roughness:.3,metalness:.1,flatShading:true}),
    column:new THREE.MeshStandardMaterial({color:0x37333a,roughness:.92,metalness:.05,flatShading:true}),
  };
  // Neon signage: dark panel canvas feeds map AND emissiveMap (panel stays dark, tubes glow)
  const neonTex=(color,main,sub)=>canvasTex(256,(g,S)=>drawNeon(g,S,color,main,sub));
  const neonSign=tex=>new THREE.MeshStandardMaterial({map:tex,emissiveMap:tex,emissive:0xffffff,emissiveIntensity:1.35,roughness:.5,metalness:.3});
  M.neonDock=neonSign(neonTex('#4fe3ff',isEN()?'DOCK 07':'七号码头',isEN()?'CARGO · 24H':'集装箱 · 通宵'));
  M.neonFerry=neonSign(neonTex('#ff5f9e',isEN()?'NIGHT FERRY':'夜航渡轮',isEN()?'GATE 3 · 24H':'3号闸 · 通宵'));
  M.neonCargo=neonSign(neonTex('#ffb84f',isEN()?'CARGO ZONE':'装卸区',isEN()?'KEEP CLEAR':'严禁停留'));
  A.mats=M;

  A.containers={
    olive:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#5e6248','rgba(30,32,22,.85)')),roughness:.6,metalness:.35}),
    rust:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#8a4f38','rgba(40,18,10,.85)')),roughness:.68,metalness:.3}),
    arctic:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#4a5a66','rgba(15,20,26,.85)',{snowCap:true})),roughness:.5,metalness:.3}),
    charcoal:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#3a3438','rgba(12,10,12,.85)')),roughness:.6,metalness:.4}),
    emberTrim:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#4a2c24','rgba(14,8,6,.85)')),roughness:.6,metalness:.35,emissive:0x9a2a08,emissiveIntensity:.12}),
    // Port palette (Neon Docklands)
    seaBlue:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#33506e','rgba(10,16,24,.85)')),roughness:.55,metalness:.4}),
    mustard:new THREE.MeshStandardMaterial({map:canvasTex(512,drawContainer('#b08030','rgba(46,32,10,.85)')),roughness:.62,metalness:.35}),
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
    lavaPool:canvasTex(512,drawLavaPool,{repeat:2}), // caldera lava surface (map+emissiveMap, UV-scrolled by worldAnim)
    // Tracer streak: transparent tail → white-hot head (cylinder v axis = direction of travel)
    streak:canvasTex(64,(g,S)=>{
      const gr=g.createLinearGradient(0,S,0,0);
      gr.addColorStop(0,'rgba(255,255,255,0)');
      gr.addColorStop(.5,'rgba(255,224,180,.3)');
      gr.addColorStop(.82,'rgba(255,240,215,.8)');
      gr.addColorStop(1,'rgba(255,255,255,1)');
      g.fillStyle=gr;g.fillRect(0,0,S,S);
    },{srgb:false}),
  };
  // AbinStudio billboard art (sponsor slot: brand + AI short-drama production + URL; bilingual, redrawn by refreshAd)
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
  // Redraw the billboard art after a language switch
  A.refreshAd=()=>{
    drawAdFront(adF.canvas.getContext('2d'),1024,512);
    drawAdBack(adB.canvas.getContext('2d'),1024,512);
    adF.tex.needsUpdate=true;
    adB.tex.needsUpdate=true;
  };
  return A;
}
