// waves.js — endless wave scheduler + resupply
import * as THREE from 'three';
import {t} from './i18n.js';
import {store} from './util.js';

const GATES=4;
export const MODIFIERS=['fog','emp','rush'];

export class Waves{
  constructor(game){
    this.game=game;
    this.n=0;
    this.state='idle'; // idle | intermission | active | cleared
    this.timer=0;
    this.queue=[];
    this.spawnT=0;
    this.modifier=null;
    this._fogBase=null;
  }
  reset(){
    this.n=0;this.state='idle';this.queue.length=0;this.timer=1.8;
    this.state='intermission';
    this._restoreFog();
    if(this.game.ui&&this.game.ui.hideBoss)this.game.ui.hideBoss();
    this.modifier=null;
  }
  _restoreFog(){
    if(this._fogBase!=null&&this.game.scene.fog){
      this.game.scene.fog.density=this._fogBase;
      this._fogBase=null;
    }
  }
  composition(n){
    const q=[];
    const wasp=4+Math.min(10,n+1);
    const reaper=n>=2?Math.min(6,Math.floor((n-1)*1.2)):0;
    const warden=n>=4?Math.min(3,Math.floor((n-3)/2)):0;
    for(let i=0;i<wasp;i++)q.push('WASP');
    for(let i=0;i<reaper;i++)q.push('REAPER');
    for(let i=0;i<warden;i++)q.push('WARDEN');
    // M3-G4: boss every 5 waves
    if(n%5===0)q.push('BOSS');
    // Shuffle so the first few seconds bring the fast WASPs
    for(let i=q.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[q[i],q[j]]=[q[j],q[i]];}
    return q;
  }
  remaining(){return this.game.enemies.list.length+this.queue.length;}

  update(dt){
    const g=this.game;
    if(this.state==='intermission'){
      this.timer-=dt;
      if(this.timer<=0){
        this.n++;
        const bestWave=parseInt(store.get('o07_best_wave','0'),10)||0;
        if(this.n>bestWave)store.set('o07_best_wave',this.n);
        this.queue=this.composition(this.n);
        this.spawnT=.6;
        this.state='active';
        g.ui.banner(t('wave_banner',{n:String(this.n).padStart(2,'0')}),t('wave_sub'));
        g.audio.waveStart();
        g.ui.setWave(this.n);
        if(this.n%5===0){
          this.modifier=MODIFIERS[Math.floor(Math.random()*MODIFIERS.length)];
          g.ui.banner(t('boss_name'),t('mod_'+this.modifier));
          if(this.modifier==='fog'&&g.scene.fog){
            this._fogBase=g.scene.fog.density;
            g.scene.fog.density=this._fogBase*1.8;
          }
          if(this.modifier==='emp')g.empT=999;
        }
      }
    }else if(this.state==='active'){
      // Spawn throttling
      if(this.queue.length){
        this.spawnT-=dt;
        if(this.spawnT<=0&&g.enemies.list.length<12){
          const type=this.queue.shift();
          const gate=g.world.spawnPoints[Math.floor(Math.random()*GATES)];
          const pos=gate.clone().add(new THREE.Vector3((Math.random()-.5)*10,0,(Math.random()-.5)*10));
          pos.y=1+Math.random()*1.5;
          const hpScale=1+.07*(this.n-1);
          if(type==='BOSS'){
            const boss=g.enemies.spawn('WARDEN',pos,{hpScale:4});
            boss.boss=true;boss.phase=1;
            g.ui.setBoss(1,t('boss_name'));
          }else g.enemies.spawn(type,pos,{hpScale});
          this.spawnT=(.75+Math.random()*.7)*(this.modifier==='rush'?.7:1);
        }
      }else if(g.enemies.list.length===0){
        // Wave cleared
        this.state='intermission';
        this.timer=6;
        const bonus=100+this.n*50;
        g.addScore(bonus,null); // wave-clear bonus (3rd arg is the crit flag; a label string here made it render as a crit)
        g.ui.banner(t('wave_clear'),t('supply_sub',{n:bonus}));
        g.audio.supply();
        g.weapon.addReserve(90);
        g.player.heal(25);
        this._restoreFog();
        this.modifier=null;   // a rush/fog modifier lasts its wave only (rush used to leak into every later wave)
        g.empT=0;if(g.ui&&g.ui.hideBoss)g.ui.hideBoss();
        // M3-G3: offer a pick-one-of-three upgrade after every 3rd cleared wave
        if(this.n%3===0)g.openUpgrade();
      }
    }
    g.ui.setRemain(this.remaining());
  }
}
