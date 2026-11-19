// ui.js —— HUD / 菜单(登录+角色+地图+模式)/ 暂停 / 结算 / 击杀播报 / 计分板
import * as THREE from 'three';
import {escHTML,store} from './util.js';
import {t,isEN} from './i18n.js';

const $=id=>document.getElementById(id);

/* 主武器目录(按阵营,双语名) */
const PRIMARIES={
  ct:[{id:'m4a4',n:'M4A4'},{id:'aug',n:'AUG · 瞄准镜',nEn:'AUG · Scoped'},{id:'awp',n:'AWP · 重狙',nEn:'AWP · Sniper'},{id:'mp5',n:'MP5'}],
  t:[{id:'ak47',n:'AK-47'},{id:'sg553',n:'SG 553 · 瞄准镜',nEn:'SG 553 · Scoped'},{id:'awp',n:'AWP · 重狙',nEn:'AWP · Sniper'},{id:'mp5',n:'MP5'}],
};

export class UI{
  constructor(){
    this.el={
      hud:$('hud'),menu:$('menu'),pause:$('pause'),over:$('over'),
      wave:$('ui-wave'),remain:$('ui-remain'),score:$('ui-score'),
      xh:$('xh'),hitmark:$('hitmark'),
      ammo:$('ui-ammo'),reserve:$('ui-reserve'),weapon:$('ui-weapon'),
      hpfill:$('hpfill'),hp:$('ui-hp'),heroRole:$('hero-role'),
      banner:$('banner'),bannerMain:$('banner-main'),bannerSub:$('banner-sub'),
      hint:$('hint'),pops:$('pops'),
      dmg:$('dmg-vignette'),lowhp:$('lowhp'),flash:$('flash-white'),
      reloadRing:$('reload-ring'),rrArc:$('rr-arc'),
      mBest:$('m-best'),oStats:$('o-stats'),oBest:$('o-best'),
      oKicker:$('o-kicker'),oTitle:$('o-title'),oBoard:$('o-board'),
      debug:$('debug'),
      dmTop:$('dm-top'),dmTimer:$('dm-timer'),dmA:$('dm-a'),dmB:$('dm-b'),
      killfeed:$('killfeed'),board:$('board'),
      wslots:[...document.querySelectorAll('.wslot')],
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
    this.errors=[];
    this._pv=new THREE.Vector3(); // 每帧计分浮字复用
    // 菜单选择状态(校验持久化旧值,脏数据回落默认)
    const HOK=['ct','t'],MOK=['desert','snow','snowtown','ember'],KOK=['waves','dm'];
    const h=store.get('o07_hero'),m=store.get('o07_map'),k=store.get('o07_mode');
    const p=store.get('o07_primary');
    this.sel={
      hero:HOK.includes(h)?h:'ct',
      map:MOK.includes(m)?m:'desert',
      mode:KOK.includes(k)?k:'waves',
      primary:['m4a4','aug','awp','mp5','sg553','ak47'].includes(p)?p:'m4a4',
    };
  }

  /* ---------- 菜单选择 ---------- */
  bindMenu(onChange){
    const s=this.sel;
    // 主武器 chips 按阵营重建(AUG 仅 CT)
    const buildPrimaries=()=>{
      const box=$('m-primaries');
      box.innerHTML=PRIMARIES[s.hero].map(p=>{
        const label=isEN()&&p.nEn?p.nEn:p.n;
        return `<div class="chip${p.id===s.primary?' selected':''}" data-primary="${p.id}">${label}</div>`;
      }).join('');
      box.querySelectorAll('.chip').forEach(c=>c.addEventListener('click',()=>{
        s.primary=c.dataset.primary;store.set('o07_primary',s.primary);buildPrimaries();
      }));
    };
    this.buildPrimaries=buildPrimaries; // 语言切换时重建
    const refresh=()=>{
      document.querySelectorAll('.hero-card').forEach(c=>c.classList.toggle('selected',c.dataset.hero===s.hero));
      document.querySelectorAll('#m-maps .chip').forEach(c=>c.classList.toggle('selected',c.dataset.map===s.map));
      document.querySelectorAll('#m-modes .chip').forEach(c=>c.classList.toggle('selected',c.dataset.mode===s.mode));
      buildPrimaries();
    };
    document.querySelectorAll('.hero-card').forEach(c=>c.addEventListener('click',()=>{
      s.hero=c.dataset.hero;store.set('o07_hero',s.hero);
      // 阵营切换后主武器合法性校验
      if(!PRIMARIES[s.hero].some(p=>p.id===s.primary)){
        s.primary=PRIMARIES[s.hero][0].id;store.set('o07_primary',s.primary);
      }
      refresh();onChange&&onChange();
    }));
    document.querySelectorAll('#m-maps .chip').forEach(c=>c.addEventListener('click',()=>{
      s.map=c.dataset.map;store.set('o07_map',s.map);refresh();onChange&&onChange();
    }));
    document.querySelectorAll('#m-modes .chip').forEach(c=>c.addEventListener('click',()=>{
      s.mode=c.dataset.mode;store.set('o07_mode',s.mode);refresh();onChange&&onChange();
    }));
    refresh();
    $('m-name').value=store.get('o07_name');
  }
  get playerName(){
    return ($('m-name').value.trim()||t('default_name')).slice(0,10);
  }
  saveName(){store.set('o07_name',$('m-name').value.trim());}

  /* ---------- 状态切换 ---------- */
  showOnly(name){ // 'menu'|'pause'|'over'|null(游戏中)
    for(const k of ['menu','pause','over'])
      this.el[k].classList.toggle('hidden',k!==name);
    const playing=!name;
    this.el.hud.classList.toggle('hidden',!playing);
    this.el.dmTop.classList.toggle('hidden',!playing||!this.dmMode);
  }
  setDmMode(on){
    this.dmMode=on;
    document.getElementById('topline').style.display=on?'none':'flex';
  }

  /* ---------- HUD ---------- */
  setWave(n){this.el.wave.textContent=String(n).padStart(2,'0');}
  setRemain(n){this.el.remain.textContent=n;}
  setScore(s){this.el.score.textContent=s;}
  setHero(name,role){this.el.heroRole.textContent=role;}
  setAmmo(ammo,reserve,reloading,weaponName){
    // DOM 写入去重:数值未变时跳过(每帧调用的热路径)
    const key=ammo+'|'+reserve+'|'+reloading+'|'+weaponName;
    if(key===this._ammoKey)return;
    this._ammoKey=key;
    if(ammo<0){ // 军刀:无弹药
      this.el.ammo.textContent='—';
      this.el.reserve.textContent='近战';
      this.el.ammo.classList.remove('low');
    }else{
      this.el.ammo.textContent=String(ammo);
      this.el.reserve.textContent=reloading?'装填中…':'/ '+reserve;
      this.el.ammo.classList.toggle('low',ammo<=8&&!reloading);
    }
    if(weaponName)this.el.weapon.textContent=weaponName;
  }
  setSlotNames(names){
    this.el.wslots.forEach((w,i)=>{
      const sp=w.querySelector('span');
      if(sp&&names[i])sp.textContent=names[i];
    });
  }
  setScope(on){ // AUG 开镜遮罩
    if(this.el.scope)this.el.scope.classList.toggle('show',!!on);
  }
  weaponSlots(cur){
    this.el.wslots.forEach((w,i)=>w.classList.toggle('active',i===cur));
  }
  abilityCd(k){ // CS 角色无技能:元素可缺省
    if(!this.el.ability)return;
    if(k<0){this.el.ability.classList.add('hidden');return;}
    this.el.ability.classList.remove('hidden');
    this.el.ability.classList.toggle('cooling',k<1);
    this.el.abilityCd.textContent=k>=1?'就绪':(k*100|0)+'%';
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
    // DOM 写入去重:准星参数未变时跳过
    const gap=ads>.6?'0':(6+Math.tan(spreadRad)*(screenH/2)/Math.tan(fovDeg*Math.PI/180)).toFixed(1);
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
    // 昵称用户可控:转义防 XSS
    slot.el.innerHTML=`<b>${escHTML(killer)}</b> <span class="w">[${escHTML(weapon)}]</span> ${mine?'✖':t('killed')} <i>${escHTML(victim)}</i>`;
    slot.el.style.display='block';
  }
  scoreboard(rows,labels={}){
    const la=labels.A||'CT',lb=labels.B||'T';
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
    this.dmgLevel=Math.max(0,this.dmgLevel-dt*1.6);
    const low=Math.max(0,1-health/max*2.2)*(0.55+Math.sin(performance.now()*.006)*.2);
    this.el.dmg.style.opacity=Math.min(1,this.dmgLevel+low*.7);
    this.el.lowhp.style.opacity=health<35?low:0;
    this.updatePops(dt);
  }

  /* ---------- 结算 ---------- */
  showOver({title,win,kicker,stats,board,boardTitle}){
    this.el.oKicker.textContent=kicker||t('kicker_lost');
    this.el.oTitle.textContent=title||t('fail_title');
    this.el.oTitle.className=win?'o-win':'o-lose';
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
    this.showOnly('over');
  }
  showBest(best){
    this.el.mBest.innerHTML=best>0?`${t('best_hit')}<b>${best}</b>`:t('best_none');
  }

  /* ---------- 调试 ---------- */
  debug(msg,isErr=false){
    this.errors.push(msg);
    this.el.debug.classList.remove('hidden');
    this.el.debug.classList.toggle('err',isErr||this.errors.some(e=>e.startsWith('ERR')));
    this.el.debug.textContent=this.errors.slice(-6).join('\n');
  }
}
