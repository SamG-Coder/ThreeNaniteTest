import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createGameScene, terrainHeight } from '../src/gameScene.js';
import { FrameMeter } from '../src/frameMeter.js';
import { GameControls } from '../src/gameControls.js';

test('terrain scene has valid indexed geometry, vertex colors and a clear spawn', () => {
  const world = createGameScene(true, 'compact');
  const g=world.geometry;
  assert.equal(g.attributes.color.count,g.attributes.position.count);
  assert.equal(g.attributes.normal.count,g.attributes.position.count);
  assert.ok(g.index.count/3 > 50000);
  assert.ok(g.index.array.every(i=>i<g.attributes.position.count));
  assert.ok(g.attributes.position.array.every(Number.isFinite));
  assert.ok(g.attributes.color.array.every(Number.isFinite));
  const controls=Object.create(GameControls.prototype);
  controls.world=world;
  assert.equal(controls.blocked(world.spawn[0],world.spawn[2]),false);
  assert.equal(terrainHeight(0,-28),1.8);
  assert.equal(controls.blocked(-3.8,-14),true);
  world.geometry.dispose();
});

test('walking moves forward and jumping lands back on the terrain', () => {
  const controls=Object.create(GameControls.prototype);
  Object.assign(controls, {enabled:true, keys:new Set(['KeyW']), stick:{x:0,y:0}, yaw:0,
    world:{heightAt:()=>2,obstacles:[],bounds:20},camera:new THREE.PerspectiveCamera(),velocityY:0});
  controls.camera.position.set(0,3.7,10);
  for(let i=0;i<60;i++) controls.update(1/60);
  assert.ok(Math.abs(controls.camera.position.z-4.5)<1e-6);
  controls.keys.clear(); controls.jump(); controls.update(1/60);
  assert.ok(controls.camera.position.y>3.7);
  for(let i=0;i<100;i++) controls.update(1/60);
  assert.equal(controls.camera.position.y,3.7);
});

test('FPS counts frame intervals and discards hidden-tab and reset gaps', () => {
  const samples=[];
  const meter=new FrameMeter(sample=>samples.push(sample));
  for(let i=0;i<=30;i++) meter.tick(i*1000/60);
  assert.ok(Math.abs(samples[0].fps-60)<.01);
  assert.ok(Math.abs(samples[0].ms-1000/60)<.01);
  meter.tick(20000,false); meter.tick(30000); meter.reset(); meter.tick(50000);
  for(let i=1;i<=15;i++) meter.tick(50000+i*1000/30);
  assert.ok(Math.abs(samples.at(-1).fps-30)<.01);
});
