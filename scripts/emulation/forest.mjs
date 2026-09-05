import * as THREE from 'three/webgpu';
import {createForestScene} from '../../src/forestScene.js';
import {buildNaniteLiteAsset} from '../../src/buildNaniteLiteAsset.js';
import {buildHierarchyAsset} from '../../src/buildHierarchyAsset.js';
import {clipNearPlane} from '../../src/bitmask/reference.js';

export async function prepareForest({density='high',geometry='full',width=384,height=704,pitch=.55,yaw=0,threshold=4.5}={}){
 if(!['full','auto','hierarchy'].includes(geometry))throw new Error('Unknown geometry mode');
 const world=createForestScene(density);
 const build=geometry==='hierarchy'?buildHierarchyAsset:buildNaniteLiteAsset;
 const assets=[await build(world.geometry,{meshletsPerGroup:64}),await build(world.treeGeometry,{meshletsPerGroup:64})];
 const camera=new THREE.PerspectiveCamera(50,width/height,.1,500);camera.coordinateSystem=THREE.WebGPUCoordinateSystem;camera.updateProjectionMatrix();
 camera.position.set(0,world.heightAt(0,62)+1.7,62);camera.rotation.set(pitch,yaw,0,'YXZ');camera.updateMatrixWorld();
 const vp=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
 const frustum=new THREE.Frustum().setFromProjectionMatrix(vp,THREE.WebGPUCoordinateSystem);
 const selected=[],counts={groupsVisited:0,groupsRejected:0,meshletsTested:0,frustumRejected:0,coneRejected:0,actualTriangles:0,paddedTriangleSlots:0};
 const point=new THREE.Vector3(),sphere=new THREE.Sphere(),axis=new THREE.Vector3(),apex=new THREE.Vector3();
 const sets=[new Float32Array([0,0,0,1]),world.treeInstances];
 const matrices=[];
 for(let a=0;a<2;a++){
  const asset=assets[a],data=sets[a];matrices[a]=[];
  for(let instance=0;instance<data.length/4;instance++){
   const scale=data[instance*4+3];const m=new THREE.Matrix4().makeRotationY(-instance*.61803398875).scale(new THREE.Vector3(scale,scale,scale)).setPosition(data[instance*4],data[instance*4+1],data[instance*4+2]);matrices[a].push(m);
   for(let group=0;group<asset.groupCount;){
    counts.groupsVisited++;const offset=group*24;
    const next=asset.hierarchy?asset.groupLods[offset+4]:group+1;
    sphere.center.fromArray(asset.groupBounds,group*4).applyMatrix4(m);sphere.radius=asset.groupBounds[group*4+3]*scale;
    if(!frustum.intersectsSphere(sphere)){counts.groupsRejected++;group=next;continue;}
    let level=0;
    const clip=new THREE.Vector4(...sphere.center.toArray(),1).applyMatrix4(vp);
    const distance=Math.max(.01,(asset.hierarchy?clip.w:sphere.center.distanceTo(camera.position))-sphere.radius);
    const factor=camera.projectionMatrix.elements[5]*height/(2*distance);
    if(asset.hierarchy&&asset.groupLods[offset+5]>0&&asset.groupLods[offset]*scale*factor>threshold){group++;continue;}
    if(geometry==='auto')for(let l=5;l>0;l--)if(asset.groupLods[offset+l*4]*scale*factor<=threshold){level=l;break;}
    const start=asset.groupLods[offset+level*4+1],count=asset.groupLods[offset+level*4+2];
    for(let cluster=start;cluster<start+count;cluster++){
     counts.meshletsTested++;sphere.center.fromArray(asset.clusterBounds,cluster*4).applyMatrix4(m);sphere.radius=asset.clusterBounds[cluster*4+3]*scale;
     if(!frustum.intersectsSphere(sphere)){counts.frustumRejected++;continue;}
     const cutoff=asset.clusterConeApex[cluster*4+3];axis.fromArray(asset.clusterConeAxis,cluster*4);
     if(cutoff>=0&&cutoff<1&&axis.lengthSq()>.5){axis.transformDirection(m);apex.fromArray(asset.clusterConeApex,cluster*4).applyMatrix4(m);point.copy(apex).sub(camera.position).normalize();if(point.dot(axis)>=cutoff){counts.coneRejected++;continue;}}
     const slot=counts['asset'+a]??0;counts['asset'+a]=slot+1;
     if(geometry!=='full'&&slot>=(a?32768:8192)){counts.capacityOverflow=(counts.capacityOverflow??0)+1;continue;}
     selected.push({a,instance,cluster,slot});
     counts.actualTriangles+=asset.clusterTriangleCounts[cluster];counts.paddedTriangleSlots+=64;
    }
    group=next;
   }
  }
 }
 // Float32 storage matches the shader's projected data format; operations use
 // JS arithmetic, so GPU FMA/rounding and parallel atomic order are not emulated.
 const projected=new Float32Array(counts.paddedTriangleSlots*14),ids=new Uint32Array(counts.paddedTriangleSlots);
 let primitiveCount=0;const setup={paddingSlots:counts.paddedTriangleSlots-counts.actualTriangles,nearClipped:0,backfaceOrDegenerate:0,outsideViewport:0};
 const v=new THREE.Vector4();
 for(const s of selected){
  const asset=assets[s.a],worldMatrix=matrices[s.a][s.instance];
  for(let t=0;t<64;t++){
   if(t>=asset.clusterTriangleCounts[s.cluster])continue; // Counted as work in report; result is provably degenerate.
   const points=[],centre=new THREE.Vector3();
   for(let c=0;c<3;c++){v.fromArray(asset.vertices,asset.indices[s.cluster*192+t*3+c]*4).applyMatrix4(worldMatrix);centre.add(new THREE.Vector3(v.x,v.y,v.z));points.push(v.clone().applyMatrix4(vp).toArray());}
   if(points.some(p=>p[2]<0))setup.nearClipped++;
   const clipped=clipNearPlane(points);if(clipped.length<3){setup.backfaceOrDegenerate++;continue;}
   const screen=clipped.map(p=>[Math.fround((p[0]/p[3]*.5+.5)*width),Math.fround((.5-p[1]/p[3]*.5)*height),Math.fround(p[2]/p[3])]);
   const [a,b,c]=screen;const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
   if(area>=-1e-8){setup.backfaceOrDegenerate++;continue;}
   if(Math.max(...screen.map(p=>p[0]))<0||Math.max(...screen.map(p=>p[1]))<0||Math.min(...screen.map(p=>p[0]))>=width||Math.min(...screen.map(p=>p[1]))>=height){setup.outsideViewport++;continue;}
   const offset=primitiveCount*14;for(let i=0;i<4;i++)projected.set(screen[Math.min(i,screen.length-1)],offset+i*3);
   projected[offset+12]=screen.length;projected[offset+13]=centre.multiplyScalar(1/3).distanceTo(camera.position);
   ids[primitiveCount]=((s.a?0x80000000:0)|(s.slot*64+t))>>>0;primitiveCount++;
  }
 }
 const capacity=geometry==='full'?assets[0].lods[0].clusterCount+assets[1].lods[0].clusterCount*world.treeInstances.length/4:8192+32768;
 const dispatchWidth=Math.min(capacity,65535);counts.binDispatchInvocations=dispatchWidth*Math.ceil(capacity/dispatchWidth)*64;counts.idleBinInvocations=counts.binDispatchInvocations-counts.paddedTriangleSlots;
 return {gpu:{assets,matrices,selected,vp,camera,world},projected,ids,primitiveCount,width,height,counts,setup,sourceTriangles:assets[0].sourceTriangleCount+assets[1].sourceTriangleCount*world.treeInstances.length/4,assetBytes:assets.reduce((n,a)=>n+a.bytes,0),camera:{position:camera.position.toArray(),pitch,yaw,fov:50},geometry,density};
}
