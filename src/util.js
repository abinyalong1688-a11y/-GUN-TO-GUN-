// util.js —— 通用工具:HTML 转义 / 安全 localStorage / 数值兜底(生产加固)

/* HTML 转义:所有用户可控字符串(昵称等)进入 innerHTML 前必须过此函数 */
export const escHTML=s=>String(s).replace(/[&<>"']/g,c=>(
  {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* 安全 localStorage:隐私模式 / 禁用存储时不抛异常,读写均有兜底 */
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

/* 数值解析:脏数据(空串/非数字)返回 null,调用方用 ?? 提供默认值 */
export const num=v=>{
  const n=parseFloat(v);
  return Number.isFinite(n)?n:null;
};
