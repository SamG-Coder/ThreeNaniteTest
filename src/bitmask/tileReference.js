import {edge} from './reference.js';
function outside(a,b,lo,hi){
  const maximum=Math.max(...[lo,hi,[lo[0],hi[1]],[hi[0],lo[1]]].map(p=>edge(a,b,p)));
  const dx=Math.abs(b[0]-a[0]),dy=Math.abs(b[1]-a[1]);
  const ex=Math.max(Math.abs(lo[0]-a[0]),Math.abs(hi[0]-a[0]));
  const ey=Math.max(Math.abs(lo[1]-a[1]),Math.abs(hi[1]-a[1]));
  return maximum < -(1e-4+1e-5*(dx*ey+dy*ex));
}
export function tileMayCover(points,lo,hi){
  const fan=(a,b,c)=>{if(edge(a,b,c)<0)[b,c]=[c,b];return !outside(b,c,lo,hi)&&!outside(c,a,lo,hi)&&!outside(a,b,lo,hi);};
  return fan(...points.slice(0,3))||(points.length===4&&fan(points[0],points[2],points[3]));
}
export function conservativeNearest(points){
  const span=Math.max(...[0,1].map(k=>Math.max(...points.map(p=>p[k]))-Math.min(...points.map(p=>p[k]))));
  let area=Math.abs(edge(...points.slice(0,3)));
  if(points.length===4)area=Math.min(area,Math.abs(edge(points[0],points[2],points[3])));
  if(area<=1e-8)return -1e30;
  const slack=1e-5*Math.max(1,span*span/area)*Math.max(1,...points.map(p=>Math.abs(p[2])));
  return Math.min(...points.map(p=>p[2]))-slack;
}
export function tileHidden(points,depths){
  const farthest=Math.max(...depths);
  return farthest<1&&conservativeNearest(points)>farthest+1e-5;
}
