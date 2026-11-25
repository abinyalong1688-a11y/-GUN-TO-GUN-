// input.js — input abstraction:
//   InputManager mounts/updates adapters; KeyboardMouseAdapter holds the keyboard/mouse listeners formerly in _setupInput.
//   Game state is still game.keys / game.input, so Player/Weapon do not care where input comes from.
export class InputManager{
  constructor(game){
    this.game=game;
    this.adapters=[];
  }
  attach(adapter){
    this.adapters.push(adapter);
    adapter.attach&&adapter.attach();
    return adapter;
  }
  update(dt){
    for(const a of this.adapters)a.update&&a.update(dt);
  }
  detachAll(){
    for(const a of this.adapters)a.detach&&a.detach();
    this.adapters.length=0;
  }
}

export class KeyboardMouseAdapter{
  constructor(game){
    this.game=game;
    this._handlers=[];
  }

  _on(target,type,fn,opts){
    target.addEventListener(type,fn,opts);
    this._handlers.push([target,type,fn,opts]);
  }

  attach(){
    const g=this.game;

    this._on(window,'keydown',e=>{
      // M3-G3: number keys pick an upgrade while the upgrade screen is open
      if(g.state==='upgrade'&&/^Digit[123]$/.test(e.code)){
        g._pickUpgrade(+e.code.slice(-1)-1);return;
      }
      // Online pause / 3 s countdown: freeze local input without stopping the match.
      if(g._uiLock&&e.code!=='Tab'&&e.code!=='Escape')return;
      if(e.code==='Tab'){e.preventDefault();if(g.state==='playing'&&g.isArena&&g.isArena())g._showBoard();}
      if(e.code==='Tab')return;

      // Toggle-crouch mode: Control latches (press again to stand), excluded from hold detection
      const toggle=g.settings&&g.settings.get('crouchToggle');
      if(toggle&&(e.code==='ControlLeft'||e.code==='ControlRight')){
        if(e.repeat)return;
        if(g.keys.has(e.code))g.keys.delete(e.code);else g.keys.add(e.code);
        return;
      }

      g.keys.add(e.code);
      if(g.state!=='playing')return;
      if(e.code==='KeyR')g.weapon.switchT<0&&g.weapon.startReload();
      if(e.code==='Digit1')g.weapon.switchTo(0);                            // primary slot (press repeatedly to cycle all 4)
      if(e.code==='Digit2')g.weapon.switchTo(g.weapon.primaryCount);        // Desert Eagle
      if(e.code==='Digit3')g.weapon.switchTo(g.weapon.primaryCount+1);      // UMP-45 backup SMG
      // M3-G1: grenades — G frag / F flash / V smoke
      if(e.code==='KeyG'&&g.grenades)g.grenades.throw('frag');
      if(e.code==='KeyF'&&g.grenades)g.grenades.throw('flash');
      if(e.code==='KeyV'&&g.grenades)g.grenades.throw('smoke');
      if(e.code==='Escape'&&g.fallbackAim)g.pause();
    });

    this._on(window,'keyup',e=>{
      const toggle=g.settings&&g.settings.get('crouchToggle');
      if(toggle&&(e.code==='ControlLeft'||e.code==='ControlRight'))return;
      g.keys.delete(e.code);
      if(e.code==='Tab')g.ui.hideBoard();
    });

    this._on(window,'mousedown',e=>{
      if(g.state!=='playing'||g._uiLock)return;
      if(e.button===0){g.input.firing=true;g._mouseFire=true;}
      if(e.button===2){
        // U1: in toggle-ADS mode right click toggles the scope; default is hold-to-aim
        const toggle=g.settings&&g.settings.get('adsToggle');
        g._mouseAds=toggle?!g._mouseAds:true;
        g.input.ads=g._mouseAds;
      }
    });

    this._on(window,'mouseup',e=>{
      if(e.button===0){g.input.firing=false;g._mouseFire=false;}
      if(e.button===2){
        const toggle=g.settings&&g.settings.get('adsToggle');
        if(!toggle){g._mouseAds=false;g.input.ads=false;}
      }
    });

    // Mouse wheel cycles weapons: down = next, up = previous (wraps)
    this._on(window,'wheel',e=>{
      if(g.state!=='playing'||g._uiLock)return;
      e.preventDefault();
      const n=g.weapon.defs.length;
      g.weapon.switchTo((g.weapon.cur+(e.deltaY>0?1:n-1))%n);
    },{passive:false});

    this._on(window,'contextmenu',e=>e.preventDefault());

    this._on(window,'mousemove',e=>{
      g._mx=e.clientX;g._my=e.clientY;
      if(g.state!=='playing'||g._uiLock)return;
      if(!document.pointerLockElement&&!g.fallbackAim)return;
      g.applyLook(e.movementX,e.movementY);
    });

    this._on(document,'pointerlockchange',()=>{
      // Lock lost while playing = the user pressed ESC → industry-standard auto-pause.
      // The game's own unlocks (DM death spectate) set _suppressPauseOnce so they don't pop the pause menu.
      if(!document.pointerLockElement&&g.state==='playing'&&!g.fallbackAim){
        if(g._suppressPauseOnce)g._suppressPauseOnce=false;
        else if(g.netMatch&&g.netMatch.active&&g.netMenu)g.netMenu();
        else g.pause();
      }
      if(g._updateCursor)g._updateCursor();
    });

    this._on(document,'pointerlockerror',()=>{g.fallbackAim=true;if(g._updateCursor)g._updateCursor();});

    // Click to (re)lock while the hint "click to lock mouse" is showing: cursor is visible exactly when a click is needed
    this._on(g.renderer.domElement,'click',()=>{
      if(g.state==='playing'&&!document.pointerLockElement&&!g.fallbackAim)g._requestLock();
    });
  }

  detach(){
    for(const [t,type,fn,opts] of this._handlers)t.removeEventListener(type,fn,opts);
    this._handlers.length=0;
  }
}
