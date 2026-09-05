// Native Dawn/SwiftShader visual smoke test of the actual Three water/sky shaders.
// Hardware comparison geometry; does not measure the browser visibility path.
import fs from 'node:fs';
import * as THREE from 'three/webgpu';
import {create,globals} from 'webgpu';
import {createLandscapeScene} from '../../src/landscapeScene.js';
import {createLandscapeWater,createLandscapeSky} from '../../src/landscapeWater.js';
Object.assign(globalThis,globals);
const gpu=create(['backend=vulkan']);
Object.defineProperty(globalThis,'navigator',{value:{gpu,userAgent:'Node visual test'},configurable:true});
globalThis.self=globalThis;globalThis.requestAnimationFrame=()=>0;globalThis.cancelAnimationFrame=()=>{};
const adapter=await gpu.requestAdapter();if(!adapter)throw new Error('A Vulkan adapter is required');
const device=await adapter.requestDevice();device.addEventListener('uncapturederror',e=>{console.error(e.error);process.exitCode=1;});
const width=640,height=400;
const canvas={width,height,style:{},addEventListener(){},removeEventListener(){},getContext(){return null;}};
const renderer=new THREE.WebGPURenderer({canvas,device,antialias:false});await renderer.init();renderer.setSize(width,height,false);renderer.toneMapping=THREE.ACESFilmicToneMapping;
const world=createLandscapeScene('compact');
const scene=new THREE.Scene();scene.background=new THREE.Color(0xb6d9df);scene.fog=new THREE.FogExp2(0xb6d9df,.008);
scene.add(new THREE.HemisphereLight(0xb9d8ff,0x303324,2));const sun=new THREE.DirectionalLight(0xfff0d7,2.5);sun.position.set(5,10,3.5);scene.add(sun);
const mat=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.9});scene.add(new THREE.Mesh(world.geometry,mat));
const trees=new THREE.InstancedMesh(world.treeGeometry,mat,world.treeInstances.length/4),m=new THREE.Matrix4(),data=world.treeInstances;
for(let i=0;i<data.length/4;i++){m.makeRotationY(-i*.61803398875);m.scale(new THREE.Vector3().setScalar(data[i*4+3]));m.setPosition(data[i*4],data[i*4+1],data[i*4+2]);trees.setMatrixAt(i,m);}
scene.add(trees,createLandscapeWater(world),createLandscapeSky());
const camera=new THREE.PerspectiveCamera(50,width/height,.1,500);camera.position.set(30,world.heightAt(30,14)+1.7,14);camera.lookAt(0,1,-12);
const target=new THREE.RenderTarget(width,height,{type:THREE.UnsignedByteType});target.texture.colorSpace=THREE.SRGBColorSpace;renderer.setRenderTarget(target);
renderer.render(scene,camera);await device.queue.onSubmittedWorkDone();
const pixels=await renderer.readRenderTargetPixelsAsync(target,0,0,width,height);
fs.writeFileSync(process.argv[2]??'/tmp/landscape.rgba',new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength));
console.log(JSON.stringify({width,height,bytes:pixels.byteLength,grass:world.grassClumps,trees:trees.count}));
renderer.dispose();device.destroy();
