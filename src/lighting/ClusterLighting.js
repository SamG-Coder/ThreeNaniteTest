import * as THREE from 'three/webgpu';
import {uniform,texture,screenUV,vec2,clamp,mix,If,float} from 'three/tsl';
import {buildInstanceBVH} from './instanceBVH.js';
import {rayLightingWGSL,shadowSamplingWGSL} from './rayShaders.js';
import {brickVisibilityWGSL} from '../cluster/brickShaders.js';
// Only direct sunlight is shadowed. Ambient/sky lighting remains present.
export const litBrickWGSL=brickVisibilityWGSL
 .replace('hemi+sun+backLight','hemi+(sun+backLight)*rayShadow(pixel)')
 .replace('hemi+sun+back)','hemi+(sun+back)*rayShadow(vec2<f32>(pixel)+.5))')+shadowSamplingWGSL;
export class ClusterLighting{
 constructor(owner){
  this.owner=owner;this.device=owner.device;this.shadows=false;this.reflections=false;this.revision=0;
  this.uniform=owner.makeBuffer(208,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  this.flags=owner.makeBuffer(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
  this.counters=owner.makeBuffer(16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST);
  const bvh=buildInstanceBVH(owner.forest.pipelines);this.count=bvh.count;this.tlas=owner.makeBuffer(bvh.data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,bvh.data);
  this.reflectionEnabled=uniform(0);this.shadowEnabled=uniform(0);this.resize();
  for(const [key,title]of [['shadows','Cluster ray shadows'],['reflections','Cluster water reflections']]){
   const label=document.createElement('label');label.className='field';label.textContent=title;const input=document.createElement('input');input.type='checkbox';input.checked=false;
   if(key==='reflections'&&!owner.forest.world.landscape){input.disabled=true;label.title='Available on Willowmere water';}
   input.onchange=()=>this.set(key,input.checked);label.append(input);owner.panel.append(label);
  }
 }
 set(key,value){this[key]=Boolean(value);this.reflectionEnabled.value=this.reflections?1:0;this.shadowEnabled.value=this.shadows?1:0;this.device.queue.writeBuffer(this.flags,0,new Uint32Array([this.shadows?1:0,0,0,0]));this.revision++;this.owner.visibilitySignature=null;}
 resize(){
  this.width=Math.max(1,Math.ceil(this.owner.width/4));this.height=Math.max(1,Math.ceil(this.owner.height/4));
  const make=(format,type)=>{const t=new THREE.StorageTexture(this.width,this.height);t.format=format;t.type=type;t.minFilter=type===THREE.FloatType?THREE.NearestFilter:THREE.LinearFilter;t.magFilter=t.minFilter;t.generateMipmaps=false;t.mipmapsAutoUpdate=false;this.owner.renderer._textures.updateTexture(t);return t;};
  this.shadow?.dispose();this.reflection?.dispose();this.shadow=make(THREE.RedFormat,THREE.FloatType);this.reflection=make(THREE.RGBAFormat,THREE.HalfFloatType);this.group=null;this.revision++;
  if(this.reflectionNode){this.reflectionNode.value=this.reflection;this.shadowNode.value=this.shadow;}
 }
 waterHooks(){
  this.reflectionNode=texture(this.reflection);this.shadowNode=texture(this.shadow);const self=this;
  return {reflection(normal,sky){const radiance=sky.toVar();If(self.reflectionEnabled.greaterThan(.5),()=>{const uv=clamp(screenUV.add(vec2(normal.x,normal.z).mul(.015)),.001,.999);const sample=self.reflectionNode.sample(uv);radiance.assign(mix(sky,sample.rgb,clamp(sample.a,0,1)));});return radiance;},sun(){const light=float(1).toVar();If(self.shadowEnabled.greaterThan(.5),()=>{light.assign(self.shadowNode.sample(screenUV).r);});return light;}};
 }
 async init(){const module=this.device.createShaderModule({code:rayLightingWGSL,label:'Cluster ray lighting'});const info=await module.getCompilationInfo();const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));this.pipeline=await this.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});}
 encode(encoder){
  if(!this.shadows&&!this.reflections)return;
  const owner=this.owner;
  if(!this.group){const resources={};owner.forest.pipelines.forEach((p,i)=>{const s=owner.selectionResources[i];[owner.assets[i].vertices,owner.assets[i].indices,owner.pagers[i].metadata,s.resources[2],owner.sharedBuffer(p.instanceWorldAttribute)].forEach((buffer,j)=>resources[i*5+j]={buffer});});
   Object.assign(resources,{10:{buffer:this.tlas},11:{buffer:this.uniform},12:owner.hardwareDepth.createView(),13:owner.renderer.backend.get(this.shadow).texture.createView(),14:owner.renderer.backend.get(this.reflection).texture.createView(),15:{buffer:this.counters},16:owner.renderer.backend.get(owner.forest.landscapeTexture).texture.createView(),17:owner.materialSampler});
   this.group=this.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:Object.entries(resources).map(([binding,resource])=>({binding:Number(binding),resource}))});
  }
  const bytes=new ArrayBuffer(208),f=new Float32Array(bytes),u=new Uint32Array(bytes);const matrix=owner.forest.terrain.projScreenMatrix;
  f.set(new THREE.Matrix4().copy(matrix).invert().elements);f.set(matrix.elements,16);f.set([...owner.camera.position.toArray(),1],32);u.set([owner.width,owner.height,this.width,this.height],36);u.set([this.shadows?1:0,this.reflections?1:0,this.count,0],40);
  const spec=owner.forest.world.water;if(spec){f.set([spec.x,spec.y,spec.z,1],44);f.set([spec.radius*spec.scaleX,spec.radius*spec.scaleZ,1,0],48);}
  this.device.queue.writeBuffer(this.uniform,0,bytes);encoder.clearBuffer(this.counters);const pass=encoder.beginComputePass({label:'Cluster shadow and reflection rays'});pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.dispatchWorkgroups(Math.ceil(this.width/8),Math.ceil(this.height/8));pass.end();encoder.copyBufferToBuffer(this.counters,0,owner.control,40,12);
 }
 dispose(){this.shadow.dispose();this.reflection.dispose();}
}
