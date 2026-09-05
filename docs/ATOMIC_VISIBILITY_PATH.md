# Hardware visibility with atomic coverage and HZB

A new main-forest option, **Visibility + atomic HZB**, implements the core visibility pipeline investigated in the Nanite research. [Open with full geometry](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=visibility). [Open with hierarchical screen-space LOD](https://samg-coder.github.io/ThreeNaniteTest/?geometry=hierarchy&bitmaskVariant=visibility).

This is a research implementation, not a port of all of Epic's Nanite. Compressed geometry paging/streaming, foliage voxelization, programmable Nanite materials, virtual shadow maps and Nanite's hybrid microtriangle rasterizer are not implemented here. Geometry remains resident. Existing atomic software raster modes remain selectable.

## Frame pathway

1. Three's existing GPU cluster selection performs frustum/cone tests and, when selected, hierarchical screen-space LOD. Full geometry continues to select original-detail clusters.
2. A GPU pass uses a persistent atomic bitset of last frame's winning clusters to form a seed draw list. Keys use asset, instance and original cluster index, so changes to compacted visible-list order do not corrupt history.
3. Hardware rasterization draws those clusters at the **current camera** into `r32uint` triangle IDs and `depth32float` depth. Draw arguments are GPU-generated.
4. A compute pass builds the user's coverage masks: two `atomic<u32>` words for each 8×8 tile, with `atomicOr(1u << pixelBit)`. A following pass uses those bits to gate valid depth samples into mip zero. Uncovered pixels and padding stay at far depth. Successive max reductions build a hierarchical depth pyramid.
5. Remaining selected clusters are tested against that current-frame pyramid using conservative projected bounds. Near-plane crossings stay visible. The test samples every overlapped mip cell and includes screen/depth margins. Rejected clusters produce no hardware triangle work. Survivors are compacted atomically and drawn in the recovery pass.
6. Final visibility drives one shading invocation per pixel, rather than shading competing triangles. This pass also builds next frame's atomic winning-cluster bitset. Three composites the result with the existing sky and lake.

The old per-triangle tile linked-list pool is not allocated for this mode. New allocations include two cluster draw lists, stable cluster bitsets, coverage masks, hardware depth and the HZB. No new CPU visibility readback is required; the existing sampled diagnostics remain asynchronous.

The atomic words record coverage and cluster membership. They do not try to implement a 64-bit depth/ID transaction by racing two separate 32-bit stores. Hardware depth testing resolves visibility; pass boundaries order mask publication, HZB construction and cluster testing.

## Controls and diagnostics

The main Rasterizer selector exposes the new mode. Its controls add **Cluster HZB + atomic coverage** for on/off comparison. The readout shows seed clusters, recovery clusters and HZB-rejected clusters; submitted triangles reflect both actual cluster draws, with padded slots counted. Source geometry and LOD can be held fixed for comparisons.

The existing GPU timestamp option labels the new stages **Visibility + HZB** and **Final shading**. Those intervals include the associated GPU passes; native software-adapter wall times below are not phone measurements.

## Correctness and measured work

The software Vulkan harness compiles and runs the production hardware visibility, atomic mask, depth pyramid, cluster recovery and shading shaders. It uses exported CPU-selected lists; Three's own selection and browser presentation remain outside the harness.

At 160×288, the real 28.2M-source-triangle forest supplies 42,990 selected clusters. The initial frame draws all of them. The second frame draws 4,434 seed clusters plus 31,509 recovery clusters and rejects **7,047 clusters** (16.4% of selected clusters). After a clip-space camera shift, 6,269 clusters are rejected. Depth, IDs and RGBA16F colour match unculled hardware visibility exactly in all three comparisons. [Forest results](emulation-gpu/visibility-forest.json).

A 65×49 regression fixture includes an opaque occluder, a hidden cluster, an uncovered gap, a near-plane crossing and partial edge tiles. It also changes the selected list to remove the occluder and reuses its compacted slot. Newly exposed geometry reappears correctly: no depth, coverage, ID or colour mismatches against uncullled rendering. [Fixture results](emulation-gpu/visibility-fixture.json).

Coplanar hardware depth ties can legitimately select different triangle IDs when draw order changes. The observed fixtures and forest produced exact ID/colour parity; the harness always rejects coverage loss or material depth differences. It does not claim software-raster bitwise parity with hardware rasterization or phone speedups.

## Reproduce

Use the software Vulkan ICD described in `scripts/emulation/README.md`:

```sh
node scripts/emulation/export-gpu.mjs /tmp/visibility-forest --width=160 --height=288 --pitch=-.05
python scripts/emulation/run-visibility.py /tmp/visibility-forest
node scripts/emulation/export-visibility-fixture.mjs /tmp/visibility-fixture
python scripts/emulation/run-visibility.py /tmp/visibility-fixture --frames=4
```

## Research basis

- [Epic: Nanite overview](https://dev.epicgames.com/documentation/unreal-engine/nanite-virtualized-geometry-in-unreal-engine): hierarchical geometry and camera-dependent selection.
- [Tencent: Seamless Rendering on Mobile, SIGGRAPH 2024](https://advances.realtimerendering.com/s2024/content/Cao-NanoMesh/AdavanceRealtimeRendering_NanoMesh0810.pdf): cluster culling and hardware visibility buffers under mobile constraints.
- [Epic: experimental Nanite Foliage](https://dev.epicgames.com/documentation/unreal-engine/nanite-foliage): separate voxel/assembly/skinning systems, not present in this implementation.
