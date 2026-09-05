import {landscapeVisibilityWGSL} from '../src/visibility/landscapeShaders.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {create,globals} from 'webgpu';
import {pagedVisibilityWGSL,pagedOpaqueVisibilityWGSL} from '../src/streaming/shaders.js';
import {visibilityWGSL,cullWGSL,pyramidWGSL,pyramidBaseWGSL} from '../src/visibility/shaders.js';
import {depthOrderWGSL} from '../src/streaming/depthOrder.js';
test('production visibility shaders compile with Chromium Dawn/Tint',async()=>{
 Object.assign(globalThis,globals);
 // Null backend validates WGSL without requiring a hardware adapter. It does
 // not prove GPU execution or validate device-specific render pipelines.
 const gpu=create(['backend=null']),adapter=await gpu.requestAdapter(),device=await adapter.requestDevice();
 try{
  for(const [name,code]of Object.entries({landscapeVisibilityWGSL,pagedVisibilityWGSL,pagedOpaqueVisibilityWGSL,visibilityWGSL,cullWGSL,pyramidWGSL,pyramidBaseWGSL,depthOrderWGSL})){
   const module=device.createShaderModule({code,label:name}),info=await module.getCompilationInfo();
   assert.deepEqual(info.messages.filter(m=>m.type==='error').map(m=>`${m.lineNum}: ${m.message}`),[],name);
  }
 }finally{device.destroy();}
});
