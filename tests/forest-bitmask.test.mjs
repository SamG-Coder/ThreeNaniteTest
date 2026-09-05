import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, WgslFrontend } from 'web-naga';
import { resolveBatches, resolveReference, clipNearPlane } from '../src/bitmask/reference.js';
import { forestRasterWGSL } from '../src/bitmask/forestShaders.js';
import { ForestRenderer } from '../src/ForestRenderer.js';

test('forest batches preserve winners beyond 32 and 128 candidates in either order',()=>{
  const triangles=Array.from({length:257},(_,i)=>[[0,0,.9-i*.003],[8,0,.9-i*.003],[0,8,.9-i*.003]]);
  const ids=triangles.map((_,i)=>i);
  const expected=resolveReference(triangles,ids,[1.5,1.5]);
  assert.equal(expected.id,256);
  for(const order of [ids,ids.toReversed(),ids.concat(ids)])assert.deepEqual(resolveBatches(triangles,order,[1.5,1.5]),expected);
});
test('near-plane clipping handles crossings and exact endpoints without duplicate vertices',()=>{
  const a=[0,0,1,2],b=[1,0,1,2],c=[0,1,-1,1];
  const quad=clipNearPlane([a,b,c]);
  assert.equal(quad.length,4);assert.ok(quad.every(p=>p[2]>=0&&p[3]>0));
  assert.equal(clipNearPlane([[0,0,0,1],b,c]).length,3);
  assert.equal(clipNearPlane([c,c,c]).length,0);
  assert.equal(clipNearPlane([a,b,[0,1,1,2]]).length,3);
});
test('forest WGSL parses and emits including workgroup mask synchronization',()=>{
  initSync({module:readFileSync(new URL('./web_naga_bg.wasm',import.meta.resolve('web-naga')))});
  const frontend=WgslFrontend.new();
  try { const module=frontend.parse(forestRasterWGSL);try{assert.ok(module.to_wgsl().length>0);}finally{module.free();} }
  finally{frontend.free();}
});
test('forest software mode submits both compute selections and hides geometry hardware draws',()=>{
  const calls=[];
  const make=name=>({naniteMesh:{visible:true},baselineMesh:{visible:false},render:(...args)=>calls.push([name,...args])});
  const terrain=make('terrain'),trees=make('trees');
  const forest={terrain,trees,pipelines:[terrain,trees],enabled:true,bitmask:{busy:false,render:now=>calls.push(['bitmask',now])}};
  ForestRenderer.prototype.render.call(forest,123);
  assert.deepEqual(calls,[['trees',123,true],['terrain',123,true],['bitmask',123]]);
  assert.equal(terrain.naniteMesh.visible,false);assert.equal(trees.naniteMesh.visible,false);
  forest.bitmask.busy=true;calls.length=0;
  assert.equal(ForestRenderer.prototype.render.call(forest,124),false);assert.equal(calls.length,0);
  forest.enabled=false;
  ForestRenderer.prototype.render.call(forest,125);
  assert.deepEqual(calls,[['trees',125,true],['terrain',125]]);
});
