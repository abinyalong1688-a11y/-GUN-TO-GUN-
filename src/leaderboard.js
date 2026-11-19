// leaderboard.js —— M4-P8 可选全球榜(默认关闭):
//   · 关闭时零外部请求;开启时仅发送昵称+分数;失败静默;
//   · 适配器接口:配置 endpoint 即可对接 Cloudflare Worker / Supabase。
const KEY='o07_leaderboard_optin';

export class Leaderboard{
  constructor(settings){
    this.settings=settings;
    this.endpoint='';
    this.enabled=this.optIn();
  }

  optIn(){try{return localStorage.getItem(KEY)==='1';}catch(e){return false;}}
  setEnabled(v){
    this.enabled=!!v;
    try{localStorage.setItem(KEY,v?'1':'0');}catch(e){}
  }

  /* 关闭或无端点时不发起任何请求 */
  async submit(name,score){
    if(!this.enabled||!this.endpoint)return {ok:false,reason:'disabled'};
    try{
      const r=await fetch(this.endpoint,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:String(name).slice(0,16),score:Math.max(0,score|0)}),
      });
      if(!r.ok)return {ok:false,reason:'http'};
      return {ok:true,data:await r.json().catch(()=>null)};
    }catch(e){return {ok:false,reason:'network'};}
  }

  async fetchTop(limit=10){
    if(!this.enabled||!this.endpoint)return [];
    try{
      const r=await fetch(this.endpoint+'?limit='+limit);
      if(!r.ok)return [];
      const j=await r.json();
      return Array.isArray(j)?j:[];
    }catch(e){return [];}
  }
}
