import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildHierarchyAsset, selectHierarchyCut } from '../src/buildHierarchyAsset.js';
import { buildNaniteLiteAsset } from '../src/buildNaniteLiteAsset.js';
import { NaniteLiteRenderer } from '../src/NaniteLiteRenderer.js';

function triangles(asset, node) {
  const offset = node * 24, result = [];
  const first = asset.groupLods[offset + 1], count = asset.groupLods[offset + 2];
  for (let c = first; c < first + count; c++) for (let t = 0; t < asset.clusterTriangleCounts[c]; t++) {
    result.push([...asset.indices.subarray(c * 192 + t * 3, c * 192 + t * 3 + 3)]);
  }
  return result;
}
function key(t) {
  return [t, [t[1],t[2],t[0]], [t[2],t[0],t[1]]].map(t=>t.join(',')).sort()[0];
}
function boundary(tris) {
  const edges = new Map();
  for (const t of tris) for (let i=0;i<3;i++) {
    const edge=[t[i],t[(i+1)%3]].sort((a,b)=>a-b).join(',');
    edges.set(edge,(edges.get(edge)??0)+1);
  }
  return [...edges].filter(([,n])=>n===1).map(([edge])=>edge).sort();
}
const geometry = new THREE.PlaneGeometry(12,12,48,48);
const positions=geometry.attributes.position;
for(let i=0;i<positions.count;i++) positions.setZ(i,Math.sin(positions.getX(i)*1.4)*Math.cos(positions.getY(i))*.7);
geometry.computeVertexNormals();
const built = buildHierarchyAsset(geometry,{leafMeshlets:2});

test('recursive parents preserve boundaries, source coverage and conservative error/bounds',async()=>{
  const asset=await built;
  assert.ok(asset.hierarchyDepth>3);
  assert.ok(asset.indices.every(i=>i<asset.vertexCount));
  const leaves=[];
  for(let n=0;n<asset.groupCount;n++) {
    const m=n*24, escape=asset.groupLods[m+4];
    assert.ok(escape>n&&escape<=asset.groupCount);
    if(!asset.groupLods[m+5]) { leaves.push(...triangles(asset,n)); assert.equal(escape,n+1); continue; }
    const a=n+1,b=asset.groupLods[a*24+4];
    assert.equal(asset.groupLods[b*24+4],escape);
    assert.deepEqual(boundary(triangles(asset,n)),boundary([...triangles(asset,a),...triangles(asset,b)]),`node ${n} changed outer boundary`);
    assert.ok(asset.groupLods[m+3]<=asset.groupLods[a*24+3]+asset.groupLods[b*24+3]);
    for(const child of [a,b]) {
      assert.ok(asset.groupLods[m]>=asset.groupLods[child*24]);
      const centerDistance=Math.hypot(...[0,1,2].map(i=>asset.groupBounds[n*4+i]-asset.groupBounds[child*4+i]));
      assert.ok(centerDistance+asset.groupBounds[child*4+3]<=asset.groupBounds[n*4+3]+1e-5);
    }
  }
  const original=[];
  for(let i=0;i<geometry.index.count;i+=3) original.push([...geometry.index.array.subarray(i,i+3)]);
  assert.deepEqual(leaves.map(key).sort(),original.map(key).sort());
  assert.ok(asset.groupLods[3]<asset.sourceTriangleCount*.5);
});

test('screen-space cuts cover each leaf exactly once and refine with pixels, zoom and proximity',async()=>{
  const asset=await built;
  const cut=(z,h=720,fov=50,error=4.5)=>selectHierarchyCut(asset,[0,0,z],h,fov,error);
  const count=cut=>cut.reduce((n,id)=>n+asset.groupLods[id*24+3],0);
  for(const z of [2,10,30,100,10000]) for(const h of [360,720,1440]) {
    const selected=cut(z,h), coverage=new Uint8Array(asset.groupCount);
    for(const id of selected) for(let n=id;n<asset.groupLods[id*24+4];n++) if(!asset.groupLods[n*24+5]) coverage[n]++;
    for(let n=0;n<asset.groupCount;n++) if(!asset.groupLods[n*24+5]) assert.equal(coverage[n],1);
  }
  assert.ok(count(cut(10))>count(cut(100)));
  assert.ok(count(cut(30,1440))>count(cut(30,360)));
  assert.ok(count(cut(30,720,25))>count(cut(30,720,90)));
  assert.ok(count(cut(30,720,50,.5))>count(cut(30,720,50,10)));
  assert.deepEqual(cut(10000),[0]);
  const mixed=cut(30);
  assert.ok(new Set(mixed.map(n=>asset.groupLods[n*24+6])).size>1,'near and far patches can use different hierarchy tiers');
});

test('both culling paths generate WGSL within the existing storage-buffer limit',async()=>{
  const renderer=new THREE.WebGPURenderer({canvas:{width:320,height:240,style:{},addEventListener(){},removeEventListener(){}}});
  // Offline shader generation only. No adapter/device or visual execution is claimed.
  renderer.hasFeature=()=>false;
  for(const asset of [await built,await buildNaniteLiteAsset(geometry,{meshletsPerGroup:4})]) {
    const pipeline=new NaniteLiteRenderer(renderer,new THREE.PerspectiveCamera(),asset,{sourceGeometry:geometry,gridSize:2,maxVisibleClusters:1000});
    for(const kernel of [pipeline.computeClear,pipeline.computeCull,pipeline.computeDrawArguments]) {
      const builder=renderer.backend.createNodeBuilder(kernel,renderer);
      builder.build();
      assert.match(builder.computeShader,/@compute/);
      assert.ok((builder.computeShader.match(/var<storage,/g)??[]).length<=12);
      if(kernel===pipeline.computeCull&&asset.hierarchy) assert.match(builder.computeShader,/while \(/);
    }
    assert.equal(pipeline.computeCull.count,asset.hierarchy?4:asset.groupCount*4);
    pipeline.dispose();
  }
});

test('full-detail software selection omits LOD decisions and avoids expanded hardware dummy geometry',async()=>{
  const renderer=new THREE.WebGPURenderer({canvas:{width:320,height:240,style:{},addEventListener(){},removeEventListener(){}}});renderer.hasFeature=()=>false;
  const asset=await buildNaniteLiteAsset(geometry,{meshletsPerGroup:4});
  const pipeline=new NaniteLiteRenderer(renderer,new THREE.PerspectiveCamera(),asset,{sourceGeometry:geometry,gridSize:1,maxVisibleClusters:asset.lods[0].clusterCount,fullGeometry:true,softwareOnly:true});
  const builder=renderer.backend.createNodeBuilder(pipeline.computeCull,renderer);builder.build();
  assert.equal(pipeline.naniteMesh.geometry.attributes.position.count,3);
  assert.equal(pipeline.maxVisibleClusters,asset.lods[0].clusterCount);
  assert.ok(!builder.uniforms.compute.some(u=>u.node===pipeline.lodThresholdUniform));
  assert.equal(asset.lods[0].triangleCount,asset.sourceTriangleCount);
  pipeline.dispose();
});
