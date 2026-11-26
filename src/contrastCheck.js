// contrastCheck.js — automatic "light text on a light background" detector, run by the e2e suite
// (case `contrast-no-light-on-light`) so the bug class cannot come back unnoticed.
//
//   contrastCheck({min:3}) → {fails:[...], low:[...]}
//
// For every rendered element that owns text we resolve its effective background the way the
// browser composites it: the element's background-color blended over each ancestor's until an
// opaque layer is reached (or the page backdrop #0a0c14). Text colour vs. that background gives
// a WCAG contrast ratio; below `min` is a FAIL, below `minWarn` is reported as low (advisory).
//
// Native controls get two extra rules, because the OS draws parts of them outside CSS:
//   · every <option>/<optgroup> must declare an OPAQUE background (a translucent option lets the
//     OS popup sheet — white on Windows — show through);
//   · text-bearing native fields (<select>, text <input>, <textarea>) must not rely on a
//     see-through background (autofill / OS themes repaint them).
// `root` defaults to document.body. Elements that are not rendered (display:none, zero box,
// hidden overlay) are skipped, so the caller can open one screen at a time.
const BACKDROP={r:10,g:12,b:20,a:1};
const NATIVE_FIELD=/^(SELECT|TEXTAREA)$|^INPUT$/;
const NON_TEXT_INPUT=/^(range|checkbox|radio|color|file|button|submit|reset|hidden|image)$/i;

export function parseColor(c){
  const m=typeof c==='string'&&c.match(/^rgba?\(([^)]+)\)$/i);
  if(!m)return null;
  const p=m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
  if(p.length<3||p.some((v,i)=>i<3&&Number.isNaN(v)))return null;
  return {r:p[0],g:p[1],b:p[2],a:p.length>3&&!Number.isNaN(p[3])?p[3]:1};
}
/* `top` over `under` (both 0-255, alpha 0-1) */
export function blend(top,under){
  const a=top.a+under.a*(1-top.a);
  if(a<=0)return {r:0,g:0,b:0,a:0};
  const k=c=>(c*top.a+(under[c]==null?0:under[c])*under.a*(1-top.a))/a;
  return {r:k('r'),g:k('g'),b:k('b'),a};
}
export function luminance({r,g,b}){
  const f=v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};
  return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b);
}
export function contrast(a,b){
  const la=luminance(a),lb=luminance(b);
  return (Math.max(la,lb)+0.05)/(Math.min(la,lb)+0.05);
}
const hex=c=>'#'+[c.r,c.g,c.b].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');

export function contrastCheck({min=3,minWarn=4.5,root=(typeof document!=='undefined'?document.body:null)}={}){
  const fails=[],low=[];
  if(!root||typeof getComputedStyle!=='function')return {fails,low};
  const cs=el=>getComputedStyle(el);
  const shown=el=>{
    for(let e=el;e&&e!==root.parentElement;e=e.parentElement){
      const s=cs(e);
      if(s.display==='none'||s.visibility==='hidden')return false;
    }
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0;
  };
  /* effective background of `el`: its own layers over its ancestors', stopped at the first opaque one */
  const bgOf=el=>{
    let out=null;
    for(let e=el;e&&e.nodeType===1;e=e.parentElement){
      const c=parseColor(cs(e).backgroundColor);
      if(c&&c.a>0){out=out?blend(c,out):c;if(out.a>=0.995)return out;}
    }
    return out?blend(out,BACKDROP):BACKDROP;
  };
  const ownText=el=>{
    let s='';
    for(const n of el.childNodes)if(n.nodeType===3)s+=n.textContent;
    return s.trim();
  };
  const label=el=>{
    const id=el.id?'#'+el.id:'';
    const cls=typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\s+/).slice(0,2).join('.'):'';
    return el.tagName.toLowerCase()+id+cls;
  };

  /* 1. rendered text */
  const all=root.querySelectorAll('*');
  for(const el of all){
    if(el.closest('script,style,noscript'))continue;
    const text=ownText(el);
    if(!text||!shown(el))continue;
    const s=cs(el);
    const fg=parseColor(s.color);
    if(!fg)continue;
    const bg=bgOf(el);
    const ratio=contrast(fg,bg);
    const size=parseFloat(s.fontSize)||16;
    const bold=parseInt(s.fontWeight,10)>=700;
    const large=size>=24||(bold&&size>=18.66);
    const rec={el:label(el),text:text.slice(0,28),color:hex(fg),bg:hex(bg),ratio:+ratio.toFixed(2),size};
    if(ratio<(large?min*0.67:min))fails.push(rec);
    else if(ratio<minWarn)low.push(rec);
  }

  /* 2. native controls the OS repaints */
  for(const el of root.querySelectorAll('select option, select optgroup')){
    if(!shown(el.closest('select')||el))continue;
    const s=cs(el),bg=parseColor(s.backgroundColor),fg=parseColor(s.color);
    const rec={el:label(el),text:(el.textContent||'').trim().slice(0,28)};
    if(!bg||bg.a<0.99){fails.push({...rec,why:'option background is not opaque (OS popup sheet shows through)'});continue;}
    if(fg){const ratio=contrast(fg,bg);rec.color=hex(fg);rec.bg=hex(bg);rec.ratio=+ratio.toFixed(2);
      if(ratio<minWarn)fails.push({...rec,why:'option text on option background'});}
  }
  for(const el of root.querySelectorAll('select, textarea, input')){
    if(el.tagName==='INPUT'&&NON_TEXT_INPUT.test(el.type||''))continue;
    if(!shown(el))continue;
    const s=cs(el),bg=parseColor(s.backgroundColor);
    if(!bg||bg.a<0.99){
      // an opaque ANCESTOR is not enough: autofill / OS theme repaints the field itself
      fails.push({el:label(el),why:'native field without an opaque background of its own'});
    }
  }
  return {fails,low};
}
