import * as THREE from 'three/webgpu';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const WORLD_SIZE = 160;

// A deterministic mountain valley with a winding, walkable route to the ruins.
export function terrainHeight(x, z) {
  const routeX = 8 * Math.sin(z * .055);
  const valley = 1 - Math.exp(-(((x - routeX) / 18) ** 2));
  const ridge = 12 + 9 * Math.sin(z * .036 + .7) ** 2;
  const detail = Math.sin(x * .22 + Math.sin(z * .12)) * Math.cos(z * .19) * 1.3
    + Math.sin(x * .71 + z * .44) * .28;
  const base = 1.2 + valley * (ridge + detail) + 1.1 * Math.sin(z * .045);
  // Flatten the ruined courtyard while blending its perimeter into the valley.
  const courtyard = THREE.MathUtils.smoothstep(Math.hypot(x, z + 28), 11, 20);
  return THREE.MathUtils.lerp(1.8, base, courtyard);
}

export function createGameScene(mobile = false) {
  let seed = 731;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const parts = [];
  const obstacles = [];
  function paint(geometry, tint, variation = .12) {
    const positions = geometry.attributes.position;
    const colors = new Float32Array(positions.count * 3);
    const base = new THREE.Color(tint);
    const shade = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const noise = Math.sin(positions.getX(i) * 3.1 + positions.getY(i) * 2.4 + positions.getZ(i) * 2.7);
      shade.copy(base).multiplyScalar(1 + variation * noise);
      shade.toArray(colors, i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (!geometry.index) {
      geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from({length:positions.count}, (_,i)=>i), 1));
    }
    if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(positions.count * 2),2));
    parts.push(geometry);
  }
  const segments = mobile ? 160 : 256;
  const ground = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segments, segments);
  ground.rotateX(-Math.PI / 2);
  const p = ground.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  ground.computeVertexNormals();
  paint(ground, 0x617446, 0);
  const grass = new THREE.Color(0x596b34), rock = new THREE.Color(0x77766b), trail = new THREE.Color(0xa58e62);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), y = p.getY(i);
    const slope = 1 - ground.attributes.normal.getY(i);
    c.copy(grass).lerp(rock, THREE.MathUtils.clamp(slope * 3 + (y - 15) * .07, 0, 1));
    const route = Math.abs(x - 8 * Math.sin(z * .055));
    const path = 1 - THREE.MathUtils.smoothstep(route, 1.6, 3.8);
    c.lerp(trail, path * .8);
    c.multiplyScalar(.9 + .1 * Math.sin(x * 1.7) * Math.cos(z * 1.2));
    ground.attributes.color.setXYZ(i, c.r, c.g, c.b);
  }
  function stone(x, z, radius) {
    const g = new THREE.IcosahedronGeometry(1, 3);
    g.scale(radius, radius * (.7 + random() * .5), radius * (.7 + random() * .4));
    g.rotateY(random() * Math.PI);
    g.translate(x, terrainHeight(x,z) + radius * .3, z);
    paint(g, 0x777b72, .16);
    obstacles.push({x,z,radius:radius * .85});
  }
  for (let i = 0; i < 70; i++) {
    const x = (random() - .5) * 140, z = (random() - .5) * 140;
    if (Math.abs(x - 8 * Math.sin(z * .055)) < 5 || Math.hypot(x,z+28) < 16) continue;
    stone(x,z,.7 + random() * 2.5);
  }
  for (let i = 0; i < 95; i++) {
    const x = (random() - .5) * 135, z = (random() - .5) * 135;
    if (Math.abs(x - 8 * Math.sin(z * .055)) < 6 || Math.hypot(x,z+28) < 17) continue;
    const y = terrainHeight(x,z), h = 4 + random() * 5;
    const trunk = new THREE.CylinderGeometry(.18,.32,h*.65,8,3);
    trunk.translate(x,y+h*.325,z); paint(trunk,0x584735);
    for (let tier = 0; tier < 3; tier++) {
      const crown = new THREE.ConeGeometry(h*(.27-tier*.045),h*.52,10,4);
      crown.translate(x,y+h*(.47+tier*.19),z);
      paint(crown, tier===2 ? 0x426349 : 0x294e3b,.14);
    }
    obstacles.push({x,z,radius:.38});
  }
  // Broken stone gateway and paired colonnades frame the walkable courtyard.
  function block(x,y,z,w,h,d) {
    const g = new THREE.BoxGeometry(w,h,d,3,3,3);
    g.translate(x,y+h/2,z); paint(g,0xb0a58d,.055);
  }
  for (const x of [-6,6]) for (const z of [-19,-27,-35]) {
    const h = z===-27 ? 5.5 : 3.8 + random() * 1.8;
    block(x,1.8,z,1.65,.45,1.65);
    const column = new THREE.CylinderGeometry(.55,.7,h,16,10);
    column.translate(x,2.25+h/2,z); paint(column,0xb0a58d,.08);
    block(x,2.25+h,z,1.8,.45,1.8);
    obstacles.push({x,z,radius:1});
  }
  for (const x of [-3.8,3.8]) {
    block(x,1.8,-14,1.8,6,2.2); obstacles.push({x,z:-14,radius:1.2});
  }
  block(0,7.8,-14,9.4,1.25,2.2);
  for (const x of [-9,9]) {
    block(x,1.8,-31,1.2,2.6,15);
    obstacles.push({x,z:-31,halfX:.6,halfZ:7.5});
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('Unable to assemble the terrain scene.');
  for (const part of parts) part.dispose();
  const geometry = mergeVertices(merged);
  merged.dispose();
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return {geometry, obstacles, heightAt:terrainHeight, spawn:[8,0,36], bounds:WORLD_SIZE/2-2};
}
