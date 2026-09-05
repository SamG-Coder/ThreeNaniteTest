import { forestReferenceWGSL } from './forestReferenceShaders.js';

// Keep the reference coverage/depth algorithm; reject only bounding boxes
// containing no pixel centres before allocating any tile entries.
const marker = '  let maxTile=vec2<f32>';
if (forestReferenceWGSL.split(marker).length !== 2) throw new Error('Binning marker changed');
export const forestBoundedWGSL = forestReferenceWGSL.replace(marker,
  '  if(any(ceil(lo-vec2<f32>(.5))>floor(hi-vec2<f32>(.5)))){return;}\n' + marker);

// Separate STORAGE/INDIRECT buffer: control remains storage in the bin pass.
// One workgroup per selected cluster (64 triangle slots); preserve the bin
// shader's fixed row stride when dispatch spills into a second dimension.
export const forestDispatchWGSL = `
struct Params { vp:mat4x4<f32>, camera:vec4<f32>, size:vec4<u32>, ranges:vec4<u32>, settings:vec4<u32> }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> control:array<u32>;
@group(0) @binding(2) var<storage,read_write> args:array<u32>;
@compute @workgroup_size(1) fn prepareDispatch(){
  let count=min(control[0],params.ranges.x)+min(control[1],params.ranges.y);
  let width=max(params.settings.w,1u);
  args[0]=min(count,width);
  args[1]=max((count+width-1u)/width,1u);
  args[2]=1u;
}
`;
