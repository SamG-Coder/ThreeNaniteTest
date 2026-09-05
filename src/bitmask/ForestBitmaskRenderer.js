import { forestFastWGSL } from './forestFastShaders.js';
import * as THREE from 'three/webgpu';
import { Discard, Fn, If, screenCoordinate, textureLoad, uint } from 'three/tsl';
import { forestBoundedWGSL, forestDispatchWGSL } from './forestBoundedShaders.js';
import { forestRasterWGSL } from './forestShaders.js';
import { forestReferenceWGSL } from './forestReferenceShaders.js';
import { forestOwnedMaskWGSL } from './forestOwnedMaskShaders.js';
import { forestRejectWGSL } from './forestRejectShaders.js';
import { rasterVariant, rasterVariantLabels } from './variant.js';
import { FrameGate, FrameProbe, frameOptions } from './FrameExperiment.js';

// Uses the pinned Three 0.185.1 backend to share GPU-selected meshlet lists.
// Geometry visibility and color are computed here; Three presents the output
// and renders the ordinary sky/lake against the computed forest depth.
export class ForestBitmaskRenderer {
  constructor(forest, variant) {
    this.forest=forest;this.renderer=forest.terrain.renderer;this.camera=forest.terrain.camera;
    this.device=this.renderer.backend.device;this.outputMode='shaded';this.disposed=false;
    this.lastReadback=-Infinity;this.reading=false;this.generation=0;
    this.metrics=null;this.buffers=[];
    this.variant=variant??rasterVariant(globalThis.location?.search??'');
    this.options=frameOptions(globalThis.location?.search??'');this.gate=new FrameGate(this.options.frames);
    this.probe=new FrameProbe(this.device);this.intervals=[];this.lastSubmit=null;this.cpuMs=0;
    this.selectionNodes=null;
    this.uniformBytes=new ArrayBuffer(128);
    this.uniform=this.makeBuffer(128,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.control=this.makeBuffer(64,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);
    this.readback=this.makeBuffer(64,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    if(['bounded','fast'].includes(this.variant))this.dispatchArgs=this.makeBuffer(12,GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT);
    this.assets=this.createAssets();
    this.resize();this.createControls();
  }
  createAssets(){
    return this.forest.pipelines.map(p=>{
      const vertices=new Float32Array(p.asset.vertexCount*12);
      for(let i=0;i<p.asset.vertexCount;i++){
        vertices.set(p.asset.vertices.subarray(i*4,i*4+4),i*12);
        vertices.set(p.asset.normals.subarray(i*4,i*4+4),i*12+4);
        vertices.set(p.sourceColors?[p.sourceColors.getX(i),p.sourceColors.getY(i),p.sourceColors.getZ(i),1]:[.3,.5,.3,1],i*12+8);
      }
      const indices=new Uint32Array(p.asset.indices.length+p.asset.clusterLod.length);
      indices.set(p.asset.indices);indices.set(p.asset.clusterLod,p.asset.indices.length);
      return {vertices:this.makeBuffer(vertices.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,vertices),
        indices:this.makeBuffer(indices.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,indices)};
    });
  }
  get busy(){return this.gate.busy;}
  createControls(){
    this.panel=document.createElement('section');
    this.panel.innerHTML=`<h2>Raster experiments</h2><p>Compare one change at a time. Reset camera before measuring.</p>`;
    const controls=[['frames','Frames in flight',[['1','1 — baseline'],['2','2 — overlap submissions']]],['batch','Batch selection',[[true,'On'],[false,'Off']]],['skipArgs','Skip unused draw arguments',[[true,'On'],[false,'Off']]],['direct','Presentation',[[false,'Intermediate target'],[true,'Direct — experimental']]],['profile','GPU timing',[[false,'Off'],[true,'On — sampled']]]];
    for(const [key,title,choices] of controls){
      const label=document.createElement('label');label.className='field';
      const span=document.createElement('span');span.textContent=title;label.append(span);
      const select=document.createElement('select');
      for(const [value,text] of choices){const o=document.createElement('option');o.value=String(value);o.textContent=text;select.append(o);}
      select.value=String(this.options[key]);
      select.onchange=()=>{this.options[key]=key==='frames'?Number(select.value):select.value==='true';this.gate.limit=this.options.frames;this.intervals=[];this.lastSubmit=null;this.gate.skipped=0;this.probe.gpu=null;};
      label.append(select);this.panel.append(label);
    }
    this.readout=document.createElement('p');this.readout.className='muted';this.panel.append(this.readout);
    document.getElementById('controls-panel').append(this.panel);
  }
  prepare(now){
    if(this.busy){this.gate.skipped++;this.updateReadout();return false;}
    this.cpuStart=performance.now();this.probe.begin(now,this.options.profile);this.probe.mark(0);
    const nodes=[];
    for(const p of [this.forest.trees,this.forest.terrain]){
      p.updateCameraUniforms();nodes.push(p.computeClear,p.computeCull);
      if(!this.options.skipArgs)nodes.push(p.computeDrawArguments);
    }
    if(this.options.batch){
      // Stable array identity avoids growing Three's compute-group cache.
      if(!this.selectionNodes||this.selectionNodes.length!==nodes.length)this.selectionNodes=nodes;
      this.renderer.compute(this.selectionNodes);
    }else for(const node of nodes)this.renderer.compute(node);
    this.probe.mark(1);
    for(const p of this.forest.pipelines)p.requestStatsReadback(now);
    return true;
  }
  updateReadout(){
    if(!this.readout||performance.now()-(this.lastUI??-Infinity)<500)return;
    this.lastUI=performance.now();
    const sorted=[...this.intervals].sort((a,b)=>a-b);
    const median=sorted[Math.floor(sorted.length*.5)]??0,p95=sorted[Math.floor(sorted.length*.95)]??0;
    const gpu=this.options.profile&&this.probe.gpu;
    this.readout.textContent=`CPU submission ${this.cpuMs.toFixed(1)} ms · frame median ${median.toFixed(1)} / p95 ${p95.toFixed(1)} ms · skipped ${this.gate.skipped} · queued ${this.gate.pending}. `+
      (gpu?['Selection','Binning','Raster','Sky/water','Composite','Screen copy'].map((label,i)=>`${label} ${gpu[i].toFixed(2)} ms`).join(' · '):this.options.profile?(this.probe.queries?'GPU sample pending.':'GPU timestamps unsupported.'):'GPU timing off.')+
      ' GPU boundaries include queue gaps; sampled profiling adds overhead.';
  }
  makeBuffer(size,usage,data){
    const b=this.device.createBuffer({size,usage});this.buffers.push(b);
    if(data)this.device.queue.writeBuffer(b,0,data);return b;
  }
  async init(){
    const module=this.device.createShaderModule({label:'Forest bitmask rasterization',code:{fast:forestFastWGSL,bounded:forestBoundedWGSL,reject:forestRejectWGSL,original:forestReferenceWGSL,owned:forestOwnedMaskWGSL,cached:forestRasterWGSL}[this.variant]});
    const info=await module.getCompilationInfo();
    const errors=info.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(e=>`Forest WGSL ${e.lineNum}: ${e.message}`).join('\n'));
    if(this.dispatchArgs){
      const dispatchModule=this.device.createShaderModule({label:'Visible cluster dispatch',code:forestDispatchWGSL});
      this.dispatchPipeline=await this.device.createComputePipelineAsync({layout:'auto',compute:{module:dispatchModule,entryPoint:'prepareDispatch'}});
      this.dispatchGroup=this.device.createBindGroup({layout:this.dispatchPipeline.getBindGroupLayout(0),entries:[this.uniform,this.control,this.dispatchArgs].map((buffer,binding)=>({binding,resource:{buffer}}))});
    }
    this.pipelines={};
    for(const entryPoint of ['clear','bin','raster'])this.pipelines[entryPoint]=await this.device.createComputePipelineAsync({
      label:`Forest bitmask ${entryPoint}`,layout:'auto',compute:{module,entryPoint}
    });
  }
  createTexture(format,type){
    const t=new THREE.StorageTexture(this.width,this.height);t.format=format;t.type=type;
    t.minFilter=THREE.NearestFilter;t.magFilter=THREE.NearestFilter;
    t.generateMipmaps=false;t.mipmapsAutoUpdate=false;
    this.renderer._textures.updateTexture(t);
    return t;
  }
  resize(){
    this.generation++;this.metrics=null;this.groups=null;
    const size=this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.width=size.x;this.height=size.y;this.tilesX=Math.ceil(this.width/8);this.tilesY=Math.ceil(this.height/8);
    if(this.heads){this.heads.destroy();this.entries.destroy();}
    for(const t of this.textures??[])t.dispose();this.quad?.material.dispose();
    // A global list pool, not a 32-candidate tile limit. Dense tiles consume
    // more batches. Pool exhaustion uses an exhaustive software scan.
    this.entryCapacity=Math.min(8_388_608,Math.floor(this.device.limits.maxStorageBufferBindingSize/8));
    if(this.variant!=='visibility'){
    this.heads=this.makeBuffer(this.tilesX*this.tilesY*(this.variant==='reject'?36:8),GPUBufferUsage.STORAGE);
    this.entries=this.makeBuffer(this.entryCapacity*8,GPUBufferUsage.STORAGE);
    }
    this.depth=this.createTexture(THREE.RedFormat,THREE.FloatType);
    this.ids=this.createTexture(THREE.RedIntegerFormat,THREE.UnsignedIntType);
    this.color=this.createTexture(THREE.RGBAFormat,THREE.HalfFloatType);
    this.textures=[this.depth,this.ids,this.color];
    const pixel=screenCoordinate.xy;
    const material=new THREE.NodeMaterial();
    material.colorNode=Fn(()=>{
      If(textureLoad(this.ids,pixel).r.equal(uint(0xffffffff)),()=>{Discard();});
      return textureLoad(this.color,pixel).rgb;
    })();
    material.depthNode=textureLoad(this.depth,pixel).r;
    material.depthTest=true;material.depthWrite=true;material.toneMapped=false;
    this.quad=new THREE.QuadMesh(material);
  }
  sharedBuffer(attribute){
    // Compute has already created these attributes and populated them this frame.
    const buffer=this.renderer.backend.get(attribute).buffer;
    if(!buffer)throw new Error('Forest bitmask input was not initialized by the geometry compute pass.');
    return buffer;
  }
  createGroups(){
    const entries=[{binding:0,resource:{buffer:this.uniform}}];
    this.forest.pipelines.forEach((p,i)=>{
      const base=1+i*4;
      for(const [offset,buffer] of [this.assets[i].vertices,this.assets[i].indices,
        this.sharedBuffer(p.instanceWorldAttribute),this.sharedBuffer(p.visibleClustersAttribute)].entries()){
        entries.push({binding:base+offset,resource:{buffer}});
      }
    });
    entries.push({binding:9,resource:{buffer:this.heads}},{binding:10,resource:{buffer:this.entries}},
      {binding:11,resource:{buffer:this.control}});
    this.textures.forEach((texture,i)=>entries.push({binding:12+i,resource:this.renderer.backend.get(texture).texture.createView()}));
    this.groups={
      clear:this.device.createBindGroup({layout:this.pipelines.clear.getBindGroupLayout(0),entries:entries.filter(e=>[0,9,11].includes(e.binding))}),
      bin:this.device.createBindGroup({layout:this.pipelines.bin.getBindGroupLayout(0),entries:entries.filter(e=>e.binding<=11)}),
      raster:this.device.createBindGroup({layout:this.pipelines.raster.getBindGroupLayout(0),entries})
    };
  }
  encodeVisibility(encoder,a,b){
    for(const name of ['clear','bin','raster']){
      if(name==='bin'&&this.dispatchArgs){
        const prepare=encoder.beginComputePass({label:'Visible cluster dispatch'});
        prepare.setPipeline(this.dispatchPipeline);prepare.setBindGroup(0,this.dispatchGroup);
        prepare.dispatchWorkgroups(1);prepare.end();
      }
      const pass=encoder.beginComputePass({label:`Forest bitmask ${name}`,timestampWrites:name==='bin'?this.probe.writes(2):name==='raster'?this.probe.writes(4):undefined});
      pass.setPipeline(this.pipelines[name]);pass.setBindGroup(0,this.groups[name]);
      if(name==='raster')pass.dispatchWorkgroups(this.tilesX,this.tilesY);
      else if(name==='clear')pass.dispatchWorkgroups(Math.ceil(Math.max(8,this.tilesX*this.tilesY)/64));
      else if(this.dispatchArgs)pass.dispatchWorkgroupsIndirect(this.dispatchArgs,0);
      else {const count=a.maxVisibleClusters+b.maxVisibleClusters;const width=Math.min(count,this.device.limits.maxComputeWorkgroupsPerDimension);pass.dispatchWorkgroups(width,Math.ceil(count/width));}
      pass.end();
    }
  }
  render(now){
    if(!this.groups)this.createGroups();
    const read=!this.reading&&now-this.lastReadback>=500;
    const f=new Float32Array(this.uniformBytes),u=new Uint32Array(this.uniformBytes);
    f.set(this.forest.terrain.projScreenMatrix.elements,0);
    f.set([...this.camera.position.toArray(),1],16);
    u.set([this.width,this.height,this.tilesX,this.tilesX*this.tilesY],20);
    const [a,b]=this.forest.pipelines;
    u.set([a.maxVisibleClusters,b.maxVisibleClusters,a.asset.indices.length,b.asset.indices.length],24);
    u.set([this.entryCapacity,{shaded:0,meshlets:1,lod:2,normals:3}[this.outputMode]??0,read?1:0,Math.min(a.maxVisibleClusters+b.maxVisibleClusters,this.device.limits.maxComputeWorkgroupsPerDimension)],28);
    this.device.queue.writeBuffer(this.uniform,0,this.uniformBytes);
    const encoder=this.device.createCommandEncoder({label:'Forest bitmask frame'});
    encoder.copyBufferToBuffer(this.sharedBuffer(a.visibleCountAttribute),0,this.control,0,4);
    encoder.copyBufferToBuffer(this.sharedBuffer(b.visibleCountAttribute),0,this.control,4,4);
    this.encodeVisibility(encoder,a,b);
    if(read)encoder.copyBufferToBuffer(this.control,0,this.readback,0,64);
    this.device.queue.submit([encoder.finish()]);
    if(read)this.readStats(now);
    // Keep the existing lake and sky. Forest geometry has no hardware draw.
    const r=this.renderer;
    const direct=this.options.direct;
    if(this.quad.material.toneMapped!==direct){this.quad.material.toneMapped=direct;this.quad.material.needsUpdate=true;}
    this.probe.mark(6);
    r.setRenderTarget(direct?null:a.sceneTarget);if(!r.autoClear)r.clear();r.render(a.scene,this.camera);
    this.probe.mark(7);this.probe.mark(8);
    const autoClear=r.autoClear;
    try{r.autoClear=false;this.quad.render(r);}finally{r.autoClear=autoClear;}
    this.probe.mark(9);this.probe.mark(10);
    if(!direct){r.setRenderTarget(null);a.blitQuad.render(r);}
    this.probe.mark(11);this.probe.finish();
    // Pace submissions without blocking the JS thread or accumulating an
    // unbounded queue of expensive software frames on slower devices. Queue
    // writes and GPU copies stay ordered after earlier frame consumers.
    // A mapped diagnostics buffer is never reused until its map completes.
    this.gate.track(this.device.queue.onSubmittedWorkDone());
    const submitted=performance.now();this.cpuMs=submitted-this.cpuStart;
    if(this.lastSubmit!==null&&submitted-this.lastSubmit<1000){this.intervals.push(submitted-this.lastSubmit);if(this.intervals.length>120)this.intervals.shift();}
    this.lastSubmit=submitted;if(read)this.updateReadout();
  }
  readStats(now){
    this.reading=true;this.lastReadback=now;const generation=this.generation;
    this.readback.mapAsync(GPUMapMode.READ).then(()=>{
      const counters=new Uint32Array(this.readback.getMappedRange()).slice();this.readback.unmap();
      if(!this.disposed&&generation===this.generation)this.metrics={
        work:this.variant==='reject'?{candidates:counters[6],edgeRejected:counters[7],depthRejected:counters[8],samples:counters[9],wins:counters[10],resolves:counters[11],rasterCandidates:counters[12]}:null,
        variant:rasterVariantLabels[this.variant],entries:Math.min(counters[2],this.entryCapacity),capacity:this.entryCapacity,
        overflowTiles:counters[3],covered:counters[4],batches:counters[5],width:this.width,height:this.height
      };
    }).catch(error=>{if(!this.disposed)console.warn('Forest bitmask statistics unavailable:',error);})
      .finally(()=>{this.reading=false;if(this.disposed)this.readback.destroy();});
  }
  dispose(){
    this.disposed=true;this.generation++;this.panel?.remove();this.probe.dispose();
    for(const b of this.buffers)if(b!==this.readback||!this.reading)b.destroy();
    for(const t of this.textures)t.dispose();this.quad.material.dispose();
  }
}
