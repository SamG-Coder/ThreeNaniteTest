import {visibilityWGSL} from './shaders.js';
// Texture and smooth-normal reconstruction happens only for the winning ID.
// The ID raster, HZB rejection and atomic coverage protocol are unchanged.
export const landscapeVisibilityWGSL=visibilityWGSL
.replace('info:vec4<u32> };\nstruct Triangle','info:vec4<u32>, wa:vec3<f32>, wb:vec3<f32>, wc:vec3<f32>, na:vec3<f32>, nb:vec3<f32>, nc:vec3<f32>, surface:f32 };\nstruct Triangle')
.replace('vec4<u32>(id,0u,lod,cluster+instance*131u));','vec4<u32>(id,0u,lod,cluster+instance*131u),a.xyz,b.xyz,c.xyz,(world*vec4<f32>(v0.normal.xyz,0)).xyz,(world*vec4<f32>(v1.normal.xyz,0)).xyz,(world*vec4<f32>(v2.normal.xyz,0)).xyz,v0.normal.w);')
.replace('color=shade(t);','color=landscapeShade(s,vec2<f32>(g.xy)+.5);')+`
@group(0) @binding(22) var materialMap:texture_2d<f32>;
@group(0) @binding(23) var materialSampler:sampler;
fn textureDetail(uv:vec2<f32>,surface:f32,lod:f32)->f32{
 // Inset one half-texel at the selected mip to avoid crossing material tiles.
 let inset=exp2(lod)*.5/256.0;
 let tiled=mix(vec2<f32>(inset),vec2<f32>(1.0-inset),fract(uv));
 return textureSampleLevel(materialMap,materialSampler,vec2<f32>((tiled.x+surface)*.25,tiled.y),lod).r;
}
fn landscapeShade(s:SourceTriangle,pixel:vec2<f32>)->vec3<f32>{
 var t:Triangle;t.color=s.color;t.normal=s.normal;t.info=s.info;
 if(params.settings.y!=0u){return shade(t);}
 // Homogeneous barycentrics also work for triangles clipped at the near plane;
 // avoid dividing each source clip vertex by W before solving the weights.
 let ndc=vec2<f32>(pixel.x/f32(params.size.x)*2.0-1.0,1.0-pixel.y/f32(params.size.y)*2.0);
 let rx=vec3<f32>(s.a.x-ndc.x*s.a.w,s.b.x-ndc.x*s.b.w,s.c.x-ndc.x*s.c.w);
 let ry=vec3<f32>(s.a.y-ndc.y*s.a.w,s.b.y-ndc.y*s.b.w,s.c.y-ndc.y*s.c.w);
 let crossWeights=cross(rx,ry);let total=dot(crossWeights,vec3<f32>(1));
 if(abs(total)<1e-20){return shade(t);}
 let weights=crossWeights/total;
 let world=s.wa*weights.x+s.wb*weights.y+s.wc*weights.z;
 var normal=s.na*weights.x+s.nb*weights.y+s.nc*weights.z;
 normal=normal/max(length(normal),1e-8);
 let view=normalize(params.camera.xyz-world);
 if(s.surface>=3.0 && dot(normal,view)<0.0){normal=-normal;}
 var detail=1.0;
 if(s.surface<3.5){
  let n=abs(normal);var uv=world.xz*.7;var tangent=vec3<f32>(1,0,0);var bitangent=vec3<f32>(0,0,1);
  if(n.x>n.y){uv=world.zy*.7;tangent=vec3<f32>(0,0,1);bitangent=vec3<f32>(0,1,0);}
  if(n.z>n.y && n.z>n.x){uv=world.xy*.7;tangent=vec3<f32>(1,0,0);bitangent=vec3<f32>(0,1,0);}
  if(s.surface>1.5 && s.surface<2.5){uv*=vec2<f32>(2,.4);}
  let dist=distance(world,params.camera.xyz);
  let lod=clamp(log2(max(dist*256.0*1.4/f32(params.size.y),1.0)),0.0,6.0);
  let value=textureDetail(uv,s.surface,lod);detail=value*1.5;
  let step=exp2(lod)/256.0;
  let dx=textureDetail(uv+vec2<f32>(step,0),s.surface,lod)-value;
  let dy=textureDetail(uv+vec2<f32>(0,step),s.surface,lod)-value;
  normal=normalize(normal-(tangent*dx+bitangent*dy)*.7);
 }
 let hemi=.48+.3*clamp(normal.y*.5+.5,0.0,1.0);
 let sun=max(0.0,dot(normal,normalize(vec3<f32>(.5,1,.35))))*.85;
 let backLight=select(0.0,.16*max(0.0,-dot(normal,normalize(vec3<f32>(.5,1,.35)))),s.surface>=3.0);
 let lit=s.color.rgb*detail*(hemi+sun+backLight);
 let fog=1.0-exp(-.0018*.0018*dot(world-params.camera.xyz,world-params.camera.xyz));
 return mix(lit,vec3<f32>(.4678,.6939,.7379),fog);
}
`;
