import * as THREE from 'three/webgpu';
import {buildClusterAsset} from './buildClusterAsset.js';
self.onmessage=async({data})=>{try{
 const geometry=new THREE.BufferGeometry();for(const [name,a]of Object.entries(data.attributes))geometry.setAttribute(name,new THREE.BufferAttribute(a.array,a.itemSize));geometry.setIndex(new THREE.BufferAttribute(data.index,1));
 const asset=await buildClusterAsset(geometry,{onProgress:(title,detail)=>self.postMessage({progress:[title,detail]})});
 const buffers=new Set();for(const value of Object.values(asset))if(ArrayBuffer.isView(value))buffers.add(value.buffer);for(const page of asset.pages)buffers.add(page.buffer);for(const name of ['sourceColors','sourceSurface']){asset[name]={array:asset[name].array,itemSize:asset[name].itemSize};buffers.add(asset[name].array.buffer);}
 self.postMessage({asset},[...buffers]);
 }catch(error){self.postMessage({error:error.stack??error.message});}};
