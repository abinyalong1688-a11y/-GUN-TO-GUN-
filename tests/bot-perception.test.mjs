// bot-perception.test.mjs — view cone / range / LOS / memory / hearing for the bot senses
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {BotSensor, canSee, forwardFromYaw} from '../src/botPerception.js';

const PARAMS = {fov: 2.30, viewRange: 46, proximity: 5, memoryTime: 4};
const observer = (yaw = 0, pos = [0, 0, 0]) => ({pos: new THREE.Vector3(...pos), yaw, team: 'A'});
const target = (pos = [0, 0, 10], team = 'B') => ({pos: new THREE.Vector3(...pos), team, alive: true});

test('forwardFromYaw follows the game convention (+Z at yaw 0)', () => {
  const f = forwardFromYaw(0);
  assert.ok(Math.abs(f.x) < 1e-9 && Math.abs(f.z - 1) < 1e-9);
  const g = forwardFromYaw(Math.PI / 2);
  assert.ok(Math.abs(g.x - 1) < 1e-9 && Math.abs(g.z) < 1e-9);
});

test('canSee: range, cone, team and line-of-sight gate visibility', () => {
  assert.equal(canSee(observer(0), target(), PARAMS, () => true), true, 'front target in range and LOS');
  assert.equal(canSee(observer(0), target([0, 0, -10]), PARAMS, () => true), false, 'behind the bot');
  assert.equal(canSee(observer(0), target([10, 0, 0]), PARAMS, () => true), false, '90° off-axis is outside the 132° cone');
  assert.equal(canSee(observer(0), target([0, 0, 60]), PARAMS, () => true), false, 'beyond view range');
  assert.equal(canSee(observer(0), target([0, 0, 10], 'A'), PARAMS, () => true), false, 'teammates are not targets');
  assert.equal(canSee(observer(0), target(), PARAMS, () => false), false, 'cover blocks sight');
});

test('canSee: close proximity bypasses the view cone (footsteps)', () => {
  assert.equal(canSee(observer(0), target([0, 0, -4]), PARAMS, () => true), true);
  assert.equal(canSee(observer(0), target([3, 0, 0]), PARAMS, () => true), true);
  assert.equal(canSee(observer(0), target([0, 0, -6]), PARAMS, () => true), false, 'just outside proximity and behind');
});

test('sensor: sight memory decays after memoryTime; suspicions keep the last position', () => {
  const s = new BotSensor();
  const bot = observer(0);
  const b = target([0, 0, 10]);
  const cand = [{id: 'h1', entity: b, team: 'B', pos: b.pos, vel: new THREE.Vector3(1, 0, 0), hp: 100, maxHp: 100}];
  s.sense(bot, cand, 0, () => true, PARAMS);
  assert.equal(s.visibleCount(0), 1);
  assert.equal(s.get('h1').visible, true);
  // A wall appears: visibility drops but the memory keeps the last known position.
  s.sense(bot, cand, 1, () => false, PARAMS);
  assert.equal(s.get('h1').visible, false);
  assert.equal(s.suspicions(1, PARAMS).length, 1);
  s.sense(bot, cand, 4.2, () => false, PARAMS);
  assert.equal(s.get('h1'), null, 'memory expires after memoryTime seconds');
});

test('sensor: sticky sight survives a turn for a moment, then drops out of the cone', () => {
  const s = new BotSensor();
  const b = target([0, 0, 10]);
  const cand = [{id: 'h1', entity: b, team: 'B', pos: b.pos, hp: 100, maxHp: 100}];
  s.sense(observer(0), cand, 0, () => true, PARAMS);
  const turned = observer(Math.PI);
  s.sense(turned, cand, .2, () => true, PARAMS);
  assert.equal(s.get('h1').visible, true, 'recently visible targets stay sticky for 0.35 s');
  s.sense(turned, cand, .6, () => true, PARAMS);
  assert.equal(s.get('h1').visible, false, 'after the sticky window the cone applies again');
});

test('sensor: memory keeps the last SEEN position — an unseen enemy cannot leak its new one', () => {
  const s = new BotSensor();
  const b = target([0, 0, 10]);
  const cand = [{id: 'h1', entity: b, team: 'B', pos: b.pos, vel: new THREE.Vector3(), hp: 100, maxHp: 100}];
  s.sense(observer(0), cand, 0, () => true, PARAMS);
  b.pos.set(20, 0, 10); // the enemy walks away behind cover
  cand[0].hp = 20;
  s.sense(observer(0), cand, 1, () => false, PARAMS);
  const mem = s.get('h1');
  assert.equal(mem.visible, false);
  assert.equal(mem.pos.x, 0, 'memory must stay at the last seen spot, not track an unseen target');
  assert.equal(mem.point.x, 0, 'the remembered aim point must not leak either');
  assert.equal(mem.hp, 100, 'unseen health must not leak through memory either');
});

test('sensor: hearing injects an approximate position and never overwrites live sight', () => {
  const s = new BotSensor();
  s.hear('player', new THREE.Vector3(12, 0, 0), 1, {noise: 0, entity: 'player', team: 'A'});
  const heard = s.get('player');
  assert.equal(heard.source, 'sound');
  assert.equal(heard.confidence, .35);
  assert.equal(heard.visible, false);
  assert.equal(heard.pos.x, 12);
  // Live sight wins over ears.
  const p = new THREE.Vector3(0, 0, 8);
  s.sense(observer(0), [{id: 'player', entity: 'player', team: 'B', pos: p, hp: 100, maxHp: 100}], 2, () => true, PARAMS);
  s.hear('player', new THREE.Vector3(99, 0, 0), 2.1, {noise: 0, entity: 'player', team: 'B'});
  assert.equal(s.get('player').visible, true);
  assert.equal(s.get('player').pos.x, 0, 'hearing must not move a visible target');
});

test('sensor: damage alerts are higher confidence than gunfire', () => {
  const s = new BotSensor();
  s.alert('h5', new THREE.Vector3(3, 0, 4), 1, {noise: 0, entity: {id: 5}, team: 'B'});
  const e = s.get('h5');
  assert.equal(e.source, 'damage');
  assert.equal(e.confidence, .8);
  assert.equal(e.pos.z, 4);
});

test('sensor: smoke hides a distant target but not one in proximity', () => {
  const s = new BotSensor();
  s.obscured = () => true;
  const far = target([0, 0, 20]);
  s.sense(observer(0), [{id: 'h1', entity: far, team: 'B', pos: far.pos, hp: 100, maxHp: 100}], 0, () => true, PARAMS);
  assert.equal(s.get('h1'), null, 'smoke blocks sight at range');
  const near = target([0, 0, 3]);
  s.sense(observer(0), [{id: 'h2', entity: near, team: 'B', pos: near.pos, hp: 100, maxHp: 100}], 0, () => true, PARAMS);
  assert.equal(s.get('h2') && s.get('h2').visible, true, 'proximity awareness still works inside smoke');
});

test('sensor: dead entities are pruned immediately', () => {
  const s = new BotSensor();
  const b = target();
  s.sense(observer(0), [{id: 'h1', entity: b, team: 'B', pos: b.pos, hp: 100, maxHp: 100}], 0, () => true, PARAMS);
  assert.ok(s.get('h1'));
  b.alive = false;
  s.prune(.1, PARAMS);
  assert.equal(s.get('h1'), null);
});
