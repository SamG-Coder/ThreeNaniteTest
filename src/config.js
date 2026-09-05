export const MESHLET_MAX_VERTICES = 64;
export const MESHLET_MAX_TRIANGLES = 64;
export const VERTICES_PER_MESHLET = MESHLET_MAX_TRIANGLES * 3;

// The dummy draw geometry reserves this many visible meshlets. Raising this
// increases the backing vertex-buffer allocation, because WebGPU validates
// vertex input ranges even though the shader pulls the real vertices from
// storage buffers.
export const MAX_VISIBLE_CLUSTERS = 16_384;

export const INSTANCE_GRID_SIZE = 14;
export const INSTANCE_SPACING = 4.25;
export const MAX_HZB_LEVELS = 16;

export const DEFAULT_LOD_THRESHOLD = 4.5;
export const DEFAULT_OCCLUSION_BIAS = 0.0012;

export const LOD_TARGETS = [
  { ratio: 1.0, error: 0.0, weights: [0.25, 0.25, 0.25, 0.5, 0.5], flags: [] },
  { ratio: 0.55, error: 0.004, weights: [0.2, 0.2, 0.2, 0.35, 0.35], flags: ['RegularizeLight'] },
  { ratio: 0.25, error: 0.015, weights: [0.12, 0.12, 0.12, 0.2, 0.2], flags: ['RegularizeLight'] },
  { ratio: 0.1, error: 0.05, weights: [0.08, 0.08, 0.08, 0.12, 0.12], flags: ['RegularizeLight'] },
  { ratio: 0.04, error: 0.14, weights: [0.04, 0.04, 0.04, 0.06, 0.06], flags: ['Regularize', 'Permissive'] },
  { ratio: 0.015, error: 0.3, weights: [0.02, 0.02, 0.02, 0.03, 0.03], flags: ['Regularize', 'Permissive'] }
];
