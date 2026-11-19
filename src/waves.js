// waves.js —— 无尽波次调度 + 补给
import * as THREE from 'three';
import {t} from './i18n.js';

const GATES=4;

export class Waves{
  constructor(game){
    this.game=game;
    this.n=0;
    this.state='idle'; // idle | intermission | active | cleared
    this.timer=0;
    this.queue=[];
    this.spawnT=0;
  }
  reset(){
    this.n=0;this.state='idle';this.queue.length=0;this.timer=1.8;
    this.state='intermission';
  }
  composition(n){
    const q=[];
    const wasp=4+Math.min(10,n+1);
    const reaper=n>=2?Math.min(6,Math.floor((n-1)*1.2)):0;
    const warden=n>=4?Math.min(3,Math.floor((n-3)/2)):0;
    for(let i=0;i<wasp;i++)q.push('WASP');
    for(let i=0;i<reaper;i++)q.push('REAPER');
    for(let i=0;i<warden;i++)q.push('WARDEN');
    // 洗牌,保证前几秒是快的 WASP
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
        this.queue=this.composition(this.n);
        this.spawnT=.6;
        this.state='active';
        g.ui.banner(t('wave_banner',{n:String(this.n).padStart(2,'0')}),t('wave_sub'));
        g.audio.waveStart();
        g.ui.setWave(this.n);
      }
    }else if(this.state==='active'){
      // 出怪节流
      if(this.queue.length){
        this.spawnT-=dt;
        if(this.spawnT<=0&&g.enemies.list.length<12){
          const type=this.queue.shift();
          const gate=g.world.spawnPoints[Math.floor(Math.random()*GATES)];
          const pos=gate.clone().add(new THREE.Vector3((Math.random()-.5)*10,0,(Math.random()-.5)*10));
          pos.y=1+Math.random()*1.5;
          const hpScale=1+.07*(this.n-1);
          g.enemies.spawn(type,pos,{hpScale});
          this.spawnT=.75+Math.random()*.7;
        }
      }else if(g.enemies.list.length===0){
        // 波次清空
        this.state='intermission';
        this.timer=6;
        const bonus=100+this.n*50;
        g.addScore(bonus,null,'清扫奖励');
        g.ui.banner(t('wave_clear'),t('supply_sub',{n:bonus}));
        g.audio.supply();
        g.weapon.addReserve(90);
        g.player.heal(25);
      }
    }
    g.ui.setRemain(this.remaining());
  }
}
