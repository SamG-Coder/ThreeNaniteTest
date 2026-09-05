import test from 'node:test';import assert from 'node:assert/strict';
import {emulateRaster,sample} from '../scripts/emulation/raster.mjs';
import {sampleDepth} from '../src/bitmask/reference.js';
function scene(){
 const projected=new Float32Array(100*14),ids=new Uint32Array(100);
 for(let i=0;i<100;i++){
  const z=(i%9)/10+.05; // Negative screen winding matches raster front faces.
  const points=i%2?[[0,0,z],[0,13,z],[11,13,z]]:[[0,0,z],[11,13,z],[11,0,z]];
  for(let c=0;c<4;c++)projected.set(points[Math.min(c,2)],i*14+c*3);
  projected[i*14+12]=3;projected[i*14+13]=z*100;ids[i]=i;
 }
 return {projected,ids,primitiveCount:100,width:11,height:13};
}
test('all emulator variants match across partial tiles, batches and insertion orders',()=>{
 const s=scene();const baseline=emulateRaster(s,'original',{capacity:1000});
 for(const variant of ['original','owned','cached','reject'])for(const order of ['forward','reverse']){
  const r=emulateRaster(s,variant,{capacity:1000,order});assert.deepEqual(r.ids,baseline.ids);assert.deepEqual(r.depths,baseline.depths);
 }
 assert.throws(()=>emulateRaster(s,'reject',{capacity:1}),/overflow/);
});
test('emulator sample agrees with independent depth reference on clipped fans and boundaries',()=>{
 const t=[[0,0,.1],[0,8,.3],[8,8,.9]];
 for(let y=0;y<9;y++)for(let x=0;x<9;x++)assert.equal(sample(t,[x+.5,y+.5]),Math.fround(sampleDepth(t,[x+.5,y+.5])));
});

test('early empty-pixel bounds discard bin entries without changing visibility',()=>{
 const s={width:8,height:8,primitiveCount:1,ids:new Uint32Array([0]),projected:new Float32Array([.01,.01,.4,.02,.03,.4,.03,.01,.4,.03,.01,.4,3,5])};
 const a=emulateRaster(s,'original',{capacity:10}),b=emulateRaster(s,'original',{capacity:10,earlyEmpty:true});
 assert.equal(a.stats.entries,1);assert.equal(b.stats.entries,0);assert.deepEqual(a.ids,b.ids);assert.deepEqual(a.depths,b.depths);
});
