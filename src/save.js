// save.js — M4-P5 save data / progression / daily challenges:
//   · v2 layout, migrates legacy o07_best / o07_best_wave automatically;
//   · match results award XP for kills / waves; levelling up unlocks camos;
//   · 3 daily challenges per mode (date-seeded), stored locally, work offline.
const KEY='o07_save_v2';
const OPERATOR_IDS=['frost','snowwolf','swift','thunder','raven','fox','vulture','viper'];
const DAILY_MODES=['waves','pvp'];

const todayKey=(ms=Date.now())=>new Date(ms).toISOString().slice(0,10);
const nonNegInt=v=>Math.max(0,Number.isFinite(+v)?(+v|0):0);

/* Daily goals are date-seeded; ids are persisted, so keep each mode's id set stable.
   Waves has actual waves; PvP has no wave counter, so it uses the best match score instead. */
const dailyGoalsFor=(date,mode='waves')=>{
  const seed=String(date||'').split('-').reduce((a,c)=>a*31+(+c||0),7);
  const kills=8+(seed%7);
  const headshots=4+(seed%5);
  if(mode==='pvp')return [
    {id:'kills',n:kills},
    {id:'score',n:1000+(seed%5)*200},
    {id:'headshots',n:headshots},
  ];
  return [
    {id:'kills',n:kills},
    {id:'wave',n:3+(seed%3)},
    {id:'headshots',n:headshots},
  ];
};
const dailySetsFor=date=>DAILY_MODES.map(mode=>dailyGoalsFor(date,mode));
const isDailyDone=(daily,date)=>dailySetsFor(date).some(set=>set.every(g=>daily.progress[g.id]>=g.n));

/* localStorage is untrusted: rebuild the daily record instead of spreading it in.
   A null / string / NaN progress field must never reach award() or the save file. */
const cleanDaily=(raw,today)=>{
  const src=raw&&typeof raw==='object'?raw:{};
  const p=src.progress&&typeof src.progress==='object'?src.progress:{};
  const date=typeof src.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(src.date)?src.date:today;
  const progress={
    kills:nonNegInt(p.kills),
    wave:nonNegInt(p.wave),
    headshots:nonNegInt(p.headshots),
    score:nonNegInt(p.score),
  };
  const daily={date,progress,done:src.done===true};
  daily.done=isDailyDone(daily,date);
  return daily;
};

const emptyDaily=date=>({date,progress:{kills:0,wave:0,headshots:0,score:0},done:false});

const fresh=()=>({
  v:2,
  operators:Object.fromEntries(OPERATOR_IDS.map(id=>[id,{level:1,xp:0,camo:'default'}])),
  stats:{bestScore:0,bestWave:0,kills:0,playtime:0},
  unlocks:['default','desert'],
  daily:emptyDaily(''),
});

const need=level=>80+level*40;

export class SaveSystem{
  /* now: optional clock for deterministic tests (a Date.now-compatible function or a fixed ms value) */
  constructor(now=Date.now){
    this._now=typeof now==='function'?now:()=>now;
    this.data=this.load();
  }

  _today(){
    const ms=Number(this._now());
    return todayKey(Number.isFinite(ms)?ms:Date.now());
  }

  load(){
    let raw=null;
    try{raw=localStorage.getItem(KEY);}catch(e){}
    let d=fresh();
    const today=this._today();
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
          if(j.daily)d.daily=cleanDaily(j.daily,today);
        }
      }catch(e){}
    }else{
      // Legacy save migration
      try{
        d.stats.bestScore=parseInt(localStorage.getItem('o07_best')||'0',10)||0;
        d.stats.bestWave=parseInt(localStorage.getItem('o07_best_wave')||'0',10)||0;
      }catch(e){}
    }
    // Daily challenges reset by date
    if(d.daily.date!==today){
      d.daily=emptyDaily(today);
    }else{
      d.daily=cleanDaily(d.daily,today);
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

  /* Match rewards: returns XP earned and level-up info */
  award({kills=0,wave=0,headshots=0,score=0,time=0,opId='frost'}={}){
    const d=this.data;
    // A session can cross UTC midnight; start the new daily before adding this match.
    const today=this._today();
    if(!d.daily||d.daily.date!==today)d.daily=emptyDaily(today);
    else d.daily=cleanDaily(d.daily,today);
    const k=nonNegInt(kills),w=nonNegInt(wave),h=nonNegInt(headshots),s=nonNegInt(score);
    const t=Math.max(0,Math.round(time)||0);
    const xp=Math.max(0,Math.round(k*12+w*30+s/100+t/20));
    const op=d.operators[opId]||(d.operators[opId]={level:1,xp:0,camo:'default'});
    const before=op.level;
    op.xp+=xp;
    while(op.xp>=need(op.level)){
      op.xp-=need(op.level);
      op.level++;
      // Level-based camo unlocks
      if(op.level>=2&&!d.unlocks.includes('snow'))d.unlocks.push('snow');
      if(op.level>=3&&!d.unlocks.includes('urban'))d.unlocks.push('urban');
    }
    d.stats.bestScore=Math.max(d.stats.bestScore,s);
    d.stats.bestWave=Math.max(d.stats.bestWave,w);
    d.stats.kills+=k;
    d.stats.playtime+=t;
    // Daily progress
    const p=d.daily.progress;
    p.kills+=k;
    p.wave=Math.max(p.wave,w);
    p.headshots+=h;
    p.score=Math.max(p.score,s);
    d.daily.done=isDailyDone(d.daily,today);
    this.save();
    return {xp,level:op.level,leveled:op.level>before,unlocks:d.unlocks.slice()};
  }

  dailyGoals(mode='waves'){
    return dailyGoalsFor(this.data.daily.date,mode);
  }

  dailyGoalSets(){
    return dailySetsFor(this.data.daily.date);
  }
}

export {need as xpNeed};
