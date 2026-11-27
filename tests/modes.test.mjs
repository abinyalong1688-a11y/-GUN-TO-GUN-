// modes.js — King of the Hill rules: hill placement, pacing, ownership, marker lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {KothMode, pickHill, KOTH_WIN, KOTH_RADIUS, KOTH_RATE} from '../src/modes.js';

const box = (minX, maxX, minZ, maxZ, top = 4) => ({minX, maxX, minZ, maxZ, top});

/* Minimal game double: a player that can be moved on / off the hill, no bots. */
function makeGame(overrides = {}) {
  const log = [];
  const game = {
    player: {alive: true, pos: new THREE.Vector3()},
    heroes: {list: []},
    ui: {setKloth() {}, setKoth() {}, hideKoth() {}, banner() {}},
    ended: null,
    _endMode(win) { this.ended = win; },
    ...overrides,
  };
  const koth = new KothMode(game);
  koth.pos.set(0, 0, 0);
  koth.reset();
  koth.active = true;
  return {game, koth, log};
}
/* Step until the match ends; returns the simulated seconds. */
function playOut(koth, dt = 1 / 30, max = 400) {
  let t = 0;
  while (!koth.done && t < max) { koth.update(dt); t += dt; }
  return t;
}

test('pickHill: an empty field keeps the hill in the middle', () => {
  const spot = pickHill([]);
  assert.deepEqual([spot.x, spot.z], [0, 0]);
  assert.equal(spot.clearance, KOTH_RADIUS);
});

test('pickHill: never puts the capture zone inside geometry', () => {
  // a block of containers right on the origin, as on the dock map
  const colliders = [box(-12, 12, -9, 9), box(14, 30, -20, 20), box(-30, -14, -20, 20)];
  const spot = pickHill(colliders);
  assert.ok(spot.clearance >= KOTH_RADIUS, `clearance ${spot.clearance} should reach the hill radius`);
  const d = Math.max(spot.x - 12, 0, -12 - spot.x, spot.z - 9, 0, -9 - spot.z);
  assert.ok(Math.hypot(d, d) >= KOTH_RADIUS || d === 0, 'hill disc must clear the centre block');
});

test('pickHill: prefers the open spot closest to the centre and is deterministic', () => {
  const colliders = [box(-6, 6, -40, 40)];                       // a wall through the middle
  const a = pickHill(colliders), b = pickHill(colliders.slice().reverse());
  assert.deepEqual(a, b);
  assert.ok(a.clearance >= KOTH_RADIUS);
  assert.equal(Math.abs(a.x), 14, 'first grid column clear of the wall plus the radius');
});

test('pickHill: only auto-step-height bumps are ignored; 1 m bank rocks are obstacles', () => {
  const colliders = [box(-3, 3, -3, 3, 0.2), box(-20, -18, -20, -18, 2)];
  const spot = pickHill(colliders);
  assert.deepEqual([spot.x, spot.z], [0, 0], 'a 20 cm lip does not push the hill off the centre');
  for (const top of [1, 1.35]) {
    const tall = pickHill([box(-3, 3, -3, 3, top), box(-20, -18, -20, -18, 2)]);
    assert.ok(tall.clearance >= KOTH_RADIUS, `${top} m cover is not walkable and must be avoided`);
  }
});

test('pickHill: still returns a usable site on a cluttered map (best clearance wins)', () => {
  const colliders = [];
  for (let i = 0; i < 60; i++) colliders.push(box(-40 + (i % 10) * 8, -34 + (i % 10) * 8, -40 + Math.floor(i / 10) * 14, -34 + Math.floor(i / 10) * 14));
  colliders.push(box(4, 10, 4, 10));
  const spot = pickHill(colliders);
  assert.ok(Number.isFinite(spot.x) && Math.abs(spot.x) <= 30 && Math.abs(spot.z) <= 30);
  assert.ok(spot.clearance > 0, 'site must be outside every obstacle');
});

test('koth: first to 200 points, one point per second of holding the hill', () => {
  const {game, koth} = makeGame();
  game.player.pos.set(0, 0, 0);
  const t = playOut(koth);
  assert.equal(game.ended, true, 'team A should win');
  assert.ok(koth.score.A >= KOTH_WIN && koth.score.A < KOTH_WIN + 1);
  // capture (≈3 s at .32/s) + 200 s of holding; a 4-minute match clock leaves room for a comeback
  assert.ok(t > 200 && t < 215, `match should last ≈203 s, took ${t.toFixed(1)} s`);
  assert.equal(KOTH_WIN, 200);
  assert.equal(KOTH_RATE, 1);
});

test('koth: nobody on the hill → nothing is captured or scored', () => {
  const {game, koth} = makeGame();
  game.player.pos.set(30, 0, 30);
  for (let i = 0; i < 300; i++) koth.update(1 / 30);
  assert.equal(koth.capture, 0);
  assert.equal(koth.owner, null);
  assert.deepEqual(koth.score, {A: 0, B: 0});
  assert.equal(game.ended, null);
});

test('koth: two teams on the hill contest it; the owner still scores, faster', () => {
  const {game, koth} = makeGame();
  game.player.pos.set(0, 0, 0);
  const mate = {alive: true, team: 'A', pos: new THREE.Vector3(1, 0, 0)};
  const foe = {alive: true, team: 'B', pos: new THREE.Vector3(-1, 0, 0)};
  game.heroes.list.push(mate, foe);
  for (let i = 0; i < 300; i++) koth.update(1 / 30);                    // 10 s
  assert.equal(koth.owner, 'A', 'two attackers beat one defender');
  const before = koth.score.A;
  koth.update(1);
  assert.ok(koth.score.A - before > 1.5, 'contested hill scores faster than a quiet one');
});

test('koth: marker is created on the hill and disposed with the mode', () => {
  const scene = new THREE.Scene();
  const {koth} = makeGame({scene});
  koth.start();
  assert.equal(koth.marker && koth.marker.grp.parent, scene);
  assert.deepEqual(koth.marker.grp.position.toArray(), [0, 0, 0]);
  koth.update(1 / 30);
  assert.equal(koth.marker.ringMat.color.getHex(), 0xdbe6f4, 'neutral hill is white');
  koth.capture = 1; koth.owner = 'A'; koth.update(1 / 30);
  assert.equal(koth.marker.ringMat.color.getHex(), 0x7fd4ff, 'NOVA-owned hill is cyan');
  koth.end();
  assert.equal(koth.marker, null);
  assert.equal(scene.children.length, 0);
});

test('koth: start() works without a 3D scene (unit / headless use)', () => {
  const {koth} = makeGame();
  assert.doesNotThrow(() => koth.start());
  assert.equal(koth.marker, null);
});

test('koth: online mode only reports ticks — it never writes the score itself', () => {
  const {game, koth} = makeGame();
  koth.online = true;
  game.player.pos.set(0, 0, 0);
  let ticks = 0;
  for (let i = 0; i < 300; i++) { koth.update(1 / 30); if (koth.lastTickTeam) ticks++; }
  // capturing takes 1/.32 ≈ 3.1 s, leaving ≈6.9 s of ownership → 6 whole-second ticks
  assert.equal(ticks, 6, 'one ownership tick per second of holding the hill');
  assert.deepEqual(koth.score, {A: 0, B: 0});
  assert.equal(game.ended, null);
});
