import * as THREE from 'three/webgpu';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
// Separate riparian alder asset: curved limbs, buttress roots and thin pointed
// leaves attached to twigs. No spheres, cubes or legacy forest canopy geometry.
export function createLandscapeTree(){
 let seed=187419;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 const parts=[],up=new THREE.Vector3(0,1,0),base=new THREE.Color();
 const finish=(g,leaf=false)=>{
  const p=g.attributes.position,c=new Float32Array(p.count*3);base.set(leaf?0x547437:0x756454);
  for(let i=0;i<p.count;i++){const light=leaf?.75+.3*random():.86+.12*Math.sin(p.getY(i)*11+p.getX(i)*5);c.set([base.r*light,base.g*light,base.b*light],i*3);}
  g.setAttribute('color',new THREE.BufferAttribute(c,3));g.setAttribute('foliage',new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(leaf?1:0),1));
  g.setAttribute('surface',new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(leaf?3:2),1));parts.push(g);
 };
 const limb=(points,radius,radial=16,steps=24)=>{
  const curve=new THREE.CatmullRomCurve3(points),g=new THREE.TubeGeometry(curve,steps,radius,radial,false),p=g.attributes.position;
  for(let i=0;i<=steps;i++){
   const t=i/steps,center=curve.getPointAt(t),taper=.08+.92*(1-t)**.85;
   for(let j=0;j<=radial;j++){
    const k=i*(radial+1)+j,angle=j/radial*Math.PI*2;
    const flute=1+.075*Math.sin(angle*9+t*3)+.045*Math.sin(angle*17-t*8);
    p.setXYZ(k,center.x+(p.getX(k)-center.x)*taper*flute,center.y+(p.getY(k)-center.y)*taper*flute,center.z+(p.getZ(k)-center.z)*taper*flute);
   }
  }g.computeVertexNormals();finish(g);return curve;
 };
 const V=(x,y,z)=>new THREE.Vector3(x,y,z);
 limb([V(0,0,0),V(.18,4,.06),V(-.12,8,.35),V(.6,12,.4),V(.3,15,.2)],.66,64,120);
 for(let i=0;i<7;i++){const a=i*2.39996;limb([V(Math.cos(a)*1.7,.03,Math.sin(a)*1.7),V(Math.cos(a)*.8,.22,Math.sin(a)*.8),V(.04,1.7,0)],.2,20,24);}
 const leafTemplate=new THREE.BufferGeometry(),lp=[],li=[],luv=[];
 // A curved, serrated leaf with a raised midrib; explicit reverse faces leave
 // real holes between leaves and do not rely on opaque alpha-card rectangles.
 for(let row=0;row<=8;row++){
  const t=row/8,w=Math.sin(Math.PI*t)**.8*.15*(row%2?.92:1);
  for(let col=0;col<3;col++){const side=col-1;lp.push(side*w,.022*Math.sin(Math.PI*t)*(1-Math.abs(side))+.045*t*t,t*.52);luv.push(col/2,t);}
 }
 for(let r=0;r<8;r++)for(let c=0;c<2;c++){const a=r*3+c,b=a+1,d=a+3,e=d+1;li.push(a,d,b,b,d,e);}
 leafTemplate.setAttribute('position',new THREE.Float32BufferAttribute(lp,3));leafTemplate.setAttribute('uv',new THREE.Float32BufferAttribute(luv,2));leafTemplate.setIndex(li);leafTemplate.computeVertexNormals();
 const back=[];for(let i=0;i<li.length;i+=3)back.push(li[i+2],li[i+1],li[i]);leafTemplate.setIndex([...li,...back]);
 for(let i=0;i<20;i++){
  const a=i*2.399963+random()*.5,y=3.8+i*.5,len=Math.sqrt(Math.max(.1,1-((y-8)/7)**2))*(4.3+random()*1.3),end=V(Math.cos(a)*len,y+2.2+random(),Math.sin(a)*len);
  const branch=limb([V(0,y,0),V(end.x*.45,y+.7,end.z*.45),end],.19,24,36);
  for(let j=0;j<7;j++){
   const t=.3+j*.095,start=branch.getPoint(t),ta=a+(j%2?1:-1)*(.65+random()*.6),length=1.2+random()*1.1;
   const tip=start.clone().add(V(Math.cos(ta)*length,.65+random()*.6,Math.sin(ta)*length));
   const twig=limb([start,start.clone().lerp(tip,.5).add(V(0,.16,0)),tip],.035,8,12);
   for(let k=0;k<20;k++){
    const u=.15+k*.042,at=twig.getPoint(u),rotation=ta+(k%2?1:-1)*(1.1+random()*.4),g=leafTemplate.clone();
    const size=.75+random()*.55;g.scale(size,size,size);g.rotateX(-.15-random()*.8);g.rotateY(rotation);g.translate(...at.toArray());finish(g,true);
   }
  }
 }
 leafTemplate.dispose();const g=mergeGeometries(parts,false);parts.forEach(p=>p.dispose());g.computeBoundingBox();g.computeBoundingSphere();return g;
}
