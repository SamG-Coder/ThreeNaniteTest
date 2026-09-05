import {visibilityWGSL,cullWGSL,pyramidWGSL,pyramidBaseWGSL} from '../../src/visibility/shaders.js';
import {forestFastWGSL} from '../../src/bitmask/forestFastShaders.js';
import {forestBoundedWGSL,forestDispatchWGSL} from '../../src/bitmask/forestBoundedShaders.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import {prepareForest} from './forest.mjs';
import {forestReferenceWGSL} from '../../src/bitmask/forestReferenceShaders.js';
import {forestOwnedMaskWGSL} from '../../src/bitmask/forestOwnedMaskShaders.js';
import {forestRasterWGSL} from '../../src/bitmask/forestShaders.js';
import {forestRejectWGSL} from '../../src/bitmask/forestRejectShaders.js';
const out=process.argv[2]??'/tmp/forest-gpu';mkdirSync(out,{recursive:true});
const flags=Object.fromEntries(process.argv.slice(3).map(arg=>arg.replace(/^--/,'').split('=')));
const s=await prepareForest({width:Number(flags.width??160),height:Number(flags.height??288),pitch:Number(flags.pitch??-.05),yaw:Number(flags.yaw??0),density:flags.density??'high',geometry:flags.geometry??'full',project:false,voxels:flags.voxels==='true'});
const {assets,matrices,selected,vp,camera,world}=s.gpu;
const save=(name,data)=>writeFileSync(`${out}/${name}.bin`,new Uint8Array(data.buffer,data.byteOffset,data.byteLength));
for(let a=0;a<2;a++){
 const asset=assets[a],colors=asset.sourceColors??(a?world.treeGeometry:world.geometry).attributes.color;
 const vertices=new Float32Array(asset.vertexCount*12);
 for(let i=0;i<asset.vertexCount;i++){vertices.set(asset.vertices.subarray(i*4,i*4+4),i*12);vertices.set(asset.normals.subarray(i*4,i*4+4),i*12+4);vertices.set([colors.getX(i),colors.getY(i),colors.getZ(i),asset.coverage?.[i]??1],i*12+8);}
 const indices=new Uint32Array(asset.indices.length+asset.clusterLod.length);indices.set(asset.indices);indices.set(asset.clusterLod,asset.indices.length);
 save(`${a}-bounds`,asset.clusterBounds);
 save(`${a}-vertices`,vertices);save(`${a}-indices`,indices);save(`${a}-matrices`,Float32Array.from(matrices[a].flatMap(m=>m.elements)));
 save(`${a}-visible`,Uint32Array.from(selected.filter(v=>v.a===a).flatMap(v=>[v.instance,v.cluster])));
}
const params=new ArrayBuffer(128),f=new Float32Array(params),u=new Uint32Array(params);f.set(vp.elements);f.set([...camera.position.toArray(),1],16);u.set([s.width,s.height,Math.ceil(s.width/8),Math.ceil(s.width/8)*Math.ceil(s.height/8)],20);
const capacity=s.geometry==='full'?assets.map((a,i)=>a.lods[0].clusterCount*(i?world.treeInstances.length/4:1)):[8192,32768];
u.set([...capacity,...assets.map(a=>a.indices.length)],24);u.set([8388608,0,0,Math.min(65535,capacity[0]+capacity[1])],28);save('params',new Uint8Array(params));
for(const [variant,code] of Object.entries({fast:forestFastWGSL,bounded:forestBoundedWGSL,original:forestReferenceWGSL,owned:forestOwnedMaskWGSL,cached:forestRasterWGSL,reject:forestRejectWGSL}))writeFileSync(`${out}/${variant}.wgsl`,code);
writeFileSync(`${out}/manifest.json`,JSON.stringify({width:s.width,height:s.height,clusterCounts:assets.map(a=>a.totalClusters),instanceCounts:[1,world.treeInstances.length/4],counts:s.counts,sourceTriangles:s.sourceTriangles,capacity,geometry:s.geometry,density:s.density,voxels:flags.voxels==='true',voxelCells:assets[1].voxelCells??0,cpuTimingsMs:s.cpuTimingsMs,camera:s.camera,selection:'CPU equivalent of cull, deterministic slot order'},null,2));
console.log('Exported actual forest GPU buffers',out,s.counts);

writeFileSync(`${out}/dispatch.wgsl`,forestDispatchWGSL);

for(const [name,code] of Object.entries({visibility:visibilityWGSL,cull:cullWGSL,pyramid:pyramidWGSL,base:pyramidBaseWGSL}))writeFileSync(`${out}/${name}.wgsl`,code);
