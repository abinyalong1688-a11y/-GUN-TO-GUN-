// input.js —— 输入抽象:
//   InputManager 统一挂载/更新适配器;KeyboardMouseAdapter 承接原 _setupInput 的键鼠监听。
//   游戏状态仍是 game.keys / game.input,Player/Weapon 无需感知输入来源。
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
      if(e.code==='Tab'){e.preventDefault();if(g.state==='playing'&&g.mode==='dm')g._showBoard();}
      if(e.code==='Tab')return;

      // 蹲伏切换模式:Control 键锁存(再按一次站起),不参与按住判定
      const toggle=g.settings&&g.settings.get('crouchToggle');
      if(toggle&&(e.code==='ControlLeft'||e.code==='ControlRight')){
        if(e.repeat)return;
        if(g.keys.has(e.code))g.keys.delete(e.code);else g.keys.add(e.code);
        return;
      }

      g.keys.add(e.code);
      if(g.state!=='playing')return;
      if(e.code==='KeyR')g.weapon.switchT<0&&g.weapon.startReload();
      if(e.code==='Digit1')g.weapon.switchTo(0);                            // 主武器槽(反复按循环 4 把)
      if(e.code==='Digit2')g.weapon.switchTo(g.weapon.primaryCount);        // 沙漠之鹰
      if(e.code==='Digit3')g.weapon.switchTo(g.weapon.primaryCount+1);      // 军刀
      if(e.code==='Escape'&&g.fallbackAim)g.pause();
    });

    this._on(window,'keyup',e=>{
      const toggle=g.settings&&g.settings.get('crouchToggle');
      if(toggle&&(e.code==='ControlLeft'||e.code==='ControlRight'))return;
      g.keys.delete(e.code);
      if(e.code==='Tab')g.ui.hideBoard();
    });

    this._on(window,'mousedown',e=>{
      if(g.state!=='playing')return;
      if(e.button===0)g.input.firing=true;
      if(e.button===2){
        // U1:ADS 切换模式下右键开/关镜,默认按住开镜
        const toggle=g.settings&&g.settings.get('adsToggle');
        g.input.ads=toggle?!g.input.ads:true;
      }
    });

    this._on(window,'mouseup',e=>{
      if(e.button===0)g.input.firing=false;
      if(e.button===2){
        const toggle=g.settings&&g.settings.get('adsToggle');
        if(!toggle)g.input.ads=false;
      }
    });

    // 滚轮换枪:下滚下一把,上滚上一把(循环)
    this._on(window,'wheel',e=>{
      if(g.state!=='playing')return;
      e.preventDefault();
      const n=g.weapon.defs.length;
      g.weapon.switchTo((g.weapon.cur+(e.deltaY>0?1:n-1))%n);
    },{passive:false});

    this._on(window,'contextmenu',e=>e.preventDefault());

    this._on(window,'mousemove',e=>{
      g._mx=e.clientX;g._my=e.clientY;
      if(g.state!=='playing')return;
      if(!document.pointerLockElement&&!g.fallbackAim)return;
      g.applyLook(e.movementX,e.movementY);
    });

    this._on(document,'pointerlockchange',()=>{
      if(!document.pointerLockElement&&g.state==='playing'&&!g.fallbackAim)g.pause();
    });

    this._on(document,'pointerlockerror',()=>{g.fallbackAim=true;});
  }

  detach(){
    for(const [t,type,fn,opts] of this._handlers)t.removeEventListener(type,fn,opts);
    this._handlers.length=0;
  }
}
