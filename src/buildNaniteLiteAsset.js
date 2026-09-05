import * as THREE from 'three/webgpu';
import { MeshoptClusterizer } from 'three/addons/libs/meshopt_clusterizer.module.js';
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';

import { partitionMeshlets } from './partitionMeshlets.js';

import {
  LOD_TARGETS,
  MESHLET_MAX_TRIANGLES,
  MESHLET_MAX_VERTICES,
  VERTICES_PER_MESHLET
} from './config.js';

/**
 * Clones, centres and uniformly scales a geometry so its bounding sphere has
 * the requested radius. This makes arbitrary GLB meshes usable in the demo's
 * fixed instance grid without changing the source file.
 */
export function normaliseGeometry(inputGeometry, targetRadius = 1.55) {
  const geometry = inputGeometry.clone();

  geometry.computeBoundingBox();
  const centre = new THREE.Vector3();
  geometry.boundingBox.getCenter(centre);
  geometry.translate(-centre.x, -centre.y, -centre.z);

  geometry.computeBoundingSphere();
  const radius = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6);
  const scale = targetRadius / radius;
  geometry.scale(scale, scale, scale);

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function copyAttribute(attribute, itemSize, fallbackFactory = null) {
  if (!attribute && fallbackFactory) return fallbackFactory();
  if (!attribute) throw new Error(`Required geometry attribute with itemSize ${itemSize} is missing.`);

  const result = new Float32Array(attribute.count * itemSize);

  for (let i = 0; i < attribute.count; i += 1) {
    result[i * itemSize + 0] = attribute.getX(i);
    if (itemSize > 1) result[i * itemSize + 1] = attribute.getY(i);
    if (itemSize > 2) result[i * itemSize + 2] = attribute.getZ(i);
    if (itemSize > 3) result[i * itemSize + 3] = attribute.getW(i);
  }

  return result;
}

function createFallbackUVs(positionArray) {
  const vertexCount = positionArray.length / 3;
  const uv = new Float32Array(vertexCount * 2);

  for (let i = 0; i < vertexCount; i += 1) {
    const x = positionArray[i * 3 + 0];
    const y = positionArray[i * 3 + 1];
    const z = positionArray[i * 3 + 2];
    const radius = Math.max(Math.hypot(x, y, z), 1e-6);

    uv[i * 2 + 0] = Math.atan2(z, x) / (Math.PI * 2) + 0.5;
    uv[i * 2 + 1] = Math.asin(THREE.MathUtils.clamp(y / radius, -1, 1)) / Math.PI + 0.5;
  }

  return uv;
}

export function prepareSourceGeometry(inputGeometry) {
  const geometry = inputGeometry.clone();

  if (!geometry.getAttribute('position')) {
    throw new Error('The selected mesh has no position attribute.');
  }

  if (!geometry.getAttribute('normal')) {
    geometry.computeVertexNormals();
  }

  const positionArray = copyAttribute(geometry.getAttribute('position'), 3);
  const normalArray = copyAttribute(geometry.getAttribute('normal'), 3);
  const uvArray = geometry.getAttribute('uv')
    ? copyAttribute(geometry.getAttribute('uv'), 2)
    : createFallbackUVs(positionArray);

  const vertexCount = positionArray.length / 3;
  let indexArray;

  if (geometry.index) {
    indexArray = new Uint32Array(geometry.index.count);
    for (let i = 0; i < geometry.index.count; i += 1) {
      indexArray[i] = geometry.index.getX(i);
    }
  } else {
    indexArray = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i += 1) indexArray[i] = i;
  }

  if (indexArray.length < 3 || indexArray.length % 3 !== 0) {
    throw new Error('Nanite Lite currently requires triangle-list geometry.');
  }

  if (!positionArray.every(Number.isFinite) || !normalArray.every(Number.isFinite) || !uvArray.every(Number.isFinite)) {
    throw new Error('Geometry attributes must contain finite values.');
  }
  if (!indexArray.every(index => index < vertexCount)) {
    throw new Error('Geometry index is outside the position buffer.');
  }

  return {
    geometry,
    positionArray,
    normalArray,
    uvArray,
    indexArray,
    vertexCount
  };
}

export function packVec4(source, itemSize, wValue) {
  const count = source.length / itemSize;
  const packed = new Float32Array(count * 4);

  for (let i = 0; i < count; i += 1) {
    packed[i * 4 + 0] = source[i * itemSize + 0];
    packed[i * 4 + 1] = source[i * itemSize + 1];
    packed[i * 4 + 2] = source[i * itemSize + 2];
    packed[i * 4 + 3] = wValue;
  }

  return packed;
}

/**
 * Shared WASM simplification and meshlet packing helper. Auto LOD uses a
 * six-level patch chain; hierarchy construction requests a single leaf or
 * child-merge simplification and retains the resulting representative.
 */
export async function buildGroupAsset(inputGeometry, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const lodTargets = options.lodTargets ?? LOD_TARGETS;

  onProgress('Preparing meshoptimizer', 'Loading the simplifier and meshlet clusterizer WASM modules…');
  await Promise.all([MeshoptClusterizer.ready, MeshoptSimplifier.ready]);

  onProgress('Preparing geometry', 'Copying positions, normals, UVs and triangle indices…');
  const source = prepareSourceGeometry(inputGeometry);
  const {
    geometry,
    positionArray,
    normalArray,
    uvArray,
    indexArray: sourceIndices,
    vertexCount
  } = source;

  geometry.computeBoundingSphere();
  const boundingRadius = (geometry.boundingSphere?.radius ?? 1) * 1.05;

  const simplifierAttributes = new Float32Array(vertexCount * 5);
  for (let i = 0; i < vertexCount; i += 1) {
    simplifierAttributes[i * 5 + 0] = normalArray[i * 3 + 0];
    simplifierAttributes[i * 5 + 1] = normalArray[i * 3 + 1];
    simplifierAttributes[i * 5 + 2] = normalArray[i * 3 + 2];
    simplifierAttributes[i * 5 + 3] = uvArray[i * 2 + 0];
    simplifierAttributes[i * 5 + 4] = uvArray[i * 2 + 1];
  }

  const sourceScale = MeshoptSimplifier.getScale(positionArray, 3);
  const lods = [];
  let currentIndices = sourceIndices;
  let previousError = 0;
  let totalClusters = 0;

  for (let level = 0; level < lodTargets.length; level += 1) {
    const target = lodTargets[level];
    let geometricError = previousError;

    onProgress(
      `Building LOD ${level}`,
      level === 0
        ? 'Clustering the full-resolution mesh…'
        : `Simplifying to approximately ${Math.round(target.ratio * 100)}% of the source indices…`
    );

    if (level > 0) {
      const targetIndexCount = Math.max(
        3,
        Math.floor((sourceIndices.length * target.ratio) / 3) * 3
      );

      const simplified = MeshoptSimplifier.simplifyWithAttributes(
        currentIndices,
        positionArray,
        3,
        simplifierAttributes,
        5,
        target.weights,
        options.vertexLocks ?? null,
        targetIndexCount,
        target.error,
        [...new Set([...target.flags, 'LockBorder'])]
      );

      if (simplified[0].length >= 3) {
        currentIndices = simplified[0];
        geometricError = previousError + simplified[1] * sourceScale;
      }
    }

    previousError = geometricError;

    const meshletBuffers = MeshoptClusterizer.buildMeshlets(
      currentIndices,
      positionArray,
      3,
      MESHLET_MAX_VERTICES,
      MESHLET_MAX_TRIANGLES,
      0.25
    );

    const bounds = MeshoptClusterizer.computeMeshletBounds(
      meshletBuffers,
      positionArray,
      3
    );

    const lod = {
      level,
      geometricError,
      indexCount: currentIndices.length,
      triangleCount: currentIndices.length / 3,
      clusterStart: totalClusters,
      clusterCount: meshletBuffers.meshletCount,
      meshletBuffers,
      bounds
    };

    lods.push(lod);
    totalClusters += lod.clusterCount;
  }

  onProgress('Packing meshlets', 'Creating fixed 64-triangle cluster records and culling bounds…');

  const paddedIndexCount = totalClusters * VERTICES_PER_MESHLET;
  const packedIndices = new Uint32Array(paddedIndexCount);
  const clusterBounds = new Float32Array(totalClusters * 4);
  const clusterConeApex = new Float32Array(totalClusters * 4);
  const clusterConeAxis = new Float32Array(totalClusters * 4);
  const clusterLod = new Uint32Array(totalClusters);
  const clusterTriangleCounts = new Uint32Array(totalClusters);

  let globalCluster = 0;

  for (const lod of lods) {
    for (let localCluster = 0; localCluster < lod.clusterCount; localCluster += 1) {
      const meshlet = MeshoptClusterizer.extractMeshlet(lod.meshletBuffers, localCluster);
      const triangleCount = meshlet.triangles.length / 3;
      const firstVertex = meshlet.vertices[0] ?? 0;
      const indexBase = globalCluster * VERTICES_PER_MESHLET;

      for (let triangle = 0; triangle < MESHLET_MAX_TRIANGLES; triangle += 1) {
        const destination = indexBase + triangle * 3;

        if (triangle < triangleCount) {
          const microBase = triangle * 3;
          packedIndices[destination + 0] = meshlet.vertices[meshlet.triangles[microBase + 0]];
          packedIndices[destination + 1] = meshlet.vertices[meshlet.triangles[microBase + 1]];
          packedIndices[destination + 2] = meshlet.vertices[meshlet.triangles[microBase + 2]];
        } else {
          // Fixed-size meshlets make the indirect draw compact. Unused triangles
          // are degenerate, so every visible cluster always expands to 192 vertices.
          packedIndices[destination + 0] = firstVertex;
          packedIndices[destination + 1] = firstVertex;
          packedIndices[destination + 2] = firstVertex;
        }
      }

      const bounds = lod.bounds[localCluster];
      const boundsOffset = globalCluster * 4;

      clusterBounds[boundsOffset + 0] = bounds.centerX;
      clusterBounds[boundsOffset + 1] = bounds.centerY;
      clusterBounds[boundsOffset + 2] = bounds.centerZ;
      clusterBounds[boundsOffset + 3] = bounds.radius;

      clusterConeApex[boundsOffset + 0] = bounds.coneApexX;
      clusterConeApex[boundsOffset + 1] = bounds.coneApexY;
      clusterConeApex[boundsOffset + 2] = bounds.coneApexZ;
      clusterConeApex[boundsOffset + 3] = bounds.coneCutoff;

      clusterConeAxis[boundsOffset + 0] = bounds.coneAxisX;
      clusterConeAxis[boundsOffset + 1] = bounds.coneAxisY;
      clusterConeAxis[boundsOffset + 2] = bounds.coneAxisZ;
      clusterConeAxis[boundsOffset + 3] = 0;

      clusterLod[globalCluster] = lod.level;
      clusterTriangleCounts[globalCluster] = triangleCount;
      globalCluster += 1;
    }
  }

  // Meshopt simplification changes the index stream but retains source vertex
  // references, so one shared vertex stream is sufficient for every LOD.
  const vertices = packVec4(positionArray, 3, 1);
  const normals = packVec4(normalArray, 3, 0);

  const sourceTriangleCount = sourceIndices.length / 3;

  return {
    vertices,
    normals,
    uvs: uvArray,
    indices: packedIndices,
    clusterBounds,
    clusterConeApex,
    clusterConeAxis,
    clusterLod,
    clusterTriangleCounts,
    lods: lods.map((lod) => ({
      level: lod.level,
      geometricError: lod.geometricError,
      indexCount: lod.indexCount,
      triangleCount: lod.triangleCount,
      clusterStart: lod.clusterStart,
      clusterCount: lod.clusterCount
    })),
    vertexCount,
    sourceTriangleCount,
    totalClusters,
    boundingRadius,
    bytes:
      vertices.byteLength +
      normals.byteLength +
      uvArray.byteLength +
      packedIndices.byteLength +
      clusterBounds.byteLength +
      clusterConeApex.byteLength +
      clusterConeAxis.byteLength +
      clusterLod.byteLength +
      clusterTriangleCounts.byteLength
  };
}

/** Auto LOD: independent boundary-locked patch chains. */
export async function buildNaniteLiteAsset(inputGeometry, options = {}) {
  const source = prepareSourceGeometry(inputGeometry);
  const { groups, locks } = await partitionMeshlets(
    source.indexArray, source.positionArray, options.meshletsPerGroup ?? 16
  );
  const parts = [];
  const groupBounds = new Float32Array(groups.length * 4);
  const base = { vertices: packVec4(source.positionArray, 3, 1),
    normals: packVec4(source.normalArray, 3, 0), uvs: source.uvArray };
  source.geometry.computeBoundingSphere();
  const boundingRadius = (source.geometry.boundingSphere?.radius ?? 1) * 1.05;
  for (let groupId = 0; groupId < groups.length; groupId++) {
    options.onProgress?.(`Building group ${groupId + 1} / ${groups.length}`, 'Simplifying with shared boundaries locked…');
    // Let the loading overlay paint between group builds.
    if (typeof requestAnimationFrame !== 'undefined') {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    // Simplify only this group's vertices. Copying the entire scene for every
    // group makes preprocessing quadratic at terrain-scale triangle counts.
    const globalVertices = [...new Set(groups[groupId])];
    const toLocal = new Map(globalVertices.map((index, local) => [index, local]));
    const geometry = new THREE.BufferGeometry();
    for (const [name, array, size] of [
      ['position', source.positionArray, 3], ['normal', source.normalArray, 3], ['uv', source.uvArray, 2]
    ]) {
      const local = new Float32Array(globalVertices.length * size);
      globalVertices.forEach((index, i) => local.set(array.subarray(index * size, index * size + size), i * size));
      geometry.setAttribute(name, new THREE.BufferAttribute(local, size));
    }
    geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(groups[groupId], index => toLocal.get(index)), 1));
    const localLocks = Uint8Array.from(globalVertices, index => locks[index]);
    const part = await buildGroupAsset(geometry, { ...options, vertexLocks: localLocks, onProgress: () => {} });
    geometry.dispose();
    // Keep every LOD in the original shared vertex address space for rendering,
    // vertex colors and exact boundary matching between adjacent groups.
    for (let i = 0; i < part.indices.length; i++) part.indices[i] = globalVertices[part.indices[i]];
    delete part.vertices; delete part.normals; delete part.uvs;
    parts.push(part);

    const box = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const index of groups[groupId]) box.expandByPoint(point.fromArray(source.positionArray, index * 3));
    const centre = box.getCenter(new THREE.Vector3());
    let radius = 0;
    for (const index of groups[groupId]) radius = Math.max(radius, centre.distanceTo(point.fromArray(source.positionArray, index * 3)));
    groupBounds.set([...centre.toArray(), radius * 1.00001 + 1e-6], groupId * 4);
  }
  const lodCount = parts[0].lods.length;
  const groupLods = new Float32Array(groups.length * lodCount * 4);
  const lods = parts[0].lods.map(lod => ({ level: lod.level, geometricError: 0, triangleCount: 0, indexCount: 0, clusterCount: 0 }));
  let totalClusters = 0;
  parts.forEach((part, groupId) => {
    part.lods.forEach(lod => {
      groupLods.set([lod.geometricError, totalClusters + lod.clusterStart, lod.clusterCount, lod.triangleCount], (groupId * lodCount + lod.level) * 4);
      const aggregate = lods[lod.level];
      aggregate.geometricError = Math.max(aggregate.geometricError, lod.geometricError);
      aggregate.triangleCount += lod.triangleCount;
      aggregate.indexCount += lod.indexCount;
      aggregate.clusterCount += lod.clusterCount;
    });
    totalClusters += part.totalClusters;
  });
  // Offsets travel in f32 metadata, so require exact integer representation.
  if (totalClusters >= 2 ** 24) throw new Error('Asset exceeds exact group-table addressing capacity.');
  const asset = { ...base, groupBounds, groupLods, groupCount: groups.length,
    lods, totalClusters, vertexCount: source.vertexCount,
    sourceTriangleCount: source.indexArray.length / 3,
    lockedVertexCount: locks.reduce((sum, lock) => sum + lock, 0),
    boundingRadius };
  for (const key of ['indices', 'clusterBounds', 'clusterConeApex', 'clusterConeAxis', 'clusterLod', 'clusterTriangleCounts']) {
    const Constructor = parts[0][key].constructor;
    asset[key] = new Constructor(parts.reduce((sum, part) => sum + part[key].length, 0));
    let offset = 0;
    for (const part of parts) { asset[key].set(part[key], offset); offset += part[key].length; }
  }
  asset.bytes = Object.values(asset).filter(ArrayBuffer.isView).reduce((sum, array) => sum + array.byteLength, 0);
  source.geometry.dispose();
  return asset;
}
