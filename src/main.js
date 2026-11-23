// main.js — boot / state machine / hit detection (characters + explosions) / deathmatch / main loop / verification hooks
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
import {attachmentIslands} from './attach.js';
import {Enemies} from './enemies.js';
import {Waves} from './waves.js';
import {HeroTeam} from './heroes.js';
import {UI} from './ui.js';
import {SaveSystem} from './save.js';
import {Leaderboard} from './leaderboard.js';
import {GameMode,KothMode} from './modes.js';
import {PortraitRenderer} from './portraits.js';
import {preloadCharacters,modelAssets} from './modelAssets.js';
import {settings} from './settings.js';
import {InputManager,KeyboardMouseAdapter} from './input.js';
import {TouchAdapter} from './input-touch.js';
import {GamepadAdapter,PAD_MAP} from './input-gamepad.js';
import {Grenades} from './grenades.js';
import {Pickups} from './pickups.js';
import {applyUpgrade,rollUpgrades} from './upgrades.js';
import {Radar} from './radar.js';
import {OPERATORS,byId,byFaction,DEFAULT_OP,CAMOS} from './operators.js';
import {store,num,escHTML} from './util.js';

const $=id=>document.getElementById(id);
const UP=new THREE.Vector3(0,1,0);
const FOV_H=106; // hip-fire horizontal FOV (degrees): horizontal FOV is locked so it does not shrink with aspect ratio (≈72.7° vertical at 16:9)
const TUTORIAL=[
  {zh:'WASD 移动,鼠标瞄准',en:'Move with WASD, aim with the mouse'},
  {zh:'按住右键开镜(ADS),精度更高',en:'Hold right mouse to aim down sights'},
  {zh:'按 R 换弹,避免空仓',en:'Press R to reload before running dry'},
  {zh:'按 1 循环主武器,2 手枪,3 冲锋枪',en:'Press 1 to cycle primaries, 2 sidearm, 3 SMG'},
  {zh:'按 G / F / V 投掷破片 / 闪光 / 烟雾',en:'Press G / F / V for frag / flash / smoke'},
];
const VERSION='1.10.0';
const _rsO=new THREE.Vector3(); // reused ray-sphere test vector (zero allocation on the hot path)

class Game{
  constructor(){
    this.shotMode=new URLSearchParams(location.search).get('shot');
    this.selftestMode=new URLSearchParams(location.search).has('selftest');
    this.e2eMode=new URLSearchParams(location.search).has('e2e');
    this.perfMode=new URLSearchParams(location.search).has('perf');
    this.rosterMode=new URLSearchParams(location.search).has('roster');
    this.portraitsMode=new URLSearchParams(location.search).has('portraits');
    this.bossMode=new URLSearchParams(location.search).get('boss')==='1';
    this.mapOverride=new URLSearchParams(location.search).get('map'); // ?map= test hook (validated against MAPS before use)
    this.padMode=new URLSearchParams(location.search).has('pad');
    this.touchMode=new URLSearchParams(location.search).has('touch')||
      (typeof matchMedia==='function'&&matchMedia('(pointer:coarse)').matches);
    if(this.shotMode||this.selftestMode||this.e2eMode||this.rosterMode||this.portraitsMode||this.padMode)window.__game=this; // debug probe: exposed only under test hooks
    this.perf={frames:0,slow:0,maxDt:0}; // hitch monitor: slow frame (>25ms) count
    this.dynScale=1;this._perfAt=0;
    this.state='menu'; // menu | playing | paused | dying | over
    this.keys=new Set();
    this.input={firing:false,ads:false};
    this.fallbackAim=false;
    this._suppressPauseOnce=false; // set before game-initiated unlocks (DM death) so the lock-loss auto-pause is skipped
    this._lastCursor=null;         // deduped per-frame canvas cursor state
    // S1.4 settings hub: unified reads + legacy key migration
    this.settings=settings;
    this.save=new SaveSystem();
    this.leaderboard=new Leaderboard(settings);
    this.settings.load();
    this.baseHFov=this.settings.get('fov');
    this.sensMul=this.settings.get('sens');
    this.volume=this.settings.get('volume');
    this.quality=this.touchMode?'low':this.settings.get('quality');
    this.score=0;this.shake=0;this.dyingT=0;this.time=0;
    this.stats={shots:0,hits:0,kills:0,critKills:0,headshots:0,time:0,bestCombo:0};
    this.comboKills=0;this.comboT=0;
    this.playerName='Guard-07';
    this.playerTeam='A';
    this.invulnT=0;this.dmRespawnT=-1;
    this.spectate={target:null,t:0};this.lastKiller=null;
    this._specWant=new THREE.Vector3();this._specFrom=new THREE.Vector3();this._specDir=new THREE.Vector3();
    this._boot();
  }

  /* ================= Boot ================= */
  _boot(){
    applyStatic(); // swap in static copy right after first-frame language detection (script blocks parsing, so no flash)
    this.ui=new UI();
    this.ui._save=this.save;
    window.addEventListener('error',e=>{
      const st=(e.error&&e.error.stack||'').split('\n').slice(0,4).join('\n');
      this.ui.debug('ERR '+e.message+'\n'+st,true);
    });
    window.addEventListener('unhandledrejection',e=>this.ui.debug('ERR '+e.reason,true));

    const test=document.createElement('canvas');
    if(!test.getContext('webgl2')){
      $('app').insertAdjacentHTML('beforeend',`<div id="nogl">${t('no_webgl')}</div>`);return;
    }

    this.renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});
    this.renderer.shadowMap.enabled=true;
    this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    // Shadows update every other frame: recomputing all casters every second frame saves almost half the shadow passes (dynamic units lag 1 frame, imperceptible)
    this.renderer.shadowMap.autoUpdate=false;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=1.18;
    // WebGL context loss: show a visible notice after a driver crash / GPU switch / sleep, reload automatically once restored
    this.renderer.domElement.addEventListener('webglcontextlost',e=>{
      e.preventDefault();
      this.renderer.setAnimationLoop(null);
      this.ui.debug('ERR WebGL context lost · the page will recover automatically…',true);
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
    // Viewmodel environment reflections (RoomEnvironment IBL): metal parts get real highlights instead of a flat rough look
    try{
      const pmrem=new THREE.PMREMGenerator(this.renderer);
      this.viewScene.environment=pmrem.fromScene(new RoomEnvironment(),.04).texture;
      this.viewScene.environmentIntensity=.55; // keep reflections in check so skin / gloves do not blow out
      pmrem.dispose();
    }catch(e){}

    this.assets=initAssets();
    this.portraits=new PortraitRenderer(this.assets);
    this.ui.portraits=this.portraits; // C4: menu operator card portraits
    // GLB characters load in the background (?model=proc|gltf overrides); when they arrive the
    // portrait cache is stale — clear it and rebuild the roster so cards switch to the new look.
    // The character data sits in inert <script> tags AFTER this bundle, so decoding starts once
    // the document is parsed. The menu is fully interactive in the meantime and the procedural
    // builders cover the gap until the models are ready.
    modelAssets.onReady(()=>{this.portraits.cache.clear();this.ui.buildOperators();});
    if(typeof document!=='undefined'&&document.readyState==='loading')
      document.addEventListener('DOMContentLoaded',preloadCharacters,{once:true});
    else preloadCharacters();
    this.audio=new AudioFX();
    if(this.mapOverride&&MAPS[this.mapOverride])this.ui.sel.map=this.mapOverride; // per-map screenshot / verification hook
    this.buildWorldFor(this.ui.sel.map);

    this.effects=new Effects(this.scene,this.assets,this.quality,this.camera);
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
    this.koth=new KothMode(this);
    this.ray=new THREE.Raycaster();
    this.losRay=new THREE.Raycaster();
    // Reusable vector pool for shooting: avoids a new Vector3 per bullet and the resulting GC jitter
    this._sd=new THREE.Vector3();this._sr=new THREE.Vector3();this._su=new THREE.Vector3();
    this._send=new THREE.Vector3();this._muzzle=new THREE.Vector3();this._losV=new THREE.Vector3();this._pierceO=new THREE.Vector3();this._smokeM=new THREE.Vector3();
    this._shotGroups=[];

    this._setupComposer();
    this._setupInput();

    // Menu bindings
    this.ui.bindMenu(()=>{ // map / mode change → rebuild the world preview
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
    const lb=$('p-leaderboard');
    if(lb){
      lb.checked=this.leaderboard.optIn();
      lb.addEventListener('change',()=>{
        this.leaderboard.setEnabled(lb.checked);
        if(lb.checked)this.leaderboard.submit(this.playerName,this.bestScore||0);
      });
    }
    // U1: settings panel bindings (sensitivity / FOV / volume / sfx / music / crosshair / invert / crouch toggle / ADS toggle)
    this.ui.bindSettings(this.settings,(path)=>{
      if(path==='fov'||path==='reset')this.baseHFov=this.settings.get('fov');
      if(path==='sens'||path==='reset')this.sensMul=this.settings.get('sens');
      if(path==='volume'||path==='reset')this.volume=this.settings.get('volume');
      if(path==='volume'||path==='sfx'||path==='music'||path==='reset')this._applyAudioSettings();
      if(path==='uiScale'||path==='colorblind'||path==='reduceMotion'||path==='reset')this.ui.applyAccessibility();
    });

    this.bestScore=parseInt(store.get('o07_best','0'))||0;
    this.ui.showBest(this.bestScore);
    this.ui.showOnly('menu');
    this._menuDrones();

    // Precompile shaders
    try{
      this.weapon.group.visible=true;
      this.renderer.compile(this.scene,this.camera);
      this.renderer.compile(this.viewScene,this.viewCam);
      this.weapon.group.visible=false;
    }catch(e){}

    // C1/C5 debug hook: ?op=raven&camo=snow picks operator and camo
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
    else if(this.shotMode==='mvp')this._shotMvp();
    else if(this.shotMode==='tutorial')this._shotTutorial();
    else if(this.shotMode==='spectate')this._shotSpectate();
    if(this.selftestMode)this.selftest();
    if(this.e2eMode)this.e2e();
    if(this.rosterMode)this._debugRoster();
    if(this.portraitsMode)this._debugPortraits();
    if(this.bossMode){
      this.ui.sel.mode='waves';this.startGame();
      this.waves.n=4;this.waves.queue.length=0;
      this.waves.state='intermission';this.waves.timer=.2;
    }
    if(this.padMode){
      console.table(PAD_MAP.axes);
      console.table(PAD_MAP.buttons);
      console.log('[PAD] left stick move · right stick look · RT fire · LT aim · A/B/X/Y actions');
    }
    // Async IP probe: non-China IP → English UI (result cached for the next first frame); ?ipcc= forces it (test hook)
    const forcedIPCC=new URLSearchParams(location.search).get('ipcc');
    (forcedIPCC?Promise.resolve(forcedIPCC):detectIPCountry()).then(cc=>{
      if(!cc)return;
      store.set('o07_ipcc',cc);
      const want=cc==='CN'?'zh':'en';
      if(lang.cur!==want){ setLang(want); this._refreshLang(); }
    }).catch(()=>{});

    const ver=$('m-ver');
    if(ver)ver.textContent=`v${VERSION}`;
    console.log(`%cGUN TO GUN v${VERSION}`,'color:#f0a860;font-weight:bold','· single file, playable offline');
    // Dev capture hook (?shot=/* and ?portraits pages): expose the game instance so browser
    // automation can grab frames (captureFrame) and dump the rig bone map
    if(this.shotMode||this.portraitsMode){
      window.__GTG_DEBUG__=this;
      window.__modelAssets=modelAssets;
      window.__GTG_OPS__=OPERATORS; // roster lineup captures (portraits.renderSheet)
    }

    this.clock=new THREE.Clock();
    // Main loop circuit breaker: an exception in one frame no longer silently kills the rAF chain; show the error and halt
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
    // PWA offline support: cached on first visit after deployment, can be reopened offline from cache (file:// needs no SW)
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
    this._refreshEnvironment();
  }

  /* Per-map environment reflections: bake the live sky shader into a PMREM once per map switch.
     Characters / metals then reflect real scene colours (sunset orange, aurora green, dock neon)
     instead of a flat studio grey. Cheap: a single cube render at build time, disposed on rebuild. */
  _refreshEnvironment(){
    try{
      const sky=this.world.sky;
      if(!sky)return;
      const pmrem=new THREE.PMREMGenerator(this.renderer);
      const tmp=new THREE.Scene();
      tmp.add(new THREE.Mesh(sky.geometry,sky.material));
      const rt=pmrem.fromScene(tmp,.04,.1,600); // far must clear the 480 m sky sphere
      pmrem.dispose();
      if(this._envRT)this._envRT.dispose();
      this._envRT=rt;
      this.scene.environment=rt.texture;
      this.scene.environmentIntensity=this.world.map.ibl??.5;
    }catch(e){}
  }

  /* Refresh dynamic copy after a language switch (static parts are covered by applyStatic) */
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
    const base=Math.min(devicePixelRatio||1,this.quality==='high'?2:1);
    const pr=base*(this.dynScale||1);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    this.bloom.strength=this.quality==='high'?.42:.26;
  }

  _resize(){
    this.camera.aspect=innerWidth/innerHeight;
    // FOV is defined horizontally: fix the horizontal angle first, then derive the vertical FOV for the current aspect
    this.camera.fov=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(this._hfovCur||this.baseHFov||FOV_H)*.5)/this.camera.aspect));
    this.camera.updateProjectionMatrix();
    this.viewCam.aspect=innerWidth/innerHeight;this.viewCam.updateProjectionMatrix();
    this.renderer.setSize(innerWidth,innerHeight);
    this.composer.setSize(innerWidth,innerHeight);
  }

  /* ================= Input ================= */
  /* S1.5: input abstraction; mouse/keyboard listeners live in KeyboardMouseAdapter, M4 layers touch / gamepad on top */
  _setupInput(){
    this.inputMgr=new InputManager(this);
    this.inputMgr.attach(new KeyboardMouseAdapter(this));
    this.inputMgr.attach(new GamepadAdapter(this));
    // M4-P1: touch devices (or ?touch=1) mount the virtual stick / look area / action buttons
    if(this.touchMode)this.inputMgr.attach(new TouchAdapter(this));
  }

  /* Single entry point for look input (shared by mouse / touch / gamepad) */
  applyLook(dx,dy){
    if(!this.player)return;
    const base=this.baseHFov||FOV_H;
    const zoom=Math.max(.28,(this._hfovCur||base)/base);
    const sens=this.settings?this.settings.get('sens'):this.sensMul;
    const adsSens=this.settings?this.settings.get('adsSens'):1;
    const inv=this.settings&&this.settings.get('yInvert')?-1:1;
    const s=.0021*sens*adsSens*zoom;
    this.player.yaw-=dx*s;
    // Normalise the yaw angle so float error does not accumulate over long sessions
    if(this.player.yaw>Math.PI)this.player.yaw-=Math.PI*2;
    else if(this.player.yaw<-Math.PI)this.player.yaw+=Math.PI*2;
    this.player.pitch-=dy*s*inv;
    // Industry standard for FPS games: clamp pitch to ±89°; past the zenith the view flips and turning reverses
    this.player.pitch=Math.max(-1.553,Math.min(1.553,this.player.pitch));
  }

  /* S1.6: per-bus audio volume (call after init) */
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
        // Industry standard: prefer raw input (unadjustedMovement) to drop OS mouse acceleration so rotation matches the hardware
        let p=null;
        try{p=this.renderer.domElement.requestPointerLock({unadjustedMovement:true});}
        catch(err){p=this.renderer.domElement.requestPointerLock();}
        if(p&&p.catch)p.catch(()=>{
          // Fall back to a normal lock without raw input support; silently handle missing-gesture / rejected cases without polluting the debug bar
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

  /* Look fallback without pointer lock: keep rotating proportionally while the cursor hugs the left/right edge (industry-standard fallback),
     fixing "the cursor hits the edge and I cannot turn to aim at targets outside the view" in relative-movement mode */
  _fallbackEdgeRotate(dt){
    if(!this.fallbackAim||this.state!=='playing'||!this.player.alive)return;
    const m=70,speed=2.8; // edge band in px / max angular speed in rad/s
    const cx=this._mx==null?innerWidth/2:this._mx;
    let rate=0;
    if(cx<m)rate=-speed*(1-cx/m);
    else if(cx>innerWidth-m)rate=speed*(1-(innerWidth-cx)/m);
    if(rate)this.player.yaw-=rate*dt;
  }

  /* Cursor lifecycle: hide the OS pointer whenever aiming is active (pointer lock hides it natively; this CSS
     toggle covers the fallback-aim path so the cursor never lingers over the crosshair mid-match), restore it
     for every state where a mouse click is needed (menu / pause / upgrade / tutorial / game-over / lock hint) */
  _updateCursor(){
    if(this.touchMode)return;
    const hide=(this.state==='playing'||this.state==='dying')&&!!(document.pointerLockElement||this.fallbackAim);
    const cur=hide?'none':'';
    if(this._lastCursor!==cur){this._lastCursor=cur;this.renderer.domElement.style.cursor=cur;}
  }

  /* C5: camo source (player uses the current selection, bots use their own saved/unlocked camo) */
  camoFor(op){
    if(this.ui&&this.ui.sel&&op.id===this.ui.sel.operator&&this.ui.sel.camo)return this.ui.sel.camo;
    return this.ui&&this.ui.camoOf?this.ui.camoOf(op):'default';
  }

  /* ================= State switching ================= */
  startGame(){
    const sel=this.ui.sel;
    this.mode=sel.mode;
    this.playerName=this.ui.playerName;
    if(sel.map!==this.world.mapKey)this.buildWorldFor(sel.map);
    // C5: player operator = roster selection; stats / weapons / first-person arms all follow the operator definition
    const op=byId(sel.operator)||byId(DEFAULT_OP);
    const hero=op.faction;
    this.playerOperator=op;
    this.ui.shareOp=op;
    this.playerFaction=hero;
    this.playerCamo=sel.camo||this.camoFor(op);
    this.player.god=false;this.invulnT=0;this.dmRespawnT=-1;
    this.spectate.target=null;this.lastKiller=null;
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
    // Base move speed × operator × weapon weight
    this.baseSpeed=5.2*op.speedMul;
    this.baseSprint=7.8*op.speedMul;
    this.weapon.speedCb=mul=>{
      this.player.speed=this.baseSpeed*mul;
      this.player.sprintSpeed=this.baseSprint*mul;
    };
    this.weapon.setFaction(op);
    // Primaries: all 4 faction primaries carried, the menu choice is drawn first (slots: 1 cycle / 2 Desert Eagle / 3 UMP-45)
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
    this.stats={shots:0,hits:0,kills:0,critKills:0,headshots:0,time:0,bestCombo:0};
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
    }else if(this.mode==='koth'){
      this.ui.setDmMode(true);
      this.waves.state='idle';
      this.dm={scores:new Map(),timer:300,winKills:999};
      this.dm.scores.set(this.playerName,{name:this.playerName,team:'A',kills:0,deaths:0,me:true,op:this.playerOperator});
      this.heroes.setup(this.playerFaction,this.playerName,op.id);
      for(const h of this.heroes.list)
        this.dm.scores.set(h.name,{name:h.name,team:h.team,kills:0,deaths:0,me:false,op:h.def});
      this.koth.start();
      this.ui.banner(t('mode_koth'),t('koth_name'));
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
    // M3-G7: show onboarding on first entry
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
    this.audio.setAmbient(this.world.mapKey);
  }

  pause(){
    if(this.state!=='playing')return;
    this.state='paused';
    this.input.firing=false;this.input.ads=false;
    this._mouseFire=false;this._mouseAds=false; // a mouse-up lost during pause must not leave fire stuck on after resuming
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
    this.koth.end();
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

  /* ================= Shooting ================= */
  _raySphere(origin,dir,c,r){
    const oc=_rsO.copy(origin).sub(c);
    const b=oc.dot(dir);
    const cc=oc.dot(oc)-r*r;
    const disc=b*b-cc;
    if(disc<0)return null;
    const t=-b-Math.sqrt(disc);
    return t>0?t:null;
  }

  fire(spread){
    this.stats.shots++;
    const cam=this.camera;
    const def=this.weapon.def;
    // Industry standard: the shot uses the authoritative yaw/pitch at the moment of firing, not last frame's render camera (fast flicks neither lag nor drift)
    const pl=this.player;
    const sy=Math.sin(pl.yaw),cy=Math.cos(pl.yaw),sp=Math.sin(pl.pitch),cp=Math.cos(pl.pitch);
    const dir=this._sd.set(-sy*cp,sp,-cy*cp);

    const right=this._sr.set(cy,0,-sy);
    const up=this._su.set(sp*sy,cp,sp*cy);
    const a=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*spread;
    dir.addScaledVector(right,Math.cos(a)*r).addScaledVector(up,Math.sin(a)*r).normalize();

    // 1. Statics
    this.ray.set(cam.position,dir);this.ray.far=400;
    const sHits=this.ray.intersectObjects(this.world.shootStatics,false);
    let bestT=sHits.length?sHits[0].distance:400;
    let bestStatic=sHits.length?sHits[0]:null;
    // 2. Drones (waves)
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
    // 3. Characters (deathmatch, sphere approximation)
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
    // Scoped: a full-size smoke puff at the hidden gun's muzzle point (half a metre from
    // the camera, on the scope axis) would cover the entire lens — spawn a smaller, fainter
    // puff metres down the aim ray instead
    const scoped=this.weapon.def.scope&&this.weapon.adsAmt>.5;
    this.effects.muzzleSmoke(scoped
      ?this._smokeM.copy(cam.position).addScaledVector(dir,5)
      :muzzle,{far:scoped});

    if(bestHero){
      this.stats.hits++;
      const head=bestHeroPart==='head';
      const dmg=def.dmg*(head?this.playerCritMul():1)*this.playerDamageMul();
      bestHero.takeDamage(dmg,this.playerName,head);
      this.audio.hit(head);
      this.ui.hitmark(head);
      this.effects.impact(end,UP,'metal',{decal:false});
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
    // M3-G3: armor-piercing rounds — 60% damage to the second target along the ray
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

    // Explosive-round AoE
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
    if(crit){this.stats.critKills++;this.stats.headshots++;} // daily headshot goal: drone core crits count too (waves has no human heads)
    this.comboT=4;this.comboKills++;
    if(this.comboKills>=2)this.ui.combo(this.comboKills);
    const comboMul=[1,1.25,1.5,2,2.5][Math.min(4,this.comboKills-1)];
    this.stats.bestCombo=Math.max(this.stats.bestCombo,comboMul);
    const pts=Math.round(e.T.score*(crit?1.5:1)*comboMul);
    this.addScore(pts,e.pos.clone().add(new THREE.Vector3(0,.4,0)),crit);
    this.audio.kill();
    // M3-G2: 15% chance to drop a supply pickup
    if(!e.decor&&Math.random()<.15){
      const type=['ammo','med','boost'][Math.floor(Math.random()*3)];
      this.pickups.spawn(e.pos,type);
    }
    // M3-G3: field medic
    if(this.upgrades&&this.upgrades.regen)this.player.heal(5*this.upgrades.regen);
  }

  /* M3-G3: pick-one-of-three upgrade every 3 waves */
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

  /* M3-G3: crit multiplier (base 2x + upgrades) */
  playerCritMul(){return 2+.25*(this.upgrades&&this.upgrades.crit||0);}

  /* M3-G2/G3: player damage multiplier (boost pickup + wave upgrades) */
  playerDamageMul(){
    const boost=this.damageBoostT>0?(this.damageBoostMul||1):1;
    const up=this.upgrades?(1+.15*(this.upgrades.dmg||0)):1;
    return boost*up;
  }

  /* ================= Deathmatch hits ================= */
  onHeroKill(killerName,victimHero,headshot=false){
    if(!this.dm||(this.mode!=='dm'&&this.mode!=='koth'))return;
    const k=this.dm.scores.get(killerName);
    if(k)k.kills++;
    const v=this.dm.scores.get(victimHero.name);
    if(v)v.deaths++;
    const mine=killerName===this.playerName;
    this.ui.killFeed(killerName,victimHero.name,t('kill_verb'),mine);
    if(mine){
      this.stats.kills++;
      if(headshot)this.stats.headshots++;
      this.addScore(200,victimHero.pos.clone().add(new THREE.Vector3(0,1.4,0)));
      this.audio.kill();
    }
    this._checkDmWin();
  }
  botDamageFx(hero,pos){
    this.effects.impact(pos,UP,'metal',{decal:false});
  }
  damagePlayerFromBot(dmg,fromName,fromPos){
    if(this.player.god||this.invulnT>0||!this.player.alive)return;
    this.player.damage(dmg,this.time);
    this.ui.damageFlash(.55);
    this.shake=Math.max(this.shake,.1);
    this.audio.hurt();
    this._showDamageDirection(fromPos);
    if(fromName){
      const killer=this.heroes.list.find(h=>h.name===fromName);
      if(killer)this.lastKiller=killer;
    }
    if(this.player.health<=0){
      if((this.mode==='dm'||this.mode==='koth')&&fromName){
        const killer=this.heroes.list.find(h=>h.name===fromName);
        if(killer&&killer.alive)this.spectate={target:killer,t:2.5};
      }
    }
  }
  /* U2: world position → screen direction (0 straight ahead, positive clockwise), fades out over 0.8 s */
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
    const ct=t('faction_ct'),tt=t('faction_t');
    return this.playerFaction==='ct'?{A:ct,B:tt}:{A:tt,B:ct};
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
    const award=this._awardProgress(); // award before the results screen so LV/XP is current
    this.ui.showOver({
      title:win?t('win'):t('lose'),
      win,kicker:t('dm_over_kicker'),
      stats:{...this.stats,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:Math.floor(this.stats.time/60),s:Math.floor(this.stats.time%60)}),score:this.score,best:Math.max(best,this.score),mvp},
      board:`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>${rows}</table>`,
    });
    if(document.pointerLockElement)document.exitPointerLock();
    this._announceProgress(award);
  }

  /* M4-P5: award XP / progression at the end of a match */
  _awardProgress(){
    const op=this.playerOperator||byId(DEFAULT_OP);
    const r=this.save.award({
      kills:this.stats.kills,wave:this.mode==='waves'?this.waves.n:0,
      headshots:this.stats.headshots||0,
      score:this.score,time:this.stats.time,opId:op.id,
    });
    this.ui.showBest(this.save.data.stats.bestScore);
    return r;
  }
  /* Shown after the results screen so it is not covered by the overlay */
  _announceProgress(r){
    if(!r)return;
    if(r.leveled)this.ui.banner(`${t('level_up')} LV.${r.level}`,'');
    else if(this.save.data.daily.done)this.ui.banner(t('daily_ready'),'');
  }

  /* M4-P4: generic mode result (KOTH timeout / capture complete) */
  _endMode(win){
    if(this.state==='over')return;
    this.state='over';
    this.koth.end();
    const lab=this._factionLabels();
    const rows=[...this.dm.scores.values()].sort((x,y)=>y.kills-x.kills)
      .map(r=>`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td><td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?lab.A:lab.B}</span></td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
    const mvpRow=[...this.dm.scores.values()].sort((a,b)=>b.kills-a.kills)[0];
    const mvp=mvpRow?{name:mvpRow.name,op:mvpRow.op||this.playerOperator,kills:mvpRow.kills,deaths:mvpRow.deaths}:null;
    const best=parseInt(store.get('o07_best','0'))||0;
    if(this.score>best)store.set('o07_best',this.score);
    this.audio.gameOver();
    const award=this._awardProgress(); // award before the results screen so LV/XP is current
    this.ui.showOver({
      title:win?t('win'):t('lose'),win,kicker:t('mode_koth'),
      stats:{...this.stats,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:Math.floor(this.stats.time/60),s:Math.floor(this.stats.time%60)}),
        score:this.score,best:Math.max(best,this.score),mvp},
      board:`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>${rows}</table>`,
    });
    if(document.pointerLockElement)document.exitPointerLock();
    this._announceProgress(award);
    if(this.leaderboard.enabled&&this.leaderboard.endpoint)
      this.leaderboard.submit(this.playerName,this.score);
  }

  /* ================= Main loop ================= */
  tick(){
    const dtRaw=Math.min(.05,this.clock.getDelta());
    let dt=dtRaw;
    // Hitch monitor: slow frame (>25ms) count and longest frame time
    this.perf.frames++;
    if(dtRaw>.025)this.perf.slow++;
    if(dtRaw>this.perf.maxDt)this.perf.maxDt=dtRaw;
    if(this.perfMode&&this.perf.frames%180===0)
      console.log(`[PERF] frames=${this.perf.frames} slow=${this.perf.slow} max=${(this.perf.maxDt*1000).toFixed(1)}ms calls=${this.renderer.info.render.calls} tris=${this.renderer.info.render.triangles}`);
    // M4-P6: dynamic resolution (every 60 frames)
    if(this.perf.frames-this._perfAt>=60){
      const ratio=this.perf.slow/Math.max(1,this.perf.frames-this._perfAt);
      let next=this.dynScale;
      if(ratio>.2)next=Math.max(.7,this.dynScale-.1);
      else if(ratio<.05)next=Math.min(1,this.dynScale+.05);
      if(next!==this.dynScale){this.dynScale=next;this._applyQuality();}
      this.perf.slow=0;this._perfAt=this.perf.frames;
    }
    this.inputMgr&&this.inputMgr.update(dtRaw);
    if(this.state==='dying'){
      dt*=.3;
      this.dyingT-=dtRaw;
      if(this.dyingT<=0){
        this.state='over';
        const best=parseInt(store.get('o07_best','0'))||0;
        if(this.score>best)store.set('o07_best',this.score);
        const award=this._awardProgress(); // waves death is a match end: persist XP / stats / daily
        this.ui.showOver({
          title:t('fail_title'),win:false,kicker:t('kicker_lost'),
          stats:{...this.stats,wave:this.waves.n,score:this.score,best:Math.max(best,this.score)},
        });
        this._announceProgress(award);
      }
    }
    const active=this.state==='playing'||this.state==='dying';
    this.time+=dt;
    this.weapon.group.visible=active||this.state==='paused';
    if(this.state!=='playing')this.ui.setScope(false); // force the scope off outside combat
    this._updateCursor(); // hide the OS pointer during aim, show it whenever a click is needed

    if(active){
      this.stats.time+=dt;
      // Deathmatch respawn
      if((this.mode==='dm'||this.mode==='koth')&&this.dmRespawnT>0){
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
          this._suppressPauseOnce=false; // the death unlock was consumed; normal lock-loss behaviour resumes
          this._requestLock();           // re-acquire aim control without waiting for the player to click
        }
      }
      if(this.invulnT>0){
        this.invulnT-=dt;
        if(this.invulnT<=0)this.player.god=false;
      }

      this._fallbackEdgeRotate(dt);
      this.player.update(dt,this.input,this.keys,this.time,this.audio);
      this.weapon.update(dt,this.input,this.player,this.camera,this.time,d=>this.fire(d));

      if(this.mode==='dm'||this.mode==='koth'){
        this.heroes.update(dt,this.time,(a,b)=>this._los(a,b));
        if(this.mode==='koth')this.koth.update(dt);
        if(this.dm&&this.state==='playing'){
          this.dm.timer-=dt;
          if(this.dm.timer<=0){
            let a=0,b=0;
            for(const s of this.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
            if(this.mode==='dm')this._endDm(a,b);
            else{
              const win=this.koth.score.A>=this.koth.score.B;
              this._endMode(win);
            }
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

      // Recoil + screen shake
      let kick=this.weapon.camKick;
      // Near the zenith recoil stops lifting the view (otherwise it crosses 90° into the flip zone and spray control breaks);
      // while pinned at the top, stored recoil drains quickly, halving the "pull-down dead zone"
      const headroom=1.553-this.player.pitch;
      if(kick>headroom){
        kick=Math.max(0,headroom);
        this.weapon.camKick*=Math.max(0,1-16*dt);
      }else if(kick<(-1.553-this.player.pitch)){
        kick=-1.553-this.player.pitch;
        this.weapon.camKick*=Math.max(0,1-16*dt);
      }
      this.camera.rotation.x+=kick;
      this.camera.rotation.y+=this.weapon.camKickYaw; // recoil pattern horizontal drift
      const shake=this.settings.get('reduceMotion')?0:this.shake;
      this.camera.rotation.y+=(Math.random()-.5)*shake*.06;
      this.camera.rotation.z=(Math.random()-.5)*shake*.05;
      // Final camera pitch clamp: recoil / flicks must never cross the zenith
      this.camera.rotation.x=Math.max(-1.553,Math.min(1.553,this.camera.rotation.x));
      this.shake=Math.max(0,this.shake-dt*.5);

      // HUD
      this.ui.setHealth(this.player.health,this.player.maxHealth);
      this.ui.crosshair(this.weapon.spreadRad(this.player),
        this.camera.fov,innerHeight,this.weapon.adsAmt);
      this.ui.hint(this.weapon.ammo<=8&&!this.weapon.reloading&&this.weapon.st.reserve>0?t('hint_reload'):
        (!document.pointerLockElement&&!this.fallbackAim?t('hint_lock'):''));
      if(this.player.alive===false&&this.state==='playing'){
        if(this.mode==='dm'||this.mode==='koth'){
          this.dmRespawnT=2.5;
          if(this.lastKiller&&this.lastKiller.alive)this.spectate={target:this.lastKiller,t:2.5};
          this.ui.deathFlash();
          this.audio.hurt();
          this._suppressPauseOnce=true; // this unlock is the game's own (spectate window) — it must not auto-pause
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
      // Camera / scope state (can be called deterministically by e2e)
      this._applyCameraState();
      // M4-P3: after death, spectate the killer for 2.5 s (raycast keeps the camera out of walls)
      if(this.spectate.target){
        const s=this.spectate,t=s.target;
        if(t&&t.alive&&this.mode==='dm'){
          const want=this._specWant.set(t.pos.x,t.pos.y+2.2,t.pos.z-3.5);
          const from=this._specFrom.set(t.pos.x,t.pos.y+1.2,t.pos.z);
          const dir=this._specDir.copy(want).sub(from);
          const len=dir.length();
          if(len>.01){
            dir.divideScalar(len);
            this.losRay.set(from,dir);this.losRay.far=len;
            const hits=this.losRay.intersectObjects(this.world.shootStatics,false);
            if(hits.length)want.copy(from).addScaledVector(dir,Math.max(.4,hits[0].distance-.3));
          }
          this.camera.position.copy(want);
          this.camera.lookAt(from);
          s.t-=dtRaw;
          if(s.t<=0)s.target=null;
        }else s.target=null;
      }
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
    // M3-G5: radar (setting toggle + EMP jamming)
    if(this._syncRadar())this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,this.empT>0);
    this.ui.update(dt,this.player.health,this.player.maxHealth);
    // M2-A6: low-health BGM tension (written only when the state flips, not scheduled every frame)
    if(this.state==='playing'){
      const low=this.player.health/this.player.maxHealth<.35;
      if(low!==this._musicLow){this._musicLow=low;this.audio.musicSet(low?.9:.7);}
    }
    this.audio.setAmbient(this.state==='menu'?'menu':this.world.mapKey);

    // Shadows every other frame (autoUpdate is off): odd frames recompute casters, even frames reuse last frame's depth
    this._frame=(this._frame||0)+1;
    this.renderer.shadowMap.needsUpdate=(this._frame&1)===1;

    this.composer.render();
  }

  /* Camera / scope state sync (AUG / Longbow / SG 553 scopes: high zoom + scope overlay + hidden gun body) */
  _applyCameraState(){
    const scoping=this.weapon.def.scope&&this.weapon.adsAmt>.8&&this.player.alive;
    this.ui.setScope(scoping);
    this.weapon.group.visible=!scoping;
    this.viewCam.fov=75+(58-75)*this.weapon.adsAmt;
    this.viewCam.updateProjectionMatrix();
    // Scope/ADS zoom keeps the original vertical FOV ratio (scopeFov or 62 vs 75), applied to the horizontal FOV
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
    const hits=this.losRay.intersectObjects(this.world.losStatics||this.world.shootStatics,false);
    return hits.length===0;
  }

  /* ================= Verification hooks ================= */
  /* S1.1: ?roster=1 prints the operator roster (the roster UI landed in M1-C4) */
  _debugRoster(){
    const rows=OPERATORS.map(o=>({
      id:o.id,faction:o.faction,gender:o.gender,role:o.role.zh,
      hp:o.hp,speedMul:o.speedMul,reloadMul:o.reloadMul,rifle:o.rifle,
    }));
    console.table(rows);
    console.log(`[ROSTER] ${OPERATORS.length} operators · NOVA ${byFaction('ct').length} / ROGUE ${byFaction('t').length}`);
    return rows;
  }

  /* S1.3: ?portraits=1 renders all operator portraits and prints time / size */
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

  /* Radar visibility follows the setting + play state (per frame; e2e calls it directly) */
  _syncRadar(){
    const rc=document.getElementById('radar');
    if(!rc)return false;
    const on=this.settings.get('radar')&&this.state==='playing';
    rc.classList.toggle('hidden',!on);
    return on;
  }

  /* Dev: grab the composed frame as a PNG data URL (same-task readback — call from automation) */
  captureFrame(){
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /* C1: switch bot #1's looks from the console (check silhouettes / palettes) */
  debugSetOperator(id){
    const op=byId(id);
    if(!op)return false;
    const h=this.heroes&&this.heroes.list[0];
    if(h)h.setOperator({...op,camo:this.camoFor(op)});
    return !!h;
  }

  /* M3-G2: debug-spawn a pickup */
  debugSpawnPickup(type){return this.pickups.spawn(this.player.pos,type);}

  /* M3-G1: debug-throw a grenade */
  debugThrow(type){return this.grenades.throw(type);}

  /* M2-A1: debug-kill a given bot (check death animation / kill card) */
  debugKillBot(id){
    const h=this.heroes.list.find(x=>x.opId===id);
    if(h)h.takeDamage(9999,'DEBUG');
    return !!h;
  }

  /* C6: memory snapshot (acceptance: no growth across 10 deathmatch enter/exit cycles) */
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
    this.ui.killFeed('Snowwolf','Fox','AK-47',false);
    this.ui.killFeed(this.playerName,'Raven','M4A4',true);
    this.ui.setDmScore(7,5,213);
  }
  /* M4-P3: spectator screenshot */
  _shotSpectate(){
    this.ui.sel.mode='dm';this.startGame();this.fallbackAim=true;this.player.god=false;
    const killer=this.heroes.list.find(h=>h.team==='B');
    this.lastKiller=killer;
    this.player.health=1;this.player.alive=true;
    this.damagePlayerFromBot(999,killer.name,killer.pos);
  }

  /* M3-G7: onboarding screenshot */
  _shotTutorial(){this.ui.showTutorial(TUTORIAL,()=>{});}

  /* M2-A4: MVP results screenshot */
  _shotMvp(){
    const op=byId('frost');
    this.ui.showOver({
      title:t('win'),win:true,kicker:t('dm_over_kicker'),
      stats:{time:312,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:5,s:12}),
        kills:42,critKills:11,hits:280,shots:430,score:18960,best:21450,bestCombo:4,
        mvp:{name:isEN()?op.name.en:op.name.zh,op,kills:19,deaths:2}},
      board:`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>
        <tr class="me"><td>${isEN()?op.name.en:op.name.zh}</td><td>${t('faction_ct')}</td><td>19</td><td>2</td></tr></table>`,
    });
  }

  _shotOver(){
    this.ui.showOver({
      title:'OUTPOST LOST',win:false,kicker:'SIGNAL LOST',
      stats:{time:354,wave:9,kills:63,critKills:21,hits:412,shots:648,score:21450,best:22800,bestCombo:2},
    });
  }

  /* ================= Integration tests (?e2e=1): in-browser end-to-end assertions =================
     Driven deterministically (update stepped manually), independent of rAF — reproducible in background tabs / headless.
     Result: window.__e2e = {pass, fail, results[]} */
  async e2e(){
    store.set('o07_tutorial_done','1'); // skip first-run onboarding under e2e
    // Run against the default (GLB) character path: wait for the rigged models unless ?model=proc
    // (bounded — a failed load falls back to procedural and the suite still runs)
    if(!/model=proc/.test(location.search)&&!modelAssets.isReady())
      await new Promise(r=>{modelAssets.onReady(r);setTimeout(r,15000);});
    const results=[];let pass=0;
    const run=async(name,fn)=>{
      try{await fn();results.push({name,ok:true});pass++;}
      catch(err){results.push({name,ok:false,err:err&&err.message||String(err)});}
    };
    const assert=(c,m)=>{if(!c)throw new Error(m);};
    const stepW=n=>{for(let i=0;i<n;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});};
    const stepP=n=>{for(let i=0;i<n;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);};

    await run('boot-no-errors',()=>{
      assert(!this.ui.errors.some(e=>e.startsWith('ERR')),'errors during startup: '+this.ui.errors.join(';'));
    });
    await run('loadout-ct-aug',()=>{
      this.ui.sel.operator='frost';this.ui.sel.hero='ct';this.ui.sel.primary='aug';this.ui.sel.mode='waves';
      this.startGame();this.fallbackAim=true;this.player.god=true;
      assert(this.weapon.def.id==='aug','should be AUG, got '+this.weapon.def.id);
    });
    await run('scope-zoom-2-5x',()=>{
      this.input.ads=true;stepW(60);this._applyCameraState();
      assert(this.camera.fov<32,'FOV should be ≈30, got '+this.camera.fov.toFixed(1));
      assert(!this.weapon.group.visible,'scoping in should hide the gun body');
      assert(document.getElementById('scope-overlay').classList.contains('show'),'scope overlay should be visible');
      this.input.ads=false;stepW(60);this._applyCameraState();
      assert((this._hfovCur||0)>90,'scoping out should restore the 106 hip-fire horizontal FOV, got '+((this._hfovCur||0).toFixed(1)));
    });
    await run('recoil-pattern',()=>{
      this.weapon.setLoadout('ak47');
      this.weapon.recoilIdx=0;this.weapon.camKick=0;this.weapon.camKickYaw=0;
      this.input.firing=true;
      for(let i=0;i<30;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.recoilIdx>=4,'sustained fire should advance the recoil index, got '+this.weapon.recoilIdx);
      assert(this.weapon.camKick>0,'recoil should lift the view');
      this.input.firing=false;
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.recoilIdx===0,'recoil pattern should reset once firing stops');
    });
    await run('flick-same-frame-hit',()=>{
      // Fast-flick regression: fire on the same frame the flick lands; the shot uses the current yaw/pitch (not last frame's camera matrix)
      this.input.firing=false;
      this.enemies.clearAll();
      const p=this.player;
      p.pos.set(0,0,7);p.velY=0;p.grounded=true;p.vel.set(0,0,0);
      const tgt=new THREE.Vector3(6,1.6,-8);
      const e=this.enemies.spawn('WASP',tgt,{entering:false});
      e.group.updateMatrixWorld(true); // refresh matrices before raycasting in the same synchronous block (otherwise the ray misses)
      p.update(.016,this.input,this.keys,this.time,this.audio); // sync camera / eye position first
      const eye=p.pos.y+1.62;
      const dx=tgt.x-p.pos.x,dz=tgt.z-p.pos.z,dy=tgt.y-eye;
      const wantYaw=Math.atan2(-dx,-dz),wantPitch=Math.atan2(dy,Math.hypot(dx,dz));
      p.yaw=wantYaw+1.4;p.pitch=0;
      p.update(.016,this.input,this.keys,this.time,this.audio); // previous frame: still looking elsewhere
      p.yaw=wantYaw;p.pitch=wantPitch;                          // flick lands this frame, fire without a new frame
      this.weapon.st.ammo=30;
      const hits0=this.stats.hits,hp0=e.hp;
      this.fire(0);
      assert(this.stats.hits>hits0&&e.hp<hp0,'a same-frame flick shot should hit the target now in view (hp '+hp0+'→'+e.hp+')');
      this.enemies.kill(e,false,true);
    });
    await run('jump-gravity',()=>{
      this.player.pos.set(0,0,7);this.player.velY=0;this.player.grounded=true;this.player.pitch=0;
      this.keys.add('Space');
      this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(!this.player.grounded&&this.player.velY>0,'a jump should give upward velocity');
      this.keys.delete('Space');
      for(let i=0;i<90;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.player.grounded&&Math.abs(this.player.pos.y)<.01,'gravity should bring the player back to y=0, got y='+this.player.pos.y.toFixed(2));
    });
    await run('crate-landing',()=>{
      const c=this.world.colliders.find(c=>c.top>1.05&&c.top<1.25);
      assert(c,'the scene should have a ~1.1 m climbable crate');
      this.player.pos.set(c.minX+(c.maxX-c.minX)/2,c.top+1.2,c.minZ+(c.maxZ-c.minZ)/2);
      this.player.velY=-2;this.player.grounded=false;
      for(let i=0;i<60;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(Math.abs(this.player.pos.y-c.top)<.02,'should land on the crate top '+c.top+', got '+this.player.pos.y.toFixed(2));
    });
    await run('crouch-steady',()=>{
      this.keys.add('ControlLeft');
      for(let i=0;i<30;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.player.crouching,'should enter crouch');
      assert(this.player.eyeHCur<1.35,'crouching should lower eye height, got '+this.player.eyeHCur.toFixed(2));
      const sC=this.weapon.spreadRad(this.player);
      this.keys.delete('ControlLeft');
      for(let i=0;i<30;i++)this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.weapon.spreadRad(this.player)>sC,'standing spread should exceed crouching spread');
    });
    await run('primary-cycle-4',()=>{
      this.weapon.setLoadout(['m4a4','aug','awp','mp5'],0);
      const seq=[];
      for(let i=0;i<4;i++){
        this.weapon.switchTo(0); // press 1 repeatedly: cycle within the slot
        stepW(25);
        seq.push(this.weapon.def.id);
      }
      assert(JSON.stringify(seq)===JSON.stringify(['aug','awp','mp5','m4a4']),'in-slot cycle order: '+seq.join(','));
      this.weapon.switchTo(this.weapon.primaryCount+1);stepW(25);
      assert(this.weapon.def.id==='ump45','should switch to the UMP-45 backup SMG');
      assert(this.weapon.def.auto&&this.weapon.def.mag>0,'the third slot must be a full-auto gun, not melee');
      this.weapon.switchTo(0);stepW(25);
      assert(this.weapon.def.id==='m4a4','pressing 1 should return to the last primary, m4a4');
    });
    await run('backup-smg-auto',()=>{
      this.weapon.setLoadout(['m4a4','aug','awp','mp5'],0);
      this.weapon.switchTo(this.weapon.primaryCount+1);stepW(40);
      assert(this.weapon.def.id==='ump45','slot 3 should hold the UMP-45');
      const a0=this.weapon.st.ammo;
      this.input.firing=true;
      for(let i=0;i<10;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      this.input.firing=false;
      assert(this.weapon.st.ammo<a0,'holding the trigger should fire the backup SMG automatically: '+a0+' → '+this.weapon.st.ammo);
      assert(this.weapon.st.ammo>0,'the SMG should still have rounds left after a short burst');
      for(let i=0;i<30;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{}); // reset the trigger edge
    });
    await run('weapon-attach-welded',()=>{
      // Attachment integrity: every viewmodel must be one welded assembly (detached scope /
      // butt plate / front sight would show up as a separate island, see src/attach.js)
      const bad=[];
      for(const id in this.weapon.models){
        const r=attachmentIslands(this.weapon.models[id]);
        if(!r.ok)bad.push(id+' ('+r.count+' islands)');
      }
      assert(!bad.length,'floating weapon parts: '+bad.join(', '));
    });
    await run('weapon-speed-weight',()=>{
      this.weapon.setLoadout(['m4a4','aug','awp','mp5'],0);
      this.weapon.switchTo(2);stepW(40); // Longbow
      const awpSpd=this.player.speed;
      this.weapon.switchTo(0);stepW(40); // M4A4
      const m4Spd=this.player.speed;
      this.weapon.switchTo(this.weapon.primaryCount+1);stepW(40); // UMP-45
      const smgSpd=this.player.speed;
      this.weapon.switchTo(this.weapon.primaryCount);stepW(40); // Desert Eagle
      const pistolSpd=this.player.speed;
      assert(awpSpd<m4Spd,'Longbow should be slower than M4A4: '+awpSpd.toFixed(2)+' vs '+m4Spd.toFixed(2));
      assert(smgSpd>m4Spd,'the backup SMG should be lighter than the rifles: '+smgSpd.toFixed(2)+' vs '+m4Spd.toFixed(2));
      assert(pistolSpd>smgSpd,'the pistol should stay the lightest gun: '+pistolSpd.toFixed(2)+' vs '+smgSpd.toFixed(2));
    });
    await run('crit-damage-x2-5',()=>{
      this.enemies.clearAll();this.scene.updateMatrixWorld(true);
      const e=this.enemies.spawn('WASP',this.player.eye.clone().add(new (this.camera.position.constructor)(0,0,-6)),{entering:false});
      e.pos.y=1.62;e.group.position.copy(e.pos);this.scene.updateMatrixWorld(true);
      const hp0=e.hp;
      const res=this.enemies.damage(e,'core',10,e.pos.clone());
      assert(res.crit&&Math.abs(e.hp-(hp0-25))<.01,'red core should be ×2.5: hp '+hp0+' → '+e.hp.toFixed(1));
      this.enemies.clearAll();
    });
    await run('xss-escape',()=>{
      this.ui.killFeed('<img src=x onerror=window.__xssE2E=1>','<b>victim</b>','AK-47',false);
      assert(!window.__xssE2E,'XSS must not execute');
      assert(!document.querySelector('#killfeed img'),'callsign should be escaped');
    });
    await run('pitch-clamp-89',()=>{
      this.player.pitch=Math.PI;this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.camera.rotation.x<Math.PI/2+.01,'pitch should clamp at ±89° and never flip past the zenith, got '+this.camera.rotation.x.toFixed(2));
      this.player.pitch=-Math.PI;this.player.update(.016,this.input,this.keys,this.time,this.audio);
      assert(this.camera.rotation.x>-.01-Math.PI/2,'the lower pitch limit is clamped too, got '+this.camera.rotation.x.toFixed(2));
      this.player.pitch=0;this.player.update(.016,this.input,this.keys,this.time,this.audio);
    });

    await run('operators-8',()=>{
      this.ui.sel.operator='frost';this.ui.sel.hero='ct';this.ui.sel.primary='m4a4';this.ui.sel.mode='dm';
      this.startGame();
      const ids=this.heroes.list.map(h=>h.opId);
      assert(ids.length===7,'deathmatch should have 7 bots (4v4 with the player), got '+ids.length);
      assert(!ids.includes('frost'),'bots must not duplicate the player operator');
      const names=this.heroes.list.map(h=>h.name);
      assert(new Set(names).size===names.length,'cycled operators need distinct names: '+names.join(','));
      assert(this.heroes.list.filter(h=>h.team==='A').length===3,'there should be 3 teammates');
      assert(this.heroes.list.filter(h=>h.team==='B').length===4,'there should be 4 enemies');
      for(const h of this.heroes.list){
        assert(h.materials.length<=13,'each character should have ≤13 materials (GLB: body + used attachments), got '+h.materials.length);
        assert(h.parts.head&&h.parts.gunTip,'character parts should be complete');
      }
    });
    await run('fp-arms-faction',()=>{
      this.weapon.setFaction(byId('frost'));
      const ct=this.weapon._armSleeves[0].color.getHex();
      this.weapon.setFaction(byId('raven'));
      const t=this.weapon._armSleeves[0].color.getHex();
      assert(ct!==t,'Nova/Rogue first-person sleeve colours should differ: '+ct.toString(16)+' vs '+t.toString(16));
    });
    await run('pickup-magnet',()=>{
      this.ui.sel.mode='dm';this.startGame();
      this.player.god=true;this.player.health=50;
      const p=this.pickups.spawn(this.player.pos.clone(),'med');
      this.pickups.update(.016,this.player);
      assert(this.player.health>50,'medkit drop should heal');
      assert(!this.pickups.list.includes(p),'a picked-up drop should be removed');
    });
    await run('pickup-ammo',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const before=this.weapon.state[this.weapon.cur].reserve;
      this.pickups.spawn(this.player.pos.clone(),'ammo');
      this.pickups.update(.016,this.player);
      assert(this.weapon.state[this.weapon.cur].reserve>before,'an ammo drop should add reserve ammo');
      this.pickups.spawn(this.player.pos.clone(),'boost');
      this.pickups.update(.016,this.player);
      assert(this.damageBoostT>9&&this.playerDamageMul()>=1.4,'a boost drop should raise the damage multiplier');
    });
    await run('save-migrate',()=>{
      localStorage.removeItem('o07_save_v2');
      localStorage.setItem('o07_best','12345');
      localStorage.setItem('o07_best_wave','7');
      const s=new SaveSystem();
      assert(s.data.stats.bestScore===12345,'legacy best should migrate');
      assert(s.data.stats.bestWave===7,'legacy best_wave should migrate');
      localStorage.removeItem('o07_save_v2');
      const s2=new SaveSystem();
      assert(s2.data.stats.bestScore===12345,'migrated data should read back');
    });
    await run('save-dirty-daily',()=>{
      const date=new Date().toISOString().slice(0,10);
      localStorage.setItem('o07_save_v2',JSON.stringify({v:2,daily:{date,progress:null,done:false}}));
      const s=new SaveSystem();
      let err=null;
      try{s.award({kills:2,wave:1,headshots:1,score:100,time:10,opId:'frost'});}catch(e){err=e;}
      assert(!err,'dirty daily progress must not break the match award: '+(err&&err.message||''));
      assert(s.data.daily.progress.kills===2,'dirty daily progress should be rebuilt, got '+s.data.daily.progress.kills);
      assert(s.data.daily.progress.headshots===1,'headshot daily progress should be awarded, got '+s.data.daily.progress.headshots);
    });
    await run('xp-award',()=>{
      const s=new SaveSystem();
      const before=s.levelOf('frost');
      const r=s.award({kills:20,wave:10,score:5000,time:200,opId:'frost'});
      assert(r.xp>0&&r.level>=before.level,'XP should be awarded');
      assert(s.data.daily.date&&new SaveSystem().dailyGoals().length===3,'3 daily challenges should be generated');
      const s3=new SaveSystem();
      assert(s3.data.operators.frost.xp===s.data.operators.frost.xp,'XP should persist');
    });
    await run('waves-award',()=>{
      this.ui.sel.mode='waves';this.ui.sel.operator='frost';
      this.startGame();
      const before=JSON.parse(JSON.stringify(this.save.data));
      this.stats.kills=4;this.stats.headshots=2;this.stats.time=40;this.score=1200;this.waves.n=6;
      this.state='dying';this.dyingT=0;
      this.tick(); // dying → over must persist the match exactly like DM/KOTH
      const d=this.save.data;
      assert(d.stats.kills===before.stats.kills+4,'waves kills should persist, got '+d.stats.kills);
      assert(d.stats.playtime===before.stats.playtime+40,'waves playtime should persist, got '+d.stats.playtime);
      assert(d.stats.bestScore>=1200,'waves score should update bestScore, got '+d.stats.bestScore);
      assert(d.daily.progress.kills>=before.daily.progress.kills+4,'kill daily should progress, got '+d.daily.progress.kills);
      assert(d.daily.progress.headshots>=before.daily.progress.headshots+2,'headshot daily should progress, got '+d.daily.progress.headshots);
      assert(d.daily.progress.wave>=6,'wave daily should progress, got '+d.daily.progress.wave);
    });
    await run('koth-score',()=>{
      this.ui.sel.mode='koth';this.startGame();
      assert(this.koth.active&&this.koth.score.A===0,'KOTH should initialise');
      this.player.pos.set(0,0,0);
      this.player.alive=true;this.player.god=true;
      for(const h of this.heroes.list)h.alive=false;
      for(let i=0;i<120;i++)this.koth.update(.016);
      assert(this.koth.capture>0,'standing on the point should build capture progress');
      this.koth.score.A=199;this.koth.score.B=0;
      this.koth.capture=1;this.koth.owner='A';
      this.koth.update(1);
      assert(this.state==='over','reaching 200 points should end the match');
      this.startGame();
    });
    await run('accessibility',()=>{
      this.settings.set('reduceMotion',true);
      this.settings.set('colorblind',true);
      this.settings.set('uiScale',110);
      this.ui.applyAccessibility();
      assert(document.documentElement.classList.contains('cb'),'colour-blind mode should apply');
      assert(document.documentElement.classList.contains('reduce-motion'),'reduce-motion mode should apply');
      assert(document.documentElement.style.getPropertyValue('--ui-zoom')==='1.10','UI scale should apply');
      this.settings.reset();this.ui.applyAccessibility();
    });
    await run('spectate',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const killer=this.heroes.list.find(h=>h.team==='B');
      this.lastKiller=killer;
      this.player.god=false;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      assert(!this.player.alive,'player should be dead');
      assert(this.spectate.target===killer,'after death the killer should be spectated');
      this.player.alive=true;this.player.health=this.player.maxHealth;this.player.god=true;
      this.spectate.target=null;
    });
    await run('gamepad-map',()=>{
      const pad=this.inputMgr.adapters.find(a=>a instanceof GamepadAdapter);
      assert(pad&&typeof pad.poll==='function','gamepad adapter should be mounted');
      assert(PAD_MAP.buttons.RT==='fire'&&PAD_MAP.buttons.LT==='ads','gamepad mapping should be correct');
      assert(PAD_MAP.axes.deadzone===.18,'dead zone should be 0.18');
      pad.gamePadButtons=[{pressed:false,value:0},{pressed:false,value:0}];
      pad.prev={};
      pad._edge(0,()=>{},()=>{});
      assert(pad.prev[0]===false,'edge state of an unpressed button should be false');
    });
    await run('tutorial',()=>{
      this.ui.showTutorial(TUTORIAL,()=>{});
      const root=document.getElementById('tutorial');
      assert(!root.classList.contains('hidden'),'onboarding should show');
      const first=document.getElementById('tut-title').textContent;
      this.ui.nextTutorial();
      assert(document.getElementById('tut-title').textContent!==first,'next should advance the step');
      this.ui.closeTutorial(false);
      assert(root.classList.contains('hidden'),'skip should hide it');
    });
    await run('bot-cover',()=>{
      this.settings.set('botDifficulty','hard');
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      assert(h.difficulty==='hard','bot difficulty should come from settings');
      assert(h.coverTarget===null,'there should be no cover target initially');
      const saved=this.world.colliders.slice();
      this.world.colliders.push({minX:-2,maxX:2,minZ:-2,maxZ:2,top:2});
      try{
        h.pos.set(0,0,8);
        const c=h._findCover(new THREE.Vector3(0,1.4,0),()=>false);
        assert(c&&Number.isFinite(c.x)&&Number.isFinite(c.z),'a valid cover spot should be found');
        assert(Math.hypot(c.x,c.z)>2,'the cover spot should be outside the cover');
      }finally{ // restore even on failure — a leaked collider list would poison later tests
        this.world.colliders.length=0;
        for(const v of saved)this.world.colliders.push(v);
      }
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
      assert(n>100,'radar should draw something');
      this.player.yaw+=Math.PI/2;
      this.radar.frame=0;
      this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,false);
      const d2=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      let n2=0;for(let i=3;i<d2.length;i+=4)if(d2[i]>16)n2++;
      assert(n2>100,'radar should still draw after rotating');
      this.radar.frame=0;
      this.radar.update(this.player,this.enemies.list,this.heroes.list,this.pickups,true);
      this._syncRadar(); // the loop may have hidden it on menu frames before this test (e2e waits for the GLB rigs)
      assert(!document.getElementById('radar').classList.contains('hidden'),'radar element should exist');
    });
    await run('wave-20',()=>{
      this.ui.sel.mode='waves';this.startGame();
      for(let i=0;i<20;i++){
        this.waves.timer=0;
        this.waves.update(.016);          // start the wave
        this.waves.queue.length=0;
        this.enemies.clearAll();
        this.waves.update(.016);          // clear the wave
        if(this.state==='upgrade')this._pickUpgrade(0);
      }
      assert(this.waves.n>=20,`should advance 20 waves, got ${this.waves.n}`);
      assert(this.state==='playing','still playing after 20 waves (no soft lock)');
    });
    await run('boss-spawn',()=>{
      this.ui.sel.mode='waves';this.startGame();
      assert(this.waves.composition(5).includes('BOSS'),'wave 5 should include a BOSS');
      assert(!this.waves.composition(4).includes('BOSS'),'wave 4 should not include a BOSS');
      this.waves.n=4;this.waves.queue.length=0;this.waves.state='intermission';this.waves.timer=0;
      this.waves.update(.016);
      assert(this.waves.n===5,'should enter wave 5');
      assert(!!this.waves.modifier,'boss waves should carry a modifier');
      assert(['fog','emp','rush'].includes(this.waves.modifier),'modifier should be valid');
      const boss=this.enemies.spawn('WARDEN',new THREE.Vector3(0,2,-8),{hpScale:4});
      boss.boss=true;boss.phase=1;
      this.ui.setBoss(.5,t('boss_name'));
      const bar=document.getElementById('bossbar');
      assert(!bar.classList.contains('hidden'),'boss health bar should show');
      assert(document.getElementById('boss-fill').style.width==='50%','boss health bar ratio should be correct');
      this.ui.hideBoss();
      assert(bar.classList.contains('hidden'),'boss health bar should be hideable');
    });
    await run('upgrade-apply',()=>{
      this.ui.sel.mode='waves';this.startGame();
      const cards=rollUpgrades(this,3);
      assert(cards.length===3,'3 upgrade cards should be offered');
      assert(new Set(cards.map(c=>c.id)).size===3,'upgrade cards should not repeat');
      this.openUpgrade();
      assert(this.state==='upgrade','should enter the upgrade state');
      assert(!document.getElementById('upgrades').classList.contains('hidden'),'upgrade panel should show');
      applyUpgrade(this,'dmg');
      assert(this.upgrades.dmg===1&&this.playerDamageMul()>=1.15,'damage upgrade should apply immediately');
      this._applyUpgrade('rpm');
      assert(this.weapon.rpmMul>1,'fire-rate upgrade should apply immediately');
      assert(this.state==='playing'&&document.getElementById('upgrades').classList.contains('hidden'),'play should resume after choosing');
    });
    await run('upgrade-max',()=>{
      this.upgrades={dmg:3,rpm:3,reload:2,speed:2,hp:3,crit:2,pierce:1,regen:2};
      assert(rollUpgrades(this,3).length===0,'the candidate pool should be empty when everything is maxed');
      assert(!applyUpgrade(this,'dmg'),'a maxed upgrade should not stack further');
      this.startGame();
    });
    await run('grenade-count',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const g=this.grenades;
      assert(g.counts.frag===2&&g.counts.flash===2&&g.counts.smoke===1,'starting grenades should be 2/2/1');
      assert(g.throw('frag')&&g.counts.frag===1,'frag count should drop');
      assert(document.getElementById('g-frag').textContent==='1','HUD count should stay in sync');
      assert(g.throw('frag')&&!g.throw('frag'),'no throws once depleted');
      assert(!g.throw('unknown'),'unknown types should be rejected');
      g.reset();
      assert(g.counts.frag===2,'grenades should refill on restart');
    });
    await run('grenade-aoe',()=>{
      this.ui.sel.mode='waves';this.startGame();this.player.god=true;
      const e=this.enemies.spawn('WASP',new THREE.Vector3(2,1.4,2),{entering:false});
      const hp=e.hp;
      this.grenades._explode({type:'frag',pos:new THREE.Vector3(2,1.4,2)});
      assert(e.hp<hp,'frag AoE should damage enemies in range');
      const far=this.enemies.spawn('WASP',new THREE.Vector3(40,1.4,40),{entering:false});
      const farHp=far.hp;
      this.grenades._explode({type:'frag',pos:new THREE.Vector3(2,1.4,2)});
      assert(far.hp===farHp,'enemies out of range should be unharmed');
    });
    await run('flash-blind',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list.find(x=>x.team==='B');
      this.grenades._explode({type:'flash',pos:h.pos.clone()});
      assert(h.blindT>2,'a flash should blind enemy bots in range');
      this.grenades._explode({type:'smoke',pos:h.pos.clone()});
      assert(this.grenades.inSmoke(h.pos),'inside the smoke should test true');
      assert(!this.grenades.inSmoke(new THREE.Vector3(99,0,99)),'outside the smoke should test false');
    });
    await run('anim-state',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      h.vel.set(0,0,0);h.reloadT=0;h.hitT=0;h.recoilKick=0;h.moving=false;
      assert(h._decideAnim(null)==='idle','still with no target → idle');
      h.moving=true;
      assert(h._decideAnim(null)==='walk','moving → walk');
      h.moving=false;
      assert(h._decideAnim({})==='aim','has a target → aim');
      h.hitT=.2;
      assert(h._decideAnim(null)==='hit','hit → hit');
      h.hitT=0;h.recoilKick=.5;
      assert(h._decideAnim(null)==='fire','firing → fire');
      h.recoilKick=0;h.reloadT=.5;
      assert(h._decideAnim(null)==='reload','reloading → reload');
      h.ammo=1;h.reloadT=0;h._consumeAmmo();
      assert(h.reloadT>1.1&&h.ammo===h.magSize,'an empty magazine should trigger a 1.2 s reload');
      h.reloadT=0;h.recoilKick=0;
      h._animate(.016,1,0);
      assert(Number.isFinite(h.armR.rotation.x)&&Number.isFinite(h.torso.position.y),'animation pose should be finite');
      assert(Math.abs(h.armR.rotation.x-h.baseArmR[0])<.01,'the idle rifle pose should return to the baseline (no T-pose)');
    });
    await run('radio-barks',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      h._barkT=0;
      assert(h.bark('bark_spot'),'the first bark should fire');
      assert(!h.bark('bark_spot'),'no repeat within the 6 s cooldown');
      assert(this.ui.barkPool.some(p=>p.t>0),'a bark slot should be showing');
      h._barkT=0;h.hp=h.maxHp*.2;h._lowBarked=false;
      h.takeDamage(1,'E2E');
      assert(h._lowBarked,'low health should trigger a bark');
      assert(!h.bark('bark_spot'),'a bark should start the cooldown');
    });
    await run('nametag-hp',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      assert(h.nameTag&&h.nameTag.bar&&h.nameTag.group,'name tag should include the health bar parts');
      assert(Math.abs(h.nameTag.bar.scale.x-1)<.01,'full health bar should be 1');
      h.takeDamage(h.maxHp*.5,'E2E');
      assert(Math.abs(h.nameTag.bar.scale.x-.5)<.02,'half health bar should be .5');
      this.camera.position.copy(h.pos);
      h.update(.016,this.time,()=>false);
      assert(h.nameTag.group.visible,'name tag should be visible up close');
      assert(h.nameTag.sprite.material.opacity>.9,'name tag should be fully opaque within 30 m');
      this.camera.position.set(999,0,999);
      h.update(.016,this.time,()=>false);
      assert(!h.nameTag.group.visible,'name tag should fade out and hide at long range');
      h.respawn();
      assert(Math.abs(h.nameTag.bar.scale.x-1)<.01,'health bar should reset after respawn');
      this.camera.position.set(0,1.6,8);
    });
    await run('mvp-card',()=>{
      const op=byId('raven');
      this.ui.showOver({title:'X',win:true,kicker:'X',mvp:null,
        stats:{time:60,waveLabel:'W',wave:'1',kills:10,critKills:2,hits:20,shots:30,score:100,best:0,bestCombo:2,
          mvp:{name:'Raven',op,kills:10,deaths:1}}});
      const el=document.getElementById('o-mvp');
      assert(!el.classList.contains('hidden'),'MVP card should show');
      assert(el.textContent.includes('Raven'),'MVP name should show');
      assert(el.querySelector('.mvp-face'),'MVP should have a portrait or the initial fallback');
      this.ui.showOnly(null);
    });
    await run('share-card',()=>{
      const cv=this.ui.buildShareCard({score:12345,wave:9,kills:63,hits:412,shots:648,bestCombo:4,waveLabel:'WAVE'},byId('frost'));
      assert(cv&&cv.width===1200&&cv.height===630,'share card should be 1200×630');
      const d=cv.getContext('2d').getImageData(600,315,1,1).data;
      assert(d[3]>0,'share card should draw an opaque background');
      assert(typeof this.ui.downloadShareCard==='function','a download entry point should exist');
    });
    await run('music-bgm',()=>{
      const a=this.audio;
      a.musicStart('menu');a.musicSet(.9);a.musicMode('combat');a.musicStop();
      a.musicStart('combat');a.musicSet(.2);
      this.pause();
      assert(this.state==='paused','pause should enter the paused state');
      this.resume();
      assert(this.state==='playing','resume should return to playing');
      this.toMenu();
      assert(this.state==='menu','returning to the menu should enter menu');
      assert(!this.ui.errors.some(e=>e.startsWith('ERR')),'BGM switching should not raise runtime errors');
    });
    await run('death-no-explosion',()=>{
      this.ui.sel.mode='dm';this.startGame();
      let boom=0;
      const orig=this.effects.explosion;
      this.effects.explosion=(...a)=>{boom++;return orig.apply(this.effects,a);};
      const h=this.heroes.list[0];
      h.takeDamage(9999,'E2E');
      assert(!h.alive&&h.state==='dying','the character should enter the dying state');
      assert(boom===0,'human deaths should not trigger an explosion');
      assert(h.parts.rifle.parent===this.scene,'the rifle should drop on death');
      h.update(1,this.time,()=>true);
      assert(h.state==='dead','should become a corpse after 0.7 s');
      // the collapse lands prone with flat limbs, then the corpse fades out ≈0.8 s later
      assert(Math.abs(h.group.rotation.x+Math.PI/2.2)<.03,'the body should be prone when the limbs land, rotation.x='+h.group.rotation.x.toFixed(2));
      const A=h.armL,restQ=A.userData.rig?A.userData.rig.restQ:(b=>{const e=new THREE.Euler(b.x,b.y,b.z);return new THREE.Quaternion().setFromEuler(e);})(A.userData.restR);
      const armAng=2*Math.acos(Math.min(1,Math.abs(A.quaternion.clone().dot(restQ))));
      assert(armAng>.7,'the arms should unwind from the rifle hold as the body lands, angle '+armAng.toFixed(2));
      h.update(.7,this.time,()=>true); // deathT≈1.7 → past the .8 s vanish window
      assert(Math.abs(h.materials[0].opacity)<.02,'the corpse should be gone shortly after the limbs land, opacity '+h.materials[0].opacity);
      h.deathT=5.6;
      h.update(.016,this.time,()=>true);
      assert(h.alive&&h.state==='active','should respawn after 5.5 s');
      // GLB rigs hold the rifle on the hand BONE (a group descendant); proc holds it on the group
      const rp=h.parts.rifle.parent;
      assert(rp===h.group||h.group.getObjectById(rp.id),'the rifle should be back in hand after respawn');
      assert(Math.abs(h.materials[0].opacity-1)<.01,'materials should be opaque again after respawn');
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
        assert(Math.abs(d)<.2,`direction error ${d.toFixed(2)}rad (expected ${want.toFixed(2)}, got ${this.ui.lastDmgAngle.toFixed(2)})`);
      };
      check(0,-10,0);            // straight ahead
      check(0,10,Math.PI);       // straight behind
      check(10,0,Math.PI/2);     // right
      check(-10,0,-Math.PI/2);   // left
      this.player.god=true;this.player.health=this.player.maxHealth;
    });
    await run('combo-callout',()=>{
      this.comboKills=1;this.comboT=4;
      this._onKill({T:{score:100},pos:new THREE.Vector3()},false);
      assert(this.comboKills===2,'a second kill within 4 s should count toward the streak');
      const el=document.getElementById('combo-callout');
      assert(el.classList.contains('show'),'the streak callout should show');
      assert(el.textContent.length>0,'the streak callout should have text');
    });
    await run('settings-persist',()=>{
      this.settings.set('fov',90);
      this.settings.set('crosshair.color','#ff8800');
      const raw=JSON.parse(localStorage.getItem('o07_settings_v2'));
      assert(raw.fov===90,'FOV should be saved');
      assert(raw.crosshair.color==='#ff8800','crosshair colour should be saved');
      this.settings.load();
      assert(this.settings.get('fov')===90,'FOV should survive a reload');
      this.settings.set('fov',106);
      this.settings.set('crosshair.color','#7fe3ff');
    });
    await run('fov-apply',()=>{
      this.baseHFov=90;this._hfovCur=90;this._applyCameraState();
      const want=THREE.MathUtils.radToDeg(2*Math.atan(Math.tan(THREE.MathUtils.degToRad(90)*.5)/this.camera.aspect));
      assert(Math.abs(this.camera.fov-want)<.5,`FOV should apply: ${this.camera.fov.toFixed(2)} vs ${want.toFixed(2)} (adsAmt=${this.weapon.adsAmt.toFixed(2)} inputAds=${this.input.ads} weapon=${this.weapon.def.id||this.weapon.def.name} base=${this.baseHFov})`);
      this.baseHFov=106;this._hfovCur=106;this._applyCameraState();
    });
    await run('operator-camo-persist',()=>{
      this.ui.selectOperator('fox');
      this.ui.setCamo('desert');
      assert(store.get('o07_operator')==='fox','operator choice should persist');
      assert(store.get('o07_camo_fox')==='desert','camo choice should persist');
      assert(this.ui.camoOf(byId('fox'))==='desert','camoOf should return the saved camo');
      assert(this.ui.sel.hero==='t','choosing a Rogue operator should switch faction');
      assert(this.ui.sel.primary==='ak47','after a faction switch the primary should fall back to a valid faction weapon');
      this.ui.selectOperator('frost');
      assert(this.ui.sel.hero==='ct','switching back to a Nova operator should restore the faction');
      assert(this.ui.sel.camo===this.ui.camoOf(byId('frost')),'camo should follow the operator back');
    });
    await run('bot-separate-4v4',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const L=this.heroes.list;
      // Blind everyone: no target-driven movement or fire, but separation + collide stay active
      L.forEach((h,i)=>{h.place(new THREE.Vector3(i*.1-.35,0,0),0);h.blindT=999;h.vel.set(0,0,0);});
      for(let i=0;i<30;i++)this.heroes.update(.016,this.time+i*.016,()=>true);
      for(let i=0;i<L.length;i++)for(let j=i+1;j<L.length;j++){
        const a=L[i],b=L[j];
        if(!a.alive||!b.alive)continue;
        const d=Math.hypot(a.pos.x-b.pos.x,a.pos.z-b.pos.z);
        assert(d>=.7,`alive bots must stay ≥.7 apart after separation: ${a.name}/${b.name} = ${d.toFixed(3)}`);
      }
      for(const h of L){
        if(!h.alive)continue;
        for(const c of this.world.colliders){
          if(h.pos.y>c.top)continue;
          const cx=Math.max(c.minX,Math.min(h.pos.x,c.maxX)),cz=Math.max(c.minZ,Math.min(h.pos.z,c.maxZ));
          assert(Math.hypot(h.pos.x-cx,h.pos.z-cz)>=.44,`${h.name} must not end up inside a collider after separation`);
        }
      }
    });
    await run('bot-duel',()=>{
      this.settings.set('botDifficulty','hard');
      this.ui.sel.mode='dm';this.startGame();
      const L=this.heroes.list;
      const a=L.find(h=>h.team==='A'),b=L.find(h=>h.team==='B');
      for(const h of L)if(h!==a&&h!==b){h.place(new THREE.Vector3(0,0,h.team==='A'?40:-40),0);h.blindT=999;}
      this.player.pos.set(50,0,60); // keep the player out of the duelists' targeting
      a.place(new THREE.Vector3(-1.5,0,0),0);
      b.place(new THREE.Vector3(1.5,0,0),Math.PI);
      a.blindT=0;b.blindT=0;a.fireT=0;b.fireT=0;a.reactionT=0;b.reactionT=0;
      const origFeed=this.ui.killFeed;let feedCalls=0,lastKill=null;
      this.ui.killFeed=(k,v,...rest)=>{feedCalls++;lastKill={k,v};return origFeed.apply(this.ui,[k,v,...rest]);};
      const kills0=[...this.dm.scores.values()].reduce((s,x)=>s+x.kills,0);
      let deaths=0;
      for(let i=0;i<1250&&deaths<1;i++){
        this.heroes.update(.016,this.time+i*.016,()=>true);
        deaths=[...this.dm.scores.values()].reduce((s,x)=>s+x.kills,0)-kills0;
      }
      this.ui.killFeed=origFeed;
      assert(deaths>=1,'two bots dueling at 3 m should score a kill within 20 s');
      assert(feedCalls>=1,'a bot kill should add a killfeed entry');
      assert(lastKill&&(lastKill.k===a.name||lastKill.k===b.name),'the killfeed killer should be one of the duelists');
      this.settings.set('botDifficulty','normal');
    });
    await run('dm-win',()=>{
      this.ui.sel.mode='dm';this.startGame();
      assert(this.dm&&this.dm.winKills,'deathmatch should initialise scores');
      for(const s of this.dm.scores.values())if(s.team==='A')s.kills=this.dm.winKills-1;
      const b=this.heroes.list.find(h=>h.team==='B');
      const hs0=this.save.data.daily.progress.headshots;
      b.takeDamage(9999,this.playerName,true); // headshot credited to the player → team A reaches winKills
      assert(this.stats.headshots===1,'hero headshot should count for the daily challenge, got '+this.stats.headshots);
      assert(this.save.data.daily.progress.headshots>=hs0+1,'headshot daily should be awarded at match end');
      assert(this.state==='over','reaching winKills should end the match');
      this.startGame();
    });
    await run('bot-reload-choreo',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const h=this.heroes.list[0];
      h.place(new THREE.Vector3(0,0,0),0);h.blindT=0;h.coverTarget=null;
      // Pose deltas live on the quaternion for GLB bones (rig.js) and on the euler for proc
      // parts — measure the total rotation away from the rest pose, which works for both
      const qRest=new THREE.Quaternion(),qCur=new THREE.Quaternion(),eRest=new THREE.Euler();
      const poseAngle=o=>{
        const r=o.userData.rig;
        if(r){qRest.copy(r.restQ);qCur.copy(o.quaternion);}
        else{const b=o.userData.restR;qRest.setFromEuler(eRest.set(b.x,b.y,b.z));qCur.setFromEuler(o.rotation);}
        return 2*Math.acos(Math.min(1,Math.abs(qRest.dot(qCur))));
      };
      h.reloadT=1.2;h.ammo=h.magSize;h.reactionT=0;h.fireT=1.2;
      let peak=0;
      for(let i=0;i<75;i++){
        h.update(.016,this.time+i*.016,()=>false); // LOS blocked: no fire once the reload ends
        peak=Math.max(peak,poseAngle(h.armL));
      }
      assert(peak>.5,'the support arm should swing through the reload choreography, peak '+peak.toFixed(2));
      assert(h.reloadT===0,'the reload should complete after 1.2 s');
      assert(h.ammo===h.magSize,'the magazine should be full after the reload');
      assert(poseAngle(h.armL)<.02,'the support arm should return to rest after the reload');
      h.respawn();
    });
    await run('bot-player-damage',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const b=this.heroes.list.find(h=>h.team==='B');
      this.player.god=false;this.invulnT=0;this.player.alive=true;
      this.player.pos.set(0,0,4);this.player.health=100;this.player.maxHealth=100;
      b.place(new THREE.Vector3(0,0,10),Math.PI);
      b.blindT=0;b.update(.016,this.time,()=>true); // acquire the player as the nearest enemy
      b.reactionT=0;b.fireT=0;
      const orig=Math.random;
      Math.random=()=>.99; // force a hit
      try{b.update(.016,this.time,()=>true);}finally{Math.random=orig;}
      assert(this.player.health===91,'rogue dmgP 9 should reach the player, health '+this.player.health);
      this.invulnT=2;this.player.health=100;b.fireT=0;
      Math.random=()=>.99;
      try{b.update(.016,this.time,()=>true);}finally{Math.random=orig;}
      assert(this.player.health===100,'spawn invulnerability must block bot damage');
      this.invulnT=0;this.player.god=true;this.player.health=100;b.fireT=0;
      Math.random=()=>.99;
      try{b.update(.016,this.time,()=>true);}finally{Math.random=orig;}
      assert(this.player.health===100,'god mode must block bot damage');
      this.player.god=false;this.player.health=100;
    });
    await run('map-matrix-4',()=>{
      const m0=this.world.mapKey;
      const MAP_KEYS=['desert','snow','snowtown','ember'];
      const clearOf=(x,z,r)=>this.world.colliders.every(c=>{
        const cx=Math.max(c.minX,Math.min(x,c.maxX)),cz=Math.max(c.minZ,Math.min(z,c.maxZ));
        return Math.hypot(x-cx,z-cz)>=r;
      });
      for(const k of MAP_KEYS){
        this.ui.sel.map=k;this.ui.sel.mode='dm';this.startGame();
        assert(this.world.mapKey===k,k+' should load');
        assert(this.world.colliders.length>0&&this.world.losStatics.length>0,k+' should build colliders and LOS statics');
        for(const c of this.world.colliders)
          assert(c.minX<c.maxX&&c.minZ<c.maxZ&&c.top>0&&Number.isFinite(c.top),k+' has a degenerate collider: '+JSON.stringify(c));
        // Fixed gameplay anchors must be clear of geometry on every layout.
        // The DM respawn envelope is x∈[-3,3] at z=24 (main.js tick), so sample along that line.
        for(const gx of[-3,-1.5,0,1.5,3])
          assert(clearOf(gx,24,.4),k+': the player DM spawn line is blocked at '+gx+',24');
        for(const [gx,gz] of this.world.spawnPoints)
          assert(clearOf(gx,gz,.5),k+': drone spawn gate is blocked at '+gx+','+gz);
        assert(clearOf(0,0,.45),k+': the KOTH capture point at the origin is blocked');
        assert(clearOf(0,24,.45)&&clearOf(0,-24,.45),k+': a bot team base center is blocked');
        // Stepped simulation: nothing goes NaN and the match keeps running
        const errs0=this.ui.errors.length;
        this.player.god=true;this.player.alive=true;this.invulnT=0;
        this.player.pos.set(0,0,24);this.player.velY=0;this.player.grounded=true;
        for(let i=0;i<60;i++){
          this.player.update(.016,this.input,this.keys,this.time+i*.016,this.audio);
          this.weapon.update(.016,this.input,this.player,this.camera,this.time+i*.016,()=>{});
          this.heroes.update(.016,this.time+i*.016,(a,b)=>this._los(a,b));
        }
        assert(Number.isFinite(this.player.pos.x)&&Number.isFinite(this.player.pos.y)&&Number.isFinite(this.player.pos.z),k+': player position went NaN');
        for(const h of this.heroes.list)
          assert(Number.isFinite(h.pos.x)&&Number.isFinite(h.pos.z),k+': '+h.name+' position went NaN');
        assert(this.state==='playing',k+': the match should stay running, got '+this.state);
        assert(this.ui.errors.length===errs0,k+' raised runtime errors: '+this.ui.errors.slice(errs0).join(';'));
      }
      this.ui.sel.map=m0;this.startGame();
    });
    await run('scoped-fire-clear',()=>{
      this.ui.sel.mode='waves';this.startGame();
      this.fallbackAim=true;
      this.weapon.setLoadout('awp');
      this.player.pos.set(0,0,20);this.player.alive=true;this.player.god=true;
      this.input.ads=true;
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.adsAmt>.9,'should be fully scoped, adsAmt '+this.weapon.adsAmt.toFixed(2));
      this.fire(0);
      this.effects.update(.016);
      const t=this.effects.tracers.find(x=>x.active);
      assert(t,'firing should spawn a tracer');
      // the bright head must render past the near-fade zone, never on the lens
      const hcs=this.camera.worldToLocal(t.head.position.clone());
      assert(hcs.z<-1.8,'the tracer head must render beyond the scope fade zone, cam z '+hcs.z.toFixed(1));
      // the muzzle smoke spawns metres down the aim ray — a full-size puff at the muzzle
      // point (half a metre out, on-axis) would cover the entire lens
      const s=this.effects.smoke;
      assert(s.n>0,'a muzzle smoke puff should spawn');
      const i3=(s.n-1)*3;
      const cs=this.camera.worldToLocal(new THREE.Vector3(s.pos[i3],s.pos[i3+1],s.pos[i3+2]));
      assert(cs.z<-3,'scoped muzzle smoke should spawn well ahead of the lens, cam z '+cs.z.toFixed(1));
      // one weapon update with the flash timer running: the point light must stay dark on the scope view
      this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(this.weapon.flashLight.intensity===0,'the muzzle light must stay dark while scoped, got '+this.weapon.flashLight.intensity.toFixed(2));
      this.input.ads=false;
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
    });
    await run('bot-spawn-4maps',()=>{
      const m0=this.world.mapKey;
      for(const k of ['desert','snow','snowtown','ember']){
        this.ui.sel.map=k;this.ui.sel.mode='dm';this.startGame();
        assert(this.world.mapKey===k,k+' should load');
        for(const h of this.heroes.list){
          h.respawn();
          const baseZ=h.team==='A'?24:-24;
          if(h.team==='A')assert(Math.abs(h.yaw-Math.PI)<1e-6,'team A should face the enemy side after respawn on '+k);
          else assert(Math.abs(h.yaw)<1e-6,'team B should face the enemy side after respawn on '+k);
          // ±4 jitter + up to ~.9 m of spawn pop-out from map geometry (caldera rims/pillars)
          assert(Math.hypot(h.pos.x,h.pos.z-baseZ)<=7,k+' respawn strayed from the base: '+h.name+' at '+h.pos.x.toFixed(1)+','+h.pos.z.toFixed(1));
          for(const c of this.world.colliders){
            if(h.pos.y>c.top)continue;
            const cx=Math.max(c.minX,Math.min(h.pos.x,c.maxX)),cz=Math.max(c.minZ,Math.min(h.pos.z,c.maxZ));
            assert(Math.hypot(h.pos.x-cx,h.pos.z-cz)>=.44,`${h.name} respawned inside map geometry on ${k}`);
          }
        }
      }
      this.ui.sel.map=m0;this.startGame();
    });
    await run('memory-stable',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const before=this.debugMemory();
      for(let i=0;i<10;i++){this.startGame();this.toMenu();}
      this.startGame();
      const after=this.debugMemory();
      assert(after.geometries<=before.geometries+2,`geometry count should not grow: ${before.geometries} → ${after.geometries}`);
      assert(after.heroMats===before.heroMats,`character material count should stay stable: ${before.heroMats} → ${after.heroMats}`);
      assert(after.textures<=before.textures+5,`textures should not keep growing: ${before.textures} → ${after.textures}`);
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
      this.scene.updateMatrixWorld(true); // without a render frame (background tab / headless) sync the whole scene tree so raycasts work
      const dir=new THREE.Vector3(0,0,-1);
      // 1. Primary weapon hit and kill
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
      // 2. Desert Eagle (semi-auto)
      this.weapon.switchTo(this.weapon.primaryCount);
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{}); // deterministic switch (independent of rAF, reproducible in background tabs)
      this.enemies.clearAll(); // clear old drones that might block the ray
      const e2=this.enemies.spawn('WASP',this.player.eye.clone().addScaledVector(dir,7),{entering:false});
      e2.pos.y=1.62;
      e2.group.position.copy(e2.pos);
      this.scene.updateMatrixWorld(true); // firing inside the same synchronous block needs a manual world-matrix refresh
      const hp2=e2.hp;
      const to2=e2.pos.clone().sub(this.player.eye);
      this.player.yaw=Math.atan2(-to2.x,-to2.z);this.player.pitch=0;
      this.player.update(0,this.input,this.keys,this.time,this.audio);
      this.fire(0);
      await new Promise(r=>setTimeout(r,200));
      const deagleOk=e2.dead||e2.hp<hp2;
      log(`deagle hp ${hp2} -> ${e2.dead?'DEAD':e2.hp.toFixed(1)} : ${deagleOk?'PASS':'FAIL'}`);
      // 3. Backup SMG (slot 3, full-auto): hold the trigger at a drone — ammo and HP must both drop
      this.weapon.switchTo(this.weapon.primaryCount+1);
      for(let i=0;i<40;i++)this.weapon.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      this.enemies.clearAll();
      const e3=this.enemies.spawn('WASP',this.player.eye.clone().addScaledVector(dir,6),{entering:false});
      e3.pos.y=1.62;
      e3.group.position.copy(e3.pos);
      this.scene.updateMatrixWorld(true);
      const hp3=e3.hp;
      const to3=e3.pos.clone().sub(this.player.eye);
      this.player.yaw=Math.atan2(-to3.x,-to3.z);this.player.pitch=0;
      this.player.update(0,this.input,this.keys,this.time,this.audio);
      const ammo3=this.weapon.st.ammo;
      this.input.firing=true;
      for(let i=0;i<8;i++)this.weapon.update(.02,this.input,this.player,this.camera,this.time,d=>this.fire(d));
      this.input.firing=false;
      await new Promise(r=>setTimeout(r,200));
      const smgOk=(e3.dead||e3.hp<hp3)&&this.weapon.st.ammo<ammo3;
      log(`ump45 hp ${hp3} -> ${e3.dead?'DEAD':e3.hp.toFixed(1)} / ammo ${ammo3} -> ${this.weapon.st.ammo} : ${smgOk?'PASS':'FAIL'}`);
      this.ui.debug(`SELFTEST rifle ${ok?'PASS':'FAIL'} / deagle ${deagleOk?'PASS':'FAIL'} / smg ${smgOk?'PASS':'FAIL'}`);
    }catch(err){
      log('FAIL '+err.message);
      this.ui.debug('SELFTEST FAIL '+err.message,true);
    }
  }
}

new Game();
