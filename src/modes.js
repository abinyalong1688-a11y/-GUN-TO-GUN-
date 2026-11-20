// modes.js — M4-P4 King of the Hill: centre radius 8 m, two teams contest it, first to 200 points wins.
import * as THREE from 'three';
import {t} from './i18n.js';

export class GameMode{
  constructor(game){this.game=game;this.active=false;}
  start(){this.active=true;}
  update(dt){}
  end(){this.active=false;}
}

export class KothMode extends GameMode{
  constructor(game){
    super(game);
    this.pos=new THREE.Vector3(0,0,0);
    this.radius=8;
    this.capture=0;   // -1 ~ 1, positive means team A
    this.owner=null;
    this.score={A:0,B:0};
    this.winScore=200;
    this.done=false;
  }

  start(){
    super.start();
    this.capture=0;this.owner=null;
    this.score={A:0,B:0};this.done=false;
  }

  _inside(pos){
    const dx=pos.x-this.pos.x,dz=pos.z-this.pos.z;
    return dx*dx+dz*dz<=this.radius*this.radius;
  }

  update(dt){
    if(!this.active||this.done)return;
    const g=this.game;
    let a=0,b=0;
    if(g.player.alive&&this._inside(g.player.pos))a++;
    for(const h of g.heroes.list){
      if(!h.alive||!this._inside(h.pos))continue;
      if(h.team==='A')a++;else b++;
    }
    const diff=a-b;
    if(diff>0)this.capture=Math.min(1,this.capture+dt*.32*Math.min(3,diff));
    else if(diff<0)this.capture=Math.max(-1,this.capture+dt*.32*Math.max(-3,diff));
    if(this.capture>=1)this.owner='A';
    else if(this.capture<=-1)this.owner='B';

    if(this.owner){
      this.score[this.owner]+=dt*10;
      if(a>0&&b>0)this.score[this.owner]+=dt*2; // contested: faster scoring
      if(this.score[this.owner]>=this.winScore){
        this.done=true;
        g.ui.banner(this.owner==='A'?t('koth_win'):t('koth_lose'),t('koth_name'));
        if(g._endMode)g._endMode(this.owner==='A');
      }
    }
    g.ui.setKoth(this.owner,(this.capture+1)/2,Math.floor(this.score.A),Math.floor(this.score.B));
  }

  end(){super.end();this.game.ui.hideKoth();}
}
