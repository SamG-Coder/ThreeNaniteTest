import * as THREE from 'three/webgpu';
import {Fn,attribute,positionWorld,normalWorld,abs,If,vec2,float,texture,fract} from 'three/tsl';
// Original tileable material textures, baked once (not noise evaluated for
// every pixel). R is reflectance and A is height. No remote asset dependency.
export function createLandscapeTexture(){
 const size=256,data=new Uint8Array(size*size*4*4);
 const hash=(x,y)=>{let n=Math.imul(x,374761393)^Math.imul(y,668265263);n=Math.imul(n^(n>>>13),1274126177);return ((n^(n>>>16))>>>0)/4294967295;};
 const noise=(x,y,period)=>{let ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);const h=(a,b)=>hash((a%period+period)%period,(b%period+period)%period);return THREE.MathUtils.lerp(THREE.MathUtils.lerp(h(ix,iy),h(ix+1,iy),fx),THREE.MathUtils.lerp(h(ix,iy+1),h(ix+1,iy+1),fx),fy);};
 for(let layer=0;layer<4;layer++)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const u=x/size,v=y/size,n=noise(u*32,v*32,32),fine=noise(u*128,v*128,128),broad=noise(u*8,v*8,8);
  let value=.48+.25*n+.14*fine;
  if(layer===0)value=.38+.3*n+.2*fine+.1*broad; // grit and soil aggregates
  if(layer===1)value=.48+.18*broad+.17*fine-.12*(n<.2?1:0); // mineral inclusions
  if(layer===2){const ridge=Math.abs(Math.sin(u*Math.PI*32+.8*Math.sin(v*Math.PI*4)+broad*2));value=.22+.55*ridge**.4+.12*fine;}
  if(layer===3){const vein=Math.abs(Math.sin((u+v*.55)*Math.PI*24));value=.62+.14*broad+.12*vein;}
  const i=(y*size*4+layer*size+x)*4,b=Math.round(Math.min(1,value)*255);data.set([b,b,b,b],i);
 }
 const result=new THREE.DataTexture(data,size*4,size,THREE.RGBAFormat);result.generateMipmaps=true;result.minFilter=THREE.LinearMipmapLinearFilter;result.magFilter=THREE.LinearFilter;result.wrapS=result.wrapT=THREE.RepeatWrapping;result.needsUpdate=true;result.name='Willowmere soil, mineral, bark and leaf textures';return result;
}
export function createLandscapeMaterial(map){
 const mat=new THREE.MeshStandardNodeMaterial({vertexColors:false,roughness:.87});
 mat.colorNode=Fn(()=>{
  const surface=attribute('surface','float'),n=abs(normalWorld),uv=positionWorld.xz.mul(.7).toVar();
  If(n.y.lessThan(n.x),()=>{uv.assign(positionWorld.zy.mul(.7));});
  If(n.z.greaterThan(n.y).and(n.z.greaterThan(n.x)),()=>{uv.assign(positionWorld.xy.mul(.7));});
  If(surface.greaterThan(1.5).and(surface.lessThan(2.5)),()=>{uv.mulAssign(vec2(2,.4));});
  const detail=float(1).toVar();If(surface.lessThan(3.5),()=>{detail.assign(texture(map,vec2(fract(uv.x).add(surface).mul(.25),fract(uv.y))).r.mul(1.5));});
  return attribute('color','vec3').mul(detail);
 })();return mat;
}
