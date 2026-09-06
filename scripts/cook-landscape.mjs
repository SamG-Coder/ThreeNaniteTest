import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createLandscapeTree} from '../src/landscapeTree.js';
import {createLandscapeScene} from '../src/landscapeScene.js';
import {buildClusterAsset} from '../src/cluster/buildClusterAsset.js';
import {encodeMetadata,encodePages} from '../src/cluster/cookedFormat.js';
const batchSize=32;
async function save(name,geometry){
 console.log(`Cooking ${name}: ${geometry.index.count/3} triangles`);
 const asset=await buildClusterAsset(geometry),metadata=encodeMetadata(asset),version=createHash('sha256').update(metadata).digest('hex').slice(0,16),directory=`public/geometry/${name}`;
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(`${directory}/${version}-meta.bin.gz`,gzipSync(metadata));
 for(let first=0;first<asset.pages.length;first+=batchSize)await fs.writeFile(`${directory}/${version}-${first/batchSize}.bin.gz`,gzipSync(encodePages(asset.pages.slice(first,first+batchSize))));
 await fs.writeFile(`${directory}/manifest.json`,JSON.stringify({version,metadata:`${version}-meta.bin.gz`,batchSize}));console.log(`Cooked ${name}: ${asset.totalClusters} pages`);
}
const choice=process.argv[2];
if(choice==='tree')await save('valley-tree',createLandscapeTree());
for(const density of (choice==='tree'?[]:choice?[choice]:['compact','high','ultra'])){const world=createLandscapeScene(density);await save(`valley-${density}`,world.geometry);if(!choice&&density==='compact')await save('valley-tree',world.treeGeometry);world.geometry.dispose();world.treeGeometry.dispose();}
