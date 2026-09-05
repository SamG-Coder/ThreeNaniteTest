import {mkdirSync,writeFileSync} from 'node:fs';
import {visibilityWGSL,cullWGSL,pyramidWGSL,pyramidBaseWGSL} from '../../src/visibility/shaders.js';
const out=process.argv[2]??'/tmp/visibility-fixture';mkdirSync(out,{recursive:true});
const save=(name,data)=>writeFileSync(`${out}/${name}.bin`,new Uint8Array(data.buffer));
const sets=[
 [[[-.95,-.95,.2],[.05,-.95,.2],[.05,.95,.2]],[[-.95,-.95,.2],[.05,.95,.2],[-.95,.95,.2]]],
 [[[-.75,-.1,.8],[-.55,-.1,.8],[-.65,.1,.8]]],
 [[[.1,-.1,.8],[.3,-.1,.8],[.2,.1,.8]]],
 [[[-.2,.4,-.1],[.2,.4,.4],[0,.7,.4]]]
];
const vertices=[],indices=new Uint32Array(sets.length*192+sets.length),bounds=[];
for(let cluster=0;cluster<sets.length;cluster++){
 const points=sets[cluster].flat();const lo=[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),hi=[0,1,2].map(k=>Math.max(...points.map(p=>p[k])));
 const centre=lo.map((x,i)=>(x+hi[i])/2),radius=Math.max(...points.map(p=>Math.hypot(...p.map((x,i)=>x-centre[i]))));bounds.push(...centre,radius+.001);
 const base=vertices.length/12;
 for(const tri of sets[cluster])for(const p of tri)vertices.push(...p,1,0,1,0,0,.2+cluster*.15,.5,.3,1);
 for(let t=0;t<64;t++)for(let c=0;c<3;c++)indices[cluster*192+t*3+c]=t<sets[cluster].length?base+t*3+c:base;
}
const identity=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
for(let i=0;i<2;i++){
 save(`${i}-vertices`,Float32Array.from(vertices));save(`${i}-indices`,indices);save(`${i}-bounds`,Float32Array.from(bounds));save(`${i}-matrices`,identity);
 // Tree copies are behind the same foreground surface; only asset A is selected.
 save(`${i}-visible`,i?new Uint32Array(0):Uint32Array.from(sets.flatMap((_,j)=>[0,j])));
}
// Nonzero binding range for an empty selected list.
save('1-visible',new Uint32Array([0,0]));
const data=new ArrayBuffer(128),f=new Float32Array(data),u=new Uint32Array(data);f.set(identity);f.set([0,0,2,1],16);u.set([65,49,9,63],20);u.set([4,0,768,768],24);u.set([0,0,0,4],28);save('params',new Uint8Array(data));
writeFileSync(`${out}/manifest.json`,JSON.stringify({width:65,height:49,capacity:[4,0],clusterCounts:[4,4],instanceCounts:[1,1],fixture:'solid occluder, hidden cluster, uncovered gap, near-plane crossing, partial tiles'},null,2));
for(const [n,c] of Object.entries({visibility:visibilityWGSL,cull:cullWGSL,pyramid:pyramidWGSL,base:pyramidBaseWGSL}))writeFileSync(`${out}/${n}.wgsl`,c);
