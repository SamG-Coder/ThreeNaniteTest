import * as THREE from 'three/webgpu';
import { Discard, Fn, If, screenCoordinate, textureLoad, uint } from 'three/tsl';
import { forestRasterWGSL } from './forestShaders.js';

// Uses the pinned Three 0.185.1 backend to share GPU-selected meshlet lists.
// Geometry visibility and color are computed here; Three presents the output
// and renders the ordinary sky/lake against the computed forest depth.
export class ForestBitmaskRenderer {
  constructor(forest) {
    this.forest=forest;this.renderer=forest.terrain.renderer;this.camera=forest.terrain.camera;
    this.device=this.renderer.backend.device;this.outputMode='shaded';this.disposed=false;
    this.lastReadback=-Infinity;this.reading=false;this.busy=false;this.generation=0;
    this.metrics=null;this.buffers=[];
    this.uniformBytes=new ArrayBuffer(128);
    this.uniform=this.makeBuffer(128,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
    this.control=this.makeBuffer(32,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC);
    this.readback=this.makeBuffer(32,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
    this.assets=forest.pipelines.map(p=>{
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
    this.resize();
  }
  makeBuffer(size,usage,data){
    const b=this.device.createBuffer({size,usage});this.buffers.push(b);
    if(data)this.device.queue.writeBuffer(b,0,data);return b;
  }
  async init(){
    const module=this.device.createShaderModule({label:'Forest bitmask rasterization',code:forestRasterWGSL});
    const info=await module.getCompilationInfo();
    const errors=info.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(e=>`Forest WGSL ${e.lineNum}: ${e.message}`).join('\n'));
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
    this.heads=this.makeBuffer(this.tilesX*this.tilesY*8,GPUBufferUsage.STORAGE);
    this.entries=this.makeBuffer(this.entryCapacity*8,GPUBufferUsage.STORAGE);
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
  render(now){
    if(!this.groups)this.createGroups();
    const f=new Float32Array(this.uniformBytes),u=new Uint32Array(this.uniformBytes);
    f.set(this.forest.terrain.projScreenMatrix.elements,0);
    f.set([...this.camera.position.toArray(),1],16);
    u.set([this.width,this.height,this.tilesX,this.tilesX*this.tilesY],20);
    const [a,b]=this.forest.pipelines;
    u.set([a.maxVisibleClusters,b.maxVisibleClusters,a.asset.indices.length,b.asset.indices.length],24);
    u.set([this.entryCapacity,{shaded:0,meshlets:1,lod:2,normals:3}[this.outputMode]??0,0,0],28);
    this.device.queue.writeBuffer(this.uniform,0,this.uniformBytes);
    const encoder=this.device.createCommandEncoder({label:'Forest bitmask frame'});
    encoder.copyBufferToBuffer(this.sharedBuffer(a.visibleCountAttribute),0,this.control,0,4);
    encoder.copyBufferToBuffer(this.sharedBuffer(b.visibleCountAttribute),0,this.control,4,4);
    for(const name of ['clear','bin','raster']){
      const pass=encoder.beginComputePass({label:`Forest bitmask ${name}`});
      pass.setPipeline(this.pipelines[name]);pass.setBindGroup(0,this.groups[name]);
      if(name==='raster')pass.dispatchWorkgroups(this.tilesX,this.tilesY);
      else pass.dispatchWorkgroups(name==='clear'?Math.ceil(Math.max(8,this.tilesX*this.tilesY)/64):a.maxVisibleClusters+b.maxVisibleClusters);
      pass.end();
    }
    const read=!this.reading&&now-this.lastReadback>=500;
    if(read)encoder.copyBufferToBuffer(this.control,0,this.readback,0,32);
    this.device.queue.submit([encoder.finish()]);
    if(read)this.readStats(now);
    // Keep the existing lake and sky. Forest geometry has no hardware draw.
    const r=this.renderer;
    r.setRenderTarget(a.sceneTarget);r.clear();r.render(a.scene,this.camera);
    const autoClear=r.autoClear;
    try{r.autoClear=false;this.quad.render(r);}finally{r.autoClear=autoClear;}
    r.setRenderTarget(null);a.blitQuad.render(r);
    // Pace submissions without blocking the JS thread or accumulating an
    // unbounded queue of expensive software frames on slower devices.
    this.busy=true;
    this.device.queue.onSubmittedWorkDone().then(()=>{this.busy=false;})
      .catch(()=>{this.busy=false;});
  }
  readStats(now){
    this.reading=true;this.lastReadback=now;const generation=this.generation;
    this.readback.mapAsync(GPUMapMode.READ).then(()=>{
      const counters=new Uint32Array(this.readback.getMappedRange()).slice();this.readback.unmap();
      if(!this.disposed&&generation===this.generation)this.metrics={
        entries:Math.min(counters[2],this.entryCapacity),capacity:this.entryCapacity,
        overflowTiles:counters[3],covered:counters[4],batches:counters[5],width:this.width,height:this.height
      };
    }).catch(error=>{if(!this.disposed)console.warn('Forest bitmask statistics unavailable:',error);})
      .finally(()=>{this.reading=false;if(this.disposed)this.readback.destroy();});
  }
  dispose(){
    this.disposed=true;this.generation++;
    for(const b of this.buffers)if(b!==this.readback||!this.reading)b.destroy();
    for(const t of this.textures)t.dispose();this.quad.material.dispose();
  }
}
