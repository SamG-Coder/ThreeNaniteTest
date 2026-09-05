import { MeshoptClusterizer } from 'three/addons/libs/meshopt_clusterizer.module.js';

// Partition whole leaf meshlets by their longest spatial axis. The source
// triangles remain disjoint; duplicated seam vertices are only used for locks.
export async function partitionMeshlets(indices, positions, meshletsPerGroup = 16) {
  if (!Number.isInteger(meshletsPerGroup) || meshletsPerGroup < 1) {
    throw new Error('meshletsPerGroup must be a positive integer.');
  }
  await MeshoptClusterizer.ready;
  const built = MeshoptClusterizer.buildMeshlets(indices, positions, 3, 64, 64, 0.25);
  const bounds = MeshoptClusterizer.computeMeshletBounds(built, positions, 3);
  const groups = [];
  function split(ids) {
    if (ids.length <= meshletsPerGroup) {
      const triangles = [];
      for (const id of ids) {
        const meshlet = MeshoptClusterizer.extractMeshlet(built, id);
        for (const index of meshlet.triangles) triangles.push(meshlet.vertices[index]);
      }
      groups.push(new Uint32Array(triangles));
      return;
    }
    const axes = ['centerX', 'centerY', 'centerZ'];
    const extents = axes.map(axis => {
      let low = Infinity, high = -Infinity;
      for (const id of ids) { low = Math.min(low, bounds[id][axis]); high = Math.max(high, bounds[id][axis]); }
      return high - low;
    });
    const axis = axes[extents.indexOf(Math.max(...extents))];
    ids.sort((a, b) => bounds[a][axis] - bounds[b][axis] || a - b);
    const mid = Math.floor(ids.length / 2);
    split(ids.slice(0, mid));
    split(ids.slice(mid));
  }
  split(Array.from({ length: built.meshletCount }, (_, i) => i));

  // Quantization is for conservative locking only: positions are never welded
  // or modified. Lock split UV/normal vertices on both sides of a group seam.
  let extent = 1;
  for (const value of positions) extent = Math.max(extent, Math.abs(value));
  const epsilon = extent * 1e-6;
  const keys = Array.from({ length: positions.length / 3 }, (_, i) =>
    [0, 1, 2].map(a => Math.round(positions[i * 3 + a] / epsilon)).join(','));
  const owner = new Map();
  groups.forEach((group, groupId) => {
    for (const index of group) {
      const key = keys[index];
      if (!owner.has(key)) owner.set(key, groupId);
      else if (owner.get(key) !== groupId) owner.set(key, -1);
    }
  });
  const locks = Uint8Array.from(keys, key => owner.get(key) === -1 ? 1 : 0);
  for (const group of groups) {
    const edges = new Map();
    for (let i = 0; i < group.length; i += 3) for (let corner = 0; corner < 3; corner++) {
      const a = group[i + corner], b = group[i + (corner + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
    // Also freeze open/non-manifold borders and attribute seams inside a patch.
    for (const edge of edges.values()) if (edge.count !== 2) {
      locks[edge.a] = 1; locks[edge.b] = 1;
    }
  }
  return { groups, locks };
}
