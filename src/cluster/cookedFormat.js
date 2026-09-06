const types={Float32Array,Uint32Array,Uint16Array,Uint8Array,Int32Array};
export function encodeMetadata(asset){
 const buffers=[];let offset=0;const plain={...asset};delete plain.pages;delete plain.pageProvider;
 for(const name of ['sourceColors','sourceSurface'])plain[name]={array:asset[name].array,itemSize:asset[name].itemSize};
 const json=new TextEncoder().encode(JSON.stringify(plain,(_,value)=>{if(!ArrayBuffer.isView(value))return value;const descriptor={$typed:value.constructor.name,offset,length:value.length};const bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);buffers.push(bytes);offset+=Math.ceil(bytes.length/4)*4;return descriptor;}));
 const start=Math.ceil((4+json.length)/4)*4,result=new Uint8Array(start+offset);new DataView(result.buffer).setUint32(0,json.length,true);result.set(json,4);let cursor=start;for(const b of buffers){result.set(b,cursor);cursor+=Math.ceil(b.length/4)*4;}return result;
}
export function decodeMetadata(bytes){
 const length=new DataView(bytes).getUint32(0,true),start=Math.ceil((4+length)/4)*4;
 return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,4,length)),(_,v)=>v?.$typed?new types[v.$typed](bytes,start+v.offset,v.length):v);
}
export function encodePages(pages){const lengths=new Uint32Array(pages.length+1);lengths[0]=pages.length;pages.forEach((p,i)=>lengths[i+1]=p.length);const words=new Uint32Array(lengths.length+pages.reduce((n,p)=>n+p.length,0));words.set(lengths);let o=lengths.length;for(const p of pages){words.set(p,o);o+=p.length;}return words;}
export function decodePages(buffer){const words=new Uint32Array(buffer),pages=[];let o=words[0]+1;for(let i=0;i<words[0];i++){pages.push(words.subarray(o,o+words[i+1]));o+=words[i+1];}return pages;}
