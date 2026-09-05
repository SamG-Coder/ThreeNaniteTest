export class FrameGate {
  constructor(limit=1){this.limit=limit;this.pending=0;this.skipped=0;}
  get busy(){return this.pending>=this.limit;}
  track(completion){
    this.pending++;
    return Promise.resolve(completion).catch(()=>{}).finally(()=>{this.pending--;});
  }
}
export function frameOptions(search=''){
  const q=new URLSearchParams(search);
  return {frames:q.get('frames')==='2'?2:1,batch:q.get('batch')!=='0',skipArgs:q.get('skipArgs')!=='0',direct:q.get('direct')==='1',profile:q.get('profile')==='1'};
}
// Boundaries around Three passes include queue gaps and profiling submissions;
// they are GPU timeline intervals, not pure shader execution times.
export class FrameProbe {
  constructor(device){
    this.device=device;this.pending=false;this.active=false;this.last=-Infinity;this.gpu=null;
    if(device.features.has('timestamp-query')){
      this.queries=device.createQuerySet({type:'timestamp',count:12});
      this.resolve=device.createBuffer({size:256,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      this.read=device.createBuffer({size:96,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    }
  }
  begin(now,enabled){this.active=!!(enabled&&this.queries&&!this.pending&&now-this.last>=500);if(this.active)this.last=now;}
  writes(index){return this.active?{querySet:this.queries,beginningOfPassWriteIndex:index, endOfPassWriteIndex:index+1}:undefined;}
  mark(index){
    if(!this.active)return;
    const e=this.device.createCommandEncoder();const p=e.beginComputePass({timestampWrites:{querySet:this.queries,beginningOfPassWriteIndex:index}});p.end();this.device.queue.submit([e.finish()]);
  }
  finish(){
    if(!this.active)return;this.active=false;this.pending=true;
    const e=this.device.createCommandEncoder();e.resolveQuerySet(this.queries,0,12,this.resolve,0);e.copyBufferToBuffer(this.resolve,0,this.read,0,96);this.device.queue.submit([e.finish()]);
    this.read.mapAsync(GPUMapMode.READ).then(()=>{
      const v=new BigUint64Array(this.read.getMappedRange()).slice();this.read.unmap();
      this.gpu=Array.from({length:6},(_,i)=>Number(v[i*2+1]-v[i*2])/1e6);
    }).catch(()=>{this.gpu=null;}).finally(()=>{this.pending=false;if(this.disposed)this.destroy();});
  }
  destroy(){this.queries?.destroy();this.resolve?.destroy();this.read?.destroy();}
  dispose(){this.disposed=true;if(!this.pending)this.destroy();}
}
