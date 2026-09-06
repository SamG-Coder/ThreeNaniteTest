// Static instance BVH, including geometry outside the camera frustum.
export function buildInstanceBVH(pipelines){
 const leaves=[];
 pipelines.forEach((p,asset)=>{const s=p.asset.groupBounds,instances=p.instanceDataAttribute.array;for(let i=0;i<p.instanceCount;i++){
  const o=i*4,scale=instances[o+3],angle=i*.61803398875,c=Math.cos(angle),sn=Math.sin(angle),center=[instances[o]+scale*(c*s[0]-sn*s[2]),instances[o+1]+scale*s[1],instances[o+2]+scale*(sn*s[0]+c*s[2])],r=s[3]*Math.abs(scale);
  leaves.push({asset,instance:i,center,min:center.map(v=>v-r),max:center.map(v=>v+r)});
 }});
 const nodes=[];
 function build(items){const index=nodes.length,n={};nodes.push(n);n.min=[0,1,2].map(a=>Math.min(...items.map(i=>i.min[a])));n.max=[0,1,2].map(a=>Math.max(...items.map(i=>i.max[a])));
  if(items.length===1)n.leaf=items[0];else{const axis=[0,1,2].sort((a,b)=>(n.max[b]-n.min[b])-(n.max[a]-n.min[a]))[0];items.sort((a,b)=>a.center[axis]-b.center[axis]);const mid=items.length>>1;build(items.slice(0,mid));build(items.slice(mid));}n.escape=nodes.length;
 }
 if(leaves.length)build(leaves);
 const data=new Float32Array(Math.max(1,nodes.length)*12);nodes.forEach((n,i)=>{data.set([...n.min,n.escape,...n.max,n.leaf?1:0,n.leaf?.asset??0,n.leaf?.instance??0,0,0],i*12);});return {data,count:nodes.length};
}
