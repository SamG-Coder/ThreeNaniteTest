import fs from 'node:fs';
import assert from 'node:assert/strict';
import {deserialize} from 'node:v8';
import {gunzipSync} from 'node:zlib';
import {createLandscapeScene} from '../../src/landscapeScene.js';
import {decodeMetadata,decodePages} from '../../src/cluster/cookedFormat.js';
async function prepared(name){const dir='public/geometry/'+name,manifest=JSON.parse(fs.readFileSync(dir+'/manifest.json'));const buffer=gunzipSync(fs.readFileSync(dir+'/'+manifest.metadata));const asset=decodeMetadata(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength));for(const name of ['sourceColors','sourceSurface'])asset[name]=new THREE.BufferAttribute(asset[name].array,asset[name].itemSize);asset.pages=new Array(asset.totalClusters);const batches=new Map();asset.pageProvider={get:async id=>{const batch=Math.floor(id/manifest.batchSize);if(!batches.has(batch)){const b=gunzipSync(fs.readFileSync(dir+'/'+manifest.version+'-'+batch+'.bin.gz'));batches.set(batch,decodePages(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)));}return batches.get(batch)[id%manifest.batchSize];}};for(let id=0;id<asset.groupLods[2];id++)asset.pages[id]=await asset.pageProvider.get(id);return asset;}

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
const width=96,height=64,canvas={width,height,style:{},addEventListener(){},removeEventListener(){},getContext(){return null;}};
const renderer=new THREE.WebGPURenderer({canvas,device,antialias:false});await renderer.init();renderer.setSize(width,height,false);
const target=new THREE.RenderTarget(width,height,{type:THREE.UnsignedByteType});target.texture.colorSpace=THREE.SRGBColorSpace;const setTarget=renderer.setRenderTarget.bind(renderer);renderer.setRenderTarget=t=>setTarget(t??target);
const decorate=(g,material,color)=>{const c=new THREE.Color(color);g.setAttribute('color',new THREE.Float32BufferAttribute(Array.from({length:g.attributes.position.count},()=>c.toArray()).flat(),3));g.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(material),1));return g;};
const ground=decorate(new THREE.PlaneGeometry(14,14,12,12).rotateX(-Math.PI/2),0,0x67844c),tree=realTree?createLandscapeTree():decorate(new THREE.SphereGeometry(1,24,16).translate(0,1.5,0),3,0x698738);
const world=createLandscapeScene('compact');
const assets=[await prepared('valley-compact'),await prepared('valley-tree')];
const camera=new THREE.PerspectiveCamera(50,width/height,.1,500);camera.coordinateSystem=THREE.WebGPUCoordinateSystem;camera.position.set(0,2,6);camera.lookAt(0,1,0);camera.updateProjectionMatrix();camera.updateMatrixWorld();
let stats;const forest=new ForestRenderer(renderer,camera,...assets,world,s=>stats=s,{bitmask:true,bitmaskVariant:'bricks'});await forest.initBitmask();forest.setLodThreshold(1);
const report=[];let clock=performance.now();
for(const [distance,threshold]of [[35,1]]){
 camera.position.set(world.spawn[0],world.heightAt(world.spawn[0],world.spawn[2])+1.7,world.spawn[2]);camera.rotation.set(world.spawnPitch,world.spawnYaw,0,'YXZ');camera.updateMatrixWorld();forest.setLodThreshold(threshold);
 for(let frame=0;frame<90;frame++){forest.render(clock+=1000);await device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,0));}
 const pixels=await renderer.readRenderTargetPixelsAsync(target,0,0,width,height);
 fs.writeFileSync(`/tmp/cluster-${distance}-${threshold}.rgba`,new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
 report.push({distance,threshold,stats});console.log(JSON.stringify(report.at(-1)));
}
fs.writeFileSync('/tmp/cluster-renderer-report.json',JSON.stringify({width,height,errors,report},null,2));forest.dispose();renderer.dispose();device.destroy();if(errors.length)throw Error(`${errors.length} GPU validation errors`);
