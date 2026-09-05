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

The tree is voxelized on a 0.4-world-unit grid using triangle/box intersection.
Only occupied surface cells generate geometry, and faces between adjacent occupied
cells are omitted. Color and normals are aggregated from intersecting surfaces.
One new hierarchy root selects the voxel tree or the original triangle hierarchy,
never both. Its geometric error is the cell diagonal, projected using the same
camera, viewport and instance scale as the existing hierarchy.

This is an exposed-face hardware emulation. It does **not** implement Epic's
4×4×4 brick rasterizer, stochastic normal distributions, assemblies, skinning,
wind simulation, or the complete Nanite engine. At loose error thresholds it can
look blocky and close small gaps. It preserves an aggregate surface instead of
simply deleting distant leaves.

Epic's [Nanite Foliage documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-foliage)
describes its specialized voxel representation and separate rasterization path.
The project's smaller implementation uses the existing hardware visibility pass,
current-frame HZB recovery, final-pixel shading, and atomic OR coverage/winner bits.
No independent depth and ID atomic writes are introduced.

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
