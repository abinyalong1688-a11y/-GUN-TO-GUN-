// main.js —— 引导 / 状态机 / 射击判定(角色+爆炸) / 乱斗对战 / 主循环 / 验证钩子
import {t,applyStatic,detectIPCountry,setLang,lang,isEN} from './i18n.js';
import * as THREE from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

import {initAssets} from './assets.js';
import {AudioFX} from './audio.js';
import {MAPS,buildWorld,disposeWorld} from './world.js';
import {Effects} from './effects.js';
import {Player} from './player.js';
import {Weapon,wName,wSlot} from './weapon.js';
import {Enemies} from './enemies.js';
import {Waves} from './waves.js';
import {HeroTeam} from './heroes.js';
import {UI} from './ui.js';
import {PortraitRenderer} from './portraits.js';
import {settings} from './settings.js';
import {InputManager,KeyboardMouseAdapter} from './input.js';
import {Grenades} from './grenades.js';
import {Pickups} from './pickups.js';
import {applyUpgrade,rollUpgrades} from './upgrades.js';
import {Radar} from './radar.js';
import {OPERATORS,byId,byFaction,DEFAULT_OP,CAMOS} from './operators.js';
import {store,num,escHTML} from './util.js';

const $=id=>document.getElementById(id);
const UP=new THREE.Vector3(0,1,0);
const FOV_H=106; // 腰射水平视野(度):横向视野锁定,不随窗口宽高比缩水(16:9 下垂直约72.7°)
const TUTORIAL=[
  {zh:'WASD 移动,鼠标瞄准',en:'Move with WASD, aim with the mouse'},
  {zh:'按住右键开镜(ADS),精度更高',en:'Hold right mouse to aim down sights'},
  {zh:'按 R 换弹,避免空仓',en:'Press R to reload before running dry'},
  {zh:'按 1 循环主武器,2 手枪,3 军刀',en:'Press 1 to cycle primaries, 2 sidearm, 3 knife'},
  {zh:'按 G / F / V 投掷破片 / 闪光 / 烟雾',en:'Press G / F / V for frag / flash / smoke'},
];
const VERSION='1.5.0';
const _rsO=new THREE.Vector3(); // 射线-球判定复用向量(热路径零分配)

class Game{
  constructor(){
    this.shotMode=new URLSearchParams(location.search).get('shot');
    this.selftestMode=new URLSearchParams(location.search).has('selftest');
    this.e2eMode=new URLSearchParams(location.search).has('e2e');
    this.perfMode=new URLSearchParams(location.search).has('perf');
    this.rosterMode=new URLSearchParams(location.search).has('roster');
    this.portraitsMode=new URLSearchParams(location.search).has('portraits');
    this.bossMode=new URLSearchParams(location.search).get('boss')==='1';
    if(this.shotMode||this.selftestMode||this.e2eMode||this.rosterMode||this.portraitsMode)window.__game=this; // 调试探针:仅测试钩子下暴露
    this.perf={frames:0,slow:0,maxDt:0}; // 卡顿监控:慢帧(>25ms)计数
    this.state='menu'; // menu | playing | paused | dying | over
    this.keys=new Set();
    this.input={firing:false,ads:false};
    this.fallbackAim=false;
    // S1.4 设置中心:统一读取 + 旧 key 迁移
    this.settings=settings;
    this.settings.load();
    this.baseHFov=this.settings.get('fov');
    this.sensMul=this.settings.get('sens');
    this.volume=this.settings.get('volume');
    this.quality=this.settings.get('quality');
    this.score=0;this.shake=0;this.dyingT=0;this.time=0;
    this.stats={shots:0,hits:0,kills:0,critKills:0,time:0,bestCombo:0};
    this.comboKills=0;this.comboT=0;
    this.playerName='守卫-07';
    this.playerTeam='A';
    this.invulnT=0;this.dmRespawnT=-1;
    this._boot();
  }

  /* ================= 引导 ================= */
  _boot(){
    applyStatic(); // 语言首帧判定后立即替换静态文案(脚本阻塞解析,无闪屏)
    this.ui=new UI();
    window.addEventListener('error',e=>{
      const st=(e.error&&e.error.stack||'').split('\n').slice(0,4).join('\n');
      this.ui.debug('ERR '+e.message+'\n'+st,true);
    });
    window.addEventListener('unhandledrejection',e=>this.ui.debug('ERR '+e.reason,true));

    const test=document.createElement('canvas');
    if(!test.getContext('webgl2')){
      $('app').insertAdjacentHTML('beforeend','<div id="nogl">当前浏览器不支持 WebGL2<br>请使用 Edge / Chrome 等现代浏览器打开</div>');return;
    }

    this.renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    // 阴影隔帧更新:全场投影每两帧重算一次,可省掉近一半的阴影 pass(动态单位阴影延迟 1 帧,肉眼不可辨)
    this.renderer.shadowMap.autoUpdate=false;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.18;
    // WebGL 上下文丢失:驱动崩溃/切显卡/系统休眠后给出可见提示,恢复后自动重载
    this.renderer.domElement.addEventListener('webglcontextlost',e=>{
      e.preventDefault();
      this.renderer.setAnimationLoop(null);
      this.ui.debug('ERR WebGL 上下文丢失 · 页面将自动恢复…',true);
      setTimeout(()=>location.reload(),1200);
    },false);
    $('gl').appendChild(this.renderer.domElement);

    this.scene=new THREE.Scene();
    this.camera=new THREE.PerspectiveCamera(75,innerWidth/innerHeight,.06,600);

    this.viewScene=new THREE.Scene();
    this.viewCam=new THREE.PerspectiveCamera(58,innerWidth/innerHeight,.01,5);
    this.viewScene.add(new THREE.HemisphereLight(0x9aa8c8,0x7a5636,1.3));
    const vmSun=new THREE.DirectionalLight(0xffc080,2.0);
    vmSun.position.set(-.8,.5,-.3);
    this.viewScene.add(vmSun);
    const vmFill=new THREE.DirectionalLight(0xfff0d8,.9);
    vmFill.position.set(.2,.15,1);
    this.viewScene.add(vmFill);
    // 视模型环境反射(RoomEnvironment IBL):金属件获得真实高光,摆脱平涂粗糙感
    try{
      const pmrem=new THREE.PMREMGenerator(this.renderer);
      this.viewScene.environment=pmrem.fromScene(new RoomEnvironment(),.04).texture;
      this.viewScene.environmentIntensity=.55; // 压住反射强度,避免皮肤/手套过曝
      pmrem.dispose();
    }catch(e){}

    this.assets=initAssets();
    this.portraits=new PortraitRenderer(this.assets);
    this.ui.portraits=this.portraits; // C4:菜单干员卡立绘
    this.audio=new AudioFX();
    this.buildWorldFor(this.ui.sel.map);

    this.effects=new Effects(this.scene,this.assets,this.quality);
    this.effects.onShake=v=>{this.shake=Math.max(this.shake,v);};
    this.player=new Player(this.camera,this.world.colliders);
    this.weapon=new Weapon(this.viewScene,this.assets,this.audio,this.ui,this.quality);
    this.enemies=new Enemies(this.scene,this.assets,this.effects,this.audio,this.ui);
    this.enemies.onKill=(e,crit)=>this._onKill(e,crit);
    this.enemies.onPlayerHit=pos=>{
      this.shake=Math.max(this.shake,.12);this.audio.hurt();
      this._showDamageDirection(pos);
    };
    this.waves=new Waves(this);
    this.heroes=new HeroTeam(this);
    this.grenades=new Grenades(this,this.scene,this.effects,this.audio,this.ui);
    this.pickups=new Pickups(this,this.scene,this.effects,this.audio,this.ui);
    this.radar=new Radar(document.getElementById('radar'));
    this.ray=new THREE.Raycaster();
    this.losRay=new THREE.Raycaster();
    // 射击复用向量池:避免每发子弹都 new Vector3 造成 GC 抖动
    this._sd=new THREE.Vector3();this._sr=new THREE.Vector3();this._su=new THREE.Vector3();
    this._send=new THREE.Vector3();this._muzzle=new THREE.Vector3();this._losV=new THREE.Vector3();this._pierceO=new THREE.Vector3();
    this._shotGroups=[];

    this._setupComposer();
    this._setupInput();

    // 菜单绑定
    this.ui.bindMenu(()=>{ // 地图/模式变更 → 世界预览重建
      if(this.ui.sel.map!==this.world.mapKey)this.buildWorldFor(this.ui.sel.map);
    });
    $('m-quality').value=this.quality;
    $('m-quality').addEventListener('change',e=>{
      this.settings.set('quality',e.target.value);location.reload();
    });
    $('m-start').addEventListener('click',()=>{this.audio.init();this.audio.resume();this._applyAudioSettings();this.audio.uiClick();this.ui.saveName();this.startGame();});
    $('p-resume').addEventListener('click',()=>{this.audio.uiClick();this.resume();});
    $('p-restart').addEventListener('click',()=>{this.audio.uiClick();this.startGame();});
    $('p-menu').addEventListener('click',()=>{this.audio.uiClick();this.toMenu();});
    $('o-restart').addEventListener('click',()=>{this.audio.uiClick();this.startGame();});
    $('o-menu').addEventListener('click',()=>{this.audio.uiClick();this.toMenu();});
    $('o-share').addEventListener('click',()=>{
      this.audio.uiClick();
      if(this.ui.downloadShareCard())this.ui.banner(t('share_hint'),'');
    });
    $('tut-next').addEventListener('click',()=>{this.audio.uiClick();this.ui.nextTutorial();});
    $('tut-skip').addEventListener('click',()=>{this.audio.uiClick();this.ui.closeTutorial(false);});
    // U1:设置面板统一绑定(灵敏度/FOV/音量/音效/音乐/准星/反转/蹲伏切换/ADS 切换)
    this.ui.bindSettings(this.settings,(path)=>{
      if(path==='fov'||path==='reset')this.baseHFov=this.settings.get('fov');
      if(path==='sens'||path==='reset')this.sensMul=this.settings.get('sens');
      if(path==='volume'||path==='reset')this.volume=this.settings.get('volume');
      if(path==='volume'||path==='sfx'||path==='music'||path==='reset')this._applyAudioSettings();
    });

    this.bestScore=parseInt(store.get('o07_best','0'))||0;
    this.ui.showBest(this.bestScore);
    this.ui.showOnly('menu');
    this._menuDrones();

    // 预编译着色器
    try{
      this.weapon.group.visible=true;
      this.renderer.compile(this.scene,this.camera);
      this.renderer.compile(this.viewScene,this.viewCam);
      this.weapon.group.visible=false;
    }catch(e){}

    // C1/C5 调试钩子:?op=raven&camo=snow 指定干员与迷彩
    const qs=new URLSearchParams(location.search);
    const forcedOp=qs.get('op');
    if(forcedOp&&byId(forcedOp))this.ui.selectOperator(forcedOp);
    const forcedCamo=qs.get('camo');
    if(forcedCamo&&CAMOS[forcedCamo]){
      this.ui.sel.camo=forcedCamo;
      this.ui.buildOperators();
    }

    if(this.shotMode==='combat')this._shotCombat();
    else if(this.shotMode==='dm')this._shotDm();
    else if(this.shotMode==='over')this._shotOver();
    else if(this.shotMode==='killcard')this._shotKillcard();
    else if(this.shotMode==='mvp')this._shotMvp();
    else if(this.shotMode==='tutorial')this._shotTutorial();
    if(this.selftestMode)this.selftest();
    if(this.e2eMode)this.e2e();
    if(this.rosterMode)this._debugRoster();
    if(this.portraitsMode)this._debugPortraits();
    if(this.bossMode){
      this.ui.sel.mode='waves';this.startGame();
      this.waves.n=4;this.waves.queue.length=0;
      this.waves.state='intermission';this.waves.timer=.2;
    }
    // 异步 IP 探测:非中国 IP → 英文界面(结果缓存供下次首帧使用);?ipcc= 可强制(测试钩子)
    const forcedIPCC=new URLSearchParams(location.search).get('ipcc');
    (forcedIPCC?Promise.resolve(forcedIPCC):detectIPCountry()).then(cc=>{
      if(!cc)return;
      store.set('o07_ipcc',cc);
      const want=cc==='CN'?'zh':'en';
      if(lang.cur!==want){ setLang(want); this._refreshLang(); }
    }).catch(()=>{});

    const ver=$('m-ver');
    if(ver)ver.textContent=`v${VERSION}`;
    console.log(`%cGUN TO GUN v${VERSION}`,'color:#f0a860;font-weight:bold','· 单文件离线可玩');

    this.clock=new THREE.Clock();
    // 主循环异常熔断:单帧异常不再静默终止 rAF 链,可见报错并停机
    this.renderer.setAnimationLoop(()=>{
      try{this.tick();}
      catch(err){
        this.renderer.setAnimationLoop(null);
        console.error(err);
        this.ui.debug('ERR '+(err&&err.message||err)+'\n'+String(err&&err.stack||'').split('\n').slice(0,4).join('\n'),true);
      }
    });
    addEventListener('resize',()=>this._resize());
    this._resize();
    // PWA 离线支持:云端部署后首次访问即缓存,断网可从缓存重开(file:// 本地打开无需 SW)
    if('serviceWorker' in navigator&&/^https?:$/.test(location.protocol)){
      const hadController=!!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange',()=>{
        if(!hadController||this._swReloaded)return;
        const toast=$('sw-toast');
        if(toast)toast.classList.add('show');
      });
      const swBtn=$('sw-reload');
      if(swBtn)swBtn.addEventListener('click',()=>{this._swReloaded=true;location.reload();});
      addEventListener('load',()=>{navigator.serviceWorker.register('sw.js').catch(()=>{});});
    }
  }

  buildWorldFor(mapKey){
    disposeWorld(this.scene,this.world);
    this.world=buildWorld(this.scene,this.assets,this.quality,mapKey);
    if(this.player)this.player.colliders=this.world.colliders;
  }

  /* 语言切换后的动态文案刷新(静态部分由 applyStatic 覆盖) */
  _refreshLang(){
    applyStatic();
    this.assets.refreshAd&&this.assets.refreshAd();
    this.weapon.refreshLang&&this.weapon.refreshLang();
    const op=byId(this.ui.sel.operator)||byId(DEFAULT_OP);
    this.ui.setHero(this.playerName,`${t('faction_'+op.faction)} · ${isEN()?op.name.en:op.name.zh}`);
    this.ui.showBest(parseInt(store.get('o07_best','0'))||0);
    this.ui.buildPrimaries&&this.ui.buildPrimaries();
    this.ui.buildOperators&&this.ui.buildOperators();
  }

  _setupComposer(){
    const pr=this.renderer.getPixelRatio();
    const rt=new THREE.WebGLRenderTarget(innerWidth*pr,innerHeight*pr,{
      type:THREE.HalfFloatType,samples:this.quality==='high'?4:0});
    this.composer=new EffectComposer(this.renderer,rt);
    this.composer.addPass(new RenderPass(this.scene,this.camera));
    const vm=new RenderPass(this.viewScene,this.viewCam);
    vm.clear=false;vm.clearDepth=true;
    this.composer.addPass(vm);
    this.bloom=new UnrealBloomPass(new THREE.Vector2(innerWidth,innerHeight),.42,.55,.82);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  _applyQuality(){
    const pr=Math.min(devicePixelRatio||1,this.quality==='high'?2:1);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.bloom.strength=this.quality==='high'?.42:.26;
  }

  _resize(){
    this.camera.aspect=innerWidth/innerHeight;
    // 视野以水平角为准:先定横向角度,再换算当前宽高比下的垂直 FOV
    this.camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(this._hfovCur||this.baseHFov||FOV_H)*.5)/this.camera.aspect));
    this.camera.updateProjectionMatrix();
    this.viewCam.aspect=innerWidth/innerHeight;this.viewCam.updateProjectionMatrix();
    this.renderer.setSize(innerWidth,innerHeight);
    this.composer.setSize(innerWidth,innerHeight);
  }

  /* ================= 输入 ================= */
  /* S1.5:输入抽象;键鼠监听在 KeyboardMouseAdapter 内,M4 可叠加触屏/手柄 */
  _setupInput(){
    this.inputMgr=new InputManager(this);
    this.inputMgr.attach(new KeyboardMouseAdapter(this));
  }

  /* 视角输入统一入口(鼠标/触屏/手柄共用) */
  applyLook(dx,dy){
    if(!this.player)return;
    const base=this.baseHFov||FOV_H;
    const zoom=Math.max(.28,(this._hfovCur||base)/base);
    const sens=this.settings?this.settings.get('sens'):this.sensMul;
    const adsSens=this.settings?this.settings.get('adsSens'):1;
    const inv=this.settings&&this.settings.get('yInvert')?-1:1;
    const s=.0021*sens*adsSens*zoom;
    this.player.yaw-=dx*s;
    // 水平角度规约,防长时间累积浮点漂移
    if(this.player.yaw>Math.PI)this.player.yaw-=Math.PI*2;
    else if(this.player.yaw<-Math.PI)this.player.yaw+=Math.PI*2;
    this.player.pitch-=dy*s*inv;
    // 行业标准(CS/瓦/网页FPS通用):俯仰钳制在 ±89°,越过天顶会天地颠倒、左右旋转反向
    this.player.pitch=Math.max(-1.553,Math.min(1.553,this.player.pitch));
  }

  /* S1.6:音频分轨音量应用(init 之后调用) */
  _applyAudioSettings(){
    if(!this.audio)return;
    this.audio.setVolume(this.settings.get('volume'));
    this.audio.setBus('sfx',this.settings.get('sfx'));
    this.audio.setBus('music',this.settings.get('music'));
    this.audio.setBus('radio',1);
    this.audio.setBus('ambient',1);
  }

  _requestLock(){
    const tryLock=()=>{
      try{
        // 行业标准:优先原始输入(unadjustedMovement),去除系统鼠标加速,转动幅度与硬件一致
        let p=null;
        try{p=this.renderer.domElement.requestPointerLock({unadjustedMovement:true});}
        catch(err){p=this.renderer.domElement.requestPointerLock();}
        if(p&&p.catch)p.catch(()=>{
          // 不支持原始输入时退回普通锁定;静默处理无手势/被拒场景,不污染调试条
          try{const q=this.renderer.domElement.requestPointerLock();if(q&&q.catch)q.catch(()=>{});}catch(err){}
        });
      }catch(e){}
    };
    tryLock();
    setTimeout(()=>{
      if(this.state==='playing'&&!document.pointerLockElement&&!this.fallbackAim)tryLock();
    },1400);
    setTimeout(()=>{
      if(this.state==='playing'&&!document.pointerLockElement&&!this.fallbackAim)this.fallbackAim=true;
    },2300);
  }

  /* 无指针锁定的 fallback 视角:光标贴左/右边缘时按比例持续旋转(行业标准 fallback),
     解决相对位移模式下"光标到边就转不动、瞄不到视野外目标"的问题 */
  _fallbackEdgeRotate(dt){
    if(!this.fallbackAim||this.state!=='playing'||!this.player.alive)return;
    const m=70,speed=2.8; // 边缘带宽 px / 最大角速度 rad/s
    const cx=this._mx==null?innerWidth/2:this._mx;
    let rate=0;
    if(cx<m)rate=-speed*(1-cx/m);
    else if(cx>innerWidth-m)rate=speed*(1-(innerWidth-cx)/m);
    if(rate)this.player.yaw-=rate*dt;
  }

  /* C5:迷彩来源(玩家用当前选择,机器人用各自存档/解锁) */
  camoFor(op){
    if(this.ui&&this.ui.sel&&op.id===this.ui.sel.operator&&this.ui.sel.camo)return this.ui.sel.camo;
    return this.ui&&this.ui.camoOf?this.ui.camoOf(op):'default';
  }

  /* ================= 状态切换 ================= */
  startGame(){
    const sel=this.ui.sel;
    this.mode=sel.mode;
    this.playerName=this.ui.playerName;
    if(sel.map!==this.world.mapKey)this.buildWorldFor(sel.map);
    // C5:玩家干员 = 名册选择;属性/武器/第一人称手臂全部按干员定义
    const op=byId(sel.operator)||byId(DEFAULT_OP);
    const hero=op.faction;
    this.playerOperator=op;
    this.ui.shareOp=op;
    this.playerFaction=hero;
    this.playerCamo=sel.camo||this.camoFor(op);
    this.player.god=false;this.invulnT=0;this.dmRespawnT=-1;
    this.grenades.reset();this.pickups.clear();
    this.damageBoostT=0;this.damageBoostMul=1;
    this.empT=0;
    this.ui.hideBoss();
    this.upgrades={dmg:0,rpm:0,reload:0,speed:0,hp:0,crit:0,pierce:0,regen:0};
    this.weapon.rpmMul=1;
    this.ui.hideUpgrades();
    this.player.maxHealth=op.hp;
    this.player.speed=5.2*op.speedMul;
    this.player.sprintSpeed=7.8*op.speedMul;
    this.weapon.reloadSpeedMul=op.reloadMul;
    this.weapon.recoilMul=op.recoilMul;
    // 基础移速 × 干员 × 武器负重(CS 机制)
    this.baseSpeed=5.2*op.speedMul;
    this.baseSprint=7.8*op.speedMul;
    this.weapon.speedCb=mul=>{
      this.player.speed=this.baseSpeed*mul;
      this.player.sprintSpeed=this.baseSprint*mul;
    };
    this.weapon.setFaction(op);
    // 主武器:阵营全部 4 把随身,菜单所选为出厂手持(CS 槽位:1 循环/2 沙鹰/3 军刀)
    const CT_P=['m4a4','aug','awp','mp5'],T_P=['ak47','sg553','awp','mp5'];
    const pool=hero==='ct'?CT_P:T_P;
    const first=pool.includes(sel.primary)?sel.primary:pool[0];
    const prims=[first,...pool.filter(x=>x!==first)];
    this.weapon.setLoadout(prims,0);
    this.ui.setHero(this.playerName,`${t('faction_'+hero)} · ${isEN()?op.name.en:op.name.zh}`);
    this.ui.abilityCd(-1);

    this.player.reset();
    this.weapon.resetAmmo();
    this.enemies.clearAll();
    this.heroes.clear();
    this.comboKills=0;this.comboT=0;
    this.stats={shots:0,hits:0,kills:0,critKills:0,time:0,bestCombo:0};
    this.score=0;this.shake=0;this.dyingT=0;
    this.startTime=performance.now()/1000;

    if(this.mode==='dm'){
      this.ui.setDmMode(true);
      this.waves.state='idle';
      this.dm={scores:new Map(),timer:240,winKills:25};
      this.dm.scores.set(this.playerName,{name:this.playerName,team:'A',kills:0,deaths:0,me:true,op:this.playerOperator});
      this.heroes.setup(this.playerFaction,this.playerName,op.id);
      for(const h of this.heroes.list)
        this.dm.scores.set(h.name,{name:h.name,team:h.team,kills:0,deaths:0,me:false,op:h.def});
      this.ui.banner(t('dm_start'),t('dm_sub'));
      this.audio.waveStart();
      this.ui.setScore(0);
    }else{
      this.ui.setDmMode(false);
      this.waves.reset();
      this.ui.banner(t('deployed'),t('hold_sub'));
    }

    this.state='playing';
    this.audio.musicStart('combat');
    this._musicLow=false;
    this.ui.showOnly(null);
    this.ui.setScore(this.score);
    this.ui.setHealth(this.player.health,this.player.maxHealth);
    this.fallbackAim=false;
    this._requestLock();
    // M3-G7:首次进入显示新手引导
    if(!this.shotMode&&!this.e2eMode&&!store.get('o07_tutorial_done')){
      this.state='tutorial';
      if(document.pointerLockElement)document.exitPointerLock();
      this.ui.showTutorial(TUTORIAL,()=>{
        store.set('o07_tutorial_done','1');
        this.state='playing';
        this.ui.showOnly(null);
        this._requestLock();
      });
    }
    for(const e of [...this.enemies.list])if(e.decor)this.enemies.kill(e,false,true);
    this.audio.setWind(.05);
  }

  pause(){
    if(this.state!=='playing')return;
    this.state='paused';
    this.input.firing=false;this.input.ads=false;
    this.audio.musicSet(.2);
    this.ui.showOnly('pause');
    if(document.pointerLockElement)document.exitPointerLock();
  }
  resume(){
    this.state='playing';
    this.audio.musicSet(.7);
    this.ui.showOnly(null);
    this._requestLock();
  }
  toMenu(){
    this.enemies.clearAll();
    this.heroes.clear();
    this.grenades.clear();
    this.pickups.clear();
    this.state='menu';
    this.audio.musicStart('menu');
    this.audio.musicSet(1);
    this.ui.showOnly('menu');
    this.ui.showBest(parseInt(localStorage.getItem('o07_best')||'0'));
    this._menuDrones();
  }

  _menuDrones(){
    this.enemies.spawn('WASP',new THREE.Vector3(24,3.2,-18),{entering:false,decor:true});
    this.enemies.spawn('REAPER',new THREE.Vector3(-26,3.8,10),{entering:false,decor:true});
    this.enemies.spawn('WASP',new THREE.Vector3(-10,2.6,-28),{entering:false,decor:true});
  }

  /* ================= 射击 ================= */
  _raySphere(origin,dir,c,r){
    const oc=_rsO.copy(origin).sub(c);
    const b=oc.dot(dir);
    const cc=oc.dot(oc)-r*r;
    const disc=b*b-cc;
    if(disc<0)return null;
    const t=-b-Math.sqrt(disc);
    return t>0?t:null;
  }

  fire(spread,opts={}){
    this.stats.shots++;
    const cam=this.camera;
    const def=this.weapon.def;
    // 行业标准:弹道取开火瞬间的权威 yaw/pitch,而非上一帧渲染相机(快速甩枪不滞后、不偏移)
    const pl=this.player;
    const sy=Math.sin(pl.yaw),cy=Math.cos(pl.yaw),sp=Math.sin(pl.pitch),cp=Math.cos(pl.pitch);
    const dir=this._sd.set(-sy*cp,sp,-cy*cp);

    // 军刀:近战范围判定(挥砍 40 / 重刺 65)
    if(def.melee){
      const range=opts.heavy?2.4:2.2;
      const dmg=opts.heavy?65:40;
      this.ray.set(cam.position,dir);this.ray.far=range;
      const sHits=this.ray.intersectObjects(this.world.shootStatics,false);
      let bestT=sHits.length?sHits[0].distance:range;
      let bestStatic=sHits.length?sHits[0]:null;
      let bestHero=null,bestEnemy=null,bestEnemyHit=null;
      for(const h of this.heroes.list){
        if(!h.alive||h.team===this.playerTeam)continue;
        for(const s of h.hitSpheres()){
          const t=this._raySphere(cam.position,dir,s.c,s.r);
          if(t!==null&&t<bestT){bestT=t;bestHero=h;bestStatic=null;}
        }
      }
      if(this.enemies.list.length){
        const groups=this.enemies.list.filter(e=>!e.decor).map(e=>e.group);
        if(groups.length){
          const eHits=this.ray.intersectObjects(groups,true);
          if(eHits.length&&eHits[0].distance<bestT){
            bestT=eHits[0].distance;bestEnemyHit=eHits[0];
            let o=eHits[0].object;
            while(o&&!o.userData.enemyRef)o=o.parent;
            bestEnemy=o?o.userData.enemyRef:null;bestStatic=null;
          }
        }
      }
      if(bestHero){
        bestHero.takeDamage(dmg,this.playerName);
        this.audio.knifeHit();this.ui.hitmark(false);
        this.effects.impact(this._send.copy(cam.position).addScaledVector(dir,bestT),UP,'metal');
      }else if(bestEnemy){
        this.enemies.damage(bestEnemy,'body',dmg,bestEnemyHit.point);
        this.audio.knifeHit();this.ui.hitmark(false);
      }else if(bestStatic){
        const n=bestStatic.face?this._sr.copy(bestStatic.face.normal).transformDirection(bestStatic.object.matrixWorld):UP;
        this.effects.impact(bestStatic.point,n,bestStatic.object.userData.surface||'concrete');
      }
      return;
    }

    const right=this._sr.set(cy,0,-sy);
    const up=this._su.set(sp*sy,cp,sp*cy);
    const a=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*spread;
    dir.addScaledVector(right,Math.cos(a)*r).addScaledVector(up,Math.sin(a)*r).normalize();

    // 1. 静态
    this.ray.set(cam.position,dir);this.ray.far=400;
    const sHits=this.ray.intersectObjects(this.world.shootStatics,false);
    let bestT=sHits.length?sHits[0].distance:400;
    let bestStatic=sHits.length?sHits[0]:null;
    // 2. 无人机(waves)
    let bestEnemy=null,bestEnemyHit=null;
    if(this.enemies.list.length){
      const groups=this.enemies.list.filter(e=>!e.decor).map(e=>e.group);
      if(groups.length){
        const eHits=this.ray.intersectObjects(groups,true);
        if(eHits.length&&eHits[0].distance<bestT){
          bestT=eHits[0].distance;bestEnemyHit=eHits[0];
          let o=eHits[0].object;
          while(o&&!o.userData.enemyRef)o=o.parent;
          bestEnemy=o?o.userData.enemyRef:null;
        }
      }
    }
    // 3. 角色(dm,球体近似)
    let bestHero=null,bestHeroPart=null;
    for(const h of this.heroes.list){
      if(!h.alive||h.team===this.playerTeam)continue;
      for(const s of h.hitSpheres()){
        const t=this._raySphere(cam.position,dir,s.c,s.r);
        if(t!==null&&t<bestT){bestT=t;bestHero=h;bestHeroPart=s.part;}
      }
    }

    const end=this._send.copy(cam.position).addScaledVector(dir,bestT);
    const muzzle=cam.localToWorld(this.weapon.muzzleCameraLocal(this._muzzle));
    this.effects.tracer(muzzle,dir,cam.position.distanceTo(end),
      {color:def.tracer,width:def.tracerW,speed:def.tracerSpeed});
    this.effects.muzzleSmoke(muzzle);

    if(bestHero){
      this.stats.hits++;
      const head=bestHeroPart==='head';
      const dmg=def.dmg*(head?this.playerCritMul():1)*this.playerDamageMul();
      bestHero.takeDamage(dmg,this.playerName);
      this.audio.hit(head);
      this.ui.hitmark(head);
      this.effects.impact(end,UP,'metal');
    }else if(bestEnemy){
      this.stats.hits++;
      const part=bestEnemyHit.object.userData.part||'body';
      const res=this.enemies.damage(bestEnemy,part,def.dmg*this.playerDamageMul(),bestEnemyHit.point);
      this.audio.hit(res.crit);
      this.ui.hitmark(res.crit);
    }else if(bestStatic){
      const n=bestStatic.face?this._sr.copy(bestStatic.face.normal).transformDirection(bestStatic.object.matrixWorld):UP;
      this.effects.impact(bestStatic.point,n,bestStatic.object.userData.surface||'concrete');
    }
    // M3-G3:穿甲弹 —— 对射线后方第二个目标造成 60% 伤害
    if(this.upgrades&&this.upgrades.pierce>0&&(bestEnemy||bestHero)&&bestT<399){
      const org=this._pierceO.copy(cam.position).addScaledVector(dir,bestT+.15);
      this.ray.set(org,dir);this.ray.far=60;
      const s2=this.ray.intersectObjects(this.world.shootStatics,false);
      let limit=s2.length?s2[0].distance:60;
      let second=null,secondHero=null;
      if(this.enemies.list.length){
        const groups=this.enemies.list.filter(e=>!e.decor).map(e=>e.group);
        const h2=groups.length?this.ray.intersectObjects(groups,true):[];
        if(h2.length&&h2[0].distance<limit){
          limit=h2[0].distance;
          let o=h2[0].object;while(o&&!o.userData.enemyRef)o=o.parent;
          second=o?o.userData.enemyRef:null;
        }
      }
      for(const h of this.heroes.list){
        if(!h.alive||h.team===this.playerTeam)continue;
        for(const s of h.hitSpheres()){
          const t=this._raySphere(org,dir,s.c,s.r);
          if(t!==null&&t<limit){limit=t;secondHero=h;second=null;}
        }
      }
      const pd=def.dmg*.6*this.playerDamageMul();
      if(second)this.enemies.damage(second,'body',pd,org);
      if(secondHero)secondHero.takeDamage(pd,this.playerName);
    }

    // 爆炸弹 AoE
    if(def.explosive){
      this.effects.explosion(end,1.15);
      this.audio.explosion(cam.position.distanceTo(end));
      for(const e of [...this.enemies.list]){
        if(e.decor)continue;
        const d=e.pos.distanceTo(end);
        if(d<def.blastR)this.enemies.damage(e,'body',def.blastDmg*(1-d/def.blastR),end);
      }
      for(const h of this.heroes.list){
        if(h.team===this.playerTeam||!h.alive)continue;
        const d=h.pos.distanceTo(end);
        if(d<def.blastR)h.takeDamage(def.blastDmg*(1-d/def.blastR),this.playerName);
      }
      this.shake=Math.max(this.shake,def.shake||.1);
    }
  }

  scorePopAt(pos,text){
    this.ui.scorePop(pos.clone().add(new THREE.Vector3(0,.5,0)),this.camera,text,false);
  }

  addScore(pts,pos,crit=false){
    this.score+=pts;
    this.ui.setScore(this.score);
    if(pos)this.ui.scorePop(pos,this.camera,`+${pts}`,crit);
  }

  _onKill(e,crit){
    this.stats.kills++;
    if(crit)this.stats.critKills++;
    this.comboT=4;this.comboKills++;
    if(this.comboKills>=2)this.ui.combo(this.comboKills);
    const comboMul=[1,1.25,1.5,2,2.5][Math.min(4,this.comboKills-1)];
    this.stats.bestCombo=Math.max(this.stats.bestCombo,comboMul);
    const pts=Math.round(e.T.score*(crit?1.5:1)*comboMul);
    this.addScore(pts,e.pos.clone().add(new THREE.Vector3(0,.4,0)),crit);
    this.audio.kill();
    // M3-G2:15% 概率掉落补给
    if(!e.decor&&Math.random()<.15){
      const type=['ammo','med','boost'][Math.floor(Math.random()*3)];
      this.pickups.spawn(e.pos,type);
    }
    // M3-G3:战场恢复
    if(this.upgrades&&this.upgrades.regen)this.player.heal(5*this.upgrades.regen);
  }

  /* M3-G3:每 3 波三选一强化 */
  openUpgrade(){
    if(this.state!=='playing')return;
    this.state='upgrade';
    const cards=rollUpgrades(this,3);
    this._upgradeCards=cards;
    if(document.pointerLockElement)document.exitPointerLock();
    this.ui.showUpgrades(cards,id=>this._applyUpgrade(id));
  }
  _applyUpgrade(id){
    const ok=applyUpgrade(this,id);
    this.ui.hideUpgrades();
    this._upgradeCards=null;
    if(this.state==='upgrade')this.state='playing';
    this._requestLock();
    if(ok)this.ui.banner(t('upgrade_applied'),'');
    return ok;
  }
  _pickUpgrade(i){
    const c=this._upgradeCards&&this._upgradeCards[i];
    return c?this._applyUpgrade(c.id):false;
  }

  /* M3-G3:暴击倍率(基础 2x + 升级) */
  playerCritMul(){return 2+.25*(this.upgrades&&this.upgrades.crit||0);}

  /* M3-G2/G3:玩家伤害倍率(强化道具 + 波次升级) */
  playerDamageMul(){
    const boost=this.damageBoostT>0?(this.damageBoostMul||1):1;
    const up=this.upgrades?(1+.15*(this.upgrades.dmg||0)):1;
    return boost*up;
  }

  /* ================= 乱斗判定 ================= */
  onHeroKill(killerName,victimHero){
    if(this.mode!=='dm'||!this.dm)return;
    const k=this.dm.scores.get(killerName);
    if(k)k.kills++;
    const v=this.dm.scores.get(victimHero.name);
    if(v)v.deaths++;
    const mine=killerName===this.playerName;
    this.ui.killFeed(killerName,victimHero.name,t('kill_verb'),mine);
    const ks=this.dm.scores.get(killerName);
    this.ui.killCard({
      killer:killerName,victim:victimHero.name,
      weapon:(ks&&ks.op&&ks.op.rifle||'rifle').toUpperCase(),
      mine,killerOp:ks&&ks.op||this.playerOperator,victimOp:victimHero.def,
    });
    if(mine){
      this.stats.kills++;
      this.addScore(200,victimHero.pos.clone().add(new THREE.Vector3(0,1.4,0)));
      this.audio.kill();
    }
    this._checkDmWin();
  }
  botDamageFx(hero,pos){
    this.effects.impact(pos,UP,'metal');
  }
  damagePlayerFromBot(dmg,fromName,fromPos){
    if(this.player.god||this.invulnT>0||!this.player.alive)return;
    this.player.damage(dmg,this.time);
    this.ui.damageFlash(.55);
    this.shake=Math.max(this.shake,.1);
    this.audio.hurt();
    this._showDamageDirection(fromPos);
    if(this.player.health<=0){
      const src=this.heroes.list.find(h=>h.name===fromName);
      this.ui.killCard({
        killer:fromName,victim:this.playerName,
        weapon:(src&&src.def.rifle||'rifle').toUpperCase(),
        mine:false,killerOp:src&&src.def,victimOp:this.playerOperator,
      });
    }
  }
  /* U2:世界坐标 → 屏幕方向(0 正前,正值顺时针),0.8s 淡出 */
  _showDamageDirection(fromPos){
    if(!fromPos||!this.player)return;
    const dx=fromPos.x-this.player.pos.x;
    const dz=fromPos.z-this.player.pos.z;
    const world=Math.atan2(dx,dz);
    const forward=this.player.yaw+Math.PI;
    let rel=forward-world;
    while(rel>Math.PI)rel-=Math.PI*2;
    while(rel<-Math.PI)rel+=Math.PI*2;
    this.ui.damageDirection(rel);
  }
  shakeFrom(pos,amt){
    const d=this.camera.position.distanceTo(pos);
    this.shake=Math.max(this.shake,amt*Math.max(.3,1-d/25));
  }
  _showBoard(){
    const rows=[...this.dm.scores.values()].sort((a,b)=>b.kills-a.kills);
    this.ui.scoreboard(rows,this._factionLabels());
  }
  _factionLabels(){
    const a=this.playerFaction==='ct'?'CT':'T';
    return {A:a,B:a==='CT'?'T':'CT'};
  }
  _checkDmWin(){
    let a=0,b=0;
    for(const s of this.dm.scores.values()){
      if(s.team==='A')a+=s.kills;else b+=s.kills;
    }
    this.ui.setDmScore(a,b,this.dm.timer);
    if(a>=this.dm.winKills||b>=this.dm.winKills)this._endDm(a,b);
  }
  _endDm(a,b){
    if(this.state==='over')return;
    this.state='over';
    const win=a>b;
    const lab=this._factionLabels();
    const rows=[...this.dm.scores.values()].sort((x,y)=>y.kills-x.kills)
      .map(r=>`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td><td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?lab.A:lab.B}</span></td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
    const mvpRow=[...this.dm.scores.values()].sort((a,b)=>b.kills-a.kills)[0];
    const mvp=mvpRow?{name:mvpRow.name,op:mvpRow.op||this.playerOperator,kills:mvpRow.kills,deaths:mvpRow.deaths}:null;
    const best=parseInt(store.get('o07_best','0'))||0;
    if(this.score>best)store.set('o07_best',this.score);
    this.audio.gameOver();
    this.ui.showOver({
      title:win?t('win'):t('lose'),
      win,kicker:t('dm_over_kicker'),
      stats:{...this.stats,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:Math.floor(this.stats.time/60),s:Math.floor(this.stats.time%60)}),score:this.score,best:Math.max(best,this.score),mvp},
      board:`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>${rows}</table>`,
    });
    if(document.pointerLockElement)document.exitPointerLock();
  }

  /* ================= 主循环 ================= */
  tick(){
    const dtRaw=Math.min(.05,this.clock.getDelta());
    let dt=dtRaw;
    // 卡顿监控:慢帧(>25ms)计数与最大帧耗时
    this.perf.frames++;
    if(dtRaw>.025)this.perf.slow++;
    if(dtRaw>this.perf.maxDt)this.perf.maxDt=dtRaw;
    if(this.perfMode&&this.perf.frames%180===0)
      console.log(`[PERF] frames=${this.perf.frames} slow=${this.perf.slow} max=${(this.perf.maxDt*1000).toFixed(1)}ms`);
    this.inputMgr&&this.inputMgr.update(dtRaw);
    if(this.state==='dying'){
      dt*=.3;
      this.dyingT-=dtRaw;
      if(this.dyingT<=0){
        this.state='over';
        const best=parseInt(store.get('o07_best','0'))||0;
        if(this.score>best)store.set('o07_best',this.score);
        this.ui.showOver({
          title:t('fail_title'),win:false,kicker:t('kicker_lost'),
          stats:{...this.stats,wave:this.waves.n,score:this.score,best:Math.max(best,this.score)},
        });
      }
    }
    const active=this.state==='playing'||this.state==='dying';
    this.time+=dt;
    this.weapon.group.visible=active||this.state==='paused';
    if(this.state!=='playing')this.ui.setScope(false); // 非战斗状态强制收镜

    if(active){
      this.stats.time+=dt;
      // dm 重生
      if(this.mode==='dm'&&this.dmRespawnT>0){
        this.dmRespawnT-=dtRaw;
        if(this.dmRespawnT<=0){
          this.player.pos.set((Math.random()-.5)*6,0,24);
          this.player.yaw=0;this.player.pitch=0;
          this.player.vel.set(0,0,0);
          this.player.velY=0;this.player.grounded=true;this.player.airborne=false;
          this.player.alive=true;
          this.player.health=this.player.maxHealth;
          this.player.god=true;this.invulnT=2;
          this.audio.respawn();
          this.ui.deathFlash();
        }
      }
      if(this.invulnT>0){
        this.invulnT-=dt;
        if(this.invulnT<=0)this.player.god=false;
      }

      this._fallbackEdgeRotate(dt);
      this.player.update(dt,this.input,this.keys,this.time,this.audio);
      this.weapon.update(dt,this.input,this.player,this.camera,this.time,(d,opts)=>this.fire(d,opts));

      if(this.mode==='dm'){
        this.heroes.update(dt,this.time,(a,b)=>this._los(a,b));
        if(this.dm&&this.state==='playing'){
          this.dm.timer-=dt;
          if(this.dm.timer<=0){
            let a=0,b=0;
            for(const s of this.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
            this._endDm(a,b);
          }
          let a=0,b=0;
          for(const s of this.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
          this.ui.setDmScore(a,b,this.dm.timer);
        }
      }else{
        this.enemies.update(dt,this.player,this.world.colliders,this.time,this);
        this.waves.update(dt);
        const boss=this.enemies.list.find(e=>e.boss);
        if(boss)this.ui.setBoss(boss.hp/boss.maxHp,t('boss_name'));
        else this.ui.hideBoss();
      }

      if(this.comboT>0){this.comboT-=dt;if(this.comboT<=0)this.comboKills=0;}

      // 后坐 + 震屏
      let kick=this.weapon.camKick;
      // 抬头接近天顶时后坐不再继续上抬(否则越过 90° 进入翻转区,压枪手感失效);
      // 贴顶期间后坐存量快速泄放,把"下压死区"减半
      const headroom=1.553-this.player.pitch;
      if(kick>headroom){
        kick=Math.max(0,headroom);
        this.weapon.camKick*=Math.max(0,1-16*dt);
      }else if(kick<(-1.553-this.player.pitch)){
        kick=-1.553-this.player.pitch;
        this.weapon.camKick*=Math.max(0,1-16*dt);
      }
      this.camera.rotation.x+=kick;
      this.camera.rotation.y+=this.weapon.camKickYaw; // 弹道模式水平漂移
      this.camera.rotation.y+=(Math.random()-.5)*this.shake*.06;
      this.camera.rotation.z=(Math.random()-.5)*this.shake*.05;
      // 相机最终俯仰钳制:后坐/甩枪任何情况都不得越过天顶
      this.camera.rotation.x=Math.max(-1.553,Math.min(1.553,this.camera.rotation.x));
      this.shake=Math.max(0,this.shake-dt*.5);

      // HUD
      this.ui.setHealth(this.player.health,this.player.maxHealth);
      this.ui.crosshair(this.weapon.spreadRad(this.player),
        this.camera.fov,innerHeight,this.weapon.adsAmt);
      this.ui.hint(this.weapon.ammo<=8&&!this.weapon.reloading&&this.weapon.st.reserve>0?t('hint_reload'):
        (!document.pointerLockElement&&!this.fallbackAim?t('hint_lock'):''));
      if(this.player.alive===false&&this.state==='playing'){
        if(this.mode==='dm'){
          this.dmRespawnT=2.5;
          this.ui.deathFlash();
          this.audio.hurt();
          if(document.pointerLockElement)document.exitPointerLock();
        }else{
          this.state='dying';this.dyingT=1.5;
          this.ui.deathFlash();
          this.audio.gameOver();
          this.audio.whineStop();
          this.audio.setDrone(0);
          if(document.pointerLockElement)document.exitPointerLock();
        }
      }
      // 相机/开镜状态(可被 e2e 确定性调用)
      this._applyCameraState();
    }else if(this.state==='menu'){
      const t=performance.now()*.001*.06;
      this.camera.position.set(Math.cos(t)*24,6.2+Math.sin(t*.7)*1.2,Math.sin(t)*24);
      this.camera.lookAt(0,1.8,0);
      this.camera.rotation.z=0;
      this.enemies.update(dt,this.player,this.world.colliders,this.time,this);
    }

    for(const fn of this.world.worldAnim)fn(this.time);
    this.effects.setCamPos(this.camera.position);
    this.effects.update(dt);
    this.grenades.update(dt);
    this.pickups.update(dt,this.player);
    if(this.damageBoostT>0)this.damageBoostT=Math.max(0,this.damageBoostT-dt);
    if(this.empT>0)this.empT=Math.max(0,this.empT-dt);
    // M3-G5:雷达(设置开关 + EMP 干扰)
    const rc=document.getElementById('radar');
    if(rc){
      const on=this.settings.get('radar')&&this.state==='playing';
      rc.classList.toggle('hidden',!on);
      if(on)this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,this.empT>0);
    }
    this.ui.update(dt,this.player.health,this.player.maxHealth);
    // M2-A6:低血量 BGM 紧张度(状态翻转时才写,避免每帧调度)
    if(this.state==='playing'){
      const low=this.player.health/this.player.maxHealth<.35;
      if(low!==this._musicLow){this._musicLow=low;this.audio.musicSet(low?.9:.7);}
    }
    this.audio.setWind(this.state==='menu'?.08:.05);

    // 阴影隔帧渲染(autoUpdate 已关):奇数帧重算投影,偶数帧沿用上帧深度
    this._frame=(this._frame||0)+1;
    this.renderer.shadowMap.needsUpdate=(this._frame&1)===1;

    this.composer.render();
  }

  /* 相机/开镜状态同步(AUG/AWP/SG 553 开镜:高倍变焦 + 镜筒遮罩 + 隐藏枪体) */
  _applyCameraState(){
    const scoping=this.weapon.def.scope&&this.weapon.adsAmt>.8&&this.player.alive;
    this.ui.setScope(scoping);
    this.weapon.group.visible=!scoping;
    this.viewCam.fov=75+(58-75)*this.weapon.adsAmt;
    this.viewCam.updateProjectionMatrix();
    // 开镜/ADS 缩放沿用原垂直 FOV 比例(scopeFov 或 62 对 75),作用到水平视野上
    const zoomH=this.weapon.def.scope?(this.weapon.def.scopeFov||30)/75:62/75;
    const hFov=(this.baseHFov||FOV_H)*(1-(1-zoomH)*this.weapon.adsAmt);
    this._hfovCur=hFov;
    const targetFov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(hFov)*.5)/this.camera.aspect));
    if(Math.abs(this.camera.fov-targetFov)>.01){
      this.camera.fov=targetFov;this.camera.updateProjectionMatrix();
    }
  }

  _los(a,b){
    const dir=b.clone().sub(a);
    const len=dir.length();
    if(len<.5)return true;
    this.losRay.set(a,dir.normalize());this.losRay.far=len-.3;
    const hits=this.losRay.intersectObjects(this.world.shootStatics,false);
    return hits.length===0;
  }

  /* ================= 验证钩子 ================= */
  /* S1.1:?roster=1 打印干员名册(名册 UI 在 M1-C4 落地) */
  _debugRoster(){
    const rows=OPERATORS.map(o=>({
      id:o.id,faction:o.faction,gender:o.gender,role:o.role.zh,
      hp:o.hp,speedMul:o.speedMul,reloadMul:o.reloadMul,rifle:o.rifle,
    }));
    console.table(rows);
    console.log(`[ROSTER] ${OPERATORS.length} operators · CT ${byFaction('ct').length} / T ${byFaction('t').length}`);
    return rows;
  }

  /* S1.3:?portraits=1 生成 8 张立绘并打印耗时/体积 */
  _debugPortraits(){
    const t0=performance.now();
    const rows=OPERATORS.map(o=>{
      const url=this.portraits.render(o);
      return {id:o.id,ok:!!url,bytes:url?url.length:0};
    });
    const ms=performance.now()-t0;
    console.table(rows);
    console.log(`[PORTRAITS] ${rows.filter(r=>r.ok).length}/${rows.length} in ${ms.toFixed(0)}ms`);
    return {ms,rows};
  }

  /* C1:控制台切换 1 号机器人外观(看剪影/配色) */
  debugSetOperator(id){
    const op=byId(id);
    if(!op)return false;
    const h=this.heroes&&this.heroes.list[0];
    if(h)h.setOperator({...op,camo:this.camoFor(op)});
    return !!h;
  }

  /* M3-G2:调试生成掉落物 */
  debugSpawnPickup(type){return this.pickups.spawn(this.player.pos,type);}

  /* M3-G1:调试投掷手雷 */
  debugThrow(type){return this.grenades.throw(type);}

  /* M2-A1:调试击杀指定 bot(看死亡动画/击杀卡) */
  debugKillBot(id){
    const h=this.heroes.list.find(x=>x.opId===id);
    if(h)h.takeDamage(9999,'DEBUG');
    return !!h;
  }

  /* C6:内存快照(10 次 DM 进出不增长验收) */
  debugMemory(){
    const m=this.renderer.info.memory;
    const geos=new Set(),mats=new Set();
    for(const h of this.heroes.list)h.group.traverse(o=>{
      if(o.isMesh){geos.add(o.geometry);if(o.material)mats.add(o.material);}
    });
    return {geometries:m.geometries,textures:m.textures,heroGeos:geos.size,heroMats:mats.size};
  }

  _shotCombat(){
    this.startGame();
    this.fallbackAim=true;
    this.player.god=true;
    this.player.pos.set(0,0,7);
    this.player.yaw=0;this.player.pitch=-.02;
    this.enemies.spawn('WASP',new THREE.Vector3(-5,2.6,-16),{entering:false});
    this.enemies.spawn('REAPER',new THREE.Vector3(7,3,-20),{entering:false});
    this.enemies.spawn('WARDEN',new THREE.Vector3(-13,2.4,-26),{entering:false});
    this.enemies.spawn('WASP',new THREE.Vector3(2,3.4,-30),{entering:false});
    this.ui.setWave(1);this.ui.setRemain(4);
  }
  _shotDm(){
    this.ui.sel.mode='dm';
    this.startGame();
    this.fallbackAim=true;
    this.player.god=true;
    this.ui.killFeed('雪狼','火狐','AK-47',false);
    this.ui.killFeed(this.playerName,'秃鹫','M4A4',true);
    this.ui.setDmScore(7,5,213);
  }
  /* M3-G7:新手引导截图 */
  _shotTutorial(){this.ui.showTutorial(TUTORIAL,()=>{});}

  /* M2-A3:击杀卡截图 */
  _shotKillcard(){
    const k=byId('frost'),v=byId('raven');
    this.ui.killCard({
      killer:isEN()?k.name.en:k.name.zh,victim:isEN()?v.name.en:v.name.zh,
      weapon:'M4A4',mine:true,killerOp:k,victimOp:v,
    });
  }

  /* M2-A4:MVP 结算截图 */
  _shotMvp(){
    const op=byId('frost');
    this.ui.showOver({
      title:t('win'),win:true,kicker:t('dm_over_kicker'),
      stats:{time:312,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:5,s:12}),
        kills:42,critKills:11,hits:280,shots:430,score:18960,best:21450,bestCombo:4,
        mvp:{name:isEN()?op.name.en:op.name.zh,op,kills:19,deaths:2}},
      board:`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>
        <tr class="me"><td>${isEN()?op.name.en:op.name.zh}</td><td>CT</td><td>19</td><td>2</td></tr></table>`,
    });
  }

  _shotOver(){
    this.ui.showOver({
      title:'哨站失守',win:false,kicker:'信号中断 · SIGNAL LOST',
      stats:{time:354,wave:9,kills:63,critKills:21,hits:412,shots:648,score:21450,best:22800,bestCombo:2},
    });
  }

  /* ================= 集成测试(?e2e=1):浏览器端到端断言 =================
     确定性驱动(手动步进 update),不依赖 rAF —— 后台标签页/无头环境可复现。
     结果:window.__e2e = {pass, fail, results[]} */
  async e2e(){
    store.set('o07_tutorial_done','1'); // e2e 环境跳过首次引导
    const results=[];let pass=0;
    const run=async(name,fn)=>{
      try{await fn();results.push({name,ok:true});pass++;}
      catch(err){results.push({name,ok:false,err:err&&err.message||String(err)});}
    };
    const assert=(c,m)=>{if(!c)throw new Error(m);};
    const stepW=n=>{for(let i=0;i<n;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});};
    const stepP=n=>{for(let i=0;i<n;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);};

    await run('boot-no-errors',()=>{
      assert(!this.ui.errors.some(e=>e.startsWith('ERR')),'启动期存在错误: '+this.ui.errors.join(';'));
    });
    await run('loadout-ct-aug',()=>{
      this.ui.sel.operator='frost';this.ui.sel.hero='ct';this.ui.sel.primary='aug';this.ui.sel.mode='waves';
      this.startGame();this.fallbackAim=true;this.player.god=true;
      assert(this.weapon.def.id==='aug','应为 AUG,实际 '+this.weapon.def.id);
    });
    await run('scope-zoom-2-5x',()=>{
      this.input.ads=true;stepW(60);this._applyCameraState();
      assert(this.camera.fov<32,'FOV 应≈30,实际 '+this.camera.fov.toFixed(1));
      assert(!this.weapon.group.visible,'开镜应隐藏枪体');
      assert(document.getElementById('scope-overlay').classList.contains('show'),'镜筒遮罩应显示');
      this.input.ads=false;stepW(60);this._applyCameraState();
      assert((this._hfovCur||0)>90,'收镜应恢复腰射横向视野106,实际 '+((this._hfovCur||0).toFixed(1)));
    });
    await run('recoil-pattern',()=>{
      this.weapon.setLoadout('ak47');
      this.weapon.recoilIdx=0;this.weapon.camKick=0;this.weapon.camKickYaw=0;
      this.input.firing=true;
      for(let i=0;i<30;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.recoilIdx>=4,'连续射击应累计弹道序号,实际 '+this.weapon.recoilIdx);
      assert(this.weapon.camKick>0,'后坐应抬升视角');
      this.input.firing=false;
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.recoilIdx===0,'停火后弹道模式应复位');
    });
    await run('flick-same-frame-hit',()=>{
      // 快速甩枪回归:甩到位后同帧开火,弹道取当前 yaw/pitch(不依赖上一帧相机矩阵)
      this.input.firing=false;
      this.enemies.clearAll();
      const p=this.player;
      p.pos.set(0,0,7);p.velY=0;p.grounded=true;p.vel.set(0,0,0);
      const tgt=new THREE.Vector3(6,1.6,-8);
      const e=this.enemies.spawn('WASP',tgt,{entering:false});
      e.group.updateMatrixWorld(true); // 同同步块内 raycast 需先刷新矩阵(否则射线漏判)
      p.update(.016,this.input,this.keys,this.time,this.audio); // 先同步相机/眼睛位置
      const eye=p.pos.y+1.62;
      const dx=tgt.x-p.pos.x,dz=tgt.z-p.pos.z,dy=tgt.y-eye;
      const wantYaw=Math.atan2(-dx,-dz),wantPitch=Math.atan2(dy,Math.hypot(dx,dz));
      p.yaw=wantYaw+1.4;p.pitch=0;
      p.update(.016,this.input,this.keys,this.time,this.audio); // 上一帧:还看着别处
      p.yaw=wantYaw;p.pitch=wantPitch;                          // 同帧甩到位,不刷帧直接开火
      this.weapon.st.ammo=30;
      const hits0=this.stats.hits,hp0=e.hp;
      this.fire(0);
      assert(this.stats.hits>hits0&&e.hp<hp0,'同帧 flick 开火应命中当前朝向目标(hp '+hp0+'→'+e.hp+')');
      this.enemies.kill(e,false,true);
    });
    await run('jump-gravity',()=>{
      this.player.pos.set(0,0,7);this.player.velY=0;this.player.grounded=true;this.player.pitch=0;
      this.keys.add('Space');
      this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(!this.player.grounded&&this.player.velY>0,'起跳应有向上初速度');
      this.keys.delete('Space');
      for(let i=0;i<90;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.player.grounded&&Math.abs(this.player.pos.y)<.01,'应受重力落回地面 y=0,实际 y='+this.player.pos.y.toFixed(2));
    });
    await run('crate-landing',()=>{
      const c=this.world.colliders.find(c=>c.top>1.05&&c.top<1.25);
      assert(c,'场景应有 ~1.1m 可攀爬箱体');
      this.player.pos.set(c.minX+(c.maxX-c.minX)/2,c.top+1.2,c.minZ+(c.maxZ-c.minZ)/2);
      this.player.velY=-2;this.player.grounded=false;
      for(let i=0;i<60;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(Math.abs(this.player.pos.y-c.top)<.02,'应落在箱顶 '+c.top+' 实际 '+this.player.pos.y.toFixed(2));
    });
    await run('crouch-steady',()=>{
      this.keys.add('ControlLeft');
      for(let i=0;i<30;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.player.crouching,'应进入蹲伏');
      assert(this.player.eyeHCur<1.35,'蹲伏眼高应降低,实际 '+this.player.eyeHCur.toFixed(2));
      const sC=this.weapon.spreadRad(this.player);
      this.keys.delete('ControlLeft');
      for(let i=0;i<30;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.weapon.spreadRad(this.player)>sC,'站姿散布应大于蹲姿');
    });
    await run('primary-cycle-4',()=>{
      this.weapon.setLoadout(['m4a4','aug','awp','mp5'],0);
      const seq=[];
      for(let i=0;i<4;i++){
        this.weapon.switchTo(0); // 反复按 1:同槽循环
        stepW(25);
        seq.push(this.weapon.def.id);
      }
      assert(JSON.stringify(seq)===JSON.stringify(['aug','awp','mp5','m4a4']),'同槽循环顺序: '+seq.join(','));
      this.weapon.switchTo(this.weapon.primaryCount+1);stepW(25);
      assert(this.weapon.def.id==='knife','应切到军刀');
      this.weapon.switchTo(0);stepW(25);
      assert(this.weapon.def.id==='m4a4','按 1 应回到最近主武器 m4a4');
    });
    await run('weapon-speed-weight',()=>{
      this.weapon.setLoadout(['m4a4','aug','awp','mp5'],0);
      this.weapon.switchTo(2);stepW(40); // AWP
      const awpSpd=this.player.speed;
      this.weapon.switchTo(0);stepW(40); // M4A4
      const m4Spd=this.player.speed;
      this.weapon.switchTo(this.weapon.primaryCount+1);stepW(40); // 军刀
      const knifeSpd=this.player.speed;
      assert(awpSpd<m4Spd,'AWP 负重应比 M4A4 慢: '+awpSpd.toFixed(2)+' vs '+m4Spd.toFixed(2));
      assert(knifeSpd>m4Spd,'持军刀应最快: '+knifeSpd.toFixed(2)+' vs '+m4Spd.toFixed(2));
    });
    await run('crit-damage-x2-5',()=>{
      this.enemies.clearAll();this.scene.updateMatrixWorld(true);
      const e=this.enemies.spawn('WASP',this.player.eye.clone().add(new (this.camera.position.constructor)(0,0,-6)),{entering:false});
      e.pos.y=1.62;e.group.position.copy(e.pos);this.scene.updateMatrixWorld(true);
      const hp0=e.hp;
      const res=this.enemies.damage(e,'core',10,e.pos.clone());
      assert(res.crit&&Math.abs(e.hp-(hp0-25))<.01,'红核应 ×2.5: hp '+hp0+' → '+e.hp.toFixed(1));
      this.enemies.clearAll();
    });
    await run('xss-escape',()=>{
      this.ui.killFeed('<img src=x onerror=window.__xssE2E=1>','<b>victim</b>','AK-47',false);
      assert(!window.__xssE2E,'XSS 不应执行');
      assert(!document.querySelector('#killfeed img'),'昵称应被转义');
    });
    await run('pitch-clamp-89',()=>{
      this.player.pitch=Math.PI;this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.camera.rotation.x<Math.PI/2+.01,'俯仰应钳制在 ±89°,不得越过天顶翻转,实际 '+this.camera.rotation.x.toFixed(2));
      this.player.pitch=-Math.PI;this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.camera.rotation.x>-.01-Math.PI/2,'俯仰下限同样钳制,实际 '+this.camera.rotation.x.toFixed(2));
      this.player.pitch=0;this.player.update(.016,this.input,this.keys,this.time,this.audio);
    });

    await run('operators-8',()=>{
      this.ui.sel.operator='frost';this.ui.sel.hero='ct';this.ui.sel.primary='m4a4';this.ui.sel.mode='dm';
      this.startGame();
      const ids=this.heroes.list.map(h=>h.opId);
      assert(ids.length===5,'DM 应有 5 名 bot,实际 '+ids.length);
      assert(new Set(ids).size===5,'同局不应出现重复干员: '+ids.join(','));
      assert(!ids.includes('frost'),'机器人不应与玩家干员重复');
      assert(this.heroes.list.filter(h=>h.team==='A').length===2,'队友应为 2 人');
      assert(this.heroes.list.filter(h=>h.team==='B').length===3,'敌人应为 3 人');
      for(const h of this.heroes.list){
        assert(h.materials.length===12,'每角色材质应≤12,实际 '+h.materials.length);
        assert(h.parts.head&&h.parts.gunTip,'角色部件应完整');
      }
    });
    await run('fp-arms-faction',()=>{
      this.weapon.setFaction(byId('frost'));
      const ct=this.weapon._armSleeves[0].color.getHex();
      this.weapon.setFaction(byId('raven'));
      const t=this.weapon._armSleeves[0].color.getHex();
      assert(ct!==t,'CT/T 第一人称袖套颜色应不同: '+ct.toString(16)+' vs '+t.toString(16));
    });
    await run('pickup-magnet',()=>{
      this.ui.sel.mode='dm';this.startGame();
      this.player.god=true;this.player.health=50;
      const p=this.pickups.spawn(this.player.pos.clone(),'med');
      this.pickups.update(.016,this.player);
      assert(this.player.health>50,'医疗掉落应回血');
      assert(!this.pickups.list.includes(p),'拾取后应移除掉落物');
    });
    await run('pickup-ammo',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const before=this.weapon.state[this.weapon.cur].reserve;
      this.pickups.spawn(this.player.pos.clone(),'ammo');
      this.pickups.update(.016,this.player);
      assert(this.weapon.state[this.weapon.cur].reserve>before,'弹药掉落应增加备弹');
      this.pickups.spawn(this.player.pos.clone(),'boost');
      this.pickups.update(.016,this.player);
      assert(this.damageBoostT>9&&this.playerDamageMul()>=1.4,'强化掉落应提升伤害倍率');
    });
    await run('tutorial',()=>{
      this.ui.showTutorial(TUTORIAL,()=>{});
      const root=document.getElementById('tutorial');
      assert(!root.classList.contains('hidden'),'引导应显示');
      const first=document.getElementById('tut-title').textContent;
      this.ui.nextTutorial();
      assert(document.getElementById('tut-title').textContent!==first,'下一步应切换步骤');
      this.ui.closeTutorial(false);
      assert(root.classList.contains('hidden'),'跳过后应隐藏');
    });
    await run('bot-cover',()=>{
      this.settings.set('botDifficulty','hard');
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      assert(h.difficulty==='hard','Bot 难度应读取设置');
      assert(h.coverTarget===null,'初始不应有掩体目标');
      const saved=this.world.colliders.slice();
      this.world.colliders.push({minX:-2,maxX:2,minZ:-2,maxZ:2,top:2});
      h.pos.set(0,0,8);
      const c=h._findCover(new THREE.Vector3(0,1.4,0),()=>false);
      assert(c&&Number.isFinite(c.x)&&Number.isFinite(c.z),'应找到合法掩体点');
      assert(Math.hypot(c.x,c.z)>2,'掩体点应在掩体外侧');
      this.world.colliders.length=0;
      for(const v of saved)this.world.colliders.push(v);
      this.settings.set('botDifficulty','normal');
      h.takeDamage(9999,'E2E');
    });
    await run('radar-draw',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const cv=document.getElementById('radar');
      this.radar.frame=0;
      this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,false);
      const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>16)n++;
      assert(n>100,'雷达应绘制非空内容');
      this.player.yaw+=Math.PI/2;
      this.radar.frame=0;
      this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,false);
      const d2=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      let n2=0;for(let i=3;i<d2.length;i+=4)if(d2[i]>16)n2++;
      assert(n2>100,'旋转后雷达仍应正常绘制');
      this.radar.frame=0;
      this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,true);
      assert(!document.getElementById('radar').classList.contains('hidden'),'雷达节点应存在');
    });
    await run('wave-20',()=>{
      this.ui.sel.mode='waves';this.startGame();
      for(let i=0;i<20;i++){
        this.waves.timer=0;
        this.waves.update(.016);          // 开波
        this.waves.queue.length=0;
        this.enemies.clearAll();
        this.waves.update(.016);          // 清波
        if(this.state==='upgrade')this._pickUpgrade(0);
      }
      assert(this.waves.n>=20,`应推进 20 波,实际 ${this.waves.n}`);
      assert(this.state==='playing','20 波后应仍处于游玩状态(无软锁)');
    });
    await run('boss-spawn',()=>{
      this.ui.sel.mode='waves';this.startGame();
      assert(this.waves.composition(5).includes('BOSS'),'第 5 波应含 BOSS');
      assert(!this.waves.composition(4).includes('BOSS'),'第 4 波不应含 BOSS');
      this.waves.n=4;this.waves.queue.length=0;this.waves.state='intermission';this.waves.timer=0;
      this.waves.update(.016);
      assert(this.waves.n===5,'应进入第 5 波');
      assert(!!this.waves.modifier,'Boss 波应带词缀');
      assert(['fog','emp','rush'].includes(this.waves.modifier),'词缀应合法');
      const boss=this.enemies.spawn('WARDEN',new THREE.Vector3(0,2,-8),{hpScale:4});
      boss.boss=true;boss.phase=1;
      this.ui.setBoss(.5,t('boss_name'));
      const bar=document.getElementById('bossbar');
      assert(!bar.classList.contains('hidden'),'Boss 血条应显示');
      assert(document.getElementById('boss-fill').style.width==='50%','Boss 血条比例应正确');
      this.ui.hideBoss();
      assert(bar.classList.contains('hidden'),'Boss 血条应可隐藏');
    });
    await run('upgrade-apply',()=>{
      this.ui.sel.mode='waves';this.startGame();
      const cards=rollUpgrades(this,3);
      assert(cards.length===3,'应提供 3 张升级卡');
      assert(new Set(cards.map(c=>c.id)).size===3,'升级卡不应重复');
      this.openUpgrade();
      assert(this.state==='upgrade','应进入升级态');
      assert(!document.getElementById('upgrades').classList.contains('hidden'),'升级面板应显示');
      applyUpgrade(this,'dmg');
      assert(this.upgrades.dmg===1&&this.playerDamageMul()>=1.15,'伤害升级应立即生效');
      this._applyUpgrade('rpm');
      assert(this.weapon.rpmMul>1,'射速升级应立即生效');
      assert(this.state==='playing'&&document.getElementById('upgrades').classList.contains('hidden'),'选择后应恢复游戏');
    });
    await run('upgrade-max',()=>{
      this.upgrades={dmg:3,rpm:3,reload:2,speed:2,hp:3,crit:2,pierce:1,regen:2};
      assert(rollUpgrades(this,3).length===0,'全满级时候选池应为空');
      assert(!applyUpgrade(this,'dmg'),'满级不应继续叠加');
      this.startGame();
    });
    await run('grenade-count',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const g=this.grenades;
      assert(g.counts.frag===2&&g.counts.flash===2&&g.counts.smoke===1,'初始手雷应为 2/2/1');
      assert(g.throw('frag')&&g.counts.frag===1,'破片数量应减少');
      assert(document.getElementById('g-frag').textContent==='1','HUD 数量应同步');
      assert(g.throw('frag')&&!g.throw('frag'),'用尽后不能继续投掷');
      assert(!g.throw('unknown'),'未知类型应被拒绝');
      g.reset();
      assert(g.counts.frag===2,'重开后手雷应补满');
    });
    await run('grenade-aoe',()=>{
      this.ui.sel.mode='waves';this.startGame();this.player.god=true;
      const e=this.enemies.spawn('WASP',new THREE.Vector3(2,1.4,2),{entering:false});
      const hp=e.hp;
      this.grenades._explode({type:'frag',pos:new THREE.Vector3(2,1.4,2)});
      assert(e.hp<hp,'破片 AoE 应伤害范围内敌人');
      const far=this.enemies.spawn('WASP',new THREE.Vector3(40,1.4,40),{entering:false});
      const farHp=far.hp;
      this.grenades._explode({type:'frag',pos:new THREE.Vector3(2,1.4,2)});
      assert(far.hp===farHp,'范围外敌人不应受伤');
    });
    await run('flash-blind',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list.find(x=>x.team==='B');
      this.grenades._explode({type:'flash',pos:h.pos.clone()});
      assert(h.blindT>2,'闪光应致盲范围内敌方 bot');
      this.grenades._explode({type:'smoke',pos:h.pos.clone()});
      assert(this.grenades.inSmoke(h.pos),'烟雾内判定应为真');
      assert(!this.grenades.inSmoke(new THREE.Vector3(99,0,99)),'烟雾外应为假');
    });
    await run('anim-state',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      h.vel.set(0,0,0);h.reloadT=0;h.hitT=0;h.recoilKick=0;h.moving=false;
      assert(h._decideAnim(null)==='idle','静止无目标 → idle');
      h.moving=true;
      assert(h._decideAnim(null)==='walk','移动 → walk');
      h.moving=false;
      assert(h._decideAnim({})==='aim','有目标 → aim');
      h.hitT=.2;
      assert(h._decideAnim(null)==='hit','受击 → hit');
      h.hitT=0;h.recoilKick=.5;
      assert(h._decideAnim(null)==='fire','开火 → fire');
      h.recoilKick=0;h.reloadT=.5;
      assert(h._decideAnim(null)==='reload','换弹 → reload');
      h.ammo=1;h.reloadT=0;h._consumeAmmo();
      assert(h.reloadT>1.1&&h.ammo===h.magSize,'打空弹匣应进入 1.2s 换弹');
      h.reloadT=0;h.recoilKick=0;
      h._animate(.016,1,0);
      assert(Number.isFinite(h.armR.rotation.x)&&Number.isFinite(h.torso.position.y),'动画姿态应有限');
      assert(Math.abs(h.armR.rotation.x-h.baseArmR[0])<.01,'静止持枪姿态应回到基准(无 T-pose)');
    });
    await run('radio-barks',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      h._barkT=0;
      assert(h.bark('bark_spot'),'首个台词应触发');
      assert(!h.bark('bark_spot'),'6s 冷却内不应重复');
      assert(this.ui.barkPool.some(p=>p.t>0),'台词槽应显示');
      h._barkT=0;h.hp=h.maxHp*.2;h._lowBarked=false;
      h.takeDamage(1,'E2E');
      assert(h._lowBarked,'低血量应触发台词');
      assert(!h.bark('bark_spot'),'台词后应进入冷却');
    });
    await run('nametag-hp',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      assert(h.nameTag&&h.nameTag.bar&&h.nameTag.group,'名牌应含血条组件');
      assert(Math.abs(h.nameTag.bar.scale.x-1)<.01,'满血血条应为 1');
      h.takeDamage(h.maxHp*.5,'E2E');
      assert(Math.abs(h.nameTag.bar.scale.x-.5)<.02,'半血血条应为 .5');
      this.camera.position.copy(h.pos);
      h.update(.016,this.time,()=>false);
      assert(h.nameTag.group.visible,'近距离名牌应可见');
      assert(h.nameTag.sprite.material.opacity>.9,'30m 内名牌应全亮');
      this.camera.position.set(999,0,999);
      h.update(.016,this.time,()=>false);
      assert(!h.nameTag.group.visible,'远距离名牌应淡出隐藏');
      h.respawn();
      assert(Math.abs(h.nameTag.bar.scale.x-1)<.01,'重生后血条应恢复');
      this.camera.position.set(0,1.6,8);
    });
    await run('mvp-card',()=>{
      const op=byId('vulture');
      this.ui.showOver({title:'X',win:true,kicker:'X',mvp:null,
        stats:{time:60,waveLabel:'W',wave:'1',kills:10,critKills:2,hits:20,shots:30,score:100,best:0,bestCombo:2,
          mvp:{name:'秃鹫',op,kills:10,deaths:1}}});
      const el=document.getElementById('o-mvp');
      assert(!el.classList.contains('hidden'),'MVP 卡片应显示');
      assert(el.textContent.includes('秃鹫'),'MVP 名字应显示');
      assert(el.querySelector('.mvp-face'),'MVP 应有立绘或首字母兜底');
      this.ui.showOnly(null);
    });
    await run('share-card',()=>{
      const cv=this.ui.buildShareCard({score:12345,wave:9,kills:63,hits:412,shots:648,bestCombo:4,waveLabel:'WAVE'},byId('frost'));
      assert(cv&&cv.width===1200&&cv.height===630,'分享卡应为 1200×630');
      const d=cv.getContext('2d').getImageData(600,315,1,1).data;
      assert(d[3]>0,'分享卡应绘制不透明背景');
      assert(typeof this.ui.downloadShareCard==='function','应提供下载入口');
    });
    await run('killcard',()=>{
      const evil='<img src=x onerror=alert(1)>';
      this.ui.killCard({killer:evil,victim:'霜华',weapon:'AK47',mine:false,
        killerOp:byId('raven'),victimOp:byId('frost')});
      const el=document.getElementById('killcard');
      assert(!el.classList.contains('hidden'),'击杀卡应显示');
      assert(this.ui.killcardT>1.5,'击杀卡应持续 1.6s');
      assert(!el.innerHTML.includes('<img'),'玩家名应转义,无 XSS');
      assert(el.classList.contains('death'),'被击杀应使用死亡配色');
      this.ui.update(1.7,100,100);
      assert(el.classList.contains('hidden'),'1.6s 后应自动隐藏');
    });
    await run('music-bgm',()=>{
      const a=this.audio;
      a.musicStart('menu');a.musicSet(.9);a.musicMode('combat');a.musicStop();
      a.musicStart('combat');a.musicSet(.2);
      this.pause();
      assert(this.state==='paused','暂停应进入 paused 状态');
      this.resume();
      assert(this.state==='playing','恢复应回到 playing');
      this.toMenu();
      assert(this.state==='menu','返回菜单应进入 menu');
      assert(!this.ui.errors.some(e=>e.startsWith('ERR')),'BGM 切换不应产生运行错误');
    });
    await run('death-no-explosion',()=>{
      this.ui.sel.mode='dm';this.startGame();
      let boom=0;
      const orig=this.effects.explosion;
      this.effects.explosion=(...a)=>{boom++;return orig.apply(this.effects,a);};
      const h=this.heroes.list[0];
      h.takeDamage(9999,'E2E');
      assert(!h.alive&&h.state==='dying','角色应进入死亡倒地状态');
      assert(boom===0,'人类单位死亡不应触发爆炸');
      assert(h.parts.rifle.parent===this.scene,'死亡时步枪应脱手掉落');
      h.update(1,this.time,()=>true);
      assert(h.state==='dead','0.7s 后应进入尸体状态');
      h.deathT=5.6;
      h.update(.016,this.time,()=>true);
      assert(h.alive&&h.state==='active','5.5s 后应重生');
      assert(h.parts.rifle.parent===h.group,'重生后步枪应回到手部');
      assert(Math.abs(h.materials[0].opacity-1)<.01,'重生后材质应恢复不透明');
      this.effects.explosion=orig;
    });
    await run('damage-direction',()=>{
      this.player.god=false;this.invulnT=0;this.player.alive=true;
      this.player.health=999;this.player.maxHealth=999;
      this.player.pos.set(0,0,0);this.player.yaw=0;
      const check=(x,z,want)=>{
        this.ui.lastDmgAngle=999;
        this.damagePlayerFromBot(1,'E2E',new THREE.Vector3(x,0,z));
        let d=this.ui.lastDmgAngle-want;
        while(d>Math.PI)d-=Math.PI*2;while(d<-Math.PI)d+=Math.PI*2;
        assert(Math.abs(d)<.2,`方向误差 ${d.toFixed(2)}rad(期望 ${want.toFixed(2)},实际 ${this.ui.lastDmgAngle.toFixed(2)})`);
      };
      check(0,-10,0);            // 正前
      check(0,10,Math.PI);       // 正后
      check(10,0,Math.PI/2);     // 正右
      check(-10,0,-Math.PI/2);   // 正左
      this.player.god=true;this.player.health=this.player.maxHealth;
    });
    await run('combo-callout',()=>{
      this.comboKills=1;this.comboT=4;
      this._onKill({T:{score:100},pos:new THREE.Vector3()},false);
      assert(this.comboKills===2,'4 秒内第二次击杀应累计连杀');
      const el=document.getElementById('combo-callout');
      assert(el.classList.contains('show'),'连杀播报应显示');
      assert(el.textContent.length>0,'连杀播报应有文案');
    });
    await run('settings-persist',()=>{
      this.settings.set('fov',90);
      this.settings.set('crosshair.color','#ff8800');
      const raw=JSON.parse(localStorage.getItem('o07_settings_v2'));
      assert(raw.fov===90,'FOV 应写入存档');
      assert(raw.crosshair.color==='#ff8800','准星颜色应写入存档');
      this.settings.load();
      assert(this.settings.get('fov')===90,'重新载入后 FOV 应保留');
      this.settings.set('fov',106);
      this.settings.set('crosshair.color','#7fe3ff');
    });
    await run('fov-apply',()=>{
      this.baseHFov=90;this._hfovCur=90;this._applyCameraState();
      const want=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(90)*.5)/this.camera.aspect));
      assert(Math.abs(this.camera.fov-want)<.5,`FOV 应生效: ${this.camera.fov.toFixed(2)} vs ${want.toFixed(2)}`);
      this.baseHFov=106;this._hfovCur=106;this._applyCameraState();
    });
    await run('operator-camo-persist',()=>{
      this.ui.selectOperator('viper');
      this.ui.setCamo('desert');
      assert(store.get('o07_operator')==='viper','干员选择应持久化');
      assert(store.get('o07_camo_viper')==='desert','迷彩选择应持久化');
      assert(this.ui.camoOf(byId('viper'))==='desert','camoOf 应返回存档迷彩');
      assert(this.ui.sel.hero==='t','选择 T 干员后阵营应切换');
      assert(this.ui.sel.primary==='ak47','切换阵营后主武器应回落到阵营合法武器');
      this.ui.selectOperator('frost');
      assert(this.ui.sel.hero==='ct','切回 CT 干员阵营应恢复');
      assert(this.ui.sel.camo===this.ui.camoOf(byId('frost')),'迷彩应随干员恢复');
    });
    await run('memory-stable',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const before=this.debugMemory();
      for(let i=0;i<10;i++){this.startGame();this.toMenu();}
      this.startGame();
      const after=this.debugMemory();
      assert(after.geometries<=before.geometries+2,`几何体不应增长: ${before.geometries} → ${after.geometries}`);
      assert(after.heroMats===before.heroMats,`角色材质数量应稳定: ${before.heroMats} → ${after.heroMats}`);
      assert(after.textures<=before.textures+5,`贴图不应持续增长: ${before.textures} → ${after.textures}`);
    });

    const fail=results.length-pass;
    window.__e2e={pass,fail,results};
    console.log(`[E2E] ${pass}/${results.length} PASS`);
    this.ui.debug('E2E '+pass+'/'+results.length+' PASS'+(fail?' | FAIL: '+results.filter(x=>!x.ok).map(x=>x.name).join(', '):''),fail>0);
  }

  async selftest(){
    const log=m=>{console.log('[SELFTEST]',m);};
    await new Promise(r=>setTimeout(r,800));
    try{
      this.ui.sel.mode='waves';
      this.startGame();
      this.fallbackAim=true;
      this.scene.updateMatrixWorld(true); // 无渲染帧时(后台标签页/无头)同步整棵场景树,保证射线判定
      const dir=new THREE.Vector3(0,0,-1);
      // 1. 主武器命中击杀
      const ePos=this.player.eye.clone().addScaledVector(dir,8);
      ePos.y=1.62;
      const e=this.enemies.spawn('WASP',ePos,{entering:false});
      this.scene.updateMatrixWorld(true);
      const hp0=e.hp;
      await new Promise(r=>setTimeout(r,300));
      for(let i=0;i<6;i++){
        this.stats.shots++;
        const to=e.pos.clone().sub(this.camera.position).normalize();
        this.ray.set(this.camera.position,to);this.ray.far=100;
        const hits=this.ray.intersectObjects([e.group],true);
        if(hits.length){
          const part=hits[0].object.userData.part||'body';
          this.enemies.damage(e,part,this.weapon.def.dmg*this.playerDamageMul(),hits[0].point);
          this.stats.hits++;
        }
        await new Promise(r=>setTimeout(r,60));
      }
      const ok=e.dead||e.hp<hp0;
      log(`rifle hp ${hp0} -> ${e.dead?'DEAD':e.hp.toFixed(1)} : ${ok?'PASS':'FAIL'}`);
      this.ui.debug(`SELFTEST rifle ${ok?'PASS':'FAIL'}`);
      // 2. 沙漠之鹰(半自动)
      this.weapon.switchTo(this.weapon.primaryCount);
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{}); // 确定性切枪(不依赖 rAF,后台标签页可复现)
      this.enemies.clearAll(); // 清掉可能挡在射线上的旧无人机
      const e2=this.enemies.spawn('WASP',this.player.eye.clone().addScaledVector(dir,7),{entering:false});
      e2.pos.y=1.62;
      e2.group.position.copy(e2.pos);
      this.scene.updateMatrixWorld(true); // 同步块内立即开火,需手动刷新世界矩阵
      const hp2=e2.hp;
      const to2=e2.pos.clone().sub(this.player.eye);
      this.player.yaw=Math.atan2(-to2.x,-to2.z);this.player.pitch=0;
      this.player.update(0,this.input,this.keys,this.time,this.audio);
      this.fire(0);
      await new Promise(r=>setTimeout(r,200));
      const deagleOk=e2.dead||e2.hp<hp2;
      log(`deagle hp ${hp2} -> ${e2.dead?'DEAD':e2.hp.toFixed(1)} : ${deagleOk?'PASS':'FAIL'}`);
      // 3. 军刀近战
      this.weapon.switchTo(this.weapon.primaryCount+1);
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      this.enemies.clearAll();
      const e3=this.enemies.spawn('WASP',this.player.eye.clone().addScaledVector(dir,1.6),{entering:false});
      e3.pos.y=1.5;
      e3.group.position.copy(e3.pos);
      this.scene.updateMatrixWorld(true);
      const hp3=e3.hp;
      const to3=e3.pos.clone().sub(this.player.eye);
      this.player.yaw=Math.atan2(-to3.x,-to3.z);this.player.pitch=-.06;
      this.player.update(0,this.input,this.keys,this.time,this.audio);
      this.fire(0,{melee:true,heavy:false});
      await new Promise(r=>setTimeout(r,200));
      const knifeOk=e3.dead||e3.hp<hp3;
      log(`knife hp ${hp3} -> ${e3.dead?'DEAD':e3.hp.toFixed(1)} : ${knifeOk?'PASS':'FAIL'}`);
      this.ui.debug(`SELFTEST rifle ${ok?'PASS':'FAIL'} / deagle ${deagleOk?'PASS':'FAIL'} / knife ${knifeOk?'PASS':'FAIL'}`);
    }catch(err){
      log('FAIL '+err.message);
      this.ui.debug('SELFTEST FAIL '+err.message,true);
    }
  }
}

new Game();
