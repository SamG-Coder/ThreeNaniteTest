import {pageLayout} from '../streaming/pages.js';
// Variable-sized pages share one word-addressed GPU arena. Replacement groups
// become visible only when all pages exist. Ancestor fallbacks stay resident.
export class GeometryCache{
 constructor(asset,capacityWords,upload,publish){
  this.asset=asset;this.layout=pageLayout(asset);this.upload=upload;this.publish=publish;
  this.table=asset.groupLods.slice();for(const unit of this.layout.units)this.table[unit.id*24+5]=0;
  this.capacity=capacityWords;this.free=[[0,capacityWords]];this.mapping=new Map();this.resident=new Set();this.requested=new Map();this.lastUsed=new Map();this.clock=0;this.evictions=0;this.uploadedBytes=0;this.pending=null;this.staged=new Map();this.order=[];this.loading=new Map();this.pageError=null;
  for(const p of this.layout.pinned)this.load(p);this.publish();
 }
 size(id){return Math.ceil(this.asset.pageWords[id]/64)*64;}
 allocate(size){const i=this.free.findIndex(r=>r[1]>=size);if(i<0)return null;const r=this.free[i],start=r[0];r[0]+=size;r[1]-=size;if(!r[1])this.free.splice(i,1);return start;}
 release(start,size){this.free.push([start,size]);this.free.sort((a,b)=>a[0]-b[0]);for(let i=0;i<this.free.length-1;){const a=this.free[i],b=this.free[i+1];if(a[0]+a[1]===b[0]){a[1]+=b[1];this.free.splice(i+1,1);}else i++;}}
 load(id){const size=this.size(id),offset=this.allocate(size);if(offset===null)throw Error('Geometry page arena exhausted');this.upload(id,offset,this.asset.pages[id]);this.mapping.set(id,{offset,size});this.uploadedBytes+=this.asset.pageWords[id]*4;if(this.asset.pageProvider&&!this.layout.pinned.includes(id))this.asset.pages[id]=undefined;this.staged.delete(id);}
 request(priorities){this.clock++;this.requested.clear();priorities.forEach((p,i)=>{if(p){this.requested.set(i,p);this.lastUsed.set(i,this.clock);}});
  for(const [id,unit]of this.staged)if(!this.requested.has(unit)){this.asset.pages[id]=undefined;this.staged.delete(id);}
  this.order=[...this.requested].sort((a,b)=>b[1]-a[1]).map(([id])=>this.layout.units[id]);
  if(this.pending&&!this.requested.has(this.pending.unit.id)){for(const id of this.pending.unit.pages.slice(0,this.pending.cursor)){const m=this.mapping.get(id);this.release(m.offset,m.size);this.mapping.delete(id);}if(this.asset.pageProvider)for(const id of this.pending.unit.pages)this.asset.pages[id]=undefined;this.pending=null;}
 }
 evict(){
  const protectedUnits=new Set();for(let id=this.pending?.unit.parent??-1;id>=0;id=this.layout.units[id].parent)protectedUnits.add(id);
  const candidates=[...this.resident].filter(id=>!protectedUnits.has(id)&&!this.requested.has(id)&&!this.layout.units[id].children.some(c=>this.resident.has(c))).sort((a,b)=>(this.lastUsed.get(a)??0)-(this.lastUsed.get(b)??0));
  if(!candidates.length)return false;const id=candidates[0];this.resident.delete(id);this.table[id*24+5]=0;this.publish(id);
  for(const p of this.layout.units[id].pages){const m=this.mapping.get(p);if(m){this.release(m.offset,m.size);this.mapping.delete(p);}}this.evictions++;return true;
 }
 prefetch(unit){if(!this.asset.pageProvider)return;
  for(const id of unit.pages){if(this.mapping.has(id)||this.asset.pages[id]||this.loading.has(id))continue;
   const promise=this.asset.pageProvider.get(id).then(page=>{if(this.requested.has(unit.id)&&!this.resident.has(unit.id)){this.asset.pages[id]=page;this.staged.set(id,unit.id);}}).catch(error=>{this.pageError=error;console.warn('Geometry page load failed; retaining parent',error);}).finally(()=>this.loading.delete(id));this.loading.set(id,promise);
  }
 }
 tick(budget){let used=0;
  if(this.asset.pageProvider){let count=0;for(const unit of this.order){if(this.resident.has(unit.id)||!unit.pages.length||(unit.parent>=0&&!this.resident.has(unit.parent)))continue;this.prefetch(unit);if(++count===8)break;}}
  while(true){
   if(!this.pending){const unit=this.order.find(u=>!this.resident.has(u.id)&&u.pages.length&&(u.parent<0||this.resident.has(u.parent)));
    if(!unit)break;this.pending={unit,cursor:0};this.prefetch(unit);}
   const p=this.pending;
   if(p.cursor===p.unit.pages.length){this.resident.add(p.unit.id);this.table[p.unit.id*24+5]=this.asset.groupLods[p.unit.id*24+5];this.pending=null;this.publish(p.unit.id);continue;}
   const id=p.unit.pages[p.cursor];if(!this.asset.pages[id]){this.prefetch(p.unit);break;}const size=this.size(id),bytes=this.asset.pageWords[id]*4;
   if(used+bytes>budget)break;
   if(!this.free.some(r=>r[1]>=size)){if(!this.evict())break;continue;}
   this.load(id);used+=bytes;p.cursor++;
  }return used;
 }
 metadata(){return this.table;}
}
