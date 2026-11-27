// botBrain.js — perception + behavior tree + combat intent for one deathmatch bot.
//
// Replaces the old "nearest enemy → shoot" if-chain with four cooperating layers:
//   BotSensor   sees/hears/remembers enemies (botPerception.js)
//   Selector    chooses the current target from sight first, then memory (botCombat.js score)
//   BehaviorTree decides between reload / retreat / engage / search / patrol (botBehaviorTree.js)
//   Intent      publishes movement, facing and fire requests that HeroBot applies through the
//               existing collision, detour and animation code.
//
// The brain never touches the scene graph: it only reads entity positions and calls
// bot.fire-facing helpers, so it stays deterministic and unit-testable.
import * as THREE from 'three';
import {BTStatus, Selector, Sequence, Parallel, Condition, Action} from './botBehaviorTree.js';
import {BotSensor} from './botPerception.js';
import {getBotParams} from './botConfig.js';
import {leadPoint, aimErrorOffset, shotMissChance, findBestCover, scoreTarget, isPointClear, teammateBlockingShot} from './botCombat.js';

const _lead = new THREE.Vector3();
const _err = new THREE.Vector3();
const _eye = new THREE.Vector3();

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* The decision tree. Priorities: finish/perform a reload, break contact when hurt, engage a
   visible threat, search the last known position, otherwise patrol toward the objective. */
export function buildBotTree() {
  return new Selector([
    new Sequence([
      new Condition((b, c) => c.needsReload(b)),
      new Action((b, c) => c.actReload(b)),
    ]),
    new Sequence([
      new Condition((b, c) => c.shouldRetreat(b)),
      new Action((b, c) => c.actRetreat(b)),
    ]),
    new Sequence([
      new Condition((b, c) => c.hasVisibleTarget()),
      new Parallel([
        new Action((b, c) => c.actAimFire(b)),
        new Action((b, c) => c.actFightMove(b)),
      ]),
    ]),
    new Sequence([
      new Condition((b, c) => c.hasSuspicion()),
      new Action((b, c) => c.actSearch(b)),
    ]),
    new Action((b, c) => c.actPatrol(b)),
  ]);
}

export class BotBrain {
  constructor(bot) {
    this.bot = bot;
    this.difficulty = bot.difficulty || 'normal';
    /* The preset is a shared, read-only cache. The brain works on its OWN copy, so the squad
       layer can tune one bot's engagement range / aggression without touching its teammates. */
    this.baseParams = getBotParams(this.difficulty, bot.faction);
    this.params = { ...this.baseParams, range: this.baseParams.range.slice() };
    this.sensor = new BotSensor();
    this.sensor.obscured = p => !!(bot.game && bot.game.grenades && bot.game.grenades.inSmoke(p));
    this.tree = buildBotTree();
    this.now = 0;
    this.dt = 0;
    this.losCheck = null;
    this.senseT = 1; // sense immediately on the first tick
    this.target = null;
    this.targetId = null;
    this.targetVisible = false;
    this.targetDist = Infinity;
    this.aimPoint = new THREE.Vector3();
    this.hasAim = false;
    this.aimSettle = 0;
    this.facePoint = null;
    this.faceYaw = null;
    this.mode = 'hold';
    this.moveX = 0;
    this.moveZ = 0;
    this.navGoal = null;
    this.navSpeed = 1;
    this.state = 'idle';
    this.retreatUntil = -1;
    this._retreatReadyAt = 0;
    this._wasVisible = false;
    this._coverWanted = false;
    this._scanT = 0;
    this._patrolGoal = null;
    this._patrolT = 0;
    this._patrolWait = 0;
    this._patrolVec = new THREE.Vector3();
    this._navGoalVec = new THREE.Vector3();
    this._inRange = false;
    this._candidates = [];
    this.blockedLineT = 0;   // fire temporarily held: a friendly body is on the line
    this.blockedBy = null;
    /* Squad command layer (squadAI.js): the order this bot is currently given, or null. It is
       only followed from the idle branch (actPatrol) — combat always comes first. */
    this.squadOrder = null;
    this._squadGoal = new THREE.Vector3();
    this._squadLook = new THREE.Vector3();
  }

  /* Respawn / operator swap: drop every memory and intent, keep the cached parameters. */
  reset() {
    this.sensor.clear();
    this.tree.reset();
    this.target = null;
    this.targetId = null;
    this.targetVisible = false;
    this.targetDist = Infinity;
    this.hasAim = false;
    this.aimSettle = 0;
    this.facePoint = null;
    this.faceYaw = null;
    this.mode = 'hold';
    this.moveX = 0;
    this.moveZ = 0;
    this.navGoal = null;
    this.state = 'idle';
    this.retreatUntil = -1;
    this._retreatReadyAt = 0;
    this._wasVisible = false;
    this._scanT = 0;
    this._patrolGoal = null;
    this._patrolT = 0;
    this._patrolWait = 0;
    this._inRange = false;
    this.blockedLineT = 0;
    this.blockedBy = null;
    this.senseT = 1;
  }

  /* Called by HeroBot.takeDamage with the attacker's position (exact for the player's shot). */
  onDamaged(pos, entity, time) {
    if (!pos) return;
    // Intel for the squad layer: hit by someone it may not even see yet
    if (this.bot.game && this.bot.game.squad) this.bot.game.squad.onDamaged(this.bot, entity, pos);
    const id = entity === 'player' ? 'player' : (entity ? 'h' + entity.id : null);
    if (id) {
      const team = entity === 'player' ? this.bot.game.playerTeam : entity.team;
      this.sensor.alert(id, pos, time, {noise: .7, entity: entity === 'player' ? 'player' : entity, team});
    }
    const hp = this.bot.hp / this.bot.maxHp;
    if (hp < this.params.lowHealthThresh) {
      this.retreatUntil = time + this.params.retreatHold;
      this._retreatReadyAt = time + this.params.retreatHold * 2;
      this.bot.coverTarget = null;
      this.bot.coverT = 0;
    } else if (hp < .65) {
      this.retreatUntil = Math.max(this.retreatUntil, time + this.params.retreatHold * .4);
    }
  }

  /* ---------------- main tick ---------------- */

  update(dt, time, losCheck) {
    const bot = this.bot;
    this.now = time;
    this.dt = dt;
    this.losCheck = losCheck;
    if (bot.difficulty && (bot.difficulty !== this.difficulty || bot.faction !== this.params.faction)) {
      this.difficulty = bot.difficulty;
      this.baseParams = getBotParams(this.difficulty, bot.faction);
      this.params = { ...this.baseParams, range: this.baseParams.range.slice() };
    }
    if (bot.reactionT > 0) bot.reactionT = Math.max(0, bot.reactionT - dt);
    if (bot.fireT > 0) bot.fireT = Math.max(0, bot.fireT - dt);
    if (bot.coverT > 0) bot.coverT = Math.max(0, bot.coverT - dt);
    if (this.blockedLineT > 0) {
      this.blockedLineT = Math.max(0, this.blockedLineT - dt);
      if (this.blockedLineT === 0) this.blockedBy = null;
    }

    this._sense(dt, time, losCheck);
    this._selectTarget(time);
    this._updateAim(dt, time);

    // Fresh intent every tick; actions below overwrite what they need.
    this.state = 'idle';
    this.mode = 'hold';
    this.moveX = 0;
    this.moveZ = 0;
    this.navGoal = null;
    this.navSpeed = 1;
    this.facePoint = null;
    this.faceYaw = null;
    this._coverWanted = false;

    this.tree.tick(bot, this);

    if (!this._coverWanted) bot.coverTarget = null;
    if (this.state !== 'search') this._scanT = 0;
    bot.hasTarget = !!this.target;
    bot._targetId = this.targetId;
  }

  /* ---------------- perception ---------------- */

  _sense(dt, time, losCheck) {
    this.senseT += dt;
    const interval = Math.max(.03, this.params.senseInterval || .1);
    if (this.senseT < interval) return;
    this.senseT = 0;
    const bot = this.bot;
    const list = this._candidates;
    list.length = 0;
    for (const h of bot.game.heroes.list) {
      if (h === bot || !h.alive || h.team === bot.team) continue;
      list.push({
        id: 'h' + h.id, entity: h, team: h.team,
        pos: h.pos, vel: h.vel, hp: h.hp, maxHp: h.maxHp,
        point: {x: h.pos.x, y: h.pos.y + 1.1, z: h.pos.z},
      });
    }
    const pl = bot.game.player;
    const playerTeam = bot.game.playerTeam || 'A';
    if (pl && pl.alive && playerTeam !== bot.team) {
      list.push({
        id: 'player', entity: 'player', team: playerTeam,
        pos: pl.pos, vel: pl.vel, hp: pl.health, maxHp: pl.maxHealth,
        point: {x: pl.pos.x, y: pl.pos.y + 1.35, z: pl.pos.z},
      });
    }
    this.sensor.sense(bot, list, time, losCheck, this.params);
    this._hearGunfire(time);
  }

  /* Gunshots give away an approximate position — the counter to being shot from behind. */
  _hearGunfire(time) {
    const bot = this.bot;
    const game = bot.game;
    const hear2 = this.params.hearing * this.params.hearing;
    for (const h of game.heroes.list) {
      if (!h.alive || h.team === bot.team) continue;
      if (!(h._shotT > 0) || time - h._shotT > 1.1) continue;
      if (bot.pos.distanceToSquared(h.pos) > hear2) continue;
      this.sensor.hear('h' + h.id, h.pos, time, {noise: 2.2, entity: h, team: h.team});
    }
    if (game.playerShotT > 0 && time - game.playerShotT <= 1.1 && game.player.alive && (game.playerTeam || 'A') !== bot.team) {
      if (bot.pos.distanceToSquared(game.player.pos) <= hear2) {
        this.sensor.hear('player', game.player.pos, time, {noise: 2.8, entity: 'player', team: game.playerTeam || 'A'});
      }
    }
  }

  _selectTarget(time) {
    const bot = this.bot;
    const visible = this.sensor.visible(time);
    let pool = visible;
    if (!pool.length) pool = this.sensor.suspicions(time, this.params);
    let best = null, bestScore = -Infinity;
    for (const e of pool) {
      if (e.entity && e.entity !== 'player' && e.entity.alive === false) continue;
      if (e.entity === 'player' && !bot.game.player.alive) continue;
      const s = scoreTarget(e, bot.pos, time, this.targetId);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best) {
      this.target = null;
      this.targetId = null;
      this.targetVisible = false;
      this.targetDist = Infinity;
      this._wasVisible = false;
      return;
    }
    const id = best.id;
    if (id !== this.targetId) {
      this.targetId = id;
      bot.bark('bark_spot');
      this.aimSettle = 0;
      bot.burst = 0;
      bot.reactionT = this.params.reaction * (best.visible ? 1 : this.params.reactionSpread);
      this._scanT = 0;
      this._inRange = false;
    } else if (best.visible && !this._wasVisible) {
      // Re-acquired after losing sight: a short fresh-aim delay, not the full reaction time.
      bot.reactionT = Math.max(bot.reactionT, this.params.reaction * .5);
      this.aimSettle = Math.min(this.aimSettle, .35);
    }
    this.target = best;
    this.targetVisible = !!best.visible;
    this.targetDist = Math.hypot(best.pos.x - bot.pos.x, best.pos.z - bot.pos.z);
    this._wasVisible = !!best.visible;
    // Respawn/target-death race: drop the reference immediately instead of shooting a corpse
    // for the few milliseconds until the next sensing tick prunes it.
    if (best.entity && best.entity !== 'player' && best.entity.alive === false) {
      this.target = null;
      this.targetId = null;
      this.targetVisible = false;
    }
  }

  _updateAim(dt, time) {
    const t = this.target;
    this.hasAim = false;
    if (!t) { this.aimSettle = 0; return; }
    if (t.visible) {
      _eye.set(this.bot.pos.x, this.bot.pos.y + 1.4, this.bot.pos.z);
      leadPoint(_eye, t.point, t.vel, this.params.lead, _lead);
      aimErrorOffset(this.params, this.aimSettle, this.targetDist, _err);
      this.aimPoint.copy(_lead).add(_err);
      if (this.aimPoint.y < .3) this.aimPoint.y = .3;
      this.hasAim = true;
      this.aimSettle = Math.min(1, this.aimSettle + dt / Math.max(.05, this.params.aimTime));
    } else {
      // Memory: look where the target was last seen/heard (peeking around cover).
      this.aimPoint.copy(t.point);
      this.hasAim = true;
      this.aimSettle = Math.max(0, this.aimSettle - dt * .8);
    }
  }

  /* ---------------- conditions ---------------- */

  needsReload(bot) {
    if (bot.reloadT > 0) return true;
    if (bot.ammo <= 0) return true;
    const frac = bot.ammo / Math.max(1, bot.magSize);
    if (this.targetVisible && this.targetDist < 18) return frac < .12;
    return frac < .42;
  }

  shouldRetreat(bot) {
    if (!this.target) return false;
    const hp = bot.hp / bot.maxHp;
    /* Low health opens a retreat window on a cooldown: the bot breaks contact for a couple
       of seconds, then re-engages even if it never healed — no permanent camping. */
    if (hp < this.params.lowHealthThresh && this.now >= this._retreatReadyAt) {
      this.retreatUntil = this.now + this.params.retreatHold;
      this._retreatReadyAt = this.now + this.params.retreatHold * 2;
    }
    if (this.now < this.retreatUntil) return true;
    if (bot.reloadT > 0 && this.targetVisible && this.targetDist < 26) return true;
    return false;
  }

  hasVisibleTarget() {
    return !!(this.target && this.targetVisible);
  }

  hasSuspicion() {
    return !!(this.target && !this.targetVisible);
  }

  /* ---------------- intent helpers ---------------- */

  setMove(x, z) {
    this.mode = 'combat';
    this.moveX = x;
    this.moveZ = z;
  }

  setNav(goal, speedScale = 1) {
    this.mode = 'nav';
    this.navGoal = goal;
    this.navSpeed = speedScale;
  }

  hold() {
    this.mode = 'hold';
    this.moveX = 0;
    this.moveZ = 0;
  }

  face(point) {
    this.facePoint = point;
  }

  startReload(bot) {
    bot.reloadT = 1.2;
    bot.ammo = bot.magSize;
    bot.burst = 0;
    bot.fireT = 1.2;
    bot.bark('bark_reload');
  }

  /* One burst step. Returns true when a round left the barrel. Accuracy is rolled here so
     the same difficulty model drives both the hit and the visible tracer. */
  fire() {
    const bot = this.bot, t = this.target;
    if (!t || !this.targetVisible) return false;
    if (bot.reloadT > 0 || bot.reactionT > 0 || bot.fireT > 0) return false;
    if (!this.hasAim) return false;
    _eye.set(bot.pos.x, bot.pos.y + 1.4, bot.pos.z);
    // Never shoot through a teammate (or the allied player): hold fire and sidestep.
    const blocker = teammateBlockingShot(bot, _eye, this.aimPoint);
    if (blocker) {
      this.blockedLineT = .32;
      this.blockedBy = blocker.entity;
      bot.fireT = .12;
      return false;
    }
    if (this.losCheck && !this.losCheck(_eye, this.aimPoint)) { bot.fireT = .18; return false; }
    const P = this.params;
    if (bot.burst >= P.burst) {
      bot.burst = 0;
      bot.fireT = P.pause * (.85 + Math.random() * .3);
      return false;
    }
    bot.burst++;
    bot.fireT = P.burstT;
    const targetSpeed = t.vel ? Math.hypot(t.vel.x, t.vel.z) : 0;
    const smoke = !!(bot.game.grenades && bot.game.grenades.inSmoke(t.point));
    const miss = Math.random() < shotMissChance(P, {
      dist: this.targetDist,
      targetSpeed,
      settle: this.aimSettle,
      smoke,
      moving: bot.vel.lengthSq() > 1,
    });
    bot._shoot(this.aimPoint, t.entity, this.targetDist, P, miss);
    return !miss;
  }

  /* Combat footwork: hold the faction's engagement band, strafe, close in when healthy,
     and widen the angle when a teammate is already closer to the same target. */
  engageMove() {
    const bot = this.bot, t = this.target;
    if (!t) return;
    const dx = t.pos.x - bot.pos.x, dz = t.pos.z - bot.pos.z;
    const dist = Math.max(.001, Math.hypot(dx, dz));
    const nx = dx / dist, nz = dz / dist;
    const [rmin, rmax] = this.params.range;
    /* Close the distance through the navigation stack (local A* / corner routes), not by
       pushing a raw velocity at the wall. Hysteresis stops advance/strafe flip-flopping on
       the range line. */
    if (dist > rmax + (this._inRange ? 1.2 : 0)) {
      this._inRange = false;
      const stand = Math.max(rmin, rmax * .9);
      this._navGoalVec.set(t.pos.x - nx * stand, 0, t.pos.z - nz * stand);
      this.setNav(this._navGoalVec, 1);
      return;
    }
    if (dist <= rmax) this._inRange = true;
    let radial = 0;
    if (dist < rmin) radial = -.9;
    const hp = bot.hp / bot.maxHp;
    const tHp = t.maxHp > 0 ? t.hp / t.maxHp : 1;
    if (radial === 0 && hp > tHp + .15 && dist > rmin + 1) radial = this.params.aggression * .55;
    let mateCloser = false;
    for (const h of bot.game.heroes.list) {
      if (h === bot || !h.alive || h.team !== bot.team) continue;
      if (h._targetId !== this.targetId) continue;
      if (Math.hypot(h.pos.x - t.pos.x, h.pos.z - t.pos.z) < dist - 1.5) { mateCloser = true; break; }
    }
    const tang0 = this.params.strafe * (.35 + this.params.flankBias * (mateCloser ? 1 : .55));
    // A friendly body on the firing line: open the angle harder and step away from it.
    let tang = tang0;
    if (this.blockedLineT > 0) {
      tang *= 1.7;
      const bp = this.blockedBy === 'player'
        ? (bot.game.player && bot.game.player.pos)
        : (this.blockedBy && this.blockedBy.pos);
      if (bp) {
        const px = -nz, pz = nx; // perpendicular to the line of fire
        const lateral = (bp.x - bot.pos.x) * px + (bp.z - bot.pos.z) * pz;
        if (Math.abs(lateral) > .05) bot.strafeDir = lateral > 0 ? -1 : 1;
      }
    }
    const spd = bot.speed * .95;
    let mx = nx * radial - nz * bot.strafeDir * tang;
    let mz = nz * radial + nx * bot.strafeDir * tang;
    const l = Math.hypot(mx, mz);
    if (l < 1e-4) { this.hold(); return; }
    this.setMove(mx / l * spd, mz / l * spd);
    bot.strafeT -= this.dt;
    if (bot.strafeT <= 0) {
      bot.strafeT = 1.4 + Math.random() * 2;
      bot.strafeDir *= -1;
    }
  }

  /* Shared cover steering for retreat and reload. Returns true when a hiding spot exists. */
  _seekCover(bot, speedScale) {
    const t = this.target;
    if (!t) return false;
    if (bot.coverT <= 0) {
      // Cooldown even when the search finds nothing: `!coverTarget` alone would retry this
      // (raycasts included) every frame while the map offers no cover.
      bot.coverTarget = bot._findCover(t.pos, this.losCheck);
      bot.coverT = 2.5;
    }
    if (!bot.coverTarget) return false;
    this._coverWanted = true;
    const d = Math.hypot(bot.coverTarget.x - bot.pos.x, bot.coverTarget.z - bot.pos.z);
    if (d > 1.0) this.setNav(bot.coverTarget, speedScale);
    else this.hold();
    return true;
  }

  /* ---------------- actions ---------------- */

  actReload(bot) {
    this.state = 'reload';
    bot.prio = 1;
    if (bot.reloadT <= 0) this.startReload(bot);
    if (this.target) {
      this._seekCover(bot, 1.0);
      this.face(this.target.point);
    } else {
      this.hold();
    }
    return bot.reloadT > 0 ? BTStatus.RUNNING : BTStatus.SUCCESS;
  }

  actRetreat(bot) {
    const t = this.target;
    if (!t) return BTStatus.FAILURE;
    this.state = 'retreat';
    bot.prio = 1;
    this.face(t.point);
    if (this._seekCover(bot, 1.05)) {
      // Return fire while falling back — the cover only pays off once the bot gets there.
      if (this.targetVisible) this.fire();
      return BTStatus.RUNNING;
    }
    // No usable cover: back away from the threat while keeping it in front.
    const dx = bot.pos.x - t.pos.x, dz = bot.pos.z - t.pos.z;
    const d = Math.max(.001, Math.hypot(dx, dz));
    this.setMove(dx / d * bot.speed, dz / d * bot.speed);
    return BTStatus.RUNNING;
  }

  actAimFire(bot) {
    if (!this.targetVisible || !this.target) return BTStatus.FAILURE;
    this.fire();
    return BTStatus.RUNNING;
  }

  actFightMove(bot) {
    if (!this.targetVisible || !this.target) return BTStatus.FAILURE;
    this.state = 'engage';
    bot.prio = 3; // a bot in a firing stance has right of way through a crowd
    this.engageMove();
    return BTStatus.RUNNING;
  }

  actSearch(bot) {
    const t = this.target;
    if (!t || t.visible) return BTStatus.FAILURE;
    this.state = 'search';
    bot.prio = 2;
    const d = Math.hypot(t.pos.x - bot.pos.x, t.pos.z - bot.pos.z);
    const hurt = bot.hp / bot.maxHp < this.params.lowHealthThresh;
    const chaseLimit = 10 + this.params.aggression * 18;
    // A wounded bot does not charge a distant memory across the map — it holds and watches.
    if (d > 1.5 && (!hurt || d <= chaseLimit)) {
      this.setNav(t.pos, .95);
      this.face(t.point);
      this.fire();
      return BTStatus.RUNNING;
    }
    // Reached the last known spot (or chose not to chase): sweep the area, then give up.
    this.hold();
    this.hasAim = false; // let `faceYaw` drive the sweep instead of staring at the memory point
    this._scanT += this.dt;
    // Sweep at ≈1.35 rad/s: `faceYaw` is a target yaw a small step ahead, and HeroBot applies
    // it at its own turn rate, so divide by that rate to keep the sweep speed stable.
    this.faceYaw = bot.yaw + 1.35 / Math.max(1, this.params.turnRate || 6);
    if (this.targetVisible) this.fire();
    if (this._scanT > 2.4) {
      this.sensor.drop(t.id);
      this.target = null;
      this.targetId = null;
      this._scanT = 0;
      return BTStatus.SUCCESS;
    }
    return BTStatus.RUNNING;
  }

  actPatrol(bot) {
    this.state = 'patrol';
    bot.prio = 2;
    const order = this.squadOrder;
    if (order) { this._followSquadOrder(bot, order); return BTStatus.RUNNING; }
    if (this._patrolWait > 0) {
      this._patrolWait -= this.dt;
      this.hold();
      this.faceYaw = bot.yaw + .6 / Math.max(1, this.params.turnRate || 6);
      return BTStatus.RUNNING;
    }
    this._patrolT -= this.dt;
    const reached = this._patrolGoal &&
      Math.hypot(this._patrolGoal.x - bot.pos.x, this._patrolGoal.z - bot.pos.z) < 1.5;
    if (!this._patrolGoal || reached || this._patrolT <= 0) {
      this._patrolGoal = this.pickPatrolGoal();
      this._patrolT = 6 + Math.random() * 4;
      if (reached) this._patrolWait = 1.2 + Math.random() * 1.5;
    }
    if (this._patrolGoal) {
      this.setNav(this._patrolGoal, .72);
      this.face(this._patrolGoal);
    } else {
      this.hold();
      this.faceYaw = bot.yaw + .5 / Math.max(1, this.params.turnRate || 6);
    }
    return BTStatus.RUNNING;
  }

  /* Squad order → intent. Any temporary order with a goal moves; only hold stands.
     navigation; anything else: stand. Either way face where the order says (usually an entrance
     or the objective). Reusable vectors: nothing is allocated per frame. */
  _followSquadOrder(bot, order) {
    const P = this.params;
    if (order.kind !== 'hold' && order.goal) {
      this._squadGoal.set(order.goal[0], 0, order.goal[1]);
      this.setNav(this._squadGoal, order.sprint ? 1.12 : .92);
    } else {
      this.hold();
    }
    if (order.lookAt) {
      this._squadLook.set(order.lookAt[0], bot.pos.y + 1.4, order.lookAt[1]);
      this.face(this._squadLook);
    } else {
      this.faceYaw = bot.yaw + .5 / Math.max(1, P.turnRate || 6);
    }
  }

  /* Objective-aware idle: contest the hill in KOTH, otherwise push toward the enemy half.
     A wounded bot without contact falls back toward its own base instead of feeding. */
  pickPatrolGoal() {
    const bot = this.bot, game = bot.game;
    const cols = game.world ? game.world.colliders : [];
    const koth = game.mode === 'koth' && game.koth;
    const hurt = bot.hp / bot.maxHp < this.params.lowHealthThresh;
    for (let i = 0; i < 10; i++) {
      let x, z;
      if (koth && !hurt) {
        const a = Math.random() * Math.PI * 2, r = Math.random() * 6.5;
        x = game.koth.pos.x + Math.cos(a) * r;
        z = game.koth.pos.z + Math.sin(a) * r;
      } else if (hurt) {
        const baseZ = bot.team === 'A' ? 20 : -20;
        x = (Math.random() - .5) * 24;
        z = baseZ + (Math.random() - .5) * 8;
      } else {
        const baseZ = bot.team === 'A' ? -18 : 18;
        x = (Math.random() - .5) * 36;
        z = baseZ + (Math.random() - .5) * 14;
      }
      if (Math.hypot(x, z) > 48) continue;
      if (!isPointClear(x, z, cols, .6)) continue;
      return this._patrolVec.set(x, 0, z);
    }
    return this._patrolVec.set(0, 0, bot.team === 'A' ? 20 : -20);
  }
}
