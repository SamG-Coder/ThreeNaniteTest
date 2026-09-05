// Lossless meshlet pages: 192 byte-sized local indices, followed by packed
// float32 position/normal/color triples. At most 64 unique vertices per meshlet.
export const PAGE_WORDS = 640; // 2.5 KiB, including alignment padding.
export function packPage(asset, colors, cluster) {
  const words = new Uint32Array(PAGE_WORDS);
  const floats = new Float32Array(words.buffer);
  const indices = new Uint8Array(words.buffer, 0, 192);
  const local = new Map();
  for (let corner = 0; corner < 192; corner++) {
    const vertex = asset.indices[cluster * 192 + corner];
    if (!local.has(vertex)) {
      const n = local.size;
      if (n >= 64) throw new Error('Meshlet exceeds the 64-vertex page format');
      local.set(vertex, n);
      const offset = 48 + n * 9;
      floats.set(asset.vertices.subarray(vertex * 4, vertex * 4 + 3), offset);
      floats.set(asset.normals.subarray(vertex * 4, vertex * 4 + 3), offset + 3);
      floats.set(colors ? [colors.getX(vertex), colors.getY(vertex), colors.getZ(vertex)] : [.3,.5,.3], offset + 6);
    }
    indices[corner] = local.get(vertex);
  }
  return words;
}
export function unpackCorner(words, corner) {
  const local = (words[corner >>> 2] >>> ((corner & 3) * 8)) & 255;
  return new Float32Array(words.buffer, words.byteOffset + (48 + local * 9) * 4, 9);
}
export function pageLayout(asset) {
  const pinned = [], units = [], group = asset.groupLods;
  const clusters = (node, level = 0) => {
    const row = (node * 6 + level) * 4;
    return Array.from({length:group[row+2]}, (_,i)=>group[row+1]+i);
  };
  if (asset.hierarchy) {
    pinned.push(...clusters(0));
    for (let node=0;node<asset.groupCount;node++) {
      const children=[];let child=node+1;
      for(let i=0;i<group[(node*6+1)*4+1];i++) { children.push(child);child=group[(child*6+1)*4]; }
      units.push({id:node,pages:children.flatMap(c=>clusters(c)),children,parent:-1});
    }
    for(const unit of units)for(const child of unit.children)units[child].parent=unit.id;
  } else {
    for(let node=0;node<asset.groupCount;node++) {
      const coarse=clusters(node,5);pinned.push(...coarse);
      units.push({id:node,pages:Array.from({length:5},(_,level)=>clusters(node,level)).flat(),children:[],parent:-1});
    }
  }
  return {pinned,units};
}
// Residency is published per complete replacement group. An incomplete upload
// can never become selectable. Hierarchy parents remain resident during descent.
export class PageCache {
  constructor(asset, slots, upload, publish) {
    this.asset=asset;this.layout=pageLayout(asset);this.upload=upload;this.publish=publish;
    this.capacity=Math.max(slots,this.layout.pinned.length);
    this.free=Array.from({length:this.capacity},(_,i)=>this.capacity-1-i);
    this.mapping=new Map();this.resident=new Set();this.lastUsed=new Map();this.requested=new Map();
    this.clock=0;this.pending=null;this.evictions=0;this.uploadedBytes=0;
    for(const page of this.layout.pinned)this.load(page);
    this.publish(this.resident);
  }
  load(page) { const slot=this.free.pop();if(slot===undefined)throw new Error('Page cache exhausted');this.upload(page,slot);this.mapping.set(page,slot);this.uploadedBytes+=PAGE_WORDS*4; }
  request(priorities) {
    this.clock++;this.requested.clear();
    priorities.forEach((priority,id)=>{if(priority){this.requested.set(id,priority);this.lastUsed.set(id,this.clock);}});
  }
  evictFor(count) {
    const candidates=[...this.resident].filter(id=>!this.requested.has(id)&&!this.layout.units[id].children.some(child=>this.resident.has(child)))
      .sort((a,b)=>(this.lastUsed.get(a)??0)-(this.lastUsed.get(b)??0));
    for(const id of candidates){
      if(this.free.length>=count)break;
      this.resident.delete(id);this.publish(this.resident); // collapse parent before reuse
      for(const page of this.layout.units[id].pages){this.free.push(this.mapping.get(page));this.mapping.delete(page);}
      this.evictions++;
    }
    return this.free.length>=count;
  }
  tick(budgetBytes) {
    const before=this.uploadedBytes;let remaining=Math.floor(budgetBytes/(PAGE_WORDS*4));
    while(remaining>0){
      if(!this.pending){
        const next=[...this.requested].sort((a,b)=>b[1]-a[1]).map(([id])=>this.layout.units[id])
          .find(u=>u.pages.length&&!this.resident.has(u.id)&&(u.parent<0||this.resident.has(u.parent))&&u.pages.length<=this.capacity-this.layout.pinned.length);
        if(!next||!this.evictFor(next.pages.length))break;
        this.pending={unit:next,cursor:0};
      }
      const p=this.pending;
      while(remaining>0&&p.cursor<p.unit.pages.length){this.load(p.unit.pages[p.cursor++]);remaining--;}
      if(p.cursor===p.unit.pages.length){this.resident.add(p.unit.id);this.publish(this.resident);this.pending=null;}
    }
    return this.uploadedBytes-before;
  }
  metadata() {
    const table=this.asset.groupLods.slice();
    for(const unit of this.layout.units){if(this.resident.has(unit.id))continue;
      if(this.asset.hierarchy)table[(unit.id*6+1)*4+1]=0;
      else for(let level=0;level<5;level++){
        // Preserve error for the desired LOD; redirect only its geometry range.
        const row=(unit.id*6+level)*4,coarse=(unit.id*6+5)*4;
        table.set(this.asset.groupLods.subarray(coarse+1,coarse+4),row+1);
      }
    }
    return table;
  }
}
