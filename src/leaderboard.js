// leaderboard.js — M4-P8 optional global leaderboard (off by default):
//   · zero external requests while off; when on, only callsign + score are sent; failures are silent;
//   · adapter interface: set an endpoint to plug in a Cloudflare Worker / Supabase backend.
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

  /* No request at all when disabled or without an endpoint */
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
