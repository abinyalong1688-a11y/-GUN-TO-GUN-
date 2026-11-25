// modes.js — King of the Hill: centre radius 8 m, two teams contest it, first to 200 points wins.
//
// Offline this class owns the score. Online it only *evaluates* the capture: the host sends a
// point tick to the Durable Object (room.addPoint) and the DO's s:score is the single source of
// truth, so two clients can never disagree about who is standing on the point.
import * as THREE from 'three';
import {t} from './i18n.js';

export class GameMode{
  constructor(game){this.game=game;this.active=false;}
  start(){this.active=true;}
  update(dt){}
  end(){this.active=false;}
}

export const KOTH_RADIUS = 8;
export const KOTH_WIN = 150;

export class KothMode extends GameMode{
  constructor(game){
    super(game);
    this.pos=new THREE.Vector3(0,0,0);
    this.radius=KOTH_RADIUS;
    this.capture=0;   // -1 ~ 1, positive means team A
    this.owner=null;
    this.score={A:0,B:0};
    this.winScore=KOTH_WIN;
    this.done=false;
    this.online=false;     // true => the DO owns the score (see update)
    this.lastTickTeam=null;
  }

  reset(){
    this.capture=0;this.owner=null;
    this.score={A:0,B:0};this.done=false;this.lastTickTeam=null;this._tick=0;
    if(this.game.ui&&this.game.ui.hideKoth)this.game.ui.hideKoth();
  }

  start(){
    super.start();
    this.reset();
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

    this.lastTickTeam=null;
    const shown=(g.dm&&g.dm.score)||this.score;
    if(this.owner){
      if(this.online){
        // Host only: one point per ~100 ms of ownership. The DO ignores anyone else.
        this._tick=(this._tick||0)+dt;
        if(this._tick>=.1){this._tick=0;this.lastTickTeam=this.owner;}
        g.ui.setKoth(this.owner,(this.capture+1)/2,Math.floor(shown.A||0),Math.floor(shown.B||0));
        return;
      }
      this.score[this.owner]+=dt*10;
      if(a>0&&b>0)this.score[this.owner]+=dt*2; // contested: faster scoring
      if(this.score[this.owner]>=this.winScore){
        this.done=true;
        g.ui.banner(this.owner==='A'?t('koth_win'):t('koth_lose'),t('koth_name'));
        if(g._endMode)g._endMode(this.owner==='A');
      }
    }
    g.ui.setKoth(this.owner,(this.capture+1)/2,Math.floor(shown.A||0),Math.floor(shown.B||0));
  }

  end(){super.end();this.game.ui.hideKoth();}
}
