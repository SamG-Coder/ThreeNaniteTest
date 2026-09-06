import {triangleBoxOverlap} from '../streaming/voxels.js';
import {clipToCell,addProjectedCoverage,projectedCoverage} from '../streaming/coverage.js';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const pack3=(v,bits,signed=false)=>{const max=(1<<bits)-1;return v.reduce((w,x,i)=>w|Math.round(clamp(signed?x*.5+.5:x,0,1)*max)<<(i*bits),0)>>>0;};
// Sparse 4³ bricks. No cube-face mesh is generated: the renderer ray-traverses
// occupied cells. Coverage is measured by clipping original triangles into cells.
export function buildBricks(g,indices,bounds,resolution=16){
 const p=g.attributes.position,n=g.attributes.normal,c=g.attributes.color,uv=g.attributes.uv,surface=g.attributes.surface;
 const size=Math.max(...bounds.max.map((v,i)=>v-bounds.min[i]),.001)/resolution;
 const origin=bounds.min.map(v=>v-size*.0001),cells=new Map();
 for(let t=0;t<indices.length;t+=3){
  const ids=[indices[t],indices[t+1],indices[t+2]],v=ids.map(i=>[p.getX(i),p.getY(i),p.getZ(i)]);
  const a=v[1].map((x,j)=>x-v[0][j]),b=v[2].map((x,j)=>x-v[0][j]);
  const area=Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])*.5;if(area<1e-12)continue;
  const lo=[0,1,2].map(j=>Math.max(0,Math.floor((Math.min(...v.map(q=>q[j]))-origin[j])/size)));
  const hi=[0,1,2].map(j=>Math.min(resolution,Math.floor((Math.max(...v.map(q=>q[j]))-origin[j])/size)));
  for(let z=lo[2];z<=hi[2];z++)for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++){
   const xyz=[x,y,z],min=xyz.map((v,j)=>origin[j]+v*size),center=min.map(v=>v+size*.5);
   if(!triangleBoxOverlap(...v,center,size*.5))continue;
   const clipped=clipToCell(v,min,size);if(clipped.length<3)continue;
   const key=xyz.join(',');let cell=cells.get(key);
   if(!cell){cell={xyz,masks:new Uint32Array(6),weight:0,color:[0,0,0],normal:[0,0,0],second:[0,0,0],uv:[0,0],material:new Map()};cells.set(key,cell);}
   addProjectedCoverage(cell.masks,clipped,min,size);
   // Area-weight the clipped polygon, avoiding bias from source tessellation.
   let weight=0;for(let k=1;k<clipped.length-1;k++){const a=clipped[k].map((x,j)=>x-clipped[0][j]),b=clipped[k+1].map((x,j)=>x-clipped[0][j]);weight+=Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])*.5;}
   if(weight<1e-15)continue;cell.weight+=weight;
   for(let j=0;j<3;j++){const normal=ids.reduce((sum,i)=>sum+n.array[i*3+j],0)/3;cell.normal[j]+=normal*weight;cell.second[j]+=normal*normal*weight;cell.color[j]+=ids.reduce((sum,i)=>sum+(c?.array[i*3+j]??.5),0)/3*weight;}
   for(let j=0;j<2;j++)cell.uv[j]+=ids.reduce((sum,i)=>sum+(uv?.array[i*2+j]??0),0)/3*weight;
   const material=surface?.getX(ids[0])??0;cell.material.set(material,(cell.material.get(material)??0)+weight);
  }
 }
 const bricks=new Map();
 for(const cell of cells.values()){
  if(cell.weight===0)continue;
  const coverage=[0,1,2].map(i=>projectedCoverage(cell.masks,i));if(!coverage.some(v=>v>0))continue;
  cell.coverage=coverage;const coord=cell.xyz.map(v=>Math.floor(v/4)),key=coord.join(',');
  if(!bricks.has(key))bricks.set(key,{coord,cells:[]});bricks.get(key).cells.push(cell);
 }
 const sorted=[...bricks.values()].sort((a,b)=>a.coord[2]-b.coord[2]||a.coord[1]-b.coord[1]||a.coord[0]-b.coord[0]),pages=[];
 for(let first=0;first<sorted.length;first+=8){
  const group=sorted.slice(first,first+8),count=group.reduce((n,b)=>n+b.cells.length,0),words=new Uint32Array(16+group.length*8+count*8),floats=new Float32Array(words.buffer);
  words[0]=1;words[1]=group.length;floats[2]=size;let cursor=16+group.length*8;
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  group.forEach((brick,i)=>{
   const o=16+i*8,xyz=brick.coord.map((v,j)=>origin[j]+v*4*size);floats.set([...xyz,size],o);words[o+6]=cursor;
   brick.cells.sort((a,b)=>(a.xyz[0]%4+4*(a.xyz[1]%4)+16*(a.xyz[2]%4))-(b.xyz[0]%4+4*(b.xyz[1]%4)+16*(b.xyz[2]%4)));
   for(let j=0;j<3;j++){min[j]=Math.min(min[j],xyz[j]);max[j]=Math.max(max[j],xyz[j]+size*4);}
   for(const cell of brick.cells){
    const bit=cell.xyz[0]%4+4*(cell.xyz[1]%4)+16*(cell.xyz[2]%4);words[o+4+(bit>>>5)]|=1<<(bit&31);
    const divide=v=>v/cell.weight,material=[...cell.material].sort((a,b)=>b[1]-a[1])[0][0];
    words[cursor]=pack3(cell.color.map(divide),8)|(material<<24);words[cursor+1]=pack3(cell.normal.map(divide),10,true);
    words[cursor+2]=pack3(cell.second.map(divide),10);words[cursor+3]=pack3(cell.coverage,8);
    floats.set(cell.uv.map(divide),cursor+4);floats[cursor+7]=cell.weight;cursor+=8;
   }
  });
  const center=min.map((v,j)=>(v+max[j])*.5),radius=Math.hypot(...max.map((v,j)=>v-center[j]));pages.push({words,bounds:[...center,radius],bricks:group.length,voxels:count});
 }
 return {pages,error:size*Math.sqrt(3),cellSize:size,voxelCount:[...bricks.values()].reduce((n,b)=>n+b.cells.length,0)};
}
