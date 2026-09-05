import { forestFastWGSL } from '../src/bitmask/forestFastShaders.js';
import { forestBoundedWGSL, forestDispatchWGSL } from '../src/bitmask/forestBoundedShaders.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initSync, WgslFrontend } from 'web-naga';
import { resolveBatches, resolveReference, clipNearPlane, sampleDepth, EMPTY_ID } from '../src/bitmask/reference.js';
import { forestRasterWGSL } from '../src/bitmask/forestShaders.js';
import { forestReferenceWGSL } from '../src/bitmask/forestReferenceShaders.js';
import { forestRejectWGSL } from '../src/bitmask/forestRejectShaders.js';
import { forestOwnedMaskWGSL } from '../src/bitmask/forestOwnedMaskShaders.js';
import { rasterVariant } from '../src/bitmask/variant.js';
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
  try { for(const code of [forestFastWGSL,forestBoundedWGSL,forestDispatchWGSL,forestRasterWGSL,forestReferenceWGSL,forestOwnedMaskWGSL,forestRejectWGSL]) { const module=frontend.parse(code);try{assert.ok(module.to_wgsl().length>0);}finally{module.free();} } }
  finally{frontend.free();}
});
test('forest software mode submits both compute selections and hides geometry hardware draws',()=>{
  const calls=[];
  const make=name=>({naniteMesh:{visible:true},baselineMesh:{visible:false},render:(...args)=>calls.push([name,...args])});
  const terrain=make('terrain'),trees=make('trees');
  const forest={terrain,trees,pipelines:[terrain,trees],enabled:true,bitmask:{busy:false,prepare(now){if(this.busy)return false;calls.push(['prepare',now]);return true;},render:now=>calls.push(['bitmask',now])}};
  ForestRenderer.prototype.render.call(forest,123);
  assert.deepEqual(calls,[['prepare',123],['bitmask',123]]);
  assert.equal(terrain.naniteMesh.visible,false);assert.equal(trees.naniteMesh.visible,false);
  forest.bitmask.busy=true;calls.length=0;
  assert.equal(ForestRenderer.prototype.render.call(forest,124),false);assert.equal(calls.length,0);
  forest.enabled=false;
  ForestRenderer.prototype.render.call(forest,125);
  assert.deepEqual(calls,[['trees',125,true],['terrain',125]]);
});

// Model the new shared-memory protocol independently of WGSL: reuse stale
// depth slots, accept only mask-marked samples, and reject behind earlier batches.
function cachedResolve(triangles,ids,pixel) {
  const cache=new Float64Array(32).fill(NaN);
  let depth=1,id=EMPTY_ID;
  for(let start=0;start<ids.length;start+=32){
    let mask=0;
    const batch=ids.slice(start,start+32);
    batch.forEach((candidate,slot)=>{
      const z=sampleDepth(triangles[candidate],pixel);
      if(z>=0&&z<=depth){cache[slot]=z;mask=(mask|(1<<slot))>>>0;}
    });
    for(let slot=0;slot<batch.length;slot++)if((mask>>>slot)&1){
      const z=cache[slot],candidate=batch[slot];
      if(z<depth||(z===depth&&candidate<id)){depth=z;id=candidate;}
    }
  }
  return {depth,id};
}
test('cached depth and previous-batch rejection preserve edges, ties and empty pixels',()=>{
  const triangles=Array.from({length:129},(_,i)=>{
    const d=(i%7)/8;
    return i%2 ? [[0,0,d],[8,8,d],[0,8,d]] : [[0,0,d],[8,0,d],[8,8,d]];
  });
  // Degenerate and off-screen candidates deliberately leave stale cache slots.
  triangles.push([[0,0,0],[0,0,0],[0,0,0]],[[20,20,0],[28,20,0],[20,28,0]]);
  const ids=triangles.map((_,i)=>i);
  for(const order of [ids,ids.toReversed(),ids.concat(ids)]){
    for(let y=-1;y<10;y++)for(let x=-1;x<10;x++){
      const pixel=[x+.5,y+.5];
      assert.deepEqual(cachedResolve(triangles,order,pixel),resolveReference(triangles,order,pixel));
    }
  }
});

test('raster defaults to phone-tested original and preserves explicit comparison links',()=>{
  assert.equal(rasterVariant(),'original');
  assert.equal(rasterVariant('?bitmaskReference=1'),'original');
  assert.equal(rasterVariant('?bitmaskReference=0'),'cached');
  assert.equal(rasterVariant('?bitmaskVariant=owned'),'owned');
  assert.equal(rasterVariant('?bitmaskVariant=original&bitmaskReference=0'),'original');
  assert.equal(rasterVariant('?bitmaskVariant=unknown'),'original');
});
test('triangle-owned coverage masks preserve visibility across word boundaries and partial batches',()=>{
  const triangles=Array.from({length:99},(_,i)=>{
    const d=(i%11)/8; // Includes far-plane samples: coverage may conservatively include them.
    return i%2 ? [[0,0,d],[8,8,d],[0,8,d]] : [[0,0,d],[8,0,d],[8,8,d]];
  });
  triangles.push([[0,0,-.5],[8,0,.5],[8,8,1.5]],[[0,0,0],[0,0,0],[0,0,0]]);
  const ids=triangles.map((_,i)=>i);
  for(const order of [ids,ids.toReversed(),ids.concat(ids)]){
    const best=Array.from({length:64},()=>({depth:1,id:EMPTY_ID}));
    const masks=new Uint32Array(64).fill(0xffffffff);
    for(let start=0;start<order.length;start+=32){
      const batch=order.slice(start,start+32);
      batch.forEach((id,slot)=>{
        masks[slot*2]=masks[slot*2+1]=0;
        const coverageTriangle=triangles[id].map(([x,y])=>[x,y,0]);
        for(let pixel=0;pixel<64;pixel++){
          if(sampleDepth(coverageTriangle,[pixel%8+.5,Math.floor(pixel/8)+.5])>=0)
            masks[slot*2+(pixel>>>5)]|=1<<(pixel&31);
        }
      });
      for(let pixel=0;pixel<64;pixel++){
        const point=[pixel%8+.5,Math.floor(pixel/8)+.5];
        const candidates=batch.filter((id,slot)=>(masks[slot*2+(pixel>>>5)]>>>(pixel&31))&1);
        const next=resolveReference(triangles,candidates,point);
        if(next.depth<best[pixel].depth||(next.depth===best[pixel].depth&&next.id<best[pixel].id))best[pixel]=next;
      }
    }
    best.forEach((value,pixel)=>assert.deepEqual(value,resolveReference(triangles,order,[pixel%8+.5,Math.floor(pixel/8)+.5])));
  }
});
