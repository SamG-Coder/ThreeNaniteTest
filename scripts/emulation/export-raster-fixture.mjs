// Small native-GPU regression workload: clipping, ties, padding, partial tiles
// and >32 candidates. --capacity=1 in the runner forces exhaustive overflow.
import {mkdirSync,writeFileSync} from 'node:fs';
import {forestBoundedWGSL,forestDispatchWGSL} from '../../src/bitmask/forestBoundedShaders.js';
import {forestFastWGSL} from '../../src/bitmask/forestFastShaders.js';
const out=process.argv[2]??'/tmp/forest-fixture';mkdirSync(out,{recursive:true});
const save=(name,data)=>writeFileSync(`${out}/${name}.bin`,new Uint8Array(data.buffer));
const matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
const vertices=new Float32Array(64*3*12),indices=new Uint32Array(193);
for(let t=0;t<64;t++){
 const z=.9-(t%13)*.06;
 let points=[[-.95,-.95,z],[.95,-.95,z],[0,.95,z]];
 if(t%7===0)points[0][2]=-.3; // near-plane clipped quad
 if(t%7===1){points[0][2]=-.3;points[1][2]=-.3;} // clipped triangle
 if(t%7===2)points[0][2]=0; // exactly on near plane
 if(t%7===3)points[2]=points[1]; // padded degenerate
 if(t%7===4)points=points.map(p=>[p[0],p[1],-.2]); // wholly behind
 if(t%7===5)points.reverse(); // back face
 for(let c=0;c<3;c++){
  const v=t*3+c;indices[v]=v;
  vertices.set([...points[c],1,0,1,0,0,(t%5)/5,.4,.8,1],v*12);
 }
}
for(let a=0;a<2;a++){
 save(`${a}-vertices`,vertices);save(`${a}-indices`,indices);
 save(`${a}-matrices`,matrix);save(`${a}-visible`,new Uint32Array([0,0]));
}
const bytes=new ArrayBuffer(128),f=new Float32Array(bytes),u=new Uint32Array(bytes);
f.set(matrix);f.set([0,0,2,1],16);u.set([13,11,2,4],20);u.set([1,1,192,192],24);u.set([8388608,0,0,2],28);save('params',new Uint8Array(bytes));
for(const [name,code] of Object.entries({bounded:forestBoundedWGSL,fast:forestFastWGSL,dispatch:forestDispatchWGSL}))writeFileSync(`${out}/${name}.wgsl`,code);
writeFileSync(`${out}/manifest.json`,JSON.stringify({width:13,height:11,capacity:[1,1],fixture:'near clipping, depth ties, degenerate padding, back faces, partial tiles, multi-batch'},null,2));
