// interp.test.mjs — pure interpolation / clock-sync math
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SnapshotBuffer,lerpAngle,TimeSync} from '../src/interp.js';
import {encodePeer,decodePeer,INTERP_DELAY} from '../src/netProtocol.js';

const P=(t,x,y=0,z=0,yaw=0,pitch=0,hp=100,alive=true)=>({t,x,y,z,yaw,pitch,hp,alive,crouch:false});

test('quantisation: 9-integer peer round-trip stays within cm / milliradian precision',()=>{
  const a=encodePeer('abc',{x:1.234,y:0,z:-9.876,yaw:2.0004,pitch:-.1234,hp:87.9},5);
  assert.deepEqual(a.slice(1,4),[123,0,-988]);
  assert.deepEqual(a.slice(4,6),[2,-.123]);
  assert.equal(a[6],87);assert.equal(a[7],5);
  const d=decodePeer(a);
  assert.equal(d.id,'abc');assert.ok(Math.abs(d.x-1.23)<.011);assert.ok(Math.abs(d.z+9.88)<.011);
});

test('SnapshotBuffer drops out-of-order and duplicate frames',()=>{
  const b=new SnapshotBuffer(4);
  b.push(1,P(1,0));b.push(2,P(2,1));
  b.push(2,P(2,99));b.push(1.5,P(1.5,99));
  assert.equal(b.n,2);
  assert.equal(b.at(1).x,1);
});

test('sample alpha 0 / 0.5 / 1 around the interpolation delay',()=>{
  const b=new SnapshotBuffer();
  const d=INTERP_DELAY.human;
  b.push(10,P(10,0));b.push(11,P(11,2));
  assert.equal(b.sample(10+d).x,0);        // exactly the first sample
  assert.equal(b.sample(10.5+d).x,1);      // midpoint
  assert.equal(b.sample(11+d).x,2);        // exactly the last sample
});

test('yaw interpolation crosses ±π the short way',()=>{
  assert.ok(Math.abs(lerpAngle(Math.PI-.1,-Math.PI+.1,.5)-Math.PI)<1e-6);
  assert.ok(Math.abs(lerpAngle(-3.1,3.1,.5)+Math.PI)<1e-6);
  const b=new SnapshotBuffer();
  b.push(10,P(10,0,0,0,Math.PI-.1));b.push(11,P(11,1,0,0,-Math.PI+.1));
  const s=b.sample(10.5+INTERP_DELAY.human);
  assert.ok(Math.abs(Math.abs(s.yaw)-Math.PI)<1e-6,'yaw should wrap through π, got '+s.yaw);
});

test('extrapolation is clamped and frozen past EXTRAP_MAX; big jumps snap',()=>{
  const b=new SnapshotBuffer();
  b.push(10,P(10,0));b.push(11,P(11,1));
  const d=INTERP_DELAY.human;
  const s=b.sample(11.05+d);
  assert.ok(s.extrapolated&&s.x>1&&s.x<1.2,'short extrapolation, got '+s.x);
  const f=b.sample(11.5+d);
  assert.ok(f.frozen&&!f.extrapolated&&f.x===1,'past 120 ms it freezes');
  const b2=new SnapshotBuffer();
  b2.push(10,P(10,0));b2.push(11,P(11,20)); // 20 m teleport
  const j=b2.sample(11.05+d);
  assert.ok(!j.extrapolated&&j.x===20,'a >8 m jump snaps to the newer sample');
});

test('TimeSync first pong seeds the offset; later pongs are EWMA(0.9) smoothed',()=>{
  const c=new TimeSync();
  c.onPong(1000,500.0,2000); // rtt = 1 s, offset = 500 + .5 - 2 = 498.5
  assert.ok(c.ready);
  assert.ok(Math.abs(c.offset-498.5)<1e-9,'first offset '+c.offset);
  assert.ok(Math.abs(c.rtt-1)<1e-9);
  c.onPong(3000,502.5,4000); // rtt 1 s, off = 502.5+.5-4 = 499
  assert.ok(Math.abs(c.offset-(498.5*.9+499*.1))<1e-6,'EWMA offset '+c.offset);
  assert.ok(c.jitter>0);
  assert.ok(Math.abs(c.serverNow(4000)-(4+c.offset))<1e-9);
});
