import * as THREE from 'three/webgpu';
import {decodeMetadata,decodePages} from './cookedFormat.js';
import {pageLayout} from '../streaming/pages.js';
export async function loadCookedAsset(name,onProgress){
 const root=`${import.meta.env.BASE_URL}geometry/${name}/`;
 const response=await fetch(`${root}manifest.json`,{cache:'no-cache'});if(!response.ok)return null;const manifest=await response.json();
 const fetchData=async file=>{const r=await fetch(root+file);if(!r.ok)throw Error(`Geometry download failed: ${r.status}`);const bytes=await r.arrayBuffer(),magic=new Uint8Array(bytes,0,Math.min(2,bytes.byteLength));return magic[0]===31&&magic[1]===139?new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer():bytes;};
 onProgress?.('Loading prepared geometry','Downloading hierarchy and root pages…');
 const asset=decodeMetadata(await fetchData(manifest.metadata));for(const name of ['sourceColors','sourceSurface'])asset[name]=new THREE.BufferAttribute(asset[name].array,asset[name].itemSize);
 const batches=new Map();const getBatch=index=>{if(batches.has(index)){const p=batches.get(index);batches.delete(index);batches.set(index,p);return p;}const p=fetchData(`${manifest.version}-${index}.bin.gz`).then(decodePages).catch(e=>{batches.delete(index);throw e;});batches.set(index,p);if(batches.size>8)batches.delete(batches.keys().next().value);return p;};
 asset.pages=new Array(asset.totalClusters);asset.pageProvider={get:async id=>(await getBatch(Math.floor(id/manifest.batchSize)))[id%manifest.batchSize]};
 const pinned=pageLayout(asset).pinned;await Promise.all(pinned.map(async id=>asset.pages[id]=await asset.pageProvider.get(id)));asset.storage='http-gzip';return asset;
}
