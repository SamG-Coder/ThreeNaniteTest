import { depthOrderWGSL } from '../../src/streaming/depthOrder.js';
// Repack an existing emulation export, retaining exactly the same cluster IDs,
// matrices, selection and camera. This isolates GPU page decoding from LOD.
import { readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { packPage, PAGE_WORDS } from '../../src/streaming/pages.js';
import { pagedVisibilityWGSL } from '../../src/streaming/shaders.js';
const [input,out]=process.argv.slice(2);if(!input||!out)throw new Error('Usage: export-paged.mjs INPUT OUT');
const m=JSON.parse(readFileSync(`${input}/manifest.json`));
if((m.vertexStride??48)!==48)throw new Error('Textured landscape exports use the full-detail visibility harness; paging would discard UVs');
mkdirSync(out,{recursive:true});cpSync(input,out,{recursive:true});
const read=(name,Type)=>{const b=readFileSync(`${input}/${name}.bin`);return new Type(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const params=read('params',Uint32Array);
for(let i=0;i<2;i++){
 const v=read(`${i}-vertices`,Float32Array),idx=read(`${i}-indices`,Uint32Array),count=m.clusterCounts[i];
 const asset={vertices:new Float32Array(v.length/3),normals:new Float32Array(v.length/3),indices:idx,coverage:Float32Array.from({length:v.length/12},(_,j)=>v[j*12+11])};
 for(let j=0;j<v.length/12;j++){asset.vertices.set(v.subarray(j*12,j*12+4),j*4);asset.normals.set(v.subarray(j*12+4,j*12+8),j*4);}
 const colors={getX:j=>v[j*12+8],getY:j=>v[j*12+9],getZ:j=>v[j*12+10]};
 const pages=new Uint32Array(count*PAGE_WORDS),table=new Uint32Array(count*4);
 for(let c=0;c<count;c++){pages.set(packPage(asset,colors,c),c*PAGE_WORDS);table.set([c*PAGE_WORDS,0,idx[params[26+i]+c],0],c*4);}
 writeFileSync(`${out}/${i}-vertices.bin`,pages);writeFileSync(`${out}/${i}-indices.bin`,table);
}
writeFileSync(`${out}/visibility.wgsl`,pagedVisibilityWGSL);
writeFileSync(`${out}/depth-order.wgsl`,depthOrderWGSL);
m.paged=true;writeFileSync(`${out}/manifest.json`,JSON.stringify(m,null,2));
console.log('Exported lossless paged visibility',out);
