// Local front-to-back ordering. Bounded 64-cluster runs avoid a global sort or
// CPU readback. This is an experiment, not Epic's global voxel depth buckets.
export const depthOrderWGSL=`
struct Params {matrix:mat4x4<f32>,camera:vec4<f32>,size:vec4<u32>,ranges:vec4<u32>,settings:vec4<u32>};
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> boundsA:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> boundsB:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> worldsA:array<mat4x4<f32>>;
@group(0) @binding(4) var<storage,read> selectedA:array<vec2<u32>>;
@group(0) @binding(7) var<storage,read> worldsB:array<mat4x4<f32>>;
@group(0) @binding(8) var<storage,read> selectedB:array<vec2<u32>>;
@group(0) @binding(11) var<storage,read> counters:array<u32>;
@group(0) @binding(18) var<storage,read_write> seedList:array<u32>;
@group(0) @binding(19) var<storage,read_write> recoveryList:array<u32>;
var<workgroup> keys:array<f32,64>;
var<workgroup> ids:array<u32,64>;
fn order(lane:u32,group:vec3<u32>,recovery:bool){
 let start=(group.x+group.y*params.settings.w)*64u;
 let count=select(counters[2],counters[3],recovery);
 let index=start+lane;var id=0xffffffffu;var key=3.402823e38;
 if(index<count){
  if(recovery){id=recoveryList[index];}else{id=seedList[index];}
  let slot=id&0x7fffffffu;var sphere:vec4<f32>;var world:mat4x4<f32>;
  if((id&0x80000000u)==0u){let v=selectedA[slot];sphere=boundsA[v.y];world=worldsA[v.x];}
  else{let v=selectedB[slot];sphere=boundsB[v.y];world=worldsB[v.x];}
  let centre=(world*vec4<f32>(sphere.xyz,1.0)).xyz;
  key=max(0.0,distance(centre,params.camera.xyz)-sphere.w*length(world[0].xyz));
 }
 keys[lane]=key;ids[lane]=id;workgroupBarrier();
 for(var size=2u;size<=64u;size*=2u){
  for(var step=size/2u;step>0u;step/=2u){
   let other=lane^step;
   let myKey=keys[lane];let myId=ids[lane];let otherKey=keys[other];let otherId=ids[other];
   let greater=myKey>otherKey||(myKey==otherKey&&myId>otherId);
   let lesser=myKey<otherKey||(myKey==otherKey&&myId<otherId);
   let ascending=(lane&size)==0u;let low=lane<other;
   let exchange=select(lesser,greater,ascending==low);
   workgroupBarrier();
   if(exchange){keys[lane]=otherKey;ids[lane]=otherId;}
   workgroupBarrier();
  }
 }
 if(index<count){if(recovery){recoveryList[index]=ids[lane];}else{seedList[index]=ids[lane];}}
}
@compute @workgroup_size(64) fn orderSeed(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){order(lane,group,false);}
@compute @workgroup_size(64) fn orderRecovery(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){order(lane,group,true);}
`;
