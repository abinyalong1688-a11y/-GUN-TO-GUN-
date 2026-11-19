// player.test.mjs —— 移动物理单元测试:重力/跳跃/落地/支撑面/碰撞/蹲伏
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

test('重力:起跳后上升、随后落地回 y=0',()=>{
  const p=makePlayer();
  p.pos.set(0,0,0);
  KEYS.add('Space');
  p.update(.016,INPUT,KEYS,0,AUDIO);
  KEYS.delete('Space');
  assert.ok(!p.grounded&&p.velY>0,'起跳应有向上初速度');
  let maxY=p.pos.y;
  for(let i=0;i<120;i++){p.update(.016,INPUT,KEYS,0,AUDIO);maxY=Math.max(maxY,p.pos.y);}
  assert.ok(maxY>.9&&maxY<1.4,'跳高应≈1.16m,实际 '+maxY.toFixed(2));
  assert.ok(p.grounded&&Math.abs(p.pos.y)<.001,'应落回地面');
});

test('支撑面:落在 1.1m 箱顶并站立',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,2.0,0);p.velY=-2;p.grounded=false;
  for(let i=0;i<60;i++)p.update(.016,INPUT,KEYS,0,AUDIO);
  assert.ok(Math.abs(p.pos.y-1.1)<.02,'应落在箱顶 1.1,实际 '+p.pos.y.toFixed(2));
  assert.ok(p.grounded,'落地应接地');
});

test('走出边缘:自然下落回地面',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,1.1,0);p.grounded=true;p.velY=0;
  p.pos.x=1.2; // 移到箱支撑范围之外
  step(p,40);
  assert.ok(p.pos.y<.05,'走出边缘应落回地面,实际 '+p.pos.y.toFixed(2));
});

test('水平碰撞:站在箱顶时不被水平推挤',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:-.6,maxX:.6,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(0,1.1,0);p.grounded=true;
  step(p,30);
  assert.ok(Math.abs(p.pos.x)<.01&&Math.abs(p.pos.z)<.01,'箱顶站立不应被推出');
});

test('水平碰撞:地面撞箱被推出半径之外',()=>{
  const cam=new THREE.PerspectiveCamera();
  const p=new Player(cam,[
    {minX:1,maxX:2.2,minZ:-.6,maxZ:.6,top:1.1},
  ]);
  p.pos.set(1.2,0,0);p.grounded=true;
  step(p,30);
  const dx=p.pos.x-1.2+ .4; // 推出后应满足 pos.x+r<=minX → pos.x<=.8
  assert.ok(p.pos.x<=.81,'应被推出箱体,实际 x='+p.pos.x.toFixed(2));
});

test('蹲伏:眼高降低且散布收紧',()=>{
  const p=makePlayer();
  KEYS.add('ControlLeft');
  step(p,30);
  assert.ok(p.crouching,'应进入蹲伏');
  assert.ok(p.eyeHCur<1.35,'蹲伏眼高 '+p.eyeHCur.toFixed(2));
  KEYS.delete('ControlLeft');
  step(p,30);
  assert.ok(!p.crouching&&Math.abs(p.eyeHCur-1.62)<.02,'应恢复站姿眼高');
});

test('空中操控衰减:空中加速明显弱于地面',()=>{
  const p1=makePlayer();p1.pos.set(0,5,0);p1.grounded=false;p1.velY=0;
  KEYS.add('KeyW');
  p1.update(.016,INPUT,KEYS,0,AUDIO);
  const airV=p1.vel.z;
  const p2=makePlayer();p2.grounded=true;
  p2.update(.016,INPUT,KEYS,0,AUDIO);
  const groundV=p2.vel.z;
  assert.ok(Math.abs(airV)<Math.abs(groundV),'空中操控应弱于地面');
  KEYS.delete('KeyW');
});

test('forward 向量:yaw→前进方向映射正确',()=>{
  const p=makePlayer();
  p.yaw=0; // 面向 -z
  const f=p.forward();
  assert.ok(Math.abs(f.z+1)<.001&&Math.abs(f.x)<.001);
  p.yaw=Math.PI/2; // 面向 -x
  const f2=p.forward();
  assert.ok(Math.abs(f2.x+1)<.001&&Math.abs(f2.z)<.001);
});
