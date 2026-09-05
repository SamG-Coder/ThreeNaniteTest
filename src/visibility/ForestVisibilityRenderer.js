import {landscapeVisibilityWGSL} from './landscapeShaders.js';
import { ForestBitmaskRenderer } from '../bitmask/ForestBitmaskRenderer.js';
import { visibilityWGSL, cullWGSL, pyramidWGSL, pyramidBaseWGSL } from './shaders.js';

// Hardware depth/ID rasterization, current-frame HZB recovery, atomic coverage
// and stable winning-cluster bitsets. Uses Three's existing selection and output.
export class ForestVisibilityRenderer extends ForestBitmaskRenderer {
  constructor(forest){
    super(forest,'visibility');
    const [a,b]=forest.pipelines;
    this.terrainWords=Math.ceil(a.asset.totalClusters*a.instanceCount/32);
    this.historyWords=this.terrainWords+Math.ceil(b.asset.totalClusters*b.instanceCount/32);
    this.config=this.makeBuffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.layoutBuffer=this.makeBuffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.dimensions=this.makeBuffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.argumentsBuffer=this.makeBuffer(44,GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT);
    this.bounds=forest.pipelines.map(p=>this.makeBuffer(p.asset.clusterBounds.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,p.asset.clusterBounds));
    this.seedList=this.makeBuffer((a.maxVisibleClusters+b.maxVisibleClusters)*4,GPUBufferUsage.STORAGE);
    this.recoveryList=this.makeBuffer((a.maxVisibleClusters+b.maxVisibleClusters)*4,GPUBufferUsage.STORAGE);
    this.hzbEnabled=true;this.allocateHistory();
    const label=document.createElement('label');label.className='field';label.textContent='Cluster HZB + atomic coverage';
    const toggle=document.createElement('input');toggle.type='checkbox';toggle.checked=true;
    toggle.onchange=()=>{this.hzbEnabled=toggle.checked;this.resetHistory=true;};label.append(toggle);this.panel.prepend(label);
    this.panel.querySelector('h2').textContent='Visibility experiments';
  }
  allocateHistory(){
    this.atomicBits?.destroy();
    this.atomicBits=this.makeBuffer((this.historyWords+this.tilesX*this.tilesY*2)*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(this.layoutBuffer,0,new Uint32Array([this.historyWords,this.tilesX*this.tilesY*2,0,0]));
    this.device.queue.writeBuffer(this.dimensions,0,new Uint32Array([this.width,this.height,this.historyWords,this.tilesX]));
    this.resetHistory=true;this.groups=null;
  }
  resize(){
    super.resize();this.hardwareDepth?.destroy();this.hzb?.destroy();
    this.hardwareDepth=this.device.createTexture({size:[this.width,this.height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.pyramidSize=2**Math.ceil(Math.log2(Math.max(this.width,this.height)));
    this.pyramidLevels=Math.log2(this.pyramidSize)+1;
    this.hzb=this.device.createTexture({size:[this.pyramidSize,this.pyramidSize],mipLevelCount:this.pyramidLevels,format:'r32float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
    if(this.layoutBuffer)this.allocateHistory();
  }
  get geometryWGSL(){return this.forest.landscapeTexture?landscapeVisibilityWGSL:visibilityWGSL;}
  async init(){
    if(this.forest.landscapeTexture){this.renderer._textures.updateTexture(this.forest.landscapeTexture);this.materialSampler=this.device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});}
    const module=this.device.createShaderModule({code:this.geometryWGSL,label:'Forest visibility'});
    const compilation=await module.getCompilationInfo();
    const errors=compilation.messages.filter(message=>message.type==='error');
    if(errors.length)throw new Error(errors.map(message=>`Forest visibility WGSL ${message.lineNum}:${message.linePos}: ${message.message}`).join('\n'));
    this.visibilityPipeline=await this.device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertexMain'},fragment:{module,entryPoint:'fragmentMain',targets:[{format:'r32uint'}]},primitive:{topology:'triangle-list',cullMode:'back',frontFace:'ccw'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less'}});
    this.compute={};
    for(const [code,names] of [[this.geometryWGSL,['coverage','shadeVisible']],[cullWGSL,['clearFrame','clearHistory','arguments','seed','recover']],[pyramidWGSL,['reduce']],[pyramidBaseWGSL,['base']]]){
      const m=this.device.createShaderModule({code});
      for(const entryPoint of names)this.compute[entryPoint]=await this.device.createComputePipelineAsync({layout:'auto',compute:{module:m,entryPoint}});
    }
  }
  createGroups(){
    const resource=buffer=>({buffer});
    const common={0:resource(this.uniform),10:resource(this.atomicBits),11:resource(this.control),12:resource(this.config),17:resource(this.layoutBuffer)};
    this.forest.pipelines.forEach((p,i)=>{
      const base=1+i*4;
      [this.assets[i].vertices,this.assets[i].indices,this.sharedBuffer(p.instanceWorldAttribute),this.sharedBuffer(p.visibleClustersAttribute)].forEach((b,j)=>common[base+j]=resource(b));
    });
    const view=t=>this.renderer.backend.get(t).texture.createView();
    const geometry={...common,13:view(this.ids),14:this.hardwareDepth.createView(),15:view(this.color),16:view(this.depth)};
    const cull={...common,1:resource(this.bounds[0]),2:resource(this.bounds[1]),18:resource(this.seedList),19:resource(this.recoveryList),20:this.hzb.createView(),21:resource(this.argumentsBuffer)};
    const group=(pipeline,entries,indices)=>this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:indices.map(binding=>({binding,resource:entries[binding]}))});
    this.groups={};
    for(const [name,ids] of Object.entries({clearFrame:[10,11,17],clearHistory:[10,17],arguments:[0,11,21],seed:[0,4,8,10,11,12,18],recover:[0,1,2,3,4,7,8,10,11,12,19,20]}))this.groups[name]=group(this.compute[name],cull,ids);
    this.groups.coverage=group(this.compute.coverage,geometry,[0,10,13,17]);
    const materialBindings=this.materialSampler?[22,23]:[];
    if(this.materialSampler){geometry[22]=view(this.forest.landscapeTexture);geometry[23]=this.materialSampler;}
    this.groups.shadeVisible=group(this.compute.shadeVisible,geometry,[0,1,2,3,4,5,6,7,8,10,11,12,13,14,15,16,...materialBindings]);
    this.drawGroups=[this.seedList,this.recoveryList].map(list=>group(this.visibilityPipeline,{...common,9:resource(list)},[0,1,2,3,4,5,6,7,8,9]));
    this.groups.base=group(this.compute.base,{0:this.hardwareDepth.createView(),1:this.hzb.createView({baseMipLevel:0,mipLevelCount:1}),2:resource(this.atomicBits),3:resource(this.dimensions)},[0,1,2,3]);
    this.reduceGroups=Array.from({length:this.pyramidLevels-1},(_,i)=>group(this.compute.reduce,{0:this.hzb.createView({baseMipLevel:i,mipLevelCount:1}),1:this.hzb.createView({baseMipLevel:i+1,mipLevelCount:1})},[0,1]));
  }
  encodeVisibility(encoder,a,b){
    this.device.queue.writeBuffer(this.config,0,new Uint32Array([a.asset.totalClusters,b.asset.totalClusters,this.terrainWords,this.hzbEnabled?1:0]));
    const dispatch=(name,x,y=1,group=this.groups[name],indirect=false)=>{
      const p=encoder.beginComputePass({label:`Forest visibility ${name}`});p.setPipeline(this.compute[name]);p.setBindGroup(0,group);
      if(indirect)p.dispatchWorkgroupsIndirect(this.argumentsBuffer,32);else p.dispatchWorkgroups(x,y);p.end();
    };
    const draw=(phase)=>{
      this.beforeVisibilityDraw?.(encoder,phase);
      const p=encoder.beginRenderPass({label:phase?'Visibility recovery':'Visibility seed',colorAttachments:[{view:this.renderer.backend.get(this.ids).texture.createView(),clearValue:{r:0xffffffff,g:0,b:0,a:0},loadOp:phase?'load':'clear',storeOp:'store'}],depthStencilAttachment:{view:this.hardwareDepth.createView(),depthClearValue:1,depthLoadOp:phase?'load':'clear',depthStoreOp:'store'}});
      p.setPipeline(this.visibilityPipeline);p.setBindGroup(0,this.drawGroups[phase]);p.drawIndirect(this.argumentsBuffer,phase*16);p.end();
    };
    const mark=index=>{if(this.probe.active){const p=encoder.beginComputePass({timestampWrites:{querySet:this.probe.queries,beginningOfPassWriteIndex:index}});p.end();}};
    mark(2);
    dispatch('clearFrame',Math.ceil(Math.max(16,this.tilesX*this.tilesY*2)/64));
    if(this.resetHistory){dispatch('clearHistory',Math.ceil(this.historyWords/64));this.resetHistory=false;}
    dispatch('arguments',1);dispatch('seed',0,1,this.groups.seed,true);dispatch('arguments',1);draw(0);
    // Seed geometry is rendered with this frame's camera. Previous visibility
    // only chooses the seed list; stale depth never rejects current geometry.
    dispatch('coverage',this.tilesX,this.tilesY);
    dispatch('base',Math.ceil(this.pyramidSize/8),Math.ceil(this.pyramidSize/8));
    for(let i=0;i<this.reduceGroups.length;i++){const size=this.pyramidSize/2**(i+1);dispatch('reduce',Math.ceil(size/8),Math.ceil(size/8),this.reduceGroups[i]);}
    dispatch('recover',0,1,this.groups.recover,true);dispatch('arguments',1);draw(1);mark(3);
    mark(4);dispatch('clearHistory',Math.ceil(this.historyWords/64));
    dispatch('shadeVisible',this.tilesX,this.tilesY);mark(5);
  }
  readStats(now){
    this.reading=true;this.lastReadback=now;const generation=this.generation;
    this.readback.mapAsync(GPUMapMode.READ).then(()=>{
      const c=new Uint32Array(this.readback.getMappedRange()).slice();this.readback.unmap();
      if(!this.disposed&&generation===this.generation)this.metrics={visibility:true,variant:'hardware visibility + atomic HZB',selected:c[0]+c[1],seed:c[2],recovery:c[3],culled:c[5],covered:c[4],submittedTriangles:(c[2]+c[3])*64,overflowTiles:0};
    }).catch(e=>{if(!this.disposed)console.warn('Visibility statistics unavailable',e);}).finally(()=>{this.reading=false;if(this.disposed)this.readback.destroy();});
  }
  updateReadout(){
    super.updateReadout();
    if(this.readout)this.readout.textContent=this.readout.textContent.replace('Binning','Visibility + HZB').replace('Raster','Final shading');
  }
  dispose(){this.hardwareDepth?.destroy();this.hzb?.destroy();super.dispose();}
}
