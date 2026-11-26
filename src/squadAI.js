// squadAI.js — squad command layer on top of the per-bot brain (botBrain.js).
//
// The brain is the "execution layer": perception, target choice, aiming, firing, fight footwork,
// cover, local avoidance and path recovery all stay where they were. This module adds a commander
// above it (src/botai/): a global nav grid, a tactical map (lanes / cover / entrances / defensive
// positions), an influence map and a squad director that hands every local bot an ORDER:
//   move to (x,z) and look at (x,z) — or hold a position facing an entrance.
// The brain follows an order only from its idle branch (actPatrol); the moment it sees, hears or
// is hit by an enemy its own combat subtree takes over, and it resumes the order afterwards.
//
// Integration is explicit (no runtime monkey-patching): main.js calls update() once per frame
// before the bots think, and reports kills / shots from the places where they happen.
//
// What the layer learns:
//   · in-match: which attack plan works (Thompson bandit), where the enemies like to show up
//     (opponent route model), whether each bot is landing its shots (engagement-range tuner);
//   · across matches (offline / local bots only): plan statistics and a bounded difficulty
//     controller (0.8–1.25× on reaction / aim / pause) that keeps the human's win rate near 50 %.
//   Online rooms get tactics only — the host's bots must not drift against other human players.
//
// Switches: ?botai=0 turns the whole layer off (the brains fall back to their own patrol).
import {createBotAI} from './botai/index.js';
import {clamp} from './botai/util.js';

export const SQUAD_OFF = typeof location!=='undefined' && new URLSearchParams(location.search).get('botai')==='0';

/* Scrub a name / id for the debug line */
const nm = v => (v == null ? '-' : String(v).slice(0, 14));

export class SquadAI{
  constructor(game){
    this.game=game;
    this.enabled=!SQUAD_OFF;
    this.ai=null;            // {nav,inf,tac,learning,director} for the current map
    this.mapKey=null;
    this.units=new Map();    // hero → unit (what the director sees)
    this.time=0;             // own clock: game.time restarts with every match
    this.learn=false;        // cross-match memory + difficulty (offline / local bots only)
    this.kills={A:0,B:0};
    this._seenT=new Map(); this._shotT=new Map(); this._paramT=-9;
    this._plUnit={id:'player',team:'A',human:true,order:null,x:0,z:0,hp:100,maxHp:100,alive:false,
      persona:{aggression:.5,patience:.5}};
    this._world={time:0,mode:'dm',escort:null,objective:null,
      teams:{A:{bots:[],spawn:[0,24],isAttacker:true},B:{bots:[],spawn:[0,-24],isAttacker:true}}};
    this._obj={pos:[0,0],radius:8,owner:null,capture:0};
    this._spawn={A:[0,24],B:[0,-24]};
    this._escort=[0,0];
    this.inMatch=false;
    this.stats={dropped:0};
  }

  /* ---------------- map bake (once per map) ---------------- */
  _ensureMap(){
    const g=this.game,w=g.world;
    if(!w||!w.colliders||!w.colliders.length)return false;
    const key=w.mapKey||'default';
    if(this.ai&&this.mapKey===key)return true;
    // The arena is a 52 m circle: a 112 m grid covers it with margin (see NavGrid.circleBound)
    const mode=g.matchMode==='waves'?'waves':(g.matchMode==='koth'?'koth':'dm');
    const t0=(typeof performance!=='undefined'?performance.now():Date.now());
    this.ai=createBotAI({colliders:w.colliders,size:112,cell:.5,radius:.45,circleBound:52,
      mapKey:key,mode,humanTeam:g.playerTeam||'A',seed:11});
    this.ai.director.adaptInterval=.5;
    this.ai.director.reach=2.2;
    this.ai.learning.setContext(key,mode);
    this.ai.learning.humanTeam=g.playerTeam||'A';
    this.ai.learning.diff.humanTeam=g.playerTeam||'A';
    this.mapKey=key;
    this.bakeMs=(typeof performance!=='undefined'?performance.now():Date.now())-t0;
    return true;
  }

  /* ---------------- events (called by main.js / heroes.js / botBrain.js) ---------------- */

  /* A bot or the player died. victim: hero object or 'player'; killerName: null when unknown. */
  onKill(killerName,victim){
    const g=this.game;
    if(!this.ai||!victim)return;
    const isPlayer=victim==='player';
    const vTeam=isPlayer?(g.playerTeam||'A'):victim.team;
    const vp=isPlayer?g.player.pos:victim.pos;
    const u=isPlayer?null:this.units.get(victim);
    // One report per death: the kill hook and the sync pass can both see it
    if(u&&u._deathSeen&&!u.alive)return;
    if(u){u.alive=false;u._deathSeen=true;}
    let killer=null;
    if(killerName){
      if(killerName===g.playerName&&g.player.alive!==false)killer={id:'player',team:g.playerTeam||'A',x:g.player.pos.x,z:g.player.pos.z};
      else{
        const k=g.heroes&&g.heroes.list.find(h=>h.name===killerName&&h!==victim);
        if(k)killer={id:'h'+k.id,team:k.team,x:k.pos.x,z:k.pos.z};
      }
    }
    if(killer)this.kills[killer.team]=(this.kills[killer.team]||0)+1;
    if(this.enabled&&this.inMatch)
      this.ai.director.report('death',{victim:{id:isPlayer?'player':'h'+victim.id,team:vTeam,x:vp.x,z:vp.z},killer});
  }

  /* A local bot fired. hit = the round was not a miss. Feeds the per-bot engagement tuner and
     tells the enemy squad where the fire is coming from (the director throttles it). */
  onBotShot(hero,target,dist,hit){
    if(!this.enabled||!this.ai||!this.inMatch)return;
    const id='h'+hero.id,t=this.time;
    if(this.learn){
      const expected=clamp(.85-(dist||10)/60,.08,.8);
      this.ai.learning.tuner.onShot(id,!!hit,expected);
    }
    const last=this._shotT.get(id);
    if(last!=null&&t-last<.5)return;
    this._shotT.set(id,t);
    this.ai.director.report('shot',{team:hero.team,x:hero.pos.x,z:hero.pos.z,id});
  }

  /* The human opened fire: enemy squads "hear" it. */
  onPlayerShot(){
    if(!this.enabled||!this.ai||!this.inMatch)return;
    const g=this.game,t=this.time,last=this._shotT.get('player');
    if(last!=null&&t-last<.5)return;
    this._shotT.set('player',t);
    this.ai.director.report('shot',{team:g.playerTeam||'A',x:g.player.pos.x,z:g.player.pos.z,id:'player'});
  }

  /* A bot was hit and knows by whom (even without line of sight). enemy: hero or 'player'. */
  onDamaged(bot,enemy,pos){
    if(!this.enabled||!this.ai||!this.inMatch||!enemy)return;
    const g=this.game;
    const team=enemy==='player'?(g.playerTeam||'A'):enemy.team;
    const p=enemy==='player'?g.player.pos:(pos||enemy.pos);
    if(!p)return;
    this.ai.director.report('seen',{team:bot.team,enemy:{id:enemy==='player'?'player':'h'+enemy.id,team,x:p.x,z:p.z}});
  }

  /* ---------------- match lifecycle (main.js: startGame / _endDm / _endMode / toMenu) ---------------- */
  /* Offline and solo-training matches adapt to the human; a room with other human players gets
     tactics only (the host's bots must not drift), and the e2e run stays deterministic. */
  beginMatch(){
    const g=this.game;
    this.kills={A:0,B:0};this.time=0;this.units.clear();
    this._seenT.clear();this._shotT.clear();this._paramT=-9;
    this.learn=!(g.netMatch&&g.netMatch.active)&&!g.e2eMode;
    this.inMatch=true;
    // a fresh match starts with a fresh plan (the director forgets the last round on roundEnd)
    if(this.ai){
      const d=this.ai.director;
      for(const k of ['A','B']){const st=d.teams[k];st.plan=null;st.retake=null;st.heard.length=0;st.seen.length=0;st.laneDeaths={};st.lastOrder={};st.nextAdapt=0;}
    }
  }
  endMatch(){
    if(!this.inMatch)return;
    this.inMatch=false;
    for(const u of this.units.values())u.order=null;
    if(this.ai&&this.enabled)this._endRound();
  }

  /* ---------------- per frame ---------------- */
  update(dt){
    const g=this.game;
    if(!this.enabled||!this.inMatch||g.state!=='playing'||!this._ensureMap())return;
    /* The squad layer is an enhancement: a bug inside it must never take the frame down (the
       game's main loop halts on an uncaught error). Log it, and after repeated failures fall back
       to the brains' own patrol for the rest of the match. */
    try{this._update(dt);}
    catch(err){
      this.failures=(this.failures||0)+1;
      console.error('[SquadAI] update failed ('+this.failures+')',err);
      if(this.failures>=3){this.setEnabled(false);console.error('[SquadAI] disabled for this match after repeated failures');}
      else for(const u of this.units.values())u.order=null;
    }
  }

  _update(dt){
    const g=this.game;
    this.time+=dt;
    this._syncUnits();
    this._syncWorld();
    const d=this.ai.director;
    // Sightings: polled from the brains (a visible target is the strongest intel there is)
    for(const [h,u] of this.units){
      if(!h.alive||!h.brain)continue;
      const b=h.brain;
      if(!(b.target&&b.targetVisible&&b.target.entity))continue;
      const last=this._seenT.get(u.id);
      if(last!=null&&this.time-last<2)continue;
      this._seenT.set(u.id,this.time);
      const e=b.target.entity;
      d.report('seen',{team:u.team,enemy:{id:e==='player'?'player':'h'+e.id,team:e==='player'?(g.playerTeam||'A'):e.team,x:b.target.pos.x,z:b.target.pos.z}});
    }
    d.update(this._world,dt);
    if(this.learn&&this.time-this._paramT>1){this._paramT=this.time;this._applyParams();}
    // Orders that go nowhere (goal behind geometry the grid thinks is reachable) are dropped for a
    // few seconds so the brain's own patrol takes over instead of pushing a wall forever.
    this._watchOrders(dt);
  }

  _syncUnits(){
    const g=this.game,list=g.heroes&&g.heroes.list;
    if(!list)return;
    for(const h of list){
      if(h.kind!=='bot'||h.netDriven||!h.brain)continue;
      let u=this.units.get(h);
      if(!u){
        const p=h.brain.baseParams||h.brain.params||{};
        u={id:'h'+h.id,team:h.team,x:h.pos.x,z:h.pos.z,hp:h.hp,maxHp:h.maxHp,alive:h.alive,human:false,order:null,
          _deathSeen:!h.alive,_bestGoal:Infinity,_goalT:0,_skipUntil:0,
          persona:{aggression:clamp(p.aggression??.5,0,1),
            patience:clamp(1-(p.aggression??.5)+((p.coverBias??.5)-.5)*.6,0,1),aim:.5}};
        this.units.set(h,u);
      }
      if(u.alive&&!h.alive){
        // died without a kill report reaching us (grenade, bleed, scripted test damage)
        if(!u._deathSeen)this.onKill(null,h);
        u.alive=false;
      }else if(!u.alive&&h.alive){u.alive=true;u._deathSeen=false;u._bestGoal=Infinity;u._goalT=this.time;}
      u.x=h.pos.x;u.z=h.pos.z;u.hp=h.hp;u.maxHp=h.maxHp;
    }
    for(const [h,u] of this.units){
      if(!list.includes(h)){this.units.delete(h);if(h.brain)h.brain.squadOrder=null;continue;}
      const skip=u._skipUntil>this.time;
      const o=h.alive&&u.order&&!skip?u.order:null;
      h.brain.squadOrder=o;
      h.orderLabel=o?(o.label||''):'';
    }
  }

  _syncWorld(){
    const g=this.game,w=this._world,pl=g.player;
    w.time=this.time;
    w.mode=g.matchMode==='waves'?'waves':(g.matchMode==='koth'?'koth':'dm');
    const A=w.teams.A,B=w.teams.B;
    A.bots.length=0;B.bots.length=0;
    for(const u of this.units.values())(u.team==='A'?A:B).bots.push(u);
    const pu=this._plUnit;
    if(pl&&pl.alive&&g.playerTeam){
      pu.team=g.playerTeam;pu.x=pl.pos.x;pu.z=pl.pos.z;pu.hp=pl.health;pu.maxHp=pl.maxHealth;pu.alive=true;
      (pu.team==='A'?A:B).bots.push(pu);
    }else pu.alive=false;
    for(const k of ['A','B']){
      const s=g.spawns&&g.spawns[k],sp=this._spawn[k];
      if(s){sp[0]=s.x;sp[1]=s.z;}
      w.teams[k].spawn=s?sp:null;
      w.teams[k].isAttacker=w.mode==='waves'?k!==(g.playerTeam||'A'):true;
    }
    if(w.mode==='koth'&&g.koth&&g.koth.active){
      const o=this._obj;
      o.pos[0]=g.koth.pos.x;o.pos[1]=g.koth.pos.z;o.radius=g.koth.radius||8;
      o.owner=g.koth.owner||null;o.capture=g.koth.capture||0;
      w.objective=o;
    }else w.objective=null;
    if(w.mode==='waves'&&pl){this._escort[0]=pl.pos.x;this._escort[1]=pl.pos.z;w.escort=this._escort;}
    else w.escort=null;
  }

  /* Learning → combat parameters. Each brain owns a private copy of its parameter set, so a
     tuned bot never leaks into its teammates (the presets themselves are shared and read-only). */
  _applyParams(){
    const L=this.ai.learning;
    for(const [h,u] of this.units){
      const b=h.brain,base=b.baseParams;
      if(!base||!b.params||!Array.isArray(base.range))continue;
      const p=b.params;
      for(const k of Object.keys(base))if(k!=='range')p[k]=base[k];
      p.range[0]=base.range[0]*L.tuner.rangeMul(u.id);
      p.range[1]=base.range[1]*L.tuner.rangeMul(u.id);
      p.aggression=clamp(base.aggression*L.tuner.aggrMul(u.id),0,1);
      L.diff.apply(p);
    }
  }

  /* Global A* route for a bot whose own 10 m planner found no way (spawn pockets behind the big
     buildings on the dock / caldera maps used to hold a bot at its spawn for a whole match while
     it "engaged" someone across the map). Cached per bot for 0.7 s. Returns [[x,z], …] from the
     bot to the goal, or null. A goal inside geometry is snapped to the nearest walkable cell. */
  route(hero,gx,gz){
    if(!this.ai||!this.enabled)return null;
    const u=this.units.get(hero);
    if(!u||!u.alive)return null;
    const nav=this.ai.nav,kx=Math.round(gx*2),kz=Math.round(gz*2),c=u._routeCache;
    if(c&&c.kx===kx&&c.kz===kz&&this.time-c.t<.7&&Math.hypot(c.x-u.x,c.z-u.z)<3)return c.pts;
    let tx=gx,tz=gz;
    if(!nav.isFree(tx,tz,1)){
      const [cx,cy]=nav.worldToCell(tx,tz),f=nav.nearestFree(cx,cy,1,16);
      if(!f){u._routeCache={kx,kz,t:this.time,x:u.x,z:u.z,pts:null};return null;}
      [tx,tz]=nav.cellToWorld(f[0],f[1]);
    }
    const pts=nav.findPath(u.x,u.z,tx,tz,{marginCells:1,maxIter:20000});
    if(pts&&pts.length>1){pts[pts.length-1]=[tx,tz];pts.shift();} // drop "where the bot stands"
    u._routeCache={kx,kz,t:this.time,x:u.x,z:u.z,pts:pts&&pts.length?pts:null};
    this.stats.routes=(this.stats.routes||0)+1;
    return pts&&pts.length?pts:null;
  }

  /* An order only counts as "not progressing" while the brain is actually following it (idle
     branch) — a bot that is fighting, reloading or chasing a sound is not disobeying. */
  _watchOrders(dt){
    for(const [h,u] of this.units){
      const o=u.order;
      if(!u.alive||!o||o.kind!=='move'||!h.brain||h.brain.state!=='patrol'){u._bestGoal=Infinity;continue;}
      const d=Math.hypot(u.x-o.goal[0],u.z-o.goal[1]);
      if(d<u._bestGoal-.5){u._bestGoal=d;u._goalT=this.time;}   // real progress
      else if(this.time-u._goalT>5&&d>2.5){                       // 5 s without getting closer
        u._skipUntil=this.time+3;u._bestGoal=d;u._goalT=this.time;this.stats.dropped=(this.stats.dropped||0)+1;
      }
    }
  }

  _endRound(){
    const d=this.ai.director,w=this._winner();
    if(this.learn)d.report('roundEnd',{winner:w,killsA:this.kills.A,killsB:this.kills.B});
    // The finished round's plan, sightings and temporary orders do not carry into the next one
    for(const k of ['A','B']){const s=d.teams[k];s.plan=null;s.retake=null;s.heard.length=0;s.seen.length=0;s.laneDeaths={};s.swaps=0;s.lastOrder={};}
  }

  _winner(){
    const g=this.game;
    if(g.matchMode==='koth'&&g.koth&&g.koth.score)return g.koth.score.A>g.koth.score.B?'A':g.koth.score.B>g.koth.score.A?'B':null;
    if(g.dm&&g.dm.scores){
      let a=0,b=0;
      for(const s of g.dm.scores.values()){if(s.team==='A')a+=s.kills;else b+=s.kills;}
      return a>b?'A':b>a?'B':null;
    }
    if(g.matchMode==='waves')return g.player&&g.player.alive?(g.playerTeam||'A'):(g.playerTeam==='A'?'B':'A');
    return null;
  }

  /* Console summary (also exposed as window.__squadAI under ?debug) */
  debug(){
    if(!this.ai)return 'SquadAI: map not baked yet';
    const d=this.ai.director,team=k=>{
      const p=d.teams[k].plan;
      return `${k}:${p?p.kind+'/'+p.strategy:'-'} bots=${[...this.units.values()].filter(u=>u.team===k&&u.alive).length}`;
    };
    const diff=this.learn?this.ai.learning.report().difficulty:null;
    return [`SquadAI ${this.mapKey} mode=${this._world.mode} t=${this.time.toFixed(0)}s learn=${this.learn}`,
      `${team('A')} | ${team('B')}`,
      `plans=${d.stats.plans} rotations=${d.stats.rotations} retakes=${d.stats.retakes} trades=${d.stats.trades} dropped=${this.stats.dropped||0}`,
      diff?`difficulty skill=${diff.skill} humanWinEMA=${diff.humanWinEMA}`:'',
      ...[...this.units.values()].filter(u=>u.alive).map(u=>`  ${u.id}[${u.team}] ${u.order?(u.order.label||u.order.kind):'-'}`)].filter(Boolean).join('\n');
  }

  setEnabled(v){
    this.enabled=!!v;
    if(!v)for(const u of this.units.values())u.order=null;
  }
}
