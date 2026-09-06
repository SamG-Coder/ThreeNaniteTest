export const clusterSelectionWGSL=`
struct Params{matrix:mat4x4<f32>,camera:vec4<f32>,size:vec4<u32>,ranges:vec4<u32>,settings:vec4<u32>};
struct Selection{planes:array<vec4<f32>,6>,limits:vec4<u32>,quality:vec4<f32>};
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> nodes:array<vec4<f32>>;
@group(0) @binding(2) var<storage,read> bounds:array<vec4<f32>>;
@group(0) @binding(3) var<storage,read> instances:array<vec4<f32>>;
@group(0) @binding(4) var<storage,read_write> worlds:array<mat4x4<f32>>;
@group(0) @binding(5) var<storage,read_write> inputQueue:array<vec2<u32>>;
@group(0) @binding(6) var<storage,read_write> outputQueue:array<vec2<u32>>;
@group(0) @binding(7) var<storage,read_write> counts:array<atomic<u32>>;
@group(0) @binding(8) var<storage,read_write> selected:array<vec2<u32>>;
@group(0) @binding(9) var<storage,read_write> visible:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> demand:array<atomic<u32>>;
@group(0) @binding(11) var<uniform> settings:Selection;
@compute @workgroup_size(64) fn initialize(@builtin(global_invocation_id) g:vec3<u32>){
 let i=g.x;
 if(i==0u){atomicStore(&counts[0],settings.limits.x);atomicStore(&counts[1],0u);atomicStore(&counts[7],0u);atomicStore(&visible[0],0u);}
 if(i<settings.limits.z+6u){atomicStore(&demand[i],0u);}
 if(i>=settings.limits.x){return;}
 let data=instances[i];let angle=f32(i)*.61803398875;let c=cos(angle)*data.w;let s=sin(angle)*data.w;
 worlds[i]=mat4x4<f32>(vec4<f32>(c,0,s,0),vec4<f32>(0,data.w,0,0),vec4<f32>(-s,0,c,0),vec4<f32>(data.xyz,1));inputQueue[i]=vec2<u32>(0,i);
}
@compute @workgroup_size(1) fn prepareLevel(){let count=min(atomicLoad(&counts[0]),settings.limits.y);atomicStore(&counts[2],(count+63u)/64u);atomicStore(&counts[3],1u);atomicStore(&counts[4],1u);atomicStore(&counts[1],0u);}
@compute @workgroup_size(1) fn advanceLevel(){atomicStore(&counts[0],atomicLoad(&counts[1]));}
fn visibleSphere(center:vec3<f32>,radius:f32)->bool{for(var i=0u;i<6u;i++){let plane=settings.planes[i];if(dot(plane.xyz,center)+plane.w < -radius){return false;}}return true;}
@compute @workgroup_size(64) fn traverse(@builtin(global_invocation_id) g:vec3<u32>){
 if(g.x>=min(atomicLoad(&counts[0]),settings.limits.y)){return;}
 let item=inputQueue[g.x];let node=item.x;let instance=item.y;let world=worlds[instance];let scale=instances[instance].w;
 let sphere=bounds[node];let center=(world*vec4<f32>(sphere.xyz,1)).xyz;let radius=sphere.w*scale;
 if(!visibleSphere(center,radius)){return;}
 let geometry=nodes[node*6u];let traversal=nodes[node*6u+1u];
 let factor=settings.quality.x/max(.01,(params.matrix*vec4<f32>(center,1)).w-radius);
 let refine=geometry.x*scale*factor>settings.quality.y;
 if(refine){atomicMax(&demand[node+6u],u32(clamp(factor*scale*256.0,1.0,4294967040.0)));}
 let children=u32(traversal.y);
 if(refine&&children>0u){
  let first=atomicAdd(&counts[1],children);
  if(first+children<=settings.limits.y){var child=node+1u;for(var i=0u;i<children;i++){outputQueue[first+i]=vec2<u32>(child,instance);child=u32(nodes[child*6u+1u].x);}return;}
  atomicStore(&counts[7],1u);
 }
 for(var i=0u;i<u32(geometry.z);i++){
  let cluster=u32(geometry.y)+i;let local=bounds[settings.limits.z+cluster];let position=(world*vec4<f32>(local.xyz,1)).xyz;
  if(!visibleSphere(position,local.w*scale)){continue;}
  let slot=atomicAdd(&visible[0],1u);if(slot<settings.limits.w){selected[slot]=vec2<u32>(instance,cluster);}else{atomicStore(&counts[7],1u);}
  atomicAdd(&demand[min(5u,u32(traversal.z))],1u);
 }
}
`;
