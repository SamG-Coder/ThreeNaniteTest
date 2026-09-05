import * as THREE from 'three/webgpu';

export function createFixture(name) {
  const triangles = [];
  if (name === 'torus') {
    const geometry = new THREE.TorusKnotGeometry(.85, .25, 48, 8);
    const p = geometry.attributes.position, indices = geometry.index.array;
    for (let i = 0; i < indices.length; i += 3) triangles.push([0,1,2].map(c => {
      const v = indices[i+c]; return [p.getX(v),p.getY(v),p.getZ(v)];
    }));
    geometry.dispose();
  } else if (name === 'edge') {
    triangles.push([[-1,-1,0],[1,-1,0],[-1,1,0]], [[1,-1,0],[1,1,0],[-1,1,0]]);
  } else {
    const count = name === 'overflow' ? 160 : name === 'tie' ? 4 : 32;
    for (let id = 0; id < count; id++) {
      const z = name === 'tie' ? 0 : -.4 + .8 * id / (count - 1);
      triangles.push([[-1,-.8,z],[1,-.8,z],[0,1,z]]);
    }
  }
  const data = new Float32Array(triangles.length * 16);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  triangles.forEach((t, id) => {
    t.forEach((p, corner) => data.set([...p,1],id*16+corner*4));
    a.fromArray(t[0]); b.fromArray(t[1]); c.fromArray(t[2]);
    const normal = b.sub(a).cross(c.sub(a)).normalize();
    const light = .35 + .65 * Math.abs(normal.dot(new THREE.Vector3(.3,.7,.6).normalize()));
    const color = new THREE.Color().setHSL((id / Math.max(1,triangles.length) * .65 + .45) % 1,.65,.55);
    data.set([color.r*light,color.g*light,color.b*light,1],id*16+12);
  });
  return { triangles, data, count: triangles.length };
}
