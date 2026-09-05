import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleDepth, collectMask, resolveMask, resolveReference, EMPTY_ID, CANDIDATE_CAPACITY } from '../src/bitmask/reference.js';
import { createFixture } from '../src/bitmask/fixtures.js';

const covering = z => [[0,0,z],[8,0,z],[0,8,z]];
test('all 32 bits survive OR including bit 31; duplicates are idempotent',()=>{
  const triangles=Array.from({length:32},(_,i)=>covering(.9-i*.02));
  const ids=triangles.map((_,i)=>i);
  const mask=collectMask(triangles,ids,[1.5,1.5]);
  assert.equal(mask[0],0xffffffff);
  assert.equal((mask[0]>>>31)&1,1);
  mask[0]|=1<<31; assert.equal(mask[0],0xffffffff);
  assert.equal(resolveMask(triangles,ids,[1.5,1.5]).id,31);
});
test('multiple mask words and reordered tile slots preserve the nearest triangle',()=>{
  const triangles=Array.from({length:128},(_,i)=>covering(.9-i*.005));
  const ids=triangles.map((_,i)=>i);
  for(const order of [ids,ids.toReversed(),ids.filter(i=>i%2).concat(ids.filter(i=>!(i%2)))]) {
    assert.deepEqual([...collectMask(triangles,order,[1.5,1.5])],[0xffffffff,0xffffffff,0xffffffff,0xffffffff]);
    assert.deepEqual(resolveMask(triangles,order,[1.5,1.5]),resolveReference(triangles,ids,[1.5,1.5]));
  }
});
test('overflow fallback retains candidates beyond capacity',()=>{
  const triangles=Array.from({length:160},(_,i)=>covering(.9-i*.004));
  const ids=triangles.map((_,i)=>i);
  assert.ok(ids.length>CANDIDATE_CAPACITY);
  assert.equal(resolveMask(triangles,ids,[1.5,1.5]).id,159);
});
test('depth ties choose global ID, background stays empty and degenerate triangles are ignored',()=>{
  const triangles=[covering(.25),covering(.25),[[0,0,0],[0,0,0],[0,0,0]]];
  assert.equal(resolveMask(triangles,[2,1,0],[1.5,1.5]).id,0);
  assert.deepEqual(resolveMask(triangles,[0,1,2],[9.5,9.5]),{depth:1,id:EMPTY_ID});
  assert.equal(sampleDepth(triangles[2],[0,0]),-1);
});
test('shared edge has one owner, both windings agree, and varying depth resolves per pixel',()=>{
  const a=[[0,0,.5],[8,0,.5],[0,8,.5]],b=[[8,0,.5],[8,8,.5],[0,8,.5]];
  for(let y=0;y<8;y++)for(let x=0;x<8;x++) {
    const p=[x+.5,y+.5];
    assert.equal(Number(sampleDepth(a,p)>=0)+Number(sampleDepth(b,p)>=0),1);
    assert.equal(sampleDepth(a,p),sampleDepth([a[0],a[2],a[1]],p));
  }
  const sloped=[[0,0,.1],[8,0,.9],[0,8,.1]],flat=covering(.5);
  assert.equal(resolveMask([sloped,flat],[1,0],[1.5,1.5]).id,0);
  assert.equal(resolveMask([sloped,flat],[1,0],[5.5,1.5]).id,1);
});
test('fixtures expose the promised bit, overflow and topology cases',()=>{
  for(const [name,count] of [['bit31',32],['overflow',160],['tie',4],['edge',2]]) {
    const f=createFixture(name);assert.equal(f.count,count);assert.ok(f.data.every(Number.isFinite));
  }
  assert.ok(createFixture('torus').count>500);
});

// Offline parser/IR emission gate, not physical-device pipeline validation.
test('all custom raster shaders parse and emit WGSL through Naga', async()=>{
  const {readFileSync}=await import('node:fs');
  const {initSync,WgslFrontend}=await import('web-naga');
  const shaders=await import('../src/bitmask/shaders.js');
  initSync({module:readFileSync(new URL('./web_naga_bg.wasm',import.meta.resolve('web-naga')))});
  const frontend=WgslFrontend.new();
  try {
    for(const code of Object.values(shaders)) {
      const module=frontend.parse(code);
      try { assert.ok(module.to_wgsl().length>0); } finally { module.free(); }
    }
  } finally { frontend.free(); }
});
