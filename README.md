# Three.js WebGPU Nanite Lite

A runnable GPU-driven geometry prototype for **Three.js 0.185.1** and WebGPU.

This is not Unreal Engine Nanite. It implements a deliberately smaller and understandable subset that is useful in a browser renderer:

- Spatial groups of up to 64 leaf meshlets in the terrain scene (16 in the mesh stress test), each with its own GPU-selected LOD
- Explicit shared-boundary, open-border and attribute-seam vertex locks
- 64-vertex / 64-triangle meshlets
- Per-group and per-meshlet GPU frustum culling
- Meshlet normal-cone backface culling
- Screen-space geometric-error LOD selection
- Experimental previous-frame hierarchical-Z occlusion culling (off by default)
- GPU-compacted visible meshlet list
- GPU-generated indirect draw arguments
- Storage-buffer vertex pulling
- One hardware-rasterized draw per Nanite Lite asset batch (terrain and trees in the forest)
- Live GPU readback statistics and LOD distribution
- Runtime `.glb` import for the largest static mesh

The default map is **Emerald Basin**, a natural forest stress test with a mountain lake, granite outcrops and detailed broadleaf trees. The map contains no buildings. Trees contain modeled branches and individual opaque 3D leaves, rather than solid canopy blobs or alpha cards.

The scene stores one high-detail tree asset and places it 96, 256 or 512 times with deterministic positions, rotations and scales. These are full-resolution indexed instances when Nanite is off; Nanite on uses the same source asset with GPU group LOD selection and meshlet culling. Terrain and forest use separate indirect draws in one scene and one presentation pass. Geometry readouts sum both batches; FPS includes lake shading too.

The original mesh stress test and mountain terrain sample remain available in Controls.

## GitHub Pages

The Pages workflow builds and tests pushes to `main`, then deploys the Vite `dist` output.
In repository **Settings → Pages → Build and deployment**, choose **GitHub Actions** as the source.
The project URL is https://samg-coder.github.io/ThreeNaniteTest/ after the deployment succeeds.
Relative asset paths support the repository subdirectory and local preview.

## Forest stress presets and controls

- **Build forest** regenerates the selected 96-, 256- or 512-tree preset. Desktop defaults to 512 trees and coarse-pointer devices to 256. Presets share nested tree placement, and geometry is never rebuilt by the Nanite on/off toggle.
- The tree prototype contains roughly 108K triangles. Depending on the preset, the forest represents roughly 11–56 million source triangles including terrain and rocks. Exact counts appear in the interface. Instancing avoids storing dozens of millions of unique vertices.
- Desktop: click the scene for mouse look; WASD/arrow keys move, Shift sprints, Space jumps, Escape releases the mouse.
- Mobile: left joystick moves, swiping the scene looks around, and Jump jumps. Walking follows the ground and uses approximate collision against trunks, rocks and the lake boundary.
- Walking / Orbit camera switches navigation. Reset position returns to the spawn or overview.
- Nanite view shows meshlet clusters, LODs or normals for the terrain and trees together.
- FPS and mean ms/frame measure animation-frame cadence, not isolated GPU execution time. Hidden tabs and asset-building periods are excluded; changing Nanite resets the sample. Display refresh rate can cap FPS.
- The geometry readout compares padded submitted meshlet triangles with source triangles. Capacity overflow is shown explicitly. A lower triangle count does not guarantee higher FPS; culling and compute have overhead.
- The lake uses the same opaque animated water material in both modes. It is outside the Nanite asset statistics and is not used to manufacture a geometry speedup. It has no planar reflections or refraction.
- Experimental previous-frame HZB is disabled in the multi-asset forest map. Frustum culling, normal-cone culling and per-group LOD selection remain active.
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
- **Nanite view**: toggle meshlet IDs, selected LOD, or world normals; off returns to shading
- **LOD error**: acceptable projected geometric error in pixels
- **Experimental HZB occlusion**: opt into research-grade GPU occlusion rejection
- **Meshlet normal-cone culling**: reject clusters whose triangles all face away
- **Show test occluders**: display or hide the wall used to exercise HZB culling
- **Load .glb**: use the largest non-skinned static mesh in a binary glTF

## Source layout

```text
src/
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
  ROADMAP.md                 Path from this prototype to a fuller Nanite system
```

## What the prototype actually does

### Asset build

`buildNaniteLiteAsset()` performs the following work in the browser:

1. Validates and copies the source attributes and triangle indices.
2. Builds 64/64 leaf meshlets and spatially partitions them into groups of at most 16.
3. Locks shared-position vertices across groups, plus explicit open/non-manifold and attribute-seam borders.
4. Builds six index-only LODs independently for each group with accumulated simplification error.
5. Re-clusters each group LOD and packs bounds, cones and indices into shared buffers.
6. Uploads group bounds and a storage table of `(error, clusterStart, clusterCount, triangleCount)`.

Every group chooses its own LOD on the GPU. All levels share the original vertex stream, and locked borders preserve their original edges. Spatial grouping currently uses a deterministic longest-axis median split; it is not an adjacency-optimized partitioner.

### GPU frame

Each frame executes:

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

- It uses **independent boundary-locked patch LOD chains**, not a recursive cluster DAG. Locked boundaries limit coarse reduction; the next step is merging groups into simplified parents.
- All generated geometry is fully resident in GPU memory.
- It does not stream geometry pages.
- It uses hardware rasterization only; there is no specialised compute path for sub-pixel triangles.
- One material is used per Nanite Lite draw. The game scene uses vertex colors; the mesh stress test uses a procedural checker. Imported material assignments remain unsupported.
- The GLB loader selects one static mesh and ignores additional primitives and material assignments.
- Skinned meshes, morph targets, transparency, transmission and runtime vertex displacement are unsupported.
- Instance transforms use uniform scaling, allowing normals and culling bounds to use the same world matrix safely.
- Occlusion is off by default. The inherited sphere projection is not conservative in all cases and there is no current-frame recovery pass. History is invalidated on camera movement, LOD-threshold changes, viewport changes and occluder visibility changes. Leave it disabled when checking coverage.
- The fixed visible-list capacity is 16,384 meshlets. The UI displays an overflow warning when it is exceeded.

## Memory note

The indirect draw expands a visible meshlet into 192 vertex invocations. Three.js uses a dummy position attribute to establish a WebGPU-valid vertex range even though the shader pulls real positions from storage buffers. The dummy attribute uses an unused `float32x3` element, matching Three.js' normal position-buffer contract. At the default 16,384-meshlet capacity, it is approximately 36 MiB.

Reduce `MAX_VISIBLE_CLUSTERS` in `src/config.js` for lower-memory devices. Increase it only after profiling.

## Why the renderer uses 64/64 meshlets

A 64-triangle meshlet maps cleanly to a 64-thread compute workgroup and gives predictable fixed-size expansion for the indirect draw. It is not universally optimal, but it is a reasonable cross-vendor starting point for WebGPU.

## Moving toward a real hierarchy

The next architectural step is replacing the independent group chains with a recursive cluster hierarchy:

1. Build leaf meshlets.
2. Partition topologically and spatially adjacent meshlets into groups.
3. Simplify each group while locking the external boundary.
4. Re-cluster the simplified parent representation.
5. Repeat until a small root representation remains.
6. Traverse nodes on the GPU with ping-pong queues.
7. Render a resident parent when requested child pages are unavailable.

See [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Credits

The implementation is built on:

- [Three.js](https://threejs.org/) WebGPU renderer and TSL
- [meshoptimizer](https://github.com/zeux/meshoptimizer) simplification and meshlet algorithms, exposed through the Three.js add-on modules

Both dependencies are installed through npm and retain their own licences.

## Validation of the grouped implementation

`npm test` checks exact full-resolution triangle coverage and winding, unchanged boundary edges at every group LOD, valid indices and enclosing group bounds, monotonic error/counts, deterministic builds, malformed input rejection, and WebGPU near-plane frustum extraction.

The production build and CPU tests were run in the hosted workspace. Browser shader compilation and visual WebGPU behavior have not been verified there: no local browser executable is installed. These tests do not establish rendering performance or general crack-free behavior for arbitrary malformed/non-manifold imports.
