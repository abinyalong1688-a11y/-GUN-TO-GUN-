// i18n.js —— 界面双语(zh/en):同步首帧判定(缓存 IP 国家/浏览器语言)
// + 异步 IP 探测修正(双端点兜底 + 超时,失败静默回退,不影响离线可玩)
import {store} from './util.js';

const STR={
  zh:{
    title:'GUN TO GUN · 战术阵营射击',
    kicker:'◆ 单文件 · 离线可玩 · Three.js / WebGL2',
    sub:'CS 风格反恐射击 · CT vs T · 7 种真实武器 · 真实物理',
    callsign:'呼号登录',
    name_ph:'输入昵称(默认 守卫-07)',
    default_name:'守卫-07',
    sec_role:'选择干员 · CT vs T · 8 名干员',
    sec_primary:'初始主武器(阵营全部 4 把随身,按 1 循环切换)',
    sec_map:'作战地图',
    sec_mode:'作战模式',
    hero_ct_name:'霜华 · CT 特勤',
    hero_ct_desc:'SAS 空勤特勤 · 模特身形女干员 · 长发马尾 · 战术耳麦<br>生命 115 · 主武器 M4A4 · 稳定精准',
    hero_t_name:'赤鸦 · T 佣兵',
    hero_t_desc:'凤凰线佣兵 · 硬朗帅气突击手 · 挽袖红夹克 · V 型身躯<br>移速 +12% 换弹 +25% · 主武器 AK-47',
    hero_ct_role:'CT 特勤 · 霜华',
    hero_t_role:'T 佣兵 · 赤鸦',
    op_locked:'未解锁',
    op_select:'选择',
    op_camo:'迷彩',
    op_bio:'档案',
    op_quote:'台词',
    op_hp:'生命',
    op_speed:'移速',
    op_reload:'换弹',
    camo_default:'标准',
    camo_desert:'沙漠',
    camo_snow:'雪地',
    camo_urban:'城市',
    camo_locked:'完成第 {n} 波解锁',
    faction_ct:'CT',
    faction_t:'T',
    map_desert:'沙漠哨站 · 日落',
    map_snow:'雪夜要塞 · 极寒',
    map_snowtown:'雪地小镇 · de_snow',
    map_ember:'熔岩废都 · 烈焰',
    mode_waves:'无尽波次 · 守卫哨站',
    mode_dm:'6 人乱斗 · 3v3 对战',
    quality_high:'画质:高',
    quality_low:'画质:流畅',
    deploy:'▶ 开始部署',
    best_hit:'历史最佳战绩:',
    best_none:'首次部署 · 祝你好运,守卫。',
    sponsor:'广告 · <b>AbinStudio</b> AI 短剧制作软件 · <a href="https://app.agents100.com" target="_blank" rel="noopener">app.agents100.com</a>',
    foot:'空格 跳跃 · Ctrl 蹲伏 · 反复按 1 循环 4 把主武器 · 2 沙漠之鹰 · 3 军刀 · 滚轮顺序切换 · 开镜 · 360° 视野 ·',
    pause_kicker:'作战暂停',
    pause_title:'行动中止',
    p_sens:'鼠标灵敏度',
    p_vol:'音量',
    p_ads:'ADS 灵敏度',
    p_fov:'视野 FOV',
    p_sfx:'音效',
    p_music:'音乐',
    p_xh_color:'准星颜色',
    p_xh_size:'准星大小',
    p_xh_gap:'准星间隙',
    p_yinv:'Y 轴反转',
    p_crouch:'蹲伏切换',
    p_ads_toggle:'ADS 切换',
    p_reset:'恢复默认设置',
    sw_update:'新版本已就绪',
    sw_reload:'立即刷新',
    combo_2:'双杀',
    combo_3:'三杀',
    combo_4:'四杀',
    combo_5:'暴走',
    bark_spot:'发现目标,请求支援',
    bark_reload:'换弹,掩护我',
    bark_low:'受伤,寻找掩护',
    bark_down:'我倒下了',
    mvp_title:'本场 MVP',
    o_share:'保存战绩',
    share_hint:'战绩卡已保存',
    share_footer:'单文件 · 离线可玩 · AbinStudio',
    resume:'继续作战',
    redeploy:'重新部署',
    main_menu:'返回主菜单',
    hud_wave:'波次',
    hud_left:'残余敌机',
    hud_score:'得分',
    reload:'装填',
    hp:'生命',
    hint_reload:'[R] 换弹',
    hint_lock:'点击画面锁定鼠标',
    deployed:'部署完成',
    hold_sub:'守住哨站 · 首波来袭',
    wave_banner:'第 {n} 波',
    wave_sub:'敌方无人机接近 · ENGAGE',
    wave_clear:'波次肃清',
    supply_sub:'补给投放中 · 弹药 +90 生命 +25 · 奖励 +{n}',
    dm_start:'对局开始',
    dm_sub:'CT vs T · 3v3 · 先到 25 击杀获胜',
    fail_title:'哨站失守',
    kicker_lost:'信号中断 · SIGNAL LOST',
    win:'胜利 · VICTORY',
    lose:'战败 · DEFEAT',
    dm_over_kicker:'对局结束 · MATCH OVER',
    dur_label:'参战时长',
    dur_fmt:'{m}分{s}秒',
    sb_title:'计分板 · CT vs T',
    sb_role:'角色',
    sb_faction:'阵营',
    sb_kills:'击杀',
    sb_deaths:'阵亡',
    killed:'击落',
    kill_verb:'击杀',
    over_time:'作战时长',
    over_waves:'坚守波次',
    over_kills:'击杀',
    over_crit:'核心暴击',
    over_acc:'命中率',
    over_combo:'最高连击',
    over_score:'本局得分',
    over_best:' · 历史最佳 <b>{n}</b>',
    best_score:'本局得分',
  },
  en:{
    title:'GUN TO GUN · Tactical Faction Shooter',
    kicker:'◆ Single file · Offline · Three.js / WebGL2',
    sub:'CS-style tactical shooter · CT vs T · 7 real weapons · real physics',
    callsign:'CALLSIGN',
    name_ph:'Enter callsign (default Guard-07)',
    default_name:'Guard-07',
    sec_role:'OPERATOR · CT vs T · 8 operators',
    sec_primary:'PRIMARY (all 4 carried · press 1 to cycle)',
    sec_map:'MAP',
    sec_mode:'MODE',
    hero_ct_name:'Frost · CT Operator',
    hero_ct_desc:'SAS airborne · Model-figure female operative · Long ponytail · Tactical headset<br>HP 115 · Primary M4A4 · Stable & precise',
    hero_t_name:'Raven · T Mercenary',
    hero_t_desc:'Phoenix-line mercenary · Handsome assault · Rolled-sleeve red jacket · V-frame<br>Speed +12% Reload +25% · Primary AK-47',
    hero_ct_role:'CT OPERATOR · FROST',
    hero_t_role:'T MERCENARY · RAVEN',
    op_locked:'LOCKED',
    op_select:'SELECT',
    op_camo:'CAMO',
    op_bio:'BIO',
    op_quote:'QUOTE',
    op_hp:'HP',
    op_speed:'SPEED',
    op_reload:'RELOAD',
    camo_default:'Standard',
    camo_desert:'Desert',
    camo_snow:'Snow',
    camo_urban:'Urban',
    camo_locked:'Unlock at wave {n}',
    faction_ct:'CT',
    faction_t:'T',
    map_desert:'Desert Outpost · Sunset',
    map_snow:'Snow Keep · Night',
    map_snowtown:'Snow Town · de_snow',
    map_ember:'Lava Ruins · Ember',
    mode_waves:'Wave Survival · Defend the Outpost',
    mode_dm:'6-Player Brawl · 3v3',
    quality_high:'Quality: High',
    quality_low:'Quality: Smooth',
    deploy:'▶ DEPLOY',
    best_hit:'BEST SCORE:',
    best_none:'First deploy · Good luck, operator.',
    sponsor:'AD · <b>AbinStudio</b> AI Short-Drama Studio · <a href="https://app.agents100.com" target="_blank" rel="noopener">app.agents100.com</a>',
    foot:'Space Jump · Ctrl Crouch · Press 1 to cycle 4 primaries · 2 Desert Eagle · 3 Knife · Wheel to switch · Scope · 360° view ·',
    pause_kicker:'PAUSED',
    pause_title:'STAND BY',
    p_sens:'Mouse Sens.',
    p_vol:'Volume',
    p_ads:'ADS Sens.',
    p_fov:'Field of View',
    p_sfx:'SFX',
    p_music:'Music',
    p_xh_color:'Crosshair Color',
    p_xh_size:'Crosshair Size',
    p_xh_gap:'Crosshair Gap',
    p_yinv:'Invert Y',
    p_crouch:'Crouch Toggle',
    p_ads_toggle:'ADS Toggle',
    p_reset:'Reset to Defaults',
    sw_update:'New version ready',
    sw_reload:'RELOAD NOW',
    combo_2:'DOUBLE KILL',
    combo_3:'TRIPLE KILL',
    combo_4:'QUAD KILL',
    combo_5:'RAMPAGE',
    bark_spot:'Contact, need backup',
    bark_reload:'Reloading, cover me',
    bark_low:'Hit, taking cover',
    bark_down:'I\'m down',
    mvp_title:'MATCH MVP',
    o_share:'SAVE CARD',
    share_hint:'Score card saved',
    share_footer:'Single file · Offline play · AbinStudio',
    resume:'RESUME',
    redeploy:'REDEPLOY',
    main_menu:'MAIN MENU',
    hud_wave:'WAVE',
    hud_left:'ENEMIES',
    hud_score:'SCORE',
    reload:'RELOAD',
    hp:'HP',
    hint_reload:'[R] RELOAD',
    hint_lock:'Click to lock mouse',
    deployed:'DEPLOYED',
    hold_sub:'Hold the outpost · First wave incoming',
    wave_banner:'WAVE {n}',
    wave_sub:'Enemy drones inbound · ENGAGE',
    wave_clear:'WAVE CLEARED',
    supply_sub:'Supply drop · Ammo +90 HP +25 · Bonus +{n}',
    dm_start:'MATCH START',
    dm_sub:'CT vs T · 3v3 · First to 25 kills',
    fail_title:'MISSION FAILED',
    kicker_lost:'CONNECTION LOST',
    win:'VICTORY',
    lose:'DEFEAT',
    dm_over_kicker:'MATCH OVER',
    dur_label:'DURATION',
    dur_fmt:'{m}m {s}s',
    sb_title:'SCOREBOARD · CT vs T',
    sb_role:'OPERATOR',
    sb_faction:'FACTION',
    sb_kills:'KILLS',
    sb_deaths:'DEATHS',
    killed:'killed',
    kill_verb:'KIA',
    over_time:'TIME',
    over_waves:'WAVES SURVIVED',
    over_kills:'KILLS',
    over_crit:'CORE CRITS',
    over_acc:'ACCURACY',
    over_combo:'BEST COMBO',
    over_score:'SCORE',
    over_best:' · BEST <b>{n}</b>',
    best_score:'SCORE',
  },
};

export const lang={cur:'zh'};

export function setLang(l){
  if(l==='zh'||l==='en')lang.cur=l;
  if(typeof document!=='undefined'&&document.documentElement){
    document.documentElement.lang=l==='en'?'en':'zh-CN';
  }
}
export function isEN(){ return lang.cur==='en'; }

/* 取词:支持 {var} 占位 */
export function t(k,vars){
  const s=STR[lang.cur]||STR.zh;
  let v=s[k]??STR.zh[k]??k;
  if(vars)for(const key in vars)v=v.replace('{'+key+'}',vars[key]);
  return v;
}

/* 同步首帧判定:?ipcc= 测试钩子 → 上次 IP 探测缓存 → 浏览器语言兜底(默认中文) */
(function detectInitial(){
  let l=null;
  try{
    if(typeof location!=='undefined'){
      const f=new URLSearchParams(location.search).get('ipcc');
      if(f==='CN'||f==='US')l=f==='CN'?'zh':'en';
    }
  }catch(e){}
  if(!l){
    try{
      const cc=store.get('o07_ipcc');
      if(cc)l=cc==='CN'?'zh':'en';
    }catch(e){}
  }
  if(!l&&typeof navigator!=='undefined'&&navigator.language&&!/^zh/i.test(navigator.language))l='en';
  if(l)lang.cur=l;
  if(typeof document!=='undefined'&&document.documentElement){
    document.documentElement.lang=lang.cur==='en'?'en':'zh-CN';
  }
})();

/* 异步 IP 探测:非中国 IP → 英文界面;失败静默(默认中文) */
async function tryFetchJSON(url,ms=2200){
  const c=new AbortController();
  const to=setTimeout(()=>c.abort(),ms);
  try{
    const r=await fetch(url,{signal:c.signal});
    return await r.json();
  }catch(e){return null;}
  finally{clearTimeout(to);}
}
export async function detectIPCountry(){
  const j=await tryFetchJSON('https://ipwho.is/');
  if(j&&j.country_code)return j.country_code;
  const j2=await tryFetchJSON('https://ipapi.co/json/');
  if(j2&&j2.country_code)return j2.country_code;
  return null;
}

/* 静态 DOM 文案应用:全部带 data-i 标记的元素(字典内容可信,允许含 <a>/<br> 标记) */
export function applyStatic(){
  if(typeof document==='undefined')return;
  if(typeof window!=='undefined')window.__i18n={lang,t,applyStatic}; // 调试探针
  document.title=t('title');
  document.querySelectorAll('[data-i]').forEach(el=>{el.innerHTML=t(el.dataset.i);});
  const name=document.getElementById('m-name');
  if(name)name.placeholder=t('name_ph');
  const q=document.getElementById('m-quality');
  if(q&&q.options.length>=2){q.options[0].text=t('quality_high');q.options[1].text=t('quality_low');}
  // 地图/模式 chips(按 data 属性取词)
  document.querySelectorAll('#m-maps .chip').forEach(c=>{c.textContent=t('map_'+c.dataset.map);});
  document.querySelectorAll('#m-modes .chip').forEach(c=>{c.textContent=t('mode_'+c.dataset.mode);});
  // 干员卡由 UI.buildOperators() 重建(名称/简介/台词均来自 operators.js)
}
