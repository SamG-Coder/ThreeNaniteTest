import { ForestVisibilityRenderer } from '../visibility/ForestVisibilityRenderer.js';
import { PAGE_WORDS, packPage, pageLayout, PageCache } from './pages.js';
import { pagedVisibilityWGSL } from './shaders.js';

export class ForestStreamingRenderer extends ForestVisibilityRenderer {
  get geometryWGSL(){return pagedVisibilityWGSL;}
  createAssets(){
    this.pagers=[];this.requestPending=false;this.lastDemand=-Infinity;
    this.frameUploadBytes=0;this.totalUploadBytes=0;
    return this.forest.pipelines.map(p=>{
      const layout=pageLayout(p.asset);
      // A bounded GPU cache, with a guaranteed complete fallback and room for
      // at least one replacement unit. Procedural source remains in CPU memory.
      const minimum=layout.pinned.length+Math.max(0,...layout.units.map(u=>u.pages.length));
      const slots=Math.min(p.asset.totalClusters,Math.max(minimum,Math.floor(8*1024*1024/(PAGE_WORDS*4))));
      if(slots*PAGE_WORDS*4>this.device.limits.maxStorageBufferBindingSize)throw new Error('Pinned geometry exceeds the device page-cache limit');
      const vertices=this.makeBuffer(slots*PAGE_WORDS*4,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
      const table=new Uint32Array(p.asset.totalClusters*4);
      const indices=this.makeBuffer(table.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);
      let dirty=true;
      const pager=new PageCache(p.asset,slots,(cluster,slot)=>{
        this.device.queue.writeBuffer(vertices,slot*PAGE_WORDS*4,packPage(p.asset,p.sourceColors,cluster));
        table.set([slot*PAGE_WORDS,0,p.asset.clusterLod[cluster],0],cluster*4);
        this.device.queue.writeBuffer(indices,cluster*16,table.subarray(cluster*4,cluster*4+4));
      },()=>{dirty=true;});
      const flush=()=>{if(!dirty)return;p.groupLodAttribute.array.set(pager.metadata());p.groupLodAttribute.needsUpdate=true;dirty=false;};
      const demand=this.makeBuffer(p.asset.groupCount*4,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
      flush();this.pagers.push({pager,p,flush,demand,bytes:vertices.size+indices.size});
      return {vertices,indices};
    });
  }
  prepare(now){
    if(this.busy)return super.prepare(now);
    // A single shared per-frame transfer budget. No await or queue drain in the
    // render path; complete groups become selectable in queue order.
    let budget=256*1024;this.frameUploadBytes=0;
    for(const {pager,flush} of this.pagers){const used=pager.tick(budget);budget-=used;this.frameUploadBytes+=used;flush();}
    this.totalUploadBytes+=this.frameUploadBytes;
    const accepted=super.prepare(now);
    this.wantDemand=accepted&&!this.requestPending&&now-this.lastDemand>=150;
    return accepted;
  }
  encodeVisibility(encoder,a,b){
    super.encodeVisibility(encoder,a,b);
    if(this.wantDemand)for(const {p,demand} of this.pagers){
      encoder.copyBufferToBuffer(this.sharedBuffer(p.lodCounterAttribute),p.asset.lods.length*4,demand,0,p.asset.groupCount*4);
    }
  }
  render(now){
    super.render(now);
    if(!this.wantDemand)return;
    this.wantDemand=false;this.lastDemand=now;this.requestPending=true;
    // Copies share the rendering submission; map asynchronously only after
    // submit. Separate staging buffers avoid collisions with diagnostic reads.
    Promise.all(this.pagers.map(async({pager,demand})=>{
      await demand.mapAsync(GPUMapMode.READ);
      const priorities=new Uint32Array(demand.getMappedRange()).slice();demand.unmap();
      if(!this.disposed)pager.request(priorities);
    })).catch(error=>{if(!this.disposed)console.warn('Page demand readback failed',error);}).finally(()=>{this.requestPending=false;});
  }
  updateReadout(){
    super.updateReadout();
    if(!this.pagers||!this.readout||performance.now()-(this.lastPageUI??-Infinity)<500)return;
    this.lastPageUI=performance.now();
    const sum=f=>this.pagers.reduce((n,p)=>n+f(p),0);
    const text=` Page cache ${(sum(p=>p.bytes)/1048576).toFixed(1)} MiB · ${sum(p=>p.pager.mapping.size)} resident pages · ${sum(p=>p.pager.resident.size)} detail groups · ${sum(p=>p.pager.evictions)} evictions · ${(this.frameUploadBytes/1024).toFixed(0)} KiB uploaded this frame (256 KiB cap).`;
    this.readout.textContent+=text;
    if(this.metrics)this.metrics.streaming={bytes:sum(p=>p.bytes),pages:sum(p=>p.pager.mapping.size),pending:sum(p=>p.pager.pending?1:0)};
  }
}
