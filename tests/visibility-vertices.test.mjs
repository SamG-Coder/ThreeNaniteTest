import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {packVisibilityVertices} from '../src/visibility/vertices.js';
import {buildNaniteLiteAsset} from '../src/buildNaniteLiteAsset.js';

test('textured visibility preserves authored float UVs, seams and vertex colours through meshlet packing',async()=>{
 const g=new THREE.BufferGeometry();
 // Coincident corners with distinct UVs must remain separate, including UVs
 // outside 0..1. World projection or half-float packing would fail this check.
 g.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0,0,0,0,0,1,0,-1,0,0],3));
 g.setAttribute('uv',new THREE.Float32BufferAttribute([-3.1234567,8.7654321,4,0,0,2,100.12345,-12.4567,9,3,-8,4],2));
 g.setAttribute('color',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,.5,.25,.125,1,1,0,0,1,1],3));
 g.setIndex([0,1,2,3,4,5]);g.computeVertexNormals();
 const asset=await buildNaniteLiteAsset(g),surface=new THREE.Float32BufferAttribute([0,0,0,2,2,2],1);
 const packed=packVisibilityVertices(asset,g.attributes.color,surface);
 assert.equal(packed.byteLength,asset.vertexCount*64);
 for(let i=0;i<6;i++){
  assert.deepEqual([...packed.slice(i*16+12,i*16+14)],[g.attributes.uv.getX(i),g.attributes.uv.getY(i)]);
  assert.deepEqual([...packed.slice(i*16+8,i*16+11)],[g.attributes.color.getX(i),g.attributes.color.getY(i),g.attributes.color.getZ(i)]);
  assert.equal(packed[i*16+7],surface.getX(i));
 }
 assert.equal(packVisibilityVertices(asset,g.attributes.color).byteLength,asset.vertexCount*48);
});
