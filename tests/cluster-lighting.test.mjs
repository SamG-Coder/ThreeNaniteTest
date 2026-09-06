import test from 'node:test';
import assert from 'node:assert/strict';
import {buildInstanceBVH} from '../src/lighting/instanceBVH.js';
test('lighting BVH retains off-screen instances and bounds rotated/scaled roots',()=>{
 const pipelines=[{asset:{groupBounds:new Float32Array([2,3,4,5])},instanceCount:3,instanceDataAttribute:{array:new Float32Array([0,0,0,1,100,2,-20,2,-100,0,0,.5])},visibleCount:0}];
 const {data,count}=buildInstanceBVH(pipelines);assert.equal(count,5);const ids=[];
 for(let n=0;n<count;n++){const o=n*12;assert.ok(data[o+3]>n&&data[o+3]<=count);if(!data[o+7])continue;const i=data[o+9];ids.push(i);const a=pipelines[0].instanceDataAttribute.array,scale=a[i*4+3],angle=i*.61803398875;const c=[a[i*4]+scale*(Math.cos(angle)*2-Math.sin(angle)*4),a[i*4+1]+scale*3,a[i*4+2]+scale*(Math.sin(angle)*2+Math.cos(angle)*4)];for(let axis=0;axis<3;axis++){assert.ok(Math.abs(data[o+axis]-(c[axis]-scale*5))<1e-4);assert.ok(Math.abs(data[o+4+axis]-(c[axis]+scale*5))<1e-4);}}
 assert.deepEqual(ids.sort(),[0,1,2]);
});

import {lightingResolution,lightingBudgets} from '../src/lighting/resolution.js';
test('secondary lighting stays within budget in portrait, landscape and resized outputs',()=>{
 for(const [quality,budget]of Object.entries(lightingBudgets))for(const [width,height]of [[779,1536],[3840,2160],[2160,3840],[192,128],[1,1]]){
  const [w,h]=lightingResolution(width,height,quality);assert.ok(w*h<=budget);assert.ok(w>0&&h>0);assert.ok(w<=Math.ceil(width/4)&&h<=Math.ceil(height/4));
 }
 assert.deepEqual(lightingResolution(192,128),[48,32]);
 assert.ok(lightingResolution(779,1536,'fast')[0]<lightingResolution(779,1536,'high')[0]);
});
