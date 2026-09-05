import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createForestScene, FOREST_COUNTS } from '../src/forestScene.js';
import { buildNaniteLiteAsset } from '../src/buildNaniteLiteAsset.js';
import { ForestRenderer } from '../src/ForestRenderer.js';

test('forest uses detailed shared trees, keeps spawn clear and reduces leaf LODs', async () => {
  const world=createForestScene('compact');
  assert.equal(world.treeInstances.length/4,FOREST_COUNTS.compact);
  assert.ok(world.treeGeometry.index.count/3>100000);
  assert.ok(world.treeGeometry.index.count/3*FOREST_COUNTS.ultra>50000000);
  assert.equal(world.obstacles.some(o=>Math.hypot(o.x-world.spawn[0],o.z-world.spawn[2])<o.radius+.35),false);
  const asset=await buildNaniteLiteAsset(world.treeGeometry,{meshletsPerGroup:64});
  assert.ok(asset.indices.every(i=>i<asset.vertexCount));
  assert.ok(asset.lods.at(-1).triangleCount<asset.sourceTriangleCount*.15);
  const renderer=new ForestRenderer({getDrawingBufferSize:v=>v.set(320,240)},new THREE.PerspectiveCamera(),asset,asset,
    {...world,geometry:world.treeGeometry},()=>{});
  assert.equal(renderer.trees.baselineMesh.count,96);
  assert.equal(renderer.trees.naniteMesh.parent,renderer.terrain.scene);
  assert.equal(renderer.trees.baselineMesh.parent,renderer.terrain.scene);
  renderer.setNaniteEnabled(false);
  assert.equal(renderer.terrain.naniteMesh.visible,false);
  assert.equal(renderer.trees.naniteMesh.visible,false);
  assert.equal(renderer.trees.baselineMesh.visible,true);
  renderer.setNaniteEnabled(true);
  assert.equal(renderer.trees.naniteMesh.visible,true);
  renderer.dispose();world.geometry.dispose();world.treeGeometry.dispose();
});
