import {texturedPagedWGSL} from '../streaming/texturedPages.js';
// Triangle visibility keeps the hardware path. Brick visibility uses separate
// bins and fragment ray traversal; the atomic coverage/HZB protocol is shared.
const brickFunctions=`
@group(0) @binding(25) var<uniform> inverseViewProjection:mat4x4<f32>;
fn clusterRecord(id:u32)->vec4<u32>{let slot=(id&0x7fffffffu)/64u;if((id&0x80000000u)==0u){let v=al[slot];return vec4<u32>(ai[v.y*4u],ai[v.y*4u+3u],v.x,0u);}let v=bl[slot];return vec4<u32>(bi[v.y*4u],bi[v.y*4u+3u],v.x,1u);}
fn stableCluster(id:u32)->u32{let slot=(id&0x7fffffffu)/64u;var v=al[slot];if((id&0x80000000u)!=0u){v=bl[slot];}return (v.x*1597334677u)^(v.y*3812015801u)^(id&0x80000000u);}
fn word(asset:u32,o:u32)->u32{if(asset==0u){return av[o];}return bv[o];}
fn scalar(asset:u32,o:u32)->f32{return bitcast<f32>(word(asset,o));}
fn worldFor(r:vec4<u32>)->mat4x4<f32>{if(r.w==0u){return am[r.z];}return bm[r.z];}
fn vector3(asset:u32,o:u32)->vec3<f32>{return vec3<f32>(scalar(asset,o),scalar(asset,o+1u),scalar(asset,o+2u));}
fn unpack3(w:u32,bits:u32)->vec3<f32>{let mask=(1u<<bits)-1u;return vec3<f32>(f32(w&mask),f32((w>>bits)&mask),f32((w>>(bits*2u))&mask))/f32(mask);}
fn random3(seed:u32)->vec3<f32>{var h=seed*747796405u+2891336453u;h=(h^(h>>16u))*2246822519u;return unpack3(h,10u)*2.0-1.0;}
@vertex fn brickVertex(@builtin(vertex_index) vi:u32,@builtin(instance_index) instance:u32)->VOut{
 let cluster=drawList[instance];let brick=vi/6u;let id=(cluster&0x80000000u)|((cluster&0x7fffffffu)*64u+brick);
 let r=clusterRecord(id);let count=word(r.w,r.x+1u);
 if(brick>=count){return VOut(vec4<f32>(2,2,2,1),id,vec2<f32>(0));}
 let o=r.x+16u+brick*8u;let origin=vector3(r.w,o);let size=scalar(r.w,o+3u)*4.0;let world=worldFor(r);
 var lo=vec2<f32>(1e30);var hi=vec2<f32>(-1e30);var crosses=false;
 for(var i=0u;i<8u;i++){
  let sign=vec3<f32>(f32(i&1u),f32((i>>1u)&1u),f32((i>>2u)&1u));let p=params.matrix*world*vec4<f32>(origin+sign*size,1);
  if(p.w<=0.0||p.z<=0.0){crosses=true;}else{lo=min(lo,p.xy/p.w);hi=max(hi,p.xy/p.w);}
 }
 if(crosses){lo=vec2<f32>(-1);hi=vec2<f32>(1);}
 lo=clamp(lo-2.0/vec2<f32>(params.size.xy),vec2<f32>(-1),vec2<f32>(1));hi=clamp(hi+2.0/vec2<f32>(params.size.xy),vec2<f32>(-1),vec2<f32>(1));
 let corners=array<vec2<f32>,6>(vec2<f32>(0,0),vec2<f32>(1,0),vec2<f32>(0,1),vec2<f32>(0,1),vec2<f32>(1,0),vec2<f32>(1,1));
 return VOut(vec4<f32>(mix(lo,hi,corners[vi%6u]),0,1),id,vec2<f32>(0));
}
struct BrickResult{@location(0) id:u32,@location(1) bary:vec2<f32>,@builtin(frag_depth) depth:f32};
@fragment fn brickFragment(input:VOut)->BrickResult{
 let r=clusterRecord(input.id);let brick=(input.id&0x7fffffffu)%64u;let o=r.x+16u+brick*8u;
 let origin=vector3(r.w,o);let cellSize=scalar(r.w,o+3u);let upper=origin+vec3<f32>(cellSize*4.0);
 let ndc=vec2<f32>(input.position.x/f32(params.size.x)*2.0-1.0,1.0-input.position.y/f32(params.size.y)*2.0);
 let far=inverseViewProjection*vec4<f32>(ndc,1,1);let ray=normalize(far.xyz/far.w-params.camera.xyz);let world=worldFor(r);
 let rotation=mat3x3<f32>(world[0].xyz,world[1].xyz,world[2].xyz);let inv=transpose(rotation)*(1.0/dot(world[0].xyz,world[0].xyz));
 let ro=inv*(params.camera.xyz-world[3].xyz);let rd=inv*ray;
 var entry=0.0;var exitDistance=1e30;
 for(var axis=0u;axis<3u;axis++){
  if(abs(rd[axis])<1e-12){if(ro[axis]<origin[axis]||ro[axis]>upper[axis]){discard;}}
  else{let a=(origin[axis]-ro[axis])/rd[axis];let b=(upper[axis]-ro[axis])/rd[axis];entry=max(entry,min(a,b));exitDistance=min(exitDistance,max(a,b));}
 }
 if(entry>=exitDistance){discard;}
 let direction=select(vec3<i32>(-1),vec3<i32>(1),rd>=vec3<f32>(0));
 var cell=clamp(vec3<i32>(floor((ro+rd*(entry+cellSize*.00001)-origin)/cellSize)),vec3<i32>(0),vec3<i32>(3));
 let rate=max(abs(rd),vec3<f32>(1e-12));let delta=vec3<f32>(cellSize)/rate;
 let boundary=origin+(vec3<f32>(cell)+select(vec3<f32>(0),vec3<f32>(1),rd>=vec3<f32>(0)))*cellSize;
 var next=(boundary-ro)/select(vec3<f32>(1e-12),rd,abs(rd)>vec3<f32>(1e-12));
 next=select(vec3<f32>(1e30),next,abs(rd)>vec3<f32>(1e-12));
 let low=word(r.w,o+4u);let high=word(r.w,o+5u);let data=r.x+word(r.w,o+6u);
 for(var step=0u;step<16u;step++){
  if(any(cell<vec3<i32>(0))||any(cell>=vec3<i32>(4))||entry>exitDistance){break;}
  let index=u32(cell.x+cell.y*4+cell.z*16);let mask=select(low,high,index>=32u);let bit=index%32u;
  if((mask&(1u<<bit))!=0u){
   let rank=select(0u,countOneBits(low),index>=32u)+countOneBits(mask&((1u<<bit)-1u));let address=data+rank*8u;
   let coverage=unpack3(word(r.w,address+3u),8u);let weights=abs(rd)/max(dot(abs(rd),vec3<f32>(1)),1e-10);let alpha=dot(coverage,weights);
   let seed=(u32(input.position.x)*1597334677u)^(u32(input.position.y)*3812015801u)^(stableCluster(input.id)*747796405u)^(brick*2246822519u)^(index*2891336453u);
   let noise=random3(seed).x*.5+.5;
   if(noise<alpha){
    let t=min(exitDistance,max(entry+.00001,min(next.x,min(next.y,next.z))*.5+entry*.5));
    let hit=params.matrix*vec4<f32>(params.camera.xyz+ray*t,1);let depth=hit.z/hit.w;
    if(depth>=0.0&&depth<=1.0){return BrickResult(input.id,vec2<f32>(f32(address),t),depth);}
   }
  }
  let axis=select(select(2u,1u,next.y<=next.z),0u,next.x<=min(next.y,next.z));entry=next[axis];next[axis]+=delta[axis];cell[axis]+=direction[axis];
 }
 discard;return BrickResult(EMPTY,vec2<f32>(0),1.0);
}
fn shadeBrick(id:u32,pixel:vec2<i32>)->vec3<f32>{
 let r=clusterRecord(id);let hit=textureLoad(barycentrics,pixel,0).xy;let address=u32(hit.x);let packed=word(r.w,address);
 let albedo=unpack3(packed,8u);let mean=unpack3(word(r.w,address+1u),10u)*2.0-1.0;let second=unpack3(word(r.w,address+2u),10u);
 let spread=sqrt(max(vec3<f32>(0),second-mean*mean));var normal=mean+spread*random3(stableCluster(id)^((id%64u)*2246822519u)^(u32(pixel.x)*747796405u)^(u32(pixel.y)*2891336453u));
 normal=(worldFor(r)*vec4<f32>(normal,0)).xyz;normal=normal/max(length(normal),1e-8);
 if(params.settings.y==1u){return hashColor(id/64u);}if(params.settings.y==2u){return vec3<f32>(1,.3,.1);}if(params.settings.y==3u){return normal*.5+.5;}
 let material=packed>>24u;var detail=1.0;
 if(material<4u){let uv=vec2<f32>(scalar(r.w,address+4u),scalar(r.w,address+5u));detail=textureSampleLevel(materialMap,materialSampler,uv,i32(material),4.0).r*1.5;}
 let hemi=.48+.3*clamp(normal.y*.5+.5,0.0,1.0);let light=normalize(vec3<f32>(.5,1,.35));let sun=max(0.0,dot(normal,light))*.85;
 let back=select(0.0,.16*max(0.0,-dot(normal,light)),material>=3u);
 let fog=1.0-exp(-.0018*.0018*hit.y*hit.y);return mix(albedo*detail*(hemi+sun+back),vec3<f32>(.4678,.6939,.7379),fog);
}
`;
export const brickVisibilityWGSL=texturedPagedWGSL.replace('let s=sourceTriangle(id);var t:Triangle;t.color=s.color;t.normal=s.normal;t.info=s.info;\n    color=landscapeShade(s,vec2<f32>(g.xy)+.5);',
 'if(clusterRecord(id).y==1u){color=shadeBrick(id,xy);}else{let s=sourceTriangle(id);color=landscapeShade(s,vec2<f32>(g.xy)+.5);}')+brickFunctions;
