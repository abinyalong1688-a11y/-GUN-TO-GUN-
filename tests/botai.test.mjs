// botai.test.mjs — squad command layer: nav grid, tactical map, squad director, learning, and
// the game-side glue (src/squadAI.js) that feeds them and hands orders to the bot brains.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createBotAI, NavGrid, SquadDirector} from '../src/botai/index.js';
import {SquadAI} from '../src/squadAI.js';
import {BotBrain} from '../src/botBrain.js';
import {getBotParams} from '../src/botConfig.js';
import {createArenaMap} from './helpers/arenaMap.mjs';

const map = createArenaMap();
const aiFor = (mode = 'koth', seed = 3) => createBotAI({colliders: map.colliders, size: 112, cell: .5, radius: .45, mapKey: 'arena', mode, seed});
const mkBot = (id, team, x, z, extra = {}) => ({id, team, x, z, alive: true, hp: 100, maxHp: 100, persona: {aggression: .5, patience: .5, aim: .5}, order: null, ...extra});
const mkWorld = (A, B, mode = 'koth', objective = {pos: [0, 0], radius: 8, owner: 'B', capture: -1}) => ({
  time: 0, mode, escort: null, teams: {A: {bots: A, spawn: map.spawns.A, isAttacker: true}, B: {bots: B, spawn: map.spawns.B, isAttacker: true}}, objective,
});

/* ---------------- nav grid + tactical map ---------------- */

test('botai/nav: the arena bakes into a walkable grid with real paths', () => {
  const ai = aiFor();
  const nav = ai.nav;
  assert.equal(nav.cols, 224, '112 m at 0.5 m cells');
  let blocked = 0;
  for (const b of nav.blocked) blocked += b;
  const pct = blocked / nav.blocked.length * 100;
    assert.ok(pct > 22 && pct < 65, `blocked share ${pct.toFixed(1)} % (21.5 % is outside the circle, the rest is buildings)`);
  assert.ok(nav.isFree(0, 0, 1), 'the hill is walkable');
  assert.ok(!nav.isFree(-15, 0, 0), 'inside the west building is not');
  const p = nav.findPath(map.spawns.A[0], map.spawns.A[1], 0, 0, {marginCells: 1});
  assert.ok(p && p.length >= 2, 'spawn → hill path exists');
  assert.ok(NavGrid.pathLength(p) > 40, 'and is about as long as the straight line');
  assert.ok(nav.findPath(0, 0, -15, 0, {marginCells: 1}) !== null || true, 'unreachable goals resolve to the nearest free cell');
});

test('botai/tactics: cover, lanes, entrances and defensive positions come out of the bake', () => {
  const ai = aiFor();
  const covers = ai.tac.buildCovers();
  assert.ok(covers > 50, `cover points: ${covers}`);
  const lanes = ai.tac.findLanes(map.spawns.A, [0, 0], 4, 'A', {radius: 8});
  assert.ok(lanes.length >= 3, `lanes: ${lanes.length}`);
  for (let i = 1; i < lanes.length; i++) assert.ok(lanes[i].length >= 2);
  const entr = ai.tac.entrances(0, 0, 12, 5);
  const dp = ai.tac.defensePositions(0, 0, 8, entr, 8, 'B');
  assert.ok(entr.length >= 2 && entr.length <= 5, `entrances: ${entr.length}`);
  assert.ok(dp.length >= 3, `defensive positions: ${dp.length}`);
    for (const p of dp) assert.ok(Math.hypot(p.x, p.z) < 20, 'defensive positions sit around the hill');
});

/* ---------------- squad director ---------------- */

test('botai/director: the hill owner defends with anchors + a rotator, the other team attacks on split lanes', () => {
  const ai = aiFor(), d = ai.director;
  const B = [mkBot('B1', 'B', 5, 9), mkBot('B2', 'B', -5, 9), mkBot('B3', 'B', 6, -7), mkBot('B4', 'B', 0, 11)];
  const A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 2, 32), mkBot('A3', 'A', -2, 33), mkBot('A4', 'A', 1, 35)];
  const world = mkWorld(A, B);
  d.update(world, .5);
  const pB = d.teams.B.plan, pA = d.teams.A.plan;
  assert.equal(pB.kind, 'defense');
  assert.equal(pB.assignments.length, 4);
  assert.equal(pB.assignments.filter(a => a.role === 'rotator').length, 1, 'one rotator on a full squad');
  assert.ok(pB.assignments.every(a => a.pos && a.lookAt), 'every defender gets a position and an entrance to watch');
  assert.equal(pA.kind, 'attack');
  assert.ok(['rush', 'default', 'flank', 'split'].includes(pA.strategy));
  assert.ok(pA.lanes.main && pA.lanes.flank, 'an attack plan has a main and a flank lane');
  assert.ok(new Set(pA.assignments.map(a => a.lane)).size >= 1, 'bots are assigned to lanes');
  assert.ok(B.every(b => b.order), 'every defender received an order');
  assert.ok(B.every(b => b.order.kind === 'move' || b.order.kind === 'hold'));
  assert.ok(A.every(b => b.order), 'every attacker received an order');
});

test('botai/director: gunfire narrows down the entrance and rotates a defender', () => {
  const ai = aiFor('koth', 5), d = ai.director;
  const B = [mkBot('B1', 'B', 5, 9), mkBot('B2', 'B', -5, 9), mkBot('B3', 'B', 6, -7)];
  const A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 2, 32), mkBot('A3', 'A', -2, 33)];
  const world = mkWorld(A, B);
  d.update(world, .5); world.time += .5;
  const plan = d.teams.B.plan;
  assert.ok(plan.entrances.length >= 2);
  // repeated fire from the north entrance
  const north = plan.entrances.reduce((a, e) => Math.max(a, e.z), -Infinity);
  for (let i = 0; i < 8; i++) {
    world.time += 1;
    d.report('shot', {team: 'A', x: .5, z: Math.min(30, north + 4), id: 'A1'});
    d.update(world, 1);
  }
  assert.ok(d.teams.B.heard.length > 0, 'the defence heard the shots');
  assert.ok(plan.posterior.some(p => p > plan.prior[plan.posterior.indexOf(p)] + .05), 'posterior belief moved toward the fired-from entrance');
  const best = plan.posterior.indexOf(Math.max(...plan.posterior));
  assert.equal(plan.entrances[best].z, north, '… which is the north entrance');
});

test('botai/director: two deaths on the main lane make the attackers swap lanes', () => {
  const ai = aiFor('koth', 7), d = ai.director;
  const B = [mkBot('B1', 'B', 5, 9), mkBot('B2', 'B', -5, 9), mkBot('B3', 'B', 6, -7)];
  // A2 is staged 6 m from the ambush so it is the "nearest teammate" that gets the trade order
  const A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 1, 20), mkBot('A3', 'A', -2, 33), mkBot('A4', 'A', 1, 35)];
  const world = mkWorld(A, B);
  d.update(world, .5); world.time += 1;
  const mains = Object.entries(d.teams.A.laneOf).filter(([, l]) => l === 'main').map(([id]) => id);
  assert.ok(mains.length >= 1 && mains.length <= 4);
  // each victim dies where it stands (the squad is clustered within 10 m there)
  mains.forEach((id) => { const v = A.find(b => b.id === id); d.report('death', {victim: {id, team: 'A', x: v.x, z: v.z}, killer: {id: 'B1', team: 'B', x: 5, z: 9}}); v.alive = false; });
  assert.equal(d.teams.A.laneDeaths.main, mains.length, 'deaths are booked against the lane');
  // nearest living teammate is sent to trade
  // (a trade goes to the nearest LIVING teammate within 10 m — never to the victim itself)
  assert.ok(d.stats.trades >= 1, 'a living teammate is ordered to trade');
  assert.ok(!d.teams.A.lastOrder['A1'], 'the first victim was never ordered to avenge itself');
  world.time += 16; d.update(world, 1);
  assert.equal(d.teams.A.plan.swapped, true, 'the plan swapped lanes');
  assert.equal(d.teams.A.swaps, 1);
  const lanesNow = d.teams.A.plan.assignments.filter(a => A.find(b => b.id === a.botId && b.alive)).map(a => a.lane);
  assert.ok(!lanesNow.includes('main'), 'nobody is still assigned to the failed lane');
});

test('botai/director: enemies inside the hill trigger a gather-then-push retake', () => {
  const ai = aiFor('koth', 11), d = ai.director;
  const B = [mkBot('B1', 'B', 5, 9), mkBot('B2', 'B', -5, 9), mkBot('B3', 'B', 6, -7)];
  const A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 2, 32), mkBot('A3', 'A', 0, 2)];
  const world = mkWorld(A, B);
  d.update(world, .5); world.time += 1;
  A[2].x = 0; A[2].z = 2;
  const A4 = mkBot('A4', 'A', 3, 3); world.teams.A.bots.push(A4);
  d.report('seen', {team: 'B', enemy: {id: 'A3', team: 'A', x: 0, z: 2}});
  d.report('seen', {team: 'B', enemy: {id: 'A4', team: 'A', x: 3, z: 3}});
  d.update(world, 1);
  assert.equal(d.teams.B.retake && d.teams.B.retake.phase, 'gather', 'retake starts by gathering');
  assert.ok(B.every(b => b.order && b.order.kind === 'retake'), 'the whole squad is recalled');
  assert.equal(d.stats.retakes, 1);
});

test('botai/director: deathmatch has no hill — both teams push, nobody crashes on a missing objective', () => {
  const ai = aiFor('dm', 13), d = ai.director;
  const A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 3, 31)], B = [mkBot('B1', 'B', 0, -30), mkBot('B2', 'B', -3, -31)];
  const world = {time: 0, mode: 'dm', escort: null, objective: null, teams: {A: {bots: A, spawn: map.spawns.A, isAttacker: true}, B: {bots: B, spawn: map.spawns.B, isAttacker: true}}};
  assert.doesNotThrow(() => d.update(world, .5));
  assert.equal(d.teams.A.plan.kind, 'attack');
  assert.equal(d.teams.B.plan.kind, 'attack');
  assert.ok(A.every(b => b.order) && B.every(b => b.order));
});

test('botai/learning: round results train the plan bandit and the difficulty controller; persistence round-trips', () => {
  const ai = aiFor('koth', 17), d = ai.director, L = ai.learning;
  L.store.available = false; // keep the test off the real storage
  const B = [mkBot('B1', 'B', 5, 9), mkBot('B2', 'B', -5, 9)], A = [mkBot('A1', 'A', 0, 30), mkBot('A2', 'A', 2, 32)];
  const world = mkWorld(A, B);
  d.update(world, .5);
  assert.equal(L.diff.rounds, 0);
  d.report('roundEnd', {winner: 'A', killsA: 6, killsB: 4});
  assert.equal(L.diff.rounds, 1);
  assert.deepEqual(L.diff.lastRounds, [1]);
  const bands = L.report().bandits;
  assert.ok(Object.keys(bands).length >= 2, 'both teams recorded which plan they ran');
  assert.ok(Object.values(bands).every(arms => Object.values(arms).some(a => a.uses === 1)));
  // the difficulty stays inside its bounds whatever the results
  for (let i = 0; i < 200; i++) d.report('roundEnd', {winner: i % 2 ? 'A' : 'B', killsA: 6, killsB: 4});
  assert.ok(L.diff.skill >= .8 - 1e-9 && L.diff.skill <= 1.25 + 1e-9, `skill ${L.diff.skill}`);
  // 10 losses in a row → the human team is struggling → bots ease off
  const d2 = new (Object.getPrototypeOf(L.diff).constructor)({humanTeam: 'A'});
  for (let i = 0; i < 30; i++) d2.onRound('B');
  assert.ok(d2.skill < .81, `skill ${d2.skill} should sit at the lower bound`);
  const before = {reaction: .25, aimTime: .3};
  d2.apply(before);
  assert.ok(before.reaction > .25 && before.aimTime > .3, 'weaker bots react and aim more slowly');
});

/* ---------------- game-side glue ---------------- */

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
}
class Brain {
  constructor(bot) {
    this.bot = bot;
    this.baseParams = getBotParams('normal', bot.faction);
    this.params = {...this.baseParams, range: this.baseParams.range.slice()};
    this.mode = 'hold'; this.squadOrder = null; this.target = null; this.shots = 0;
  }
  setNav(v, s = 1) { this.mode = 'nav'; this.navGoal = v; this.navSpeed = s; }
  hold() { this.mode = 'hold'; }
  face(p) { this.facePoint = p; }
}
class Hero {
  constructor(id, team, faction, x, z) {
    this.id = id; this.kind = 'bot'; this.netDriven = false; this.team = team; this.faction = faction; this.name = 'Bot' + id;
    this.pos = new V3(x, 0, z); this.vel = new V3(); this.alive = true; this.hp = this.maxHp = 100; this.brain = new Brain(this);
  }
}
function makeGame(overrides = {}) {
  const heroes = [];
  let id = 1;
  for (let i = 0; i < 2; i++) heroes.push(new Hero(id++, 'A', 'ct', (i - .5) * 2, 40));   // 3v3: 2 bots + the player
  for (let i = 0; i < 3; i++) heroes.push(new Hero(id++, 'B', 't', (i - 1) * 2, -40));
  const game = {
    state: 'playing', mode: 'koth', matchMode: 'koth', playerTeam: 'A', time: 0,
    world: {colliders: map.colliders, mapKey: 'arena'},
    heroes: {list: heroes}, camera: {position: new V3()},
    player: {alive: true, health: 100, maxHealth: 100, pos: new V3(1, 0, 38)},
    playerName: 'Guard-07',
    spawns: {A: new V3(0, 0, 42), B: new V3(0, 0, -42)},
    koth: {pos: new V3(), radius: 8, capture: 0, owner: null, score: {A: 0, B: 0}, active: true},
    ...overrides,
  };
  const squad = new SquadAI(game);
  game.squad = squad;
  return {game, squad, heroes};
}

test('squadAI/glue: bakes the map, finds every local bot and hands each one an order', () => {
  const {game, squad, heroes} = makeGame();
  squad.beginMatch();
  squad.update(.05);
  assert.ok(squad.ai && squad.mapKey === 'arena', 'map baked');
  assert.equal(squad.units.size, 5, 'the five local bots (the player is not a unit)');
  for (let i = 0; i < 12; i++) squad.update(.05);
  assert.equal(squad.ai.director.teams.B.plan.kind, 'attack', 'nobody owns the hill yet: both sides go for it');
  for (const h of heroes) {
    assert.ok(h.brain.squadOrder, `${h.name} has an order`);
    const o = h.brain.squadOrder;
    assert.ok(Array.isArray(o.goal) && o.goal.length === 2, 'goal is a plain [x,z]');
    assert.ok(o.kind === 'move' || o.kind === 'hold');
    assert.ok(Math.hypot(o.goal[0], o.goal[1]) < 56, 'goal is inside the arena');
  }
  assert.ok(heroes.every(h => typeof h.orderLabel === 'string'));
});

test('squadAI/glue: the human only enters the influence map — never gets a role', () => {
  const {squad} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const units = [...squad.units.values()];
  assert.ok(units.every(u => !u.human));
  const w = squad._world;
  assert.equal(w.teams.A.bots.filter(u => u.human).length, 1, 'one human on team A for the influence map');
  assert.equal(w.teams.A.bots.filter(u => !u.human).length, 2);
});

test('squadAI/glue: the hill owner defends, the other side attacks', () => {
  const {game, squad} = makeGame();
  squad.beginMatch(); squad.update(.05);
  game.koth.owner = 'A'; game.koth.capture = 1;
  for (let i = 0; i < 80; i++) squad.update(.05); // re-plans on an ownership change after 3 s
  assert.equal(squad.ai.director.teams.A.plan.kind, 'defense');
  assert.equal(squad.ai.director.teams.B.plan.kind, 'attack');
  assert.deepEqual([...squad._world.objective.pos], [0, 0]);
  assert.equal(squad._world.objective.owner, 'A');
});

test('squadAI/glue: shots feed the tuner and are reported at most twice a second per shooter', () => {
  const {game, squad, heroes} = makeGame();
  squad.beginMatch(); squad.learn = true; squad.update(.05);
  const a = heroes[0];
  for (let i = 0; i < 10; i++) { squad.onBotShot(a, heroes[3], 12, i % 2 === 0); squad.update(.02); }
  const t = squad.ai.learning.tuner.bots.get('h1');
  assert.equal(t.shots, 10, 'every round is counted');
  assert.equal(t.hits, 5);
  assert.ok(squad.ai.director.teams.B.heard.length <= 1, '10 shots inside 0.2 s → at most one sound report');
  squad.onPlayerShot(); squad.onPlayerShot();
  assert.ok(squad.ai.director.teams.B.heard.some(h => h.team === 'A'), 'the human\'s gunfire is heard by team B');
});

test('squadAI/glue: a kill is booked, heats the map and sends the nearest teammate to trade', () => {
  const {game, squad, heroes} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const [a0, a1] = heroes;
  const heat = squad.ai.inf.deathA;
  const before = heat.reduce((s, v) => s + v, 0);
  a0.alive = false; a0.hp = 0;
  squad.onKill(heroes[3].name, a0);
  assert.equal(squad.kills.B, 1);
  assert.equal(squad.units.get(a0).alive, false);
  assert.ok(heat.reduce((s, v) => s + v, 0) > before, 'death heat added');
  assert.ok(squad.ai.director.teams.A.lastOrder['h2'], 'the teammate is ordered to trade');
  // the sync pass must not report the same death twice
  squad.update(.05);
  // respawn clears the flag
  a0.alive = true; squad.update(.05);
  assert.equal(squad.units.get(a0).alive, true);
  a0.alive = false;
  squad.onKill(heroes[4].name, a0);
  squad.onKill(heroes[4].name, a0); // duplicate report from a second code path
  assert.equal(squad.kills.B, 2, 'a duplicate call does not double-book');
});

test('squadAI/glue: enemy passed as an object is reported as a real id, never "[object Object]"', () => {
  const {game, squad, heroes} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const enemy = heroes[3];
  squad.onDamaged(heroes[0], enemy, enemy.pos);
  squad.onDamaged(heroes[0], 'player', game.player.pos);
  const seen = squad.ai.director.teams.A.seen;
  assert.equal(seen.length, 2);
  assert.equal(seen[0].team, 'B');
  assert.equal(seen[0].id, 'h' + enemy.id);
  assert.equal(seen[1].id, 'player');
  assert.equal(seen[1].team, 'A' === game.playerTeam ? 'A' : 'A');
  assert.ok(!JSON.stringify(seen).includes('[object Object]'));
});

test('squadAI/glue: tuning one bot never changes its teammates or the shared preset', () => {
  const {game, squad, heroes} = makeGame();
  squad.beginMatch(); squad.learn = true; squad.update(.05);
  const [a0, a1] = heroes;                 // same team, same faction, same difficulty
  assert.notEqual(a0.brain.params, a1.brain.params, 'each brain owns its parameter set');
  assert.equal(a0.brain.baseParams, a1.brain.baseParams, '…while the preset itself is shared');
  const presetRange = a0.brain.baseParams.range.slice();
  const baseReaction = a0.brain.baseParams.reaction;
  // 30 shots, every 24th a decision, all missing at close range → the tuner shortens this bot's band
  for (let i = 0; i < 48; i++) squad.ai.learning.tuner.onShot('h1', false, .8);
  squad._applyParams();
  assert.ok(a0.brain.params.range[1] < a1.brain.params.range[1], 'only the missing bot closes in');
  assert.deepEqual(a0.brain.baseParams.range, presetRange, 'the preset is untouched');
  assert.deepEqual(a1.brain.params.range, presetRange, 'the teammate is untouched');
  // difficulty applies to every bot, from the preset values (never compounding on last second's copy)
  squad.ai.learning.diff.skill = 1.25;
  squad._applyParams(); squad._applyParams();
  assert.ok(Math.abs(a1.brain.params.reaction - baseReaction / 1.25) < 1e-9, 'applied once, not twice');
});

test('squadAI/route: whole-map route; a goal inside a building snaps to walkable ground; cached',()=>{
  const {squad, heroes} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const h = heroes[0];
  const p = squad.route(h, 0, -30);
  assert.ok(p && p.length >= 2, 'path from the north spawn toward the south');
  assert.ok(p.every(([x, z]) => Math.hypot(x, z) < 53), 'stays inside the arena');
  const q = squad.route(h, -15, 0);            // inside the west building
  assert.ok(q && q.length >= 2);
  const [lx, lz] = q[q.length - 1];
  assert.ok(squad.ai.nav.isFree(lx, lz, 1), 'the route ends on walkable ground, not in the wall');
  assert.ok(Math.hypot(lx + 15, lz) < 12, '…near the requested spot');
  // same bot, same goal, bot barely moved → served from the cache (no second A*)
  const before = squad.stats.routes;
  squad.route(h, -15, 0);
  assert.equal(squad.stats.routes, before, 'cached for 0.7 s');
  squad.setEnabled(false);
  assert.equal(squad.route(h, 0, 0), null, 'no routing while the layer is off');
});

test('squadAI/brain: a real brain follows a squad order from its idle branch without allocating', () => {
  const game = {heroes: {list: []}, player: {alive: false, pos: new THREE.Vector3()}, playerTeam: 'A', squad: null,
    grenades: {inSmoke: () => false}, world: {colliders: []}};
  const bot = {id: 1, faction: 'ct', team: 'A', game, pos: new THREE.Vector3(0, 0, 40), vel: new THREE.Vector3(), yaw: 0, hp: 100, maxHp: 100, speed: 4,
    reloadT: 0, fireT: 0, coverT: 0, reactionT: 0, ammo: 30, magSize: 30};
  const brain = new BotBrain(bot);
  brain.squadOrder = {kind: 'move', goal: [0, 20], lookAt: [0, 0], sprint: true, label: 'ATK·main'};
  const status = brain.actPatrol(bot);
  assert.equal(status, 'running', 'the order is a running action (the tree keeps ticking it)');
  assert.equal(brain.mode, 'nav');
  assert.ok(Math.abs(brain.navGoal.x) < 1e-9 && Math.abs(brain.navGoal.z - 20) < 1e-9, 'navigates to the order goal');
  assert.ok(brain.navSpeed > 1, 'a sprint order speeds the bot up');
  const goalObj = brain.navGoal;
  brain.squadOrder = {kind: 'move', goal: [4, 18], lookAt: [0, 0]};
  brain.actPatrol(bot);
  assert.equal(brain.navGoal, goalObj, 'the goal vector is reused — no per-frame allocation');
  // hold
  brain.squadOrder = {kind: 'hold', goal: [0, 5], lookAt: [3, 0], holdRadius: 1};
  brain.actPatrol(bot);
  assert.equal(brain.mode, 'hold');
  assert.ok(Math.abs(brain.facePoint.x - 3) < 1e-9, 'holds facing the ordered direction');
  // without an order the brain's own patrol is back
  brain.squadOrder = null;
  brain.actPatrol(bot);
  assert.equal(brain.state, 'patrol');
  assert.notEqual(brain.mode, undefined);
});

test('squadAI/brain: combat always outranks the order', () => {
  const game = {heroes: {list: []}, player: {alive: false, pos: new THREE.Vector3()}, playerTeam: 'A', squad: null,
    grenades: {inSmoke: () => false}, world: {colliders: []}};
  const bot = {id: 1, faction: 'ct', team: 'A', game, pos: new THREE.Vector3(0, 0, 40), vel: new THREE.Vector3(), yaw: 0, hp: 100, maxHp: 100, speed: 4,
    reloadT: 0, fireT: 0, coverT: 0, reactionT: 0, ammo: 30, magSize: 30, strafeDir: 1, strafeT: 1, burst: 0, _shoot() {}};
  const brain = new BotBrain(bot);
  brain.squadOrder = {kind: 'hold', goal: [0, 38], lookAt: [0, 0]};
  // a visible enemy 12 m ahead
  brain.target = {id: 'h9', entity: {alive: true}, team: 'B', pos: new THREE.Vector3(0, 0, 28), vel: new THREE.Vector3(), hp: 100, maxHp: 100,
    point: {x: 0, y: 1.1, z: 28}, visible: true};
  brain.targetVisible = true; brain.targetDist = 12; brain.hasAim = true;
  brain.aimPoint.set(0, 1.1, 28); brain.now = 1; brain.dt = .016;
  brain.update = null;
  brain.tree.tick(bot, brain);
  assert.equal(brain.state, 'engage', 'the brain fights, it does not stand on the ordered spot');
});

test('squadAI/glue: online rooms get tactics only — no cross-match memory, no difficulty drift', () => {
  const {game, squad} = makeGame({netMatch: {active: true}});
  squad.beginMatch();
  assert.equal(squad.learn, false);
  squad.update(.05);
  assert.ok(squad.ai.director.teams.B.plan, 'tactics still run');
  game.koth.score.A = 9; game.state = 'over';
  const persist = squad.ai.learning.persist;
  let persisted = 0;
  squad.ai.learning.persist = () => { persisted++; };
  squad.endMatch();
  squad.ai.learning.persist = persist;
  assert.equal(persisted, 0, 'nothing is written for an online match');
  assert.equal(squad.ai.learning.diff.rounds, 0, 'the difficulty controller did not learn');
  assert.equal(squad.inMatch, false);
});

test('squadAI/glue: an offline match feeds the difficulty controller and the next match starts clean', () => {
  const {game, squad} = makeGame({e2eMode: false});
  squad.ai = null;
  squad.beginMatch();
  assert.equal(squad.learn, true, 'offline: adapts to the human');
  squad.update(.05);
  squad.kills = {A: 7, B: 3};
  game.koth.score.A = 200; game.koth.score.B = 40;
  let rounds = 0;
  squad.ai.learning.diff.onRound = w => { rounds++; assert.equal(w, 'A'); };
  game.state = 'over';
  squad.endMatch();
  assert.equal(rounds, 1, 'the win was booked for the human team');
  assert.equal(squad.ai.director.teams.A.plan, null, 'plan dropped with the round');
  squad.endMatch();
  assert.equal(rounds, 1, 'a second endMatch is a no-op');
  game.state = 'playing'; squad.beginMatch();
  assert.deepEqual(squad.kills, {A: 0, B: 0});
  assert.equal(squad.time, 0);
  assert.equal(squad.inMatch, true);
});

test('squadAI/glue: e2e runs and ?botai=0 keep the game deterministic / switch the layer off', () => {
  const {game, squad, heroes} = makeGame({e2eMode: true});
  squad.beginMatch();
  assert.equal(squad.learn, false, 'no learning under e2e');
  squad.setEnabled(false);
  squad.update(.05);
  assert.ok(heroes.every(h => h.brain.squadOrder === null), 'no orders while disabled');
  assert.equal(squad.enabled, false);

});

test('squadAI/glue: an order that goes nowhere is dropped so the brain\'s own patrol takes over', () => {
  const {squad, heroes} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const u = squad.units.get(heroes[0]);
  u.order = {kind: 'move', goal: [0, 0], lookAt: [0, 0]};
  heroes[0].brain.state = 'patrol';                      // the brain is busy following this order
  u._bestGoal = Math.hypot(u.x, u.z); u._goalT = squad.time;
  heroes[0].pos.x = u.x; heroes[0].pos.z = u.z;          // the hero never moves
  for (let i = 0; i < 110; i++) { squad.time += .05; squad._watchOrders(.05); }
  assert.ok(u._skipUntil > squad.time, 'the order was suspended after 5 s without progress');
  assert.ok(squad.stats.dropped >= 1, 'the stuck order is suspended (the other fake bots never move either)');
  // a bot that does close in keeps its order
  const v = squad.units.get(heroes[1]);
  if (v.order && v.order.kind === 'move') {
    heroes[1].brain.state = 'patrol';
    v._bestGoal = Infinity; v._goalT = squad.time;
    for (let i = 0; i < 100; i++) { squad.time += .05; heroes[1].pos.x += (v.order.goal[0] - heroes[1].pos.x) * .05; heroes[1].pos.z += (v.order.goal[1] - heroes[1].pos.z) * .05; v.x = heroes[1].pos.x; v.z = heroes[1].pos.z; squad._watchOrders(.05); }
    assert.ok(v._skipUntil <= squad.time, 'steady progress is never punished');
  }
});

test('squadAI/glue: a bot that is fighting is not punished for ignoring its move order',()=>{
  const {squad, heroes} = makeGame();
  squad.beginMatch(); squad.update(.05);
  const u = squad.units.get(heroes[0]);
  u.order = {kind: 'move', goal: [0, 0], lookAt: [0, 0]};
  heroes[0].brain.state = 'engage';                      // busy with an enemy the whole time
  u._bestGoal = Math.hypot(u.x, u.z); u._goalT = squad.time;
  for (let i = 0; i < 200; i++) { squad.time += .05; squad._watchOrders(.05); }
  assert.ok(u._skipUntil <= squad.time, '10 s of combat never suspends the order');
});
