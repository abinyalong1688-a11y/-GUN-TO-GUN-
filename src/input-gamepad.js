// input-gamepad.js — M4-P2 gamepad support:
//   left stick move / right stick look / RT fire / LT aim / A jump / B crouch / X reload / Y switch weapon;
//   dead zone 0.18, buttons trigger on the edge, completely silent without a gamepad.
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
    // Gamepad and mouse/keyboard are merged, not overwritten: polling must not clear a held mouse fire
    const rtDown=!!(rt&&(rt.pressed||rt.value>.4));
    const ltDown=!!(lt&&(lt.pressed||lt.value>.4));
    g.input.firing=g._mouseFire||rtDown;
    g.input.ads=g._mouseAds||ltDown;

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

  // Sync button references before polling so _edge can read them
  sync(pad){this.gamePadButtons=pad.buttons;}
}
