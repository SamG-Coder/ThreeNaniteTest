import { visibilityWGSL } from '../visibility/shaders.js';
// Keep visibility IDs, clipping, HZB and the user's atomic masks unchanged.
// Only the virtual-cluster -> physical-page geometry fetch is replaced.
let shader=visibilityWGSL.replaceAll('av:array<Vertex>','av:array<u32>').replaceAll('bv:array<Vertex>','bv:array<u32>');
let decode='';
for(const prefix of ['a','b']){
  decode+=`
fn ${prefix}Vertex(cluster:u32,corner:u32)->Vertex{
 let page=${prefix}i[cluster*4u];
 let packed=${prefix}v[page+corner/4u];
 let local=(packed>>((corner%4u)*8u))&255u;
 let offset=page+48u+local*9u;
 return Vertex(vec4<f32>(bitcast<f32>(${prefix}v[offset]),bitcast<f32>(${prefix}v[offset+1u]),bitcast<f32>(${prefix}v[offset+2u]),1.0),
  vec4<f32>(bitcast<f32>(${prefix}v[offset+3u]),bitcast<f32>(${prefix}v[offset+4u]),bitcast<f32>(${prefix}v[offset+5u]),0.0),
  vec4<f32>(bitcast<f32>(${prefix}v[offset+6u]),bitcast<f32>(${prefix}v[offset+7u]),bitcast<f32>(${prefix}v[offset+8u]),1.0));
}
`;
  shader=shader.replace(`let base=cluster*192u+corner; v0=${prefix}v[${prefix}i[base]]; v1=${prefix}v[${prefix}i[base+1u]]; v2=${prefix}v[${prefix}i[base+2u]];`,
    `v0=${prefix}Vertex(cluster,corner); v1=${prefix}Vertex(cluster,corner+1u); v2=${prefix}Vertex(cluster,corner+2u);`)
    .replace(`lod=${prefix}i[params.ranges.${prefix==='a'?'z':'w'}+cluster];`,`lod=${prefix}i[cluster*4u+2u];`)
    .replace(`${prefix}v[${prefix}i[v.y*192u+vi]].position`,`${prefix}Vertex(v.y,vi).position`);
}
export const pagedVisibilityWGSL=shader+'\n'+decode;
