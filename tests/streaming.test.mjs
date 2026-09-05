import test from 'node:test';
import assert from 'node:assert/strict';
import { packPage, unpackCorner, PageCache, PAGE_WORDS } from '../src/streaming/pages.js';
function asset(hierarchy=false){
 const a={hierarchy,groupCount:3,groupLods:new Float32Array(3*24)};
 if(hierarchy){
  for(let i=0;i<3;i++){a.groupLods.set([1,i,1,1],i*24);a.groupLods.set([i===0?3:i+1,i===0?2:0,0,0],i*24+4);}
 }else for(let i=0;i<3;i++)for(let l=0;l<6;l++)a.groupLods.set([l,i*6+l,1,1],i*24+l*4);
 return a;
}
test('packed pages preserve every corner position, normal and color exactly',()=>{
 const vertices=Float32Array.from({length:64*4},(_,i)=>Math.sin(i)*100),normals=vertices.map(x=>x/100);
 const indices=Uint32Array.from({length:192},(_,i)=>(i*17)%64);
 const colors={getX:i=>vertices[i*4],getY:i=>vertices[i*4+1],getZ:i=>vertices[i*4+2]};
 const page=packPage({vertices,normals,indices},colors,0);
 for(let i=0;i<192;i++){const v=indices[i];assert.deepEqual([...unpackCorner(page,i)],[...vertices.slice(v*4,v*4+3),...normals.slice(v*4,v*4+3),...vertices.slice(v*4,v*4+3)]);}
 assert.equal(page.byteLength,2560);
});
test('partial uploads never publish detail and never exceed transfer budget',()=>{
 const a=asset(),c=new PageCache(a,8,()=>{},()=>{});
 c.request([9,0,0]);assert.equal(c.tick(PAGE_WORDS*4*2),PAGE_WORDS*4*2);
 assert.equal(c.resident.size,0);assert.equal(c.metadata()[1],5);
 c.tick(PAGE_WORDS*4*3);assert.deepEqual([...c.resident],[0]);assert.equal(c.metadata()[1],0);
 assert.equal(c.mapping.size,8);
});
test('eviction collapses fallback before page slots are reused',()=>{
 const events=[],a=asset(),c=new PageCache(a,8,(page,slot)=>events.push(['upload',page,slot]),r=>events.push(['publish',[...r]]));
 c.request([9,0,0]);c.tick(1e6);c.request([0,9,0]);events.length=0;c.tick(1e6);
 assert.deepEqual(events[0],['publish',[]]);assert.deepEqual([...c.resident],[1]);assert.equal(c.metadata()[1],5);assert.equal(c.mapping.size,8);
 assert.equal(new Set(c.mapping.values()).size,8);
});
test('hierarchy only descends after all siblings are resident',()=>{
 const a=asset(true),c=new PageCache(a,3,()=>{},()=>{});
 assert.equal(c.metadata()[5],0);assert.ok(c.mapping.has(0));
 c.request([9,0,0]);c.tick(PAGE_WORDS*4);assert.equal(c.metadata()[5],0);
 c.tick(PAGE_WORDS*4);assert.equal(c.metadata()[5],2);assert.deepEqual([...c.mapping.keys()],[0,1,2]);
});
test('an oversized request leaves the complete fallback intact',()=>{
 const a=asset(),c=new PageCache(a,4,()=>{},()=>{});c.request([9,9,9]);
 assert.equal(c.tick(1e6),0);assert.equal(c.mapping.size,3);assert.equal(c.resident.size,0);
});

import * as THREE from 'three/webgpu';
import { triangleBoxOverlap, voxelizeSurface, addVoxelRoot } from '../src/streaming/voxels.js';
import { buildNaniteLiteAsset } from '../src/buildNaniteLiteAsset.js';
import { buildHierarchyAsset } from '../src/buildHierarchyAsset.js';
import { initSync, WgslFrontend } from 'web-naga';
import { readFileSync } from 'node:fs';
import { pagedVisibilityWGSL } from '../src/streaming/shaders.js';

test('paged visibility shader validates through Naga',()=>{
 initSync({module:readFileSync(new URL('./web_naga_bg.wasm',import.meta.resolve('web-naga')))});
 const frontend=WgslFrontend.new();const module=frontend.parse(pagedVisibilityWGSL);assert.ok(module.to_wgsl());module.free();frontend.free();
});
test('surface occupancy rejects empty boxes inside triangle bounds',()=>{
 const t=[[0,0,0],[2,0,0],[0,2,0]];
 assert.equal(triangleBoxOverlap(...t,[.2,.2,0],.1),true);
 assert.equal(triangleBoxOverlap(...t,[1.8,1.8,0],.1),false);
 assert.equal(triangleBoxOverlap(...t,[.2,.2,1],.1),false);
});
test('voxel exposed faces have outward winding and omit internal faces',()=>{
 const g=new THREE.BoxGeometry(1,1,1);g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(.5),3));
 const v=voxelizeSurface(g,.25),p=v.attributes.position.array,idx=v.index.array;
 for(let i=0;i<idx.length;i+=3){
  const a=new THREE.Vector3().fromArray(p,idx[i]*3),b=new THREE.Vector3().fromArray(p,idx[i+1]*3),c=new THREE.Vector3().fromArray(p,idx[i+2]*3);
  const n=b.clone().sub(a).cross(c.clone().sub(a));assert.ok(n.length()>0);
 }
 assert.ok(idx.length/3<v.userData.occupiedCells*12);g.dispose();v.dispose();
});
test('voxel root preserves all original indices and complete hierarchy cuts',async()=>{
 for(const builder of [buildNaniteLiteAsset,buildHierarchyAsset]){
  const g=new THREE.SphereGeometry(1,12,8);g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(.5),3));
  const original=await builder(g,{meshletsPerGroup:2,leafMeshlets:2});const a=await addVoxelRoot(original,g,.4);
  assert.deepEqual(a.indices.slice(0,original.indices.length),original.indices);
  assert.equal(a.groupLods[1],original.totalClusters);assert.equal(a.groupLods[4],a.groupCount);
  assert.equal(a.sourceColors.count,a.vertexCount);
  let node=1,covered=0;
  while(node<a.groupCount){covered++;const escape=a.groupLods[node*24+4];assert.ok(escape>node&&escape<=a.groupCount);node=escape;}
  assert.equal(covered,a.groupLods[5]);
  const cache=new PageCache(a,a.totalClusters,()=>{},()=>{});
  assert.equal(cache.metadata()[5],a.groupLods[5]);cache.request(new Uint32Array(a.groupCount).fill(1));cache.tick(1e9);
  assert.equal(cache.metadata()[5],a.groupLods[5]);assert.equal(cache.mapping.size,a.totalClusters);
  g.dispose();
 }
});

import { NaniteLiteRenderer } from '../src/NaniteLiteRenderer.js';
test('streaming demand uses the existing bindings for patch, hierarchy and voxel selection',async()=>{
 const g=new THREE.SphereGeometry(1,12,8);g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count*3).fill(.5),3));
 const patch=await buildNaniteLiteAsset(g,{meshletsPerGroup:2});
 const renderer=new THREE.WebGPURenderer({canvas:{width:320,height:240,style:{},addEventListener(){},removeEventListener(){}}});renderer.hasFeature=()=>false;
 for(const a of [patch,await buildHierarchyAsset(g,{leafMeshlets:2}),await addVoxelRoot(patch,g)]){
  const pipeline=new NaniteLiteRenderer(renderer,new THREE.PerspectiveCamera(),a,{sourceGeometry:g,gridSize:1,streaming:true,softwareOnly:true,fullGeometry:true,maxVisibleClusters:1000});
  assert.equal(pipeline.lodCounterAttribute.array.length,6+a.groupCount);
  for(const kernel of [pipeline.computeClear,pipeline.computeCull]){
   const builder=renderer.backend.createNodeBuilder(kernel,renderer);builder.build();
   assert.ok((builder.computeShader.match(/var<storage,/g)??[]).length<=12);
   const front=WgslFrontend.new(),module=front.parse(builder.computeShader);module.to_wgsl();module.free();front.free();
   if(kernel===pipeline.computeCull)assert.match(builder.computeShader,/atomicMax/);
  }
  pipeline.dispose();
 }
 g.dispose();
});

test('camera demand changes keep a complete resident cut through recursive eviction',()=>{
 const a={hierarchy:true,groupCount:7,groupLods:new Float32Array(7*24)};
 const escape=[7,4,3,4,7,6,7],children=[2,2,0,0,2,0,0];
 for(let i=0;i<7;i++){a.groupLods.set([1,i,1,1],i*24);a.groupLods.set([escape[i],children[i],0,0],i*24+4);}
 const c=new PageCache(a,5,()=>{},()=>{});
 for(const demand of [[9,8,0,0,0,0,0],[9,0,0,0,8,0,0],[9,8,0,0,0,0,0]]){
  c.request(demand);
  for(let frame=0;frame<5;frame++){
   c.tick(PAGE_WORDS*4);const table=c.metadata();let node=0;const leaves=[];
   while(node<7){
    if(table[node*24+5]){node++;continue;}
    assert.ok(c.mapping.has(table[node*24+1]),`selected nonresident node ${node}`);
    for(let i=node;i<escape[node];i++)if(!children[i])leaves.push(i);
    node=escape[node];
   }
   assert.deepEqual(leaves,[2,3,5,6]);assert.equal(new Set(c.mapping.values()).size,c.mapping.size);assert.ok(c.mapping.size<=5);
  }
 }
 assert.ok(c.evictions>=2);
});
