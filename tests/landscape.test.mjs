import {createLandscapeTexture,createLandscapeMaterial} from '../src/landscapeMaterials.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import {createLandscapeScene,LANDSCAPE_PRESETS} from '../src/landscapeScene.js';
import {createLandscapeWater,createLandscapeSky} from '../src/landscapeWater.js';
import {GameControls} from '../src/gameControls.js';
import {create,globals} from 'webgpu';
const world=createLandscapeScene('compact');
test('landscape provides grass geometry, tagged trees, terrain and a dry spawn',()=>{
 assert.equal(world.forest,true);assert.equal(world.landscape,true);
 assert.equal(world.treeInstances.length/4,LANDSCAPE_PRESETS.compact.trees);assert.equal(world.grassClumps,LANDSCAPE_PRESETS.compact.grass);
 const g=world.geometry;assert.ok(g.index.count/3>200000);assert.ok(g.index.array.every(i=>i<g.attributes.position.count));
 assert.ok(g.attributes.position.array.every(Number.isFinite));assert.ok(g.attributes.normal.array.every(Number.isFinite));assert.equal(g.attributes.color.count,g.attributes.position.count);
 assert.ok(world.treeGeometry.attributes.foliage.array.some(x=>x===1));assert.ok(world.treeGeometry.attributes.foliage.array.some(x=>x===0));
 const [x,,z]=world.spawn;assert.equal(GameControls.prototype.blocked.call({world},x,z),false);
 assert.equal(GameControls.prototype.blocked.call({world},0,-12),true);
 const n=LANDSCAPE_PRESETS.compact.grid+1;
 for(let i=0;i<n*n;i+=113){const p=g.attributes.position;assert.ok(Math.abs(p.getY(i)-world.heightAt(p.getX(i),p.getZ(i)))<1e-4);}
});
test('shoreline depth matches the terrain and water stays a bounded separate draw',()=>{
 const water=createLandscapeWater(world),depth=water.geometry.attributes.waterDepth,p=water.geometry.attributes.position;
 assert.ok(depth.array.some(x=>x<0));assert.ok(depth.array.some(x=>x>1));
 for(let i=0;i<p.count;i+=127)assert.ok(Math.abs(depth.getX(i)-(world.water.y-world.heightAt(p.getX(i)+world.water.x,p.getZ(i)+world.water.z)))<1e-4);
 assert.ok(water.geometry.index.count/3<40000);assert.equal(water.material.transparent,false);
 water.geometry.dispose();water.material.dispose();
});
test('actual water and sky TSL shaders compile with Dawn/Tint',async()=>{
 Object.assign(globalThis,globals);const gpu=create(['backend=null']),adapter=await gpu.requestAdapter(),device=await adapter.requestDevice();
 const renderer=new THREE.WebGPURenderer({canvas:{width:320,height:240,style:{},addEventListener(){},removeEventListener(){}}});renderer.hasFeature=()=>false;
 try{
  for(const mesh of [createLandscapeWater(world),createLandscapeSky(),new THREE.Mesh(world.geometry.clone(),createLandscapeMaterial(createLandscapeTexture()))]){
   const builder=renderer.backend.createNodeBuilder(mesh,renderer);builder.scene=new THREE.Scene();builder.camera=new THREE.PerspectiveCamera();builder.build();
   for(const code of [builder.vertexShader,builder.fragmentShader]){
    const module=device.createShaderModule({code}),info=await module.getCompilationInfo();
    assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>m.message),[],mesh.material.name);
   }
   mesh.geometry.dispose();mesh.material.dispose();
  }
 }finally{device.destroy();}
});
