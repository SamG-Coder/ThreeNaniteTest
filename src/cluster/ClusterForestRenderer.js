import {ClusterLighting,litBrickWGSL} from '../lighting/ClusterLighting.js';
import * as THREE from 'three/webgpu';
import {ForestStreamingRenderer} from '../streaming/ForestStreamingRenderer.js';
import {ForestVisibilityRenderer} from '../visibility/ForestVisibilityRenderer.js';
import {GeometryCache} from './GeometryCache.js';
import {pageLayout} from '../streaming/pages.js';
import {brickVisibilityWGSL} from './brickShaders.js';
import {brickBinWGSL} from './binShaders.js';
import {clusterSelectionWGSL} from './selectionShaders.js';
export class ClusterForestRenderer extends ForestStreamingRenderer{
 resize(){super.resize();this.visibilitySignature=null;this.rayLighting?.resize();}
 get geometryWGSL(){return litBrickWGSL;}
 get shadeBindings(){return [30,31];}
 extendShadeResources(resources){resources[30]=this.renderer.backend.get(this.rayLighting.shadow).texture.createView();resources[31]={buffer:this.rayLighting.flags};}
 dispose(){this.rayLighting?.dispose();super.dispose();}
 createAssets(){
  this.residencyRevision=0;this.selectionRuns=0;this.visibilityRuns=0;this.pagers=[];this.raw=new Map();this.requestPending=false;this.lastDemand=-Infinity;this.totalUploadBytes=0;this.frameUploadBytes=0;
  return this.forest.pipelines.map(p=>{
   const layout=pageLayout(p.asset),size=id=>Math.ceil(p.asset.pageWords[id]/64)*256;
   const pinned=layout.pinned.reduce((n,i)=>n+size(i),0),largest=Math.max(...layout.units.map(u=>u.pages.reduce((n,i)=>n+size(i),0)));
   const bytes=Math.max(32*1048576,pinned+largest*2);
   if(bytes>this.device.limits.maxStorageBufferBindingSize)throw Error('Cluster geometry cache exceeds device limits; choose lower density');
   const vertices=this.makeBuffer(bytes,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),indices=this.makeBuffer(p.asset.totalClusters*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),table=new Uint32Array(p.asset.totalClusters*4);
   const metadata=this.makeBuffer(p.asset.groupLods.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,p.asset.groupLods);
   let dirty=true;const dirtyNodes=new Set();
   const pager=new GeometryCache(p.asset,bytes/4,(cluster,offset,page)=>{
    this.device.queue.writeBuffer(vertices,offset*4,page);table.set([offset,0,p.asset.clusterLod[cluster],p.asset.clusterKinds[cluster]],cluster*4);this.device.queue.writeBuffer(indices,cluster*16,table.subarray(cluster*4,cluster*4+4));
   },id=>{if(id===undefined)dirty=true;else dirtyNodes.add(id);this.residencyRevision++;});
   const flush=()=>{const table=pager.metadata();if(dirty){this.device.queue.writeBuffer(metadata,0,table);dirty=false;}else for(const id of dirtyNodes)this.device.queue.writeBuffer(metadata,(id*24+5)*4,table.buffer,table.byteOffset+(id*24+5)*4,4);dirtyNodes.clear();};
   const demand=this.makeBuffer(p.asset.groupCount*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
   flush();this.pagers.push({pager,p,flush,demand,metadata,bytes});return{vertices,indices};
  });
 }
 sharedBuffer(attribute){return this.raw.get(attribute)??super.sharedBuffer(attribute);}
 async init(){
  this.rayLighting=new ClusterLighting(this);await this.rayLighting.init();
  if(this.forest.world.landscape)this.forest.connectWaterLighting(this.rayLighting.waterHooks());
  await ForestVisibilityRenderer.prototype.init.call(this);
  const module=this.device.createShaderModule({code:brickVisibilityWGSL});
  this.brickPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'brickVertex'},fragment:{module,entryPoint:'brickFragment',targets:[{format:'r32uint'},{format:'rg32float'}]},primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
  this.inverse=this.makeBuffer(64,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  const capacity=this.forest.pipelines.reduce((n,p)=>n+p.maxVisibleClusters,0);
  this.triangleBin=this.makeBuffer(capacity*4,GPUBufferUsage.STORAGE);this.brickBin=this.makeBuffer(capacity*4,GPUBufferUsage.STORAGE);this.binArgs=this.makeBuffer(32,GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT);
  const binModule=this.device.createShaderModule({code:brickBinWGSL});this.binPipelines={};
  for(const entryPoint of ['clearBins','binGeometry'])this.binPipelines[entryPoint]=await this.device.createComputePipelineAsync({layout:'auto',compute:{module:binModule,entryPoint}});
  const sm=this.device.createShaderModule({code:clusterSelectionWGSL});this.selection={};
  for(const entryPoint of ['initialize','prepareLevel','advanceLevel','traverse'])this.selection[entryPoint]=await this.device.createComputePipelineAsync({layout:'auto',compute:{module:sm,entryPoint}});
  this.selectionResources=this.forest.pipelines.map((p,i)=>{
   const queueCapacity=Math.max(p.instanceCount,p.asset.queueWidth*p.instanceCount),usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
   if(queueCapacity*8>this.device.limits.maxStorageBufferBindingSize||Math.ceil(queueCapacity/64)>this.device.limits.maxComputeWorkgroupsPerDimension)throw Error('Cluster traversal exceeds device limits');
   const own=(attribute,bytes)=>{const buffer=this.makeBuffer(bytes,usage);this.raw.set(attribute,buffer);return buffer;};
   const worlds=own(p.instanceWorldAttribute,p.instanceCount*64),selected=own(p.visibleClustersAttribute,p.maxVisibleClusters*8),visible=own(p.visibleCountAttribute,4),demand=own(p.lodCounterAttribute,(p.asset.groupCount+6)*4);
   const bounds=new Float32Array(p.asset.groupBounds.length+p.asset.clusterBounds.length);bounds.set(p.asset.groupBounds);bounds.set(p.asset.clusterBounds,p.asset.groupBounds.length);
   const resources={0:this.uniform,1:this.pagers[i].metadata,2:this.makeBuffer(bounds.byteLength,usage,bounds),3:this.makeBuffer(p.instanceDataAttribute.array.byteLength,usage,p.instanceDataAttribute.array),4:worlds,7:this.makeBuffer(32,usage|GPUBufferUsage.INDIRECT),8:selected,9:visible,10:demand,11:this.makeBuffer(128,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)};
   const queues=[this.makeBuffer(queueCapacity*8,usage),this.makeBuffer(queueCapacity*8,usage)];
   const bg=(name,ids,phase=0)=>this.group(this.selection[name],{...resources,5:queues[phase],6:queues[1-phase]},ids);
   return{p,resources,indirect:this.makeBuffer(12,GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST),queueCapacity,initialize:bg('initialize',[3,4,5,7,9,10,11]),prepare:bg('prepareLevel',[7,11]),advance:bg('advanceLevel',[7]),traverse:[0,1].map(phase=>bg('traverse',[0,1,2,3,4,5,6,7,8,9,10,11],phase))};
  });
  this.panel.querySelector('h2').textContent='Triangle / voxel-brick visibility';
 }
 group(pipeline,resources,ids){return this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:ids.map(binding=>({binding,resource:resources[binding] instanceof GPUBuffer?{buffer:resources[binding]}:resources[binding]}))});}
 createGroups(){
  ForestVisibilityRenderer.prototype.createGroups.call(this);
  const resources={0:this.uniform,9:this.triangleBin,11:this.control,25:this.inverse,26:this.triangleBin,27:this.brickBin,28:this.binArgs};
  this.forest.pipelines.forEach((p,i)=>{[this.assets[i].vertices,this.assets[i].indices,this.sharedBuffer(p.instanceWorldAttribute),this.sharedBuffer(p.visibleClustersAttribute)].forEach((v,j)=>resources[1+i*4+j]=v);});
  this.binClear=this.group(this.binPipelines.clearBins,resources,[28]);
  this.binGroups=[this.seedList,this.recoveryList].map((list,phase)=>{const uniform=this.makeBuffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,new Uint32Array([phase,0,0,0]));return this.group(this.binPipelines.binGeometry,{...resources,9:list,29:uniform},[0,2,4,6,8,9,11,26,27,28,29]);});
  this.triangleDraw=this.group(this.visibilityPipeline,resources,[0,1,2,3,4,5,6,7,8,9]);
  this.brickDraw=this.group(this.brickPipeline,{...resources,9:this.brickBin},[0,1,2,3,4,5,6,7,8,9,25]);
 }
 prepare(now){
  if(this.busy){this.gate.skipped++;this.updateReadout();return false;}
  this.cpuStart=performance.now();this.probe.begin(now,this.options.profile);this.probe.mark(0);
  let budget=256*1024;this.frameUploadBytes=0;
  for(const {pager,flush}of this.pagers){const used=pager.tick(budget);budget-=used;this.frameUploadBytes+=used;flush();}this.totalUploadBytes+=this.frameUploadBytes;
  for(const p of this.forest.pipelines)p.updateCameraUniforms();
  const f=new Float32Array(this.uniformBytes),u=new Uint32Array(this.uniformBytes);f.set(this.forest.terrain.projScreenMatrix.elements);f.set([...this.camera.position.toArray(),1],16);u.set([this.width,this.height,this.tilesX,this.tilesX*this.tilesY],20);u.set([0,0,0,65535],28);this.device.queue.writeBuffer(this.uniform,0,this.uniformBytes);
  const inverse=new THREE.Matrix4().copy(this.forest.terrain.projScreenMatrix).invert();this.device.queue.writeBuffer(this.inverse,0,new Float32Array(inverse.elements));
  const signature=[...this.forest.terrain.projScreenMatrix.elements,this.width,this.height,this.residencyRevision,...this.forest.pipelines.map(p=>p.fullGeometry?0:p.settings.lodThreshold)].join(',');
  if(signature===this.selectionSignature){this.probe.mark(1);this.wantDemand=this.demandDirty&&!this.requestPending&&now-this.lastDemand>=50;if(this.wantDemand)this.demandDirty=false;return true;}
  this.selectionSignature=signature;this.selectionRuns++;this.demandDirty=true;
  const encoder=this.device.createCommandEncoder({label:'GPU cluster traversal'});
  for(const s of this.selectionResources){
   const p=s.p,bytes=new ArrayBuffer(128),f=new Float32Array(bytes),u=new Uint32Array(bytes);
   p.frustum.planes.forEach((plane,i)=>f.set([...plane.normal.toArray(),plane.constant],i*4));u.set([p.instanceCount,s.queueCapacity,p.asset.groupCount,p.maxVisibleClusters],24);f.set([this.camera.projectionMatrix.elements[5]*this.height*.5,p.fullGeometry?0:p.settings.lodThreshold,0,0],28);this.device.queue.writeBuffer(s.resources[11],0,bytes);
   const pass=(name,group,x,indirect=false)=>{const pass=encoder.beginComputePass({label:`Cluster ${name}`});pass.setPipeline(this.selection[name]);pass.setBindGroup(0,group);if(indirect)pass.dispatchWorkgroupsIndirect(s.indirect,0);else pass.dispatchWorkgroups(x);pass.end();};
   pass('initialize',s.initialize,Math.ceil(Math.max(p.instanceCount,p.asset.groupCount+6)/64));
   for(let level=0;level<p.asset.hierarchyDepth;level++){pass('prepareLevel',s.prepare,1);encoder.copyBufferToBuffer(s.resources[7],8,s.indirect,0,12);pass('traverse',s.traverse[level%2],0,true);pass('advanceLevel',s.advance,1);}
  }
  this.device.queue.submit([encoder.finish()]);this.probe.mark(1);this.wantDemand=!this.requestPending&&now-this.lastDemand>=50;if(this.wantDemand)this.demandDirty=false;return true;
 }
 encodeVisibility(encoder,a,b){
  const signature=`${this.selectionRuns}:${this.outputMode}:${this.hzbEnabled}:${this.rayLighting.revision}`;
  this.visibilityReused=signature===this.visibilitySignature&&!this.resetHistory;
  if(this.visibilityReused){if(this.wantDemand)for(const {p,demand}of this.pagers)encoder.copyBufferToBuffer(this.sharedBuffer(p.lodCounterAttribute),24,demand,0,p.asset.groupCount*4);return;}
  this.visibilitySignature=signature;this.visibilityRuns++;
  this.device.queue.writeBuffer(this.config,0,new Uint32Array([a.asset.totalClusters,b.asset.totalClusters,this.terrainWords,this.hzbEnabled?1:0]));
  const dispatch=(name,x,y=1,group=this.groups[name],indirect=false)=>{const p=encoder.beginComputePass({label:name});p.setPipeline(this.compute[name]);p.setBindGroup(0,group);if(indirect)p.dispatchWorkgroupsIndirect(this.argumentsBuffer,32);else p.dispatchWorkgroups(x,y);p.end();};
  const draw=phase=>{
   for(const [name,group]of [['clearBins',this.binClear],['binGeometry',this.binGroups[phase]]]){const p=encoder.beginComputePass({label:name});p.setPipeline(this.binPipelines[name]);p.setBindGroup(0,group);if(name==='clearBins')p.dispatchWorkgroups(1);else p.dispatchWorkgroupsIndirect(this.argumentsBuffer,32);p.end();}
   const p=encoder.beginRenderPass({label:phase?'Cluster recovery':'Cluster seed',colorAttachments:[{view:this.renderer.backend.get(this.ids).texture.createView(),clearValue:{r:0xffffffff,g:0,b:0,a:0},loadOp:phase?'load':'clear',storeOp:'store'},{view:this.barycentrics.createView(),clearValue:{r:0,g:0,b:0,a:0},loadOp:phase?'load':'clear',storeOp:'store'}],depthStencilAttachment:{view:this.hardwareDepth.createView(),depthClearValue:1,depthLoadOp:phase?'load':'clear',depthStoreOp:'store'}});
   p.setPipeline(this.visibilityPipeline);p.setBindGroup(0,this.triangleDraw);p.drawIndirect(this.binArgs,0);p.setPipeline(this.brickPipeline);p.setBindGroup(0,this.brickDraw);p.drawIndirect(this.binArgs,16);p.end();
  };
  dispatch('clearFrame',Math.ceil(Math.max(16,this.tilesX*this.tilesY*2)/64));if(this.resetHistory){dispatch('clearHistory',Math.ceil(this.historyWords/64));this.resetHistory=false;}
  dispatch('arguments',1);dispatch('seed',0,1,this.groups.seed,true);dispatch('arguments',1);draw(0);dispatch('coverage',this.tilesX,this.tilesY);dispatch('base',Math.ceil(this.pyramidSize/8),Math.ceil(this.pyramidSize/8));
  for(let i=0;i<this.reduceGroups.length;i++){const size=this.pyramidSize/2**(i+1);dispatch('reduce',Math.ceil(size/8),Math.ceil(size/8),this.reduceGroups[i]);}
  dispatch('recover',0,1,this.groups.recover,true);dispatch('arguments',1);draw(1);dispatch('clearHistory',Math.ceil(this.historyWords/64));this.rayLighting.encode(encoder);dispatch('shadeVisible',this.tilesX,this.tilesY);
  this.selectionResources.forEach((s,i)=>encoder.copyBufferToBuffer(s.resources[7],28,this.control,32+i*4,4));
  if(this.wantDemand)for(const {p,demand}of this.pagers)encoder.copyBufferToBuffer(this.sharedBuffer(p.lodCounterAttribute),24,demand,0,p.asset.groupCount*4);
 }
 readStats(now){
  this.reading=true;this.lastReadback=now;const generation=this.generation;
  this.readback.mapAsync(GPUMapMode.READ).then(()=>{const c=new Uint32Array(this.readback.getMappedRange()).slice();this.readback.unmap();if(this.disposed||generation!==this.generation)return;
   const sum=fn=>this.forest.pipelines.reduce((s,p)=>s+fn(p),0);
   this.metrics={visibility:true,reused:this.visibilityReused,lighting:{shadows:this.rayLighting.shadows,reflections:this.rayLighting.reflections,rays:c[10]+c[11],limited:c[12]},variant:'triangle / sparse-brick hierarchy',seed:c[2],recovery:c[3],culled:c[5],covered:c[4],triangleClusters:c[6],brickClusters:c[7],submittedTriangles:c[6]*64,streaming:{bytes:this.pagers.reduce((s,p)=>s+p.bytes,0),pages:this.pagers.reduce((s,p)=>s+p.pager.mapping.size,0)},overflowTiles:0};
   this.forest.onStats({naniteEnabled:true,sourceTriangles:sum(p=>p.asset.sourceTriangleCount),sourceSceneTriangles:sum(p=>p.asset.sourceTriangleCount*p.instanceCount),submittedTriangles:c[6]*64,visibleMeshlets:c[2]+c[3],capacity:sum(p=>p.maxVisibleClusters),instances:sum(p=>p.instanceCount),groups:sum(p=>p.asset.groupCount),assetBytes:sum(p=>p.asset.bytes),lockedVertices:0,overflowed:Boolean(c[8]||c[9]),lodCounts:[c[6],c[7],0,0,0,0],bitmask:this.metrics});
  }).catch(e=>{if(!this.disposed)console.warn(e);}).finally(()=>{this.reading=false;if(this.disposed)this.readback.destroy();});
 }
}
