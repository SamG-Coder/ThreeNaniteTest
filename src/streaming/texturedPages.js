import {landscapeVisibilityWGSL} from '../visibility/landscapeShaders.js';
export const TEXTURED_PAGE_WORDS=1088;
export function packTexturedPage(asset,colors,surface,cluster){
 const words=new Uint32Array(TEXTURED_PAGE_WORDS),f=new Float32Array(words.buffer),indices=new Uint8Array(words.buffer,0,192),local=new Map();
 for(let c=0;c<192;c++){
  const v=asset.indices[cluster*192+c];
  if(!local.has(v)){
   const n=local.size;if(n>=64)throw Error('Textured page exceeds 64 vertices');local.set(v,n);const o=48+n*16;
   f.set(asset.vertices.subarray(v*4,v*4+4),o);f.set(asset.normals.subarray(v*4,v*4+4),o+4);f[o+7]=surface?.getX(v)??0;
   f.set(colors?[colors.getX(v),colors.getY(v),colors.getZ(v),asset.coverage?.[v]??1]:[.3,.5,.3,1],o+8);
   f[o+12]=asset.uvs[v*2];f[o+13]=asset.uvs[v*2+1];
  }indices[c]=local.get(v);
 }return words;
}
let shader=landscapeVisibilityWGSL.replaceAll('av:array<Vertex>','av:array<u32>').replaceAll('bv:array<Vertex>','bv:array<u32>');
let decode='';
for(const p of ['a','b']){
 decode+=`\nfn ${p}Vertex(cluster:u32,corner:u32)->Vertex{let page=${p}i[cluster*4u];let local=(${p}v[page+corner/4u]>>((corner%4u)*8u))&255u;let o=page+48u+local*16u;return Vertex(`;
 decode+=Array.from({length:4},(_,i)=>`vec4<f32>(${Array.from({length:4},(_,j)=>`bitcast<f32>(${p}v[o+${i*4+j}u])`).join(',')})`).join(',')+');}\n';
 shader=shader.replace(`let base=cluster*192u+corner; v0=${p}v[${p}i[base]]; v1=${p}v[${p}i[base+1u]]; v2=${p}v[${p}i[base+2u]];`,`v0=${p}Vertex(cluster,corner);v1=${p}Vertex(cluster,corner+1u);v2=${p}Vertex(cluster,corner+2u);`)
 .replace(`lod=${p}i[params.ranges.${p==='a'?'z':'w'}+cluster];`,`lod=${p}i[cluster*4u+2u];`)
 .replace(`${p}v[${p}i[v.y*192u+vi]].position`,`${p}Vertex(v.y,vi).position`);
}
export const texturedPagedWGSL=shader+decode;
