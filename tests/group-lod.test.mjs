import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { buildNaniteLiteAsset, normaliseGeometry } from '../src/buildNaniteLiteAsset.js';

function triangles(asset, group, level) {
  const offset = (group * asset.lods.length + level) * 4;
  const first = asset.groupLods[offset + 1];
  const count = asset.groupLods[offset + 2];
  const result = [];
  for (let c = first; c < first + count; c++) {
    for (let t = 0; t < asset.clusterTriangleCounts[c]; t++) {
      result.push(Array.from(asset.indices.subarray(c * 192 + t * 3, c * 192 + t * 3 + 3)));
    }
  }
  return result;
}
function triangleKey(t) {
  const rotations = [t, [t[1], t[2], t[0]], [t[2], t[0], t[1]]];
  return rotations.map(v => v.join(',')).sort()[0];
}
function boundary(tris) {
  const counts = new Map();
  for (const t of tris) for (let i = 0; i < 3; i++) {
    const a = t[i], b = t[(i + 1) % 3];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count === 1).map(([key]) => key).sort();
}

test('group LODs preserve coverage, winding, boundary edges and bounds', async () => {
  const source = normaliseGeometry(new THREE.TorusKnotGeometry(1.25, .42, 64, 16));
  const asset = await buildNaniteLiteAsset(source, { meshletsPerGroup: 4 });
  assert.ok(asset.groupCount > 1);
  assert.ok(asset.lockedVertexCount > 0);
  assert.ok(asset.indices.every(index => index < asset.vertexCount));
  assert.ok(asset.clusterBounds.every(Number.isFinite));
  const fullResolution = [];
  for (let g = 0; g < asset.groupCount; g++) {
    const original = triangles(asset, g, 0);
    fullResolution.push(...original);
    const originalBoundary = boundary(original);
    const bounds = asset.groupBounds.subarray(g * 4, g * 4 + 4);
    let previousError = 0, previousCount = Infinity;
    for (let level = 0; level < asset.lods.length; level++) {
      const current = triangles(asset, g, level);
      assert.deepEqual(boundary(current), originalBoundary, `group ${g}, LOD ${level} changes boundary`);
      assert.ok(current.length <= previousCount);
      const error = asset.groupLods[(g * asset.lods.length + level) * 4];
      assert.ok(error >= previousError);
      previousError = error; previousCount = current.length;
      for (const triangle of current) for (const v of triangle) {
        const p = asset.vertices.subarray(v * 4, v * 4 + 3);
        assert.ok(Math.hypot(p[0]-bounds[0],p[1]-bounds[1],p[2]-bounds[2]) <= bounds[3]+1e-6);
      }
    }
  }
  const original = [];
  for (let i = 0; i < source.index.count; i += 3) original.push(Array.from(source.index.array.subarray(i, i+3)));
  assert.deepEqual(fullResolution.map(triangleKey).sort(), original.map(triangleKey).sort());
  assert.equal(asset.lods[0].triangleCount, original.length);
});

test('repeated builds produce deterministic group metadata and meshlets', async () => {
  const source = normaliseGeometry(new THREE.PlaneGeometry(4, 4, 12, 12));
  const a = await buildNaniteLiteAsset(source, { meshletsPerGroup: 2 });
  const b = await buildNaniteLiteAsset(source, { meshletsPerGroup: 2 });
  assert.deepEqual(a.groupLods, b.groupLods);
  assert.deepEqual(a.indices, b.indices);
});

test('invalid source data is rejected before WASM', async () => {
  const empty = new THREE.BufferGeometry();
  empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  await assert.rejects(buildNaniteLiteAsset(empty), /triangle|position/i);
  const source = new THREE.PlaneGeometry();
  source.index.array[0] = 100;
  await assert.rejects(buildNaniteLiteAsset(source), /index/i);
});

test('WebGPU frustum rejects geometry before its zero-depth near plane', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 1, 100);
  camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix, THREE.WebGPUCoordinateSystem);
  assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -.75)), false);
  assert.equal(frustum.containsPoint(new THREE.Vector3(0, 0, -2)), true);
});
