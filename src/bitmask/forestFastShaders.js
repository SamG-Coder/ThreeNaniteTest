import { forestBoundedWGSL } from './forestBoundedShaders.js';

function replaceOnce(source, before, after) {
  if(source.split(before).length!==2)throw new Error('Forest fast-path shader marker changed');
  return source.replace(before,after);
}
let code=replaceOnce(forestBoundedWGSL,
  '  let inputPoints=array<vec4<f32>,3>(s.a,s.b,s.c);',
  `  // Most forest triangles do not cross the near plane. Preserve the full
  // clipper below for crossings and keep the same screen/depth arithmetic.
  if(s.a.z>=0.0 && s.b.z>=0.0 && s.c.z>=0.0){
    var t:Triangle;t.info=s.info;t.color=s.color;t.normal=s.normal;
    t.a=screen(s.a);t.b=screen(s.b);t.c=screen(s.c);t.d=t.c;
    if(edge(t.a.xy,t.b.xy,t.c.xy)<-1e-8){t.info.y=3u;}
    return t;
  }
  let inputPoints=array<vec4<f32>,3>(s.a,s.b,s.c);`);
// 512 additional workgroup bytes, not a per-triangle/per-pixel depth cache.
code=replaceOnce(code,'var<workgroup> pixelMasks:',
  'var<workgroup> batchColors:array<vec3<f32>,32>;\nvar<workgroup> pixelMasks:');
code=replaceOnce(code,'batchTriangles[local.x]=makeTriangle(batchIds[local.x]);',
  'let t=makeTriangle(batchIds[local.x]);batchTriangles[local.x]=t;batchColors[local.x]=shade(t);');
code=replaceOnce(code,'color=shade(t);','color=batchColors[bit];');
code=replaceOnce(code,
  'let bit=firstTrailingBit(bits);let t=batchTriangles[bit];let z=sampleDepth(t,point);',
  `let bit=firstTrailingBit(bits);let t=batchTriangles[bit];var z:f32;
      // A set mask bit proves coverage and the depth range were tested above.
      // For an unclipped triangle, only interpolation needs to be repeated.
      // A clipped quad still needs sampleDepth to choose its covered fan.
      if(t.info.y==3u){
        let area=edge(t.a.xy,t.c.xy,t.b.xy);
        let e0=edge(t.c.xy,t.b.xy,point);let e1=edge(t.b.xy,t.a.xy,point);let e2=edge(t.a.xy,t.c.xy,point);
        z=(e0*t.a.z+e1*t.c.z+e2*t.b.z)/area;
      }else{z=sampleDepth(t,point);}`);
export const forestFastWGSL=code;
