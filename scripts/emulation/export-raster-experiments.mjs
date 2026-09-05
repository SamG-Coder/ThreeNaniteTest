import {writeFileSync,mkdirSync} from 'node:fs';
const out=process.argv[2]??'/tmp/forest-profile';mkdirSync(out,{recursive:true});
import {forestBoundedWGSL as base} from '../../src/bitmask/forestBoundedShaders.js';
const start=base.indexOf('    atomicStore(&pixelMasks[local.x],0u);');
const end=base.indexOf('\n    workgroupBarrier();\n  }',start);
const pixel=base.slice(0,start)+`    if(local.x<count){batchTriangles[local.x]=makeTriangle(batchIds[local.x]);}
    workgroupBarrier();
    if(coord.x<params.size.x && coord.y<params.size.y){
      for(var i=0u;i<count;i++){
        let t=batchTriangles[i];
        let lo=min(min(t.a.xy,t.b.xy),min(t.c.xy,t.d.xy));
        let hi=max(max(t.a.xy,t.b.xy),max(t.c.xy,t.d.xy));
        if(any(point<lo)||any(point>hi)){continue;}
        let z=sampleDepth(t,point);
        if(z>=0.0 && (z<best || (z==best && t.info.x<winner))){best=z;winner=t.info.x;color=shade(t);}
      }
    }`+base.slice(end);
writeFileSync(`${out}/pixel.wgsl`,pixel);
const shaded=base.replace('var<workgroup> pixelMasks:','var<workgroup> batchColors:array<vec3<f32>,32>;\nvar<workgroup> pixelMasks:').replace('batchTriangles[local.x]=makeTriangle(batchIds[local.x]);','let t=makeTriangle(batchIds[local.x]);batchTriangles[local.x]=t;batchColors[local.x]=shade(t);').replace('color=shade(t);','color=batchColors[bit];');
writeFileSync(`${out}/shaded.wgsl`,shaded);
const fast=base.replace('let bit=firstTrailingBit(bits);let t=batchTriangles[bit];let z=sampleDepth(t,point);',`let bit=firstTrailingBit(bits);let t=batchTriangles[bit];var z:f32;
      if(t.info.y==3u){
        let area=edge(t.a.xy,t.c.xy,t.b.xy);
        let e0=edge(t.c.xy,t.b.xy,point);let e1=edge(t.b.xy,t.a.xy,point);let e2=edge(t.a.xy,t.c.xy,point);
        z=(e0*t.a.z+e1*t.c.z+e2*t.b.z)/area;
      }else{z=sampleDepth(t,point);}`);
writeFileSync(`${out}/resolve.wgsl`,fast);
const clipfast=base.replace('  let inputPoints=array<vec4<f32>,3>(s.a,s.b,s.c);',`  if(s.a.z>=0.0 && s.b.z>=0.0 && s.c.z>=0.0){
    var t:Triangle;t.info=s.info;t.color=s.color;t.normal=s.normal;
    t.a=screen(s.a);t.b=screen(s.b);t.c=screen(s.c);t.d=t.c;
    if(edge(t.a.xy,t.b.xy,t.c.xy)<-1e-8){t.info.y=3u;}
    return t;
  }
  let inputPoints=array<vec4<f32>,3>(s.a,s.b,s.c);`);
writeFileSync(`${out}/clipfast.wgsl`,clipfast);
let combined=clipfast.replace('var<workgroup> pixelMasks:','var<workgroup> batchColors:array<vec3<f32>,32>;\nvar<workgroup> pixelMasks:').replace('batchTriangles[local.x]=makeTriangle(batchIds[local.x]);','let t=makeTriangle(batchIds[local.x]);batchTriangles[local.x]=t;batchColors[local.x]=shade(t);').replace('color=shade(t);','color=batchColors[bit];');
const fastResolve=fast.slice(fast.indexOf('let bit=firstTrailingBit(bits);'),fast.indexOf('\n      if(z>=0.0',fast.indexOf('let bit=firstTrailingBit(bits);')));
combined=combined.replace('let bit=firstTrailingBit(bits);let t=batchTriangles[bit];let z=sampleDepth(t,point);',fastResolve);
writeFileSync(`${out}/fast.wgsl`,combined);
