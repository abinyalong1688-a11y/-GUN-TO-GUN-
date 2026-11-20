// util.js — shared helpers: HTML escaping / safe localStorage / numeric fallbacks (production hardening)

/* HTML escape: every user-controlled string (callsign etc.) must pass through this before innerHTML */
export const escHTML=s=>String(s).replace(/[&<>"']/g,c=>(
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* Safe localStorage: never throws in private mode / with storage disabled; reads and writes have fallbacks */
export const store={
  get(k,def=''){
    try{
      const v=localStorage.getItem(k);
      return v==null?def:v;
    }catch(e){return def;}
  },
  set(k,v){
    try{localStorage.setItem(k,String(v));}catch(e){}
  },
};

/* Numeric parse: dirty data (empty string / NaN) returns null; callers supply defaults with ?? */
export const num=v=>{
  const n=parseFloat(v);
  return Number.isFinite(n)?n:null;
};
