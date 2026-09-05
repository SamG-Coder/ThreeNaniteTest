// Legacy experiments keep 48-byte vertices. Textured visibility uses 64 bytes
// so UVs remain float32 and are never reconstructed from world position.
export function packVisibilityVertices(asset,colors,surface){
 const stride=surface?16:12,out=new Float32Array(asset.vertexCount*stride);
 for(let i=0;i<asset.vertexCount;i++){
  const o=i*stride;out.set(asset.vertices.subarray(i*4,i*4+4),o);out.set(asset.normals.subarray(i*4,i*4+4),o+4);
  out.set(colors?[colors.getX(i),colors.getY(i),colors.getZ(i),asset.coverage?.[i]??1]:[.3,.5,.3,1],o+8);
  if(surface){out[o+7]=surface.getX(i);out[o+12]=asset.uvs[i*2];out[o+13]=asset.uvs[i*2+1];}
 }
 return out;
}
