import {mkdirSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {prepareForest} from './emulation/forest.mjs';
import {emulateRaster,primitive,sample} from './emulation/raster.mjs';
const flags=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.join('=')];}));
const settings={density:flags.density??'high',geometry:flags.geometry??'full',width:Number(flags.width??384),height:Number(flags.height??704),pitch:Number(flags.pitch??.55),yaw:Number(flags.yaw??0)};
const out=flags.out??'docs/emulation';mkdirSync(out,{recursive:true});
console.log('Building actual forest assets:',settings);
const scene=await prepareForest(settings);console.log('Selection and projection:',scene.counts,scene.setup,'projected',scene.primitiveCount);
const variants=(flags.variants??'original,owned,cached,reject').split(',');let baseline;
const report={settings,earlyEmptyExperiment:flags.empty==='1',camera:scene.camera,sourceTriangles:scene.sourceTriangles,assetBytes:scene.assetBytes,selection:scene.counts,setup:scene.setup,projectedPrimitives:scene.primitiveCount,limitations:['CPU algorithm/work-count model, not phone GPU timing','Deterministic serial atomic insertion order; GPU ordering differs','Projected float32 values, JS arithmetic; no GPU FMA/bit-exact guarantee','Triangle projection memoized on CPU; repeated shader setup counted analytically','No hardware raster, lighting, sky/water, presentation, driver or cache emulation','Overflow aborts explicitly; no silent geometry truncation','Camera is reproducible, not recovered from screenshots'],variants:[],sources:{}};
for(const variant of variants){
 console.log('Rasterizing',variant);const result=emulateRaster(scene,variant,{capacity:Number(flags.capacity??8388608),order:flags.order??'forward',earlyEmpty:flags.empty==='1'});
 let idMismatch=0,depthMismatch=0;if(baseline)for(let i=0;i<result.ids.length;i++){if(result.ids[i]!==baseline.ids[i])idMismatch++;if(result.depths[i]!==baseline.depths[i])depthMismatch++;}else baseline=result;
 const verification=[];
 // Independent brute-force pixels bypass all bins, masks and tile rejection.
 for(const [x,y] of [[.25,.25],[.5,.5],[.75,.75],[.5,.8],[.1,.5],[.9,.5]]){
  const px=Math.floor(x*scene.width),py=Math.floor(y*scene.height);let best=1,id=0xffffffff;
  for(let p=0;p<scene.primitiveCount;p++){const z=sample(primitive(scene,p),[px+.5,py+.5]);if(z>=0&&(z<best||(z===best&&scene.ids[p]<id))){best=z;id=scene.ids[p];}}
  verification.push({pixel:[px,py],match:result.ids[py*scene.width+px]===id&&result.depths[py*scene.width+px]===best});
 }
 const checksum=createHash('sha256').update(new Uint8Array(result.ids.buffer)).update(new Uint8Array(result.depths.buffer)).digest('hex');
 report.variants.push({...result.stats,idMismatch,depthMismatch,checksum,verification});console.log(report.variants.at(-1));
 const pixels=Buffer.alloc(scene.width*scene.height*3);for(let i=0;i<result.ids.length;i++){const id=result.ids[i];pixels[i*3]=id===0xffffffff?12:(id*131)>>>0&255;pixels[i*3+1]=id===0xffffffff?18:(id*31)>>>0&255;pixels[i*3+2]=id===0xffffffff?24:(id*71)>>>0&255;}
 writeFileSync(`${out}/${variant}.ppm`,Buffer.concat([Buffer.from(`P6\n${scene.width} ${scene.height}\n255\n`),pixels]));
 writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2)+'\n');
 if(idMismatch||depthMismatch||verification.some(v=>!v.match))throw new Error('Emulation visibility mismatch');
}
function hashSources(dir){for(const item of readdirSync(dir,{withFileTypes:true})){const path=dir+'/'+item.name;if(item.isDirectory())hashSources(path);else if(/\.(js|mjs|css)$/.test(path))report.sources[path]=createHash('sha256').update(readFileSync(path)).digest('hex');}}
hashSources('src');hashSources('scripts');writeFileSync(`${out}/report.json`,JSON.stringify(report,null,2)+'\n');console.log('Saved',out+'/report.json');
