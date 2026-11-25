// i18n.js — bilingual UI (zh/en): synchronous first-frame detection (cached IP country / browser language)
// + async IP probe correction (two endpoints + timeout; failures silently fall back, offline play unaffected)
import {store} from './util.js';

const STR={
  zh:{
    title:'GUN TO GUN · 战术阵营射击',
    sub:'战术阵营射击 · 新星 vs 浪人 · 8 种真实武器 · 真实物理',
    callsign:'呼号登录',
    name_ph:'输入昵称(默认 守卫-07)',
    default_name:'守卫-07',
    sec_role:'选择干员 · 新星 vs 浪人 · 8 名干员',
    sec_primary:'初始主武器(阵营全部 4 把随身,按 1 循环切换)',
    sec_map:'作战地图',
    sec_mode:'作战模式',
    hero_ct_name:'霜华 · 新星特勤',
    hero_ct_desc:'北境空勤特勤 · 模特身形女干员 · 长发马尾 · 战术耳麦<br>生命 115 · 主武器 M4A4 · 稳定精准',
    hero_t_name:'赤鸦 · 浪人佣兵',
    hero_t_desc:'赤线佣兵 · 硬朗帅气突击手 · 挽袖红夹克 · V 型身躯<br>移速 +12% 换弹 +25% · 主武器 AK-47',
    hero_ct_role:'新星特勤 · 霜华',
    hero_t_role:'浪人佣兵 · 赤鸦',
    op_locked:'未解锁',
    op_select:'选择',
    op_camo:'迷彩',
    op_hp:'生命',
    op_speed:'移速',
    op_reload:'换弹',
    camo_default:'标准',
    camo_desert:'沙漠',
    camo_snow:'雪地',
    camo_urban:'城市',
    camo_locked:'完成第 {n} 波解锁',
    faction_ct:'新星',
    faction_t:'浪人',
    map_desert:'沙漠哨站 · 日落',
    map_snow:'极夜冰湖 · 极光',
    map_snowtown:'霓虹雨港 · 雨夜',
    map_ember:'熔岩火山口 · 烈焰',
    mode_waves:'无尽波次 · 单人',
    mode_koth:'占点争夺 · 3v3',
    mode_dm:'五五开黑 · 5v5',
    mode_online:'好友对战 5v5 · 在线',
    quality_high:'画质:高',
    quality_low:'画质:流畅',
    deploy:'▶ 开始部署',
    best_hit:'历史最佳战绩:',
    best_none:'首次部署 · 祝你好运,守卫。',
    sponsor:'广告 · <b>AbinStudio</b> AI 短剧制作软件 · <a href="https://app.agents100.com" target="_blank" rel="noopener">app.agents100.com</a>',
    foot:'空格 跳跃 · Ctrl 蹲伏 · 反复按 1 循环 4 把主武器 · 2 沙漠之鹰 · 3 UMP-45 · 滚轮顺序切换 · 开镜 · G/F/V 手雷 ·',
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
    p_ads_toggle:'ADS 切换',p_touchassist:'触屏辅助瞄准',
    p_colorblind:'色盲高对比',p_reduce_motion:'减弱动态效果',p_subtitles:'台词字幕',p_ui_scale:'界面缩放',p_leaderboard:'匿名全球榜(需联网)',
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
    boss_name:'重装守卫者',mod_fog:'词缀 · 浓雾',mod_emp:'词缀 · EMP 干扰',mod_rush:'词缀 · 急速突袭',
    tut_kicker:'新兵训练',tut_next:'下一步',tut_skip:'跳过训练',
    tut_keys:'WASD 移动 · 鼠标瞄准 · 左键开火 · 右键开镜 · R 换弹 · 1 切枪 · G 投雷',
    level_up:'等级提升',daily_ready:'每日挑战已完成',progress_lv:'等级',
    koth_name:'控制点',koth_a:'新星',koth_b:'浪人',koth_win:'占据成功',koth_lose:'据点失守',
    upgrade_kicker:'补给投放',upgrade_title:'选择一项强化',
    upgrade_hint:'点击卡片立即生效 · 可按 1/2/3 快速选择',upgrade_applied:'强化已生效',
    g_frag:'破片',g_flash:'闪光',g_smoke:'烟雾',
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
    hud_reloading:'装填中…',hud_ready:'就绪',rotate_hint:'请横屏游玩',no_webgl:'当前浏览器不支持 WebGL2<br>请使用 Edge / Chrome 等现代浏览器打开',
    supply_sub:'补给投放中 · 弹药 +90 生命 +25 · 奖励 +{n}',
    dm_start:'对局开始',
    dm_sub:'新星 vs 浪人 · {a}v{b} · 5 分钟 · 先到 {k} 击杀',
    fail_title:'哨站失守',
    kicker_lost:'信号中断 · SIGNAL LOST',
    win:'胜利 · VICTORY',
    lose:'战败 · DEFEAT',
    dm_over_kicker:'对局结束 · MATCH OVER',
    dur_label:'参战时长',
    dur_fmt:'{m}分{s}秒',
    sb_title:'计分板 · 新星 vs 浪人',
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
    /* Friends 5v5 online */
    lobby_title:'好友对战 · 5v5',lobby_tip:'房间码制 · 空位由 AI 补满',
    lobby_create:'创建房间',lobby_join:'加入',lobby_code:'房间码',lobby_code_ph:'5 位房间码',
    lobby_copy:'复制邀请链接',lobby_copied:'已复制',lobby_ready:'已准备',lobby_unready:'取消准备',
    lobby_start:'开始对局',lobby_leave:'离开房间',lobby_rematch:'再战一局',
    lobby_solo:'单人训练 (AI 5v5)',lobby_host:'房主',lobby_waiting:'等待中',
    net_connecting:'连接中…',net_connected:'已连接',net_reconnecting:'重连中…',net_lost:'连接中断',
    net_server_unset:'尚未配置联机服务器。请在 URL 加 ?server=wss://… 或使用构建常量。仍可进行单人训练。',
    net_full:'房间已满',net_bad_code:'房间码无效 (5 位，不含 0/O/1/I)',net_proto:'版本不匹配，请刷新页面',
    net_err:'网络错误',net_rate:'操作过快',net_kicked:'已被移出房间',
    net_create_fail:'建房失败，请稍后重试',net_connect_fail:'无法连接服务器，请检查地址与网络',
    pause_net_note:'联机对局仍在继续 · 你的角色原地待命',pause_leave:'离开对局',sb_ping:'延迟',
    online_start:'好友对战',online_sub:'5v5 · 5 分钟 · 先到 25 击杀',
    online_over_kicker:'在线对局结束',online_countdown:'{s} 秒后开始 · 准备战斗',
  },
  en:{
    title:'GUN TO GUN · Tactical Faction Shooter',
    sub:'Tactical faction shooter · NOVA vs ROGUE · 8 real weapons · real physics',
    callsign:'CALLSIGN',
    name_ph:'Enter callsign (default Guard-07)',
    default_name:'Guard-07',
    sec_role:'OPERATOR · NOVA vs ROGUE · 8 operators',
    sec_primary:'PRIMARY (all 4 carried · press 1 to cycle)',
    sec_map:'MAP',
    sec_mode:'MODE',
    hero_ct_name:'Frost · Nova Operator',
    hero_ct_desc:'Northern airborne · Model-figure female operative · Long ponytail · Tactical headset<br>HP 115 · Primary M4A4 · Stable & precise',
    hero_t_name:'Raven · Rogue Mercenary',
    hero_t_desc:'Redline mercenary · Handsome assault · Rolled-sleeve red jacket · V-frame<br>Speed +12% Reload +25% · Primary AK-47',
    hero_ct_role:'NOVA OPERATOR · FROST',
    hero_t_role:'ROGUE MERCENARY · RAVEN',
    op_locked:'LOCKED',
    op_select:'SELECT',
    op_camo:'CAMO',
    op_hp:'HP',
    op_speed:'SPEED',
    op_reload:'RELOAD',
    camo_default:'Standard',
    camo_desert:'Desert',
    camo_snow:'Snow',
    camo_urban:'Urban',
    camo_locked:'Unlock at wave {n}',
    faction_ct:'NOVA',
    faction_t:'ROGUE',
    map_desert:'Desert Outpost · Sunset',
    map_snow:'Glacier Lake · Aurora',
    map_snowtown:'Neon Docklands · Rain',
    map_ember:'Volcano Caldera',
    mode_waves:'Wave Survival · Solo',
    mode_koth:'King of the Hill · 3v3',
    mode_dm:'Team Brawl · 5v5',
    mode_online:'Friends 5v5 · Online',
    quality_high:'Quality: High',
    quality_low:'Quality: Smooth',
    deploy:'▶ DEPLOY',
    best_hit:'BEST SCORE:',
    best_none:'First deploy · Good luck, operator.',
    sponsor:'AD · <b>AbinStudio</b> AI Short-Drama Studio · <a href="https://app.agents100.com" target="_blank" rel="noopener">app.agents100.com</a>',
    foot:'Space Jump · Ctrl Crouch · Press 1 to cycle 4 primaries · 2 Desert Eagle · 3 UMP-45 · Wheel to switch · Scope · G/F/V Grenades ·',
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
    p_ads_toggle:'ADS Toggle',p_touchassist:'Touch Aim Assist',
    p_colorblind:'Colorblind Mode',p_reduce_motion:'Reduce Motion',p_subtitles:'Radio Subtitles',p_ui_scale:'UI Scale',p_leaderboard:'Anonymous global board (online)',
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
    boss_name:'WARDEN PRIME',mod_fog:'MODIFIER · DENSE FOG',mod_emp:'MODIFIER · EMP JAM',mod_rush:'MODIFIER · RUSH',
    tut_kicker:'BOOTCAMP',tut_next:'NEXT',tut_skip:'SKIP',
    tut_keys:'WASD move · mouse aim · LMB fire · RMB ADS · R reload · 1 switch · G grenade',
    level_up:'LEVEL UP',daily_ready:'DAILY COMPLETE',progress_lv:'LV',
    koth_name:'CONTROL POINT',koth_a:'NOVA',koth_b:'ROGUE',koth_win:'POINT SECURED',koth_lose:'POINT LOST',
    upgrade_kicker:'SUPPLY DROP',upgrade_title:'CHOOSE AN UPGRADE',
    upgrade_hint:'Click to apply · or press 1/2/3',upgrade_applied:'UPGRADE APPLIED',
    g_frag:'FRAG',g_flash:'FLASH',g_smoke:'SMOKE',
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
    hud_reloading:'RELOADING…',hud_ready:'READY',rotate_hint:'Rotate your device to landscape',no_webgl:'This browser does not support WebGL2<br>Please open the game in a modern browser such as Edge or Chrome',
    supply_sub:'Supply drop · Ammo +90 HP +25 · Bonus +{n}',
    dm_start:'MATCH START',
    dm_sub:'NOVA vs ROGUE · {a}v{b} · 5 min · First to {k} kills',
    fail_title:'MISSION FAILED',
    kicker_lost:'CONNECTION LOST',
    win:'VICTORY',
    lose:'DEFEAT',
    dm_over_kicker:'MATCH OVER',
    dur_label:'DURATION',
    dur_fmt:'{m}m {s}s',
    sb_title:'SCOREBOARD · NOVA vs ROGUE',
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
    /* Friends 5v5 online */
    lobby_title:'FRIENDS 5v5',lobby_tip:'Room-code only · empty slots filled by AI',
    lobby_create:'CREATE ROOM',lobby_join:'JOIN',lobby_code:'ROOM CODE',lobby_code_ph:'5-character code',
    lobby_copy:'COPY LINK',lobby_copied:'COPIED',lobby_ready:'READY',lobby_unready:'UNREADY',
    lobby_start:'START',lobby_leave:'LEAVE',lobby_rematch:'REMATCH',
    lobby_solo:'SOLO TRAINING (AI 5v5)',lobby_host:'HOST',lobby_waiting:'WAITING',
    net_connecting:'Connecting…',net_connected:'Connected',net_reconnecting:'Reconnecting…',net_lost:'Disconnected',
    net_server_unset:'No online server configured. Add ?server=wss://… to the URL or set the build constant. Solo training still works.',
    net_full:'Room is full',net_bad_code:'Invalid room code (5 chars, no 0/O/1/I)',net_proto:'Version mismatch — please refresh',
    net_err:'Network error',net_rate:'Too many actions',net_kicked:'Removed from room',
    net_create_fail:'Could not create a room — please retry',net_connect_fail:'Cannot reach the server — check the address and network',
    pause_net_note:'Online match continues · your character holds position',pause_leave:'LEAVE MATCH',sb_ping:'PING',
    online_start:'FRIENDS MATCH',online_sub:'5v5 · 5 min · First to 25 kills',
    online_over_kicker:'ONLINE MATCH OVER',online_countdown:'Starting in {s}s · get ready',
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

/* Lookup with {var} placeholders */
export function t(k,vars){
  const s=STR[lang.cur]||STR.zh;
  let v=s[k]??STR.zh[k]??k;
  if(vars)for(const key in vars)v=v.replace('{'+key+'}',vars[key]);
  return v;
}

/* Synchronous first-frame detection: ?ipcc= test hook → cached IP probe → browser language fallback (default Chinese) */
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

/* Async IP probe: non-China IP → English UI; silent on failure (default Chinese).
   One CORS-friendly endpoint only: the previous ipapi.co fallback rate-limited and logged
   cross-origin errors, and the caller now caches the country and skips the probe in e2e. */
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
  const j=await tryFetchJSON('https://ipwho.is/?fields=country_code');
  if(j&&typeof j.country_code==='string')return j.country_code;
  return null;
}

/* Apply static DOM copy to every element tagged with data-i (dictionary content is trusted and may contain <a>/<br>)
   字典缺 key 时保留原内容不回写——防止 data-i 与其他业务属性(如槽位序号)碰撞时抹掉结构 */
export function applyStatic(){
  if(typeof document==='undefined')return;
  if(typeof window!=='undefined'&&(typeof DEBUG_HOOKS==='undefined'||DEBUG_HOOKS))window.__i18n={lang,t,applyStatic}; // stripped in production
  document.title=t('title');
  document.documentElement.lang=lang.cur==='en'?'en':'zh-CN';
  const zh=STR.zh;
  document.querySelectorAll('[data-i]').forEach(el=>{
    const k=el.dataset.i;
    const v=(STR[lang.cur]||STR.zh)[k]??zh[k];
    if(v!=null)el.innerHTML=v;
  });
  const name=document.getElementById('m-name');
  if(name)name.placeholder=t('name_ph');
  const rc=document.getElementById('lobby-code');
  if(rc)rc.placeholder=t('lobby_code_ph');
  const q=document.getElementById('m-quality');
  if(q&&q.options.length>=2){q.options[0].text=t('quality_high');q.options[1].text=t('quality_low');}
  // Map / mode chips (looked up by data attribute)
  document.querySelectorAll('#m-maps .chip').forEach(c=>{c.textContent=t('map_'+c.dataset.map);});
  document.querySelectorAll('#m-modes .chip').forEach(c=>{c.textContent=t('mode_'+c.dataset.mode);});
  // Operator cards are rebuilt by UI.buildOperators() (names come from operators.js)
}
