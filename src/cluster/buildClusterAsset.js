import * as THREE from 'three/webgpu';
import {MeshoptClusterizer} from 'three/addons/libs/meshopt_clusterizer.module.js';
import {packTexturedPage} from '../streaming/texturedPages.js';
import {buildBricks} from './brickBuilder.js';
// New representation hierarchy, not the six preset LODs. Leaves are original
// source meshlets. Parents compete with sparse-brick representations using their
// measured spatial support error; screen-space traversal selects the cut.
export async function buildClusterAsset(g,{onProgress=()=>{}}={}){
 if(!g.attributes.surface)g.setAttribute('surface',new THREE.Float32BufferAttribute(Array.from({length:g.attributes.position.count},(_,i)=>g.attributes.foliage?(g.attributes.foliage.getX(i)?3:2):0),1));
 await MeshoptClusterizer.ready;
 const p=g.attributes.position,n=g.attributes.normal,uv=g.attributes.uv,count=p.count,vertices=new Float32Array(count*4),normals=new Float32Array(count*4);
 for(let i=0;i<count;i++){vertices.set([p.getX(i),p.getY(i),p.getZ(i),1],i*4);normals.set([n.getX(i),n.getY(i),n.getZ(i),0],i*4);}
 const built=MeshoptClusterizer.buildMeshlets(g.index.array,p.array,3,64,64,.25),source=[];
 for(let m=0;m<built.meshletCount;m++){
  const mesh=MeshoptClusterizer.extractMeshlet(built,m),indices=Uint32Array.from(mesh.triangles,i=>mesh.vertices[i]);
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(const i of mesh.vertices)for(let j=0;j<3;j++){min[j]=Math.min(min[j],p.array[i*3+j]);max[j]=Math.max(max[j],p.array[i*3+j]);}
  source.push({indices,min,max,center:min.map((x,j)=>(x+max[j])*.5)});
 }
 const asset={brickHierarchy:true,hierarchy:true,vertices,normals,uvs:uv.array.slice(),vertexCount:count,sourceTriangleCount:g.index.count/3,sourceColors:g.attributes.color,sourceSurface:g.attributes.surface,pages:[],clusterKinds:[],clusterBounds:[],clusterTriangleCounts:[],clusterLod:[],clusterConeApex:[],clusterConeAxis:[],indices:[],nodes:[],groupBounds:[],groupLods:[]};
 const append=(page,bounds,kind,triangles,indices,level)=>{
  asset.pages.push(page);asset.clusterKinds.push(kind);asset.clusterBounds.push(...bounds);asset.clusterTriangleCounts.push(triangles);asset.clusterLod.push(level);
  asset.clusterConeApex.push(0,0,0,-1);asset.clusterConeAxis.push(0,1,0,1);asset.indices.push(...indices);
 };
 function trianglePage(indices,bounds,level){
  const padded=new Uint32Array(192);padded.fill(indices[0]);padded.set(indices);
  const input={vertices,normals,uvs:asset.uvs,indices:padded};const page=packTexturedPage(input,g.attributes.color,g.attributes.surface,0);
  append(page,bounds,0,indices.length/3,padded,level);
 }
 let processed=0;
 async function build(parts,depth){
  const id=asset.nodes.length,node={id,children:[],error:0,depth,level:Math.min(depth,5)};asset.nodes.push(node);
  const min=[0,1,2].map(j=>Math.min(...parts.map(p=>p.min[j]))),max=[0,1,2].map(j=>Math.max(...parts.map(p=>p.max[j]))),center=min.map((x,j)=>(x+max[j])*.5),radius=Math.hypot(...max.map((x,j)=>x-center[j]));
  node.bounds=[...center,radius+1e-5];node.start=asset.pages.length;
  if(parts.length===1)trianglePage(parts[0].indices,node.bounds,0);
  else{
   const indices=new Uint32Array(parts.reduce((sum,p)=>sum+p.indices.length,0));let offset=0;for(const part of parts){indices.set(part.indices,offset);offset+=part.indices.length;}
   const bricks=buildBricks(g,indices,{min,max},parts.length>16?8:16);
   const proxyTriangles=bricks.pages.reduce((sum,p)=>sum+p.bricks*2,0);
   // Empty or more expensive candidates are rejected. This comparison is a
   // representation cost heuristic; runtime measurements are reported separately.
   if(bricks.pages.length && proxyTriangles<indices.length/3){
    node.error=bricks.error;
    for(const page of bricks.pages)append(page.words,page.bounds,1,0,new Uint32Array(192),node.level);
   }else for(const part of parts)trianglePage(part.indices,[...part.center,Math.hypot(...part.max.map((x,j)=>x-part.center[j]))+1e-5],node.level);
  }
  node.count=asset.pages.length-node.start;
  if(parts.length>1){
   const axis=[0,1,2].sort((a,b)=>(max[b]-min[b])-(max[a]-min[a]))[0];parts.sort((a,b)=>a.center[axis]-b.center[axis]);const mid=Math.floor(parts.length/2);
   node.children.push(await build(parts.slice(0,mid),depth+1),await build(parts.slice(mid),depth+1));
   node.error=Math.max(node.error,...node.children.map(i=>asset.nodes[i].error));
  }
  node.maxCut=Math.max(node.count,node.children.reduce((sum,i)=>sum+asset.nodes[i].maxCut,0));
  node.escape=asset.nodes.length;
  if(++processed%32===0){onProgress(`Building triangle/brick hierarchy · ${processed}`,`${asset.pages.length} geometry pages`);if(typeof window!=='undefined'&&typeof requestAnimationFrame!=='undefined')await new Promise(requestAnimationFrame);}
  return id;
 }
 await build(source,0);
 const widths=[];for(const n of asset.nodes)widths[n.depth]=(widths[n.depth]??0)+1;asset.queueWidth=Math.max(...widths);
 asset.maxCutClusters=asset.nodes[0].maxCut;asset.pageWords=Uint32Array.from(asset.pages,p=>p.length);
 asset.groupCount=asset.nodes.length;asset.totalClusters=asset.pages.length;asset.hierarchyDepth=1+Math.ceil(Math.log2(source.length));
 asset.groupBounds=new Float32Array(asset.groupCount*4);asset.groupLods=new Float32Array(asset.groupCount*24);
 for(const node of asset.nodes){asset.groupBounds.set(node.bounds,node.id*4);asset.groupLods.set([node.error,node.start,node.count,asset.clusterTriangleCounts.slice(node.start,node.start+node.count).reduce((a,b)=>a+b,0),node.escape,node.children.length,node.level,0],node.id*24);}
 for(const name of ['clusterBounds','clusterConeApex','clusterConeAxis'])asset[name]=new Float32Array(asset[name]);
 for(const name of ['indices','clusterTriangleCounts','clusterLod','clusterKinds'])asset[name]=new Uint32Array(asset[name]);
 asset.lods=Array.from({length:6},(_,level)=>({level,clusterCount:level===0?source.length:0,triangleCount:level===0?asset.sourceTriangleCount:0,geometricError:0,indexCount:level===0?g.index.count:0}));
 asset.boundingRadius=asset.nodes[0].bounds[3]+Math.hypot(...asset.nodes[0].bounds.slice(0,3));
 asset.bytes=Object.values(asset).filter(ArrayBuffer.isView).reduce((s,a)=>s+a.byteLength,0)+asset.pages.reduce((s,p)=>s+p.byteLength,0);
 delete asset.nodes;return asset;
}
