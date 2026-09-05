import * as THREE from 'three/webgpu';
import {Fn,If,Discard,attribute,positionLocal,positionWorld,cameraPosition,time,vec3,vec4,float,sin,cos,mix,normalize,dot,max,clamp,pow,exp,smoothstep,reflect} from 'three/tsl';
const waveTerms=[[.65,.3,.62,.065],[.17,-.83,.91,.04],[1.8,.7,1.4,.013],[.8,-2.2,1.75,.008]];
function surface(x,z){
 let height=float(0),dx=float(0),dz=float(0);
 for(const[kx,kz,speed,amplitude]of waveTerms){
  const phase=x.mul(kx).add(z.mul(kz)).add(time.mul(speed));
  height=height.add(sin(phase).mul(amplitude));dx=dx.add(cos(phase).mul(amplitude*kx));dz=dz.add(cos(phase).mul(amplitude*kz));
 }
 return {height,normal:normalize(vec3(dx.negate(),1,dz.negate()))};
}
function skyRadiance(direction){
 const elevation=clamp(direction.y,0,1),sun=normalize(vec3(.5,1,.35));
 const sky=mix(vec3(.4678,.6939,.7379),vec3(.12,.32,.56),pow(elevation,.55));
 const alignment=max(dot(direction,sun),0);
 const cloudX=direction.x.div(max(direction.y,.12)),cloudZ=direction.z.div(max(direction.y,.12));
 const cloudField=sin(cloudX.mul(1.2).add(.5)).mul(cos(cloudZ.mul(.9))).mul(.55)
  .add(sin(cloudX.mul(3.2).add(cloudZ.mul(1.7))).mul(.22));
 const cloud=smoothstep(.25,.58,cloudField).mul(smoothstep(.06,.2,elevation)).mul(.65);
 return mix(sky,vec3(.8,.84,.79),cloud).add(vec3(1,.76,.43).mul(pow(alignment,512).mul(3.5).add(pow(alignment,24).mul(.12))));
}
export function createLandscapeWater(world){
 const spec=world.water;
 const geometry=new THREE.PlaneGeometry(spec.radius*2*spec.scaleX,spec.radius*2*spec.scaleZ,160,112).rotateX(-Math.PI/2);
 const p=geometry.attributes.position,depth=new Float32Array(p.count);
 for(let i=0;i<p.count;i++)depth[i]=spec.y-world.heightAt(p.getX(i)+spec.x,p.getZ(i)+spec.z);
 geometry.setAttribute('waterDepth',new THREE.BufferAttribute(depth,1));geometry.computeBoundingSphere();geometry.boundingSphere.radius+=.2;
 const material=new THREE.NodeMaterial();material.name='Willowmere water';material.fog=false;
 const waterDepth=attribute('waterDepth','float');
 material.positionNode=Fn(()=>{
  const s=surface(positionLocal.x,positionLocal.z);
  return positionLocal.add(vec3(0,s.height.mul(smoothstep(0,1.5,waterDepth)),0));
 })();
 material.fragmentNode=Fn(()=>{
  If(waterDepth.lessThanEqual(0),()=>{Discard();});
  const s=surface(positionWorld.x.sub(spec.x),positionWorld.z.sub(spec.z));
  const normal=normalize(mix(vec3(0,1,0),s.normal,smoothstep(0,1.5,waterDepth)));
  const view=normalize(cameraPosition.sub(positionWorld));
  const reflection=reflect(view.negate(),normal);
  const fresnel=float(.02).add(pow(float(1).sub(clamp(dot(normal,view),0,1)),5).mul(.98));
  const absorption=float(1).sub(exp(waterDepth.mul(-.48)));
  const bed=mix(vec3(.13,.23,.14),vec3(.008,.055,.065),absorption);
  // Sunlit ripples on the shallow bed are procedural; no second scene render.
  const caustic=pow(max(sin(positionWorld.x.mul(2.1).add(time.mul(.6))).mul(cos(positionWorld.z.mul(2.6).sub(time.mul(.7)))),0),6)
    .mul(exp(waterDepth.mul(-.8))).mul(.07);
  const water=mix(bed.add(caustic),skyRadiance(reflection),fresnel).toVar();
  const sun=normalize(vec3(.5,1,.35)),half=normalize(sun.add(view));
  water.addAssign(vec3(1,.83,.57).mul(pow(max(dot(normal,half),0),320)).mul(1.8));
  const shore=float(1).sub(smoothstep(.03,.6,waterDepth));
  const ripple=sin(waterDepth.mul(20).sub(time.mul(1.7)).add(sin(positionWorld.x.mul(.8)).mul(.8)));
  const foam=shore.mul(smoothstep(.45,.95,ripple)).mul(.5);
  water.assign(mix(water,vec3(.73,.8,.71),foam));
  const delta=cameraPosition.sub(positionWorld),fog=float(1).sub(exp(dot(delta,delta).mul(-.00000324)));
  return vec4(mix(water,vec3(.4678,.6939,.7379),fog),1);
 })();
 const mesh=new THREE.Mesh(geometry,material);mesh.name='Willowmere lake';mesh.position.set(spec.x,spec.y,spec.z);return mesh;
}
export function createLandscapeSky(){
 const material=new THREE.NodeMaterial();material.name='Willowmere sky';material.side=THREE.BackSide;material.depthWrite=false;material.fog=false;
 material.fragmentNode=Fn(()=>vec4(skyRadiance(normalize(positionLocal)),1))();
 const mesh=new THREE.Mesh(new THREE.SphereGeometry(440,32,16),material);mesh.frustumCulled=false;mesh.renderOrder=-100;return mesh;
}
