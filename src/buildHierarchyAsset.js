import * as THREE from 'three/webgpu';
import { partitionMeshlets } from './partitionMeshlets.js';
import { buildGroupAsset, prepareSourceGeometry, packVec4 } from './buildNaniteLiteAsset.js';
import { LOD_TARGETS, VERTICES_PER_MESHLET } from './config.js';

const streams = ['indices', 'clusterBounds', 'clusterConeApex', 'clusterConeAxis', 'clusterLod', 'clusterTriangleCounts'];

// A nested spatial cluster tree. Each parent replaces ALL of its children.
// Parent simplification unlocks internal child borders, but keeps its own outer
// boundary fixed. No vertex positions are moved and no foliage instances vanish.
export async function buildHierarchyAsset(inputGeometry, options = {}) {
  const source = prepareSourceGeometry(inputGeometry);
  const { groups } = await partitionMeshlets(source.indexArray, source.positionArray, options.leafMeshlets ?? 8);
  const parts = [];
  let completed = 0;
  async function build(first, end) {
    const node = { id: parts.length, children: [], height: 0, error: 0 };
    parts.push(node); // Preorder: first child follows parent; escape skips subtree.
    let indices;
    if (end - first === 1) indices = groups[first];
    else {
      const middle = first + Math.floor((end - first) / 2);
      node.children = [await build(first, middle), await build(middle, end)];
      node.height = 1 + Math.max(...node.children.map(child => child.height));
      node.error = Math.max(...node.children.map(child => child.error));
      indices = new Uint32Array(node.children.reduce((n, child) => n + child.representative.length, 0));
      let offset = 0;
      for (const child of node.children) {
        indices.set(child.representative, offset); offset += child.representative.length;
        delete child.representative;
      }
    }
    const global = [...new Set(indices)];
    const local = new Map(global.map((index, i) => [index, i]));
    const geometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [
      ['position', source.positionArray, 3], ['normal', source.normalArray, 3], ['uv', source.uvArray, 2]
    ]) {
      const values = new Float32Array(global.length * size);
      global.forEach((index, i) => values.set(array.subarray(index * size, index * size + size), i * size));
      geometry.setAttribute(name, new THREE.BufferAttribute(values, size));
    }
    const localIndices = Uint32Array.from(indices, index => local.get(index));
    geometry.setIndex(new THREE.BufferAttribute(localIndices, 1));
    // Recompute locks at this node: old INTERNAL patch boundaries may collapse.
    const { locks } = await partitionMeshlets(localIndices, geometry.attributes.position.array, Number.MAX_SAFE_INTEGER);
    const targets = node.children.length ? [LOD_TARGETS[0], {
      ratio: 0.45, error: 0.1, weights: [0.03, 0.03, 0.03, 0.05, 0.05], flags: ['Regularize']
    }] : [LOD_TARGETS[0]];
    const packed = await buildGroupAsset(geometry, { lodTargets: targets, vertexLocks: locks });
    const lod = packed.lods.at(-1);
    node.error += lod.geometricError;
    node.level = Math.min(5, node.height);
    node.triangleCount = lod.triangleCount;
    node.clusterCount = lod.clusterCount;
    node.representative = new Uint32Array(lod.triangleCount * 3);
    let cursor = 0;
    for (let c = lod.clusterStart; c < lod.clusterStart + lod.clusterCount; c++) {
      const count = packed.clusterTriangleCounts[c] * 3;
      for (let i = 0; i < count; i++) node.representative[cursor++] = global[packed.indices[c * VERTICES_PER_MESHLET + i]];
    }
    for (const key of streams) {
      const stride = key === 'indices' ? VERTICES_PER_MESHLET : key.startsWith('clusterCone') || key === 'clusterBounds' ? 4 : 1;
      node[key] = packed[key].slice(lod.clusterStart * stride, (lod.clusterStart + lod.clusterCount) * stride);
    }
    for (let i = 0; i < node.indices.length; i++) node.indices[i] = global[node.indices[i]];
    node.clusterLod.fill(node.level);
    if (node.children.length) {
      // Enclose child spheres, including all original geometry and error support.
      const box = new THREE.Box3();
      for (const child of node.children) {
        box.expandByPoint(child.sphere.center.clone().addScalar(child.sphere.radius));
        box.expandByPoint(child.sphere.center.clone().addScalar(-child.sphere.radius));
      }
      const center = box.getCenter(new THREE.Vector3());
      node.sphere = new THREE.Sphere(center, Math.max(...node.children.map(child => center.distanceTo(child.sphere.center) + child.sphere.radius)) + 1e-5);
    } else {
      geometry.computeBoundingSphere();
      node.sphere = geometry.boundingSphere.clone(); node.sphere.radius += 1e-5;
    }
    node.escape = parts.length;
    geometry.dispose();
    if (++completed % 8 === 0) {
      options.onProgress?.(`Building hierarchy · ${completed} / ${groups.length * 2 - 1}`, 'Merging child geometry, simplifying in WASM and reclustering parents…');
      if (typeof requestAnimationFrame !== 'undefined') await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return node;
  }
  const root = await build(0, groups.length);
  delete root.representative;
  const asset = {
    hierarchy: true, hierarchyDepth: root.height + 1,
    vertices: packVec4(source.positionArray, 3, 1), normals: packVec4(source.normalArray, 3, 0), uvs: source.uvArray,
    vertexCount: source.vertexCount, sourceTriangleCount: source.indexArray.length / 3,
    groupCount: parts.length, groupBounds: new Float32Array(parts.length * 4),
    // Reuse existing GPU bindings: 6 vec4 rows per node, row 0 geometry, row 1 traversal.
    groupLods: new Float32Array(parts.length * 6 * 4), lockedVertexCount: 0,
    boundingRadius: root.sphere.center.length() + root.sphere.radius,
    lods: Array.from({ length: 6 }, (_, level) => ({ level, geometricError: 0, triangleCount: 0, clusterCount: 0, indexCount: 0 })),
    totalClusters: parts.reduce((n, node) => n + node.clusterCount, 0)
  };
  if (asset.totalClusters >= 2 ** 24 || parts.length >= 2 ** 24) throw new Error('Hierarchy exceeds exact GPU table addressing capacity.');
  for (const key of streams) {
    asset[key] = new (parts[0][key].constructor)(parts.reduce((n, node) => n + node[key].length, 0));
    let offset = 0;
    for (const node of parts) { asset[key].set(node[key], offset); offset += node[key].length; }
  }
  let clusterStart = 0;
  for (const node of parts) {
    asset.groupBounds.set([...node.sphere.center.toArray(), node.sphere.radius], node.id * 4);
    asset.groupLods.set([node.error, clusterStart, node.clusterCount, node.triangleCount], node.id * 24);
    asset.groupLods.set([node.escape, node.children.length, node.level, node.height], node.id * 24 + 4);
    clusterStart += node.clusterCount;
    const lod = asset.lods[node.level];
    lod.geometricError = Math.max(lod.geometricError, node.error);
    lod.triangleCount += node.triangleCount; lod.indexCount += node.triangleCount * 3; lod.clusterCount += node.clusterCount;
  }
  asset.bytes = Object.values(asset).filter(ArrayBuffer.isView).reduce((n, value) => n + value.byteLength, 0);
  source.geometry.dispose();
  return asset;
}

// CPU reference for tests/tools. Rendering uses the equivalent GPU traversal.
export function selectHierarchyCut(asset, camera, height, fov, threshold, scale = 1, forward = [0, 0, -1]) {
  const selected = [];
  for (let node = 0; node < asset.groupCount;) {
    const b = node * 4, m = node * 24;
    const distance = Math.max(0.01, [0, 1, 2].reduce((sum, i) => sum + (asset.groupBounds[b + i] * scale - camera[i]) * forward[i], 0) - asset.groupBounds[b + 3] * scale);
    const pixels = asset.groupLods[m] * scale * height / (2 * Math.tan(fov * Math.PI / 360) * distance);
    if (!asset.groupLods[m + 5] || pixels <= threshold) {
      selected.push(node); node = asset.groupLods[m + 4];
    } else node++;
  }
  return selected;
}
