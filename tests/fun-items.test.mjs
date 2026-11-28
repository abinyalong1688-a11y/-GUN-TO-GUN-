// fun-items.test.mjs — Fun Brawl props (src/funItems.js): scoring table, ammo bags, and the
// four effects against a minimal fake game (no renderer, no bots beyond the ones we need).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildWorld } from '../src/world.js';
import {
  FunItems, FUN_ITEMS, FUN_DEFS, FUN_MATCH,
  funScoreEvent, funStartCounts,
} from '../src/funItems.js';
import { makeProp } from '../src/funProps.js';

function assets() {
  const mat = new THREE.MeshBasicMaterial();
  const tex = new THREE.Texture();
  return {
    mats: new Proxy({}, { get: () => mat }),
    ground: new Proxy({}, { get: () => mat }),
    containers: new Proxy({}, { get: () => mat }),
    tex: new Proxy({}, { get: () => tex }),
  };
}

/* A game stub with just what FunItems reads: camera/player/world/heroes/pickups/ui. */
function setup(events = []) {
  const scene = new THREE.Scene();
  const world = buildWorld(scene, assets(), 'high', 'desert');
  const pickups = { drops: [], addDrop(pos, rifle) { this.drops.push({ pos, rifle }); } };
  const player = {
    pos: new THREE.Vector3(0, 0, 0), alive: true,
    slipT: 0, slowT: 0, disarmT: 0, velY: 0, grounded: true,
  };
  const weapon = { cur: 0, primaryCount: 4, def: { id: 'm4a4' }, switchTo(idx) { this.cur = idx; } };
  const game = {
    scene, world, player, weapon, pickups,
    playerTeam: 'A', playerName: 'me',
    matchMode: 'fun',            // FunItems gates throw()/update() on this
    camera: new THREE.PerspectiveCamera(),
    heroes: { list: [] },
    ui: {},
    onFunEvent: ev => events.push(ev),
  };
  const ui = { calls: [], setFunItems(c) { this.last = c; }, banner(a, b) { this.calls.push([a, b]); } };
  const fun = new FunItems(game, scene, { impactFlash() {} }, { uiClick() {} }, ui);
  return { game, fun, ui, scene, player, pickups, events };
}

/* Run the prop into the ground immediately by placing it just above y=0. */
function drop(fun, type, x = 0, z = 0, owner = null) {
  const from = new THREE.Vector3(x, .6, z);
  fun._launch(type, from, new THREE.Vector3(0, 0, 0), owner || { team: 'A', name: 'me', isPlayer: true });
  for (let i = 0; i < 400 && fun.list.length; i++) fun.update(1 / 60);
}

test('every prop type has a definition and a starting bag', () => {
  for (const k of FUN_ITEMS) {
    assert.ok(FUN_DEFS[k], `${k} needs a definition`);
    assert.ok(FUN_DEFS[k].max >= 1, `${k} needs a per-type cap`);
  }
  const c = funStartCounts();
  for (const k of FUN_ITEMS) assert.equal(c[k], FUN_MATCH.startCounts);
});

test('the prank scoring table: kills and disarms pay 2, every other prop hit pays 1', () => {
  assert.equal(funScoreEvent('kill'), 2);
  assert.equal(funScoreEvent('disarm'), 2);
  assert.equal(funScoreEvent('slip'), 1);
  assert.equal(funScoreEvent('bounce'), 1);
  assert.equal(funScoreEvent('water'), 1);
  assert.equal(funScoreEvent('nonsense'), 0);
});

test('throwing spends one prop of that type and refuses when the bag is empty', () => {
  const { fun, ui } = setup();
  assert.equal(fun.counts.banana, FUN_MATCH.startCounts);
  assert.equal(fun.throw('banana'), true);
  assert.equal(fun.counts.banana, FUN_MATCH.startCounts - 1);
  assert.equal(ui.last.banana, FUN_MATCH.startCounts - 1, 'HUD is told about the new count');
  fun.counts.banana = 0;
  assert.equal(fun.throw('banana'), false, 'an empty bag throws nothing');
  assert.equal(fun.throw('does-not-exist'), false);
});

test('a banana lands as a peel, and stepping on it slips the victim and scores once', () => {
  const { fun, player, events } = setup();
  drop(fun, 'banana', -4, 6, { team: 'B', name: 'enemy', isPlayer: false });
  assert.equal(fun.placed.length, 1, 'the peel rests on the ground');
  assert.equal(fun.placed[0].type, 'banana');

  player.pos.set(-4, 0, 6);
  fun.update(1 / 60);
  assert.ok(player.slipT > 0, 'the player slips');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'slip');
  assert.equal(fun.placed.length, 0, 'a peel is single use');
});

test('a prop resting on a crate top is only stepped on from that surface', () => {
  const { fun, player } = setup();
  drop(fun, 'banana', 3, 3, { team: 'B', name: 'enemy', isPlayer: false });  // desert crate top
  const p = fun.placed[0];
  assert.ok(p.pos.y > 1, 'the peel sits on the crate, not the ground');

  player.pos.set(3, 0, 3);           // standing under the crate at ground level
  fun.update(1 / 60);
  assert.equal(player.slipT, 0, 'the ground-level player is not on the peel');

  player.pos.set(3, p.pos.y, 3);     // up on the crate
  fun.update(1 / 60);
  assert.ok(player.slipT > 0, 'the player on the crate top slips');
});

test('a spring launches the player upward and is consumed', () => {
  const { fun, player } = setup();
  drop(fun, 'spring', -4, 6, { team: 'B', name: 'enemy', isPlayer: false });
  player.pos.set(-4, 0, 6);
  player.velY = 0; player.grounded = true;
  fun.update(1 / 60);
  assert.ok(player.velY > 0, 'the spring pushes the player up');
  assert.equal(player.grounded, false);
  assert.equal(fun.placed.length, 0, 'a spring is single use');
});

test('a water puddle slows whoever stands in it, repeatedly but not every frame', () => {
  const { fun, player, events } = setup();
  drop(fun, 'water', 0, -5, { team: 'B', name: 'enemy', isPlayer: false });
  player.pos.set(0, 0, -5);
  fun.update(1 / 60);
  assert.ok(player.slowT > 0, 'standing in the puddle slows the player');
  assert.equal(events.length, 1, 'the first soak scores');
  assert.equal(fun.placed.length, 1, 'a puddle persists instead of being consumed');
  // Standing still must not farm points: the per-victim cooldown keeps it at one event.
  for (let i = 0; i < 30; i++) fun.update(1 / 60);
  assert.equal(events.length, 1, 'no repeat scoring inside the cooldown');
});

test('the magnet bursts once, strips an enemy bot and drops their rifle as a weapon crate', () => {
  const { fun, pickups, events, game } = setup();
  const bot = {
    alive: true, team: 'B', name: 'bot-1', hp: 100, maxHp: 100,
    pos: new THREE.Vector3(2, 0, 2), disarmedT: 0,
    def: { rifle: 'ak47' }, dropped: false,
    dropRifle() { this.dropped = true; },
  };
  game.heroes.list = [bot];
  drop(fun, 'magnet', 0, 0, { team: 'A', name: 'me', isPlayer: true });
  assert.equal(fun.placed.length, 0, 'the magnet is a one-shot field');
  assert.ok(bot.disarmedT > 0, 'the bot cannot shoot');
  assert.equal(bot.dropped, true, 'its rifle is dropped');
  assert.equal(pickups.drops.length, 1);
  assert.equal(pickups.drops[0].rifle, 'ak47', 'a weapon crate spawns with the right rifle');
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'disarm');
});

test('the magnet does not strip its own team, and the same bot cannot be stripped twice', () => {
  const { fun, events, game } = setup();
  const mate = {
    alive: true, team: 'A', name: 'mate', pos: new THREE.Vector3(2, 0, 2), disarmedT: 0,
    def: { rifle: 'm4a4' }, dropRifle() {},
  };
  game.heroes.list = [mate];
  drop(fun, 'magnet', 0, 0, { team: 'A', name: 'me', isPlayer: true });
  assert.equal(mate.disarmedT, 0, 'teammates keep their rifles');
  assert.equal(events.length, 0);
});

test('props are capped per type so a long match cannot pile them up', () => {
  const { fun } = setup();
  const cap = FUN_DEFS.banana.max;
  for (let i = 0; i < cap + 4; i++) drop(fun, 'banana', 10 + i * .05, 10);
  const bananas = fun.placed.filter(p => p.type === 'banana');
  assert.equal(bananas.length, cap, `at most ${cap} peels exist at once`);
});

test('reset clears every prop and restores the starting bag', () => {
  const { fun } = setup();
  drop(fun, 'banana', 3, 3);
  fun.counts.banana = 0;
  fun.reset();
  assert.equal(fun.placed.length, 0);
  assert.equal(fun.list.length, 0);
  assert.equal(fun.counts.banana, FUN_MATCH.startCounts);
});

test('the field keeps seeding prop boxes on its own timer', () => {
  const { fun, pickups } = setup();
  pickups.drop = (pos, type) => { pickups.drops.push({ pos, type }); return {}; };
  fun.refreshT = .01;
  fun.update(1 / 60);
  assert.equal(pickups.drops.length, 1, 'one box is seeded when the timer elapses');
  assert.equal(pickups.drops[0].type, 'fun');
  assert.ok(fun.refreshT > 1, 'the timer is re-armed');
});

test('every prop model stays inside a low-poly budget', () => {
  /* Guards the "zero external assets, low-poly" rule: a future model swap must not quietly
     multiply the triangle count. Budgets are generous (models are ~200-700 tris). */
  const trisOf = g => {
    let n = 0;
    g.traverse(o => {
      if (!o.geometry) return;
      const g2 = o.geometry;
      n += (g2.index ? g2.index.count : g2.attributes.position.count) / 3;
    });
    return n;
  };
  for (const type of FUN_ITEMS) {
    for (const stage of ['fly', 'rest']) {
      const model = makeProp(type, stage);
      const tris = trisOf(model);
      assert.ok(tris > 0, `${type}/${stage} must actually have geometry`);
      assert.ok(tris < 1500, `${type}/${stage} has ${Math.round(tris)} tris (budget 1500)`);
    }
  }
});

test('prop models reuse cached geometry instead of allocating per instance', () => {
  const modelA = makeProp('banana', 'fly');
  const modelB = makeProp('banana', 'fly');
  assert.notEqual(modelA, modelB, 'each prop gets its own group');
  const geoA = [], geoB = [];
  modelA.traverse(o => o.geometry && geoA.push(o.geometry.uuid));
  modelB.traverse(o => o.geometry && geoB.push(o.geometry.uuid));
  assert.deepEqual(geoA, geoB, 'two instances must share the same geometry buffers');
});

test('outside Fun Brawl the prop system is completely inert', () => {
  const { fun, game, pickups } = setup();
  game.matchMode = 'dm';
  pickups.drop = (pos, type) => { pickups.drops.push({ pos, type }); return {}; };
  assert.equal(fun.throw('banana'), false, 'a throw is refused outside the mode');
  assert.equal(fun.list.length, 0);
  fun.refreshT = .01;
  fun.update(1 / 60);
  assert.equal(fun.placed.length, 0, 'nothing ticks outside the mode');
  assert.equal(pickups.drops.length, 0, 'no prop boxes are seeded outside the mode');
});
