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
  vec4<f32>(bitcast<f32>(${prefix}v[offset+6u]),bitcast<f32>(${prefix}v[offset+7u]),bitcast<f32>(${prefix}v[offset+8u]),f32((${prefix}v[page+624u+local/4u]>>((local%4u)*8u))&255u)/255.0));
}
`;
  shader=shader.replace(`let base=cluster*192u+corner; v0=${prefix}v[${prefix}i[base]]; v1=${prefix}v[${prefix}i[base+1u]]; v2=${prefix}v[${prefix}i[base+2u]];`,
    `v0=${prefix}Vertex(cluster,corner); v1=${prefix}Vertex(cluster,corner+1u); v2=${prefix}Vertex(cluster,corner+2u);`)
    .replace(`lod=${prefix}i[params.ranges.${prefix==='a'?'z':'w'}+cluster];`,`lod=${prefix}i[cluster*4u+2u];`)
    .replace(`${prefix}v[${prefix}i[v.y*192u+vi]].position`,`${prefix}Vertex(v.y,vi).position`);
}
export const pagedOpaqueVisibilityWGSL=shader+'\n'+decode;
shader=shader.replace('id:u32 };','id:u32, @location(1) @interpolate(flat) coverage:f32, @location(2) @interpolate(flat) stable:u32 };')
 .replace('var p:vec4<f32>;','var p:vec4<f32>;var alpha=1.0;var stable=0u;')
 .replace('p=params.matrix*am[v.x]*aVertex(v.y,vi).position;', 'let vertex=aVertex(v.y,vi);p=params.matrix*am[v.x]*vertex.position;alpha=vertex.color.w;stable=v.y*747796405u+v.x*2891336453u+vi/6u;')
 .replace('p=params.matrix*bm[v.x]*bVertex(v.y,vi).position;', 'let vertex=bVertex(v.y,vi);p=params.matrix*bm[v.x]*vertex.position;alpha=vertex.color.w;stable=v.y*747796405u+v.x*2891336453u+vi/6u;')
 .replace('return VOut(p,id);','return VOut(p,id,alpha,stable);')
 .replace('u32{return input.id;}',`u32{
   // Stable stochastic coverage: rejected samples never write ID or depth.
   // No frame-dependent random value: the seed and recovery passes agree.
   if(input.coverage<1.0){
     var h=u32(input.position.x)*1597334677u^u32(input.position.y)*3812015801u^input.stable;
     h=(h^(h>>16u))*2246822519u;h=(h^(h>>13u))*3266489917u;h=h^(h>>16u);
     if(f32(h&0x00ffffffu)/16777216.0>=input.coverage){discard;}
   }
   return input.id;
 }`);
export const pagedVisibilityWGSL=shader+'\n'+decode;
