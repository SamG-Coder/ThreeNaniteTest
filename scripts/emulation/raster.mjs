import {tileMayCover,conservativeNearest} from '../../src/bitmask/tileReference.js';
const EMPTY=0xffffffff;
const edge=(a,b,p)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
const inclusive=(e,a,b)=>e>0||(e===0&&(b[1]<a[1]||(b[1]===a[1]&&b[0]>a[0])));
function fan(a,b,c,p,depth){
 const area=edge(a,c,b);if(area<=1e-8)return -1;
 const e0=edge(c,b,p),e1=edge(b,a,p),e2=edge(a,c,p);
 if(!inclusive(e0,c,b)||!inclusive(e1,b,a)||!inclusive(e2,a,c))return -1;
 if(!depth)return 0;
 const z=Math.fround((e0*a[2]+e1*c[2]+e2*b[2])/area);return z>=0&&z<=1?z:-1;
}
export function sample(t,p,depth=true){const z=fan(t[0],t[1],t[2],p,depth);return z>=0||t.length===3?z:fan(t[0],t[2],t[3],p,depth);}
export function primitive(scene,index){const o=index*14,n=scene.projected[o+12];return Array.from({length:n},(_,i)=>Array.from(scene.projected.subarray(o+i*3,o+i*3+3)));}
export function emulateRaster(scene,variant,{capacity=8_388_608,order='forward',earlyEmpty=false}={}){
 const {width,height,primitiveCount}=scene,tx=Math.ceil(width/8),ty=Math.ceil(height/8),buckets=variant==='reject'?8:1;
 const heads=new Int32Array(tx*ty*buckets).fill(-1),links=new Int32Array(capacity),refs=new Uint32Array(capacity);
 const stats={variant,candidateTiles:0,edgeRejected:0,entries:0,batches:0,rasterSetups:0,depthRejected:0,coverageTests:0,coverageHits:0,resolveTests:0,depthInterpolations:0,winnerUpdates:0,maskAtomics:0,maskReadWords:0,depthScratchReads:0,depthScratchWrites:0,barriers:0,diagnosticAtomicAdds:0,coveredPixels:0,zeroHitCandidates:0,emptyPixelBounds:0,emptyPixelBoundEntries:0};
 for(let n=0;n<primitiveCount;n++){
  const id=order==='reverse'?primitiveCount-1-n:n,t=primitive(scene,id),xs=t.map(p=>p[0]),ys=t.map(p=>p[1]);
  const firstX=Math.max(0,Math.min(tx-1,Math.floor(Math.min(...xs)/8))),lastX=Math.max(0,Math.min(tx-1,Math.floor(Math.max(...xs)/8)));
  const firstY=Math.max(0,Math.min(ty-1,Math.floor(Math.min(...ys)/8))),lastY=Math.max(0,Math.min(ty-1,Math.floor(Math.max(...ys)/8)));
  const emptyPixelBounds=Math.ceil(Math.min(...xs)-.5)>Math.floor(Math.max(...xs)-.5)||Math.ceil(Math.min(...ys)-.5)>Math.floor(Math.max(...ys)-.5);
  if(emptyPixelBounds){stats.emptyPixelBounds++;if(earlyEmpty)continue;}
  const bucket=buckets===8?Math.min(7,Math.floor(scene.projected[id*14+13]/16)):0;
  for(let y=firstY;y<=lastY;y++)for(let x=firstX;x<=lastX;x++){
   stats.candidateTiles++;
   if(buckets===8&&!tileMayCover(t,[x*8+.5,y*8+.5],[Math.min(x*8+7,width-1)+.5,Math.min(y*8+7,height-1)+.5])){stats.edgeRejected++;continue;}
   if(stats.entries===capacity)throw new Error('Emulator pool overflow: exhaustive overflow scanning is not modelled. Increase --capacity; no result was silently truncated.');
   if(emptyPixelBounds)stats.emptyPixelBoundEntries++;
   const entry=stats.entries++,head=(y*tx+x)*buckets+bucket;refs[entry]=id;links[entry]=heads[head];heads[head]=entry;
  }
 }
 const depths=new Float32Array(width*height).fill(1),ids=new Uint32Array(width*height).fill(EMPTY);
 for(let tile=0;tile<tx*ty;tile++){
  const ox=(tile%tx)*8,oy=Math.floor(tile/tx)*8;
  const best=new Float32Array(64).fill(1),winners=new Uint32Array(64).fill(EMPTY);
  for(let bucket=0;bucket<buckets;bucket++){
   let next=heads[tile*buckets+bucket];
   while(next!==-1){
    const batch=[];for(let i=0;i<32&&next!==-1;i++){batch.push(refs[next]);next=links[next];}
    stats.batches++;stats.rasterSetups+=batch.length;stats.barriers+=(variant==='owned'||variant==='reject')?3:4;
    if(variant==='reject')stats.depthScratchReads+=64;
    if(variant==='cached'){stats.depthScratchWrites+=64;}
    let farthest=0;for(let p=0;p<64;p++)if(ox+p%8<width&&oy+Math.floor(p/8)<height)farthest=Math.max(farthest,best[p]);
    const masks=new Uint32Array(64),cache=variant==='cached'?new Float32Array(2048):null,triangles=batch.map(id=>primitive(scene,id));
    for(let i=0;i<batch.length;i++){
     const t=triangles[i];
     if(variant==='reject'&&farthest<1&&conservativeNearest(t)>farthest+1e-5){stats.depthRejected++;continue;}
     const xs=t.map(p=>p[0]),ys=t.map(p=>p[1]);let hits=0;
     const lx=Math.max(ox,Math.ceil(Math.min(...xs)-.5)),hx=Math.min(ox+7,width-1,Math.floor(Math.max(...xs)-.5));
     const ly=Math.max(oy,Math.ceil(Math.min(...ys)-.5)),hy=Math.min(oy+7,height-1,Math.floor(Math.max(...ys)-.5));
     for(let y=ly;y<=hy;y++)for(let x=lx;x<=hx;x++){
      const pixel=(y-oy)*8+x-ox;stats.coverageTests++;
      const depthPass=variant==='original'||variant==='cached';const z=sample(t,[x+.5,y+.5],depthPass);
      if(z>=0){
       stats.coverageHits++;if(depthPass)stats.depthInterpolations++;
       if(variant==='cached'){stats.depthScratchReads++;if(z>best[pixel])continue;}
       masks[pixel]|=1<<i;hits++;
       if(depthPass)stats.maskAtomics++;
       if(cache){cache[i*64+pixel]=z;stats.depthScratchWrites++;}
      }
     }
     if(hits===0)stats.zeroHitCandidates++;
    }
    if(variant==='owned'||variant==='reject')stats.maskReadWords+=64*batch.length;
    for(let p=0;p<64;p++){
     let bits=masks[p]>>>0;while(bits){
      const bit=31-Math.clz32((bits&-bits)>>>0),id=batch[bit];stats.resolveTests++;
      const z=cache?cache[bit*64+p]:sample(triangles[bit],[ox+p%8+.5,oy+Math.floor(p/8)+.5]);
      if(cache)stats.depthScratchReads++;else if(z>=0)stats.depthInterpolations++;
      if(z>=0&&(z<best[p]||(z===best[p]&&scene.ids[id]<winners[p]))){best[p]=z;winners[p]=scene.ids[id];stats.winnerUpdates++;}
      bits=(bits&(bits-1))>>>0;
     }
    }
    if(variant==='reject')stats.depthScratchWrites+=64;
    // Explicit calls issued by the source on a diagnostic frame, even for zero additions.
    if(variant==='reject')stats.diagnosticAtomicAdds+=1+2*batch.length+hiddenCount(triangles,farthest)+128;
   }
  }
  for(let p=0;p<64;p++)if(ox+p%8<width&&oy+Math.floor(p/8)<height){const dst=(oy+Math.floor(p/8))*width+ox+p%8;depths[dst]=best[p];ids[dst]=winners[p];if(winners[p]!==EMPTY)stats.coveredPixels++;}
 }
 if(variant==='reject')stats.diagnosticAtomicAdds+=primitiveCount*2+stats.coveredPixels;
 else if(variant!=='cached')stats.diagnosticAtomicAdds=stats.batches+stats.coveredPixels;
 else {stats.diagnosticAtomicAdds=2*tx*ty;stats.barriers+=tx*ty;}
 stats.barriers+=tx*ty; // Initial tile workgroup synchronization.
 stats.binSetups=scene.counts?.paddedTriangleSlots??primitiveCount;
 stats.totalSetupCalls=stats.binSetups+stats.rasterSetups;
 stats.setupSourceVertexFetches=stats.totalSetupCalls*3;
 stats.shadeCalls=variant==='cached'?stats.coveredPixels:stats.winnerUpdates;
 return {stats,depths,ids};
}
function hiddenCount(triangles,farthest){return triangles.reduce((n,t)=>n+(farthest<1&&conservativeNearest(t)>farthest+1e-5?1:0),0);}
