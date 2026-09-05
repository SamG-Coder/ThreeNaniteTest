import {visibilityWGSL} from './shaders.js';
// Texture and smooth-normal reconstruction happens only for the winning ID.
// The ID raster, HZB rejection and atomic coverage protocol are unchanged.
export const landscapeVisibilityWGSL=visibilityWGSL
.replace('struct Vertex { position:vec4<f32>, normal:vec4<f32>, color:vec4<f32> };','struct Vertex { position:vec4<f32>, normal:vec4<f32>, color:vec4<f32>, uv:vec4<f32> };')
.replace('info:vec4<u32> };\nstruct Triangle','info:vec4<u32>, wa:vec3<f32>, wb:vec3<f32>, wc:vec3<f32>, na:vec3<f32>, nb:vec3<f32>, nc:vec3<f32>, surface:f32, ua:vec2<f32>, ub:vec2<f32>, uc:vec2<f32>, ca:vec3<f32>, cb:vec3<f32>, cc:vec3<f32> };\nstruct Triangle')
.replace('vec4<u32>(id,0u,lod,cluster+instance*131u));','vec4<u32>(id,0u,lod,cluster+instance*131u),a.xyz,b.xyz,c.xyz,(world*vec4<f32>(v0.normal.xyz,0)).xyz,(world*vec4<f32>(v1.normal.xyz,0)).xyz,(world*vec4<f32>(v2.normal.xyz,0)).xyz,v0.normal.w,v0.uv.xy,v1.uv.xy,v2.uv.xy,v0.color.rgb,v1.color.rgb,v2.color.rgb);')
.replace('@interpolate(flat) id:u32 };','@interpolate(flat) id:u32, @location(1) bary:vec2<f32> };')
.replace('return VOut(p,id);','let corner=vi%3u;return VOut(p,id,vec2<f32>(select(0.0,1.0,corner==0u),select(0.0,1.0,corner==1u)));')
.replace('@fragment fn fragmentMain(input:VOut)->@location(0) u32{return input.id;}','struct VisibilityOut { @location(0) id:u32, @location(1) bary:vec2<f32> }; @fragment fn fragmentMain(input:VOut)->VisibilityOut{return VisibilityOut(input.id,input.bary);}')
.replace('color=shade(t);','color=landscapeShade(s,vec2<f32>(g.xy)+.5);')+`
@group(0) @binding(22) var materialMap:texture_2d_array<f32>;
@group(0) @binding(23) var materialSampler:sampler;
@group(0) @binding(24) var barycentrics:texture_2d<f32>;
fn rasterWeights(pixel:vec2<f32>)->vec3<f32>{let b=textureLoad(barycentrics,vec2<i32>(pixel),0).xy;return vec3<f32>(b,1.0-b.x-b.y);}
fn textureDetail(uv:vec2<f32>,surface:f32,lod:f32)->f32{
 return textureSampleLevel(materialMap,materialSampler,uv,i32(surface),lod).r;
}
fn surfaceWeights(s:SourceTriangle,pixel:vec2<f32>)->vec3<f32>{
 // Solve in homogeneous space: preserves perspective and near-plane crossings.
 let ndc=vec2<f32>(pixel.x/f32(params.size.x)*2.0-1.0,1.0-pixel.y/f32(params.size.y)*2.0);
 let rx=vec3<f32>(s.a.x-ndc.x*s.a.w,s.b.x-ndc.x*s.b.w,s.c.x-ndc.x*s.c.w);
 let ry=vec3<f32>(s.a.y-ndc.y*s.a.w,s.b.y-ndc.y*s.b.w,s.c.y-ndc.y*s.c.w);
 let w=cross(rx,ry);let total=dot(w,vec3<f32>(1));
 if(abs(total)<1e-20){return vec3<f32>(1.0/3.0);}
 return w/total;
}
fn surfaceUV(s:SourceTriangle,w:vec3<f32>)->vec2<f32>{return s.ua*w.x+s.ub*w.y+s.uc*w.z;}
fn landscapeShade(s:SourceTriangle,pixel:vec2<f32>)->vec3<f32>{
 var t:Triangle;t.color=s.color;t.normal=s.normal;t.info=s.info;
 if(params.settings.y!=0u){return shade(t);}
 let weights=rasterWeights(pixel);
 let world=s.wa*weights.x+s.wb*weights.y+s.wc*weights.z;
 var normal=s.na*weights.x+s.nb*weights.y+s.nc*weights.z;
 normal=normal/max(length(normal),1e-8);
 let view=normalize(params.camera.xyz-world);
 if(s.surface>=3.0 && dot(normal,view)<0.0){normal=-normal;}
 var detail=1.0;
 if(s.surface<3.5){
  let uv=surfaceUV(s,weights);
  // Compute-stage derivatives come from this triangle at adjacent pixel centres,
  // not from a neighbour's triangle ID and not a camera-distance guess.
  let analyticUV=surfaceUV(s,surfaceWeights(s,pixel));
  let duvdx=surfaceUV(s,surfaceWeights(s,pixel+vec2<f32>(1,0)))-analyticUV;
  let duvdy=surfaceUV(s,surfaceWeights(s,pixel+vec2<f32>(0,1)))-analyticUV;
  let footprint=max(length(duvdx*256.0),length(duvdy*256.0));
  let lod=clamp(log2(max(footprint,1.0)),0.0,8.0);
  let e1=s.wb-s.wa;let e2=s.wc-s.wa;let uv1=s.ub-s.ua;let uv2=s.uc-s.ua;
  let determinant=uv1.x*uv2.y-uv1.y*uv2.x;
  var tangent=vec3<f32>(0);var bitangent=vec3<f32>(0);
  if(abs(determinant)>1e-10){
   let tu=(e1*uv2.y-e2*uv1.y)/determinant;let tv=(e2*uv1.x-e1*uv2.x)/determinant;
   tangent=tu/max(length(tu),1e-8);bitangent=tv/max(length(tv),1e-8);
  }
  let value=textureDetail(uv,s.surface,lod);detail=value*1.5;
  let step=exp2(lod)/256.0;
  let dx=textureDetail(uv+vec2<f32>(step,0),s.surface,lod)-value;
  let dy=textureDetail(uv+vec2<f32>(0,step),s.surface,lod)-value;
  normal=normalize(normal-(tangent*dx+bitangent*dy)*.7);
 }
 let hemi=.48+.3*clamp(normal.y*.5+.5,0.0,1.0);
 let sun=max(0.0,dot(normal,normalize(vec3<f32>(.5,1,.35))))*.85;
 let backLight=select(0.0,.16*max(0.0,-dot(normal,normalize(vec3<f32>(.5,1,.35)))),s.surface>=3.0);
 let albedo=s.ca*weights.x+s.cb*weights.y+s.cc*weights.z;
 let lit=albedo*detail*(hemi+sun+backLight);
 let fog=1.0-exp(-.0018*.0018*dot(world-params.camera.xyz,world-params.camera.xyz));
 return mix(lit,vec3<f32>(.4678,.6939,.7379),fog);
}
`;
