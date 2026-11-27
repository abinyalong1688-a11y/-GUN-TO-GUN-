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
