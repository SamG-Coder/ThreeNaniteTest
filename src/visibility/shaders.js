import { forestReferenceWGSL } from '../bitmask/forestReferenceShaders.js';
// Reuse the existing vertex format and flat material interpretation. Geometry
// functions are shared; the hardware visibility pass only consumes positions.
const prefix=forestReferenceWGSL.slice(0,forestReferenceWGSL.indexOf('fn screen('));
const shading=forestReferenceWGSL.slice(forestReferenceWGSL.indexOf('fn hashColor('),forestReferenceWGSL.indexOf('var<workgroup> batchIds:'));
const inputs=prefix.replace(/\/\/ Two words per tile:[\s\S]*?(?=fn sourceTriangle)/,'');
export const visibilityWGSL=inputs+shading+`
@group(0) @binding(9) var<storage,read> drawList:array<u32>;
struct VOut { @builtin(position) position:vec4<f32>, @location(0) @interpolate(flat) id:u32 };
@vertex fn vertexMain(@builtin(vertex_index) vi:u32,@builtin(instance_index) instance:u32)->VOut{
  let clusterId=drawList[instance];let slot=clusterId&0x7fffffffu;
  let id=(clusterId&0x80000000u)|(slot*64u+vi/3u);
  var p:vec4<f32>;
  if((clusterId&0x80000000u)==0u){let v=al[slot];p=params.matrix*am[v.x]*av[ai[v.y*192u+vi]].position;}
  else{let v=bl[slot];p=params.matrix*bm[v.x]*bv[bi[v.y*192u+vi]].position;}
  return VOut(p,id);
}
@fragment fn fragmentMain(input:VOut)->@location(0) u32{return input.id;}
@group(0) @binding(10) var<storage,read_write> bits:array<atomic<u32>>;
@group(0) @binding(11) var<storage,read_write> counters:array<atomic<u32>>;
// x/y: clusters per asset, z: bitset word count, w: HZB enabled
@group(0) @binding(12) var<uniform> config:vec4<u32>;
@group(0) @binding(13) var vis:texture_2d<u32>;
@group(0) @binding(14) var depth:texture_depth_2d;
@group(0) @binding(15) var colorOutput:texture_storage_2d<rgba16float,write>;
@group(0) @binding(16) var depthOutput:texture_storage_2d<r32float,write>;
fn bitLocation(id:u32)->u32{
  let slot=(id&0x7fffffffu)/64u;
  if((id&0x80000000u)==0u){let v=al[slot];return v.x*config.x+v.y;}
  let v=bl[slot];return config.z*32u+v.x*config.y+v.y;
}
// config.z is the terrain bitset words; tree bits start at a word boundary.
// Mask words begin after both assets' stable cluster bitsets; provided below.
@group(0) @binding(17) var<uniform> bitLayout:vec4<u32>;
@compute @workgroup_size(8,8) fn coverage(@builtin(global_invocation_id) g:vec3<u32>){
  if(any(g.xy>=params.size.xy)){return;}
  if(textureLoad(vis,vec2<i32>(g.xy),0).x==EMPTY){return;}
  let tile=(g.y/8u)*params.size.z+g.x/8u;let pixel=(g.y%8u)*8u+g.x%8u;
  atomicOr(&bits[bitLayout.x+tile*2u+pixel/32u],1u<<(pixel%32u));
}
@compute @workgroup_size(8,8) fn shadeVisible(@builtin(global_invocation_id) g:vec3<u32>){
  if(any(g.xy>=params.size.xy)){return;}
  let xy=vec2<i32>(g.xy);let id=textureLoad(vis,xy,0).x;
  var color=vec3<f32>(0.0);
  if(id!=EMPTY){
    let s=sourceTriangle(id);var t:Triangle;t.color=s.color;t.normal=s.normal;t.info=s.info;
    color=shade(t);let index=bitLocation(id);atomicOr(&bits[index/32u],1u<<(index%32u));
    atomicAdd(&counters[4],1u);
  }
  textureStore(colorOutput,xy,vec4<f32>(color,1.0));
  textureStore(depthOutput,xy,vec4<f32>(textureLoad(depth,xy,0)));
}
`;
export const cullWGSL=`
struct Params { matrix:mat4x4<f32>, camera:vec4<f32>, size:vec4<u32>, ranges:vec4<u32>, settings:vec4<u32> };
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> boundsA:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> boundsB:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> worldsA:array<mat4x4<f32>>;
@group(0) @binding(4) var<storage,read> selectedA:array<vec2<u32>>;
@group(0) @binding(7) var<storage,read> worldsB:array<mat4x4<f32>>;
@group(0) @binding(8) var<storage,read> selectedB:array<vec2<u32>>;
@group(0) @binding(10) var<storage,read_write> bits:array<atomic<u32>>;
@group(0) @binding(11) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(12) var<uniform> config:vec4<u32>;
@group(0) @binding(17) var<uniform> bitLayout:vec4<u32>;
@group(0) @binding(18) var<storage,read_write> seedList:array<u32>;
@group(0) @binding(19) var<storage,read_write> recoveryList:array<u32>;
@group(0) @binding(20) var hzb:texture_2d<f32>;
@group(0) @binding(21) var<storage,read_write> args:array<u32>;
fn countA()->u32{return min(atomicLoad(&counters[0]),params.ranges.x);}
fn countB()->u32{return min(atomicLoad(&counters[1]),params.ranges.y);}
fn globalCluster(index:u32)->u32{let a=countA();if(index<a){return index;}return 0x80000000u|(index-a);}
fn stableBit(id:u32)->u32{
 let slot=id&0x7fffffffu;
 if((id&0x80000000u)==0u){let v=selectedA[slot];return v.x*config.x+v.y;}
 let v=selectedB[slot];return config.z*32u+v.x*config.y+v.y;
}
fn seeded(id:u32)->bool{let bit=stableBit(id);return config.w!=0u && (atomicLoad(&bits[bit/32u])&(1u<<(bit%32u)))!=0u;}
fn hidden(id:u32)->bool{
 if(config.w==0u){return false;}
 let slot=id&0x7fffffffu;var sphere:vec4<f32>;var world:mat4x4<f32>;
 if((id&0x80000000u)==0u){let v=selectedA[slot];sphere=boundsA[v.y];world=worldsA[v.x];}
 else{let v=selectedB[slot];sphere=boundsB[v.y];world=worldsB[v.x];}
 let centre=(world*vec4<f32>(sphere.xyz,1.0)).xyz;
 let radius=sphere.w*length(world[0].xyz);
 var lo=vec2<f32>(1e30);var hi=vec2<f32>(-1e30);var nearest=1.0;
 for(var i=0u;i<8u;i++){
  let sign=vec3<f32>(f32(i&1u),f32((i>>1u)&1u),f32((i>>2u)&1u))*2.0-1.0;
  let p=params.matrix*vec4<f32>(centre+sign*radius,1.0);
  if(p.w<=0.0||p.z<=0.0){return false;}
  let ndc=p.xyz/p.w;let screen=vec2<f32>(ndc.x*.5+.5,.5-ndc.y*.5)*vec2<f32>(params.size.xy);
  lo=min(lo,screen);hi=max(hi,screen);nearest=min(nearest,ndc.z);
 }
 lo=clamp(floor(lo)-1.0,vec2<f32>(0.0),vec2<f32>(params.size.xy)-1.0);
 hi=clamp(ceil(hi)+1.0,vec2<f32>(0.0),vec2<f32>(params.size.xy)-1.0);
 let extent=max(hi.x-lo.x+1.0,hi.y-lo.y+1.0);
 let level=min(u32(floor(log2(max(extent,1.0)))),textureNumLevels(hzb)-1u);
 let first=vec2<i32>(lo/f32(1u<<level));let last=vec2<i32>(hi/f32(1u<<level));
 var farthest=0.0;
 for(var y=first.y;y<=last.y;y++){for(var x=first.x;x<=last.x;x++){
  farthest=max(farthest,textureLoad(hzb,vec2<i32>(x,y),i32(level)).x);
 }}
 return nearest>farthest+0.00002;
}
@compute @workgroup_size(64) fn clearFrame(@builtin(global_invocation_id) g:vec3<u32>){
 if(g.x>=2u&&g.x<16u){atomicStore(&counters[g.x],0u);}
 if(g.x<bitLayout.y){atomicStore(&bits[bitLayout.x+g.x],0u);}
}
@compute @workgroup_size(64) fn clearHistory(@builtin(global_invocation_id) g:vec3<u32>){
 if(g.x<bitLayout.x){atomicStore(&bits[g.x],0u);}
}
@compute @workgroup_size(1) fn arguments(){
 args[0]=192u;args[1]=atomicLoad(&counters[2]);args[2]=0u;args[3]=0u;
 args[4]=192u;args[5]=atomicLoad(&counters[3]);args[6]=0u;args[7]=0u;
 let groups=(countA()+countB()+63u)/64u;let width=max(params.settings.w,1u);
 args[8]=min(groups,width);args[9]=max((groups+width-1u)/width,1u);args[10]=1u;
}
@compute @workgroup_size(64) fn seed(@builtin(global_invocation_id) g:vec3<u32>){
 let index=g.x+g.y*params.settings.w*64u;if(index>=countA()+countB()){return;}
 let id=globalCluster(index);if(seeded(id)){let out=atomicAdd(&counters[2],1u);seedList[out]=id;}
}
@compute @workgroup_size(64) fn recover(@builtin(global_invocation_id) g:vec3<u32>){
 let index=g.x+g.y*params.settings.w*64u;if(index>=countA()+countB()){return;}
 let id=globalCluster(index);if(seeded(id)){return;}
 if(hidden(id)){atomicAdd(&counters[5],1u);return;}
 let out=atomicAdd(&counters[3],1u);recoveryList[out]=id;
}
`;
export const pyramidWGSL=`
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var destination:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) g:vec3<u32>){
 if(any(g.xy>=textureDimensions(destination))){return;}
 let p=vec2<i32>(g.xy*2u);var d=0.0;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){d=max(d,textureLoad(source,p+vec2<i32>(x,y),0).x);}}
 textureStore(destination,vec2<i32>(g.xy),vec4<f32>(d));
}
`;
export const pyramidBaseWGSL=`
@group(0) @binding(0) var depth:texture_depth_2d;
@group(0) @binding(1) var destination:texture_storage_2d<r32float,write>;
@group(0) @binding(2) var<storage,read_write> bits:array<atomic<u32>>;
// actual width/height, mask offset, tilesX
@group(0) @binding(3) var<uniform> dimensions:vec4<u32>;
@compute @workgroup_size(8,8) fn base(@builtin(global_invocation_id) g:vec3<u32>){
 if(any(g.xy>=textureDimensions(destination))){return;}
 var d=1.0;
 if(all(g.xy<dimensions.xy)){
  let tile=(g.y/8u)*dimensions.w+g.x/8u;let pixel=(g.y%8u)*8u+g.x%8u;
  let mask=atomicLoad(&bits[dimensions.z+tile*2u+pixel/32u]);
  if((mask&(1u<<(pixel%32u)))!=0u){d=textureLoad(depth,vec2<i32>(g.xy),0);}
 }
 textureStore(destination,vec2<i32>(g.xy),vec4<f32>(d));
}
`;
