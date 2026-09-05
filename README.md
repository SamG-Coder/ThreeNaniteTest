# Three.js WebGPU Geometry LOD

See the [full emulation audit](docs/EMULATION_AUDIT.md) for CPU work counts, actual SwiftShader shader execution, reproducible harnesses, and the two largest avoidable costs found. The harness experiments do not alter the deployed renderer.

A runnable GPU-driven geometry prototype for **Three.js 0.185.1** and WebGPU.

**Geometry** and **Rasterizer** are independent controls.

- Geometry: Full resolution, Patch LOD, or Hierarchical LOD.
- Rasterizer: Hardware, or Bitmask compute (forest only).

[Full resolution + Bitmask compute](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=original&geometry=full) selects original-detail meshlets with no LOD simplification. Frustum/cone culling still applies; pixel depth resolves visibility in compute. Switch only Rasterizer to compare with the original indexed hardware scene at the same camera. Materials differ, so this is a geometry comparison, not shading parity. Full-detail compute can be much slower and can exhaust the tile pool; it is not claimed to outperform hardware.

New experiment: [full-detail tile rejection](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=reject&geometry=full). It rejects empty triangle/tile intersections before binning, visits coarse near-to-far buckets, and skips fine coverage when existing depth proves an entire tile contribution hidden. Work counters show what was rejected and how many coverage/depth tests remain. Compare against [full-detail triangle-owned masks](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=owned&geometry=full). Device correctness and speedup still need measurement.

The original Bitmask Raster shader is the default again: the depth-cache experiment ran roughly half as fast on the user's phone. Compare the [original](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=original) with the new [triangle-owned masks experiment](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=owned). The new path replaces coverage atomics with two mask words per triangle and defers depth interpolation until resolution, without an 8 KiB depth cache. Geometry and resolution stay the same; its device performance is not yet measured. The previous [depth-cache experiment](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=cached) remains available for diagnosis.

**Frame experiments:** In Bitmask Raster, open Controls → Raster experiments. Compare one/two frames in flight, batched selection, unused draw arguments, direct presentation, and optional GPU timings independently. [Start with the old scheduling baseline](https://samg-coder.github.io/ThreeNaniteTest/?bitmaskVariant=original&frames=1&batch=0&skipArgs=0&direct=0). Batching and skipping unused arguments are enabled by default; two-frame queuing and direct presentation are opt-in. CPU submission, frame intervals and GPU timeline measurements are labelled separately. See the [test specification](docs/BITMASK_RASTER_TEST.md#frame-scheduling-and-presentation-experiments) for measurement limits.

Hierarchical LOD is the default. This is a browser experiment, not Epic's Nanite implementation. Patch LOD and Hierarchical LOD include:

- Patch LOD: spatial groups of up to 64 leaf meshlets in the terrain scene (16 in the mesh stress test)
- Hierarchical LOD: eight-meshlet leaves, recursively merged/simplified/reclustered parents, and stackless GPU traversal
- Explicit shared-boundary, open-border and attribute-seam vertex locks
- 64-vertex / 64-triangle meshlets
- Per-group and per-meshlet GPU frustum culling
- Meshlet normal-cone backface culling
- Screen-space geometric-error LOD selection
- Experimental previous-frame hierarchical-Z occlusion culling (off by default)
- GPU-compacted visible meshlet list
- GPU-generated indirect draw arguments
- Storage-buffer vertex pulling
- One hardware-rasterized draw per geometry asset batch (terrain and trees in the forest)
- Live GPU readback statistics and LOD distribution
- Runtime `.glb` import for the largest static mesh

The default map is **Emerald Basin**, a natural forest stress test with a mountain lake, granite outcrops and detailed broadleaf trees. The map contains no buildings. Trees contain modeled branches and individual opaque 3D leaves, rather than solid canopy blobs or alpha cards.

The scene stores one high-detail tree asset and places it 96, 256 or 512 times with deterministic positions, rotations and scales. All forest modes use identical source geometry and instance placement. Full resolution draws the original indexed instances; Patch LOD and Hierarchical LOD use their respective selection algorithms and meshlet culling. Terrain and forest use separate indirect draws in one scene and one presentation pass. Geometry readouts sum both batches; FPS includes lake shading too.

The original mesh stress test and mountain terrain sample remain available in Controls.

## Experimental hierarchy and limits

The existing meshoptimizer WebAssembly simplifier and clusterizer perform preprocessing. Each parent merges the simplified child geometry, unlocks internal child boundaries, simplifies again with its outer boundary locked, and reclusters the result. Errors accumulate from children; parent bounds enclose child spheres. Source positions and attribute references stay unchanged.

Each frame a GPU invocation traverses one instance's tree. An accepted parent skips its complete subtree; an unacceptable parent descends. Screen-space error uses accumulated geometric error, instance scale, projection depth to the nearest sphere surface, vertical field of view and drawing-buffer height. Frustum rejection also skips whole subtrees. Accepted meshlets undergo cone/frustum culling, atomic compaction and indirect drawing. Tier 5+ in the visualization combines deeper hierarchy levels.

This is a resident binary hierarchy, not a repartitioned cluster DAG. It has no geometry streaming, software rasterizer, material visibility buffer or production occlusion system. Single-invocation traversal can bottleneck very large individual assets. Boundary locks and conservative error accumulation can retain more triangles than desired. The pixel threshold is an approximate geometric metric, not a guaranteed image-difference bound. WASM accelerates CPU preprocessing; it does not bypass WebGPU/device limits. No mobile FPS improvement is claimed without device measurements.

Regression tests check exact leaf coverage/winding, parent boundary matching, bounds/error monotonicity, complete non-overlapping cuts, response to viewport/FOV/distance/error, and offline WGSL generation within the 12-storage-buffer limit. Offline generation does not validate shaders on a physical adapter.

Design references: [meshoptimizer cluster hierarchy example](https://github.com/zeux/meshoptimizer/blob/master/demo/clusterlod.h) and [Epic's Nanite documentation](https://dev.epicgames.com/documentation/unreal-engine/nanite-virtualized-geometry-in-unreal-engine). This implementation uses a simpler nested tree.

## Bitmask Raster in the forest

Choose **Geometry → Bitmask Raster · forest** to try the compute rasterizer on Emerald Basin. It uses the current hierarchical selection and all selected terrain/tree triangles, with 32-triangle mask batches and separate depth/ID/color textures. It retains camera position, mobile controls and the existing lake. Terrain/tree hardware draws are disabled; Three.js handles the depth-tested fullscreen composite and water.

Dense tiles process additional batches. Exhausting the 64 MiB candidate pool triggers an explicitly reported exhaustive software scan, which can be very slow. The renderer keeps only one frame in flight and counts actual frame submissions in its FPS meter. It uses simplified per-triangle lighting, not exact MeshStandard material parity. Full viewport resolution is retained; no device FPS improvement is claimed. See the [forest integration specification](docs/BITMASK_RASTER_TEST.md#forest-integration-bitmask-raster).

## Bitmask Raster Test

Open **Controls → Bitmask Raster Test**, or [open the isolated test](https://samg-coder.github.io/ThreeNaniteTest/bitmask.html). It uses 32-bit atomic OR to collect tile-local triangle candidates and writes separate depth and triangle-ID textures in a per-pixel resolve. Four masks represent 128 candidates per tile; overflow uses an explicit exhaustive fallback. Select a fixture and press **Check GPU result** to compare with an exhaustive GPU reference for that frame.

Read the [specification and acceptance criteria](docs/BITMASK_RASTER_TEST.md). This is a controlled custom rasterizer test, not geometry streaming or a forest performance claim. Device validation remains pending until the GPU checks run on a WebGPU browser.

## GitHub Pages

The Pages workflow builds and tests pushes to `main`, then deploys the Vite `dist` output.
In repository **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source.
The project URL is https://samg-coder.github.io/ThreeNaniteTest/ after the deployment succeeds.
Relative asset paths support the repository subdirectory and local preview.

## Forest stress presets and controls

- **Build forest** regenerates the selected 96-, 256- or 512-tree preset. Desktop defaults to 512 trees and coarse-pointer devices to 256. Presets share nested tree placement, and source geometry is unchanged when switching modes. The first switch to another optimized mode builds its asset; CPU assets are then cached. Only one optimized GPU pipeline remains resident, and switching preserves camera position.
- The tree prototype contains roughly 108K triangles. Depending on the preset, the forest represents roughly 11–56 million source triangles including terrain and rocks. Exact counts appear in the interface. Instancing avoids storing dozens of millions of unique vertices.
- Desktop: click the scene for mouse look; WASD/arrow keys move, Shift sprints, Space jumps, Escape releases the mouse.
- Mobile: left joystick moves, swiping the scene looks around, and Jump jumps. Walking follows the ground and uses approximate collision against trunks, rocks and the lake boundary.
- Walking / Orbit camera switches navigation. Reset position returns to the spawn or overview.
- Geometry view shows meshlet clusters, LODs or normals for the terrain and trees together.
- FPS and mean ms/frame measure animation-frame cadence, not isolated GPU execution time. Hidden tabs and asset-building periods are excluded; changing geometry mode resets the sample. Display refresh rate can cap FPS.
- The geometry readout compares padded submitted meshlet triangles with source triangles. Capacity overflow is shown explicitly. A lower triangle count does not guarantee higher FPS; culling and compute have overhead.
- The lake uses the same opaque animated water material in all three modes. It is outside the meshlet asset statistics and is not used to manufacture a geometry speedup. It has no planar reflections or refraction.
- Experimental previous-frame HZB is disabled in the multi-asset forest map. Frustum culling, normal-cone culling and the selected geometry algorithm remain active.
- The forest reserves 32,768 visible tree meshlets plus 8,192 terrain meshlets. The fixed dummy vertex buffers consume approximately 90 MiB combined. GPU assets and baseline buffers require additional memory.
- Terrain sample uses the selected density for 256², 512² or 1024² grid subdivisions. Mesh stress test retains its original 49/196-instance grid.
- WebGPU and 12 storage buffers per shader stage are still required. This is a procedural rendering stress test, not a complete game or a claim of photorealistic rendering.

## Run it

Requirements:

- Node.js 22.12 or newer
- A current Chrome or Edge build with WebGPU enabled
- A WebGPU adapter supporting at least 12 storage buffers per shader stage (requested explicitly)

```bash
npm install
npm run dev
```

Then open the address printed by Vite, normally `http://localhost:5173`.

Production build:

```bash
npm run build
npm run preview
```

Validation and topology regression tests:

```bash
npm run validate
npm test
```

## Controls

- Left drag: orbit
- Mouse wheel: zoom
- Right drag: pan
- **Geometry view**: toggle meshlet IDs, selected LOD, or world normals; off returns to shading
- **LOD error**: acceptable projected geometric error in pixels
- **Experimental HZB occlusion**: opt into research-grade GPU occlusion rejection
- **Meshlet normal-cone culling**: reject clusters whose triangles all face away
- **Show test occluders**: display or hide the wall used to exercise HZB culling
- **Load .glb**: use the largest non-skinned static mesh in a binary glTF

## Source layout

```text
src/
  buildHierarchyAsset.js     Recursive parent construction and CPU reference traversal
  partitionMeshlets.js        Spatial leaf grouping and conservative boundary locks
  main.js                    Application bootstrap, camera and GLB loading
  gameScene.js               Terrain, forest, natural scenery, colors and collision layout
  gameControls.js            First-person movement, mouse look and touch controls
  forestScene.js             Natural map, detailed leaves/branches and forest placement
  ForestRenderer.js          Shared scene with terrain and forest render batches
  frameMeter.js              FPS and frame interval sampling
  buildNaniteLiteAsset.js    Mesh simplification, meshlet generation and packing
  NaniteLiteRenderer.js      GPU buffers, compute culling, HZB and indirect draw
  config.js                  Meshlet, LOD and scene limits
  ui.js                      Controls and GPU readback display
  styles.css                 Demo interface

docs/
  ARCHITECTURE.md            Pipeline and data-flow explanation
  ROADMAP.md                 Path from this prototype to a streamed geometry system
```

## What the prototype actually does

### Asset build

For **Patch LOD**, `buildNaniteLiteAsset()` performs the following work in the browser:

1. Validates and copies the source attributes and triangle indices.
2. Builds 64/64 leaf meshlets and spatially partitions them into groups of at most 16 (64 for terrain and trees).
3. Locks shared-position vertices across groups, plus explicit open/non-manifold and attribute-seam borders.
4. Builds six index-only LODs independently for each group with accumulated simplification error.
5. Re-clusters each group LOD and packs bounds, cones and indices into shared buffers.
6. Uploads group bounds and a storage table of `(error, clusterStart, clusterCount, triangleCount)`.

Every group chooses its own LOD on the GPU. All levels share the original vertex stream, and locked borders preserve their original edges. Spatial grouping currently uses a deterministic longest-axis median split; it is not an adjacency-optimized partitioner.

### GPU frame

The Patch LOD frame executes the following sequence. Hierarchical LOD replaces the first two selection stages with recursive GPU hierarchy traversal:

```text
clear counters
    ↓
GPU group culling
    ↓
per-group screen-space LOD selection
    ↓
GPU meshlet frustum / cone / HZB culling
    ↓
compact visible meshlets with atomic append
    ↓
write non-indexed indirect draw arguments
    ↓
vertex-pulled hardware rasterization
    ↓
build current depth pyramid for the next frame
    ↓
present the HDR render target
```

The draw shader derives a visible-list slot and local meshlet vertex directly from `vertexIndex`:

```text
visibleSlot = vertexIndex / 192
localVertex = vertexIndex % 192
```

It then reads `(instanceId, clusterId)` from the compacted visible list, pulls the cluster's real source index and vertex attributes from storage buffers, applies the GPU-generated instance transform and passes the result into a Three.js node material.

## Important limits

This prototype is intentionally honest about what it does not implement:

- Patch LOD uses independent patch chains; Hierarchical LOD uses a recursive binary tree. Neither implements a repartitioned cluster DAG.
- The streaming options use bounded GPU page caches with resident fallback; older modes keep generated geometry resident. CPU source geometry remains resident. There is no network page server.
- Hardware visibility and experimental software rasterizers are available; there is no automatic hybrid hardware/software triangle classifier.
- One material is used per geometry draw. The game scene uses vertex colors; the mesh stress test uses a procedural checker. Imported material assignments remain unsupported.
- The GLB loader selects one static mesh and ignores additional primitives and material assignments.
- Skinned meshes, morph targets, transparency, transmission and runtime vertex displacement are unsupported.
- Instance transforms use uniform scaling, allowing normals and culling bounds to use the same world matrix safely.
- Legacy geometry occlusion is off by default. Its inherited sphere projection is not conservative in all cases. The newer Visibility + atomic HZB and streaming paths have current-frame recovery. History is invalidated on camera movement, LOD-threshold changes, viewport changes and occluder visibility changes. Leave it disabled when checking coverage.
- Visible-list capacities are 8,192 terrain and 32,768 tree meshlets in the forest; the mesh test uses 8,192 on mobile or 16,384 on desktop. The UI displays an overflow warning when it is exceeded.

## Memory note

The indirect draw expands a visible meshlet into 192 vertex invocations. Three.js uses a dummy position attribute to establish a WebGPU-valid vertex range even though the shader pulls real positions from storage buffers. The dummy attribute uses an unused `float32x3` element, matching Three.js' normal position-buffer contract. At the default 16,384-meshlet capacity, it is approximately 36 MiB.

Reduce `MAX_VISIBLE_CLUSTERS` in `src/config.js` for lower-memory devices. Increase it only after profiling.

## Why the renderer uses 64/64 meshlets

A 64-triangle meshlet gives predictable fixed-size expansion for the indirect draw. Compute workgroup size is independent of cluster triangle count in these traversal paths. It is not universally optimal, but it is a reasonable cross-vendor starting point for WebGPU.

## Further hierarchy work

The recursive resident tree is implemented. Next steps are parallel traversal queues, adjacency-aware cluster repartitioning and network-backed pages. CPU-to-GPU streaming with resident-parent fallback is available in the streaming modes. See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Credits

The implementation is built on:

- [Three.js](https://threejs.org/) WebGPU renderer and TSL
- [meshoptimizer](https://github.com/zeux/meshoptimizer) simplification and meshlet algorithms, exposed through the Three.js add-on modules

Both dependencies are installed through npm and retain their own licences.

## Validation of the grouped implementation

`npm test` checks exact full-resolution triangle coverage and winding, unchanged boundary edges at every group LOD, valid indices and enclosing group bounds, monotonic error/counts, deterministic builds, malformed input rejection, and WebGPU near-plane frustum extraction.

The production build, CPU tests and offline TSL-to-WGSL generation were run in the hosted workspace. Physical-device shader validation and visual WebGPU behavior remain unverified; the available test browser has no WebGPU. These tests do not establish rendering performance or general crack-free behavior for arbitrary malformed/non-manifold imports.

### Visible dispatch + pixel bounds (main forest)

In the main forest's **Rasterizer** dropdown, select **Bitmask · visible dispatch + pixel bounds**. Keep **Full resolution** selected to compare original geometry without LOD. Switch to **Bitmask compute · forest** for the previous algorithm or **Hardware** for normal GPU rasterization. Geometry settings remain independent.

[Open the full-detail comparison](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=bounded).

This variant generates indirect bin dispatch arguments from GPU-visible cluster counts without a CPU readback. It also skips projected triangle bounds that contain no pixel centres before allocating tile entries. Coverage, depth and shading use the original bitmask algorithm. This is not Nanite or geometry streaming.

The production shaders match the original depth/ID checksum on the exported forest in SwiftShader; see [measured result](docs/emulation-gpu/indirect-bounded.json). Software-adapter timings do not predict phone FPS.

[Repeated main-forest stage profile](docs/EMULATED_STAGE_PROFILE.md): production original and bounded shaders at 384×704, with warm-up excluded and per-stage timing distributions. In this software-adapter run, tile rasterization becomes the largest measured stage after the dispatch optimisation. GPU selection and browser presentation are outside the harness.

### Triangle fast paths (experimental)

Select **Bitmask · triangle fast paths** in the main forest, or [open it at full detail](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=fast). It avoids unnecessary clipping and repeated coverage checks, and shares shading within each triangle batch. Emulated total GPU medians improved about 15% in the spawn view and 2% in the canopy view; phone performance is unverified. [Changes, measurements and correctness checks](docs/RASTER_FAST_PATHS.md).

### Visibility + atomic HZB

[Open the new full-detail forest path](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=visibility), or select **Visibility + atomic HZB** in the Rasterizer dropdown. It combines hardware depth/triangle-ID visibility, atomic 8×8 coverage masks, current-frame hierarchical occlusion rejection, indirect cluster draws and final-pixel shading. Hierarchical screen-space LOD remains a separate geometry option; earlier atomic software raster modes remain available.

The emulated forest rejected 7,047 of 42,990 selected clusters on its second frame with exact depth/ID/colour parity against unculled hardware visibility. Phone performance is unverified. This implements the core visibility pathway. Separate streaming and surface-voxel experiments are now available below. [Architecture, checks and reproduction](docs/ATOMIC_VISIBILITY_PATH.md).

### Streaming and distant surface voxels

Select **Visibility + atomic HZB · streaming** for a bounded geometry page cache,
or **Streaming + distant surface voxels** to additionally approximate distant trees.
Both retain atomic coverage, HZB recovery and final-pixel shading. The existing
Visibility + atomic HZB mode remains available.

[Streaming comparison](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=streaming)
· [Surface-voxel comparison](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=voxel)

Pages stream from CPU memory with a 256 KiB/frame geometry payload cap; fallback
stays visible while detail loads. Surface voxels use exposed cube faces, not Epic's
specialized brick rasterizer. These additions are emulated and tested, but phone
speedups are unverified. [Implementation, limitations and results](docs/STREAMING_AND_VOXELS.md).

### Foliage coverage correction

The surface-voxel option now preserves opaque trunks/branches and estimates
partial leaf coverage instead of making every cell solid. Coverage-rejected
samples write neither depth nor atomic coverage. Voxel error is capped at one
screen pixel, and a triangle fallback stays resident. The stricter limit can
keep the visible forest in triangles at mobile resolutions.

Controls also includes an optional **GPU front-to-back cluster ordering** test
(off by default). This is a bounded GPU sorting experiment inspired by depth
ordering in Epic's pipeline, not a claimed phone speedup. See the updated
[coverage and implementation notes](docs/STREAMING_AND_VOXELS.md).
