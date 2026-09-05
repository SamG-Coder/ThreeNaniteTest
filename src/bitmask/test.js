import * as THREE from 'three/webgpu';
import { createFixture } from './fixtures.js';
import { rasterWGSL, validateWGSL, presentWGSL } from './shaders.js';
import { CANDIDATE_CAPACITY, MASK_WORDS } from './reference.js';
import './test.css';

const el = Object.fromEntries(['canvas','status','fixture','resolution','view','animate','validate','metrics','validation','error','reset']
  .map(id => [id, document.getElementById(id)]));
let device, context, pipelines, resources, format;
let frameId, stopped = false, angleX = .35, angleY = 0, revision = 0;
let previousTime, meterStart, frames = 0, fps = '—', lastReadback = -Infinity;
let readbackBusy = false, validationRequested = false;
let validationPending = false;
const camera = new THREE.PerspectiveCamera(50,1,.1,30);
camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
const model = new THREE.Matrix4(), transform = new THREE.Matrix4();
const uniformBytes = new ArrayBuffer(80), matrixValues = new Float32Array(uniformBytes,0,16), config = new Uint32Array(uniformBytes,64,4);

function fail(error) {
  stopped = true; cancelAnimationFrame(frameId);
  el.error.hidden = false; el.error.textContent = error instanceof Error ? error.message : String(error);
  el.status.textContent = 'Test stopped'; el.validate.disabled = true;
}
function invalidate() {
  revision++; validationPending = false; validationRequested = false;
  el.validation.textContent = 'GPU correctness: not checked';
  el.view.querySelector('[value="5"]').disabled = true;
  if (el.view.value === '5') el.view.value = '0';
  previousTime = undefined; meterStart = undefined; frames = 0; fps = '—';
}
function buffer(size, usage, data) {
  const value = device.createBuffer({size,usage});
  if(data) device.queue.writeBuffer(value,0,data);
  return value;
}
function computeLayout(validation = false) {
  const entries = [{binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}}];
  for(let i=1;i<=6;i++) entries.push({binding:i,visibility:GPUShaderStage.COMPUTE,buffer:{type:i===1?'read-only-storage':'storage'}});
  entries.push({binding:7,visibility:GPUShaderStage.COMPUTE,...(validation?{texture:{sampleType:'unfilterable-float'}}:{storageTexture:{access:'write-only',format:'r32float'}})});
  entries.push({binding:8,visibility:GPUShaderStage.COMPUTE,...(validation?{texture:{sampleType:'uint'}}:{storageTexture:{access:'write-only',format:'r32uint'}})});
  if(validation) entries.push({binding:9,visibility:GPUShaderStage.COMPUTE,storageTexture:{access:'write-only',format:'r32uint'}});
  return device.createBindGroupLayout({entries});
}
async function createPipelines() {
  const modules = [rasterWGSL,validateWGSL,presentWGSL].map((code,i)=>device.createShaderModule({code,label:`Bitmask raster module ${i}`}));
  for(const module of modules) {
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter(m=>m.type==='error');
    if(errors.length) throw new Error(errors.map(m=>`WGSL ${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
  }
  const layout = computeLayout(), validationLayout = computeLayout(true);
  const result = {layout,validationLayout};
  const entries = ['clear','bin','coverage','resolve'];
  const built = await Promise.all(entries.map(entryPoint=>device.createComputePipelineAsync({
    label:`Bitmask ${entryPoint}`,layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module:modules[0],entryPoint}
  })));
  entries.forEach((entry,i)=>result[entry]=built[i]);
  result.validate = await device.createComputePipelineAsync({label:'Bitmask exhaustive validation',layout:device.createPipelineLayout({bindGroupLayouts:[validationLayout]}),compute:{module:modules[1],entryPoint:'validate'}});
  const presentLayout = device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float'}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'uint'}},
    ...[3,4,5].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}})),
    {binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'uint'}}
  ]});
  result.present = await device.createRenderPipelineAsync({label:'Bitmask presentation',layout:device.createPipelineLayout({bindGroupLayouts:[presentLayout]}),vertex:{module:modules[2],entryPoint:'vertex'},fragment:{module:modules[2],entryPoint:'fragment',targets:[{format}]},primitive:{topology:'triangle-list'}});
  return result;
}
function rebuild() {
  invalidate();
  const old = resources;
  const maxDimension = Number(el.resolution.value), aspect = innerWidth / innerHeight;
  const width = Math.max(8,Math.floor((aspect>=1?maxDimension:maxDimension*aspect)/8)*8);
  const height = Math.max(8,Math.floor((aspect>=1?maxDimension/aspect:maxDimension)/8)*8);
  const pixels = width*height, tiles = pixels/64;
  const fixture = createFixture(el.fixture.value);
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const buffers = [buffer(80,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),
    buffer(fixture.data.byteLength,storage,fixture.data),buffer(fixture.data.byteLength,storage),
    buffer(tiles*4,storage),buffer(tiles*CANDIDATE_CAPACITY*4,storage),buffer(pixels*MASK_WORDS*4,storage),
    buffer(16,storage|GPUBufferUsage.COPY_SRC)];
  const textures = ['r32float','r32uint','r32uint'].map(format=>device.createTexture({size:[width,height],format,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING}));
  const views = textures.map(t=>t.createView());
  const entries = buffers.map((b,binding)=>({binding,resource:{buffer:b}}));
  const group = device.createBindGroup({layout:pipelines.layout,entries:[...entries,{binding:7,resource:views[0]},{binding:8,resource:views[1]}]});
  const validateGroup = device.createBindGroup({layout:pipelines.validationLayout,entries:[...entries,{binding:7,resource:views[0]},{binding:8,resource:views[1]},{binding:9,resource:views[2]}]});
  const presentGroup = device.createBindGroup({layout:pipelines.present.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:buffers[0]}},{binding:1,resource:views[0]},{binding:2,resource:views[1]},
    {binding:3,resource:{buffer:buffers[1]}},{binding:4,resource:{buffer:buffers[3]}},
    {binding:5,resource:{buffer:buffers[5]}},{binding:6,resource:views[2]}
  ]});
  const readback = buffer(16,GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ);
  resources = {width,height,pixels,tiles,fixture,buffers,textures,group,validateGroup,presentGroup,readback,
    bytes:buffers.reduce((sum,b)=>sum+b.size,0)+pixels*12+16};
  camera.aspect = width/height;
  camera.position.set(0,0,4/Math.min(1,camera.aspect));
  camera.far = camera.position.z + 10;
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  el.canvas.width = width; el.canvas.height = height;
  el.status.textContent = 'WebGPU · Bitmask Raster Test';
  el.metrics.textContent = `${width}×${height} internal · ${fixture.count} triangles · waiting for counters`;
  if(old) {
    for(const b of old.buffers) b.destroy(); for(const t of old.textures) t.destroy();
    // A mapped readback must finish or reject before its allocation is retired.
    if(old.readback.mapState==='unmapped') old.readback.destroy(); else old.retireReadback=true;
  }
}
function dispatch(encoder, pipeline, group, count) {
  const pass=encoder.beginComputePass({label:pipeline.label});
  pass.setPipeline(pipeline); pass.setBindGroup(0,group); pass.dispatchWorkgroups(Math.ceil(count/64)); pass.end();
}
function requestReadback(r, frameRevision, wasValidation, now) {
  readbackBusy = true; lastReadback = now;
  r.readback.mapAsync(GPUMapMode.READ).then(()=>{
    const values=new Uint32Array(r.readback.getMappedRange()).slice(); r.readback.unmap();
    if(resources!==r || frameRevision!==revision) return;
    el.metrics.textContent = `${fps} FPS · ${r.width}×${r.height} · ${r.fixture.count} triangles · ${(r.bytes/1048576).toFixed(1)} MiB test buffers · ${values[1]} covered pixels · ${values[0]} overflow tiles`;
    el.metrics.classList.toggle('warning',values[0]>0);
    if(wasValidation) {
      validationPending=false;
      el.validation.textContent=values[3]===0?'GPU check: PASS · 0 mismatched pixels':`GPU check: FAIL · ${values[3]} mismatched pixels`;
      el.validation.classList.toggle('warning',values[3]>0);
      el.view.querySelector('[value="5"]').disabled=false;
      el.view.value='5';
    }
  }).catch(error=>{
    if(resources===r && frameRevision===revision) {
      validationPending=false;
      el.validation.textContent=`Readback failed: ${error.message}`;
    }
  }).finally(()=>{
    if(r.retireReadback) r.readback.destroy();
    readbackBusy=false;
  });
}
function frame(now) {
  if(stopped) return;
  try {
    const r=resources;
    const dt=previousTime===undefined?0:Math.min(.05,(now-previousTime)/1000); previousTime=now;
    if(!document.hidden) {
      if(meterStart===undefined) meterStart=now;
      else { frames++; if(now-meterStart>=500) { fps=(frames*1000/(now-meterStart)).toFixed(0); frames=0; meterStart=now; } }
    }
    if(el.animate.checked && !document.hidden) angleY+=dt*.35;
    model.makeRotationFromEuler(new THREE.Euler(angleX,angleY,0));
    transform.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(model);
    matrixValues.set(transform.elements); config.set([r.width,r.height,r.fixture.count,Number(el.view.value)]);
    device.queue.writeBuffer(r.buffers[0],0,uniformBytes);
    const encoder=device.createCommandEncoder({label:'Bitmask test frame'});
    dispatch(encoder,pipelines.clear,r.group,r.pixels*MASK_WORDS);
    dispatch(encoder,pipelines.bin,r.group,r.fixture.count);
    dispatch(encoder,pipelines.coverage,r.group,r.tiles*CANDIDATE_CAPACITY);
    dispatch(encoder,pipelines.resolve,r.group,r.pixels);
    const validateNow=validationRequested&&!readbackBusy;
    if(validateNow) {
      dispatch(encoder,pipelines.validate,r.validateGroup,r.pixels);
      validationRequested=false; validationPending=true;
    }
    const shouldRead=!readbackBusy&&(validateNow||now-lastReadback>=500);
    if(shouldRead) encoder.copyBufferToBuffer(r.buffers[6],0,r.readback,0,16);
    const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:1}}]});
    pass.setPipeline(pipelines.present); pass.setBindGroup(0,r.presentGroup); pass.draw(3); pass.end();
    device.queue.submit([encoder.finish()]);
    if(shouldRead) requestReadback(r,revision,validateNow,now);
    el.validate.disabled=validationRequested||validationPending;
    frameId=requestAnimationFrame(frame);
  } catch(error) { fail(error); }
}
async function init() {
  if(!navigator.gpu) throw new Error('This test requires a WebGPU browser. Use the return link to open the main demo.');
  const adapter=await navigator.gpu.requestAdapter();
  if(!adapter) throw new Error('No WebGPU adapter is available.');
  device=await adapter.requestDevice();
  device.addEventListener('uncapturederror',event=>fail(event.error));
  device.lost.then(info=>{ if(!stopped) fail(new Error(`WebGPU device lost: ${info.message}`)); });
  context=el.canvas.getContext('webgpu'); format=navigator.gpu.getPreferredCanvasFormat();
  context.configure({device,format,alphaMode:'opaque'});
  pipelines=await createPipelines();
  if(matchMedia('(pointer: coarse)').matches) el.resolution.value='256';
  rebuild(); el.validate.disabled=false;
  el.fixture.addEventListener('change',()=>{
    el.animate.checked=el.fixture.value==='torus'; angleX=el.animate.checked ? .35 : 0; angleY=0; rebuild();
  });
  el.resolution.addEventListener('change',rebuild);
  el.animate.addEventListener('change',invalidate);
  el.validate.addEventListener('click',()=>{
    el.animate.checked=false; validationRequested=true;
    el.validation.textContent='Checking this frame against exhaustive GPU resolve…'; el.validate.disabled=true;
  });
  el.reset.addEventListener('click',()=>{angleX=el.fixture.value==='torus' ? .35 : 0;angleY=0;invalidate();});
  let pointer=null;
  el.canvas.addEventListener('pointerdown',event=>{pointer={id:event.pointerId,x:event.clientX,y:event.clientY};el.canvas.setPointerCapture(event.pointerId);});
  el.canvas.addEventListener('pointermove',event=>{
    if(!pointer||event.pointerId!==pointer.id) return;
    angleY+=(event.clientX-pointer.x)*.008; angleX+=(event.clientY-pointer.y)*.008;
    pointer.x=event.clientX;pointer.y=event.clientY;el.animate.checked=false;invalidate();
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture']) el.canvas.addEventListener(name,()=>{pointer=null;});
  let resizePending=false;
  window.addEventListener('resize',()=>{if(!resizePending){resizePending=true;requestAnimationFrame(()=>{resizePending=false;if(!stopped)rebuild();});}});
  document.addEventListener('visibilitychange',()=>{previousTime=undefined;meterStart=undefined;frames=0;});
  frameId=requestAnimationFrame(frame);
}
init().catch(fail);
