import * as THREE from 'three/webgpu';
import { buildGroupAsset } from '../buildNaniteLiteAsset.js';

// Conservative triangle/box SAT. Occupancy comes from surfaces, never from
// filling a tree's bounding box. Empty canopy gaps remain empty cells.
export function triangleBoxOverlap(a,b,c,centre,half) {
  const v=[a,b,c].map(p=>p.map((x,i)=>x-centre[i]));
  const sub=(p,q)=>p.map((x,i)=>x-q[i]);
  const cross=(p,q)=>[p[1]*q[2]-p[2]*q[1],p[2]*q[0]-p[0]*q[2],p[0]*q[1]-p[1]*q[0]];
  const edges=[sub(v[1],v[0]),sub(v[2],v[1]),sub(v[0],v[2])];
  const axes=[[1,0,0],[0,1,0],[0,0,1],cross(edges[0],edges[1])];
  for(const e of edges)for(const axis of [[1,0,0],[0,1,0],[0,0,1]])axes.push(cross(e,axis));
  for(const axis of axes){
    const p=v.map(q=>q[0]*axis[0]+q[1]*axis[1]+q[2]*axis[2]);
    const r=half*(Math.abs(axis[0])+Math.abs(axis[1])+Math.abs(axis[2]));
    if(Math.min(...p)>r+1e-8||Math.max(...p)<-r-1e-8)return false;
  }
  return true;
}
export function voxelizeSurface(geometry,cell=.4){
  const positions=geometry.attributes.position,colors=geometry.attributes.color,normals=geometry.attributes.normal;
  const index=geometry.index.array,cells=new Map(),key=(x,y,z)=>`${x},${y},${z}`;
  for(let t=0;t<index.length;t+=3){
    const ids=[index[t],index[t+1],index[t+2]],v=ids.map(i=>[positions.getX(i),positions.getY(i),positions.getZ(i)]);
    const lo=[0,1,2].map(d=>Math.floor(Math.min(...v.map(p=>p[d]))/cell)),hi=[0,1,2].map(d=>Math.floor(Math.max(...v.map(p=>p[d]))/cell));
    const color=colors?[0,1,2].map(d=>ids.reduce((n,i)=>n+colors.array[i*3+d],0)/3):[.3,.5,.3];
    const normal=[0,1,2].map(d=>ids.reduce((n,i)=>n+normals.array[i*3+d],0)/3);
    for(let z=lo[2];z<=hi[2];z++)for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++){
      if(!triangleBoxOverlap(...v,[(x+.5)*cell,(y+.5)*cell,(z+.5)*cell],cell/2))continue;
      const k=key(x,y,z);let entry=cells.get(k);
      if(!entry){entry={xyz:[x,y,z],color:[0,0,0],normal:[0,0,0],count:0};cells.set(k,entry);}
      entry.count++;for(let d=0;d<3;d++){entry.color[d]+=color[d];entry.normal[d]+=normal[d];}
    }
  }
  const p=[],n=[],c=[],indices=[];
  // Exposed faces only. Cubes are an explicit hardware emulation of voxel
  // rasterization, not Epic's brick ray traversal or stochastic normal model.
  const faces=[
    [[1,0,0],[[1,0,0],[1,1,0],[1,1,1],[1,0,1]]],
    [[-1,0,0],[[0,0,1],[0,1,1],[0,1,0],[0,0,0]]],
    [[0,1,0],[[0,1,1],[1,1,1],[1,1,0],[0,1,0]]],
    [[0,-1,0],[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]],
    [[0,0,1],[[1,0,1],[1,1,1],[0,1,1],[0,0,1]]],
    [[0,0,-1],[[0,0,0],[0,1,0],[1,1,0],[1,0,0]]]
  ];
  for(const entry of cells.values())for(const [axis,corners] of faces){
    const xyz=entry.xyz;if(cells.has(key(...xyz.map((v,i)=>v+axis[i]))))continue;
    const base=p.length/3,length=Math.hypot(...entry.normal);
    for(const corner of corners){p.push(...xyz.map((v,i)=>(v+corner[i])*cell));n.push(...(length>1e-8?entry.normal.map(v=>v/length):axis));c.push(...entry.color.map(v=>v/entry.count));}
    indices.push(base,base+1,base+2,base,base+2,base+3);
  }
  const result=new THREE.BufferGeometry();
  for(const [name,values] of [['position',p],['normal',n],['color',c]])result.setAttribute(name,new THREE.Float32BufferAttribute(values,3));
  result.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(p.length/3*2),2));result.setIndex(indices);
  result.userData={cell,occupiedCells:cells.size};return result;
}
// A new root switches the entire tree representation using projected error.
// Its child is the original triangle hierarchy; they are never drawn together.
export async function addVoxelRoot(asset,geometry,cell=.4){
  const voxel=voxelizeSurface(geometry,cell);
  const coarse=await buildGroupAsset(voxel,{lodTargets:[{ratio:1,error:0,weights:[0,0,0,0,0],flags:[]}]});
  const merge=(a,b)=>{const out=new a.constructor(a.length+b.length);out.set(a);out.set(b,a.length);return out;};
  const result={...asset,hierarchy:true,voxelRoot:true,voxelCell:cell,voxelCells:voxel.userData.occupiedCells};
  const vertexOffset=asset.vertexCount,clusterOffset=asset.totalClusters;
  result.vertices=merge(asset.vertices,coarse.vertices);result.normals=merge(asset.normals,coarse.normals);result.uvs=merge(asset.uvs,coarse.uvs);
  result.vertexCount=result.vertices.length/4;
  result.indices=merge(asset.indices,coarse.indices.map(i=>i+vertexOffset));
  for(const name of ['clusterBounds','clusterConeApex','clusterConeAxis','clusterLod','clusterTriangleCounts'])result[name]=merge(asset[name],coarse[name]);
  // Averaged leaf normals describe shading, not reliable backface cones.
  for(let i=clusterOffset;i<result.clusterConeApex.length/4;i++)result.clusterConeApex[i*4+3]=-1;
  result.totalClusters=clusterOffset+coarse.totalClusters;
  result.sourceColors=new THREE.BufferAttribute(merge(geometry.attributes.color.array,voxel.attributes.color.array),3);
  const oldNodes=asset.hierarchy?asset.groupCount:asset.groupCount*6;
  result.groupCount=oldNodes+1;result.groupLods=new Float32Array(result.groupCount*24);result.groupBounds=new Float32Array(result.groupCount*4);
  geometry.computeBoundingSphere();const sphere=geometry.boundingSphere;
  result.groupBounds.set([...sphere.center.toArray(),sphere.radius+cell*Math.sqrt(3)]);
  result.groupLods.set([cell*Math.sqrt(3),clusterOffset,coarse.totalClusters,coarse.sourceTriangleCount]);
  result.groupLods.set([result.groupCount,asset.hierarchy?1:asset.groupCount,5,0],4);
  if(asset.hierarchy){
    result.groupLods.set(asset.groupLods,24);result.groupBounds.set(asset.groupBounds,4);
    for(let i=1;i<result.groupCount;i++)result.groupLods[(i*6+1)*4]++;
  }else{
    for(let g=0;g<asset.groupCount;g++)for(let level=5;level>=0;level--){
      const node=1+g*6+5-level;
      result.groupBounds.set(asset.groupBounds.subarray(g*4,g*4+4),node*4);
      result.groupLods.set(asset.groupLods.subarray((g*6+level)*4,(g*6+level)*4+4),node*24);
      result.groupLods.set([1+(g+1)*6,level>0?1:0,level,0],node*24+4);
    }
  }
  result.bytes=(asset.bytes??0)+coarse.bytes+result.groupLods.byteLength+result.groupBounds.byteLength;
  voxel.dispose();return result;
}
