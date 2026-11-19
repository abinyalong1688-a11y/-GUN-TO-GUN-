// save.js —— M4-P5 存档 / 成长 / 每日挑战:
//   · v2 结构,自动迁移旧 o07_best / o07_best_wave;
//   · 结算按击杀/波次给 XP,升级解锁迷彩;
//   · 每日 3 个挑战(日期种子),本地存储,离线可用。
const KEY='o07_save_v2';
const OPERATOR_IDS=['frost','snowwolf','swift','thunder','raven','fox','vulture','viper'];

const fresh=()=>({
  v:2,
  operators:Object.fromEntries(OPERATOR_IDS.map(id=>[id,{level:1,xp:0,camo:'default'}])),
  stats:{bestScore:0,bestWave:0,kills:0,playtime:0},
  unlocks:['default','desert'],
  daily:{date:'',progress:{kills:0,wave:0,headshots:0},done:false},
});

const need=level=>80+level*40;

export class SaveSystem{
  constructor(){
    this.data=this.load();
  }

  load(){
    let raw=null;
    try{raw=localStorage.getItem(KEY);}catch(e){}
    let d=fresh();
    if(raw){
      try{
        const j=JSON.parse(raw);
        if(j&&j.v===2){
          if(j.operators&&typeof j.operators==='object'){
            for(const id of OPERATOR_IDS){
              const o=j.operators[id];
              if(o&&typeof o.level==='number')d.operators[id]={level:Math.max(1,o.level|0),xp:Math.max(0,o.xp|0),camo:o.camo||'default'};
            }
          }
          for(const k of ['bestScore','bestWave','kills','playtime'])
            if(typeof j.stats?.[k]==='number')d.stats[k]=Math.max(0,j.stats[k]|0);
          if(Array.isArray(j.unlocks))d.unlocks=[...new Set([...d.unlocks,...j.unlocks.filter(x=>typeof x==='string')])];
          if(j.daily&&typeof j.daily==='object')d.daily={...d.daily,...j.daily};
        }
      }catch(e){}
    }else{
      // 旧档迁移
      try{
        d.stats.bestScore=parseInt(localStorage.getItem('o07_best')||'0',10)||0;
        d.stats.bestWave=parseInt(localStorage.getItem('o07_best_wave')||'0',10)||0;
      }catch(e){}
    }
    // 每日挑战按日期重置
    const today=new Date().toISOString().slice(0,10);
    if(d.daily.date!==today){
      d.daily={date:today,progress:{kills:0,wave:0,headshots:0},done:false};
    }
    this.data=d;
    return d;
  }

  save(){
    try{localStorage.setItem(KEY,JSON.stringify(this.data));}catch(e){}
  }

  levelOf(id){
    return this.data.operators[id]||{level:1,xp:0,camo:'default'};
  }

  /* 结算奖励:返回本次获得 XP 与升级信息 */
  award({kills=0,wave=0,score=0,time=0,opId='frost'}={}){
    const d=this.data;
    const xp=Math.round(kills*12+wave*30+score/100+time/20);
    const op=d.operators[opId]||(d.operators[opId]={level:1,xp:0,camo:'default'});
    const before=op.level;
    op.xp+=xp;
    while(op.xp>=need(op.level)){
      op.xp-=need(op.level);
      op.level++;
      // 等级解锁迷彩
      if(op.level>=2&&!d.unlocks.includes('snow'))d.unlocks.push('snow');
      if(op.level>=3&&!d.unlocks.includes('urban'))d.unlocks.push('urban');
    }
    d.stats.bestScore=Math.max(d.stats.bestScore,score|0);
    d.stats.bestWave=Math.max(d.stats.bestWave,wave|0);
    d.stats.kills+=Math.max(0,kills|0);
    d.stats.playtime+=Math.max(0,Math.round(time));
    // 每日进度
    const p=d.daily.progress;
    p.kills+=Math.max(0,kills|0);
    p.wave=Math.max(p.wave,wave|0);
    const goals=this.dailyGoals();
    d.daily.done=goals.every(g=>p[g.id]>=g.n);
    this.save();
    return {xp,level:op.level,leveled:op.level>before,unlocks:d.unlocks.slice()};
  }

  dailyGoals(){
    const seed=this.data.daily.date.split('-').reduce((a,c)=>a*31+(+c||0),7);
    return [
      {id:'kills',n:8+(seed%7)},
      {id:'wave',n:3+(seed%3)},
      {id:'headshots',n:4+(seed%5)},
    ];
  }
}

export {need as xpNeed};
