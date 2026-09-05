import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {clipToCell,addProjectedCoverage,projectedCoverage} from '../src/streaming/coverage.js';
import {voxelizeSurface} from '../src/streaming/voxels.js';
import {packPage} from '../src/streaming/pages.js';
test('projected coverage unions both sides of a leaf without double opacity',()=>{
 const masks=new Uint32Array(6),triangle=[[0,0,.5],[1,0,.5],[0,1,.5]];
 const clipped=clipToCell(triangle,[0,0,0],1);
 addProjectedCoverage(masks,clipped,[0,0,0],1);
 const before=masks.slice();addProjectedCoverage(masks,[...clipped].reverse(),[0,0,0],1);
 assert.deepEqual(masks,before);assert.ok(projectedCoverage(masks,2)>.4&&projectedCoverage(masks,2)<.65);
 assert.equal(projectedCoverage(masks,0),0);assert.equal(projectedCoverage(masks,1),0);
});
test('clipping excludes neighboring cells and keeps thin partial leaf coverage',()=>{
 const tri=[[0,0,.5],[.25,0,.5],[0,.25,.5]],masks=new Uint32Array(6);
 addProjectedCoverage(masks,clipToCell(tri,[0,0,0],1),[0,0,0],1);
 assert.ok(projectedCoverage(masks,2)>0&&projectedCoverage(masks,2)<.1);
 assert.deepEqual(clipToCell(tri,[2,0,0],1),[]);
});
test('coverage occupies spare page bytes without enlarging the geometry cache',()=>{
 const a={vertices:new Float32Array(12),normals:new Float32Array(12),indices:Uint32Array.from({length:192},(_,i)=>i%3),coverage:new Float32Array([0,.5,1])};
 const page=packPage(a,null,0);
 assert.equal(page.byteLength,2560);assert.equal(page[624]&255,0);assert.equal((page[624]>>>8)&255,128);assert.equal((page[624]>>>16)&255,255);
});
test('voxel foliage keeps opaque wood triangles exactly and emits partial coverage',()=>{
 const g=new THREE.BufferGeometry();
 const positions=[0,0,0,1,0,0,0,1,0, 2,0,.5,2.25,0,.5,2,.25,.5];
 g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex([0,1,2,3,4,5]);g.computeVertexNormals();
 g.setAttribute('color',new THREE.Float32BufferAttribute(new Float32Array(18).fill(.4),3));
 g.setAttribute('foliage',new THREE.Float32BufferAttribute([0,0,0,1,1,1],1));
 const v=voxelizeSurface(g,1),a=v.attributes.coverage;
 assert.ok([...a.array].some(x=>x>0&&x<1));
 const last=[...v.index.array.slice(-3)].flatMap(i=>[v.attributes.position.getX(i),v.attributes.position.getY(i),v.attributes.position.getZ(i)]);
 assert.deepEqual(last,positions.slice(0,9));for(const i of v.index.array.slice(-3))assert.equal(a.getX(i),1);
 g.dispose();v.dispose();
});

import {depthOrderWGSL} from '../src/streaming/depthOrder.js';
import {initSync,WgslFrontend} from 'web-naga';
import {readFileSync} from 'node:fs';
test('bounded GPU depth ordering validates including workgroup barriers',()=>{
 initSync({module:readFileSync(new URL('./web_naga_bg.wasm',import.meta.resolve('web-naga')))});
 const f=WgslFrontend.new(),m=f.parse(depthOrderWGSL);assert.ok(m.to_wgsl());m.free();f.free();
});

import {pagedOpaqueVisibilityWGSL} from '../src/streaming/shaders.js';
test('ordinary streaming retains an opaque visibility pipeline without discard',()=>{
 assert.ok(!pagedOpaqueVisibilityWGSL.includes('discard;'));
 const f=WgslFrontend.new(),m=f.parse(pagedOpaqueVisibilityWGSL);assert.ok(m.to_wgsl());m.free();f.free();
});
