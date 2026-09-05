// Clip actual leaf surfaces to each cell before estimating projected coverage.
// The union of 8x8 samples avoids counting front/back leaf triangles twice.
export function clipToCell(triangle, lo, cell) {
 let polygon=triangle;
 for(let axis=0;axis<3;axis++)for(const side of [0,1]){
  const boundary=lo[axis]+side*cell,inside=p=>side?p[axis]<=boundary:p[axis]>=boundary;
  const out=[];
  for(let i=0;i<polygon.length;i++){
   const a=polygon[i],b=polygon[(i+1)%polygon.length],ia=inside(a),ib=inside(b);
   if(ia)out.push(a);
   if(ia!==ib){const t=(boundary-a[axis])/(b[axis]-a[axis]);out.push(a.map((v,d)=>v+(b[d]-v)*t));}
  }
  polygon=out;if(!polygon.length)return [];
 }
 return polygon;
}
export function addProjectedCoverage(masks,polygon,lo,cell){
 for(let axis=0;axis<3;axis++){
  const u=(axis+1)%3,v=(axis+2)%3;
  const points=polygon.map(p=>[(p[u]-lo[u])/cell,(p[v]-lo[v])/cell]);
  if(points.length<3)continue;
  const area=points.reduce((a,p,i)=>{const q=points[(i+1)%points.length];return a+p[0]*q[1]-p[1]*q[0];},0);
  if(Math.abs(area)<1e-10)continue;
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){
   const px=(x+.5)/8,py=(y+.5)/8;let inside=true;
   for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];
    if(((b[0]-a[0])*(py-a[1])-(b[1]-a[1])*(px-a[0]))*Math.sign(area)<-1e-9){inside=false;break;}
   }
   if(inside){const bit=y*8+x;masks[axis*2+(bit>>>5)]|=1<<(bit&31);}
  }
 }
}
export function projectedCoverage(masks,axis){
 let count=0;for(let word=0;word<2;word++){let bits=masks[axis*2+word]>>>0;while(bits){bits=(bits&(bits-1))>>>0;count++;}}
 return count/64;
}
