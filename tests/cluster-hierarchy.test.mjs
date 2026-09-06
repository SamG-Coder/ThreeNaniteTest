import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {buildClusterAsset} from '../src/cluster/buildClusterAsset.js';
import {GeometryCache} from '../src/cluster/GeometryCache.js';
function geometry(){const g=new THREE.SphereGeometry(2,16,12);g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(.5),3));return g;}
test('new hierarchy preserves every source triangle and float UV at its leaves',async()=>{
 const g=geometry(),a=await buildClusterAsset(g),source=[],leaves=[];
 for(let i=0;i<g.index.count;i+=3)source.push(Array.from(g.index.array.slice(i,i+3)).join(','));
 for(let n=0;n<a.groupCount;n++){
  const row=n*24;if(a.groupLods[row+5]){let child=n+1;for(let i=0;i<a.groupLods[row+5];i++){assert.ok(a.groupLods[row]>=a.groupLods[child*24]);child=a.groupLods[child*24+4];}continue;}
  for(let cluster=a.groupLods[row+1];cluster<a.groupLods[row+1]+a.groupLods[row+2];cluster++){
   assert.equal(a.clusterKinds[cluster],0);const words=a.pages[cluster],f=new Float32Array(words.buffer),local=new Uint8Array(words.buffer,0,192);
   for(let i=0;i<a.clusterTriangleCounts[cluster]*3;i++){
    const vertex=a.indices[cluster*192+i],o=48+local[i]*16;assert.equal(f[o+12],g.attributes.uv.getX(vertex));assert.equal(f[o+13],g.attributes.uv.getY(vertex));
    if(i%3===0)leaves.push(Array.from(a.indices.slice(cluster*192+i,cluster*192+i+3)).join(','));
   }
  }
 }
 assert.deepEqual(leaves.sort(),source.sort());assert.ok(a.clusterKinds.includes(1));
 for(let i=0;i<a.pages.length;i++)if(a.clusterKinds[i]){const page=a.pages[i];assert.ok(page[1]>=1&&page[1]<=8);for(let b=0;b<page[1];b++)assert.notEqual(page[16+b*8+4]|page[16+b*8+5],0);}
});
test('variable page cache publishes complete replacements and cancels stale partial uploads',async()=>{
 const a=await buildClusterAsset(geometry()),root=a.groupLods[2];let publishes=0;const cache=new GeometryCache(a,1024*1024,()=>{},()=>publishes++);
 const priorities=new Uint32Array(a.groupCount);priorities[0]=100;cache.request(priorities);
 const unit=cache.layout.units[0];assert.ok(unit.pages.length>1);const first=unit.pages[0];const bytes=a.pageWords[first]*4;
 assert.equal(cache.tick(bytes),bytes);assert.equal(cache.metadata()[5],0);assert.ok(!cache.resident.has(0));
 cache.request(new Uint32Array(a.groupCount));assert.equal(cache.mapping.size,root);assert.equal(cache.pending,null);
 cache.request(priorities);cache.tick(1000000);assert.ok(cache.resident.has(0));assert.equal(cache.metadata()[5],2);assert.ok(publishes>=2);
});
test('on-demand page loads retain parent coverage until the replacement is uploaded',async()=>{
 const a=await buildClusterAsset(geometry()),pages=a.pages.slice(),cache=new GeometryCache(a,1024*1024,()=>{},()=>{});
 a.pageProvider={get:async id=>pages[id]};for(let i=0;i<a.pages.length;i++)if(!cache.mapping.has(i))a.pages[i]=undefined;
 const priorities=new Uint32Array(a.groupCount);priorities[0]=10;cache.request(priorities);assert.equal(cache.tick(1000000),0);assert.equal(cache.metadata()[5],0);
 await Promise.all(cache.loading.values());assert.ok(cache.tick(1000000)>0);assert.equal(cache.metadata()[5],2);
 for(const id of cache.layout.units[0].pages)assert.equal(a.pages[id],undefined);
});
