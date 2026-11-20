// portraits.js — offscreen 3D portrait renderer (roster / kill card / MVP / share card):
//   · singleton WebGLRenderer (alpha, transparent background), lazily initialised;
//   · results cached as dataURLs keyed by def.id|camo|size, no external images;
//   · without WebGL / on init failure render() returns null and the UI falls back to a CSS gradient.
import * as THREE from 'three';
import {buildOperatorMesh} from './character.js';

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
      const bust=new THREE.PerspectiveCamera(36,1,.1,10);
      bust.position.set(0,1.52,1.55);
      bust.lookAt(0,1.32,0);
      this.bustCam=bust;
    }catch(e){
      this._failed=true;
    }
  }

  /* Returns a dataURL, or null on failure; frame: 'full' body / 'bust' */
  render(def,camo='default',size=512,{frame='full'}={}){
    const key=`${def.id}|${camo}|${size}|${frame}`;
    if(this.cache.has(key))return this.cache.get(key);
    this._init();
    const cam=frame==='bust'?this.bustCam:this.camera;
    if(!this.renderer||!this.scene||!cam)return null;

    let built=null;
    try{
      this.renderer.setSize(size,size,false);
      built=buildOperatorMesh(this.assets,def,{camo});
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
    this._init();
    const cam=frame==='bust'?this.bustCam:this.camera;
    if(!this.renderer||!this.scene||!cam)return null;
    let built=null;
    try{
      this.renderer.setSize(size,size,false);
      built=buildOperatorMesh(this.assets,def,{camo});
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
