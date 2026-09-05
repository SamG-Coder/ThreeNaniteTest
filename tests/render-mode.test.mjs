import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { NaniteLiteRenderer } from '../src/NaniteLiteRenderer.js';

// Exercise the actual baseline draw setup without requiring a GPU adapter.
test('full-resolution comparison preserves source topology and instance placement', () => {
  const source = new THREE.BoxGeometry();
  const pipeline = Object.create(NaniteLiteRenderer.prototype);
  Object.assign(pipeline, {
    asset: {}, scene: new THREE.Scene(), instanceCount: 2,
    instanceDataAttribute: { array: new Float32Array([3, 4, 5, 2, -4, 1, 6, .5]) }
  });
  pipeline.createBaselineMesh(source);
  const mesh = pipeline.baselineMesh;
  assert.notEqual(mesh.geometry, source);
  assert.deepEqual(mesh.geometry.index.array, source.index.array);
  assert.deepEqual(mesh.geometry.attributes.position.array, source.attributes.position.array);
  assert.equal(mesh.count, 2);
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(0, matrix);
  assert.deepEqual(new THREE.Vector3(1, 0, 0).applyMatrix4(matrix).toArray(), [5, 4, 5]);
  mesh.getMatrixAt(1, matrix);
  const result = new THREE.Vector3(1, 0, 0).applyMatrix4(matrix);
  assert.ok(Math.abs(result.x - (-4 + .5 * Math.cos(.61803398875))) < 1e-6);
  assert.ok(Math.abs(result.z - (6 + .5 * Math.sin(.61803398875))) < 1e-6);
  mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose(); source.dispose();
});

test('Nanite off bypasses compute and readback; switching restores visualization and invalidates history', () => {
  const pipeline = Object.create(NaniteLiteRenderer.prototype);
  let renders = 0;
  let stats;
  Object.assign(pipeline, {
    settings: { naniteEnabled: true, outputMode: 'meshlets' },
    renderer: {
      setRenderTarget() {}, clear() {}, render() { renders++; },
      compute() { assert.fail('Baseline must not dispatch Nanite compute'); }
    },
    naniteMesh: {}, baselineMesh: {}, materials: { meshlets: {} },
    hzbValidUniform: { value: 1 }, occlusionEnabledUniform: { value: 1 },
    previousFrameValid: true, blitQuad: { render() {} },
    asset: { sourceTriangleCount: 12, groupCount: 1, lods: [{}, {}], bytes: 100 },
    instanceCount: 2, onStats(value) { stats = value; }
  });
  pipeline.setNaniteEnabled(false);
  pipeline.render(0);
  assert.equal(renders, 1);
  assert.equal(stats.submittedTriangles, 24);
  assert.equal(stats.naniteEnabled, false);
  assert.equal(pipeline.baselineMesh.visible, true);
  assert.equal(pipeline.naniteMesh.visible, false);
  assert.equal(pipeline.renderer.toneMapping, THREE.ACESFilmicToneMapping);
  pipeline.setNaniteEnabled(true);
  assert.equal(pipeline.baselineMesh.visible, false);
  assert.equal(pipeline.naniteMesh.visible, true);
  assert.equal(pipeline.naniteMesh.material, pipeline.materials.meshlets);
  assert.equal(pipeline.renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(pipeline.previousFrameValid, false);
  assert.equal(pipeline.hzbValidUniform.value, 0);
});
