// server-hit.test.mjs — authoritative hit adjudication: crouched headshots + weapon attribution
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Room} from '../server/worker.js';
import {PEER_FLAGS} from '../src/netProtocol.js';

/* validateHit is pure given pending snapshots + baked geometry — no Cloudflare bindings
   are touched, so a bare object with the two fields it reads is enough. */
function roomWith(shooter, victim) {
  const r = Object.create(Room.prototype);
  r.pending = new Map([['shooter', {at: 0, p: shooter}], ['victim', {at: 0, p: victim}]]);
  r.state = {worldGeo: [], worldMap: 'desert'}; // empty walls → every LOS probe is clear
  return r;
}
const peer = (x, y, z, flags) => [0, Math.round(x*100), Math.round(y*100), Math.round(z*100), 0, 0, 100, flags];
const alive = PEER_FLAGS.ALIVE;
const crouch = alive | PEER_FLAGS.CROUCH;

test('validateHit: a crouched headshot resolves at +1.18 (not the standing +1.6)', () => {
  const r = roomWith(
    peer(0, 0, 10, alive),
    peer(0, 0, 0, crouch),
  );
  const ok = r.validateHit({id: 'shooter'}, {w: 'awp', target: 'victim', head: 1});
  assert.equal(ok.ok, true, 'a clear crouched headshot must be accepted');
  assert.equal(ok.dmg, 230, 'head multiplier is 2× the 115 base');
});

test('validateHit: crouched torso uses the low centre (not the standing +0.95)', () => {
  const r = roomWith(
    peer(0, 0, 10, alive),
    peer(0, 0, 0, crouch),
  );
  const ok = r.validateHit({id: 'shooter'}, {w: 'm4a4', target: 'victim', head: 0});
  assert.equal(ok.ok, true);
  assert.equal(ok.dmg, 31);
});

test('validateHit: standing target keeps the original probe heights', () => {
  const r = roomWith(
    peer(0, 0, 10, alive),
    peer(0, 0, 0, alive),
  );
  assert.equal(r.validateHit({id: 'shooter'}, {w: 'awp', target: 'victim', head: 1}).dmg, 230);
  assert.equal(r.validateHit({id: 'shooter'}, {w: 'deagle', target: 'victim', head: 0}).dmg, 53);
});

/* Regression: the bot branch of relayHit called this.attachment(ws, at) with a `ws` that is
   out of scope there — a ReferenceError on EVERY human→bot hit — and stored the shot on
   at.botShots while creditBotKiller read this.botShots, so remote bot kills were never
   credited. */
test('relayHit: a human hitting a BOT records the shot for kill credit and does not throw', () => {
  const r = Object.create(Room.prototype);
  r.state = { humans: {}, hostId: 'host', bots: [{ id: 'bA0' }] };
  r.pending = new Map([['shooter', { at: 0, p: peer(0, 0, 10, alive) }]]);
  const sent = [];
  r.send = (ws, msg) => sent.push(msg);
  r.wsOf = () => ({ ok: true });
  r.attachment = () => {};
  r.isBotId = Room.prototype.isBotId;
  const at = { id: 'shooter' };
  assert.doesNotThrow(() => r.relayHit(at, { target: 'bA0', w: 'm4a4', head: 0 }, 31));
  assert.equal(sent.length, 1, 'the host receives the S.HIT bot proxy frame');
  const t = (r.botShots || {})['bA0'];
  assert.ok(t && t.by === 'shooter', 'the shot is credited on the ROOM (this.botShots), readable by creditBotKiller');
  assert.ok(r.creditBotKiller('host', 'bA0', 'shooter') === 'shooter', 'creditBotKiller now finds it');
});
