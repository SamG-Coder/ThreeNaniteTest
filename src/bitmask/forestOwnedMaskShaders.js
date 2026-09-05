// Forest renderer: linked tile candidates, 32-triangle mask batches, and one
// depth/ID owner per pixel. Hardware never resolves terrain/tree visibility.
export const forestOwnedMaskWGSL = /* wgsl */`
const EMPTY:u32=0xffffffffu;
struct Params {
  matrix:mat4x4<f32>, camera:vec4<f32>, size:vec4<u32>, ranges:vec4<u32>, settings:vec4<u32>
};
struct Vertex { position:vec4<f32>, normal:vec4<f32>, color:vec4<f32> };
struct SourceTriangle { a:vec4<f32>, b:vec4<f32>, c:vec4<f32>, color:vec4<f32>, normal:vec4<f32>, info:vec4<u32> };
struct Triangle { a:vec4<f32>, b:vec4<f32>, c:vec4<f32>, d:vec4<f32>, color:vec4<f32>, normal:vec4<f32>, info:vec4<u32> };
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<storage,read> av:array<Vertex>;
@group(0) @binding(2) var<storage,read> ai:array<u32>;
@group(0) @binding(3) var<storage,read> am:array<mat4x4<f32>>;
@group(0) @binding(4) var<storage,read> al:array<vec2<u32>>;
@group(0) @binding(5) var<storage,read> bv:array<Vertex>;
@group(0) @binding(6) var<storage,read> bi:array<u32>;
@group(0) @binding(7) var<storage,read> bm:array<mat4x4<f32>>;
@group(0) @binding(8) var<storage,read> bl:array<vec2<u32>>;
// Two words per tile: list head and overflow marker.
@group(0) @binding(9) var<storage,read_write> heads:array<atomic<u32>>;
// Each pool entry stores triangle ID and next entry.
@group(0) @binding(10) var<storage,read_write> entries:array<vec2<u32>>;
// Counts copied from Three compute: terrain, trees, allocated, overflow tiles,
// covered pixels, processed batches, reserved, reserved.
@group(0) @binding(11) var<storage,read_write> control:array<atomic<u32>>;
@group(0) @binding(12) var depthOut:texture_storage_2d<r32float,write>;
@group(0) @binding(13) var idOut:texture_storage_2d<r32uint,write>;
@group(0) @binding(14) var colorOut:texture_storage_2d<rgba16float,write>;
fn sourceTriangle(id:u32)->SourceTriangle {
  let local=id&0x7fffffffu;
  let slot=local/64u; let corner=(local%64u)*3u;
  var v0:Vertex; var v1:Vertex; var v2:Vertex; var world:mat4x4<f32>; var cluster:u32; var instance:u32; var lod:u32;
  if ((id&0x80000000u)==0u) {
    let visible=al[slot]; cluster=visible.y; instance=visible.x; world=am[instance];
    let base=cluster*192u+corner; v0=av[ai[base]]; v1=av[ai[base+1u]]; v2=av[ai[base+2u]];
    lod=ai[params.ranges.z+cluster];
  } else {
    let visible=bl[slot]; cluster=visible.y; instance=visible.x; world=bm[instance];
    let base=cluster*192u+corner; v0=bv[bi[base]]; v1=bv[bi[base+1u]]; v2=bv[bi[base+2u]];
    lod=bi[params.ranges.w+cluster];
  }
  let a=world*v0.position; let b=world*v1.position; let c=world*v2.position;
  let rawNormal=(world*vec4<f32>((v0.normal+v1.normal+v2.normal).xyz,0.0)).xyz;
  let n=rawNormal/max(length(rawNormal),1e-8);
  return SourceTriangle(params.matrix*a,params.matrix*b,params.matrix*c,
    (v0.color+v1.color+v2.color)/3.0,vec4<f32>(n,distance((a.xyz+b.xyz+c.xyz)/3.0,params.camera.xyz)),
    vec4<u32>(id,0u,lod,cluster+instance*131u));
}
fn screen(p:vec4<f32>)->vec4<f32> {
  let ndc=p.xyz/p.w;
  return vec4<f32>((ndc.x*.5+.5)*f32(params.size.x),(.5-ndc.y*.5)*f32(params.size.y),ndc.z,1.0);
}
fn edge(a:vec2<f32>,b:vec2<f32>,p:vec2<f32>)->f32 {
  return (b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x);
}
fn makeTriangle(id:u32)->Triangle {
  let s=sourceTriangle(id);
  let inputPoints=array<vec4<f32>,3>(s.a,s.b,s.c);
  var clipped:array<vec4<f32>,4>; var count=0u;
  // Clip in homogeneous coordinates against WebGPU's z >= 0 near plane.
  // This keeps W positive for the app's finite perspective camera.
  for(var i=0u;i<3u;i++) {
    let a=inputPoints[i];let b=inputPoints[(i+1u)%3u];
    if(a.z>=0.0) { clipped[count]=a;count++; }
    if((a.z>0.0 && b.z<0.0)||(a.z<0.0 && b.z>0.0)) {
      var intersection=mix(a,b,a.z/(a.z-b.z));intersection.z=0.0;clipped[count]=intersection;count++;
    }
  }
  var t:Triangle;t.info=s.info;t.color=s.color;t.normal=s.normal;
  if(count<3u) { return t; }
  t.a=screen(clipped[0]);t.b=screen(clipped[1]);t.c=screen(clipped[2]);t.d=t.c;
  if(count==4u) {t.d=screen(clipped[3]);}
  let area=edge(t.a.xy,t.b.xy,t.c.xy);
  // Three's front faces are CCW in NDC, hence negative area with screen Y down.
  if(area>=-1e-8) { return t; }
  t.info.y=count;
  return t;
}
fn inclusive(e:f32,a:vec2<f32>,b:vec2<f32>)->bool {
  return e>0.0 || (e==0.0 && (b.y<a.y || (b.y==a.y && b.x>a.x)));
}
fn sampleFan(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,p:vec2<f32>)->f32 {
  // Reverse front-face winding for the positive-area top-left rule.
  let area=edge(a.xy,c.xy,b.xy);
  if(area<=1e-8) {return -1.0;}
  let e0=edge(c.xy,b.xy,p);let e1=edge(b.xy,a.xy,p);let e2=edge(a.xy,c.xy,p);
  if(!inclusive(e0,c.xy,b.xy)||!inclusive(e1,b.xy,a.xy)||!inclusive(e2,a.xy,c.xy)) {return -1.0;}
  let z=(e0*a.z+e1*c.z+e2*b.z)/area;
  if(z<0.0||z>1.0) {return -1.0;}
  return z;
}
fn sampleDepth(t:Triangle,p:vec2<f32>)->f32 {
  if(t.info.y<3u) {return -1.0;}
  let z=sampleFan(t.a,t.b,t.c,p);
  if(z>=0.0 || t.info.y==3u) {return z;}
  return sampleFan(t.a,t.c,t.d,p);
}
// Coverage only: depth interpolation is deferred until a pixel resolves a hit.
fn coversFan(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,p:vec2<f32>)->bool {
  if(edge(a.xy,c.xy,b.xy)<=1e-8){return false;}
  return inclusive(edge(c.xy,b.xy,p),c.xy,b.xy)
    && inclusive(edge(b.xy,a.xy,p),b.xy,a.xy)
    && inclusive(edge(a.xy,c.xy,p),a.xy,c.xy);
}
fn covers(t:Triangle,p:vec2<f32>)->bool {
  if(t.info.y<3u){return false;}
  if(coversFan(t.a,t.b,t.c,p)){return true;}
  return t.info.y==4u && coversFan(t.a,t.c,t.d,p);
}
fn aCount()->u32 {return min(atomicLoad(&control[0]),params.ranges.x)*64u;}
fn bCount()->u32 {return min(atomicLoad(&control[1]),params.ranges.y)*64u;}
fn globalId(index:u32)->u32 {
  let count=aCount();if(index<count){return index;}return 0x80000000u|(index-count);
}
@compute @workgroup_size(64)
fn clear(@builtin(global_invocation_id) gid:vec3<u32>) {
  if(gid.x<params.size.w) {atomicStore(&heads[gid.x*2u],EMPTY);atomicStore(&heads[gid.x*2u+1u],0u);}
  if(gid.x>=2u&&gid.x<8u) {atomicStore(&control[gid.x],0u);}
}
@compute @workgroup_size(64)
fn bin(@builtin(global_invocation_id) gid:vec3<u32>) {
  let triangleIndex=gid.x+gid.y*params.settings.w*64u;
  if(triangleIndex>=aCount()+bCount()) {return;}
  let id=globalId(triangleIndex);let t=makeTriangle(id);
  if(t.info.y<3u) {return;}
  let lo=min(min(t.a.xy,t.b.xy),min(t.c.xy,t.d.xy));
  let hi=max(max(t.a.xy,t.b.xy),max(t.c.xy,t.d.xy));
  if(hi.x<0.0||hi.y<0.0||lo.x>=f32(params.size.x)||lo.y>=f32(params.size.y)) {return;}
  let maxTile=vec2<f32>(f32(params.size.z-1u),f32((params.size.y+7u)/8u-1u));
  let first=vec2<u32>(clamp(floor(lo/8.0),vec2<f32>(0.0),maxTile));
  let last=vec2<u32>(clamp(floor(hi/8.0),vec2<f32>(0.0),maxTile));
  for(var y=first.y;y<=last.y;y++){for(var x=first.x;x<=last.x;x++){
    let tile=y*params.size.z+x;
    var entry=params.settings.x;
    if(atomicLoad(&control[2])<params.settings.x){entry=atomicAdd(&control[2],1u);}
    if(entry<params.settings.x){
      let previous=atomicExchange(&heads[tile*2u],entry);
      entries[entry]=vec2<u32>(id,previous);
    }else{
      if(atomicExchange(&heads[tile*2u+1u],1u)==0u){atomicAdd(&control[3],1u);}
    }
  }}
}
fn hashColor(value:u32)->vec3<f32>{
  var id=value*747796405u+289559509u;id=((id>>16u)^id)*277803737u;id=(id>>16u)^id;
  return vec3<f32>(f32(id&255u),f32((id>>8u)&255u),f32((id>>16u)&255u))/255.0*.72+.18;
}
fn shade(t:Triangle)->vec3<f32>{
  if(params.settings.y==1u){return hashColor(t.info.w);}
  if(params.settings.y==2u){return hashColor((t.info.z+1u)*7919u);}
  if(params.settings.y==3u){return t.normal.xyz*.5+.5;}
  let hemi=.55+.45*clamp(t.normal.y*.5+.5,0.0,1.0);
  let sun=max(0.0,dot(t.normal.xyz,normalize(vec3<f32>(.5,1.0,.35))))*.85;
  let lit=t.color.rgb*(hemi+sun);
  let fog=1.0-exp(-.0018*.0018*t.normal.w*t.normal.w);
  return mix(lit,vec3<f32>(.4678,.6939,.7379),fog);
}
var<workgroup> batchIds:array<u32,32>;
var<workgroup> batchTriangles:array<Triangle,32>;
// Each triangle owns two words covering the tile's 64 pixels. No atomics.
var<workgroup> triangleMasks:array<vec2<u32>,32>;
var<workgroup> nextEntry:u32;
var<workgroup> scanCursor:u32;
var<workgroup> batchCount:u32;
@compute @workgroup_size(64)
fn raster(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_id) local:vec3<u32>){
  let tile=group.y*params.size.z+group.x;
  let coord=vec2<u32>(group.x*8u+local.x%8u,group.y*8u+local.x/8u);
  let point=vec2<f32>(coord)+vec2<f32>(.5);
  // Every invocation reaches every barrier, including the partial edge tiles.
  var best=1.0;var winner=EMPTY;var color=vec3<f32>(0.0);
  if(local.x==0u){nextEntry=atomicLoad(&heads[tile*2u]);scanCursor=0u;}
  workgroupBarrier();
  loop{
    if(local.x==0u){
      batchCount=0u;
      if(atomicLoad(&heads[tile*2u+1u])!=0u){
        // Pool exhaustion stays entirely in software. Slower, but complete.
        let total=aCount()+bCount();
        for(var i=0u;i<32u && scanCursor<total;i++){
          batchIds[i]=globalId(scanCursor);scanCursor++;batchCount++;
        }
      }else{
        for(var i=0u;i<32u && nextEntry!=EMPTY;i++){
          let entry=entries[nextEntry];batchIds[i]=entry.x;nextEntry=entry.y;batchCount++;
        }
      }
      if(batchCount>0u){atomicAdd(&control[5],1u);}
    }
    let count=workgroupUniformLoad(&batchCount);
    if(count==0u){break;}
    if(local.x<count){
      // Only this invocation needs its triangle until publication below.
      // Setup and coverage therefore share one phase and one final barrier.
      let t=makeTriangle(batchIds[local.x]);
      batchTriangles[local.x]=t;
      var mask=vec2<u32>(0u);
      if(t.info.y>=3u){
        let origin=vec2<i32>(group.xy*8u);
        let lo=max(origin,vec2<i32>(ceil(min(min(t.a.xy,t.b.xy),min(t.c.xy,t.d.xy))-vec2<f32>(.5))));
        let hi=min(min(origin+vec2<i32>(7),vec2<i32>(params.size.xy)-vec2<i32>(1)),
          vec2<i32>(floor(max(max(t.a.xy,t.b.xy),max(t.c.xy,t.d.xy))-vec2<f32>(.5))));
        for(var y=lo.y;y<=hi.y;y++){for(var x=lo.x;x<=hi.x;x++){
          if(covers(t,vec2<f32>(f32(x)+.5,f32(y)+.5))){
            let pixel=u32(y-origin.y)*8u+u32(x-origin.x);
            mask[pixel>>5u]=mask[pixel>>5u]|(1u<<(pixel&31u));
          }
        }}
      }
      triangleMasks[local.x]=mask;
    }
    workgroupBarrier();
    // Transpose the small masks into a private candidate word. Read only the
    // half covering this pixel; unused batch slots are never inspected.
    var bits=0u;
    let pixelBit=1u<<(local.x&31u);
    for(var candidate=0u;candidate<count;candidate++){
      if((triangleMasks[candidate][local.x>>5u]&pixelBit)!=0u){bits=bits|(1u<<candidate);}
    }
    while(bits!=0u){
      let bit=firstTrailingBit(bits);let t=batchTriangles[bit];let z=sampleDepth(t,point);
      if(z>=0.0 && (z<best || (z==best && t.info.x<winner))){best=z;winner=t.info.x;color=shade(t);}
      bits=bits&(bits-1u);
    }
    workgroupBarrier();
  }
  if(coord.x<params.size.x && coord.y<params.size.y){
    textureStore(depthOut,vec2<i32>(coord),vec4<f32>(best));
    textureStore(idOut,vec2<i32>(coord),vec4<u32>(winner));
    textureStore(colorOut,vec2<i32>(coord),vec4<f32>(color,1.0));
    if(winner!=EMPTY){atomicAdd(&control[4],1u);}
  }
}
`;
