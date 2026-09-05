# Geometry paging and distant surface voxels

Two new forest rasterizer options preserve **Visibility + atomic HZB** as the
unchanged comparison:

- **Visibility + atomic HZB · streaming** — virtual meshlet pages, bounded GPU
  residency and a resident coarse fallback. Once the requested detail is resident,
  page decoding preserves its float32 positions, normals and colors exactly.
- **Streaming + distant surface voxels** — the same paging/atomic path with an
  explicit approximate representation for distant trees. The screen-space error
  threshold controls the switch. Even with Full resolution selected, this mode
  uses voxels in the distance; nearby resident triangles retain full detail.

## Paging

Each 2.5 KiB meshlet page contains 192 eight-bit local indices and up to 64
vertices with nine float32 components. Four indices share a uint32. This is
lossless index packing, not quantized vertex compression or an entropy codec.
A small virtual-cluster table maps cluster IDs to physical page offsets. The
shader decodes directly without an unpacked GPU geometry backup.

The default cache allocation is up to 8 MiB per asset, increased when necessary
to hold the pinned fallback plus one complete replacement unit. Metadata and
visibility buffers are additional allocations. CPU source geometry is retained;
these generated assets have no network page server. This is CPU-to-GPU geometry
streaming, not network streaming or a reduction of total application RAM.

GPU traversal writes compact priority requests into the existing counter buffer
binding, only when it needs more detail. Demand copies share the rendering
submission. Reusable staging buffers are mapped asynchronously at most once per
150 ms; render never awaits them. No selected-cluster list or geometry returns
to the CPU. Ordinary diagnostic readbacks remain as in the old mode.

The shared per-frame **geometry payload** upload budget is 256 KiB. Page-table
and group-table writes are additional small metadata transfers. The pinned
fallback is uploaded at initialization, outside this runtime budget. Complete
replacement units are published only after all their pages have been uploaded.
Patch groups retain their coarsest LOD. Hierarchies retain parents and expand only
when every direct child's geometry is resident. Eviction collapses selection
before reusing slots; units with resident descendants cannot be evicted.
If the working set exceeds the cache, coarse fallback persists rather than
exposing missing geometry. Its lower detail can affect both appearance and FPS.

## Surface voxel emulation

Only explicitly tagged **foliage** is voxelized on the 0.4-world-unit grid.
Trunks and branches retain their original opaque triangles, colors and normals
in the distant representation. Each leaf triangle is clipped to a cell, then its
three axial projections are sampled on 8×8 grids. Bitwise unions preserve gaps
and avoid double-counting the two sides of a leaf. This is a directional coverage
estimate, not volumetric transmission or order-independent transparency.

Per-face coverage is quantized to eight bits in the page's previously unused
64-byte tail. The page remains 2.5 KiB. The visibility fragment shader performs a
stable stochastic coverage test **before** writing depth or triangle ID. Discarded
samples leave the underlying surface visible; the existing atomic coverage and
HZB passes therefore see only accepted samples. Random values depend on stable
cluster/instance IDs and pixel coordinates, not frame number or draw-list order.
Partial adjacent cells retain their faces so deeper foliage can fill rejected
samples. Fully covered internal faces are omitted.

The voxel root's projected geometric-error limit is now capped at **one pixel**,
even when the general LOD slider allows larger errors. Its original triangle
children are pinned alongside the voxel root. Near cameras therefore refine to
resident triangle geometry instead of showing oversized voxel fallback during
streaming. At typical mobile resolutions this stricter threshold can keep the
whole visible forest in triangles; that is preferable to changing its appearance.

Epic's [Nanite Foliage documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage)
describes near-pixel aggregate voxels, a specialized raster path and depth bucket
ordering. This implementation borrows those design goals, but uses exposed cell
faces and custom stochastic coverage. It is **not** Epic's brick rasterizer,
normal-distribution shading, assemblies, skinning or wind system. Coverage is
sampled rather than exact, and can show grain or shimmer without temporal AA.

An additional **GPU front-to-back cluster ordering** checkbox in Controls sorts
64-cluster runs of seed and recovery work using conservative near distances.
It needs no CPU readback and preserves cluster IDs. This is local bitonic sorting,
not global depth buckets. It is disabled by default: the added compute passes
may cost more than early-depth savings, particularly on mobile. Atomic masks,
current-frame HZB recovery and final-visible-pixel shading remain in both paths.

## Validation

- Page decoding preserves every corner's float32 position, normal and color.
- Tests exercise partial uploads, the byte budget, eviction order, slot ownership,
  oversized demand, sibling residency, and original triangle preservation.
- TSL generation for patch, hierarchy and voxel traversal stays within the existing
  12-storage-buffer limit; Naga validates the generated and paged shaders.
- The exported 160×288 full forest's paged depth hashes exactly match the original
  visibility mode for initial, stationary and shifted-camera frames.
- The paged voxel scene has no HZB depth, ID, color or coverage mismatches against
  the same voxel scene rendered without occlusion rejection. This does not claim
  pixel parity between approximate voxels and original triangles.

Results: [paged forest](emulation-gpu/paged-forest.json),
[paged voxel forest](emulation-gpu/paged-voxel-forest.json).
These are SwiftShader correctness checks, **not phone timing measurements**.
The harness exports selection on the CPU; actual browser demand/readback and
cache-to-render integration are covered by code tests, not an end-to-end browser run.

```sh
npm test
npm run validate
npm run build
node scripts/emulation/export-gpu.mjs /tmp/forest --width=160 --height=288
node scripts/emulation/export-paged.mjs /tmp/forest /tmp/paged
python scripts/emulation/run-visibility.py /tmp/paged --frames=3
node scripts/emulation/export-gpu.mjs /tmp/voxels --width=160 --height=288 --voxels=true
node scripts/emulation/export-paged.mjs /tmp/voxels /tmp/paged-voxels
python scripts/emulation/run-visibility.py /tmp/paged-voxels --frames=3
```

The Python runner requires wgpu and a software Vulkan adapter. For the workspace
setup, set `VK_ICD_FILENAMES` to the SwiftShader ICD path.

### Coverage regression checks

The 25%-coverage foreground fixture retained 368 foreground pixels and exposed
7 pixels of the small rear triangle on its first frame. The zero-coverage fixture
wrote no foreground pixels and exposed 17 rear-triangle pixels. Both matched
unculled visibility for depth, ID, color and coverage, including camera movement.
The full 160×288 forest retained its original depth hashes with depth ordering
both enabled and disabled; at that viewport the one-pixel limit selected triangles.
These are software-GPU correctness results, not mobile speed measurements.

Reproduce partial/zero coverage:

```sh
node scripts/emulation/export-coverage-fixture.mjs /tmp/coverage .25
node scripts/emulation/export-paged.mjs /tmp/coverage /tmp/coverage-paged
python scripts/emulation/run-visibility.py /tmp/coverage-paged --frames=4 --depth-order
```

Use `0` instead of `.25` to test complete transparency. The 80×144 forest export
also exercises the distant coverage representation under its one-pixel limit.

The 80×144 test selected 18,982 clusters from the distant representation and
preserved depth/coverage across all three frames. One equal-depth pixel chose a
different triangle ID/color on the stationary frame after list ordering; the
other frames matched completely. This is recorded rather than claiming exact
color parity. Ordinary streaming without voxel coverage retains an opaque
visibility shader without fragment discard.
