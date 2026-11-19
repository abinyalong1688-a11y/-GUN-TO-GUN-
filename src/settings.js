// settings.js —— 设置中心:
//   · 统一 schema + 点路径读写(crosshair.color 等);
//   · 所有数值 clamp,脏 JSON 静默回退默认值;
//   · 首次启动迁移旧 key(o07_sens / o07_vol / o07_quality)。
import {store,num} from './util.js';

const KEY='o07_settings_v2';

export const DEFAULTS={
  sens:1,adsSens:1,volume:.8,sfx:.9,music:.6,fov:106,
  crosshair:{color:'#7fe3ff',size:4,gap:6,dot:true},
  yInvert:false,crouchToggle:false,quality:'high',
  radar:true,botDifficulty:'normal',
  reduceMotion:false,colorblind:false,adsToggle:false,
  uiScale:100,
};

const clone=o=>JSON.parse(JSON.stringify(o));
const LIMITS={
  sens:[.3,2.2],adsSens:[.5,1.5],volume:[0,1],sfx:[0,1],music:[0,1],
  fov:[70,110],uiScale:[90,120],
  'crosshair.size':[2,8],'crosshair.gap':[0,20],
};

function clampNumber(path,v){
  const lim=LIMITS[path];
  if(!lim)return null;
  const n=num(v);
  if(n==null)return null;
  return Math.min(lim[1],Math.max(lim[0],n));
}

function sanitize(raw){
  const d=clone(DEFAULTS);
  if(!raw||typeof raw!=='object')return d;
  for(const k of ['sens','adsSens','volume','sfx','music','fov','uiScale']){
    const n=clampNumber(k,raw[k]);
    if(n!=null)d[k]=n;
  }
  for(const k of ['yInvert','crouchToggle','radar','reduceMotion','colorblind','adsToggle']){
    if(typeof raw[k]==='boolean')d[k]=raw[k];
  }
  if(raw.quality==='low'||raw.quality==='high')d.quality=raw.quality;
  if(['easy','normal','hard'].includes(raw.botDifficulty))d.botDifficulty=raw.botDifficulty;
  const c=raw.crosshair;
  if(c&&typeof c==='object'){
    if(typeof c.color==='string'&&/^#[0-9a-f]{6}$/i.test(c.color))d.crosshair.color=c.color;
    const s=clampNumber('crosshair.size',c.size);if(s!=null)d.crosshair.size=s;
    const g=clampNumber('crosshair.gap',c.gap);if(g!=null)d.crosshair.gap=g;
    if(typeof c.dot==='boolean')d.crosshair.dot=c.dot;
  }
  return d;
}

/* 旧 key 迁移:只在没有 v2 存档时读取一次 */
function legacy(){
  const out={};
  const sens=num(store.get('o07_sens'));if(sens!=null)out.sens=sens;
  const vol=num(store.get('o07_vol'));if(vol!=null)out.volume=vol;
  const q=store.get('o07_quality');if(q)out.quality=q;
  return out;
}

export const settings={
  data:clone(DEFAULTS),

  load(){
    let raw=null;
    try{raw=JSON.parse(store.get(KEY,'')||'null');}catch(e){raw=null;}
    if(!raw||typeof raw!=='object'){
      const old=legacy();
      raw=Object.keys(old).length?old:null;
    }
    this.data=sanitize(raw);
    this.save();
    return this.data;
  },

  save(){
    store.set(KEY,JSON.stringify(this.data));
    return this.data;
  },

  get(path){
    if(!path)return this.data;
    let cur=this.data;
    for(const k of path.split('.')){
      if(cur==null)return undefined;
      cur=cur[k];
    }
    return cur;
  },

  set(path,v){
    if(!path)return undefined;
    const keys=path.split('.');
    const last=keys.pop();
    const lim=LIMITS[path];
    if(lim){
      const n=clampNumber(path,v);
      if(n==null)return undefined;
      v=n;
    }else if(path==='quality'){
      v=v==='low'?'low':'high';
    }else if(path==='botDifficulty'){
      if(!['easy','normal','hard'].includes(v))v='normal';
    }else if(path==='crosshair.color'){
      if(!/^#[0-9a-f]{6}$/i.test(String(v)))return undefined;
      v=String(v);
    }
    let cur=this.data;
    for(const k of keys){
      if(!cur[k]||typeof cur[k]!=='object')cur[k]={};
      cur=cur[k];
    }
    cur[last]=v;
    this.save();
    return v;
  },

  reset(){
    this.data=clone(DEFAULTS);
    this.save();
    return this.data;
  },
};
