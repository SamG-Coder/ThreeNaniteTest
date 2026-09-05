import { TILE_SIZE, MASK_WORDS, CANDIDATE_CAPACITY } from './reference.js';

export const rasterWGSL = /* wgsl */`
const TILE: u32 = ${TILE_SIZE}u;
const WORDS: u32 = ${MASK_WORDS}u;
const CAPACITY: u32 = ${CANDIDATE_CAPACITY}u;
const EMPTY: u32 = 0xffffffffu;
struct Params { matrix: mat4x4<f32>, size: vec4<u32> };
struct Triangle { a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, color: vec4<f32> };
struct Stats { overflow: atomic<u32>, covered: atomic<u32>, candidates: atomic<u32>, mismatches: atomic<u32> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> source: array<Triangle>;
@group(0) @binding(2) var<storage, read_write> projected: array<Triangle>;
@group(0) @binding(3) var<storage, read_write> tileCounts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> tileIds: array<u32>;
@group(0) @binding(5) var<storage, read_write> masks: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> stats: Stats;
@group(0) @binding(7) var depthOut: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var idOut: texture_storage_2d<r32uint, write>;
fn tilesX() -> u32 { return params.size.x / TILE; }
fn tileCount() -> u32 { return tilesX() * (params.size.y / TILE); }
fn edge(a: vec2<f32>, b: vec2<f32>, p: vec2<f32>) -> f32 {
  return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
}
fn topLeft(a: vec2<f32>, b: vec2<f32>) -> bool {
  return b.y < a.y || (b.y == a.y && b.x > a.x);
}
fn accepts(e: f32, a: vec2<f32>, b: vec2<f32>) -> bool {
  return e > 0.0 || (e == 0.0 && topLeft(a,b));
}
fn sampleDepth(t: Triangle, p: vec2<f32>) -> f32 {
  if (t.a.w == 0.0) { return -1.0; }
  let area = edge(t.a.xy,t.b.xy,t.c.xy);
  let e0 = edge(t.b.xy,t.c.xy,p);
  let e1 = edge(t.c.xy,t.a.xy,p);
  let e2 = edge(t.a.xy,t.b.xy,p);
  if (!accepts(e0,t.b.xy,t.c.xy) || !accepts(e1,t.c.xy,t.a.xy) || !accepts(e2,t.a.xy,t.b.xy)) { return -1.0; }
  let z = (e0*t.a.z+e1*t.b.z+e2*t.c.z)/area;
  if (z < 0.0 || z > 1.0) { return -1.0; }
  return z;
}
fn project(p: vec4<f32>) -> vec4<f32> {
  let clip = params.matrix * p;
  let ndc = clip.xyz / clip.w;
  return vec4<f32>((ndc.x*.5+.5)*f32(params.size.x),(.5-ndc.y*.5)*f32(params.size.y),ndc.z,1.0);
}
@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i=gid.x;
  if (i < params.size.x*params.size.y*WORDS) { atomicStore(&masks[i],0u); }
  if (i < tileCount()) { atomicStore(&tileCounts[i],0u); }
  if (i == 0u) {
    atomicStore(&stats.overflow,0u); atomicStore(&stats.covered,0u);
    atomicStore(&stats.candidates,0u); atomicStore(&stats.mismatches,0u);
  }
}
@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid: vec3<u32>) {
  let id=gid.x;
  if (id >= params.size.z) { return; }
  let inputTriangle=source[id];
  var t=Triangle(project(inputTriangle.a),project(inputTriangle.b),project(inputTriangle.c),inputTriangle.color);
  let area=edge(t.a.xy,t.b.xy,t.c.xy);
  if (abs(area)<1e-8) { t.a.w=0.0; projected[id]=t; return; }
  if (area<0.0) { let swap=t.b; t.b=t.c; t.c=swap; }
  projected[id]=t;
  let lo=min(t.a.xy,min(t.b.xy,t.c.xy));
  let hi=max(t.a.xy,max(t.b.xy,t.c.xy));
  if (hi.x<0.0 || hi.y<0.0 || lo.x>=f32(params.size.x) || lo.y>=f32(params.size.y)) { return; }
  let first=vec2<u32>(clamp(floor(lo/f32(TILE)),vec2<f32>(0.0),vec2<f32>(f32(tilesX()-1u),f32(params.size.y/TILE-1u))));
  let last=vec2<u32>(clamp(floor(hi/f32(TILE)),vec2<f32>(0.0),vec2<f32>(f32(tilesX()-1u),f32(params.size.y/TILE-1u))));
  for (var y=first.y;y<=last.y;y++) { for (var x=first.x;x<=last.x;x++) {
    let tile=y*tilesX()+x;
    let slot=atomicAdd(&tileCounts[tile],1u);
    atomicAdd(&stats.candidates,1u);
    if (slot<CAPACITY) { tileIds[tile*CAPACITY+slot]=id; }
    if (slot==CAPACITY) { atomicAdd(&stats.overflow,1u); }
  }}
}
@compute @workgroup_size(64)
fn coverage(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tile=gid.x/CAPACITY; let slot=gid.x%CAPACITY;
  if (tile>=tileCount()) { return; }
  let count=atomicLoad(&tileCounts[tile]);
  if (slot>=count || count>CAPACITY) { return; }
  let t=projected[tileIds[tile*CAPACITY+slot]];
  let origin=vec2<u32>(tile%tilesX(),tile/tilesX())*TILE;
  for (var y=0u;y<TILE;y++) { for (var x=0u;x<TILE;x++) {
    let p=origin+vec2<u32>(x,y);
    if (sampleDepth(t,vec2<f32>(p)+vec2<f32>(.5))>=0.0) {
      let index=(p.y*params.size.x+p.x)*WORDS+slot/32u;
      atomicOr(&masks[index],1u<<(slot%32u));
    }
  }}
}
@compute @workgroup_size(64)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let pixel=gid.x;
  if (pixel>=params.size.x*params.size.y) { return; }
  let coord=vec2<u32>(pixel%params.size.x,pixel/params.size.x);
  let p=vec2<f32>(coord)+vec2<f32>(.5);
  let tile=(coord.y/TILE)*tilesX()+coord.x/TILE;
  var best=1.0; var winner=EMPTY;
  if (atomicLoad(&tileCounts[tile])>CAPACITY) {
    // Correctness fallback: never drop candidates beyond the tile capacity.
    for (var id=0u;id<params.size.z;id++) {
      let z=sampleDepth(projected[id],p);
      if (z>=0.0 && (z<best || (z==best && id<winner))) { best=z; winner=id; }
    }
  } else {
    for (var word=0u;word<WORDS;word++) {
      var bits=atomicLoad(&masks[pixel*WORDS+word]);
      while (bits!=0u) {
        let bit=firstTrailingBit(bits);
        let id=tileIds[tile*CAPACITY+word*32u+bit];
        let z=sampleDepth(projected[id],p);
        if (z>=0.0 && (z<best || (z==best && id<winner))) { best=z; winner=id; }
        bits=bits&(bits-1u);
      }
    }
  }
  textureStore(depthOut,vec2<i32>(coord),vec4<f32>(best));
  textureStore(idOut,vec2<i32>(coord),vec4<u32>(winner));
  if (winner!=EMPTY) { atomicAdd(&stats.covered,1u); }
}
`;

// Validation uses sampled views of the resolve outputs, never simultaneous
// read/write storage texture bindings. Separate bind group and compute pass.
export const validateWGSL = rasterWGSL.slice(0, rasterWGSL.indexOf('@compute'))
  .replace('@group(0) @binding(7) var depthOut: texture_storage_2d<r32float, write>;', '@group(0) @binding(7) var depthIn: texture_2d<f32>;')
  .replace('@group(0) @binding(8) var idOut: texture_storage_2d<r32uint, write>;', '@group(0) @binding(8) var idIn: texture_2d<u32>;') + /* wgsl */`
@group(0) @binding(9) var mismatchOut: texture_storage_2d<r32uint, write>;
@compute @workgroup_size(64)
fn validate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x>=params.size.x*params.size.y) { return; }
  let coord=vec2<i32>(i32(gid.x%params.size.x),i32(gid.x/params.size.x));
  let p=vec2<f32>(coord)+vec2<f32>(.5);
  var best=1.0; var winner=EMPTY;
  for (var id=0u;id<params.size.z;id++) {
    let z=sampleDepth(projected[id],p);
    if (z>=0.0 && (z<best || (z==best && id<winner))) { best=z; winner=id; }
  }
  let mismatch=winner!=textureLoad(idIn,coord,0).x || best!=textureLoad(depthIn,coord,0).x;
  textureStore(mismatchOut,coord,vec4<u32>(select(0u,1u,mismatch)));
  if (mismatch) { atomicAdd(&stats.mismatches,1u); }
}
`;

export const presentWGSL = /* wgsl */`
struct Params { matrix: mat4x4<f32>, size: vec4<u32> };
struct Triangle { a: vec4<f32>, b: vec4<f32>, c: vec4<f32>, color: vec4<f32> };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var depth: texture_2d<f32>;
@group(0) @binding(2) var ids: texture_2d<u32>;
@group(0) @binding(3) var<storage, read> triangles: array<Triangle>;
@group(0) @binding(4) var<storage, read> counts: array<u32>;
@group(0) @binding(5) var<storage, read> masks: array<u32>;
@group(0) @binding(6) var mismatch: texture_2d<u32>;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vertex(@builtin(vertex_index) index:u32) -> Vertex {
  let x=f32((index<<1u)&2u); let y=f32(index&2u);
  return Vertex(vec4<f32>(x*2.0-1.0,1.0-y*2.0,0.0,1.0),vec2<f32>(x,y));
}
@fragment fn fragment(v:Vertex) -> @location(0) vec4<f32> {
  let p=min(vec2<u32>(v.uv*vec2<f32>(params.size.xy)),params.size.xy-vec2<u32>(1u));
  let coord=vec2<i32>(p); let id=textureLoad(ids,coord,0).x;
  let tile=(p.y/8u)*(params.size.x/8u)+p.x/8u;
  var color=vec3<f32>(.025,.035,.055);
  if (id!=0xffffffffu) { color=triangles[id].color.rgb; }
  if (params.size.w==1u && id!=0xffffffffu) {
    color=fract(sin(vec3<f32>(f32(id)+1.0)*vec3<f32>(12.9898,78.233,39.425))*43758.5453)*.8+.2;
  }
  if (params.size.w==2u) { color=vec3<f32>(clamp((1.0-textureLoad(depth,coord,0).x)*30.0,0.0,1.0)); }
  if (params.size.w==3u) {
    var hits=0u;
    for (var word=0u;word<4u;word++) { hits+=countOneBits(masks[(p.y*params.size.x+p.x)*4u+word]); }
    let heat=f32(hits)/32.0;
    color=vec3<f32>(min(heat,1.0),min(heat*.5,1.0),.12);
    if (counts[tile]>128u) { color=vec3<f32>(1.0,0.0,.7); }
  }
  if (params.size.w==4u) {
    color=mix(color,vec3<f32>(.1,.6,.25),.35);
    if (counts[tile]>128u) { color=vec3<f32>(1.0,0.0,.7); }
  }
  if (params.size.w==5u) {
    color=vec3<f32>(.02,.12,.07);
    if (textureLoad(mismatch,coord,0).x!=0u) { color=vec3<f32>(1.0,.05,.02); }
  }
  return vec4<f32>(color,1.0);
}
`;
