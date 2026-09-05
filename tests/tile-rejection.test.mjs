import test from 'node:test';
import assert from 'node:assert/strict';
import {tileMayCover,tileHidden} from '../src/bitmask/tileReference.js';
import {sampleDepth,resolveReference,EMPTY_ID} from '../src/bitmask/reference.js';
test('edge rejection never removes covered pixel centres, including partial tiles and clipped quads',()=>{
 let seed=7;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 let rejected=0;
 for(let i=0;i<1200;i++){
  const t=Array.from({length:3},()=>[random()*50-20,random()*50-20,random()]);
  const lo=[.5,.5],hi=i%2?[7.5,7.5]:[2.5,4.5];
  if(!tileMayCover(t,lo,hi)){
   rejected++;for(let y=lo[1];y<=hi[1];y++)for(let x=lo[0];x<=hi[0];x++)assert.equal(sampleDepth(t,[x,y]),-1);
  }
 }
 assert.ok(rejected>100);
 const quad=[[-2,-2,.5],[10,-2,.5],[10,10,.5],[-2,10,.5]];
 assert.equal(tileMayCover(quad,[.5,.5],[7.5,7.5]),true);
});
test('tile depth rejection preserves holes, ties, crossing depth and skinny triangles',()=>{
 const t=[[0,0,.8],[8,0,.9],[0,8,.85]],depths=Array(64).fill(.3);
 assert.equal(tileHidden(t,depths),true);
 depths[31]=1;assert.equal(tileHidden(t,depths),false);
 assert.equal(tileHidden(t,Array(64).fill(.8)),false);
 assert.equal(tileHidden([[0,0,.1],[8,0,.9],[0,8,.9]],Array(64).fill(.3)),false);
 assert.equal(tileHidden([[0,0,.8],[8,8,.8],[8,8+1e-9,.8]],Array(64).fill(.3)),false);
});
test('front bucket traversal with rejection matches exhaustive depth and IDs',()=>{
 const tris=[];
 for(let i=0;i<160;i++){const z=(i%10)/12+.05;tris.push(i%2?[[0,0,z],[8,8,z],[0,8,z]]:[[0,0,z],[8,0,z],[8,8,z]]);}
 const all=tris.map((_,i)=>i);
 const order=all.toReversed().sort((a,b)=>Math.floor(tris[a][0][2]*8)-Math.floor(tris[b][0][2]*8));
 const best=Array.from({length:64},()=>({depth:1,id:EMPTY_ID}));let rejected=0;
 for(let start=0;start<order.length;start+=32){
  const snapshot=best.map(p=>p.depth);
  const batch=order.slice(start,start+32).filter(id=>{if(tileHidden(tris[id],snapshot)){rejected++;return false;}return tileMayCover(tris[id],[.5,.5],[7.5,7.5]);});
  for(let pixel=0;pixel<64;pixel++){
   const next=resolveReference(tris,batch,[pixel%8+.5,Math.floor(pixel/8)+.5]);
   if(next.depth<best[pixel].depth||(next.depth===best[pixel].depth&&next.id<best[pixel].id))best[pixel]=next;
  }
 }
 assert.ok(rejected>0);
 best.forEach((v,pixel)=>assert.deepEqual(v,resolveReference(tris,all,[pixel%8+.5,Math.floor(pixel/8)+.5])));
});
