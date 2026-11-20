// input-touch.js — M4-P1 touch support:
//   left virtual stick writes WASD, right-side drag writes look, buttons write fire / aim / reload / jump / crouch / switch / grenade;
//   light aim assist within 6° can be disabled in settings; ?touch=1 forces it on desktop for testing.
import * as THREE from 'three';

const DIRS=['KeyW','KeyA','KeyS','KeyD'];

export class TouchAdapter{
  constructor(game){
    this.game=game;
    this.stickId=null;this.lookId=null;
    this.dx=0;this.dy=0;
    this._handlers=[];
    this._assistDir=new THREE.Vector3();
    this._assistTo=new THREE.Vector3();
  }

  _on(el,type,fn){
    if(!el)return;
    el.addEventListener(type,fn,{passive:false});
    this._handlers.push([el,type,fn]);
  }

  attach(){
    const g=this.game;
    const root=document.getElementById('touch-ui');
    if(!root)return;
    root.classList.remove('hidden');
    const stick=document.getElementById('touch-stick');
    const knob=stick&&stick.querySelector('i');
    const look=document.getElementById('touch-look');

    const setMove=(x,y)=>{
      const dead=.18;
      this.dx=Math.abs(x)<dead?0:x;this.dy=Math.abs(y)<dead?0:y;
      for(const k of DIRS)g.keys.delete(k);
      if(this.dy<-.18)g.keys.add('KeyW');
      if(this.dy>.18)g.keys.add('KeyS');
      if(this.dx<-.18)g.keys.add('KeyA');
      if(this.dx>.18)g.keys.add('KeyD');
      if(knob)knob.style.transform=`translate(${this.dx*34}px,${this.dy*34}px)`;
    };

    if(stick){
      this._on(stick,'pointerdown',e=>{
        e.preventDefault();this.stickId=e.pointerId;
        stick.setPointerCapture(e.pointerId);
      });
      this._on(stick,'pointermove',e=>{
        if(e.pointerId!==this.stickId)return;
        e.preventDefault();
        const r=stick.getBoundingClientRect();
        const x=(e.clientX-r.left-r.width/2)/(r.width/2);
        const y=(e.clientY-r.top-r.height/2)/(r.height/2);
        setMove(Math.max(-1,Math.min(1,x)),Math.max(-1,Math.min(1,y)));
      });
      const end=e=>{
        if(e.pointerId!==this.stickId)return;
        this.stickId=null;setMove(0,0);
      };
      this._on(stick,'pointerup',end);
      this._on(stick,'pointercancel',end);
    }

    if(look){
      let lastX=0,lastY=0;
      this._on(look,'pointerdown',e=>{
        e.preventDefault();this.lookId=e.pointerId;lastX=e.clientX;lastY=e.clientY;
        look.setPointerCapture(e.pointerId);
      });
      this._on(look,'pointermove',e=>{
        if(e.pointerId!==this.lookId)return;
        e.preventDefault();
        g.applyLook((e.clientX-lastX)*1.6,(e.clientY-lastY)*1.6);
        lastX=e.clientX;lastY=e.clientY;
      });
      const end=e=>{if(e.pointerId===this.lookId)this.lookId=null;};
      this._on(look,'pointerup',end);
      this._on(look,'pointercancel',end);
    }

    for(const btn of document.querySelectorAll('#touch-acts button')){
      const act=btn.dataset.act;
      this._on(btn,'pointerdown',e=>{
        e.preventDefault();
        if(g.state!=='playing')return;
        if(act==='fire'){g.input.firing=true;g._mouseFire=true;} // merged with gamepad polling so it is not overwritten
        else if(act==='ads'){g._mouseAds=!g._mouseAds;g.input.ads=g._mouseAds;}
        else if(act==='reload')g.weapon.startReload();
        else if(act==='jump'||act==='crouch')g.keys.add(act==='jump'?'Space':'ControlLeft');
        else if(act==='switch')g.weapon.switchTo((g.weapon.cur+1)%g.weapon.primaryCount);
        else if(act==='grenade')g.grenades&&g.grenades.throw('frag');
      });
      const end=e=>{
        e.preventDefault();
        if(act==='fire'){g.input.firing=false;g._mouseFire=false;}
        else if(act==='jump'||act==='crouch')g.keys.delete(act==='jump'?'Space':'ControlLeft');
      };
      this._on(btn,'pointerup',end);
      this._on(btn,'pointercancel',end);
    }

    // Portrait-orientation hint
    const hint=document.getElementById('rotate-hint');
    const check=()=>{
      if(!hint)return;
      hint.classList.toggle('show',innerHeight>innerWidth&&g.touchMode);
    };
    this._on(window,'resize',check); // tracked in _handlers so detach removes it too
    check();
  }

  /* 6° light aim assist: only nudges when the crosshair is already near a target */
  update(dt){
    const g=this.game;
    if(!g.settings.get('touchAssist')||g.state!=='playing')return;
    const cam=g.camera;
    cam.getWorldDirection(this._assistDir);
    let best=null,bestA=.105; // 6° in radians
    for(const e of g.enemies.list){
      if(e.dead||e.decor)continue;
      this._assistTo.copy(e.pos).sub(cam.position).normalize();
      const a=Math.acos(Math.max(-1,Math.min(1,this._assistDir.dot(this._assistTo))));
      if(a<bestA){bestA=a;best=this._assistTo;}
    }
    if(!best)return;
    // Turn the offset into a small look correction (at most 1.2° per frame)
    const k=Math.min(1,dt*6);
    const dx=(best.x-this._assistDir.x)*260*k;
    const dy=(best.y-this._assistDir.y)*-260*k;
    if(Math.hypot(dx,dy)<2)g.applyLook(dx,dy);
  }

  detach(){
    for(const [el,type,fn] of this._handlers)el.removeEventListener(type,fn);
    this._handlers.length=0;
    const root=document.getElementById('touch-ui');
    if(root)root.classList.add('hidden');
    for(const k of DIRS)this.game.keys.delete(k);
  }
}
