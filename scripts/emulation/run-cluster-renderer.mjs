import fs from 'node:fs';
import {deserialize} from 'node:v8';
import {createLandscapeTree} from '../../src/landscapeTree.js';
const realTree=process.argv.includes('--tree');
import * as THREE from 'three/webgpu';
import {create,globals} from 'webgpu';
import {buildClusterAsset} from '../../src/cluster/buildClusterAsset.js';
import {ForestRenderer} from '../../src/ForestRenderer.js';
Object.assign(globalThis,globals);
const element=()=>({textContent:'',innerHTML:'',append(){},prepend(){},remove(){},querySelector(){return element();}});
globalThis.document={createElement:element,getElementById:element};
const gpu=create(['backend=vulkan']);Object.defineProperty(globalThis,'navigator',{value:{gpu,userAgent:'Node native validation'},configurable:true});globalThis.self=globalThis;globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};
const adapter=await gpu.requestAdapter();if(!adapter)throw Error('Vulkan adapter required');
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:12}});const errors=[];device.addEventListener('uncapturederror',e=>{errors.push(e.error.message);console.error(e.error.message);});
const width=192,height=128,canvas={width,height,style:{},addEventListener(){},removeEventListener(){},getContext(){return null;}};
const renderer=new THREE.WebGPURenderer({canvas,device,antialias:false});await renderer.init();renderer.setSize(width,height,false);
const target=new THREE.RenderTarget(width,height,{type:THREE.UnsignedByteType});target.texture.colorSpace=THREE.SRGBColorSpace;const setTarget=renderer.setRenderTarget.bind(renderer);renderer.setRenderTarget=t=>setTarget(t??target);
const decorate=(g,material,color)=>{const c=new THREE.Color(color);g.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:g.attributes.position.count},()=>c.toArray()).flat(),3));g.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(material),1));return g;};
const ground=decorate(new THREE.PlaneGeometry(14,14,12,12).rotateX(-Math.PI/2),0,0x67844c),tree=realTree?createLandscapeTree():decorate(new THREE.SphereGeometry(1,24,16).translate(0,1.5,0),3,0x698738);
const world={forest:true,geometry:ground,treeGeometry:tree,treeInstances:new Float32Array([0,0,0,1,2,0,-3,1])};
const treeAsset=realTree&&fs.existsSync('/tmp/cluster-tree.v8')?deserialize(fs.readFileSync('/tmp/cluster-tree.v8')):await buildClusterAsset(tree);
for(const name of ['sourceColors','sourceSurface'])if(!treeAsset[name].getX)treeAsset[name]=new THREE.BufferAttribute(treeAsset[name].array,treeAsset[name].itemSize);
const assets=[await buildClusterAsset(ground),treeAsset];
const camera=new THREE.PerspectiveCamera(50,width/height,.1,500);camera.coordinateSystem=THREE.WebGPUCoordinateSystem;camera.position.set(0,2,6);camera.lookAt(0,1,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
let stats;const forest=new ForestRenderer(renderer,camera,...assets,world,s=>stats=s,{bitmask:true,bitmaskVariant:'bricks'});await forest.initBitmask();forest.setLodThreshold(1);
const report=[];let clock=performance.now();
for(const [distance,threshold]of (realTree?[[12,1],[80,1],[160,1]]:[[6,0],[6,1],[45,1],[100,1]])){
 camera.position.set(0,realTree?7:2,distance);camera.lookAt(0,realTree?7:1,0);camera.updateMatrixWorld();forest.setLodThreshold(threshold);
 for(let frame=0;frame<(realTree?180:12);frame++){forest.render(clock+=1000);await device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}
 const pixels=await renderer.readRenderTargetPixelsAsync(target,0,0,width,height);
 fs.writeFileSync(`/tmp/cluster-${distance}-${threshold}.rgba`,new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
 report.push({distance,threshold,stats});console.log(JSON.stringify(report.at(-1)));
}
fs.writeFileSync('/tmp/cluster-renderer-report.json',JSON.stringify({width,height,errors,report},null,2));forest.dispose();renderer.dispose();device.destroy();if(errors.length)throw Error(`${errors.length} GPU validation errors`);
