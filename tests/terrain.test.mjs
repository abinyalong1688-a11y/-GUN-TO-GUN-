// terrain.test.mjs — the rendered ground must match the y=0 movement plane inside the arena
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {terrainHeight,ARENA_FLAT_RADIUS,TERRAIN_BLEND_RADIUS} from '../src/terrain.js';

test('the whole playable disc is exactly flat (no boot-burying rise)',()=>{
  // Player bound is r=56, bots r=52; sample a dense grid plus the exact boundary ring.
  for(let x=-56;x<=56;x+=2)
    for(let z=-56;z<=56;z+=2)
      if(Math.hypot(x,z)<=56)
        assert.equal(terrainHeight(x,z),0,`terrain at ${x},${z} must be 0`);
  for(let a=0;a<Math.PI*2;a+=Math.PI/32)
    assert.equal(terrainHeight(Math.cos(a)*56,Math.sin(a)*56),0,'boundary ring must be 0');
  assert.ok(ARENA_FLAT_RADIUS>=57,'flat radius must cover the r=56 player bound plus one mesh ring');
});

test('the flat apron extends past the boundary, so mesh interpolation cannot leak a rise inward',()=>{
  for(let a=0;a<Math.PI*2;a+=Math.PI/16){
    const x=Math.cos(a)*57,z=Math.sin(a)*57;
    assert.equal(terrainHeight(x,z),0,'flat apron at r=57 must still be 0');
  }
  // Just past the apron the field starts to move, but continuously (no visible cliff).
  let max=0;
  for(let a=0;a<Math.PI*2;a+=Math.PI/16)
    max=Math.max(max,Math.abs(terrainHeight(Math.cos(a)*60,Math.sin(a)*60)));
  assert.ok(max>0,'dunes should resume outside the arena');
  assert.ok(max<.05,'the blend should be gradual, got '+max.toFixed(3));
});

test('distant terrain is finite and rises outside the blend radius',()=>{
  let sawRise=false;
  for(let x=-180;x<=180;x+=6)
    for(let z=-180;z<=180;z+=6){
      const h=terrainHeight(x,z);
      assert.ok(Number.isFinite(h),`height at ${x},${z} must be finite`);
      if(Math.hypot(x,z)>TERRAIN_BLEND_RADIUS&&h>1)sawRise=true;
    }
  assert.ok(sawRise,'distant hills should still exist');
  assert.ok(terrainHeight(120,0)>2,'the outer hill ring should keep its silhouette');
});
