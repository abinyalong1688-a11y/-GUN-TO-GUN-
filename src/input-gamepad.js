// input-gamepad.js —— M4-P2 手柄适配:
//   左摇杆移动 / 右摇杆视角 / RT 开火 / LT 开镜 / A 跳 / B 蹲 / X 换弹 / Y 切枪;
//   死区 0.18,按键沿触发,无手柄时完全静默。
export const PAD_MAP={
  axes:{move:'0/1',look:'2/3',deadzone:.18},
  buttons:{A:'jump',B:'crouch',X:'reload',Y:'switch',LT:'ads',RT:'fire'},
};

export class GamepadAdapter{
  constructor(game){
    this.game=game;
    this.prev={};
    this.deadzone=.18;
  }

  update(dt){this.poll(dt);}

  poll(dt){
    if(typeof navigator==='undefined'||!navigator.getGamepads)return;
    const pads=navigator.getGamepads();
    let pad=null;
    for(const p of pads)if(p&&p.connected){pad=p;break;}
    if(!pad)return;
    const g=this.game;
    this.gamePadButtons=pad.buttons;

    const ax=pad.axes[0]||0,ay=pad.axes[1]||0;
    this._key('KeyA',ax<-.18);this._key('KeyD',ax>.18);
    this._key('KeyW',ay<-.18);this._key('KeyS',ay>.18);

    const rx=pad.axes[2]||0,ry=pad.axes[3]||0;
    if(Math.hypot(rx,ry)>.18)g.applyLook(rx*dt*950,ry*dt*950);

    const rt=pad.buttons[7],lt=pad.buttons[6];
    g.input.firing=!!(rt&&(rt.pressed||rt.value>.4));
    g.input.ads=!!(lt&&(lt.pressed||lt.value>.4));

    this._edge(0,()=>g.keys.add('Space'),()=>g.keys.delete('Space'));
    this._edge(1,()=>g.keys.add('ControlLeft'),()=>g.keys.delete('ControlLeft'));
    this._edge(2,()=>g.weapon.startReload());
    this._edge(3,()=>g.weapon.switchTo((g.weapon.cur+1)%g.weapon.defs.length));
  }

  _key(code,on){
    if(on)this.game.keys.add(code);else this.game.keys.delete(code);
  }

  _edge(i,down,up){
    const b=this.gamePadButtons&&this.gamePadButtons[i];
    const pressed=!!(b&&(b.pressed||b.value>.4));
    if(pressed&&!this.prev[i]&&down)down();
    if(!pressed&&this.prev[i]&&up)up();
    this.prev[i]=pressed;
  }

  // poll 前同步按钮引用,便于 _edge 读取
  sync(pad){this.gamePadButtons=pad.buttons;}
}
