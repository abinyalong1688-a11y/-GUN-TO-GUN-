// portraits.js — offscreen 3D portrait renderer (roster / kill card / MVP / share card):
//   · singleton WebGLRenderer (alpha, transparent background), lazily initialised;
//   · results cached as dataURLs keyed by def.id|camo|size, no external images;
//   · GLB-only: renders nothing until the shared rigs are loaded — the UI falls back to a
//     CSS gradient placeholder while they stream in, and main.js rebuilds the roster on
//     modelAssets.onReady (no procedural character is ever drawn here);
//   · without WebGL / on init failure render() returns null and the UI falls back to a CSS gradient.
import * as THREE from 'three';
import {buildOperatorMeshGLTF} from './character.js';
import {modelAssets} from './modelAssets.js';
import {OPERATORS} from './operators.js';
import {isEN} from './i18n.js';

export class PortraitRenderer{
  constructor(assets){
    this.assets=assets;
    this.cache=new Map();
    this.renderer=null;
    this.scene=null;
    this.camera=null;
    this._failed=false;
  }

  _init(){
    if(this.renderer||this._failed)return;
    try{
      const r=new THREE.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});
      r.setPixelRatio(1);
      r.outputColorSpace=THREE.SRGBColorSpace;
      r.toneMapping=THREE.ACESFilmicToneMapping;
      r.toneMappingExposure=1.15;
      this.renderer=r;

      const scene=new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xbfd8ff,0x3a2a20,1.1));
      const key=new THREE.DirectionalLight(0xfff2e0,2.3);key.position.set(2.5,3.5,3);
      const fill=new THREE.DirectionalLight(0x8fb8ff,.75);fill.position.set(-3,2,1.5);
      const rim=new THREE.DirectionalLight(0xffb070,1.25);rim.position.set(0,3,-4);
      scene.add(key,fill,rim);
      this.scene=scene;

      const cam=new THREE.PerspectiveCamera(36,1,.1,10);
      cam.position.set(0,1.30,3.6);
      cam.lookAt(0,1.00,0);
      this.camera=cam;

      // C4: bust camera (menu cards: a full-body shot is unreadable in a 92px card)
      // Reframed per-render from the built model's headY — works for both rig heights
      const bust=new THREE.PerspectiveCamera(36,1,.1,10);
      this.bustCam=bust;
    }catch(e){
      this._failed=true;
    }
  }

  /* Returns a dataURL, or null on failure; frame: 'full' body / 'bust'.
     GLB-only: until the shared rigs are loaded we return null (CSS placeholder) instead of
     rendering a procedural body that would be thrown away moments later. */
  render(def,camo='default',size=512,{frame='full'}={}){
    if(!modelAssets.isReady())return null;
    const key=`${modelAssets.mode()}|${def.id}|${camo}|${size}|${frame}`;
    if(this.cache.has(key))return this.cache.get(key);
    this._init();
    const cam=frame==='bust'?this.bustCam:this.camera;
    if(!this.renderer||!this.scene||!cam)return null;

    let built=null;
    try{
      this.renderer.setSize(size,size,false);
      built=buildOperatorMeshGLTF(this.assets,def,{camo});
      if(frame==='bust'){
        // Frame the skull: head centre ≈ headY - .06, camera slightly above eye line
        const hy=(built.parts.headY||1.6)-.06;
        cam.position.set(0,hy+.1,1.5);
        cam.lookAt(0,hy-.06,0);
      }
      built.group.rotation.y=-.35;
      this.scene.add(built.group);
      this.renderer.render(this.scene,cam);
      const url=this.renderer.domElement.toDataURL('image/png');
      this.scene.remove(built.group);
      built.dispose();
      built=null;
      this.cache.set(key,url);
      return url;
    }catch(e){
      if(built){
        this.scene.remove(built.group);
        built.dispose();
      }
      return null;
    }
  }

  /* M2-A7: returns the shared canvas after rendering (drawn synchronously into the share card, no async image load) */
  renderCanvas(def,camo='default',size=512,{frame='full'}={}){
    if(!modelAssets.isReady())return null;
    this._init();
    const cam=frame==='bust'?this.bustCam:this.camera;
    if(!this.renderer||!this.scene||!cam)return null;
    let built=null;
    try{
      this.renderer.setSize(size,size,false);
      built=buildOperatorMeshGLTF(this.assets,def,{camo});
      if(frame==='bust'){
        const hy=(built.parts.headY||1.6)-.06;
        cam.position.set(0,hy+.1,1.5);
        cam.lookAt(0,hy-.06,0);
      }
      built.group.rotation.y=-.35;
      this.scene.add(built.group);
      this.renderer.render(this.scene,cam);
      const canvas=this.renderer.domElement;
      this.scene.remove(built.group);
      built.dispose();
      return canvas;
    }catch(e){
      if(built){this.scene.remove(built.group);built.dispose();}
      return null;
    }
  }

  /* Roster lineup: every operator side by side on one canvas (verification / lineup captures).
     Returns the canvas, or null. size = per-card edge; each card is the bust framing. */
  renderSheet({size=300,camo='default'}={}){
    this._init();
    if(!this.renderer)return null;
    const pad=Math.round(size*.06);
    const n=OPERATORS.length;
    const labelH=Math.round(size*.14);
    const canvas=document.createElement('canvas');
    canvas.width=pad+(size+pad)*n;
    canvas.height=pad*2+size+labelH;
    const ctx=canvas.getContext('2d');
    ctx.fillStyle='#101318';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    OPERATORS.forEach((o,i)=>{
      const x=pad+i*(size+pad);
      const c=this.renderCanvas(o,camo,size,{frame:'bust'});
      if(c)ctx.drawImage(c,x,pad,size,size);
      ctx.fillStyle=o.faction==='ct'?'#7fd4ff':'#ff8a6a';
      ctx.font=`bold ${Math.round(size*.085)}px system-ui,sans-serif`;
      ctx.textAlign='center';
      ctx.fillText(isEN()?o.name.en:o.name.zh,x+size/2,pad+size+Math.round(labelH*.6));
    });
    return canvas;
  }

  dispose(){
    this.cache.clear();
    if(this.renderer){
      try{this.renderer.forceContextLoss();}catch(e){}
      this.renderer.dispose();
      this.renderer=null;
    }
    if(this.scene){
      this.scene.clear();
      this.scene=null;
    }
    this.camera=null;
    this.bustCam=null;
  }
}
