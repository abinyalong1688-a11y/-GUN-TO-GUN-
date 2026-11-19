// portraits.js —— 离屏 3D 立绘渲染器(名册 / 击杀卡 / MVP / 分享卡共用):
//   · 单例 WebGLRenderer(alpha, 透明背景),懒初始化;
//   · 结果按 def.id|camo|size 缓存为 dataURL,零外部图片;
//   · 无 WebGL / 初始化失败时 render() 返回 null,UI 用 CSS 渐变兜底。
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

      // C4:半身立绘机位(菜单卡用,避免全身像在 92px 卡片里看不清)
      const bust=new THREE.PerspectiveCamera(36,1,.1,10);
      bust.position.set(0,1.52,1.55);
      bust.lookAt(0,1.32,0);
      this.bustCam=bust;
    }catch(e){
      this._failed=true;
    }
  }

  /* 返回 dataURL;失败返回 null;frame: 'full' 全身 / 'bust' 半身 */
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

  /* M2-A7:返回渲染后的共享 canvas(同步绘制到分享卡,避免异步图片加载) */
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
