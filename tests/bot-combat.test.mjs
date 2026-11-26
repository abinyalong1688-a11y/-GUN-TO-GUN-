// bot-combat.test.mjs — target priority, ballistic lead, accuracy model and cover selection
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  leadPoint, shotMissChance, scoreTarget, aimErrorOffset,
  segmentBlocked, coverPointsFor, scoreCoverPoint, findBestCover, isPointClear,
  teammateBlockingShot,
} from '../src/botCombat.js';

const PARAMS = {accuracy: .83, missK: 1, aimJitter: .02, settleError: .4};

test('leadPoint leads a strafing target by distance / bullet speed', () => {
  const from = new THREE.Vector3(0, 0, 0);
  const pos = new THREE.Vector3(0, 0, 20);
  const vel = new THREE.Vector3(10, 0, 0);
  const aimed = leadPoint(from, pos, vel, 1);
  assert.ok(aimed.x > 1.5 && aimed.x < 2.0, 'lead at 20 m and 10 m/s should be ≈1.8 m, got ' + aimed.x.toFixed(2));
  assert.equal(leadPoint(from, pos, vel, 0).x, 0, 'zero lead aims at the current position');
  const half = leadPoint(from, pos, vel, .5);
  assert.ok(half.x > 0 && half.x < aimed.x, 'partial lead scales down');
});

test('shotMissChance: base accuracy, distance, motion, settling, smoke and clamping', () => {
  const clean = shotMissChance(PARAMS, {dist: 10, targetSpeed: 0, settle: 1});
  assert.ok(Math.abs(clean - .17) < 1e-6, 'clean 10 m shot should miss 17 %, got ' + clean);
  const far = shotMissChance(PARAMS, {dist: 25, targetSpeed: 0, settle: 1});
  assert.ok(far > clean, 'distance increases the miss chance');
  const moving = shotMissChance(PARAMS, {dist: 10, targetSpeed: 6, settle: 1});
  assert.ok(moving > clean, 'a strafing target is harder to hit');
  const fresh = shotMissChance(PARAMS, {dist: 10, targetSpeed: 0, settle: 0});
  assert.ok(fresh > clean, 'an unsettled aim is less accurate');
  const smoked = shotMissChance(PARAMS, {dist: 10, targetSpeed: 0, settle: 1, smoke: true});
  assert.ok(smoked > clean, 'smoke increases the miss chance');
  const capped = shotMissChance({accuracy: .4, missK: 2}, {dist: 90, targetSpeed: 20, settle: 0, smoke: true});
  assert.equal(capped, .92, 'the miss chance caps at .92');
  assert.ok(shotMissChance({accuracy: .99, missK: 1}, {dist: 0}) >= .02, 'a floor keeps some spread');
});

test('scoreTarget prefers visible, close, wounded and already-tracked enemies', () => {
  const now = 10;
  const bot = new THREE.Vector3(0, 0, 0);
  const base = {id: 'a', team: 'B', hp: 100, maxHp: 100, confidence: 0, source: 'sight', lastSeen: now, pos: new THREE.Vector3(0, 0, 10)};
  const visible = {...base, visible: true};
  const remembered = {...base, id: 'b', visible: false, lastSeen: now - 2};
  assert.ok(scoreTarget(visible, bot, now) > scoreTarget(remembered, bot, now), 'sight outranks memory');
  const wounded = {...visible, id: 'c', hp: 20};
  assert.ok(scoreTarget(wounded, bot, now) > scoreTarget(visible, bot, now), 'a wounded target is preferred');
  const near = {...visible, id: 'd', pos: new THREE.Vector3(0, 0, 3)};
  const far = {...visible, id: 'e', pos: new THREE.Vector3(0, 0, 30)};
  assert.ok(scoreTarget(near, bot, now) > scoreTarget(far, bot, now), 'closer targets score higher');
  assert.ok(scoreTarget({...visible, id: 'a'}, bot, now, 'a') > scoreTarget({...visible, id: 'a'}, bot, now), 'the current target gets hysteresis');
});

test('aimErrorOffset shrinks as the bot settles', () => {
  const fresh = aimErrorOffset(PARAMS, 0, 20, new THREE.Vector3());
  const settled = aimErrorOffset(PARAMS, 1, 20, new THREE.Vector3());
  assert.ok(fresh.length() >= 0 && settled.length() >= 0);
  // Random values, so compare the maximum expected spread over many samples instead of one draw.
  let freshMax = 0, settledMax = 0;
  for (let i = 0; i < 200; i++) {
    freshMax = Math.max(freshMax, aimErrorOffset(PARAMS, 0, 20, new THREE.Vector3()).length());
    settledMax = Math.max(settledMax, aimErrorOffset(PARAMS, 1, 20, new THREE.Vector3()).length());
  }
  assert.ok(freshMax > settledMax * 1.5, 'fresh aim error should be much wider than settled error');
});

test('segmentBlocked detects a wall crossing and ignores low props', () => {
  const wall = {minX: -2, maxX: 2, minZ: 4, maxZ: 5, top: 2};
  assert.equal(segmentBlocked(0, 0, 0, 10, [wall]), true);
  assert.equal(segmentBlocked(0, 0, 10, 0, [wall]), false, 'a segment that misses the wall is clear');
  const low = {...wall, top: .6};
  assert.equal(segmentBlocked(0, 0, 0, 10, [low]), false, 'waist-high props do not block the eye line');
});

test('coverPointsFor: points stay outside the boxes and the cache follows collider changes', () => {
  const world = {colliders: [{minX: -2, maxX: 2, minZ: -2, maxZ: 2, top: 2}]};
  const pts = coverPointsFor(world);
  assert.ok(pts.length >= 8, 'eight candidate spots per box, got ' + pts.length);
  for (const p of pts) {
    assert.ok(isPointClear(p.x, p.z, world.colliders), 'cover point must be standable: ' + JSON.stringify(p));
    assert.ok(Math.hypot(p.x, p.z) > 2, 'cover point must be outside the box');
  }
  world.colliders.push({minX: 6, maxX: 8, minZ: 6, maxZ: 8, top: 2});
  const more = coverPointsFor(world);
  assert.ok(more.length > pts.length, 'the cache is rebuilt when the collider count changes');
});

test('findBestCover returns a blocked standable spot, or null when nothing hides the bot', () => {
  const world = {colliders: [{minX: -2, maxX: 2, minZ: -2, maxZ: 2, top: 2}]};
  const bot = {
    pos: new THREE.Vector3(0, 0, 8),
    game: {world},
    brain: {params: {coverBias: .7, preferCoverDist: 13}},
  };
  const threat = new THREE.Vector3(0, 1.4, 0);
  const spot = findBestCover(bot, threat, () => false); // the stub says "blocked"
  assert.ok(spot, 'a cover spot should be found');
  assert.ok(Math.hypot(spot.x, spot.z) > 2 && Math.hypot(spot.x, spot.z) < 9, 'spot should sit just outside the box');
  assert.equal(findBestCover(bot, threat, () => true), null, 'clear LOS means no cover');
  world.colliders = [];
  assert.equal(findBestCover(bot, threat, () => false), null, 'an empty map has no cover');
});

test('teammateBlockingShot: allies on the firing line block, allies off-line or behind the target do not', () => {
  const mk = (team, x, z, alive = true) => ({team, alive, pos: new THREE.Vector3(x, 0, z)});
  const bot = mk('A', 0, 0);
  const mate = mk('A', 0, -5);
  const enemy = mk('B', 0, -10);
  const player = {alive: false, pos: new THREE.Vector3(0, 0, -4)};
  bot.game = {heroes: {list: [bot, mate, enemy]}, playerTeam: 'A', player};
  const from = {x: 0, y: 1.4, z: 0};
  const to = {x: 0, y: 1.1, z: -10};
  assert.equal(teammateBlockingShot(bot, from, to).entity, mate, 'a teammate in the line is a blocker');
  mate.pos.set(3, 0, -5);
  assert.equal(teammateBlockingShot(bot, from, to), null, 'a teammate 3 m off the line does not block');
  mate.pos.set(0, 0, -12);
  assert.equal(teammateBlockingShot(bot, from, to), null, 'a teammate behind the target does not block');
  // Allied player: nearest friendly body wins, and enemy players are targets, not blockers.
  mate.pos.set(3, 0, -5);
  player.alive = true;
  assert.equal(teammateBlockingShot(bot, from, to).entity, 'player', 'the allied player blocks');
  player.alive = false;
  assert.equal(teammateBlockingShot(bot, from, to), null, 'a dead player never blocks');
  player.alive = true;
  bot.game.playerTeam = 'B';
  assert.equal(teammateBlockingShot(bot, from, to), null, 'an enemy player is a target, not a blocker');
});

test('scoreCoverPoint rewards blocking and the preferred stand-off distance', () => {
  const botPos = new THREE.Vector3(0, 0, 12);
  const threat = new THREE.Vector3(0, 0, 0);
  const blocked = scoreCoverPoint({x: 0, z: 8}, {botPos, threatPos: threat, coverBias: .8, preferCoverDist: 13, blocked: true});
  const exposed = scoreCoverPoint({x: 0, z: 8}, {botPos, threatPos: threat, coverBias: .8, preferCoverDist: 13, blocked: false});
  assert.ok(blocked > exposed, 'a blocking spot is worth more');
  const far = scoreCoverPoint({x: 30, z: 0}, {botPos, threatPos: threat, coverBias: .8, preferCoverDist: 13, blocked: true});
  assert.ok(far < blocked, 'a spot far from the preferred distance scores lower');
});

/* ---- sniper identity: the Longbow operator fights like a marksman, not a spray SMG ---- */
import {getBotParams, clearBotParamsCache} from '../src/botConfig.js';

test('sniper override: vulture gets a one-shot bolt rhythm and long engagement band', () => {
  clearBotParamsCache();
  const p = getBotParams('normal', 't', 'vulture');
  assert.equal(p.burst, 1, 'a bolt rifle fires one aimed round per cycle');
  assert.equal(p.dmgP, 62, 'sniper dmgP override, got ' + p.dmgP);
  assert.equal(p.dmgH, 78, 'sniper dmgH override, got ' + p.dmgH);
  assert.ok(p.range[0] >= 10 && p.range[1] >= 25, 'snipers hold the long lane: ' + p.range.join('-'));
  assert.ok(p.missK < 1, 'the marksman discipline should tighten accuracy, missK ' + p.missK);
  // Non-sniper operators keep the faction spray table (raven dmgP 9 stays asserted by e2e).
  const r = getBotParams('normal', 't', 'raven');
  assert.equal(r.dmgP, 9, 'the spray table must not leak to non-snipers');
  const v2 = getBotParams('hard', 't', 'vulture');
  assert.ok(v2.dmgP > p.dmgP, 'difficulty should still scale sniper damage, hard ' + v2.dmgP + ' vs normal ' + p.dmgP);
  // Easy must not two-tap a fresh player: the heavy rifle punch is eased and the bolt slows.
  const e = getBotParams('easy', 't', 'vulture');
  assert.equal(e.dmgP, 37, 'easy sniper dmgP eased, got ' + e.dmgP);
  assert.ok(e.burstT > p.burstT, 'easy sniper bolt is slower, ' + e.burstT + ' vs ' + p.burstT);
  assert.ok(e.range[1] < p.range[1], 'easy sniper holds a shorter lane, ' + e.range[1] + ' vs ' + p.range[1]);
});

test('sniper accuracy model: ≈75%+ single-shot hit at 20 m, one bolt cycle between shots', () => {
  const P = getBotParams('normal', 't', 'vulture');
  let hit = 0;
  const N = 4000;
  for (let i = 0; i < N; i++) {
    const miss = shotMissChance(P, {dist: 20, targetSpeed: 0, settle: 1, smoke: false, moving: false});
    if (Math.random() >= miss) hit++;
  }
  assert.ok(hit / N > .70, 'a settled sniper shot at 20 m should hit ≈75%+ of the time, got ' + (hit / N * 100).toFixed(1) + '%');
  assert.ok(P.burstT > 1.2, 'the bolt cycle must pace the follow-up (burstT ' + P.burstT + ')');
});
