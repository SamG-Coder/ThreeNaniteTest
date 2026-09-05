import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const FOREST_COUNTS = { compact: 96, high: 256, ultra: 512 };
export function basinHeight(x,z) {
  const lakeDistance=Math.hypot(x,z+9);
  const lake=THREE.MathUtils.smoothstep(lakeDistance,20,34);
  const rim=THREE.MathUtils.smoothstep(Math.hypot(x*.9,z*.8),42,100);
  const ridges=14+8*Math.sin(x*.045+z*.035)**2;
  return -3.5+lake*(5+rim*ridges + 1.2*Math.sin(x*.14)*Math.cos(z*.12));
}
function tint(g,hex,amount=.15) {
  const p=g.attributes.position, base=new THREE.Color(hex), colors=new Float32Array(p.count*3);
  for(let i=0;i<p.count;i++) {
    const shade=1+amount*Math.sin(p.getX(i)*3+p.getY(i)*6+p.getZ(i)*4);
    colors.set([base.r*shade,base.g*shade,base.b*shade],i*3);
  }
  g.setAttribute('color',new THREE.BufferAttribute(colors,3));
  return g;
}
function roughen(g,amplitude,frequency) {
  const p=g.attributes.position,n=g.attributes.normal;
  for(let i=0;i<p.count;i++) {
    const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
    const d=amplitude*Math.sin(x*frequency+z*.7)*Math.sin(y*frequency*.8+z*frequency);
    p.setXYZ(i,x+n.getX(i)*d,y+n.getY(i)*d,z+n.getZ(i)*d);
  }
  g.computeVertexNormals();return g;
}
export function createDetailedTree() {
  const parts=[];
  const trunk=roughen(new THREE.CylinderGeometry(.24,.65,13,48,96),.07,13);
  trunk.translate(0,6.5,0);parts.push(tint(trunk,0x665342,.19));
  const up=new THREE.Vector3(0,1,0);
  for(let i=0;i<24;i++) {
    const a=i*2.399963, y=4+i*.31;
    const end=new THREE.Vector3(Math.cos(a)*(3.2+Math.sin(i)*.7),y+2.8,Math.sin(a)*(3.2+Math.sin(i)*.7));
    const start=new THREE.Vector3(0,y,0), dir=end.clone().sub(start);
    const branch=roughen(new THREE.CylinderGeometry(.055,.19,dir.length(),16,20),.018,20);
    branch.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up,dir.clone().normalize()));
    branch.translate(...start.clone().add(end).multiplyScalar(.5).toArray());parts.push(tint(branch,0x665342,.12));
    // Individual opaque leaf geometry with air between leaves, rather than
    // large solid canopy blobs or alpha-card overdraw.
    let seed = 137 + i * 731;
    const random = () => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; };
    for (let leaf = 0; leaf < 72; leaf++) {
      const theta=random()*Math.PI*2, u=random()*2-1, radius=Math.cbrt(random());
      const horizontal=Math.sqrt(1-u*u)*radius;
      const position=end.clone().add(new THREE.Vector3(
        Math.cos(theta)*horizontal*2.1,u*radius*1.4,Math.sin(theta)*horizontal*1.9));
      const g=new THREE.SphereGeometry(1,8,4);
      g.scale(.24+random()*.13,.012,.085+random()*.04);
      g.rotateZ((random()-.5)*1.6);g.rotateY(random()*Math.PI*2);
      g.translate(...position.toArray());
      parts.push(tint(g,leaf%3===0?0x738747:leaf%3===1?0x3e633c:0x557b45,.06));
    }

  }
  const merged=mergeGeometries(parts,false);
  for(const part of parts) part.dispose();
  // Vertex colors provide the tree material. Unused UV seams would otherwise
  // lock the tiny leaf surfaces and prevent meaningful geometric reduction.
  merged.attributes.uv.array.fill(0);
  const geometry=mergeVertices(merged);
  merged.dispose();
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  return geometry;
}
export function createForestScene(density='high') {
  const count=FOREST_COUNTS[density];
  if(!count) throw new Error('Unknown forest density.');
  const obstacles=[],parts=[];
  // More of the workload is in the forest, rather than subdividing empty land.
  const ground=new THREE.PlaneGeometry(210,210,384,384).rotateX(-Math.PI/2);
  const pos=ground.attributes.position;
  for(let i=0;i<pos.count;i++) pos.setY(i,basinHeight(pos.getX(i),pos.getZ(i)));
  ground.computeVertexNormals();tint(ground,0x768158,.1);
  const color=ground.attributes.color, sand=new THREE.Color(0xb6ad83),moss=new THREE.Color(0x59734b),stone=new THREE.Color(0x8c9387),c=new THREE.Color();
  for(let i=0;i<pos.count;i++) {
    const y=pos.getY(i), slope=1-ground.attributes.normal.getY(i);
    c.copy(sand).lerp(moss,THREE.MathUtils.smoothstep(y,.2,3.2));
    c.lerp(stone,THREE.MathUtils.clamp(slope*2+(y-17)*.045,0,1));
    color.setXYZ(i,c.r,c.g,c.b);
  }
  parts.push(ground);
  let seed=9201;
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const data=[];
  // Keep placements nested across presets, and clear a winding lakeside route.
  while(data.length/4<count) {
    const x=(random()-.5)*182,z=(random()-.5)*182;
    if(Math.hypot(x,z-62)<5 || Math.hypot(x,z+9)<33 || Math.abs(x-9*Math.sin(z*.035))<4 || Math.hypot(x-29,z-24)<10) continue;
    if(obstacles.some(o=>Math.hypot(x-o.x,z-o.z)<4)) continue;
    const scale=.75+random()*.6;
    data.push(x,basinHeight(x,z),z,scale);obstacles.push({x,z,radius:.65*scale});
  }
  // Granite outcrops have actual surface relief, not just a higher subdivision count.
  for(let i=0;i<48;i++) {
    const a=i*2.399963,r=30+random()*57,x=Math.cos(a)*r,z=Math.sin(a)*r-9;
    if(Math.hypot(x,z-62)<6 || Math.abs(x-9*Math.sin(z*.035))<5) continue;
    const g=roughen(new THREE.SphereGeometry(1,48,32),.18,9);
    const scale=1+random()*2.8;g.scale(scale,scale*.75,scale*.85);
    g.translate(x,basinHeight(x,z)+scale*.25,z);parts.push(tint(g,0x929a91,.12));
    obstacles.push({x,z,radius:scale*.8});
  }
  const geometry=mergeGeometries(parts,false);for(const p of parts)p.dispose();
  geometry.computeBoundingBox();geometry.computeBoundingSphere();
  // The lake is not swimmable; keep the walkable route on its shore.
  obstacles.push({x:0,z:-9,radius:25});
  return {geometry,treeGeometry:createDetailedTree(),treeInstances:new Float32Array(data),
    obstacles,heightAt:basinHeight,spawn:[0,0,62],bounds:100,forest:true};
}
