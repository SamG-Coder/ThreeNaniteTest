import {loadCookedAsset} from './cookedAsset.js';
import * as THREE from 'three/webgpu';
import {buildClusterAsset} from './buildClusterAsset.js';
import {pageLayout} from '../streaming/pages.js';
const VERSION='cluster-bricks-v1';
const request=r=>new Promise((resolve,reject)=>{r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
const complete=t=>new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error??Error('Geometry cache transaction aborted'));t.onerror=()=>reject(t.error);});
async function database(){const r=indexedDB.open(VERSION,1);r.onupgradeneeded=()=>r.result.createObjectStore('data');return request(r);}
async function keyFor(g){
 const parts=[VERSION];for(const name of ['position','normal','uv','color','surface','foliage']){const a=g.attributes[name]?.array;parts.push(name,a??'none');}parts.push(g.index.array);
 const digest=await crypto.subtle.digest('SHA-256',await new Blob(parts).arrayBuffer());return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
function plain(asset){const result={...asset};delete result.pages;for(const name of ['sourceColors','sourceSurface'])result[name]={array:asset[name].array,itemSize:asset[name].itemSize};return result;}
function hydrate(metadata){for(const name of ['sourceColors','sourceSurface'])metadata[name]=new THREE.BufferAttribute(metadata[name].array,metadata[name].itemSize);return metadata;}
async function read(db,key){const tx=db.transaction('data','readonly');return request(tx.objectStore('data').get(key));}
async function write(db,entries){const tx=db.transaction('data','readwrite'),done=complete(tx);for(const [key,value]of entries)tx.objectStore('data').put(value,key);await done;}
async function compress(words){return new Response(new Blob([words]).stream().pipeThrough(new CompressionStream('gzip'))).blob();}
async function decompress(blob){if(!blob)throw Error('Missing cooked geometry page');return new Uint32Array(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());}
// Compressed persistent geometry pages; only roots and pending uploads need CPU
// page data. The original source geometry remains available for the hardware mode.
async function cook(g,options){
 if(typeof Worker==='undefined')return buildClusterAsset(g,options);
 const worker=new Worker(new URL('./buildWorker.js',import.meta.url),{type:'module'});
 return new Promise((resolve,reject)=>{
  worker.onmessage=({data})=>{if(data.progress){options.onProgress?.(...data.progress);return;}worker.terminate();if(data.error)reject(Error(data.error));else resolve(hydrate(data.asset));};
  worker.onerror=error=>{worker.terminate();reject(Error(error.message));};
  const attributes={};for(const [name,a]of Object.entries(g.attributes))attributes[name]={array:a.array,itemSize:a.itemSize};worker.postMessage({attributes,index:g.index.array});
 });
}
export async function buildStoredClusterAsset(g,options={}){
 if(options.cookedName){try{const cooked=await loadCookedAsset(options.cookedName,options.onProgress);if(cooked)return cooked;}catch(error){console.warn('Prepared geometry unavailable; building locally',error);}}
 if(typeof indexedDB==='undefined'||typeof CompressionStream==='undefined'||!globalThis.crypto?.subtle)return cook(g,options);
 let db,key,asset;
 try{
  db=await database();key=await keyFor(g);const metadata=await read(db,`${key}:meta`);
  if(metadata){asset=hydrate(metadata);asset.pages=new Array(asset.totalClusters);}
  else{
   asset=await cook(g,options);
   for(let first=0;first<asset.pages.length;first+=32){options.onProgress?.('Caching compressed geometry pages',`${first} / ${asset.pages.length}`);const entries=await Promise.all(asset.pages.slice(first,first+32).map(async(page,i)=>[`${key}:${first+i}`,await compress(page)]));await write(db,entries);}
   // Publish metadata last, so interrupted builds can never expose missing pages.
   await write(db,[[`${key}:meta`,plain(asset)]]);
  }
  const pinned=pageLayout(asset).pinned;
  const roots=await Promise.all(pinned.map(id=>read(db,`${key}:${id}`).then(decompress)));
  asset.pages=new Array(asset.totalClusters);pinned.forEach((id,i)=>asset.pages[id]=roots[i]);
  asset.pageProvider={get:id=>read(db,`${key}:${id}`).then(decompress),close:()=>db.close()};asset.storage='indexeddb-gzip';return asset;
 }catch(error){db?.close();console.warn('Persistent geometry cache unavailable; using memory pages',error);
  if(asset&&asset.pages?.filter(Boolean).length===asset.totalClusters)return asset;
  return cook(g,options);
 }
}
