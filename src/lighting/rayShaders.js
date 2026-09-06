// Rays traverse the same resident triangle/brick hierarchy, independently of
// the main camera's selected list. Missing detail uses resident parent pages.
let access='';
for(const [i,p]of ['a','b'].entries())access+=`
@group(0) @binding(${i*5}) var<storage,read> ${p}v:array<u32>;
@group(0) @binding(${i*5+1}) var<storage,read> ${p}i:array<u32>;
@group(0) @binding(${i*5+2}) var<storage,read> ${p}n:array<vec4<f32>>;
@group(0) @binding(${i*5+3}) var<storage,read> ${p}b:array<vec4<f32>>;
@group(0) @binding(${i*5+4}) var<storage,read> ${p}m:array<mat4x4<f32>>;
`;
export const rayLightingWGSL=access+`
struct Params{inverse:mat4x4<f32>,matrix:mat4x4<f32>,camera:vec4<f32>,size:vec4<u32>,flags:vec4<u32>,water:vec4<f32>,extent:vec4<f32>,assets:vec4<u32>};
@group(0) @binding(10) var<storage,read> tlas:array<vec4<f32>>;
@group(0) @binding(11) var<uniform> p:Params;
@group(0) @binding(12) var mainDepth:texture_depth_2d;
@group(0) @binding(13) var shadowOut:texture_storage_2d<r32float,write>;
@group(0) @binding(14) var reflectionOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(15) var<storage,read_write> counters:array<atomic<u32>>;
@group(0) @binding(16) var materials:texture_2d_array<f32>;
@group(0) @binding(17) var materialSampler:sampler;
@group(0) @binding(18) var receiverOut:texture_storage_2d<r32float,write>;
fn word(a:u32,o:u32)->u32{if(a==0u){return av[o];}return bv[o];}
fn scalar(a:u32,o:u32)->f32{return bitcast<f32>(word(a,o));}
fn xyz(a:u32,o:u32)->vec3<f32>{return vec3<f32>(scalar(a,o),scalar(a,o+1u),scalar(a,o+2u));}
fn table(a:u32,o:u32)->u32{if(a==0u){return ai[o];}return bi[o];}
fn node(a:u32,o:u32)->vec4<f32>{if(a==0u){return an[o];}return bn[o];}
fn sphere(a:u32,o:u32)->vec4<f32>{if(a==0u){return ab[o];}return bb[o];}
fn world(a:u32,i:u32)->mat4x4<f32>{if(a==0u){return am[i];}return bm[i];}
fn unpack(w:u32,b:u32)->vec3<f32>{let mask=(1u<<b)-1u;return vec3<f32>(f32(w&mask),f32((w>>b)&mask),f32((w>>(b*2u))&mask))/f32(mask);}
fn random(seed:u32)->f32{var h=seed*747796405u+2891336453u;h=(h^(h>>16u))*2246822519u;return f32(h&65535u)/65536.0;}
fn box(ro:vec3<f32>,rd:vec3<f32>,lo:vec3<f32>,hi:vec3<f32>,limit:f32)->vec2<f32>{
 var near=0.0;var far=limit;for(var axis=0u;axis<3u;axis++){if(abs(rd[axis])<1e-10){if(ro[axis]<lo[axis]||ro[axis]>hi[axis]){return vec2<f32>(1,-1);}}else{let a=(lo[axis]-ro[axis])/rd[axis];let b=(hi[axis]-ro[axis])/rd[axis];near=max(near,min(a,b));far=min(far,max(a,b));}}return vec2<f32>(near,far);
}
fn intersects(ro:vec3<f32>,rd:vec3<f32>,s:vec4<f32>,limit:f32)->bool{let d=ro-s.xyz;let aa=dot(rd,rd);let b=dot(d,rd);let c=dot(d,d)-s.w*s.w;let discriminant=b*b-aa*c;if(discriminant<0.0){return false;}let root=sqrt(discriminant);return (-b+root)/aa>0.0&&(-b-root)/aa<limit;}
struct Hit{t:f32,color:vec3<f32>,normal:vec3<f32>,complete:u32};
fn miss()->Hit{return Hit(200.0,vec3<f32>(0),vec3<f32>(0,1,0),1u);}
fn vertex(a:u32,page:u32,corner:u32)->u32{let local=(word(a,page+corner/4u)>>((corner%4u)*8u))&255u;return page+48u+local*16u;}
fn detail(a:u32,o:u32,b:u32,c:u32,w:vec3<f32>,lod:f32)->f32{let material=scalar(a,o+7u);if(material>=4.0){return 1.0;}let uv=vec2<f32>(scalar(a,o+12u),scalar(a,o+13u))*w.x+vec2<f32>(scalar(a,b+12u),scalar(a,b+13u))*w.y+vec2<f32>(scalar(a,c+12u),scalar(a,c+13u))*w.z;return textureSampleLevel(materials,materialSampler,uv,i32(material),lod).r*1.5;}
fn trace(origin:vec3<f32>,direction:vec3<f32>,shadow:bool,seed:u32)->Hit{
 var hit=miss();var nodes=0u;var work=0u;var instances:array<u32,32>;instances[0]=0u;var instanceTop=1u;
 loop{
  if(instanceTop==0u){break;}instanceTop--;let item=instances[instanceTop];if(item>=p.flags.z){continue;}
  let lo=tlas[item*3u];let hi=tlas[item*3u+1u];let range=box(origin,direction,lo.xyz,hi.xyz,hit.t);
  if(range.x>range.y){continue;}if(hi.w==0.0){
   let left=item+1u;let right=u32(tlas[left*3u].w);let leftRange=box(origin,direction,tlas[left*3u].xyz,tlas[left*3u+1u].xyz,hit.t);let rightRange=box(origin,direction,tlas[right*3u].xyz,tlas[right*3u+1u].xyz,hit.t);
   if(instanceTop+2u>32u){atomicAdd(&counters[2],1u);hit.complete=0u;return hit;}
   instances[instanceTop]=select(left,right,leftRange.x<=rightRange.x);instances[instanceTop+1u]=select(right,left,leftRange.x<=rightRange.x);instanceTop+=2u;continue;
  }
  let leaf=tlas[item*3u+2u];let asset=u32(leaf.x);let instance=u32(leaf.y);let m=world(asset,instance);
  let scale=length(m[0].xyz);let inverse=transpose(mat3x3<f32>(m[0].xyz,m[1].xyz,m[2].xyz))*(1.0/(scale*scale));let ro=inverse*(origin-m[3].xyz);let rd=inverse*direction;
  var pending:array<u32,32>;pending[0]=0u;var top=1u;
  loop{
   if(top==0u){break;}top--;let n=pending[top];nodes++;if(nodes>384u||work>2048u){atomicAdd(&counters[2],1u);hit.complete=0u;return hit;}
   let s=sphere(asset,n);let geometry=node(asset,n*6u);let walk=node(asset,n*6u+1u);
   if(!intersects(ro,rd,s,hit.t)){continue;}
   let distance=max(0.0,length((m*vec4<f32>(s.xyz,1)).xyz-origin)-s.w*scale);
   let error=select(.12+distance*.006,.08+distance*.003,shadow);
   if(walk.y>0.0&&geometry.x*scale>error){
    if(top+2u>32u){atomicAdd(&counters[2],1u);hit.complete=0u;return hit;}
    let left=n+1u;let right=u32(node(asset,left*6u+1u).x);let a=sphere(asset,left);let b=sphere(asset,right);let leftFirst=dot(a.xyz-ro,rd)-a.w/scale<dot(b.xyz-ro,rd)-b.w/scale;
    pending[top]=select(left,right,leftFirst);pending[top+1u]=select(right,left,leftFirst);top+=2u;continue;
   }
   for(var cluster=u32(geometry.y);cluster<u32(geometry.y+geometry.z);cluster++){
    if(work>2048u){atomicAdd(&counters[2],1u);hit.complete=0u;return hit;}
    // Reject whole clusters before decoding any page vertices or occupancy.
    if(geometry.z>1.0&&!intersects(ro,rd,sphere(asset,p.assets[asset]+cluster),hit.t)){continue;}
    let page=table(asset,cluster*4u);let kind=table(asset,cluster*4u+3u);
    if(kind==0u){
     for(var corner=0u;corner<192u;corner+=3u){
      work++;let ia=vertex(asset,page,corner);let ib=vertex(asset,page,corner+1u);let ic=vertex(asset,page,corner+2u);
      let a=xyz(asset,ia);let e1=xyz(asset,ib)-a;let e2=xyz(asset,ic)-a;let h=cross(rd,e2);let det=dot(e1,h);if(abs(det)<1e-10){continue;}
      let q=ro-a;let u=dot(q,h)/det;if(u<0.0||u>1.0){continue;}let r=cross(q,e1);let v=dot(rd,r)/det;if(v<0.0||u+v>1.0){continue;}let t=dot(e2,r)/det;if(t<.08||t>=hit.t){continue;}
      hit.t=t;if(shadow){return hit;}
      let w=1.0-u-v;hit.color=(xyz(asset,ia+8u)*w+xyz(asset,ib+8u)*u+xyz(asset,ic+8u)*v)*detail(asset,ia,ib,ic,vec3<f32>(w,u,v),2.0);
      hit.normal=normalize((m*vec4<f32>(xyz(asset,ia+4u)*w+xyz(asset,ib+4u)*u+xyz(asset,ic+4u)*v,0)).xyz);
     }
    }else{
     for(var brick=0u;brick<word(asset,page+1u);brick++){
      let o=page+16u+brick*8u;let lower=xyz(asset,o);let cellSize=scalar(asset,o+3u);let range=box(ro,rd,lower,lower+vec3<f32>(cellSize*4.0),hit.t);if(range.x>range.y){continue;}
      var entry=max(range.x,.08);let dir=select(vec3<i32>(-1),vec3<i32>(1),rd>=vec3<f32>(0));
      var cell=clamp(vec3<i32>(floor((ro+rd*(entry+.00001)-lower)/cellSize)),vec3<i32>(0),vec3<i32>(3));
      let boundary=lower+(vec3<f32>(cell)+select(vec3<f32>(0),vec3<f32>(1),rd>=vec3<f32>(0)))*cellSize;
      let divisor=select(vec3<f32>(1e-10),rd,abs(rd)>vec3<f32>(1e-10));var next=select(vec3<f32>(1e30),(boundary-ro)/divisor,abs(rd)>vec3<f32>(1e-10));let delta=vec3<f32>(cellSize)/max(abs(rd),vec3<f32>(1e-10));
      let low=word(asset,o+4u);let high=word(asset,o+5u);
      for(var step=0u;step<16u;step++){
       work++;if(any(cell<vec3<i32>(0))||any(cell>=vec3<i32>(4))||entry>range.y||entry>=hit.t){break;}
       let index=u32(cell.x+cell.y*4+cell.z*16);let bits=select(low,high,index>=32u);let bit=index%32u;
       if((bits&(1u<<bit))!=0u){let rank=select(0u,countOneBits(low),index>=32u)+countOneBits(bits&((1u<<bit)-1u));let address=page+word(asset,o+6u)+rank*8u;
        let coverage=unpack(word(asset,address+3u),8u);let alpha=dot(coverage,abs(rd))/max(dot(abs(rd),vec3<f32>(1)),1e-10);
        let noise=random(seed^(instance*1597334677u)^(cluster*3812015801u)^(brick*747796405u)^(index*2891336453u));
        // Ignore the receiver's own coarse cell rather than self-shadow its box.
        if(entry>max(.08,cellSize*scale*.75)&&noise<alpha){
         hit.t=entry;if(shadow){return hit;}let packed=word(asset,address);let mat=packed>>24u;hit.color=unpack(packed,8u);
         if(mat<4u){let uv=vec2<f32>(scalar(asset,address+4u),scalar(asset,address+5u));hit.color*=textureSampleLevel(materials,materialSampler,uv,i32(mat),4.0).r*1.5;}
         let normal=unpack(word(asset,address+1u),10u)*2.0-1.0;hit.normal=normalize((m*vec4<f32>(normal+vec3<f32>(0,.0001,0),0)).xyz);break;
        }
       }
       let axis=select(select(2u,1u,next.y<=next.z),0u,next.x<=min(next.y,next.z));entry=next[axis];next[axis]+=delta[axis];cell[axis]+=dir[axis];
      }
     }
    }
   }
  }
 }
 return hit;
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) g:vec3<u32>){
 if(any(g.xy>=p.size.zw)){return;}
 let pixel=min(vec2<u32>((vec2<f32>(g.xy)+.5)*vec2<f32>(p.size.xy)/vec2<f32>(p.size.zw)),p.size.xy-1u);let ndc=vec2<f32>((f32(pixel.x)+.5)/f32(p.size.x)*2.0-1.0,1.0-(f32(pixel.y)+.5)/f32(p.size.y)*2.0);
 let far=p.inverse*vec4<f32>(ndc,1,1);let direction=normalize(far.xyz/far.w-p.camera.xyz);
 let depth=textureLoad(mainDepth,vec2<i32>(pixel),0);let hp=p.inverse*vec4<f32>(ndc,depth,1);var point=hp.xyz/hp.w;var receiver=depth<1.0;var water=false;
 if(p.extent.z>0.0&&direction.y<-.00001){let t=(p.water.y-p.camera.y)/direction.y;if(t>0.0){let w=p.camera.xyz+direction*t;let q=(w.xz-p.water.xz)/p.extent.xy;let clip=p.matrix*vec4<f32>(w,1);if(dot(q,q)<1.0&&clip.z/clip.w<depth){water=true;receiver=true;point=w;}}}
 var shadow=1.0;var reflection=vec4<f32>(0);let seed=(g.x*1597334677u)^(g.y*3812015801u);let sun=normalize(vec3<f32>(.5,1,.35));
 if(p.flags.x!=0u&&receiver){atomicAdd(&counters[0],1u);let hit=trace(point+sun*.08,sun,true,seed);if(hit.complete==1u&&hit.t<200.0){shadow=0.0;}}
 if(p.flags.y!=0u&&water){atomicAdd(&counters[1],1u);let ray=reflect(direction,vec3<f32>(0,1,0));let hit=trace(point+ray*.1,ray,false,seed);if(hit.complete==1u&&hit.t<200.0){var normal=hit.normal;if(dot(normal,ray)>0.0){normal=-normal;}let lit=hit.color*(.48+.3*clamp(normal.y*.5+.5,0.0,1.0)+max(dot(normal,sun),0.0)*.85);let fog=1.0-exp(-.00000324*hit.t*hit.t);reflection=vec4<f32>(mix(lit,vec3<f32>(.4678,.6939,.7379),fog),1);}}
 let receiverClip=p.matrix*vec4<f32>(point,1);textureStore(receiverOut,vec2<i32>(g.xy),vec4<f32>(select(1.0,receiverClip.z/receiverClip.w,receiver)));
 textureStore(shadowOut,vec2<i32>(g.xy),vec4<f32>(shadow));textureStore(reflectionOut,vec2<i32>(g.xy),reflection);
}
`;
export const shadowSamplingWGSL=`
@group(0) @binding(30) var rayShadows:texture_2d<f32>;
@group(0) @binding(31) var<uniform> rayFlags:vec4<u32>;
@group(0) @binding(32) var rayReceiverDepth:texture_2d<f32>;
fn rayShadow(pixel:vec2<f32>)->f32{
 if(rayFlags.x==0u){return 1.0;}
 let size=vec2<i32>(textureDimensions(rayShadows));let uv=pixel/vec2<f32>(params.size.xy)*vec2<f32>(size)-.5;let base=vec2<i32>(floor(uv));let f=fract(uv);
 let receiver=textureLoad(depth,clamp(vec2<i32>(pixel),vec2<i32>(0),vec2<i32>(params.size.xy)-1),0);
 var sum=0.0;var weight=0.0;
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let q=clamp(base+vec2<i32>(x,y),vec2<i32>(0),size-1);let sampleDepth=textureLoad(rayReceiverDepth,q,0).r;
  // Relative perspective-depth difference rejects samples across silhouettes.
  let difference=abs(sampleDepth-receiver)/max(1.0-receiver,.000001);
  let spatial=select(1.0-f.x,f.x,x==1)*select(1.0-f.y,f.y,y==1);
  let w=spatial*max(0.0,1.0-difference*32.0);
  sum+=textureLoad(rayShadows,q,0).r*w;weight+=w;
 }}
 return select(1.0,sum/max(weight,.00001),weight>.001);
}
`;
