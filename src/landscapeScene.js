import * as THREE from 'three/webgpu';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createLandscapeTree} from './landscapeTree.js';
export const LANDSCAPE_PRESETS={compact:{trees:80,grass:7000,grid:192},high:{trees:160,grass:16000,grid:320},ultra:{trees:320,grass:30000,grid:448}};
const smooth=THREE.MathUtils.smoothstep;
export function landscapeHeight(x,z){
 const r=Math.hypot(x/1.3,(z+12)/.86),angle=Math.atan2(z+12,x);
 const shore=r+1.3*Math.sin(angle*5)+.7*Math.cos(angle*9);
 const bank=smooth(shore,24,37);
 const rim=smooth(Math.hypot(x*.85,z*.8),43,110);
 const rolling=2.2*Math.sin(x*.053+.4)*Math.cos(z*.046)+.65*Math.sin(x*.19+z*.12)+.22*Math.sin(x*.62-z*.41);
 const ridge=10+9*Math.sin(x*.028-z*.018)**2+12*smooth(-z,45,110);
 return -3.8+bank*(6+rolling*.6+rim*ridge);
}
export function landscapePath(x,z){return Math.abs(x-(18+13*Math.sin(z*.029)));}
function colored(g,base){
 const p=g.attributes.position,n=g.attributes.normal,c=new Float32Array(p.count*3),color=new THREE.Color();
 for(let i=0;i<p.count;i++){
  const shade=.85+.12*Math.sin(p.getX(i)*4+p.getZ(i)*3)+.03*n.getY(i);
  color.copy(base).multiplyScalar(shade);c.set(color.toArray(),i*3);
 }
 g.setAttribute('color',new THREE.BufferAttribute(c,3));g.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(1),1));return g;
}
function makeGrass(random,count,trees){
 const positions=[],normals=[],colors=[],indices=[];let placed=0;
 const root=new THREE.Color(0x344326),tip=new THREE.Color(0x82924b),dry=new THREE.Color(0xa89963),c=new THREE.Color();
 for(let attempt=0;placed<count&&attempt<count*30;attempt++){
  const angle=random()*Math.PI*2,radius=34+random()**2*63;
  const x=Math.cos(angle)*radius*1.3,z=Math.sin(angle)*radius*.86-12,y=landscapeHeight(x,z);
  if(Math.abs(x)>107||Math.abs(z)>107||y<.7||landscapePath(x,z)<1.8||Math.hypot(x-30,z-14)<3)continue;
  const patch=.5+.28*Math.sin(x*.22)*Math.sin(z*.17)+.22*Math.sin(x*.071+z*.057);
  if(random()>patch)continue;
  if(trees.some(t=>Math.hypot(x-t.x,z-t.z)<t.radius+.15))continue;
  placed++;
  const tuft=.35+random()*.4;
  for(let blade=0;blade<4;blade++){
   const angle=random()*Math.PI*2,dx=Math.cos(angle),dz=Math.sin(angle),width=.025+random()*.035,height=tuft*(.55+random()*.7),lean=.12+random()*.22;
   const bx=x+(random()-.5)*.26,bz=z+(random()-.5)*.26,by=landscapeHeight(bx,bz)-.015,base=positions.length/3;
   const points=[[-width,0,0],[width,0,0],[-width*.6,height*.55,lean*.35],[width*.6,height*.55,lean*.35],[0,height,lean]];
   for(let v=0;v<points.length;v++){
    const [side,up,bend]=points[v];positions.push(bx+dx*side-dz*bend,by+up,bz+dz*side+dx*bend);
    // Upward-biased leaf normals keep tiny blades readable under hemisphere light.
    const normal=new THREE.Vector3(-dz,.65,dx).normalize();normals.push(...normal.toArray());
    c.copy(root).lerp(tip,up/height).lerp(dry,Math.max(0,(patch-.7)*1.5));colors.push(...c.toArray());
   }
   // Double-sided actual geometry; no alpha cards or hidden extra grass draw.
   for(const tri of [[0,1,2],[1,3,2],[2,3,4]])indices.push(...tri.map(i=>base+i),...tri.slice().reverse().map(i=>base+i));
  }
 }
 const g=new THREE.BufferGeometry();
 for(const[name,data]of[['position',positions],['normal',normals],['color',colors]])g.setAttribute(name,new THREE.Float32BufferAttribute(data,3));
 g.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(positions.length/3).fill(4),1));
 g.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(positions.length/3*2),2));g.setIndex(indices);return {geometry:g,clumps:placed};
}
export function createLandscapeScene(density='high'){
 const preset=LANDSCAPE_PRESETS[density];if(!preset)throw new Error('Unknown landscape density');
 let seed=572912;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const ground=new THREE.PlaneGeometry(224,224,preset.grid,preset.grid).rotateX(-Math.PI/2),p=ground.attributes.position;
 for(let i=0;i<p.count;i++)p.setY(i,landscapeHeight(p.getX(i),p.getZ(i)));ground.computeVertexNormals();
 const sand=new THREE.Color(0xb7ab84),earth=new THREE.Color(0x76664b),moss=new THREE.Color(0x52603c),rock=new THREE.Color(0x7b827c),color=new THREE.Color();
 const colors=new Float32Array(p.count*3);
 for(let i=0;i<p.count;i++){
  const x=p.getX(i),y=p.getY(i),z=p.getZ(i),slope=1-ground.attributes.normal.getY(i);
  color.copy(sand).lerp(moss,smooth(y,.4,3.2));color.lerp(rock,smooth(slope,.12,.4));
  color.lerp(earth,(1-smooth(landscapePath(x,z),1.1,2.6))*smooth(y,.8,2));
  color.multiplyScalar(.91+.08*Math.sin(x*.55+z*.33)*Math.cos(z*.67));colors.set(color.toArray(),i*3);
 }
 ground.setAttribute('color',new THREE.BufferAttribute(colors,3));
 ground.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(p.count),1));
 const parts=[ground],obstacles=[],data=[];
 for(let attempt=0;data.length/4<preset.trees&&attempt<50000;attempt++){
  const x=(random()-.5)*199,z=(random()-.5)*199,y=landscapeHeight(x,z);
  if(y<2.6||landscapePath(x,z)<4||Math.hypot(x-30,z-14)<8||obstacles.some(o=>Math.hypot(x-o.x,z-o.z)<4.5))continue;
  const scale=.72+random()*.65;data.push(x,y,z,scale);obstacles.push({x,z,radius:.65*scale});
 }
 const grass=makeGrass(random,preset.grass,obstacles);parts.push(grass.geometry);
 for(let i=0;i<65;i++){
  const angle=random()*Math.PI*2,r=32+random()*60,x=Math.cos(angle)*r*1.15,z=Math.sin(angle)*r-12,y=landscapeHeight(x,z);
  if(y<.8||landscapePath(x,z)<3||Math.hypot(x-30,z-14)<6)continue;
  const size=.65+random()*2.4,g=new THREE.SphereGeometry(1,64,48),v=g.attributes.position;
  for(let j=0;j<v.count;j++){
   const a=v.getX(j),b=v.getY(j),c=v.getZ(j),noise=1+.12*Math.sin(a*9+c*6)*Math.sin(b*11-c*4);
   v.setXYZ(j,a*noise*size,b*noise*size*.65,c*noise*size*.82);
  }
  g.computeVertexNormals();colored(g,new THREE.Color(0x858a7c));g.rotateY(random()*Math.PI);g.translate(x,y+size*.14,z);parts.push(g);obstacles.push({x,z,radius:size*.75});
 }
 const geometry=mergeGeometries(parts,false);for(const part of parts)part.dispose();geometry.computeBoundingSphere();geometry.computeBoundingBox();
 return {name:'Willowmere Valley',landscape:true,forest:true,geometry,treeGeometry:createLandscapeTree(),treeInstances:new Float32Array(data),
  obstacles,heightAt:landscapeHeight,blockedAt:(x,z)=>landscapeHeight(x,z)<.65,spawn:[30,0,14],spawnYaw:Math.atan2(30,26),spawnPitch:-.09,bounds:106,
  grassClumps:grass.clumps,water:{x:0,z:-12,y:.35,radius:39,scaleX:1.3,scaleZ:.86}};
}
