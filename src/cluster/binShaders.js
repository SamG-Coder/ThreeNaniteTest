export const brickBinWGSL=`
struct Params {matrix:mat4x4<f32>,camera:vec4<f32>,size:vec4<u32>,ranges:vec4<u32>,settings:vec4<u32>};
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(2) var<storage,read> ai:array<u32>;
@group(0) @binding(4) var<storage,read> al:array<vec2<u32>>;
@group(0) @binding(6) var<storage,read> bi:array<u32>;
@group(0) @binding(8) var<storage,read> bl:array<vec2<u32>>;
@group(0) @binding(9) var<storage,read> inputList:array<u32>;
@group(0) @binding(11) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(26) var<storage,read_write> triangles:array<u32>;
@group(0) @binding(27) var<storage,read_write> bricks:array<u32>;
@group(0) @binding(28) var<storage,read_write> args:array<atomic<u32>>;
@group(0) @binding(29) var<uniform> phase:vec4<u32>;
@compute @workgroup_size(1) fn clearBins(){for(var i=0u;i<8u;i++){atomicStore(&args[i],0u);}atomicStore(&args[0],192u);atomicStore(&args[4],48u);}
@compute @workgroup_size(64) fn binGeometry(@builtin(global_invocation_id) g:vec3<u32>){
 let index=g.x+g.y*params.settings.w*64u;if(index>=atomicLoad(&counters[2u+phase.x])){return;}
 let id=inputList[index];let slot=id&0x7fffffffu;var kind:u32;
 if((id&0x80000000u)==0u){kind=ai[al[slot].y*4u+3u];}else{kind=bi[bl[slot].y*4u+3u];}
 if(kind==1u){let out=atomicAdd(&args[5],1u);bricks[out]=id;atomicAdd(&counters[7],1u);}
 else{let out=atomicAdd(&args[1],1u);triangles[out]=id;atomicAdd(&counters[6],1u);}
}
`;
