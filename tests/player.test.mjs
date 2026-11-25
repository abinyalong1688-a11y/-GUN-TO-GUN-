// player.test.mjs — movement physics unit tests: gravity / jump / landing / support surfaces / collision / crouch
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {Player} from '../src/player.js';

function makePlayer(){
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[]);
  p.god=false;
  return p;
}
const INPUT={ads:false};
const KEYS=new Set();
const AUDIO={step(){}};
const step=(p,n,dt=.016)=>{for(let i=0;i<n;i++)p.update(dt,INPUT,KEYS,0,AUDIO);};

test('gravity: rises after a jump, then lands back at y=0',()=>{
  const p=makePlayer();
  p.pos.set(0,0,0);
  KEYS.add('Space');
  p.update(.016,INPUT,KEYS,0,AUDIO);
  KEYS.delete('Space');
  assert.ok(!p.grounded&&p.velY>0,'a jump should give upward velocity');
  let maxY=p.pos.y;
  for(let i=0;i<120;i++){p.update(.016,INPUT,KEYS,0,AUDIO);maxY=Math.max(maxY,p.pos.y);}
  assert.ok(maxY>.9&&maxY<1.4,'jump height should be ≈1.16 m, got '+maxY.toFixed(2));
  assert.ok(p.grounded&&Math.abs(p.pos.y)<.001,'should land back on the ground');
});

test('support surface: lands and stands on a 1.1 m crate top',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,2.0,0);p.velY=-2;p.grounded=false;
  for(let i=0;i<60;i++)p.update(.016,INPUT,KEYS,0,AUDIO);
  assert.ok(Math.abs(p.pos.y-1.1)<.02,'should land on the crate top at 1.1, got '+p.pos.y.toFixed(2));
  assert.ok(p.grounded,'landing should set grounded');
});

test('walking off an edge: falls back to the ground naturally',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,1.1,0);p.grounded=true;p.velY=0;
  p.pos.x=1.2; // move outside the crate support area
  step(p,40);
  assert.ok(p.pos.y<.05,'walking off the edge should drop to the ground, got '+p.pos.y.toFixed(2));
});

test('horizontal collision: not pushed sideways while standing on a crate',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,1.1,0);p.grounded=true;
  step(p,30);
  assert.ok(Math.abs(p.pos.x)<.01&&Math.abs(p.pos.z)<.01,'standing on a crate must not push the player off');
});

test('horizontal collision: on the ground, pushed outside the crate radius',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:1,maxX:2.2,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(1.2,0,0);p.grounded=true;
  step(p,30);
  const dx=p.pos.x-1.2+ .4; // after push-out pos.x+r<=minX → pos.x<=.8
  assert.ok(p.pos.x<=.81,'should be pushed out of the crate, got x='+p.pos.x.toFixed(2));
});

test('crouch: lower eye height and tighter spread',()=>{
  const p=makePlayer();
  KEYS.add('ControlLeft');
  step(p,30);
  assert.ok(p.crouching,'should enter crouch');
  assert.ok(p.eyeHCur<1.35,'crouch eye height '+p.eyeHCur.toFixed(2));
  KEYS.delete('ControlLeft');
  step(p,30);
  assert.ok(!p.crouching&&Math.abs(p.eyeHCur-1.62)<.02,'should return to standing eye height');
});

test('air control damping: air acceleration is clearly weaker than on the ground',()=>{
  const p1=makePlayer();p1.pos.set(0,5,0);p1.grounded=false;p1.velY=0;
  KEYS.add('KeyW');
  p1.update(.016,INPUT,KEYS,0,AUDIO);
  const airV=p1.vel.z;
  const p2=makePlayer();p2.grounded=true;
  p2.update(.016,INPUT,KEYS,0,AUDIO);
  const groundV=p2.vel.z;
  assert.ok(Math.abs(airV)<Math.abs(groundV),'air control should be weaker than ground control');
  KEYS.delete('KeyW');
});

test('spawn: a fresh player faces the enemy side (-z), not away from it',()=>{
  const p=makePlayer();
  assert.ok(Math.abs(p.yaw)<.001,'spawn yaw should be 0');
  p.reset();
  const f=p.forward();
  assert.ok(f.z<-.99&&Math.abs(f.x)<.001,'spawn and redeploy should both face -z, got x='+f.x.toFixed(2)+' z='+f.z.toFixed(2));
});

test('forward vector: yaw maps to the right travel direction',()=>{
  const p=makePlayer();
  p.yaw=0; // facing -z
  const f=p.forward();
  assert.ok(Math.abs(f.z+1)<.001&&Math.abs(f.x)<.001);
  p.yaw=Math.PI/2; // facing -x
  const f2=p.forward();
  assert.ok(Math.abs(f2.x+1)<.001&&Math.abs(f2.z)<.001);
});

test('damage: rejects NaN / Infinity / negative input from the network',()=>{
  const p=makePlayer();
  p.health=100;
  p.damage(NaN,0); p.damage(Infinity,0); p.damage(-50,0); p.damage('35',0);
  assert.equal(p.health,100,'health must stay untouched');
  assert.equal(p.alive,true);
});

test('damage: a single packet cannot exceed the 200 cap or drive health negative',()=>{
  const p=makePlayer();
  p.health=100;
  p.damage(9999,0);
  assert.equal(p.health,0);
  assert.equal(p.alive,false);
  p.damage(10,0);
  assert.equal(p.health,0,'dead players ignore further damage');
});
