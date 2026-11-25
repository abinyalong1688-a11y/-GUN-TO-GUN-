// ui.js — HUD / menu (callsign + operator + map + mode) / pause / results / killfeed / scoreboard
import * as THREE from 'three';
import {escHTML,store} from './util.js';
import {t,isEN} from './i18n.js';
import {OPERATORS,byId,byFaction,CAMOS,DEFAULT_OP} from './operators.js';

const $=id=>document.getElementById(id);

/* Primary weapon catalogue (per faction, bilingual names) */
const PRIMARIES={
  ct:[{id:'m4a4',n:'M4A4'},{id:'aug',n:'AUG · 瞄准镜',nEn:'AUG · Scoped'},{id:'awp',n:'长弓 · 重狙',nEn:'LONGBOW · Sniper'},{id:'mp5',n:'MP5'}],
  t:[{id:'ak47',n:'AK-47'},{id:'sg553',n:'SG 553 · 瞄准镜',nEn:'SG 553 · Scoped'},{id:'awp',n:'长弓 · 重狙',nEn:'LONGBOW · Sniper'},{id:'mp5',n:'MP5'}],
};

export class UI{
  constructor(){
    this.el={
      hud:$('hud'),menu:$('menu'),pause:$('pause'),over:$('over'),
      lobby:$('lobby'),netPill:$('net-pill'),pLeave:$('p-leave'),oRematch:$('o-rematch'),
      wave:$('ui-wave'),remain:$('ui-remain'),score:$('ui-score'),
      xh:$('xh'),hitmark:$('hitmark'),
      ammo:$('ui-ammo'),reserve:$('ui-reserve'),weapon:$('ui-weapon'),
      hpfill:$('hpfill'),hp:$('ui-hp'),heroRole:$('hero-role'),
      banner:$('banner'),bannerMain:$('banner-main'),bannerSub:$('banner-sub'),
      hint:$('hint'),pops:$('pops'),
      dmg:$('dmg-vignette'),lowhp:$('lowhp'),flash:$('flash-white'),
      reloadRing:$('reload-ring'),rrArc:$('rr-arc'),
      mBest:$('m-best'),oStats:$('o-stats'),oBest:$('o-best'),
      oKicker:$('o-kicker'),oTitle:$('o-title'),oBoard:$('o-board'),oMvp:$('o-mvp'),
      debug:$('debug'),
      dmTop:$('dm-top'),dmTimer:$('dm-timer'),dmA:$('dm-a'),dmB:$('dm-b'),
      killfeed:$('killfeed'),barks:$('barks'),board:$('board'),
      dmgDir:$('dmg-dir'),combo:$('combo-callout'),
      mOperators:$('m-operators'),mCamos:$('m-camos'),
      koth:{bar:$('koth-bar'),name:$('koth-name'),fill:$('koth-fill'),score:$('koth-score')},
  progress:$('m-progress'),
      wslots:[...document.querySelectorAll('.wslot')],
      grenades:{frag:$('g-frag'),flash:$('g-flash'),smoke:$('g-smoke')},
      fragBadge:$('tb-frag'),
      scope:$('scope-overlay'),
    };
    this.bannerT=0;
    this.dmgLevel=0;
    this.popPool=[];
    for(let i=0;i<10;i++){
      const d=document.createElement('div');
      d.className='pop';d.style.display='none';
      this.el.pops.appendChild(d);
      this.popPool.push({el:d,t:0,life:0,pos:new THREE.Vector3()});
    }
    this.kfPool=[];
    for(let i=0;i<4;i++){
      const d=document.createElement('div');
      d.className='kf';d.style.display='none';
      this.el.killfeed.appendChild(d);
      this.kfPool.push({el:d,t:0});
    }
    // M2-A2: radio bark pool (4 reused slots, no per-line DOM allocation)
    this.barkPool=[];
    for(let i=0;i<4;i++){
      const d=document.createElement('div');
      d.className='bk';d.style.display='none';
      if(this.el.barks)this.el.barks.appendChild(d);
      this.barkPool.push({el:d,t:0});
    }
    this._barkIdx=0;
    this.errors=[];
    this._pv=new THREE.Vector3(); // reused for per-frame score popups
    this.dmgDirT=0;this.comboT=0;
    // Menu selection state (validates persisted values; dirty data falls back to defaults)
    // The roster is online-only now: koth (3v3) and dm (5v5); waves is single-player offline.
    const MOK=['desert','snow','snowtown','ember'],KOK=['waves','koth','dm'];
    const m=store.get('o07_map'),k=store.get('o07_mode');
    const p=store.get('o07_primary');
    const op=byId(store.get('o07_operator'))||byId(DEFAULT_OP);
    this.sel={
      hero:op.faction,
      operator:op.id,
      camo:'default',
      map:MOK.includes(m)?m:'desert',
      mode:KOK.includes(k)?k:'dm',
      primary:['m4a4','aug','awp','mp5','sg553','ak47'].includes(p)?p:'m4a4',
    };
    // Match operator and primary to the faction + restore the saved camo (C4/C5: still selected after a refresh)
    if(!PRIMARIES[this.sel.hero].some(w=>w.id===this.sel.primary)){
      this.sel.primary=PRIMARIES[this.sel.hero][0].id;
    }
    this.sel.camo=this.camoOf(op);
  }

  /* ---------- Menu selection ---------- */
  bindMenu(onChange){
    const s=this.sel;
    this._onChange=onChange;
    // Primary chips are rebuilt per faction (AUG is Nova-only)
    const buildPrimaries=()=>{
      const box=$('m-primaries');
      if(!box)return;
      box.innerHTML=PRIMARIES[s.hero].map(p=>{
        const label=isEN()&&p.nEn?p.nEn:p.n;
        return `<div class="chip${p.id===s.primary?' selected':''}" data-primary="${p.id}">${label}</div>`;
      }).join('');
      box.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
        s.primary=c.dataset.primary;store.set('o07_primary',s.primary);buildPrimaries();
      }));
    };
    this.buildPrimaries=buildPrimaries; // rebuilt on language switch
    const refresh=()=>{
      document.querySelectorAll('#m-maps .chip').forEach(c=>c.classList.toggle('selected',c.dataset.map===s.map));
      document.querySelectorAll('#m-modes .chip').forEach(c=>c.classList.toggle('selected',c.dataset.mode===s.mode));
      buildPrimaries();
      this.buildOperators();
    };
    this.refreshMenu=refresh;
    // C4: operator cards / camo chips (event delegation, no rebinding after a rebuild)
    if(this.el.mOperators)this.el.mOperators.addEventListener('click',e=>{
      const card=e.target.closest('.op-card');
      if(card)this.selectOperator(card.dataset.op);
    });
    if(this.el.mCamos)this.el.mCamos.addEventListener('click',e=>{
      const chip=e.target.closest('.camo-chip');
      if(!chip||chip.classList.contains('locked'))return;
      this.setCamo(chip.dataset.camo);
    });
    document.querySelectorAll('#m-maps .chip').forEach(c=>c.addEventListener('click',()=>{
      s.map=c.dataset.map;store.set('o07_map',s.map);refresh();onChange&&onChange();
    }));
    document.querySelectorAll('#m-modes .chip').forEach(c=>c.addEventListener('click',()=>{
      s.mode=c.dataset.mode;store.set('o07_mode',s.mode);refresh();onChange&&onChange();
    }));
    refresh();
    $('m-name').value=store.get('o07_name');
    this.applyTheme(byId(s.operator)?.faction||'ct');
  }

  /* ---------- C4 operator roster ---------- */
  camoNeed(camo){return {default:0,desert:0,snow:5,urban:10}[camo]||0;}
  camoLocked(camo){
    const best=parseInt(store.get('o07_best_wave','0'),10)||0;
    return best<this.camoNeed(camo);
  }
  camoOf(op){
    let c=store.get('o07_camo_'+op.id)||'default';
    if(!CAMOS[c]||this.camoLocked(c))c='default';
    return c;
  }
  buildOperators(){
    const box=this.el.mOperators;
    if(!box)return;
    const s=this.sel;
    const html=[];
    for(const f of ['ct','t']){
      html.push(`<div class="op-group"><div class="op-group-t"><span class="${f==='ct'?'tA':'tB'}">${t('faction_'+f)}</span> · ${byFaction(f).length}</div><div class="op-row">`);
      for(const o of byFaction(f)){
        const camo=this.camoOf(o);
        const url=this.portraits?this.portraits.render(o,camo,256,{frame:'bust'}):null;
        const name=isEN()?o.name.en:o.name.zh;
        const role=isEN()?o.role.en:o.role.zh;
        const selected=o.id===s.operator;
        const speed=(5.2*o.speedMul).toFixed(1);
        html.push(`<div class="op-card ${f}${selected?' selected':''}${url?'':' no-art'}" data-op="${o.id}">
          <div class="op-portrait"${url?` style="background-image:url('${url}')"`:''}><span class="op-faction">${t('faction_'+f)}</span></div>
          <div class="op-name">${escHTML(name)}</div>
          <div class="op-role">${escHTML(role)}</div>
          <div class="op-stats">${t('op_hp')} ${o.hp} · ${t('op_speed')} ${speed}</div>
        </div>`);
      }
      html.push('</div></div>');
    }
    box.innerHTML=html.join('');
    this.buildCamos();
  }
  buildCamos(){
    const box=this.el.mCamos;
    const op=byId(this.sel.operator);
    if(!box||!op)return;
    box.innerHTML=`<span class="camo-label">${t('op_camo')}</span>`+Object.keys(CAMOS).map(c=>{
      const locked=this.camoLocked(c);
      const label=t('camo_'+c);
      const title=locked?t('camo_locked',{n:this.camoNeed(c)}):label;
      return `<div class="camo-chip${c===this.sel.camo?' selected':''}${locked?' locked':''}" data-camo="${c}" title="${escHTML(title)}">${label}</div>`;
    }).join('');
  }
  selectOperator(id){
    const op=byId(id);
    if(!op)return;
    const s=this.sel;
    s.operator=op.id;s.hero=op.faction;
    store.set('o07_operator',op.id);
    store.set('o07_hero',op.faction);
    // Validate the primary after a faction switch
    if(!PRIMARIES[s.hero].some(p=>p.id===s.primary)){
      s.primary=PRIMARIES[s.hero][0].id;store.set('o07_primary',s.primary);
    }
    s.camo=this.camoOf(op);
    this.applyTheme(op.faction);
    this.refreshMenu?this.refreshMenu():this.buildOperators();
    this._onChange&&this._onChange();
  }
  setCamo(camo){
    if(!CAMOS[camo]||this.camoLocked(camo))return;
    const op=byId(this.sel.operator);
    if(!op)return;
    this.sel.camo=camo;
    store.set('o07_camo_'+op.id,camo);
    this.buildOperators();
  }
  applyTheme(faction){
    const root=document.documentElement.style;
    const ct=faction!=='t';
    root.setProperty('--accent',ct?'#7fd4ff':'#ff8a6a');
    root.setProperty('--line',ct?'rgba(127,212,255,.35)':'rgba(255,138,106,.35)');
  }

  /* ---------- U1 settings panel ---------- */
  bindSettings(settings,onChange){
    this.settings=settings;
    const el=id=>document.getElementById(id);
    const bind=(id,path,labelId,fmt)=>{
      const c=el(id);
      if(!c)return;
      c.addEventListener('input',()=>{
        const raw=c.type==='checkbox'?c.checked:c.value;
        const val=settings.set(path,raw);
        if(val===undefined)return;
        if(labelId){const l=el(labelId);if(l)l.textContent=fmt?fmt(val):val;}
        if(path.startsWith('crosshair.'))this.applyCrosshair();
        onChange&&onChange(path,val);
      });
    };
    bind('p-sens','sens','p-sens-v',v=>Number(v).toFixed(2));
    bind('p-ads','adsSens','p-ads-v',v=>Number(v).toFixed(2));
    bind('p-fov','fov','p-fov-v');
    bind('p-vol','volume','p-vol-v',v=>Math.round(v*100)+'%');
    bind('p-sfx','sfx','p-sfx-v',v=>Math.round(v*100)+'%');
    bind('p-music','music','p-music-v',v=>Math.round(v*100)+'%');
    bind('p-xh-color','crosshair.color');
    bind('p-xh-size','crosshair.size','p-xh-size-v');
    bind('p-xh-gap','crosshair.gap','p-xh-gap-v');
    bind('p-yinv','yInvert');
    bind('p-crouch','crouchToggle');
    bind('p-ads-toggle','adsToggle');
    bind('p-touchassist','touchAssist');
    bind('p-colorblind','colorblind');
    bind('p-reduce-motion','reduceMotion');
    bind('p-subtitles','subtitles');
    bind('p-ui-scale','uiScale','p-ui-scale-v',v=>v+'%');
    const reset=el('p-reset');
    if(reset)reset.addEventListener('click',()=>{
      settings.reset();
      this.syncSettings();
      this.applyCrosshair();
      onChange&&onChange('reset',true);
    });
    this.syncSettings();
    this.applyCrosshair();
    this.applyAccessibility();
  }
  syncSettings(){
    const s=this.settings;
    if(!s)return;
    const set=(id,v)=>{const c=document.getElementById(id);if(c)c.value=v;};
    const check=(id,v)=>{const c=document.getElementById(id);if(c)c.checked=!!v;};
    const txt=(id,v)=>{const c=document.getElementById(id);if(c)c.textContent=v;};
    set('p-sens',s.get('sens'));txt('p-sens-v',Number(s.get('sens')).toFixed(2));
    set('p-ads',s.get('adsSens'));txt('p-ads-v',Number(s.get('adsSens')).toFixed(2));
    set('p-fov',s.get('fov'));txt('p-fov-v',s.get('fov'));
    set('p-vol',s.get('volume'));txt('p-vol-v',Math.round(s.get('volume')*100)+'%');
    set('p-sfx',s.get('sfx'));txt('p-sfx-v',Math.round(s.get('sfx')*100)+'%');
    set('p-music',s.get('music'));txt('p-music-v',Math.round(s.get('music')*100)+'%');
    set('p-xh-color',s.get('crosshair.color'));
    set('p-xh-size',s.get('crosshair.size'));txt('p-xh-size-v',s.get('crosshair.size'));
    set('p-xh-gap',s.get('crosshair.gap'));txt('p-xh-gap-v',s.get('crosshair.gap'));
    check('p-yinv',s.get('yInvert'));
    check('p-crouch',s.get('crouchToggle'));
    check('p-ads-toggle',s.get('adsToggle'));
    check('p-touchassist',s.get('touchAssist'));
    check('p-colorblind',s.get('colorblind'));
    check('p-reduce-motion',s.get('reduceMotion'));
    check('p-subtitles',s.get('subtitles'));
    set('p-ui-scale',s.get('uiScale'));txt('p-ui-scale-v',s.get('uiScale')+'%');
  }
  /* M4-P7: accessibility settings apply immediately */
  applyAccessibility(){
    const s=this.settings;
    if(!s)return;
    const r=document.documentElement;
    r.style.setProperty('--ui-zoom',(s.get('uiScale')/100).toFixed(2));
    r.classList.toggle('cb',!!s.get('colorblind'));
    r.classList.toggle('reduce-motion',!!s.get('reduceMotion'));
  }
  applyCrosshair(){
    const s=this.settings;
    if(!s)return;
    const c=s.get('crosshair');
    const r=document.documentElement.style;
    r.setProperty('--xh-color',c.color);
    r.setProperty('--xh-w',c.size+'px');
    r.setProperty('--xh-len',(c.size*2)+'px');
  }
  get playerName(){
    return ($('m-name').value.trim()||t('default_name')).slice(0,10);
  }
  saveName(){store.set('o07_name',$('m-name').value.trim());}

  /* ---------- State switching ---------- */
  showOnly(name){ // 'menu'|'pause'|'over'|'lobby'|null (in game)
    for(const k of ['menu','pause','over','lobby'])
      if(this.el[k])this.el[k].classList.toggle('hidden',k!==name);
    const playing=!name;
    this.el.hud.classList.toggle('hidden',!playing);
    this.el.dmTop.classList.toggle('hidden',!playing||!this.dmMode);
  }
  setDmMode(on){
    this.dmMode=on;
    document.getElementById('topline').style.display=on?'none':'flex';
  }
  /* ---------- Online ---------- */
  setNetPill(state,text){
    const el=this.el.netPill;
    if(!el)return;
    el.className=state?('np-'+state):'hidden';
    el.textContent=text||'';
  }
  setNetMode(on){
    if(this.el.pLeave)this.el.pLeave.classList.toggle('hidden',!on);
    const note=$('pause-net-note');
    if(note)note.classList.toggle('hidden',!on);
    const restart=$('p-restart');
    if(restart)restart.classList.toggle('hidden',!!on);
  }
  updateLobby(room,meId){ if(this._netLobby)this._netLobby.render(room,meId); }
  lobbyError(key){ if(this._netLobby)this._netLobby.error(key); }
  hideLobby(){ if(this._netLobby)this._netLobby.hide(); }

  /* ---------- HUD ---------- */
  setWave(n){this.el.wave.textContent=String(n).padStart(2,'0');}
  setRemain(n){this.el.remain.textContent=n;}
  setScore(s){this.el.score.textContent=s;}
  setHero(name,role){this.el.heroRole.textContent=role;}
  setAmmo(ammo,reserve,reloading,weaponName){
    // Deduplicated DOM writes: skip when values are unchanged (hot path, called every frame)
    const key=ammo+'|'+reserve+'|'+reloading+'|'+weaponName;
    if(key===this._ammoKey)return;
    this._ammoKey=key;
    this.el.ammo.textContent=String(ammo);
    this.el.reserve.textContent=reloading?t('hud_reloading'):'/ '+reserve;
    this.el.ammo.classList.toggle('low',ammo<=8&&!reloading);
    if(weaponName)this.el.weapon.textContent=weaponName;
  }
  setSlotNames(names){
    this.el.wslots.forEach((w,i)=>{
      const sp=w.querySelector('span');
      if(sp&&names[i])sp.textContent=names[i];
    });
  }
  setScope(on){ // scope overlay
    if(this.el.scope)this.el.scope.classList.toggle('show',!!on);
  }
  weaponSlots(cur){
    this.el.wslots.forEach((w,i)=>w.classList.toggle('active',i===cur));
  }
  abilityCd(k){ // operators have no abilities: the element may be absent
    if(!this.el.ability)return;
    if(k<0){this.el.ability.classList.add('hidden');return;}
    this.el.ability.classList.remove('hidden');
    this.el.ability.classList.toggle('cooling',k<1);
    this.el.abilityCd.textContent=k>=1?t('hud_ready'):(k*100|0)+'%';
  }
  setDmScore(a,b,t){
    this.el.dmA.textContent=a;this.el.dmB.textContent=b;
    const m=Math.floor(Math.max(0,t)/60),s=Math.floor(Math.max(0,t)%60);
    this.el.dmTimer.textContent=`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  setHealth(h,max){
    const p=Math.max(0,h/max*100);
    this.el.hpfill.style.width=p+'%';
    this.el.hpfill.classList.toggle('hurt',p<35);
    this.el.hp.textContent=Math.ceil(h);
  }
  crosshair(spreadRad,fovDeg,screenH,ads){
    // Deduplicated DOM writes: skip when crosshair parameters are unchanged
    const base=this.settings?this.settings.get('crosshair.gap'):6;
    const gap=ads>.6?'0':(base+Math.tan(spreadRad)*(screenH/2)/Math.tan(fovDeg*Math.PI/180)).toFixed(1);
    const key=gap+'|'+ads;
    if(key===this._xhKey)return;
    this._xhKey=key;
    if(ads>.6){this.el.xh.style.setProperty('--op','0');return;}
    this.el.xh.style.setProperty('--op','1');
    this.el.xh.style.setProperty('--gap',gap+'px');
  }
  hitmark(crit){
    const el=this.el.hitmark;
    el.classList.remove('show','crit');
    void el.offsetWidth;
    if(crit)el.classList.add('crit');
    el.classList.add('show');
  }
  reloadRing(k){
    if(k<0){this.el.reloadRing.classList.remove('show');return;}
    this.el.reloadRing.classList.add('show');
    const C=100.5;
    this.el.rrArc.style.strokeDashoffset=(C*(1-k)).toFixed(1);
  }
  banner(main,sub){
    this.el.bannerMain.textContent=main;
    this.el.bannerSub.textContent=sub||'';
    this.el.banner.classList.add('show');
    this.bannerT=2.6;
  }
  hint(text){
    if(text){this.el.hint.textContent=text;this.el.hint.classList.add('show');}
    else this.el.hint.classList.remove('show');
  }
  killFeed(killer,victim,weapon,mine){
    const slot=this.kfPool.find(p=>p.t<=0)||this.kfPool[0];
    slot.t=4;
    slot.el.className='kf'+(mine?' me':'');
    // Callsigns are user-controlled: escape against XSS
    slot.el.innerHTML=`<b>${escHTML(killer)}</b>${weapon?` <span class="w">[${escHTML(weapon)}]</span>`:''} ${mine?'✖':t('killed')} <i>${escHTML(victim)}</i>`;
    slot.el.style.display='block';
  }
  /* M2-A2: radio barks (names from the operator def, lines from i18n) */
  bark(name,text,faction){
    const pool=this.barkPool;
    if(!pool||!pool.length)return;
    if(this.settings&&!this.settings.get('subtitles'))return;
    const slot=pool[this._barkIdx++%pool.length];
    slot.t=2.5;
    slot.el.className='bk'+(faction==='t'?' t':'');
    slot.el.textContent=`${name}: ${text}`;
    slot.el.style.display='block';
  }
  scoreboard(rows,labels={}){
    const la=labels.A||t('faction_ct'),lb=labels.B||t('faction_t');
    let html=`<h3>${t('sb_title')}</h3><table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>`;
    for(const r of rows){
      html+=`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td><td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?la:lb}</span></td><td>${r.kills}</td><td>${r.deaths}</td></tr>`;
    }
    html+='</table>';
    this.el.board.innerHTML=html;
    this.el.board.classList.remove('hidden');
  }
  hideBoard(){this.el.board.classList.add('hidden');}

  damageFlash(v){this.dmgLevel=Math.min(1,this.dmgLevel+v);}
  /* U2: damage direction indicator (angle=0 straight ahead, positive is clockwise) */
  damageDirection(angle){
    if(!this.el.dmgDir)return;
    this.lastDmgAngle=angle;
    this.el.dmgDir.style.transform=`rotate(${angle}rad)`;
    this.el.dmgDir.classList.add('show');
    this.dmgDirT=.8;
  }
  /* U3: kill streak callouts */
  combo(n){
    if(!this.el.combo)return;
    this.el.combo.textContent=t('combo_'+Math.min(5,Math.max(2,n)));
    this.el.combo.classList.remove('show');
    void this.el.combo.offsetWidth;
    this.el.combo.classList.add('show');
    this.comboT=1.1;
  }
  flashWhite(v=.85){
    const f=this.el.flash;
    if(!f)return;
    f.style.transition='none';f.style.opacity=String(v);
    requestAnimationFrame(()=>{f.style.transition='opacity .6s';f.style.opacity='0';});
  }
  /* M3-G1: grenade count HUD */
  setGrenades(counts){
    if(!counts||!this.el.grenades)return;
    const g=this.el.grenades;
    if(g.frag)g.frag.textContent=counts.frag;
    if(g.flash)g.flash.textContent=counts.flash;
    if(g.smoke)g.smoke.textContent=counts.smoke;
    if(this.el.fragBadge){
      this.el.fragBadge.textContent=counts.frag;
      this.el.fragBadge.classList.toggle('empty',counts.frag<=0);
    }
  }
  /* M4-P4: KOTH capture status bar */
  setKoth(owner,ratio,a,b){
    const k=this.el.koth;
    if(!k||!k.bar)return;
    k.bar.classList.remove('hidden');
    if(k.fill)k.fill.style.width=Math.max(0,Math.min(1,ratio))*100+'%';
    if(k.fill)k.fill.style.background=owner==='B'?'#ff8a6a':'#7fd4ff';
    if(k.name)k.name.textContent=t('koth_name');
    if(k.score)k.score.textContent=`${t('koth_a')} ${a} : ${b} ${t('koth_b')}`;
  }
  hideKoth(){
    const k=this.el.koth;
    if(k&&k.bar)k.bar.classList.add('hidden');
  }
  /* M3-G4: boss health bar */
  setBoss(ratio,name){
    const el=document.getElementById('bossbar');
    if(!el)return;
    el.classList.remove('hidden');
    const fill=document.getElementById('boss-fill');
    if(fill)fill.style.width=Math.max(0,Math.min(1,ratio))*100+'%';
    const n=document.getElementById('boss-name');
    if(n&&name)n.textContent=name;
  }
  hideBoss(){
    const el=document.getElementById('bossbar');
    if(el)el.classList.add('hidden');
  }
  deathFlash(){
    const f=this.el.flash;
    f.style.transition='none';f.style.opacity=.85;
    requestAnimationFrame(()=>{f.style.transition='opacity 1.2s';f.style.opacity=0;});
  }
  scorePop(worldPos,camera,text,crit,cls=''){
    const slot=this.popPool.find(p=>p.t<=0)||this.popPool[0];
    slot.t=slot.life=1.0;
    slot.pos.copy(worldPos);
    slot.el.textContent=text;
    slot.el.className='pop '+cls+(crit?' crit':'');
    slot.el.style.display='block';
    slot.camera=camera;
  }
  updatePops(dt){
    const v=this._pv;
    for(const p of this.popPool){
      if(p.t<=0){p.el.style.display='none';continue;}
      p.t-=dt;
      const k=1-p.t/p.life;
      v.copy(p.pos);v.y+=k*.7;
      v.project(p.camera);
      if(v.z>1){p.el.style.display='none';continue;}
      const x=(v.x*.5+.5)*100,y=(-v.y*.5+.5)*100;
      p.el.style.left=x+'%';
      p.el.style.top=y+'%';
      p.el.style.opacity=k<.15?k/.15:1-(k-.15)/.85;
    }
    for(const k of this.kfPool){
      if(k.t<=0){k.el.style.display='none';continue;}
      k.t-=dt;
      if(k.t<=0)k.el.style.display='none';
    }
  }
  update(dt,health,max){
    if(this.bannerT>0){this.bannerT-=dt;if(this.bannerT<=0)this.el.banner.classList.remove('show');}
    if(this.dmgDirT>0){this.dmgDirT-=dt;if(this.dmgDirT<=0)this.el.dmgDir&&this.el.dmgDir.classList.remove('show');}
    if(this.comboT>0){this.comboT-=dt;if(this.comboT<=0)this.el.combo&&this.el.combo.classList.remove('show');}
    this.dmgLevel=Math.max(0,this.dmgLevel-dt*1.6);
    if(this.barkPool)for(const p of this.barkPool){
      if(p.t>0){p.t-=dt;if(p.t<=0)p.el.style.display='none';}
    }
    const low=Math.max(0,1-health/max*2.2)*(0.55+Math.sin(performance.now()*.006)*.2);
    this.el.dmg.style.opacity=Math.min(1,this.dmgLevel+low*.7);
    this.el.lowhp.style.opacity=health<35?low:0;
    this.updatePops(dt);
  }

  /* ---------- Results ---------- */
  showOver({title,win,kicker,stats,board,boardTitle,mvp}){
    mvp=mvp||(stats&&stats.mvp);
    this.el.oKicker.textContent=kicker||t('kicker_lost');
    this.el.oTitle.textContent=title||t('fail_title');
    this.el.oTitle.className=win?'o-win':'o-lose';
    // M4-P5: level progress (save is injected by the showOver caller)
    if(this.el.progress&&this._save&&mvp&&mvp.op){
      const lv=this._save.levelOf(mvp.op.id);
      this.el.progress.textContent=`${t('progress_lv')} ${lv.level} · ${lv.xp} XP`;
    }
    // M2-A4: MVP portrait + callsign + quote (falls back to the initial without a portrait)
    if(this.el.oMvp){
      if(mvp&&mvp.op){
        let url=null;
        try{if(this.portraits)url=this.portraits.render(mvp.op,'default',160,{frame:'bust'});}catch(e){}
        const face=url
          ?`<div class="mvp-face" style="background-image:url('${url}')"></div>`
          :`<div class="mvp-face mvp-fallback">${escHTML(String(mvp.name||'?').slice(0,1))}</div>`;
        const quote=isEN()?mvp.op.quote.en:mvp.op.quote.zh;
        this.el.oMvp.innerHTML=`<div class="mvp-kicker">${t('mvp_title')}</div>
          <div class="mvp-row">${face}<div class="mvp-info">
            <b>${escHTML(mvp.name)}</b><span>“${escHTML(quote)}”</span>
            <em>${t('over_kills')} ${mvp.kills} · ${t('sb_deaths')} ${mvp.deaths}</em>
          </div></div>`;
        this.el.oMvp.classList.remove('hidden');
      }else{
        this.el.oMvp.innerHTML='';
        this.el.oMvp.classList.add('hidden');
      }
    }
    const mm=String(Math.floor(stats.time/60)).padStart(2,'0');
    const ss=String(Math.floor(stats.time%60)).padStart(2,'0');
    const rows=[
      [t('over_time'),`${mm}:${ss}`],
      [stats.waveLabel||t('over_waves'),stats.wave],
      [t('over_kills'),stats.kills],
      [t('over_crit'),stats.critKills],
      [t('over_acc'),stats.shots?Math.round(stats.hits/stats.shots*100)+'%':'–'],
      [t('over_combo'),`×${stats.bestCombo}`],
    ];
    this.el.oStats.innerHTML=rows.map(([k,v])=>`<div class="st"><span>${k}</span><b>${v}</b></div>`).join('');
    this.el.oBoard.innerHTML=board||'';
    this.el.oBest.innerHTML=stats.best!=null?`${t('over_score')} <b style="font-family:var(--mono);font-size:20px;color:var(--amber)">${stats.score}</b>`+
      (stats.best>0?t('over_best',{n:stats.best}):''):'';
    // M2-A7: build the share card synchronously at the end of a match (MVP first, otherwise the player's operator)
    try{this.buildShareCard(stats,(mvp&&mvp.op)||this.shareOp);}catch(e){}
    this.showOnly('over');
  }

  /* M2-A7: 1200×630 share card (offscreen canvas, no external assets) */
  buildShareCard(stats,op){
    const cv=document.createElement('canvas');cv.width=1200;cv.height=630;
    const g=cv.getContext('2d');
    const grad=g.createLinearGradient(0,0,1200,630);
    grad.addColorStop(0,'#0d1424');grad.addColorStop(.55,'#1a2740');grad.addColorStop(1,'#3a1717');
    g.fillStyle=grad;g.fillRect(0,0,1200,630);
    g.strokeStyle='rgba(255,255,255,.035)';g.lineWidth=2;
    for(let x=-620;x<1200;x+=26){g.beginPath();g.moveTo(x,630);g.lineTo(x+420,0);g.stroke();}
    g.fillStyle='#f0a860';g.fillRect(64,60,6,96);
    g.font='bold 62px "Segoe UI",sans-serif';g.fillStyle='#fff';g.fillText('GUN TO GUN',92,116);
    g.font='20px "Segoe UI",sans-serif';g.fillStyle='#9ba7c0';
    g.fillText(isEN()?'TACTICAL FPS · OFFLINE':'战术阵营射击 · 离线可玩',94,152);
    let art=null;
    try{if(op&&this.portraits)art=this.portraits.renderCanvas(op,'default',512,{frame:'bust'});}catch(e){}
    if(art){
      g.drawImage(art,690,70,460,500);
    }else{
      g.fillStyle='rgba(127,212,255,.12)';g.fillRect(720,90,400,460);
      g.font='bold 220px "Segoe UI",sans-serif';g.fillStyle='#7fd4ff';g.textAlign='center';
      g.fillText(String((op&&(isEN()?op.name.en:op.name.zh))||'?').slice(0,1),920,360);
      g.textAlign='left';
    }
    const rows=[
      [t('over_score'),stats.score],
      [stats.waveLabel||t('over_waves'),stats.wave],
      [t('over_kills'),stats.kills],
      [t('over_acc'),stats.shots?Math.round(stats.hits/stats.shots*100)+'%':'-'],
      [t('over_combo'),'x'+(stats.bestCombo||0)],
    ];
    rows.forEach(([k,v],i)=>{
      const y=248+i*62;
      g.font='17px "Segoe UI",sans-serif';g.fillStyle='#9ba7c0';g.fillText(k,96,y);
      g.font='bold 38px Consolas,monospace';g.fillStyle=i===0?'#f0a860':'#eef0f6';g.fillText(String(v),96,y+40);
    });
    g.fillStyle='rgba(240,168,96,.7)';g.fillRect(64,560,1072,1);
    g.font='16px "Segoe UI",sans-serif';g.fillStyle='#9ba7c0';g.fillText(t('share_footer'),66,598);
    this._shareCanvas=cv;
    return cv;
  }
  downloadShareCard(){
    const cv=this._shareCanvas;
    if(!cv)return false;
    const name='gun-to-gun-score.png';
    if(cv.toBlob){
      cv.toBlob(blob=>{
        if(!blob)return;
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');a.href=url;a.download=name;a.click();
        setTimeout(()=>URL.revokeObjectURL(url),2000);
      },'image/png');
    }else{
      const a=document.createElement('a');a.href=cv.toDataURL('image/png');a.download=name;a.click();
    }
    return true;
  }
  /* M3-G7: onboarding */
  showTutorial(steps,onDone){
    const root=document.getElementById('tutorial');
    if(!root||!steps||!steps.length)return;
    this._tutSteps=steps;this._tutIdx=0;this._tutDone=onDone;
    this._renderTutorial();
    root.classList.remove('hidden');
  }
  _renderTutorial(){
    const s=this._tutSteps&&this._tutSteps[this._tutIdx];
    if(!s)return;
    const title=document.getElementById('tut-title');
    if(title)title.textContent=isEN()?s.en:s.zh;
    const c=document.getElementById('tut-count');
    if(c)c.textContent=`${this._tutIdx+1} / ${this._tutSteps.length}`;
  }
  nextTutorial(){
    if(!this._tutSteps)return;
    this._tutIdx++;
    if(this._tutIdx>=this._tutSteps.length)this.closeTutorial(true);
    else this._renderTutorial();
  }
  closeTutorial(done=false){
    const root=document.getElementById('tutorial');
    if(root)root.classList.add('hidden');
    const cb=this._tutDone;
    this._tutSteps=null;this._tutDone=null;
    if(cb)cb(done);
  }
  /* M3-G3: pick-one-of-three upgrade cards */
  showUpgrades(cards,onPick){
    const box=document.getElementById('upgrade-cards');
    const root=document.getElementById('upgrades');
    if(!box||!root)return;
    box.innerHTML=cards.map((c,i)=>`<div class="up-card" data-up="${escHTML(c.id)}">
      <div class="up-num">${i+1}</div>
      <div class="up-name">${escHTML(isEN()?c.name.en:c.name.zh)}</div>
      <div class="up-desc">${escHTML(isEN()?c.desc.en:c.desc.zh)}</div>
    </div>`).join('');
    box.onclick=e=>{
      const el=e.target.closest('.up-card');
      if(el){this.hideUpgrades();onPick&&onPick(el.dataset.up);}
    };
    root.classList.remove('hidden');
  }
  hideUpgrades(){
    const root=document.getElementById('upgrades');
    if(root)root.classList.add('hidden');
  }
  showBest(best){
    this.el.mBest.innerHTML=best>0?`${t('best_hit')}<b>${best}</b>`:t('best_none');
  }

  /* ---------- Debug ---------- */
  debug(msg,isErr=false){
    this.errors.push(msg);
    this.el.debug.classList.remove('hidden');
    this.el.debug.classList.toggle('err',isErr||this.errors.some(e=>e.startsWith('ERR')));
    this.el.debug.textContent=this.errors.slice(-6).join('\n');
  }
}
