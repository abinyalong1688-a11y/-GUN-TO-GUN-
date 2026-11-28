// funItems.js — Fun Brawl props (banana / magnet / spring / water bomb):
//   · thrown on a real parabolic arc like a grenade, but they PLACE on first ground contact
//     instead of fusing;
//   · banana  → a peel: whoever steps on it slips (inertia keeps sliding, no shooting);
//   · magnet  → a one-shot 6 m field that yanks the primary off every enemy in range;
//   · spring  → a pad: stepping on it launches the victim;
//   · water   → a puddle: standing in it slows the victim down for a few seconds.
//   · singleton geometry/materials, a hard cap per prop type, no per-frame allocations.
// Only advances while `game.matchMode === 'fun'` (main.js gates update/reset/throw), so every
// other mode is untouched.
import * as THREE from 'three';
import {t as i18nT} from './i18n.js';
import {makeProp,setPropPuddleRadius,disposePropAssets} from './funProps.js';

export const FUN_ITEMS = ['banana', 'magnet', 'spring', 'water'];

/* Thrown like a grenade (see grenades.js throw): 15 m/s forward + 4.2 m/s up. */
export const FUN_DEFS = {
  banana: { color: 0xf2d95a, radius: 1.15, life: 25, max: 12, slip: .9,  points: 1, label: 'banana' },
  magnet: { color: 0xd8503e, radius: 6.0,  life: 0,  max: 1,  disarm: 3, points: 2, label: 'magnet' },
  spring: { color: 0x6ad1f5, radius: 1.25, life: 30, max: 6,  bounce: 7,  points: 1, label: 'spring' },
  water:  { color: 0x4fa8e8, radius: 2.2,  life: 12, max: 6,  slow: 3,    points: 1, label: 'water' },
};

export const FUN_MATCH = { win: 40, duration: 240, refreshEvery: 20, refill: 2, startCounts: 1 };

const THROW_SPEED = 15, THROW_LIFT = 4.2, GRAVITY = 14;
/* Foot height above the prop that still counts as stepping on it. */
const STEP_EPS = 1.1;

/* Points for one scoring event. Pure so it can be unit-tested without a Game. */
export function funScoreEvent(kind) {
  if (kind === 'kill') return 2;
  if (kind === 'disarm') return 2;
  if (kind === 'slip' || kind === 'bounce' || kind === 'water') return 1;
  return 0;
}

/* Fresh per-type ammo bag. */
export function funStartCounts(n = FUN_MATCH.startCounts) {
  const c = {};
  for (const k of FUN_ITEMS) c[k] = n;
  return c;
}

export class FunItems {
  /* `owner` marks who threw it: {team, name, isPlayer}. */
  constructor(game, scene, effects, audio, ui) {
    this.game = game; this.scene = scene; this.fx = effects; this.audio = audio; this.ui = ui;
    this.counts = funStartCounts();
    this.list = [];        // in flight
    this.placed = [];      // resting props that still have an effect
    this.pulses = [];      // short-lived visual pulses (magnet field ring)
    this.refreshT = FUN_MATCH.refreshEvery;
    /* Props are real objects (funProps.js), not primitives: each one is a small Group of
       low-poly parts, with all geometry/material buffers shared across instances. */
    setPropPuddleRadius(FUN_DEFS.water.radius);
    this._v = new THREE.Vector3(); this._dir = new THREE.Vector3(); this._tmp = new THREE.Vector3();
  }

  reset() {
    this.counts = funStartCounts();
    this.refreshT = FUN_MATCH.refreshEvery;
    this.clear();
  }

  /* Player throw from the camera; returns whether a prop left the hand. */
  throw(type) {
    /* Mode gate, not just an input gate: the prop system must be unable to spawn anything
       outside Fun Brawl even if a caller (touch pad, test hook, console) invokes it directly. */
    if (this.game.matchMode !== 'fun') return false;
    const def = FUN_DEFS[type];
    if (!def || this.counts[type] <= 0) return false;
    const cam = this.game.camera;
    this._dir.set(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    const pos = this._tmp.copy(cam.position).addScaledVector(this._dir, .6);
    this._launch(type, pos, this._dir.clone());
    this.counts[type]--;
    if (this.ui && this.ui.setFunItems) this.ui.setFunItems(this.counts);
    if (this.audio && this.audio.uiClick) this.audio.uiClick();
    return true;
  }

  /* Bot throw: from its eye toward a target point. No ammo bookkeeping — bots throw on cooldown. */
  botThrow(type, fromPos, targetPos, owner) {
    /* Same mode gate as throw(): bots must not spawn props in waves / dm / koth. */
    if (this.game.matchMode !== 'fun') return false;
    const def = FUN_DEFS[type];
    if (!def || !fromPos || !targetPos) return false;
    /* No owner = no known side, and a wrong side means the magnet disarms the wrong team.
       Refusing is the safe default (the caller in botBrain.js always passes one). */
    if (!owner || !owner.team) return false;
    const dir = new THREE.Vector3(targetPos.x - fromPos.x, 0, targetPos.z - fromPos.z);
    if (dir.lengthSq() < 1e-4) return false;
    dir.normalize();
    this._launch(type, new THREE.Vector3(fromPos.x, fromPos.y, fromPos.z), dir, owner);
    return true;
  }

  _launch(type, pos, dir, owner = null) {
    const mesh = makeProp(type, 'fly');
    mesh.position.copy(pos);
    /* Point the prop along its flight direction so a banana flies tip-first and a magnet leads
       with a pole instead of tumbling sideways. The group's +Z is "forward" by construction in
       funProps.js (the banana arc and the magnet's opening both face +Z). */
    if (dir.lengthSq() > 1e-6) {
      const flat = Math.atan2(dir.x, dir.z);
      mesh.rotation.y = flat;
    }
    this.scene.add(mesh);
    this.list.push({
      type, mesh,
      pos: mesh.position.clone(),
      vel: dir.clone().multiplyScalar(THROW_SPEED).add(new THREE.Vector3(0, THROW_LIFT, 0)),
      spin: Math.random() * 4 + 3,
      owner: owner || { team: this.game.playerTeam || 'A', name: this.game.playerName, isPlayer: true },
    });
  }

  update(dt) {
    /* Same mode gate as throw(): outside Fun Brawl no prop may tick, place or score. */
    if (this.game.matchMode !== 'fun') return;
    /* Prop-box refresh: the map keeps seeding new props so the fight has a supply line. */
    this.refreshT -= dt;
    if (this.refreshT <= 0) {
      this.refreshT = FUN_MATCH.refreshEvery;
      this._seedBox();
    }

    /* In-flight: parabola, then place on the first ground/support contact. */
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.vel.y -= GRAVITY * dt;
      p.pos.addScaledVector(p.vel, dt);
      this._bounceWalls(p);
      p.mesh.position.copy(p.pos);
      /* Tumble while airborne. The water bomb is a sphere, so spinning it would destroy the
         glass-balloon read — it drifts instead. */
      if (p.type !== 'water') {
        p.mesh.rotation.x += p.spin * dt;
        p.mesh.rotation.z += p.spin * .7 * dt;
      } else {
        p.mesh.rotation.y += p.spin * .35 * dt;
      }
      const ground = this._surfaceY(p.pos.x, p.pos.z);
      /* Props are placed, not fused: the first floor contact settles them. Ordered BEFORE any
         bounce, so a prop can never be pushed back above the landing threshold and hover forever. */
      if (p.pos.y <= ground + .1) {
        this.scene.remove(p.mesh);
        this.list.splice(i, 1);
        this._place(p, ground);
      }
    }

    /* Resting props: run their effect and expire. */
    for (let i = this.placed.length - 1; i >= 0; i--) {
      const p = this.placed[i];
      p.life -= dt;
      /* Puddle rings drift around the vertical axis (the model lies flat, so a Z spin would tip
         it out of the ground plane). Cheap life for a static prop. */
      if (p.type === 'water') p.mesh.rotation.y += dt * .25;
      if (p.life <= 0) { this._remove(i); continue; }
      this._apply(p, dt);
    }

    /* Short-lived visual pulses (the magnet's field ring). Driven off update() rather than a
       timer so a paused or finished match never leaves one hanging in the scene. */
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const q = this.pulses[i];
      q.t += dt;
      const k = Math.min(1, q.t / q.dur);
      /* The ring expands from the impact point out to the real field radius and fades. */
      const s = .18 + (q.radius / .18 - 1) * k;
      q.mesh.scale.setScalar(s);
      q.mesh.material.opacity = q.opacity * (1 - k) * (1 - k);
      if (k >= 1) {
        this.scene.remove(q.mesh);
        q.mesh.material.dispose();
        q.mesh.geometry.dispose();
        this.pulses.splice(i, 1);
      }
    }
  }

  /* Expanding ring that shows where a one-shot field reached. Own geometry/material per pulse
     because it is short-lived and scaled per instance (a handful per match at most). */
  _magnetPulse(pos, radius) {
    const geo = new THREE.RingGeometry(.9, 1, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff7a5c, transparent: true, opacity: .7,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos.x, pos.y + .05, pos.z);
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.pulses.push({ mesh, t: 0, dur: .45, radius, opacity: .7 });
  }

  /* Horizontal bounces off cover only: the floor is handled by placement in update(). */
  _bounceWalls(p) {
    const cols = this.game.world && this.game.world.colliders;
    if (!cols) return;
    for (const c of cols) {
      if (p.pos.y > c.top + .12) continue;
      const cx = Math.max(c.minX, Math.min(p.pos.x, c.maxX));
      const cz = Math.max(c.minZ, Math.min(p.pos.z, c.maxZ));
      const dx = p.pos.x - cx, dz = p.pos.z - cz, d2 = dx * dx + dz * dz;
      if (d2 < .0144 && d2 > 1e-8) {
        const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
        const dot = p.vel.x * nx + p.vel.z * nz;
        if (dot < 0) { p.vel.x -= 1.5 * dot * nx; p.vel.z -= 1.5 * dot * nz; p.vel.x *= .6; p.vel.z *= .6; }
        p.pos.x = cx + nx * .12; p.pos.z = cz + nz * .12;
      }
    }
  }

  /* Highest support under a point (crate tops included). Ground is flat inside the arena bound. */
  _surfaceY(x, z) {
    let y = 0;
    const cols = this.game.world && this.game.world.colliders;
    if (cols) for (const c of cols) {
      if (c.top == null) continue;
      if (x < c.minX - .001 || x > c.maxX + .001 || z < c.minZ - .001 || z > c.maxZ + .001) continue;
      if (c.top > y) y = c.top;
    }
    return y;
  }

  _place(p, ground) {
    const def = FUN_DEFS[p.type];
    /* The resting look is a different model: a banana becomes a peel, a spring flattens into a
       pad, and the water bomb bursts into a puddle sized to the gameplay radius. */
    const mesh = makeProp(p.type, 'rest');
    mesh.position.set(p.pos.x, ground + (p.type === 'water' ? .012 : .02), p.pos.z);
    this.scene.add(mesh);

    if (p.type === 'magnet') {
      /* One-shot field: it fires on landing and does not linger. The pulse ring below tells the
         player how far the field actually reached, which is the whole point of the magnet. */
      this.fx && this.fx.impactFlash && this.fx.impactFlash(mesh.position);
      this._magnetPulse(mesh.position, def.radius);
      this._magnetBurst(mesh.position, p.owner);
      this.scene.remove(mesh);
      return;
    }

    /* Cap per type: the oldest prop of that type is recycled so a long match cannot pile up.
       Collect the victims first, then remove by identity — splicing while holding indexes would
       invalidate them (and `same` is a filtered copy, not a live view of `this.placed`). */
    const drop = this.placed.filter(q => q.type === p.type);
    const excess = drop.length - (def.max - 1);
    for (let i = 0; i < excess; i++) {
      const idx = this.placed.indexOf(drop[i]);
      if (idx >= 0) this._remove(idx);
    }

    this.placed.push({
      type: p.type, mesh, pos: mesh.position.clone(),
      radius: def.radius, life: def.life, used: false, owner: p.owner,
      /* Only the water puddle needs per-victim cooldown tracking; banana/spring are consumed on
         first contact. `null` keeps the shared empty map below out of their hot path. */
      _cool: p.type === 'water' ? new Map() : null,
    });
  }

  /* Magnet: yank the primary off every enemy inside the field. */
  _magnetBurst(pos, owner) {
    const D = FUN_DEFS.magnet;
    /* No owner = no known side. Refusing is the safe default: falling back to the local player's
       team would silently disarm allies whenever a caller forgot to pass one. */
    if (!owner || !owner.team) return;
    const myTeam = owner.team;
    const g = this.game;

    /* The local player. */
    if (g.player && g.player.alive && (g.playerTeam || 'A') !== myTeam) {
      const d = Math.hypot(g.player.pos.x - pos.x, g.player.pos.z - pos.z);
      if (d < D.radius) this._disarmPlayer(pos, owner);
    }
    for (const h of g.heroes.list) {
      if (!h.alive || h.team === myTeam) continue;
      const d = Math.hypot(h.pos.x - pos.x, h.pos.z - pos.z);
      if (d < D.radius) this._disarmBot(h, pos, owner);
    }
  }

  _disarmPlayer(pos, owner) {
    const g = this.game, w = g.weapon;
    /* Already stunned by an earlier magnet: no second yank, no double points. */
    if (g.player.disarmT > 0) return;
    /* The peel status is dropped: being yanked and sliding at the same time is two control
       losses stacked, which reads as a freeze rather than a gag. */
    g.player.slipT = 0;
    g.player.disarmT = FUN_DEFS.magnet.disarm;
    /* Only a PRIMARY is a rifle worth dropping. `w.cur` still names the outgoing gun while a
       switch animation runs, so "holding a primary" reads correctly even mid-swap. */
    const holdingPrimary = !!(w && w.primaryCount != null && w.cur < w.primaryCount);
    const rifle = holdingPrimary ? (w.def && w.def.id) : null;
    if (holdingPrimary && w.switchT < 0) w.switchTo(w.primaryCount);   // hand them the sidearm
    if (rifle && g.pickups) g.pickups.addDrop(g.player.pos, rifle);
    this._report('disarm', owner, { team: g.playerTeam || 'A', name: g.playerName }, pos);
    if (this.ui && this.ui.banner) this.ui.banner(this._t('fun_disarmed'), this._t('fun_magnet'));
  }

  _disarmBot(h, pos, owner) {
    const g = this.game;
    if (h.disarmedT > 0) return;                  // already stripped: no double points
    if (h.rifleFalling) return;                    // its rifle is already on the ground
    h.disarmedT = FUN_DEFS.magnet.disarm;
    h.dropRifle();
    const rifle = h.def && h.def.rifle;
    if (rifle && g.pickups) g.pickups.addDrop(h.pos, rifle);
    this._report('disarm', owner, { team: h.team, name: h.name }, pos);
  }

  _apply(p, dt) {
    /* A prop whose owner is unknown cannot score; skip the whole pass rather than defaulting to
       the local team (that would credit the wrong side). */
    if (!p.owner || !p.owner.team) return;
    const g = this.game, team = p.owner.team;
    /* Cooldown map keeps a single victim from farming points by standing in one puddle. Expired
       keys are deleted, so the map only ever holds victims currently inside the cooldown.
       Only the water puddle has one (banana/spring are single-use). */
    const cool = p._cool;
    if (cool && cool.size) for (const [k, v] of cool) { const n = v - dt; if (n <= 0) cool.delete(k); else cool.set(k, n); }

    if (p.type === 'water') {
      if (g.player && g.player.alive && (g.playerTeam || 'A') !== team && this._inside(p, g.player.pos)) {
        g.player.slowT = Math.max(g.player.slowT || 0, FUN_DEFS.water.slow);
        this._hitOnce(p, g.playerName, 'water', team, { team: g.playerTeam || 'A', name: g.playerName }, p.pos);
      }
      for (const h of g.heroes.list) {
        if (!h.alive || h.team === team || !this._inside(p, h.pos)) continue;
        h.slowT = Math.max(h.slowT || 0, FUN_DEFS.water.slow);
        this._hitOnce(p, h.name, 'water', team, { team: h.team, name: h.name }, p.pos);
      }
      return;
    }

    /* Banana / spring are single-use: the first victim standing on them consumes the prop. */
    if (p.used) return;
    if (g.player && g.player.alive && (g.playerTeam || 'A') !== team && this._onFoot(p, g.player.pos)) {
      if (p.type === 'banana') this._slipPlayer(p);
      else this._bouncePlayer(p);
      p.used = true;
      this._report(p.type === 'banana' ? 'slip' : 'bounce', p.owner,
        { team: g.playerTeam || 'A', name: g.playerName }, p.pos);
      this._consume(p);
      return;
    }
    for (const h of g.heroes.list) {
      if (!h.alive || h.team === team || !this._onFoot(p, h.pos)) continue;
      if (p.type === 'banana') this._slipBot(h);
      else this._bounceBot(h, p);
      p.used = true;
      this._report(p.type === 'banana' ? 'slip' : 'bounce', p.owner, { team: h.team, name: h.name }, p.pos);
      this._consume(p);
      return;
    }
  }

  _inside(p, pos) {
    const dx = pos.x - p.pos.x, dz = pos.z - p.pos.z;
    return dx * dx + dz * dz <= p.radius * p.radius && Math.abs(pos.y - p.pos.y) < 2.4;
  }

  /* Stepping on a prop requires the feet to be near the prop's height (not standing on a crate above). */
  _onFoot(p, pos) {
    const dx = pos.x - p.pos.x, dz = pos.z - p.pos.z;
    if (dx * dx + dz * dz > p.radius * p.radius) return false;
    return Math.abs(pos.y - p.pos.y) < STEP_EPS;
  }

  _hitOnce(p, key, kind, team, victim, pos) {
    const cool = p._cool;
    if (!cool) return;
    if (cool.has(key)) return;
    cool.set(key, 4);
    this._report(kind, p.owner, victim, pos);
  }

  _slipPlayer(p) {
    const pl = this.game.player;
    pl.slipT = FUN_DEFS.banana.slip;
    if (this.ui && this.ui.banner) this.ui.banner(this._t('fun_slipped'), this._t('fun_banana'));
  }

  _slipBot(h) {
    h.slipT = FUN_DEFS.banana.slip;
  }

  _bouncePlayer(p) {
    const pl = this.game.player;
    pl.velY = FUN_DEFS.spring.bounce;
    pl.grounded = false;
    if (this.audio && this.audio.uiClick) this.audio.uiClick();
  }

  /* Bots have no vertical physics (heroes.js keeps group.position.y on the ground), so the spring
     gives them a sideways launch plus a short loss of control. */
  _bounceBot(h, p) {
    const dx = h.pos.x - p.pos.x, dz = h.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    h.vel.x += dx / d * 8;
    h.vel.z += dz / d * 8;
    h.slipT = Math.max(h.slipT || 0, .7);
  }

  /* Report a scoring event to the host game (main.js decides whether it counts for the board). */
  _report(kind, owner, victim, pos) {
    const g = this.game;
    if (g && g.onFunEvent) g.onFunEvent({ kind, owner: owner || null, victim: victim || null, pos });
    if (g && g.ui && g.ui.scorePop && pos) {
      const pts = funScoreEvent(kind);
      if (pts > 0) g.ui.scorePop(pos, g.camera, `+${pts}`, false, 'fun');
    }
  }

  _t(key) {
    const g = this.game;
    if (g && g.t) return g.t(key);
    return i18nT(key);
  }

  /* Spawn a prop box somewhere near the middle of the map (pickups.js handles the magnet/collect). */
  _seedBox() {
    const g = this.game;
    if (!g || !g.pickups || !g.pickups.drop) return null;
    const spot = this._randPoint();
    return g.pickups.drop(spot, 'fun');
  }

  _randPoint() {
    const g = this.game;
    const r = 26;
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * r;
      const x = Math.cos(a) * d, z = Math.sin(a) * d;
      const cols = (g.world && g.world.colliders) || [];
      let blocked = false;
      for (const c of cols) {
        if (x > c.minX - .6 && x < c.maxX + .6 && z > c.minZ - .6 && z < c.maxZ + .6) { blocked = true; break; }
      }
      if (!blocked) return { x, z };
    }
    return { x: 0, z: 0 };
  }

  _consume(p) {
    const i = this.placed.indexOf(p);
    if (i >= 0) this._remove(i);
  }

  _remove(i) {
    const p = this.placed[i];
    if (p) this.scene.remove(p.mesh);
    this.placed.splice(i, 1);
  }

  clear() {
    for (const p of this.list) this.scene.remove(p.mesh);
    for (const p of this.placed) this.scene.remove(p.mesh);
    for (const q of this.pulses) {
      this.scene.remove(q.mesh);
      q.mesh.material.dispose();
      q.mesh.geometry.dispose();
    }
    this.list.length = 0; this.placed.length = 0; this.pulses.length = 0;
    if (this.ui && this.ui.setFunItems) this.ui.setFunItems(this.counts);
    if (this.ui && this.ui.setFunItemsActive) this.ui.setFunItemsActive(false);
  }

  dispose() {
    this.clear();
    disposePropAssets();   // shared buffers live in funProps.js
  }
}
