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
import {circleOverlapsCollider,verticalBodyOverlap} from './collision.js';
import {findSafeSpawn,spawnPointClear} from './spawn.js';
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
import {FunItems,funApplyScore,funStartBreakdown,FUN_MATCH,FUN_ITEMS,FUN_CATEGORIES} from './funItems.js';
import {prewarmPropModels} from './funProps.js';
import {Pickups} from './pickups.js';
import {applyUpgrade,rollUpgrades} from './upgrades.js';
import {Radar} from './radar.js';
import {OPERATORS,byId,byFaction,DEFAULT_OP,CAMOS} from './operators.js';
import {store,num,escHTML} from './util.js';
import {NetMatch,PHASE} from './netMatch.js';
import {NetLobby} from './netLobby.js';
import {LoopbackTransport} from './net.js';
import {C,S,ROOM_CODE_RE,SPAWN_INVULN} from './netProtocol.js';
import {auditFeet} from './footAudit.js';
import {terrainHeight} from './terrain.js';
import {contrastCheck} from './contrastCheck.js';
import {SquadAI} from './squadAI.js';

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
const VERSION='1.13.0';
const _rsO=new THREE.Vector3(); // reused ray-sphere test vector (zero allocation on the hot path)
const DEBUG=typeof DEBUG_HOOKS!=='undefined'?DEBUG_HOOKS:true; // production build sets DEBUG_HOOKS=false

class Game{
  constructor(){
    // The static loading screen (top of <body>) has been visible since the first bytes of the page;
    // localise its status line now that i18n is up. It is dismissed at the end of this constructor.
    const bootStatus=$('boot-status');
    if(bootStatus)bootStatus.textContent=t('boot_loading');
    performance.mark('gtg:boot');
    this.shotMode=new URLSearchParams(location.search).get('shot');
    this.selftestMode=new URLSearchParams(location.search).has('selftest');
    this.e2eMode=new URLSearchParams(location.search).has('e2e');
    this.perfMode=new URLSearchParams(location.search).has('perf');
    this.rosterMode=new URLSearchParams(location.search).has('roster');
    this.portraitsMode=new URLSearchParams(location.search).has('portraits');
    this.bossMode=new URLSearchParams(location.search).get('boss')==='1';
    this.mapOverride=new URLSearchParams(location.search).get('map'); // ?map= test hook (validated against MAPS before use)
    this.padMode=new URLSearchParams(location.search).has('pad');
    this.debugExpose=new URLSearchParams(location.search).has('debug'); // ?debug=1 exposes window.__GTG_DEBUG__
    this.touchMode=new URLSearchParams(location.search).has('touch')||
      (typeof matchMedia==='function'&&matchMedia('(pointer:coarse)').matches);
    if(DEBUG&&(this.shotMode||this.selftestMode||this.e2eMode||this.rosterMode||this.portraitsMode||this.padMode))window.__game=this; // debug probe: stripped in production
    this.perf={frames:0,slow:0,maxDt:0}; // hitch monitor: slow frame (>25ms) count
    this.dynScale=1;this._perfAt=0;
    this.state='menu'; // menu | playing | paused | dying | over | tutorial | upgrade
    this.keys=new Set();
    this.input={firing:false,ads:false};
    this.fallbackAim=false;
    this._suppressPauseOnce=false; // set before a game-initiated unlock so the lock-loss auto-pause is skipped. Arena death no longer unlocks (it used to, and the respawn re-lock could be refused); kept for any future scripted unlock.
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
    this.playerTeam='A';                       // derived in startGame(); online A=NOVA / B=ROGUE
    this.spawns={A:new THREE.Vector3(0,0,24),B:new THREE.Vector3(0,0,-24)};
    this.netMatch=null;this.netLobby=null;
    this._uiLock=false;                        // online pause / 3 s countdown freezes local input only
    this._netReady=false;
    this.t=t;                                  // shared by NetMatch killfeed
    this.invulnT=0;this.dmRespawnT=-1;
    this.spawnInvulnT=0;                       // respawn shield countdown (see SPAWN_INVULN)
    this._tabHeld=false;this._boardAt=0;       // live TAB board refresh (see tick / input.js)
    this._deathHandled=false;                  // ensures death side-effects run once per life
    this.spectate={target:null,t:0};this.lastKiller=null;
    this._specWant=new THREE.Vector3();this._specFrom=new THREE.Vector3();this._specDir=new THREE.Vector3();
    this._boot();
  }

  /* ================= Boot ================= */
  _boot(){
    applyStatic(); // swap in static copy right after first-frame language detection (script blocks parsing, so no flash)
    this.ui=new UI();
    this.ui._save=this.save;
    // One NetMatch for the whole page. No socket opens until the player picks the online mode.
    const netOpts={};
    if(DEBUG&&new URLSearchParams(location.search).get('net')==='loopback'){
      const loop=new LoopbackTransport();
      window.__loopback=loop;
      window.__game=this; // debug probe for ?net=loopback (same single Game instance)
      netOpts.client=loop.createClient();
    }
    this.netMatch=new NetMatch(this,netOpts);
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
    // WebGL context loss: try a real in-place restore first; reload only as a last resort.
    this.renderer.domElement.addEventListener('webglcontextlost',e=>{
      e.preventDefault();
      this.renderer.setAnimationLoop(null);
      this.ui.debug('ERR WebGL context lost · recovering…',true);
      clearTimeout(this._ctxLostTimer);
      this._ctxLostTimer=setTimeout(()=>location.reload(),5000);
    },false);
    this.renderer.domElement.addEventListener('webglcontextrestored',()=>{
      clearTimeout(this._ctxLostTimer);
      try{this.rebuildAfterContextRestore();}
      catch(err){console.error(err);location.reload();}
    },false);
    // Background tabs: pointer-lock loss covers desktop, but fallbackAim / touch need this.
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden&&(this.state==='playing'||this.state==='dying')){
        this.input.firing=false;this.input.ads=false;this.keys.clear();
        if(this.online())this.netMenu();
        else this.pause();
      }
    });
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

    performance.mark('gtg:assets-start');
    this.assets=initAssets();
    performance.mark('gtg:assets');
    this.portraits=new PortraitRenderer(this.assets);
    this.ui.portraits=this.portraits; // C4: menu operator card portraits
    // Character rigs load in the background (?model=proc|gltf overrides). Web build: they are two
    // separate files requested right after the menu is up (baked thumbnails cover the roster
    // meanwhile); single-file build: inert tags after the bundle. When they arrive the portrait
    // cache is stale — clear it and rebuild the roster so cards switch to the live renders.
    modelAssets.onReady(()=>{this.portraits.cache.clear();this.ui.buildOperators();});
    preloadCharacters({version:VERSION});
    this.audio=new AudioFX();
    if(this.mapOverride&&MAPS[this.mapOverride])this.ui.sel.map=this.mapOverride; // per-map screenshot / verification hook
    this.buildWorldFor(this.ui.sel.map);
    performance.mark('gtg:world');

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
    this.funItems=new FunItems(this,this.scene,this.effects,this.audio,this.ui);
    this.pickups=new Pickups(this,this.scene,this.effects,this.audio,this.ui);
    this.radar=new Radar(document.getElementById('radar'));
    this.koth=new KothMode(this);
    // Squad command layer above the bot brains (src/botai/): plans, lanes, roles per team
    this.squad=new SquadAI(this);
    this.ray=new THREE.Raycaster();
    this.losRay=new THREE.Raycaster();
    // Reusable vector pool for shooting: avoids a new Vector3 per bullet and the resulting GC jitter
    this._sd=new THREE.Vector3();this._sr=new THREE.Vector3();this._su=new THREE.Vector3();
    this._send=new THREE.Vector3();this._muzzle=new THREE.Vector3();this._losV=new THREE.Vector3();this._losDir=new THREE.Vector3();this._pierceO=new THREE.Vector3();this._smokeM=new THREE.Vector3();
    this._shotGroups=[];
    /* Gunfire cue: enemy bots hear the player's shots within their hearing radius (botBrain.js) */
    this.playerShotT=-99;

    this._setupComposer();
    // Prop prewarm (Fun Brawl): render every prop variant once through the SAME composer
    // pipeline the match uses, while the loading screen still covers the canvas. D3D11 drivers
    // build their native shaders per pipeline format, so prewarming through a bare
    // renderer.render() would not cover the match's HalfFloat+MSAA target — first throws still
    // hitched 70-380 ms without this (measured). frustumCulled=false forces every mesh through
    // a real draw call despite being far outside the menu camera's frustum.
    try{
      const unprewarm=prewarmPropModels(this.scene);
      // Also force one shadow pass: the shadow depth programs for the prop materials must be
      // built here too, or the first prop entering the light frustum pays them mid-match.
      this.renderer.shadowMap.needsUpdate=true;
      this.composer.render();
      unprewarm();
    }catch(e){}
    this._setupInput();

    // Menu bindings
    this.ui.bindMenu(()=>{ // map / mode change → rebuild the world preview
      if(this.ui.sel.map!==this.world.mapKey)this.buildWorldFor(this.ui.sel.map);
    });
    this.netLobby=new NetLobby(this,{
      create:()=>this.netMatch.createRoom(),
      join:code=>this.netMatch.joinRoom(code),
      ready:()=>{
        this._netReady=!this._netReady;
        this.netLobby.setMyReady(this._netReady);
        this.netMatch.setReady(this._netReady);
        this.netLobby.render(this.netMatch.room,this.netMatch.me?.id);
      },
      side:team=>this.netMatch.setSide(team),
      start:()=>this.netMatch.start(),
      leave:()=>{this.netMatch.leave();this.ui.showOnly('menu');},
      solo:()=>this._startSoloOnline(),
    });
    this.ui._netLobby=this.netLobby;
    $('m-quality').value=this.quality;
    $('m-quality').addEventListener('change',e=>{
      this.settings.set('quality',e.target.value);location.reload();
    });
    $('m-start').addEventListener('click',()=>{
      this.audio.init();this.audio.resume();this._applyAudioSettings();this.audio.uiClick();this.ui.saveName();
      // Online-only entry: the Friends 5v5 chip opens the lobby and the room carries the mode.
      // Every other mode (waves / dm / koth) is offline and deploys directly, as before.
      if(this.ui.sel.mode==='online'){
        this.ui.showOnly('lobby');
        this.netLobby.show();
        // No room yet: validate the server address here, but only open a socket once the
        // player actually creates or joins a room (the Worker routes on /rooms/{code}/ws).
        this.netMatch.openLobby();
        return;
      }
      this.startGame();
    });
    const pl=$('p-leave');
    if(pl)pl.addEventListener('click',()=>{this.audio.uiClick();this.netMatch.leave();this.toMenu();});
    const orm=$('o-rematch');
    if(orm)orm.addEventListener('click',()=>{this.audio.uiClick();this.netMatch.rematch();});
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

    // Online deep link: ...?room=CODE auto-fills and joins without touching the main menu flow.
    const roomCode=qs.get('room');
    if(roomCode&&ROOM_CODE_RE.test(roomCode.toUpperCase())){
      // A deep link joins whatever mode the room was created with.
      this.ui.refreshMenu&&this.ui.refreshMenu();
      this.ui.saveName();
      if(this.netLobby){
        this.netLobby.el.code.value=roomCode.toUpperCase();
        this.ui.showOnly('lobby');
        this.netLobby.show();
      }
      this.netMatch.openLobby({code:roomCode.toUpperCase()});
    }
    if(this.shotMode==='online')this._shotOnline(false);
    else if(this.shotMode==='online-remotes')this._shotOnline(true);

    if(this.shotMode==='combat')this._shotCombat();
    else if(this.shotMode==='dm')this._shotDm();
    else if(this.shotMode==='over')this._shotOver();
    else if(this.shotMode==='mvp')this._shotMvp();
    else if(this.shotMode==='tutorial')this._shotTutorial();
    else if(this.shotMode==='spectate')this._shotSpectate();
    // Debug suites are dev-only: `?selftest` / `?e2e` write to localStorage (save + best score),
    // so they must not be reachable in a production build.
    if(DEBUG){
      if(this.selftestMode)this.selftest();
      if(this.e2eMode)this.e2e();
      if(this.rosterMode)this._debugRoster();
      if(this.portraitsMode)this._debugPortraits();
    }
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
    // IP probe: non-China IP → English UI. Cache the result and skip it in e2e mode:
    // a failed cross-origin probe is logged by the browser even though the game handles it silently.
    const forcedIPCC=new URLSearchParams(location.search).get('ipcc');
    const applyIPCC=cc=>{
      if(!cc)return;
      store.set('o07_ipcc',cc);
      const want=cc==='CN'?'zh':'en';
      if(lang.cur!==want){ setLang(want); this._refreshLang(); }
    };
    if(forcedIPCC)applyIPCC(forcedIPCC);
    else if(!this.e2eMode&&!store.get('o07_ipcc'))detectIPCountry().then(applyIPCC).catch(()=>{});

    const ver=$('m-ver');
    if(ver)ver.textContent=`v${VERSION}`;
    console.log(`%cGUN TO GUN v${VERSION}`,'color:#f0a860;font-weight:bold','· plays in the browser, no install');
    // Dev capture hook (?shot=/* and ?portraits pages): expose the game instance so browser
    // automation can grab frames (captureFrame) and dump the rig bone map
    if(DEBUG&&(this.shotMode||this.portraitsMode||this.debugExpose)){
      window.__GTG_DEBUG__=this;
      window.__modelAssets=modelAssets;
      window.__squadAI=this.squad; // console: __squadAI.debug()
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
    performance.mark('gtg:ready');
    dismissBoot();
    // Offline mode was removed: revisits use the host's normal HTTP cache. Returning visitors may
    // still have the old service worker installed — unregister it once and drop its cache, otherwise
    // it would keep answering from a stale copy forever (and hide the separate rig files).
    if('serviceWorker' in navigator&&/^https?:$/.test(location.protocol)){
      navigator.serviceWorker.getRegistrations()
        .then(rs=>Promise.all(rs.map(r=>r.unregister().catch(()=>{}))))
        .then(()=>{
          if(typeof caches==='undefined')return;
          return caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('gtg-v')).map(k=>caches.delete(k))));
        })
        .catch(()=>{});
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
    // Fill-rate is the main GPU cost; 2x DPR on phones buys little but doubles every pass.
    const coarse=typeof matchMedia==='function'&&matchMedia('(pointer:coarse)').matches;
    const cap=coarse?1.5:(this.quality==='high'?2:1);
    const pr=Math.min(devicePixelRatio||1,cap)*(this.dynScale||1);
    this.renderer.setPixelRatio(pr);
    this.composer.setPixelRatio(pr);
    // Bloom is low-frequency: render it at half resolution and upsample (~75% less fill).
    const w=Math.max(1,Math.round(innerWidth*pr/2)),h=Math.max(1,Math.round(innerHeight*pr/2));
    this.bloom.setSize(w,h);
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
    this._applyQuality();               // re-apply DPR cap and half-res bloom after a resize
  }

  /* Prewarm the corpse-fade variant: a dying character's materials flip to transparent, and the
     FIRST transparent draw of each pays a driver-side pipeline build — measured 300-470 ms on
     the first bot death of a match. One composer.render() behind the deploy banner with every
     hero material temporarily transparent builds them all; restored on the next line. */
  _prewarmFadeVariants(){
    try{
      const touched=[];
      for(const h of this.heroes.list)for(const m of h.materials||[])
        if(m&&m.isMaterial&&!m.transparent){m.transparent=true;m.opacity=Math.min(m.opacity,.999);touched.push(m);}
      if(!touched.length)return;
      // shadow pass too: the depth programs for the transparent-fade variant are a separate
      // build, and the corpse still casts a shadow while it fades.
      this.renderer.shadowMap.needsUpdate=true;
      this.composer.render();
      for(const m of touched){m.transparent=false;m.opacity=1;}
    }catch(e){}
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

  /* Every arena mode is played online now: dm and koth are team arenas. Endless waves is
     single-player only; a solo-training session (server unreachable) runs it locally. */
  isArena(){ return this.mode==='dm'||this.mode==='koth'||this.mode==='fun'; }
  /* True while a networked match is running (the DO is authoritative). */
  online(){ return !!(this.netMatch&&this.netMatch.active); }

  /* Solo training: the offline fallback. Every real mode is online, but if the room server is
     unreachable this runs the same waves rule set locally (drone AI, no socket, never scored). */
  _startSoloOnline(){
    if(this.netLobby)this.netLobby.hide();
    this._pendingNet=null;
    this._soloTraining=true;
    this.ui.sel.mode='dm'; // solo 5v5 training uses the DM rule set with AI-filled teams
    this.startGame();
  }

  /* ?shot=online / online-remotes: deterministic 5v5 staging for visual verification. */
  _shotOnline(remotes){
    this.ui.sel.mode='dm';
    const roster=remotes?[
      {id:'r1',name:'Frost-2',op:'frost',camo:'default',team:'A'},
      {id:'r2',name:'Raven-2',op:'raven',camo:'default',team:'B'},
      {id:'r3',name:'Swift',op:'swift',camo:'snow',team:'A'},
    ]:[];
    const humans={A:roster.filter(r=>r.team==='A').length,B:roster.filter(r=>r.team==='B').length};
    this._pendingNet={
      mode:'dm', team:'A',faction:'ct',map:this.ui.sel.map,
      rows:[{name:this.playerName,team:'A',kills:0,deaths:0,me:true,id:'me',op:this.ui.sel.operator},
        ...roster.map(r=>({name:r.name,team:r.team,kills:0,deaths:0,me:false,id:r.id,op:r.op}))],
      timer:180,winKills:25,isHost:!remotes,
      setup:{sizes:{A:5,B:5},humans,playerTeam:'A',roster,bots:[],isHost:!remotes,online:true},
    };
    this.mode='dm';
    this.startGame();
    for(const h of this.heroes.list)if(h.netDriven&&h.netBuf)
      h.netBuf.push(performance.now()/1000,{x:h.pos.x,y:h.pos.y,z:h.pos.z,
        yaw:h.yaw,pitch:0,hp:h.hp,alive:true,crouch:false});
  }

  /* ================= State switching ================= */
  startGame(){
    const sel=this.ui.sel;
    this.mode=sel.mode;
    this.playerName=this.ui.playerName;
    // Dynamic-resolution grace: the first seconds of a match are one-off shader compilation,
    // not sustained load — downscaling during the grace only chains into a second rebuild hitch
    // when the scale creeps back (measured; see the M4-P6 note in tick()).
    this._resAt=performance.now()/1000+5;
    this._resCeil=1;this._resOk=0;
    const pm=this.mode==='online'?this._pendingNet:null;
    if(this.mode==='online'&&!pm){this.toMenu();return;}  // bail before any state is cleared
    // The room's mode (waves / koth / dm) decides the rules. Solo training (server unreachable)
    // runs the waves rule set locally with no socket.
    // The room's mode decides online rules; offline the menu chip does (waves / koth / dm).
    const soloTraining=this._soloTraining;
    this.matchMode=soloTraining?'dm':((pm&&pm.mode)||(this.mode==='online'?'dm':this.mode));
    this.mode=this.matchMode;
    this._soloTraining=false;
    this.playerTeam=pm?pm.team:'A';
    const mapKey=pm?pm.map:sel.map;
    if(mapKey!==this.world.mapKey)this.buildWorldFor(mapKey);
    // C5: player operator = roster selection; stats / weapons / first-person arms all follow the operator definition
    let op=byId(sel.operator)||byId(DEFAULT_OP);
    if(pm&&op.faction!==pm.faction){
      const pool=byFaction(pm.faction);
      if(!pool.length){this.toMenu();return;}                 // malformed roster faction
      op=pool[0];                                             // online side is fixed by the server roster
    }
    const hero=op.faction;
    this.playerOperator=op;
    this.ui.shareOp=op;
    this.playerFaction=hero;
    this.playerCamo=sel.camo||this.camoFor(op);
    this.player.god=false;this.invulnT=0;this.dmRespawnT=-1;
    /* No shield at match start: the requirement is RESPAWN protection, and a start shield would
       be player-only asymmetry (bots get theirs on respawn only). Cleared so a shield left over
       from the previous match can never carry into a new one. */
    this.spawnInvulnT=0;
    this._deathHandled=false;
    this.spectate.target=null;this.lastKiller=null;
    this.grenades.reset();this.funItems.reset();this.pickups.clear();
    this.damageBoostT=0;this.damageBoostMul=1;
    this.empT=0;
    this.ui.hideBoss();
    this.ui.hideBoard(); // a board left open by a held TAB must not leak into the next match
    this._tabHeld=false;this._boardAt=0;
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

    this.player.reset(this.matchMode==='waves'?null:findSafeSpawn(this.spawns[this.playerTeam||'A'],this.world.colliders,{jitter:0,radius:this.player.radius,bound:this.player.boundsR}));
    this.weapon.resetAmmo();
    this.enemies.clearAll();
    this.heroes.clear();
    this.comboKills=0;this.comboT=0;
    this.stats={shots:0,hits:0,kills:0,critKills:0,headshots:0,time:0,bestCombo:0};
    this.score=0;this.shake=0;this.dyingT=0;
    this.playerShotT=-99; // a shot from the previous match must not alert the new bots
    this.startTime=performance.now()/1000;

    if(this.matchMode==='waves'){
      // Single-player waves: drones are simulated locally, no networking involved.
      this.ui.setDmMode(false);
      this.dm=null;
      this.koth.end();
      this.waves.reset();
      this.enemies.authoritative=true;
      this.enemies.mirror=false;
      this.ui.banner(t('mode_waves'),t('wave_sub'));
      this.audio.waveStart();
      this.ui.setWave(0);
    }else if(this.matchMode==='fun'){
      /* Fun Brawl: a plain 3v3 team arena (same roster/spawn/respawn rules as offline DM) whose
         score is the prank board — kills and prop hits both feed the same `kills` column. */
      this.ui.setDmMode(true);
      this.waves.state='idle';
      this.dm={scores:new Map(),timer:FUN_MATCH.duration,winKills:FUN_MATCH.win,score:{A:0,B:0}};
      this.dm.scores.set(this.playerName,{name:this.playerName,team:this.playerTeam||'A',kills:0,deaths:0,me:true,op:this.playerOperator,breakdown:funStartBreakdown()});
      this.heroes.setup(this.playerFaction,this.playerName,op.id);
      for(const h of this.heroes.list)
        this.dm.scores.set(h.name,{name:h.name,team:h.team,kills:0,deaths:0,me:false,op:h.def,breakdown:funStartBreakdown()});
      /* Props are the point of the mode: everyone starts with one of each, and the map keeps
         seeding boxes (FunItems.update). Grenades are disabled — the prop keys replace them. */
      this.funItems.reset();
      this.grenades.counts={frag:0,flash:0,smoke:0};
      this.ui.setGrenades&&this.ui.setGrenades(this.grenades.counts);
      this.ui.setFunItems&&this.ui.setFunItems(this.funItems.counts);
      this.ui.setFunItemsActive&&this.ui.setFunItemsActive(true);
      // Tighter reserve than DM: the props, not the rifle, are supposed to carry the match.
      for(const s of this.weapon.state)s.reserve=Math.floor(s.reserve/2);
      this.ui.banner(t('mode_fun'),t('fun_sub',{k:FUN_MATCH.win}));
      this.audio.waveStart();
      this.ui.setScore(0);
      this.ui.setDmScore(0,0,this.dm.timer);
      this._prewarmFadeVariants();   // corpse fade should not cost the first bot death a 300-470 ms pipeline build
    }else if(this.matchMode==='koth'){
      this.ui.setDmMode(true);
      this.waves.state='idle';
      const timer=pm?(pm.timer||240):240;
      this.dm={scores:new Map(),timer,winKills:pm?(pm.winKills||200):0,score:{A:0,B:0}};
      /* Online, pm.rows already carries the local player's roster row (server-sanitised name and
         seat id). Inserting a second, locally-named "me" row produced two me rows whenever the
         server had to rename the callsign (duplicate / sanitised), and the id-less one then sat
         on the board at 0/0 forever because nothing can match it. */
      if(!pm)this.dm.scores.set(this.playerName,{name:this.playerName,team:this.playerTeam||'A',kills:0,deaths:0,me:true,op:this.playerOperator});
      for(const r of (pm&&pm.rows)||[])
        this.dm.scores.set(r.name,{name:r.name,id:r.id,team:r.team,kills:0,deaths:0,
          me:!!r.me,op:byId(r.op)||byId(DEFAULT_OP)});
      if(pm){
        if(this.netMatch)this.netMatch.sendWorld(this.world.mapKey,this.world.losGeo);
        this.heroes.setup(hero,this.playerName,op.id,pm.setup);
        // The host is the only node that evaluates the capture; the DO is the only score writer.
        this.koth.online=true;
        this._uiLock=true;
      }else{
        this.heroes.setup(this.playerFaction,this.playerName,op.id);   // solo training vs AI
        for(const h of this.heroes.list)
          this.dm.scores.set(h.name,{name:h.name,team:h.team,kills:0,deaths:0,me:false,op:h.def});
        this.koth.online=false;
      }
      this.koth.reset();
      this.koth.start();
      this.ui.banner(t('mode_koth'),t('koth_name'));
      this.audio.waveStart();
      this.ui.setScore(0);
    }else{
      this.ui.setDmMode(true);
      this.waves.state='idle';
      const timer=pm?(pm.timer||300):180; // offline bot DM is a 3-minute match; online uses the room timer
      const winKills=pm?(pm.winKills||25):25;
      this.dm={scores:new Map(),timer,winKills,score:{A:0,B:0}};
      // Same rule as the KOTH branch: online rows (incl. my own) come from the server roster.
      if(!pm)this.dm.scores.set(this.playerName,{name:this.playerName,team:this.playerTeam||'A',kills:0,deaths:0,me:true,op:this.playerOperator});
      for(const r of (pm&&pm.rows)||[])
        this.dm.scores.set(r.name,{name:r.name,id:r.id,team:r.team,kills:0,deaths:0,
          me:!!r.me,op:byId(r.op)||byId(DEFAULT_OP)});
      if(pm){
        // Upload the authoritative map geometry so the DO can reject wall shots this match.
        if(this.netMatch)this.netMatch.sendWorld(this.world.mapKey,this.world.losGeo);
        this.heroes.setup(hero,this.playerName,op.id,pm.setup);
        this.ui.banner(t('online_start'),t('online_sub'));
        // 3 s countdown: local input is frozen but remote avatars keep interpolating.
        this._uiLock=true;
      }else{
        // 5v5 solo training (lobby fallback) fields a full AI 5v5; plain offline DM is 3v3.
        const setup=soloTraining?{sizes:{A:5,B:5},humans:{A:0,B:0},playerTeam:'A',roster:[],bots:[],isHost:true,online:false}:undefined;
        this.heroes.setup(this.playerFaction,this.playerName,op.id,setup);
        for(const h of this.heroes.list)
          this.dm.scores.set(h.name,{name:h.name,team:h.team,kills:0,deaths:0,me:false,op:h.def});
        this.ui.banner(t('dm_start'),t('dm_sub',{a:soloTraining?5:3,b:soloTraining?5:3,m:3,k:winKills}));
      }
      this.audio.waveStart();
      this.ui.setScore(0);
    }

    this.state='playing';
    if(this.squad)this.squad.beginMatch();
    this.audio.musicStart('combat');
    this._musicLow=false;
    this.ui.showOnly(null);
    this.ui.setScore(this.score);
    this.ui.setHealth(this.player.health,this.player.maxHealth);
    // The camera only follows the player inside player.update() (active states). While the
    // first-run tutorial pauses simulation, it would otherwise stay on the menu's orbit
    // position — the player "deploys into the sky". Snap it to the spawn eye at once.
    this.camera.position.copy(this.player.eye);
    this.camera.rotation.set(this.player.pitch,this.player.yaw,0,'YXZ');
    this.fallbackAim=false;
    this._requestLock();
    // M3-G7: show onboarding on first entry (offline only — never during a live online match)
    if(!this.online()&&!this.shotMode&&!this.e2eMode&&!store.get('o07_tutorial_done')){
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
    if(this.online()){this.netMenu();return;}
    this.state='paused';
    this.input.firing=false;this.input.ads=false;
    this._mouseFire=false;this._mouseAds=false; // a mouse-up lost during pause must not leave fire stuck on after resuming
    /* The sim is frozen but the gun stays on screen (main.js keeps the viewmodel visible while
       paused), so anything weapon.update() would have decayed has to be cleared by hand — most
       visibly a muzzle flash burning in a still frame if ESC lands right after a shot. The reload
       and switch state are deliberately kept: pausing mid-reload resumes that reload. */
    this.weapon.clearTransientFx();
    this.audio.musicSet(.2);
    this._tabHeld=false;this._boardAt=0; // a held TAB must not pop the board back after resume
    this.ui.hideBoard();
    this.ui.showOnly('pause');
    if(document.pointerLockElement)document.exitPointerLock();
  }
  /* Online ESC: freeze only local input. The world, bots and damage keep running server-side,
     so the player cannot pause the match for everyone else. */
  netMenu(){
    this.state='paused';
    this._uiLock=true;
    this.input.firing=false;this.input.ads=false;
    this._mouseFire=false;this._mouseAds=false;
    this.keys.clear();
    this.weapon.clearTransientFx();   // same frozen-frame muzzle flash guard as pause()
    this.audio.musicSet(.2);
    this.ui.showOnly('pause');
    this.ui.setNetMode(true);
    if(document.pointerLockElement)document.exitPointerLock();
  }
  resume(){
    this.state='playing';
    this._uiLock=false;
    this.ui.setNetMode(false);
    this.audio.musicSet(.7);
    this.ui.showOnly(null);
    this._requestLock();
  }
  toMenu(){
    if(this.squad)this.squad.endMatch();
    if(this.netMatch&&this.netMatch.phase!==PHASE.IDLE)this.netMatch.leave();
    this._uiLock=false;
    this.ui.setNetMode(false);
    if(this.netLobby)this.netLobby.hide();
    this.enemies.clearAll();
    this.heroes.clear();
    this.grenades.clear();
    this.funItems.clear();
    this.pickups.clear();
    this.koth.end();
    this.state='menu';
    this.audio.musicStart('menu');
    this.audio.musicSet(1);
    this.ui.hideBoard();
    this.ui.showOnly('menu');
    this.ui.showBest(parseInt(localStorage.getItem('o07_best')||'0'));
    this._menuDrones();
  }

  _menuDrones(){
    this.enemies.spawn('WASP',new THREE.Vector3(24,3.2,-18),{entering:false,decor:true});
    this.enemies.spawn('REAPER',new THREE.Vector3(-26,3.8,10),{entering:false,decor:true});
    this.enemies.spawn('WASP',new THREE.Vector3(-10,2.6,-28),{entering:false,decor:true});
  }

  /* Rebuild GPU-side state after a WebGL context restore without losing the match. */
  rebuildAfterContextRestore(){
    this.composer?.dispose?.();
    this.bloom?.dispose?.();
    this._setupComposer();
    this._applyQuality();
    this.renderer.compile(this.scene,this.camera);
    this.renderer.setAnimationLoop(()=>{
      try{this.tick();}
      catch(err){
        this.renderer.setAnimationLoop(null);
        console.error(err);
        this.ui.debug('ERR '+(err&&err.message||err),true);
      }
    });
    this.ui.debug('WebGL context restored',true);
  }

  /* Spawn safety: jittered respawn points must not overlap any collider. */
  _spawnClear(){
    const p=this.player.pos,r=this.player.radius+.05;
    for(const c of this.world.colliders){
      if(!verticalBodyOverlap(p.y,this.player.crouching?1.2:1.8,c))continue;
      if(circleOverlapsCollider(p.x,p.z,r,c))return false;
    }
    return true;
  }

  /* ================= Shooting ================= */
  _raySphere(origin,dir,c,r){
    const oc=_rsO.copy(origin).sub(c);
    const b=oc.dot(dir);
    const cc=oc.dot(oc)-r*r;
    if(cc<=0)return 0;                 // ray origin inside the sphere: point-blank hit
    const disc=b*b-cc;
    if(disc<0)return null;
    const t=-b-Math.sqrt(disc);
    return t>0?t:null;
  }

  fire(spread){
    // Hard guard: dead players / post-match input must never produce a shot, even if a
    // direct caller (touch, gamepad, test hook) bypasses weapon.update().
    if(!this.player || !this.player.alive)return;
    if(this.player.slipT>0||this.player.disarmT>0)return;  // slipped / disarmed: no shot
    this.stats.shots++;
    const killerId=this.netMatch&&this.netMatch.active?this.netMatch.me?.id:null;
    const cam=this.camera;
    const def=this.weapon.def;
    this.playerShotT=this.time;
    if(this.squad)this.squad.onPlayerShot();
    // Industry standard: the shot uses the authoritative yaw/pitch at the moment of firing, not last frame's render camera (fast flicks neither lag nor drift)
    const pl=this.player;
    const kick=this.weapon.camKick||0, kickY=this.weapon.camKickYaw||0;
    const pitch=Math.max(-1.553,Math.min(1.553,pl.pitch+kick));
    const yaw=pl.yaw+kickY;
    const sy=Math.sin(yaw),cy=Math.cos(yaw),sp=Math.sin(pitch),cp=Math.cos(pitch);
    const dir=this._sd.set(-sy*cp,sp,-cy*cp);

    const right=this._sr.set(cy,0,-sy);
    const up=this._su.set(sp*sy,cp,sp*cy);
    const a=Math.random()*Math.PI*2,r=Math.sqrt(Math.random())*spread;
    dir.addScaledVector(right,Math.cos(a)*r).addScaledVector(up,Math.sin(a)*r).normalize();

    // 1. Statics
    this.ray.set(cam.position,dir);this.ray.far=120;   // arena radius is 56 m; 400 m only wasted work
    const sHits=this.ray.intersectObjects(this.world.shootStatics,false);
    let bestT=sHits.length?sHits[0].distance:120;
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
      const head=bestHeroPart==='head';
      const dmg=def.dmg*(head?this.playerCritMul():1)*this.playerDamageMul();
      const hp=bestHero.takeDamage(dmg,this.playerName,head,killerId);
      /* A locally simulated bot returns -1 only when the spawn shield absorbed the shot, so the
         hit marker / hit sound / accuracy stat must not fire. Net-driven proxies also return -1
         (their hit is merely a request) — those still count as a hit. */
      const absorbed=hp===-1&&!bestHero.netDriven;
      if(!absorbed){
        this.stats.hits++;
        this.audio.hit(head);
        this.ui.hitmark(head);
      }
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
    if(this.upgrades&&this.upgrades.pierce>0&&(bestEnemy||bestHero)&&bestT<119){
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
      if(secondHero)secondHero.takeDamage(pd,this.playerName,false,killerId);
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
        if(d<def.blastR)h.takeDamage(def.blastDmg*(1-d/def.blastR),this.playerName,false,killerId);
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
      this.pickups.drop(e.pos,type);
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
  onHeroKill(killerName,victimHero,headshot=false,fromId=null){
    if(this.netMatch&&this.netMatch.active){
      // The DO owns online scoring; the host reports bot deaths so all clients agree.
      // fromId can be an id *object* ({id,name}); the DO needs the bare id string.
      const kid=(fromId&&typeof fromId==='object')?fromId.id:fromId;
      this.netMatch.reportBotDeath(victimHero,kid||this.netMatch.me?.id);
      // Weapon drops online ride on the DO's S.KILL frame (drop:), so every client — this one
      // included — renders exactly one crate out of _onKill. Nothing to do here.
      return;
    }
    if(!this.dm||!this.isArena())return;
    if(this.squad)this.squad.onKill(killerName,victimHero);
    /* Fun Brawl: kills and prop hits all pay per funScoreEvent; each lands in its own scoring
       category (see funApplyScore) so the results screen can show where points came from. */
    if(this.matchMode==='fun'){
      const kf=this.dm.scores.get(killerName);
      funApplyScore(kf,'kill');
    }else{
      const k=this.dm.scores.get(killerName);
      if(k)k.kills+=1;
    }
    const v=this.dm.scores.get(victimHero.name);
    if(v)v.deaths++;
    const mine=killerName===this.playerName;
    this.ui.killFeed(killerName,victimHero.name,t('kill_verb'),mine);
    // Arena rule: a defeated opponent drops their primary (weapon crate + bullets).
    this.dropWeaponFrom(victimHero);
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

  /* Single entry point for Fun Brawl scoring (funItems.js calls this for every prop hit).
     Offline it writes the prank board directly; online a mode would route the same event through
     the DO, so the signature already carries the neutral shape {kind, owner, victim, pos}. */
  onFunEvent(ev){
    if(!ev||this.matchMode!=='fun'||!this.dm||this.netMatch&&this.netMatch.active)return 0;
    const by=ev.owner&&ev.owner.name;
    const row=by&&this.dm.scores.get(by);
    if(!row)return 0;
    /* One call both bumps the category bucket and the row total; unknown kinds award nothing. */
    const pts=funApplyScore(row,ev.kind);
    /* Feed the kill feed so the whole lobby can see who got pranked. */
    if(pts&&ev.victim&&ev.victim.name&&ev.victim.name!==by){
      const verb=t('fun_verb_'+ev.kind);
      this.ui.killFeed(by,ev.victim.name,verb,by===this.playerName);
    }
    this._checkDmWin();
    return pts;
  }

  /* Arena kill drop (dm / koth / online, NOT waves): a defeated opponent drops their primary.
     Thin forwarders — the logic lives on Pickups so it is unit-testable without a Game. */
  dropWeaponFrom(victimHero){
    if(this.matchMode==='waves')return;
    const rifleId=victimHero&&victimHero.def&&victimHero.def.rifle;
    if(!rifleId||!this.pickups)return;
    this.pickups.addDrop(victimHero.pos,rifleId);
  }

  collectWeaponDrop(rifleId){
    if(this.pickups)this.pickups.collectWeapon(rifleId);
  }
  /* Single entry point for all incoming damage. `from = {id,name,pos}`; older callers pass a name. */
  damagePlayer(dmg,from,head=false,weapon){
    if(this.player.god||this.invulnT>0||this.spawnInvulnT>0||!this.player.alive)return;
    const fromName=typeof from==='string'?from:from?.name;
    const fromPos=typeof from==='string'?(head&&typeof head==='object'?head:null):from?.pos;
    const fromId=typeof from==='string'?null:from?.id;
    this.player.damage(dmg,this.time);
    this.ui.damageFlash(.55);
    this.shake=Math.max(this.shake,.1);
    this.audio.hurt();
    this._showDamageDirection(fromPos);
    if(fromName||fromId){
      const killer=(fromId&&this.heroes.byNetId(fromId))||this.heroes.list.find(h=>h.name===fromName);
      if(killer)this.lastKiller=killer;
    }
    if(this.player.health<=0){
      if(this.netMatch&&this.netMatch.active){
        this.netMatch.reportLocalDeath(fromId||'',weapon||this.weapon.def?.id,head);
      }else if(this.isArena()){
        // Offline/local arena: the human is a full participant, so the death goes on the board and
        // the killing bot is credited exactly once (the caller's _deathHandled guard prevents repeats).
        const me=this.dm&&this.dm.scores.get(this.playerName);
        if(me)me.deaths++;
        if(fromName){
          const k=this.dm&&this.dm.scores.get(fromName);
          if(this.matchMode==='fun')funApplyScore(k,'kill');
          else if(k)k.kills+=1;
          this.ui.killFeed(fromName,this.playerName,t('kill_verb'),false);
          if(this.squad)this.squad.onKill(fromName,'player');
          this._checkDmWin();
        }
      }
      const killer=fromName?this.heroes.list.find(h=>h.name===fromName):null;
      if(killer&&killer.alive)this.spectate={target:killer,t:2.5};
      /* Clear the viewmodel the moment HP hits zero — here, not only in tick's death branch: the
         shot that killed us may have lit the muzzle flash microseconds earlier, and any code path
         (online death report, a test hook) has to leave the same clean state behind. Idempotent. */
      this.weapon.onDeath();
    }
  }
  damagePlayerFromBot(dmg,fromName,fromPos){ return this.damagePlayer(dmg,{name:fromName,pos:fromPos}); }
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
    /* TAB board for every mode: team table in DM/KOTH, a compact run summary in waves.
       KOTH adds the capture points, which are the actual win condition in that mode. */
    if(this.mode==='waves'){
      this.ui.scoreboard([],{},{
        title:t('sb_run'),
        lines:[
          [t('hud_wave'),String(this.waves.n).padStart(2,'0')],
          [t('hud_left'),String(this.waves.remaining())],
          [t('hud_score'),String(this.score)],
          [t('over_kills'),String(this.stats.kills)],
        ],
      });
      return;
    }
    if(!this.dm){this.ui.hideBoard();return;}
    const rows=[...this.dm.scores.values()]
      .sort((a,b)=>b.kills-a.kills||a.deaths-b.deaths);
    const meta={title:this.mode==='koth'?t('mode_koth'):this.mode==='fun'?t('sb_fun'):t('sb_title')};
    if(this.mode==='koth'&&this.koth){
      /* Online the DO owns the capture score (s:score → dm.score) and KothMode.update returns
         before writing this.koth.score, so reading it here showed a permanent 0 : 0. */
      const ks=(this.koth.online&&this.dm&&this.dm.score)?this.dm.score:this.koth.score;
      meta.lines=[
        [t('koth_a'),Math.floor(ks.A||0)],
        [t('koth_b'),Math.floor(ks.B||0)],
        [t('koth_name'),Math.round((this.koth.capture+1)/2*100)+'%'],
      ];
    }
    this.ui.scoreboard(rows,this._factionLabels(),meta);
  }
  _factionLabels(){
    const ct=t('faction_ct'),tt=t('faction_t');
    if(this.online())return {A:ct,B:tt}; // online sides are fixed: A = Nova, B = Rogue
    return this.playerFaction==='ct'?{A:ct,B:tt}:{A:tt,B:ct};
  }
  _checkDmWin(){
    if(this.netMatch&&this.netMatch.active)return; // the DO decides the winner online
    // Team deathmatch and Fun Brawl only. KOTH is decided by capture points (KothMode offline /
    // the room server online) — its kill line is 0, so running the kill check there ended the
    // match on first blood.
    if(this.matchMode!=='dm'&&this.matchMode!=='fun')return;
    let a=0,b=0;
    for(const s of this.dm.scores.values()){
      if(s.team==='A')a+=s.kills;else b+=s.kills;
    }
    this.ui.setDmScore(a,b,this.dm.timer);
    if(a>=this.dm.winKills||b>=this.dm.winKills)this._endDm(a,b);
  }
  /* Fun Brawl results: the per-category scoring breakdown (kills / banana / magnet / spring /
     water). `row.kills` is the grand total the match was decided on; this table shows WHERE the
     points came from, and the last column re-sums the categories as a consistency check. */
  _funBreakdownBoard(){
    const CAT_KEY={kill:'over_kills',banana:'fun_banana',magnet:'fun_magnet',spring:'fun_spring',water:'fun_water'};
    const rows=[...this.dm.scores.values()].sort((x,y)=>y.kills-x.kills);
    const head=`<tr><th>${t('sb_role')}</th>${FUN_CATEGORIES.map(c=>`<th>${t(CAT_KEY[c])}</th>`).join('')}<th>${t('sb_total')}</th></tr>`;
    const body=rows.map(r=>{
      const b=r.breakdown||{};
      let sum=0;
      const cells=FUN_CATEGORIES.map(c=>{const v=b[c]||0;sum+=v;return `<td>${v}</td>`}).join('');
      return `<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td>${cells}<td class="fb-total"><b>${sum}</b></td></tr>`;
    }).join('');
    return `<div class="fun-breakdown"><div class="fb-title">${t('sb_breakdown')}</div><table>${head}${body}</table></div>`;
  }

  _endDm(a,b){
    if(this.state==='over')return;
    this.squad.endMatch();this.state='over';
    const win=a>b;
    const lab=this._factionLabels();
    const rows=[...this.dm.scores.values()].sort((x,y)=>y.kills-x.kills)
      .map(r=>`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td><td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?lab.A:lab.B}</span></td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
    const mvpRow=[...this.dm.scores.values()].sort((a,b)=>b.kills-a.kills)[0];
    const mvp=mvpRow?{name:mvpRow.name,op:mvpRow.op||this.playerOperator,kills:mvpRow.kills,deaths:mvpRow.deaths}:null;
    const best=parseInt(store.get('o07_best','0'))||0;
    if(this.score>best)store.set('o07_best',this.score);
    this.audio.gameOver();
    this.ui.hideBoard();
    const award=this._awardProgress(); // award before the results screen so LV/XP is current
    const board=`<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>${rows}</table>`+
      (this.matchMode==='fun'?this._funBreakdownBoard():'');
    this.ui.showOver({
      title:win?t('win'):t('lose'),
      win,kicker:t(this.matchMode==='fun'?'fun_over_kicker':'dm_over_kicker'),
      stats:{...this.stats,waveLabel:t('dur_label'),wave:t('dur_fmt',{m:Math.floor(this.stats.time/60),s:Math.floor(this.stats.time%60)}),score:this.score,best:Math.max(best,this.score),mvp},
      board,
    });
    if(document.pointerLockElement)document.exitPointerLock();
    this._announceProgress(award);
  }

  _resultBoard(rows,labels){
    return `<table><tr><th>${t('sb_role')}</th><th>${t('sb_faction')}</th><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr>`+
      rows.map(r=>`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td>`+
        `<td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?labels.A:labels.B}</span></td>`+
        `<td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('')+'</table>';
  }
  /* Online result is rendered from the DO's s:end payload. No local best score, no leaderboard. */
  _endOnline(m={}){
    if(this.state==='over')return;
    this.squad.endMatch();this.state='over';
    this._uiLock=false;
    const score=m.score||this.dm?.score||{A:0,B:0};
    const win=m.win===this.playerTeam;
    const raw=(m.rows&&m.rows.length)?m.rows:[...(this.dm?.scores?.values()||[])];
    const rows=raw.map(r=>({
      name:r.name,team:r.team,kills:(r.kills|0)||0,deaths:(r.deaths|0)||0,
      me:r.id===this.netMatch?.me?.id||!!r.me,op:r.op,
    })).sort((x,y)=>y.kills-x.kills);
    const top=rows[0];
    const mvp=top?{name:top.name,op:byId(top.op)||this.playerOperator,kills:top.kills,deaths:top.deaths}:null;
    this.ui.setDmScore(score.A,score.B,0);
    this.audio.gameOver();
    const award=this._awardProgress({score:score.A+score.B,skipBest:true});
    this.ui.showOver({
      title:win?t('win'):t('lose'),win,kicker:t('online_over_kicker'),
      stats:{...this.stats,waveLabel:t('dur_label'),
        wave:t('dur_fmt',{m:Math.floor(this.stats.time/60),s:Math.floor(this.stats.time%60)}),
        // Show MY side's score: the B-team used to be shown the opponent's A score here.
        score:score[this.playerTeam]??score.A??0,best:0,mvp},
      board:this._resultBoard(rows,this._factionLabels()),
    });
    const restart=$('o-restart'),rematch=$('o-rematch'),share=$('o-share');
    if(restart)restart.classList.add('hidden');
    if(share)share.classList.add('hidden');
    if(rematch)rematch.classList.toggle('hidden',!this.netMatch?.isHost);
    if(document.pointerLockElement)document.exitPointerLock();
    this._announceProgress(award);
  }

  /* M4-P5: award XP / progression at the end of a match */
  _awardProgress(opts){
    const o=opts&&typeof opts==='object'?opts:{};
    const score=o.score??this.score;
    const op=this.playerOperator||byId(DEFAULT_OP);
    const r=this.save.award({
      kills:this.stats.kills,wave:this.mode==='waves'?this.waves.n:0,
      headshots:this.stats.headshots||0,
      score,time:this.stats.time,opId:op.id,
    });
    if(!o.skipBest)this.ui.showBest(this.save.data.stats.bestScore);
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
    this.squad.endMatch();this.state='over';
    this.koth.end();
    const lab=this._factionLabels();
    const rows=[...this.dm.scores.values()].sort((x,y)=>y.kills-x.kills)
      .map(r=>`<tr class="${r.me?'me':''}"><td>${escHTML(r.name)}</td><td><span class="${r.team==='A'?'tA':'tB'}">${r.team==='A'?lab.A:lab.B}</span></td><td>${r.kills}</td><td>${r.deaths}</td></tr>`).join('');
    const mvpRow=[...this.dm.scores.values()].sort((a,b)=>b.kills-a.kills)[0];
    const mvp=mvpRow?{name:mvpRow.name,op:mvpRow.op||this.playerOperator,kills:mvpRow.kills,deaths:mvpRow.deaths}:null;
    const best=parseInt(store.get('o07_best','0'))||0;
    if(this.score>best)store.set('o07_best',this.score);
    this.audio.gameOver();
    this.ui.hideBoard();
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
    // A case that drives the simulation itself (and awaits between chunks) holds the loop, so no
    // frame lands in one of its awaits and moves the camera / the clock under its assertions.
    if(this._e2eHold)return;
    const dtRaw=Math.min(.05,this.clock.getDelta());
    let dt=dtRaw;
    // Hitch monitor: slow frame (>25ms) count and longest frame time
    this.perf.frames++;
    if(dtRaw>.025)this.perf.slow++;
    if(dtRaw>this.perf.maxDt)this.perf.maxDt=dtRaw;
    if(this.perfMode&&this.perf.frames%180===0)
      console.log(`[PERF] frames=${this.perf.frames} slow=${this.perf.slow} max=${(this.perf.maxDt*1000).toFixed(1)}ms calls=${this.renderer.info.render.calls} tris=${this.renderer.info.render.triangles}`);
    // M4-P6: dynamic resolution (every 60 frames)
    /* Hysteresis + minimum dwell + match-start grace. The old policy flipped the scale on a
       single window: a ratio hovering between the .2 down and .05 up thresholds ping-ponged
       0.70↔0.80 every ~2 s, and EVERY flip rebuilds the composer render targets (MSAA buffers
       included) — a measured 60-100 ms hitch each time, 20+ times per match, with the flip's
       own hitch causing the next slow window. Now a change needs a decisively crossed
       threshold (> .2 down / < .04 up) AND ≥ 4 s since the last one, and the first 5 s after a
       deploy never rescale (first-frame shader compilation is a one-off, not sustained load).
       Small steps are deliberate: on iGPUs the sustainable ratio often sits at 0.80-0.85, and
       big 0.7↔1.0 swings produced long stretches of >25 ms frames at 1.0 (measured). */
    if(this.perf.frames-this._perfAt>=60){
      const ratio=this.perf.slow/Math.max(1,this.perf.frames-this._perfAt);
      this.perf.slow=0;this._perfAt=this.perf.frames;
      const nowS=performance.now()/1000;
      this._resOk=ratio<.04?(this._resOk||0)+1:0;
      /* Ceiling memory: a scale that just proved too heavy may not be climbed straight back
         into, or the scale oscillates across it forever (measured: 0.70↔0.80 every ~8 s on an
         iGPU whose sustainable ratio sits just below 0.75). A long comfortable stretch relaxes
         the ceiling one step at a time, so a genuinely lighter scene can still regain levels. */
      if(this._resOk>=6&&(this._resCeil??1)<1)this._resCeil=Math.min(1,(this._resCeil||1)+.05);
      let next=this.dynScale;
      if(ratio>.2)next=Math.max(.7,this.dynScale-.1);
      else if(this._resOk>=2)next=Math.min(this._resCeil??1,this.dynScale+.05);
      if(next!==this.dynScale){
        const dwell=next<this.dynScale?4:6;
        if(nowS-(this._resAt||0)>=dwell){
          if(next<this.dynScale)this._resCeil=Math.min(this._resCeil??1,this.dynScale-.05);
          this.dynScale=next;this._resAt=nowS;this._applyQuality();
        }
      }
    }
    this.inputMgr&&this.inputMgr.update(dtRaw);
    // The network session runs even while the local player is in the online pause menu.
    if(this.netMatch&&this.netMatch.active){
      this.netMatch.tick(dt);
      const remain=this.netMatch.startAt/1000-this.netMatch.clock.serverNow(performance.now());
      if(remain>0)this._uiLock=true;
      else if(this._uiLock&&this.state==='playing')this._uiLock=false;
    }
    if(this.state==='dying'){
      dt*=.3;
      this.dyingT-=dtRaw;
      if(this.dyingT<=0){
        this.squad.endMatch();this.state='over';
        // Waves is single-player: one death ends the run and shows the results screen.
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
      /* A held TAB keeps the board live: without this the panel froze at the instant it was
         opened, so kills and the KOTH score never appeared until the player re-pressed TAB.
         ~4 Hz is fast enough to read and cheap enough for the DOM. */
      if(this._tabHeld&&(this._boardAt=(this._boardAt||0)+dt)>=.25){this._boardAt=0;this._showBoard();}
      // Deathmatch respawn
      if(this.isArena()&&this.dmRespawnT>0){
        this.dmRespawnT-=dtRaw;
        if(this.dmRespawnT<=0){
          this.dmRespawnT=-1;
          const base=this.spawns[this.playerTeam]||new THREE.Vector3(0,0,24);
          // Sample a genuinely free point instead of spawning inside geometry and popping out.
          this.player.pos.copy(findSafeSpawn(base,this.world.colliders,{jitter:3,radius:this.player.radius,bound:this.player.boundsR}));
          this.player.yaw=0;this.player.pitch=0;
          this.player.vel.set(0,0,0);
          this.player.velY=0;this.player.grounded=true;this.player.airborne=false;
          this.player.slipT=0;this.player.slowT=0;this.player.disarmT=0; // no stale prop status carries over
          this.player.alive=true;
          this._deathHandled=false;             // allow the next death to run side-effects once
          this.player.health=this.player.maxHealth;
          /* Respawn protection: 3 s of spawn invulnerability (requirement), tracked on its own
             timer instead of the debug `god` flag so a screenshot check cannot be confused with
             a spawn shield and the HUD can show a countdown. `god` is no longer touched here. */
          this.spawnInvulnT=SPAWN_INVULN;
          this.weapon.onRespawn();       // a queued semi shot must not fire itself after respawn
          this.audio.respawn();
          /* No second full-screen white flash: death already flashed, and flashing again on the
             frame the player regains control is a needless full-screen composite at the exact
             moment they are trying to read the battlefield again. */
          /* The lock was held through the spectate window (see the death branch), so normally
             there is nothing to do here. Only re-request when it was actually lost meanwhile. */
          if(!document.pointerLockElement&&!this.fallbackAim)this._requestLock();
        }
      }
      if(this.invulnT>0){
        this.invulnT-=dt;
        if(this.invulnT<=0)this.player.god=false;
      }
      // Spawn shield: a separate 3 s window that survives even when `god`/`invulnT` are scripted.
      // Online holds a 3 s pre-match countdown with _uiLock set — the shield must not burn away
      // inside it, or it is already 0 by the time control is handed to the player.
      if(this.spawnInvulnT>0&&!this._uiLock)this.spawnInvulnT=Math.max(0,this.spawnInvulnT-dt);

      if(!this._uiLock){
        if(this.player.alive){
          this._fallbackEdgeRotate(dt);
          this.player.update(dt,this.input,this.keys,this.time,this.audio);
        }
        /* The weapon keeps updating while dead: its muzzle flash, shell casings, recoil kick and
           ADS zoom are all decayed inside weapon.update(), so skipping the call froze them on the
           death frame (a permanently lit muzzle flash was the visible symptom). weapon.update()
           has its own dead branch that only settles the viewmodel — it can never fire, reload or
           complete a swap for a corpse. */
        this.weapon.update(dt,this.input,this.player,this.camera,this.time,d=>this.fire(d));
      }

      if(this.isArena()){
        this._losLeft=16;                      // AI LOS budget for this frame (firing + cover sampling)
        if(this.squad)this.squad.update(dt);  // orders first, so the brains can act on them this frame
        this.heroes.update(dt,this.time,(a,b)=>this._losCapped(a,b));
        if(this.mode==='koth'){
          const online=this.netMatch&&this.netMatch.active;
          this.koth.update(dt);
          // Only the host evaluates the capture; the DO adds the points so both clients agree.
          if(online&&this.netMatch.isHost&&this.koth.lastTickTeam)
            this.netMatch.reportPoint(this.koth.lastTickTeam,1);
        }
        if(this.dm&&this.state==='playing'){
          const online=this.netMatch&&this.netMatch.active;
          if(!online){
            this.dm.timer-=dt;
            if(this.dm.timer<=0){
              let a=0,b=0;
              for(const s of this.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
              if(this.mode==='dm')this._endDm(a,b);
              else if(this.mode==='fun'){
                // Fun Brawl: the prank board decides, same end screen as DM.
                this._checkDmWin();
                if(this.state!=='over')this._endDm(a,b);
              }
              else{
                const win=this.koth.score.A>=this.koth.score.B;
                this._endMode(win);
              }
            }
          }else this.dm.timer=this.netMatch.left;   // read-only mirror for the HUD (netMatch owns it)
          let a=0,b=0;
          for(const s of this.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
          this.ui.setDmScore(a,b,this.dm.timer);
        }
      }else{
        // Single-player waves: drones are simulated and drawn locally.
        this._losLeft=16;
        if(this.squad)this.squad.update(dt);
        this.heroes.update(dt,this.time,(a,b)=>this._losCapped(a,b));   // teammate avatars
        this.enemies.update(dt,this.player,this.world.colliders,this.time,this);
        this.waves.update(dt);
        const boss=this.enemies.list.find(e=>e.boss);
        if(boss)this.ui.setBoss(boss.hp/boss.maxHp,t('boss_name'));
        else this.ui.hideBoss();
      }
      // Bot separation pushes the player after player.update() has already resolved collisions.
      // Re-run the player collision once so a bot cannot shove them into a wall for the frame.
      if(this.player.alive)this.player._collide(this.world.colliders);

      if(this.comboT>0){this.comboT-=dt;if(this.comboT<=0)this.comboKills=0;}

      // Recoil + screen shake
      /* Recoil only applies while alive. It is decayed inside weapon.update(), but adding a stale
         nonzero value to the camera every frame would ratchet the view up/aside for as long as the
         corpse sits there — and it is dead-obvious when the spectate camera has no target. */
      let kick=this.player.alive?this.weapon.camKick:0;
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
      if(this.player.alive)this.camera.rotation.y+=this.weapon.camKickYaw; // recoil pattern horizontal drift
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
      this.ui.hint(this.weapon.st.ammo<=8&&!this.weapon.reloading&&this.weapon.st.reserve>0?t('hint_reload'):
        (!document.pointerLockElement&&!this.fallbackAim?t('hint_lock'):''));
      if(this.player.alive===false&&!this._deathHandled&&this.state==='playing'){
        this._deathHandled=true;          // death side-effects must not re-run every frame
        this.input.firing=false;this.input.ads=false;
        this._mouseFire=false;this._mouseAds=false;
        /* Clean the viewmodel on this exact frame rather than waiting for the next weapon.update():
           the shot that killed us may have lit the muzzle flash microseconds ago in the same tick. */
        this.weapon.onDeath();
        if(this.isArena()){
          this.dmRespawnT=2.5;
          if(this.lastKiller&&this.lastKiller.alive)this.spectate={target:this.lastKiller,t:2.5};
          this.ui.deathFlash();
          this.audio.hurt();
          /* Pointer lock is deliberately NOT released here. Dropping it on death and asking for it
             back 2.5 s later is a lock request without a fresh user gesture: the browser may reject
             it, and _requestLock's polynomial fallback then leaves the player unable to turn for
             1.4-2.3 s — which reads as "respawn froze". Keeping the lock through the spectate window
             also matches an FPS convention: the camera keeps following the killer under mouse look. */
        }else{
          // Waves is single-player: one death ends the run.
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
        if(t&&t.alive&&this.isArena()){
          const want=this._specWant.set(t.pos.x,t.pos.y+2.2,t.pos.z-3.5);
          const from=this._specFrom.set(t.pos.x,t.pos.y+1.2,t.pos.z);
          const dir=this._specDir.copy(want).sub(from);
          const len=dir.length();
          /* The wall test only needs to run on alternate frames: the spectate camera tracks a bot
             that moves a few centimetres per frame, so a one-frame-old pullback is invisible, and
             this raycast was ~2 ms against the full static list every single frame while dead.
             losStatics (no sky sphere, no distant scenery) is the list built for exactly this. */
          if(len>.01&&(this._frame&1)===1){
            dir.divideScalar(len);
            this.losRay.set(from,dir);this.losRay.far=len;
            const hits=this.losRay.intersectObjects(this.world.losStatics||this.world.shootStatics,false);
            this._specClamped=!!hits.length;
            if(this._specClamped)this._specWantHit=Math.max(.4,hits[0].distance-.3);
          }
          if(this._specClamped&&this._specWantHit!=null){
            const d2=this._specDir.copy(want).sub(from);const l2=d2.length();
            if(l2>.01)want.copy(from).addScaledVector(d2.divideScalar(l2),this._specWantHit);
          }
          this.camera.position.copy(want);
          this.camera.lookAt(from);
          s.t-=dtRaw;
          if(s.t<=0)s.target=null;
        }else s.target=null;
        /* Leaving spectate drops the cached clamp so the next death starts from a clean test. */
        if(!s.target){this._specClamped=false;this._specWantHit=null;}
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
    // Grenades damage and pickups attract: neither may advance while the sim is suspended
    // (pause / upgrade / tutorial / result) or a stray grenade could end the match from the
    // pause menu. Effects keep running (pure visuals).
    if(this.state==='playing'){
      this.grenades.update(dt);
      /* Fun Brawl props only exist in that mode: the update is gated so no other mode can ever
         have a prop ticking, and `reset()` leaves the list empty the moment the mode changes. */
      if(this.matchMode==='fun')this.funItems.update(dt);
      this.pickups.update(dt,this.player);
    }
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
    /* A dead player has no viewmodel: the spectate camera looks at the killer through the main
       camera, so a gun+arms pinned to the screen would float in someone else's view. */
    this.weapon.group.visible=this.player.alive&&!scoping;
    const viewFov=75+(58-75)*this.weapon.adsAmt;
    if(Math.abs(viewFov-(this._lastViewFov??-1))>.01){
      this._lastViewFov=viewFov;
      this.viewCam.fov=viewFov;
      this.viewCam.updateProjectionMatrix();   // only recompute when ADS actually changes
    }
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
    // Accepts plain {x,y,z} as well as Vector3: the bot cover code passes cheap object
    // literals, and this is called many times per second by eight bots.
    const dir=this._losV.set((b.x||0)-(a.x||0),(b.y||0)-(a.y||0),(b.z||0)-(a.z||0));

    const len=dir.length();
    if(len<.5)return true;
    this.losRay.set(a,dir.multiplyScalar(1/len));this.losRay.far=len-.3;
    const hits=this.losRay.intersectObjects(this.world.losStatics||this.world.shootStatics,false);
    return hits.length===0;
  }
  /* Budget AI line-of-sight rays so a room full of bots cannot create a ray storm.
     Over-budget frames optimistically return "clear"; the next frame re-checks. */
  _losCapped(a,b){
    // Budget is conservative: when exhausted the bot assumes the shot is blocked (holds fire)
    // rather than assuming it is clear, so a tight budget can never produce wall-bang shots.
    if(this._losLeft<=0)return false;
    this._losLeft--;
    return this._los(a,b);
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
  debugSpawnPickup(type){return this.pickups.drop(this.player.pos,type);}

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
    this.spawnInvulnT=0;   // this shot force-kills on frame 0: the opening spawn shield must not absorb it
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
      const t0=performance.now();
      try{await fn();results.push({name,ok:true,ms:Math.round(performance.now()-t0)});pass++;}
      catch(err){results.push({name,ok:false,ms:Math.round(performance.now()-t0),err:err&&err.message||String(err)});}
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
      assert(ids.length===5,'deathmatch should have 5 bots (3v3 with the player), got '+ids.length);
      assert(!ids.includes('frost'),'bots must not duplicate the player operator');
      const names=this.heroes.list.map(h=>h.name);
      assert(new Set(names).size===names.length,'cycled operators need distinct names: '+names.join(','));
      assert(this.heroes.list.filter(h=>h.team==='A').length===2,'there should be 2 teammates');
      assert(this.heroes.list.filter(h=>h.team==='B').length===3,'there should be 3 enemies');
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
      const p=this.pickups.drop(this.player.pos.clone(),'med');
      this.pickups.update(.016,this.player);
      assert(this.player.health>50,'medkit drop should heal');
      assert(!this.pickups.list.includes(p),'a picked-up drop should be removed');
    });
    await run('pickup-ammo',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const before=this.weapon.state[this.weapon.cur].reserve;
      this.pickups.drop(this.player.pos.clone(),'ammo');
      this.pickups.update(.016,this.player);
      assert(this.weapon.state[this.weapon.cur].reserve>before,'an ammo drop should add reserve ammo');
      this.pickups.drop(this.player.pos.clone(),'boost');
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
    await run('daily-pvp',()=>{
      localStorage.removeItem('o07_save_v2');
      const s=new SaveSystem();
      const goals=s.dailyGoals('pvp');
      assert(goals.length===3&&goals[1].id==='score','PvP daily should use a score goal, got '+goals.map(g=>g.id).join(','));
      s.data.daily.progress={kills:goals[0].n-1,wave:0,headshots:goals[2].n-1,score:goals[1].n-1};
      s.data.daily.done=false;
      s.award({kills:1,wave:0,headshots:1,score:goals[1].n,time:0,opId:'frost'});
      assert(s.data.daily.progress.score>=goals[1].n,'PvP score daily should persist, got '+s.data.daily.progress.score);
      assert(s.data.daily.done,'PvP goals should be able to complete the daily');
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
      assert(document.getElementById('o-board').textContent==='','waves results must not keep a stale PvP board');
    });
    await run('koth-score',()=>{
      this.ui.sel.mode='koth';this.startGame();
      assert(this.koth.active&&this.koth.score.A===0,'KOTH should initialise');
      this.player.pos.set(this.koth.pos.x,0,this.koth.pos.z); // stand on the hill, wherever the map put it
      this.player.alive=true;this.player.god=true;
      for(const h of this.heroes.list)h.alive=false;
      for(let i=0;i<120;i++)this.koth.update(.016);
      assert(this.koth.capture>0,'standing on the point should build capture progress');
      assert(this.koth.score.A===0,'no points before the hill is captured (capture takes ≈3 s)');
      this.koth.capture=1;this.koth.owner='A';
      for(let i=0;i<30;i++)this.koth.update(1/30);
      assert(this.koth.score.A>0.9&&this.koth.score.A<1.1,'one point per second of holding, got '+this.koth.score.A);
      this.koth.score.A=199;this.koth.score.B=0;
      this.koth.capture=1;this.koth.owner='A';
      this.koth.update(1);
      assert(this.state==='over','reaching 200 points should end the match');
      assert(document.getElementById('koth-score').textContent.includes('200'),'KOTH HUD should show the final capture points (200)');
      const ob=document.getElementById('o-board');
      assert(ob.querySelectorAll('tr').length===7,'KOTH results should show 6 players (3v3) + header');
      assert(ob.textContent.includes(this.playerName),'KOTH results should list the player');
      this.startGame();
    });
    /* Every screen must keep light text off light backgrounds. Each overlay is opened with real
       content, then contrastCheck() resolves text colour against the composited background. */
    await run('contrast-no-light-on-light',()=>{
      const ui=this.ui,root=id=>document.getElementById(id);
      const hidden=id=>root(id).classList.contains('hidden');
      const fails=[];
      const check=name=>{for(const f of contrastCheck().fails)fails.push(name+' '+JSON.stringify(f));};
      // a menu with every mode / map chip selected in turn + both lobby sub-views + a filled results page
      const prev={...ui.sel};
      ui.showOnly('menu');
      for(const mode of ['dm','koth','waves']){ui.sel.mode=mode;try{ui.refreshModes&&ui.refreshModes();}catch(e){}check('menu['+mode+']');}
      for(const m of Object.keys(MAPS)){ui.sel.map=m;check('menu[map '+m+']');}
      Object.assign(ui.sel,prev);
      // The detector must be able to fail: an option that loses its opaque background is exactly
      // the white-on-white bug (the OS popup sheet shows through), so it has to be reported.
      const opt=document.querySelector('#m-quality option'),bg=opt.style.backgroundColor;
      opt.style.backgroundColor='rgba(0,0,0,0)';
      const caught=contrastCheck().fails.length;
      opt.style.backgroundColor=bg;
      assert(caught>0,'the contrast detector must flag an option without an opaque background');
      assert(contrastCheck().fails.length===0,'…and the stylesheet in place keeps every screen clean');
      ui.showOnly('lobby');
      root('lobby-home').classList.remove('hidden');root('lobby-room').classList.add('hidden');check('lobby-home');
      root('lobby-home').classList.add('hidden');root('lobby-room').classList.remove('hidden');check('lobby-room');
      root('lobby-home').classList.remove('hidden');root('lobby-room').classList.add('hidden');
      ui.showOnly('pause');ui.setNetMode(false);check('pause');ui.setNetMode(true);check('pause-net');
      ui.setNetMode(false);
      ui.showTutorial(TUTORIAL,()=>{});check('tutorial');ui.closeTutorial(false);
      this.ui.sel.mode='waves';this.startGame();this.openUpgrade();
      if(this.state==='upgrade'){check('upgrades');applyUpgrade(this,'dmg');}
      this.ui.sel.mode='dm';this.startGame();this.fallbackAim=true;
      ui.showOver({title:t('win'),win:true,kicker:t('dm_over_kicker'),
        stats:{time:123,kills:9,critKills:2,hits:40,shots:60,score:900,best:1200,bestCombo:3,mvp:{name:'Raven',op:byId('raven'),kills:9,deaths:1}},
        board:`<table><tr><th>${t('sb_kills')}</th><th>${t('sb_deaths')}</th></tr><tr class="me"><td>9</td><td>1</td></tr></table>`});
      check('over');
      // HUD / scoreboard during play
      ui.showOnly(null);check('hud');
      window.dispatchEvent(new KeyboardEvent('keydown',{code:'Tab',key:'Tab',bubbles:true,cancelable:true}));
      check('scoreboard');
      window.dispatchEvent(new KeyboardEvent('keyup',{code:'Tab',key:'Tab',bubbles:true}));
      ui.showOnly('menu');this.startGame();
      assert(fails.length===0,'low-contrast text on: '+fails.slice(0,6).join(' | '));
    });
    await run('koth-first-blood-no-end',()=>{
      this.ui.sel.mode='koth';this.startGame();
      // 25 kills used to satisfy KOTH's kill line (0) → "match over" on the very first kill
      for(const s of this.dm.scores.values())if(s.team==='A')s.kills=25;
      const foes=this.heroes.list.filter(h=>h.team==='B');
      foes[0].takeDamage(9999,this.playerName,true);
      assert(this.state==='playing'&&this.koth.done===false,'a kill must not end King of the Hill');
      assert(this.dm.timer>230,'the match clock should still be running');
      this.player.god=false;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,foes[1].name,foes[1].pos);
      assert(this.state!=='over','the player dying must not end King of the Hill');
      this.player.god=true;this.startGame();
    });
    await run('koth-hill-open-4maps',()=>{
      // The hill is placed on open ground: its whole disc must be clear of static geometry on
      // every map (the dock map used to have 9 containers and pillars inside the point).
      const map0=this.ui.sel.map,mode0=this.ui.sel.mode;
      for(const k of ['desert','snow','snowtown','ember']){
        this.ui.sel.map=k;this.ui.sel.mode='koth';this.startGame();
        const p=this.koth.pos,r=this.koth.radius;
        assert(Math.hypot(p.x,p.z)<=30,k+': hill should stay near the middle of the arena');
        for(const spawn of Object.values(this.spawns))
          assert(Math.hypot(p.x-spawn.x,p.z-spawn.z)>=r+1.4,k+': hill overlaps a team spawn envelope');
        // ember is dense: its best site keeps tall obstacles ≥ 7.5 m from the centre (a sliver of
        // cover may poke into the outer edge of the ring); the other three maps get the full 8 m
        assert(this.koth.clearance>=r-.5,k+': hill should sit on open ground (clearance '+this.koth.clearance.toFixed(1)+')');
        for(const c of this.world.colliders){
          if(c.top<=.32)continue; // only the actual .32 m auto-step is walkable
          if(c.bottom!=null&&c.bottom>=1.8)continue; // overhead geometry does not block the hill
          const dx=Math.max(c.minX-p.x,0,p.x-c.maxX),dz=Math.max(c.minZ-p.z,0,p.z-c.maxZ);
          assert(Math.hypot(dx,dz)>=r-.5,k+': collider overlaps the hill: '+JSON.stringify([c.minX,c.maxX,c.minZ,c.maxZ])+' hill '+p.x.toFixed(1)+','+p.z.toFixed(1));
        }
        assert(this.koth.marker&&this.koth.marker.grp.parent===this.scene,k+': hill marker should be in the scene');
      }
      this.ui.sel.map=map0;this.ui.sel.mode=mode0;this.startGame();
    });
    /* The squad command layer must really run: it is wrapped in a safety net, so a bug inside it
       would otherwise fail silently and leave every bot on its own patrol. */
    const breathe=()=>new Promise(r=>setTimeout(r,0)); // let the runner's poll through during long sims
    await run('squad-ai-orders',async()=>{
      this._e2eHold=true;                                       // this case steps the world itself
      try{
      for(const mode of ['dm','koth']){
        this.ui.sel.mode=mode;this.ui.sel.map='snowtown';this.startGame();
        this.player.god=true;this.player.pos.set(0,0,46);
        for(let i=0;i<400;i++){
          this._losLeft=16;this.squad.update(.016);
          this.heroes.update(.016,this.time+i*.016,(a,b)=>this._losCapped(a,b));
          if(mode==='koth')this.koth.update(.016);
          if(i%60===0)await breathe();
        }
        assert(this.squad.enabled&&this.squad.ai,'squad layer is active ('+mode+')');
        assert(!(this.squad.failures>0),'squad layer ran without failures ('+mode+'): '+(this.squad.failures||0));
        assert(this.squad.units.size===this.heroes.list.length,'every local bot is a squad unit');
        const d=this.squad.ai.director;
        assert(d.teams.A.plan&&d.teams.B.plan,'both teams hold a plan ('+mode+')');
        assert(['attack','defense'].includes(d.teams.A.plan.kind),'plan kinds are attack / defense');
        const kinds=new Set([...this.squad.units.values()].map(u=>u.order&&u.order.kind));
        assert(kinds.has('move')||kinds.has('hold'),'orders reach the bots ('+mode+'): '+[...kinds]);
        const sets=this.heroes.list.map(h=>h.brain.params);
        assert(new Set(sets).size===sets.length,'each brain owns its parameter set');
        // Presets stay shared per faction — with one sanctioned exception: the Longbow
        // operator carries its own sniper preset (botConfig SNIPER_OVERRIDES), so a bot's
        // baseParams may differ from its faction twin's iff exactly one of them is 'sniper'.
        assert(this.heroes.list.every(h=>h.brain.baseParams===this.heroes.list[0].brain.baseParams
          ||h.faction!==this.heroes.list[0].brain.faction
          ||(h.brain.baseParams.style==='sniper')!==(this.heroes.list[0].brain.baseParams.style==='sniper')),
          '…while the presets stay shared per faction (sniper preset excepted)');
      }
      this.squad.endMatch();this.ui.sel.map='desert';this.ui.sel.mode='dm';this.startGame();
      }finally{this._e2eHold=false;}
    });
    await run('bot-order-crosses-map',async()=>{
      this._e2eHold=true;                                       // this case steps the world itself
      try{
      /* A single order across the whole map is followed through the bot's own navigation. The dock
         and caldera maps keep spawn pockets behind big buildings: the bot's 10 m planner finds no
         route there, and an empty waypoint list used to latch and pin the bot in place. */
      for(const k of ['snowtown','ember']){
        this.ui.sel.map=k;this.ui.sel.mode='dm';this.startGame();
        const bot=this.heroes.list.find(h=>h.team==='A');
        // nobody else on the map (alive=false alone would leave the others fighting): pure navigation
        const everyone=this.heroes.list;this.heroes.list=[bot];
        this.player.god=true;this.player.pos.set(0,0,46);
        bot.place(new THREE.Vector3(this.spawns.A.x,0,this.spawns.A.z),0);
        bot._route=null;bot.vel.set(0,0,0);bot.brain.reset();bot._blockT=0;
        const goal=new THREE.Vector3(this.spawns.B.x,0,this.spawns.B.z);
        const d0=bot.pos.distanceTo(goal);
        const order={kind:'move',goal:[goal.x,goal.z],lookAt:[goal.x,goal.z],label:'TEST'};
        for(let i=0;i<1500;i++){                                           // 24 s
          this.squad.ai.director.teams.A.lastOrder['h'+bot.id]={...order,until:this.squad.time+30};
          this._losLeft=16;this.squad.update(.016);
          this.heroes.update(.016,this.time+i*.016,(a,b)=>this._losCapped(a,b));
          if(i%60===0)await breathe();
        }
        const d1=bot.pos.distanceTo(goal);
        this.heroes.list=everyone;
        assert(d1<3,k+': the bot should reach a whole-map order ('+d0.toFixed(1)+' → '+d1.toFixed(1)+' m in 24 s)');
      }
      this.ui.sel.map='desert';this.startGame();
      }finally{this._e2eHold=false;}
    });
    await run('bot-empty-route-replans',()=>{
      this.ui.sel.map='snowtown';this.ui.sel.mode='dm';this.startGame();
      const bot=this.heroes.list.find(h=>h.team==='A');
      for(const h of this.heroes.list)if(h!==bot)h.blindT=999;              // everyone else stands still
      this.squad.setEnabled(false);                                         // hand the order straight to the brain
      bot.place(new THREE.Vector3(this.spawns.A.x,0,this.spawns.A.z),0);
      bot._route=[];bot.vel.set(0,0,0);bot.brain.reset();                   // the state that used to latch
      const goal=new THREE.Vector3(this.spawns.B.x,0,this.spawns.B.z);
      const order={kind:'move',goal:[goal.x,goal.z],lookAt:[goal.x,goal.z]};
      let planned=false,empty=0;
      for(let i=0;i<240;i++){
        bot.blindT=0;bot.brain.squadOrder=order;
        this.heroes.update(.016,this.time+i*.016,(a,b)=>this._losCapped(a,b));
        if(bot._route&&bot._route.length)planned=true;
        // the list may be empty for the few frames between "last waypoint reached" and the next
        // planning frame — but it must never STAY empty (that latched before this fix)
        if(bot._route&&!bot._route.length)empty++;else empty=0;
        assert(empty<=4,'an empty waypoint list must not persist ('+empty+' frames)');
      }
      this.squad.setEnabled(true);
      assert(planned,'a route toward the enemy spawn gets planned (local or whole-map)');
      assert(bot.pos.distanceTo(goal)<44,'and the bot is under way ('+bot.pos.distanceTo(goal).toFixed(1)+' m left of 48)');
      this.ui.sel.map='desert';this.startGame();
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
      // kill the player on frame 0: clear every damage immunity, including the opening spawn shield
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      assert(!this.player.alive,'player should be dead');
      assert(this.spectate.target===killer,'after death the killer should be spectated');
      this.player.alive=true;this.player.health=this.player.maxHealth;this.player.god=true;
      this.spectate.target=null;
    });
    await run('dm-player-death-scored',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      const me=this.dm.scores.get(this.playerName),k=killer&&this.dm.scores.get(killer.name);
      const d0=me.deaths,k0=k.kills;
      const origFeed=this.ui.killFeed;let feeds=0;this.ui.killFeed=()=>feeds++;
      try{this.damagePlayerFromBot(999,killer.name,killer.pos);}finally{this.ui.killFeed=origFeed;}
      assert(!this.player.alive,'the player should be dead');
      assert(me.deaths===d0+1,'the player death should count on the board, deaths='+me.deaths);
      assert(k.kills===k0+1,'the killing bot should be credited, kills='+k.kills);
      assert(feeds===1,'the player death should post a killfeed entry, got '+feeds);
      assert(document.getElementById('dm-b').textContent===String(k0+1),'the DM HUD should update from the player death');
      this.damagePlayerFromBot(999,killer.name,killer.pos); // already dead: must not double count
      assert(me.deaths===d0+1&&k.kills===k0+1,'a dead player must not be scored twice');
      assert(this.dm.timer===180,'the deathmatch clock should start at 3 minutes, got '+this.dm.timer);
      this.player.alive=true;this.player.health=this.player.maxHealth;this.player.god=true;
      this.spectate.target=null;this.dmRespawnT=-1;
    });
    await run('dm-respawn',()=>{
      this.ui.sel.mode='dm';this.startGame();
      this.fallbackAim=true;
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      const clock=this.clock;
      this.clock={getDelta:()=>.05}; // deterministic 20 fps: the loop under test is the real tick()
      const origFlash=this.ui.deathFlash;let flashes=0;
      const render=this.composer.render;this.composer.render=()=>{}; // headless SwiftShader: 120 full renders are not part of the respawn check
      this.ui.deathFlash=()=>{flashes++;return origFlash.call(this.ui);};
      try{
        let t=0,respawned=false;
        for(let i=0;i<120;i++){this.tick();t+=.05;if(this.player.alive){respawned=true;break;}}
        assert(respawned,'the player should respawn after the 2.5 s countdown, alive after '+t.toFixed(2)+' s');
        assert(this.dmRespawnT<0,'the countdown should be cleared after the respawn, got '+this.dmRespawnT);
        assert(this.player.health===this.player.maxHealth,'respawn should restore full health');
        /* Death flashes exactly once. There is deliberately NO respawn flash: it used to fire on
           the very frame control was handed back, slamming a full-screen white layer over the
           battlefield the player is trying to re-read. The assertion guards both halves — the
           count must not re-arm every frame (that pinned the white overlay on screen forever). */
        assert(flashes===1,'death should flash exactly once, got '+flashes);
      }finally{this.clock=clock;this.composer.render=render;this.ui.deathFlash=origFlash;}
      this.spectate.target=null;this.dmRespawnT=-1;this.player.god=true;
    });
    await run('death-clears-viewmodel',()=>{
      /* Regression: the muzzle flash / shells / recoil / ADS all decay inside weapon.update(), and
         main.js used to skip that call for a dead player — so a shot fired just before death left
         the flash lit on the gun tip for the whole spectate window. */
      this.ui.sel.mode='dm';this.startGame();this.player.god=false;
      const w=this.weapon;
      this.player.sprinting=false;this.input.ads=false;
      w.switchT=-1;w._equip(0,true);
      // Fire once so the flash is genuinely lit before the kill lands.
      this.input.firing=true;w._trigWasDown=false;w.fireT=0;
      w.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      assert(w.muzzleFlashT>0&&w.flash.visible,'a shot should light the muzzle flash');
      this.input.firing=false;
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      assert(w.muzzleFlashT===0,'the muzzle flash timer must be cleared on the death frame');
      assert(w.flash.visible===false,'the flash plane must be hidden');
      assert(w.flashLight.intensity===0,'the muzzle point light must be off');
      assert(w.shells.every(s=>!s.active&&!s.mesh.visible),'no casing may hang in the air');
      assert(w.camKick===0&&w.camKickYaw===0,'recoil must not survive into the death camera');
      /* group.visible is owned by _applyCameraState() (called once per frame), so drive one frame
         to observe it — the flash/light/shells above are already clean without a tick. */
      this._applyCameraState();
      assert(w.group.visible===false,'a dead player has no viewmodel');
      this.player.alive=true;this.player.health=this.player.maxHealth;
      this.dmRespawnT=-1;this.spectate.target=null;this._deathHandled=false;
    });
    await run('death-cancels-reload',()=>{
      this.ui.sel.mode='dm';this.startGame();this.player.god=false;
      const w=this.weapon;
      this.player.sprinting=false;this.input.ads=false;
      w.switchT=-1;w._equip(0,true);
      this.input.firing=true;w._trigWasDown=false;w.fireT=0;
      w.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      this.input.firing=false;
      w.startReload();
      for(let i=0;i<20;i++)w.update(.016,{firing:false,ads:false},this.player,this.camera,this.time,()=>{});
      assert(w.reloading||w.reloadT>0,'the reload should be underway');
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      assert(w.reloading===false,'a death cancels the reload rather than pausing it');
      assert(w.reloadT===0,'the reload timer is reset');
      this.player.alive=true;this.player.health=this.player.maxHealth;
      this.dmRespawnT=-1;this.spectate.target=null;this._deathHandled=false;
    });
    await run('death-restores-fov',()=>{
      /* ADS zoom feeds the camera FOV; a frozen adsAmt left the player zoomed in through the whole
         death screen and the respawn. */
      this.ui.sel.mode='dm';this.startGame();this.player.god=false;
      const w=this.weapon;
      w.switchT=-1;w.setLoadout('awp');w._equip(0,true);
      this.player.sprinting=false;
      for(let i=0;i<90;i++)w.update(.016,{firing:false,ads:true},this.player,this.camera,this.time,()=>{});
      assert(w.adsAmt>.85,'the scope should be up, got '+w.adsAmt);
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      // Let the dead tick ease the zoom out (main.js still calls weapon.update while dead).
      for(let i=0;i<60;i++)w.update(.016,{firing:false,ads:false},this.player,this.camera,this.time,()=>{});
      assert(w.adsAmt<.05,'the ADS zoom must ease back out while dead, got '+w.adsAmt);
      this.player.alive=true;this.player.health=this.player.maxHealth;
      this.dmRespawnT=-1;this.spectate.target=null;this._deathHandled=false;
    });
    await run('pause-clears-muzzle-fx',()=>{
      /* Same frozen-frame symptom as death, reached through ESC instead: the sim stops but the gun
         stays on screen, so a muzzle flash lit by the last shot would burn in the paused frame. */
      this.ui.sel.mode='dm';this.startGame();this.player.god=true;
      const w=this.weapon;
      this.player.sprinting=false;this.input.ads=false;
      w.switchT=-1;w._equip(0,true);
      this.input.firing=true;w._trigWasDown=false;w.fireT=0;
      w.update(.016,this.input,this.player,this.camera,this.time,()=>{});
      this.input.firing=false;
      assert(w.muzzleFlashT>0&&w.flash.visible,'a shot should light the muzzle flash');
      // Reload in flight: a pause must not cancel it.
      w.startReload();
      for(let i=0;i<10;i++)w.update(.016,{firing:false,ads:false},this.player,this.camera,this.time,()=>{});
      const reloadWas=w.reloading;
      this.pause();
      assert(w.muzzleFlashT===0,'pausing must clear the muzzle flash timer');
      assert(w.flash.visible===false,'pausing must hide the flash plane');
      assert(w.flashLight.intensity===0,'pausing must turn the muzzle light off');
      assert(w.reloading===reloadWas,'a pause must not cancel an in-flight reload');
      assert(this.state==='paused','the game should be paused');
      this.resume();
      this.player.god=false;
    });
    await run('spawn-invuln-3s',()=>{
      /* Respawn protection: 3 s where incoming damage is ignored entirely (no HP loss, no death,
         no score), then normal damage resumes. The timer is driven by tick(), so this steps the
         real loop like dm-respawn does. */
      this.ui.sel.mode='dm';this.startGame();
      this.fallbackAim=true;
      const killer=this.heroes.list.find(h=>h.team==='B'&&h.alive);
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.health=1;this.player.alive=true;
      this.damagePlayerFromBot(999,killer.name,killer.pos);
      const clock=this.clock;
      this.clock={getDelta:()=>.05};
      const render=this.composer.render;this.composer.render=()=>{};
      try{
        let respawned=false;
        for(let i=0;i<120&&!respawned;i++){this.tick();if(this.player.alive)respawned=true;}
        assert(respawned,'the player should respawn');
        assert(Math.abs(this.spawnInvulnT-SPAWN_INVULN)<.06,
          `a respawn must arm a ${SPAWN_INVULN} s shield, got ${this.spawnInvulnT.toFixed(2)}`);
        const me=this.dm.scores.get(this.playerName);
        const d0=me.deaths;
        const hp=this.player.health;
        this.damagePlayerFromBot(999,killer.name,killer.pos);
        assert(this.player.alive,'a shielded player must not die');
        assert(this.player.health===hp,'a shielded player must lose no HP');
        assert(me.deaths===d0,'a shielded death must not be scored');
        // Step ~3.2 s: the shield expires.
        for(let i=0;i<64;i++)this.tick();
        assert(this.spawnInvulnT===0,'the shield must expire, got '+this.spawnInvulnT);
        this.damagePlayerFromBot(999,killer.name,killer.pos);
        assert(!this.player.alive,'once the shield is gone a 999 hit kills the player');
      }finally{this.clock=clock;this.composer.render=render;}
      this.spectate.target=null;this.dmRespawnT=-1;this.player.god=true;
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
    await run('fun-items',()=>{
      this.ui.sel.mode='fun';this.startGame();
      const f=this.funItems;
      assert(this.matchMode==='fun'&&this.isArena(),'fun should be an arena mode');
      assert(f.counts.banana===1&&f.counts.magnet===1&&f.counts.spring===1&&f.counts.water===1,
        'every prop starts with one charge');
      assert(this.grenades.counts.frag===0,'grenades are disabled in Fun Brawl');
      assert(!document.getElementById('fun-items').classList.contains('hidden'),'the prop HUD is shown');
      assert(document.getElementById('grenades').classList.contains('hidden'),'the grenade HUD is hidden');
      // Throwing spends a charge and lands as a placed prop.
      assert(f.throw('banana'),'a throw should leave the hand');
      assert(f.counts.banana===0,'the charge is spent');
      assert(!f.throw('banana'),'an empty bag throws nothing');
      assert(document.getElementById('fi-banana').textContent==='0','the prop HUD stays in sync');
    });
    await run('fun-props',()=>{
      this.ui.sel.mode='fun';this.startGame();this.player.god=true;
      const f=this.funItems;
      /* Props score for whoever THREW them, so the owner has to be someone on the board. */
      const enemyBot=this.heroes.list.find(h=>h.team==='B');
      const owner={team:'B',name:enemyBot.name,isPlayer:false};
      const ownerRow=this.dm.scores.get(enemyBot.name);
      assert(ownerRow,'the enemy bot must have a board row');
      // Banana: a peel on open ground slips the player and scores for the thrower.
      const before=ownerRow.kills;
      f._place({type:'banana',pos:new THREE.Vector3(0,0,0),owner},0);
      this.player.pos.set(0,0,0);
      f.update(.016);
      assert(this.player.slipT>0,'the banana should make the player slip');
      assert(ownerRow.kills>before,'the thrower should score the slip');
      // Spring: launches upward.
      this.player.slipT=0;this.player.velY=0;this.player.grounded=true;
      f._place({type:'spring',pos:new THREE.Vector3(3,0,3),owner},0);
      this.player.pos.set(3,0,3);
      f.update(.016);
      assert(this.player.velY>0,'the spring should launch the player');
      // Water: slows the player.
      this.player.velY=0;this.player.grounded=true;
      f._place({type:'water',pos:new THREE.Vector3(-3,0,-3),owner},0);
      this.player.pos.set(-3,0,-3);
      f.update(.016);
      assert(this.player.slowT>0,'the puddle should slow the player');
      assert(this.player.alive,'props are prank effects, not damage');
    });
    await run('fun-magnet',()=>{
      this.ui.sel.mode='fun';this.startGame();
      const f=this.funItems;
      const bot=this.heroes.list.find(h=>h.team==='B');
      bot.pos.set(1,0,1);bot.disarmedT=0;bot.rifleFalling=false;
      const dropsBefore=this.pickups.list.length;
      const myRow=this.dm.scores.get(this.playerName);
      assert(myRow,'the local player must have a board row');
      const before=myRow.kills;
      f._magnetBurst(new THREE.Vector3(1,0,1),{team:'A',name:this.playerName,isPlayer:true});
      assert(bot.disarmedT>0,'the magnet should disarm the enemy bot');
      assert(bot.rifleFalling,'the bot rifle should fall');
      assert(this.pickups.list.length>dropsBefore,'a weapon crate should spawn');
      assert(myRow.kills>before,'the thrower should score the disarm');
      // A second burst cannot farm the same victim.
      const again=myRow.kills;
      f._magnetBurst(new THREE.Vector3(1,0,1),{team:'A',name:this.playerName,isPlayer:true});
      assert(myRow.kills===again,'a disarmed bot must not score twice');
    });
    await run('fun-status-no-fire',()=>{
      /* A slipped or disarmed player must not empty the magazine: the shot's ammo/spark/sound are
         committed inside weapon.update(), so the status gate has to live there too (the fire()
         guard alone would drain the mag and deal no damage). */
      this.ui.sel.mode='fun';this.startGame();this.player.god=true;
      this.weapon.switchT=-1;
      this.weapon._equip(0,true);           // a known primary, no swap animation in flight
      /* canFire also requires !player.sprinting; this harness never calls player.update(), so a
         sprint flag left over from an earlier case would silently block every shot here. */
      this.player.sprinting=false;
      this.input.ads=false;
      /* `shove` always goes through this one callback so every segment below counts shots;
         a separate no-op callback would make the "fires again" assertion unobservable. */
      let shots=0;
      const shove=(dt)=>this.weapon.update(dt,this.input,this.player,this.camera,this.time,()=>{shots++;});
      this.player.slipT=0;this.player.disarmT=0;
      this.weapon.resetAmmo();this.weapon.fireT=0;
      this.input.firing=true;this.weapon._trigWasDown=false;
      const before=this.weapon.st.ammo;
      shove(.016);
      assert(this.weapon.st.ammo<before,'a normal trigger pull spends a round');

      // Slipped: no rounds, no fire callback.
      this.weapon.resetAmmo();this.weapon.fireT=0;this.weapon._trigWasDown=false;
      this.player.slipT=.9;
      const magSlip=this.weapon.st.ammo;shots=0;
      for(let i=0;i<40;i++)shove(.016);
      assert(this.weapon.st.ammo===magSlip,'slipping must not spend ammo');
      assert(shots===0,'slipping must not fire a shot');

      // Disarmed: same rule.
      this.player.slipT=0;this.player.disarmT=3;
      this.weapon.resetAmmo();this.weapon.fireT=0;this.weapon._trigWasDown=false;
      const magDis=this.weapon.st.ammo;shots=0;
      for(let i=0;i<40;i++)shove(.016);
      assert(this.weapon.st.ammo===magDis,'being disarmed must not spend ammo');
      assert(shots===0,'being disarmed must not fire a shot');

      // Control: once the statuses clear the rifle works again. (player.update() is what drains
      // the timers, so a weapon-only harness has to clear them by hand.)
      this.player.slipT=0;this.player.disarmT=0;
      this.weapon.resetAmmo();this.weapon.fireT=0;this.weapon._trigWasDown=false;
      const magOk=this.weapon.st.ammo;shots=0;
      this.player.sprinting=false;              // re-assert: nothing else resets it in this harness
      for(let i=0;i<40;i++)shove(.016);
      assert(this.weapon.st.ammo<magOk,'the rifle works again after the status expires');
      assert(shots>0,'shots fire again after the status expires');
      this.input.firing=false;
    });
    await run('fun-ends',()=>{
      this.ui.sel.mode='fun';this.startGame();
      // The prank board decides the match: first to FUN_MATCH.win ends it. Points must go
      // through funApplyScore so the per-category breakdown mirrors the row total exactly.
      const me=this.dm.scores.get(this.playerName);
      const other=[...this.dm.scores.values()].find(r=>!r.me);
      for(let i=0;i<FUN_MATCH.win/2;i++)funApplyScore(me,'kill');   // 2 pts per kill → win score
      funApplyScore(other,'slip');funApplyScore(other,'slip');      // banana ×2
      funApplyScore(other,'water');
      funApplyScore(other,'disarm');
      this._checkDmWin();
      assert(this.state==='over','the prank board should end the match at the win score');
      const kicker=document.getElementById('o-kicker');
      assert(kicker&&kicker.textContent.includes(t('fun_over_kicker')),'fun shows its own end kicker');
      /* Per-category breakdown on the results screen: kills + every prop, plus the total. */
      const fb=document.querySelector('#o-board .fun-breakdown');
      assert(fb,'the results screen shows the per-category breakdown table');
      const headers=[...fb.querySelectorAll('th')].map(th=>th.textContent);
      for(const key of ['over_kills','fun_banana','fun_magnet','fun_spring','fun_water','sb_total'])
        assert(headers.includes(t(key)),'breakdown header missing: '+key);
      const totals=[...fb.querySelectorAll('td.fb-total')].map(td=>+td.textContent);
      assert(totals.length===this.dm.scores.size,'one total cell per player');
      assert(totals.includes(FUN_MATCH.win),'my row re-sums to the win score');
      assert(totals.includes(5),'the other row re-sums to banana2+water1+magnet2');
      const myRow=fb.querySelector('tr.me');
      assert(myRow,'my row is marked in the breakdown');
      const myCells=[...myRow.children].map(td=>+td.textContent);
      assert(myCells[1]===FUN_MATCH.win,'all my points sit in the kills category');
    });
    await run('fun-player-disarm',()=>{
      /* The local player is a valid magnet victim; the guard used to only be exercised on bots. */
      this.ui.sel.mode='fun';this.startGame();
      const f=this.funItems;
      this.player.pos.set(0,0,0);
      this.weapon.switchT=-1;                       // no switch mid-animation
      this.weapon._equip(0,true);                   // holding a primary
      this.player.disarmT=0;
      const dropsBefore=this.pickups.list.length;
      const holding=this.weapon.cur<this.weapon.primaryCount;
      assert(holding,'the player should start on a primary slot');
      f._magnetBurst(new THREE.Vector3(0,0,0),{team:'B',name:'enemy',isPlayer:false});
      assert(this.player.disarmT>0,'the magnet disarms the local player');
      /* switchTo() starts a 0.32 s raise animation: the slot index only becomes the sidearm when
         that animation completes, so a weapon timer has to be driven to see the hand change. */
      for(let i=0;i<40;i++)this.weapon.update(.016,{firing:false,ads:false},this.player,this.camera,this.time,()=>{});
      assert(this.weapon.cur>=this.weapon.primaryCount,'the player is handed a sidearm');
      assert(this.pickups.list.length>dropsBefore,'the primary is dropped as a weapon crate');
      // A sidearm in hand has no rifle to yank: no second crate, but still no shooting.
      this.player.disarmT=0;
      const drops2=this.pickups.list.length;
      f._magnetBurst(new THREE.Vector3(0,0,0),{team:'B',name:'enemy',isPlayer:false});
      assert(this.player.disarmT>0,'the sidearm holder is still stunned');
      assert(this.pickups.list.length===drops2,'a sidearm holder drops no rifle crate');
      this.player.disarmT=0;
    });
    await run('fun-isolation',()=>{
      // Fun Brawl must leave every other mode byte-identical: no props, grenades intact.
      for(const m of ['waves','dm','koth']){
        this.ui.sel.mode=m;this.startGame();
        assert(this.funItems.list.length===0&&this.funItems.placed.length===0,`${m} must not have props`);
        assert(document.getElementById('fun-items').classList.contains('hidden'),`${m} hides the prop HUD`);
      }
      this.ui.sel.mode='dm';this.startGame();
      assert(this.grenades.counts.frag===2,'dm keeps its grenades');
      assert(this.funItems.throw('banana')===false||this.funItems.list.length===0,'dm never receives props');
      this.ui.sel.mode='fun';this.startGame();
      this.toMenu();
      assert(this.funItems.list.length===0&&this.funItems.placed.length===0,'leaving the mode clears props');
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
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.alive=true;
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
    await run('bot-separate-3v3',()=>{
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
      assert(this.save.data.daily.progress.score>=200,'PvP score daily should be awarded at match end, got '+this.save.data.daily.progress.score);
      assert(this.state==='over','reaching winKills should end the match');
      const ob=document.getElementById('o-board');
      assert(ob.querySelectorAll('tr').length===7,'DM results should show 6 players (3v3) + header');
      assert(ob.textContent.includes(this.playerName),'DM results should list the player');
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
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.alive=true;
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
    await run('bot-perception-memory',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const a=this.heroes.list.find(h=>h.team==='A');
      const b=this.heroes.list.find(h=>h.team==='B');
      this.player.alive=false; // keep the player out of the sight test
      for(const h of this.heroes.list)if(h!==a&&h!==b){h.place(new THREE.Vector3(0,0,h.team==='A'?45:-45),0);h.blindT=999;}
      a.place(new THREE.Vector3(0,0,0),Math.PI);
      b.place(new THREE.Vector3(0,0,-10),0);
      const t0=this.time;
      a.update(.016,t0,()=>true); // acquire in the view cone
      assert(a.brain.targetId==='h'+b.id,'the enemy in the view cone should be perceived');
      assert(a.brain.targetVisible,'it should be a live sighting, not memory');
      for(let i=0;i<12;i++)a.update(.016,t0+i*.016,()=>false); // one full sensing tick behind cover
      assert(!a.brain.targetVisible,'cover should break live sight');
      assert(a.brain.targetId==='h'+b.id,'the bot should remember the last known position');
      const mem=a.brain.sensor.get('h'+b.id);
      assert(mem&&!mem.visible,'the memory entry should persist while hidden');
      b.place(new THREE.Vector3(0,0,-42),0);
      for(let i=0;i<300;i++)a.update(.016,t0+1+i*.016,()=>false); // > memoryTime
      assert(!a.brain.sensor.get('h'+b.id),'the memory entry should expire after memoryTime');
      assert(!a.brain.target,'an expired target must not stay selected');
      this.player.alive=true;this.startGame();
    });
    await run('bot-target-priority',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const a=this.heroes.list.find(h=>h.team==='A');
      const foes=this.heroes.list.filter(h=>h.team==='B');
      this.player.alive=false;
      for(const h of this.heroes.list)if(h!==a&&!foes.includes(h)){h.place(new THREE.Vector3(0,0,45),0);h.blindT=999;}
      for(const f of foes.slice(2)){f.place(new THREE.Vector3(0,0,45),0);f.blindT=999;}
      a.place(new THREE.Vector3(0,0,0),Math.PI);
      foes[0].place(new THREE.Vector3(-3,0,-8),0);
      foes[1].place(new THREE.Vector3(3,0,-8),0);
      foes[0].hp=foes[0].maxHp;foes[1].hp=20;
      a.update(.016,this.time,()=>true);
      assert(a.brain.targetId==='h'+foes[1].id,'the wounded enemy at equal distance should be prioritised');
      this.player.alive=true;this.startGame();
    });
    await run('bot-hearing',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const a=this.heroes.list.find(h=>h.team==='A');
      const b=this.heroes.list.find(h=>h.team==='B');
      this.player.alive=false;
      for(const h of this.heroes.list)if(h!==a&&h!==b){h.place(new THREE.Vector3(0,0,45),0);h.blindT=999;}
      a.place(new THREE.Vector3(0,0,0),Math.PI);
      b.place(new THREE.Vector3(0,0,-20),0);
      const now=this.time+5;
      b._shotT=now; // a gunshot that the bot cannot see (no _shotPos needed: hearing uses the body position)
      a.update(.016,now,()=>false);
      const heard=a.brain.sensor.get('h'+b.id);
      assert(heard,'gunfire within hearing range should create a memory entry');
      assert(!heard.visible,'hearing must not act like sight');
      assert(a.brain.targetId==='h'+b.id,'the bot should investigate the sound');
      this.player.alive=true;this.startGame();
    });
    await run('bot-difficulty-presets',()=>{
      const rows={};
      for(const d of ['easy','normal','hard']){
        this.settings.set('botDifficulty',d);
        this.ui.sel.mode='dm';this.startGame();
        rows[d]=this.heroes.list[0].brain.params;
      }
      assert(rows.hard.reaction<rows.normal.reaction&&rows.normal.reaction<rows.easy.reaction,'reaction time should improve with difficulty');
      assert(rows.hard.viewRange>rows.normal.viewRange&&rows.normal.viewRange>rows.easy.viewRange,'view range should improve with difficulty');
      assert(rows.hard.accuracy>rows.normal.accuracy&&rows.normal.accuracy>rows.easy.accuracy,'accuracy should improve with difficulty');
      assert(rows.hard.fov>rows.normal.fov&&rows.normal.fov>rows.easy.fov,'view cone should widen with difficulty');
      this.settings.set('botDifficulty','normal');this.startGame();
    });
    await run('bot-firing-line',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const a=this.heroes.list.find(h=>h.team==='A');
      const mate=this.heroes.list.find(h=>h.team==='A'&&h!==a);
      const b=this.heroes.list.find(h=>h.team==='B');
      this.player.alive=false;
      for(const h of this.heroes.list)if(h!==a&&h!==mate&&h!==b){h.place(new THREE.Vector3(0,0,h.team==='A'?45:-45),0);h.blindT=999;}
      a.place(new THREE.Vector3(0,0,0),Math.PI);
      mate.place(new THREE.Vector3(0,0,-3),0);
      b.place(new THREE.Vector3(0,0,-6),0);
      a.update(.016,this.time,()=>true); // acquire the enemy past the teammate
      a.reactionT=0;a.fireT=0;
      const hp0=b.hp;const orig=Math.random;
      Math.random=()=>.99;
      try{for(let i=0;i<3;i++)a.update(.016,this.time+i*.016,()=>true);}finally{Math.random=orig;}
      assert(b.hp===hp0,'the bot must hold fire while a teammate is on the line');
      assert(a.brain.blockedLineT>0,'the blocked firing line should be tracked');
      mate.place(new THREE.Vector3(4,0,-3),0);
      a.brain.senseT=.2; // force the next update to re-sense, like a real 10 Hz sense tick
      a.update(.016,this.time+1,()=>true); // re-acquire the now-visible enemy
      a.reactionT=0;a.fireT=0;
      Math.random=()=>.99;
      try{a.update(.016,this.time+1.016,()=>true);}finally{Math.random=orig;}
      assert(b.hp<hp0,'fire should resume after the teammate steps aside');
      this.player.alive=true;this.startGame();
    });
    await run('scoreboard-dm',()=>{
      const tab=()=>{
        const ev=new KeyboardEvent('keydown',{code:'Tab',key:'Tab',bubbles:true,cancelable:true});
        window.dispatchEvent(ev);
        return ev;
      };
      const untab=()=>window.dispatchEvent(new KeyboardEvent('keyup',{code:'Tab',key:'Tab',bubbles:true}));
      this.ui.sel.mode='dm';this.startGame();
      for(const s of this.dm.scores.values()){s.kills=0;s.deaths=0;}
      const me=this.dm.scores.get(this.playerName);me.kills=7;me.deaths=2;
      const enemy=[...this.dm.scores.values()].find(s=>s.team==='B');enemy.kills=3;
      this._checkDmWin();
      assert(document.getElementById('dm-a').textContent==='7','DM HUD should show team A kills');
      assert(document.getElementById('dm-b').textContent==='3','DM HUD should show team B kills');
      const ev=tab();
      assert(ev.defaultPrevented,'TAB must be consumed by the game, not move browser focus');
      const board=document.getElementById('board');
      assert(!board.classList.contains('hidden'),'TAB board should show in DM');
      const dataRows=[...board.querySelectorAll('table tr')].slice(1);
      assert(dataRows.length===6,'DM board should list all 6 players (3v3), got '+dataRows.length);
      assert(board.querySelector('tr.me td').textContent===this.playerName,'the player row should be marked');
      assert(dataRows[0].querySelector('td').textContent===this.playerName,'the player with most kills should sort first');
      assert(board.textContent.includes(this._factionLabels().A),'team A label should be localized');
      untab();
      assert(board.classList.contains('hidden'),'releasing TAB should hide the board');
      tab();
      this.startGame();
      assert(document.getElementById('board').classList.contains('hidden'),'a new match must clear a stale board');
    });
    await run('scoreboard-player-death',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const b=this.heroes.list.find(h=>h.team==='B');
      const playerScore=this.dm.scores.get(this.playerName);
      const killerScore=this.dm.scores.get(b.name);
      const k0=killerScore.kills,d0=playerScore.deaths;
      this.player.god=false;this.invulnT=0;this.spawnInvulnT=0;this.player.alive=true;this.player.health=5;
      this.damagePlayerFromBot(50,b.name,b.pos);
      assert(!this.player.alive,'the player should die');
      assert(killerScore.kills===k0+1,'the bot that killed the player should get the kill');
      assert(playerScore.deaths===d0+1,'the player death should appear on the board');
      assert(document.getElementById('dm-b').textContent===String(k0+1),'the DM HUD should update from the player death');
      const feed=document.getElementById('killfeed').textContent;
      assert(feed.includes(b.name)&&feed.includes(this.playerName),'the player death should reach the killfeed');
      assert(this.state==='playing','one kill must not end a 25-kill match');
      this.player.alive=true;this.player.health=this.player.maxHealth;
      this.startGame();
    });
    await run('scoreboard-koth',()=>{
      this.ui.sel.mode='koth';this.startGame();
      this.koth.score.A=140;this.koth.score.B=95;this.koth.capture=.25;
      window.dispatchEvent(new KeyboardEvent('keydown',{code:'Tab',key:'Tab',bubbles:true,cancelable:true}));
      const board=document.getElementById('board');
      assert(!board.classList.contains('hidden'),'TAB board should show in KOTH');
      assert(board.textContent.includes(t('mode_koth')),'KOTH board should carry the mode title');
      assert(board.textContent.includes(t('koth_a'))&&board.textContent.includes(t('koth_b')),'KOTH board should show both team names');
      assert(board.textContent.includes('140')&&board.textContent.includes('95'),'KOTH board should show capture points');
      const dataRows=[...board.querySelectorAll('table tr')].slice(1);
      assert(dataRows.length===6,'KOTH board should list all 6 players (3v3), got '+dataRows.length);
      window.dispatchEvent(new KeyboardEvent('keyup',{code:'Tab',key:'Tab',bubbles:true}));
      this.startGame();
    });
    await run('scoreboard-waves',()=>{
      this.ui.sel.mode='waves';this.startGame();
      this.waves.n=7;this.score=1234;this.stats.kills=5;
      window.dispatchEvent(new KeyboardEvent('keydown',{code:'Tab',key:'Tab',bubbles:true,cancelable:true}));
      const board=document.getElementById('board');
      assert(!board.classList.contains('hidden'),'TAB board should show in waves');
      assert(board.textContent.includes('07'),'waves board should show the wave number');
      assert(board.textContent.includes('1234'),'waves board should show the score');
      assert(!board.querySelector('table'),'waves board should not render the deathmatch table');
      window.dispatchEvent(new KeyboardEvent('keyup',{code:'Tab',key:'Tab',bubbles:true}));
      this.startGame();
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
        if(k==='snowtown'){
          // The dock canyon is a wall of 6.1 m containers stacked end-to-end. Two were placed
          // overlapping by .5 m (visible interpenetration in the seam); a same-top AABB overlap
          // check keeps that layout bug from coming back.
          for(let i=0;i<this.world.colliders.length;i++)for(let j=i+1;j<this.world.colliders.length;j++){
            const a=this.world.colliders[i],b=this.world.colliders[j];
            if(Math.abs(a.top-b.top)>.3)continue;
            const ix=Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX);
            const iz=Math.min(a.maxZ,b.maxZ)-Math.max(a.minZ,b.minZ);
            assert(!(ix>.15&&iz>.15),`snowtown has interpenetrating same-height cover at ${a.minX.toFixed(1)},${a.minZ.toFixed(1)} / ${b.minX.toFixed(1)},${b.minZ.toFixed(1)}`);
          }
        }
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
          assert(spawnPointClear(h.pos.x,h.pos.z,this.world.colliders,h.radius,1.8,52),
            `${h.name} respawned inside map geometry on ${k}`);
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

    /* ---------------- Foot-vs-ground clearance (rendered sole vertices, not capsules) ---------------- */
    await run('foot-ground-flat',()=>{
      this.ui.sel.mode='dm';this.startGame();
      this.scene.updateMatrixWorld(true);
      const ray=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0),from=new THREE.Vector3();
      for(const h of this.heroes.list){
        ray.set(from.set(h.pos.x,30,h.pos.z),down);
        const hit=ray.intersectObject(this.world.ground,false)[0];
        assert(hit,'the ground mesh must exist under '+h.name);
        assert(Math.abs(hit.point.y)<.002,`${h.name}: rendered ground is ${hit.point.y.toFixed(3)} m at the feet, expected 0`);
        assert(Math.abs(terrainHeight(h.pos.x,h.pos.z))<.002,`${h.name}: terrain height field drifted from the flat arena`);
        const r=auditFeet(h,()=>0);
        assert(r.count>=20,`${h.name}: expected rendered foot vertices, got ${r.count}`);
        assert(r.maxPenetration<=.002,`${h.name}: sole penetrates the flat ground by ${(r.maxPenetration*100).toFixed(1)} cm`);
      }
    });
    await run('foot-anim-sweep',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const heroes=this.heroes.list.slice(0,4);
      let worst={pen:-Infinity,name:''};
      const check=(h,label)=>{
        this.scene.updateMatrixWorld(true);
        const r=auditFeet(h,()=>0);
        if(r.maxPenetration>worst.pen)worst={pen:r.maxPenetration,name:h.name+' '+label};
      };
      for(const h of heroes){
        h.pos.y=0;h.group.position.y=0;h.yaw=0;
        h.moveK=0;h.walkT=0;h._animate(0,0,0);
        check(h,'idle');
        for(const spd of [2.5,5.2,7.8]){
          for(let k=0;k<12;k++){
            h.moveK=1;h.walkT=k/12*Math.PI*2;h.yaw=k*.3;
            h._animate(0,k*.17,spd);
            check(h,`walk ${spd} m/s phase ${k}`);
          }
        }
      }
      assert(worst.pen<=.003,`a moving sole dipped ${(worst.pen*100).toFixed(1)} cm below the ground (${worst.name})`);
    });
    await run('foot-platform',()=>{
      this.ui.sel.mode='dm';this.startGame();
      const ray=new THREE.Raycaster(),down=new THREE.Vector3(0,-1,0),from=new THREE.Vector3();
      const surfaces=[this.world.ground,...this.world.shootStatics];
      const surfaceAt=(x,z)=>{
        ray.set(from.set(x,30,z),down);ray.far=60;
        const hit=ray.intersectObjects(surfaces,false)[0];
        return hit?hit.point.y:0;
      };
      let platform=null,renderedTop=0,centre=null;
      for(const o of this.world.shootStatics){
        if(o.geometry?.type!=='BoxGeometry')continue;
        const b=new THREE.Box3().setFromObject(o),p=o.geometry.parameters,c=b.getCenter(new THREE.Vector3());
        if(p.width<=2||p.depth<=1.3)continue;
        const top=surfaceAt(c.x,c.z);
        if(top>1&&top<3.3){platform=o;renderedTop=top;centre=c;break;}
      }
      assert(platform,'a standable crate/container top should exist');
      const c=this.world.colliders.find(c=>Math.abs(c.top-renderedTop)<.03&&
        centre.x>=c.minX&&centre.x<=c.maxX&&centre.z>=c.minZ&&centre.z<=c.maxZ);
      assert(c,`collider top must match the rendered platform at ${renderedTop.toFixed(3)} m`);
      const h=this.heroes.list[0];
      h.place(new THREE.Vector3(centre.x,renderedTop,centre.z),0);
      h.moveK=0;h.walkT=0;h._animate(0,0,0);
      this.scene.updateMatrixWorld(true);
      const r=auditFeet(h,surfaceAt);
      assert(r.count>=20,'expected rendered foot vertices on the platform');
      assert(r.maxPenetration<=.002,`sole penetrates the ${renderedTop.toFixed(2)} m rendered platform by ${(r.maxPenetration*100).toFixed(1)} cm`);
    });

    /* ---------------- Friends 5v5 online ---------------- */
    await run('net-zero-offline',()=>{
      assert(this.netMatch.client.stats.socketsOpened===0,
        'no socket may open until the player enters the online lobby, got '+this.netMatch.client.stats.socketsOpened);
    });
    await run('online-5v5-ai',()=>{
      this.ui.sel.mode='online';
      this._startSoloOnline();
      assert(this.heroes.list.length===9,'5v5 should field 9 bots + the player, got '+this.heroes.list.length);
      assert(this.heroes.list.filter(h=>h.team==='A').length===4,'team A has 4 bots + player');
      assert(this.heroes.list.filter(h=>h.team==='B').length===5,'team B has 5 bots');
      assert(new Set(this.heroes.list.map(h=>h.name)).size===9,'bot names must be unique');
      assert(this.dm.scores.size>=10,'scoreboard should list all combatants');
      this.toMenu();
    });
    await run('online-rogue-side',()=>{
      this.ui.sel.mode='online';
      this._pendingNet={team:'B',faction:'t',map:this.ui.sel.map,
        rows:[{name:this.playerName,team:'B',me:true,id:'me',op:'raven'}],timer:180,winKills:25,isHost:true,
        setup:{sizes:{A:5,B:5},humans:{A:0,B:0},playerTeam:'B',roster:[],bots:[],isHost:true,online:true}};
      this.startGame();
      assert(this.playerTeam==='B','local player should be on team B');
      assert(this.playerFaction==='t','team B is Rogue online');
      const a=this.heroes.list.find(h=>h.team==='A'),b=this.heroes.list.find(h=>h.team==='B');
      assert(a&&a.faction==='ct'&&b&&b.faction==='t','online sides are fixed A=NOVA / B=ROGUE');
      this.toMenu();
    });
    if(window.__loopback){
      const wait=ms=>new Promise(r=>setTimeout(r,ms));
      const peer=window.__loopback.createClient();
      const seen=[];
      for(const k of [S.HELLO,S.ROOM,S.START,S.KILL,S.HOST,S.END])
        peer.on(k,m=>seen.push({t:k,m}));
      await run('net-loopback-room',async()=>{
        this.ui.sel.mode='online';this.ui.sel.map='desert';
        this.netMatch.client.connect('ws://loopback');
        this.netMatch.createRoom();
        await wait(15);
        assert(this.netMatch.me&&this.netMatch.me.id,'host should receive s:hello');
        assert(this.netMatch.room&&this.netMatch.room.code==='LOOP1','room code should be LOOP1');
        assert(this.netMatch.isHost,'creator is host');
        peer.connect('ws://loopback',{t:C.JOIN,code:'LOOP1',name:'Guest',op:'raven',ver:1});
        await wait(15);
        assert(this.netMatch.room.roster.length===2,'two humans in the room, got '+this.netMatch.room.roster.length);
      });
      await run('net-loopback-start',async()=>{
        this.netMatch.setReady(true);peer.send(C.READY,{r:1});
        await wait(15);
        this.netMatch.start();
        await wait(20);
        this.player.god=true;this.invulnT=99; // keep the deterministic kill-relay test unambiguous
        assert(this.mode==='online'&&this.netMatch.active,'both clients should enter the online match');
        assert(this.heroes.list.length===9,'2 humans + 1 AI fill to 9 combatants, got '+this.heroes.list.length);
        assert(this.heroes.list.filter(h=>h.netDriven&&h.kind==='human').length===1,'one remote human proxy');
        assert(this.heroes.list.filter(h=>h.netId&&String(h.netId).startsWith('b')).length===8,'8 replicated bots');
      });
      await run('net-peer-moves',async()=>{
        const guestId=seen.find(x=>x.t===S.HELLO)?.m.id;
        const h=guestId&&this.heroes.byNetId(guestId);
        assert(h&&h.netBuf,'remote human proxy should exist');
        peer.send(C.SNAP,{s:[guestId,350,0,-240,0,0,100,1]});
        await wait(15);
        assert(h.netBuf.n>0,'remote snapshot should land in the interpolation buffer');
        const s=h.netBuf.sample(this.netMatch.renderTime(),'human');
        assert(s&&Math.abs(s.x-3.5)<.02,'interpolated x should match the snapshot, got '+(s&&s.x));
      });
      await run('net-kill-relayed',async()=>{
        const guestId=seen.find(x=>x.t===S.HELLO)?.m.id;
        const before=[...this.dm.scores.values()].find(r=>r.id===this.netMatch.me.id)?.kills||0;
        peer.send(C.DIED,{killer:this.netMatch.me.id,w:'m4a4',seq:99});
        await wait(15);
        const after=[...this.dm.scores.values()].find(r=>r.id===this.netMatch.me.id)?.kills||0;
        assert(after===before+1,'DO kill broadcast should increment the local player score, '+before+'→'+after);
        assert(this.ui.errors.length===0||!this.ui.errors.some(e=>e.startsWith('ERR')),'no runtime errors');
      });
      await run('net-host-migration',async()=>{
        let promoted=false;
        peer.on(S.HOST,()=>{promoted=true;});
        this.netMatch.client.close();
        await wait(15);
        assert(promoted,'the remaining client should be promoted to host');
        peer.close();
      });
    }

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

/* Loading screen → menu. It painted while this bundle was still downloading; fade it out once the
   first frame can be rendered and drop it from the DOM. */
function dismissBoot(){
  const boot=$('boot');
  if(!boot||boot.classList.contains('done'))return;
  boot.classList.add('done');
  setTimeout(()=>{if(boot.parentNode)boot.parentNode.removeChild(boot);},700);
}

new Game();
