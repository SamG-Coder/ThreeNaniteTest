# Triangle / sparse-brick hierarchy

Select **Cluster hierarchy · streamed bricks** in the forest rasterizer control, or open [the valley test](https://samg-coder.github.io/ThreeNaniteTest/?scene=landscape&renderer=clusters).

This mode builds a new representation hierarchy from original source triangles. It does not call the preset LOD generator, use its reduced leaf meshes, or insert the old whole-tree voxel mesh. Shared triangle/cell intersection utilities are geometry math, not prebuilt representations.

## Implemented pathway

1. A worker clusters original triangles into 64-vertex, 64-triangle leaves, preserving float UVs, colours, normals and material tags. Spatial partitioning builds a binary hierarchy over these leaves.
2. Each parent generates sparse 4×4×4 voxel bricks directly from its original subtree. Occupancy, directional projected coverage, area-weighted colour, UV mean and normal moments are stored per occupied cell. No exposed cube-face mesh is generated. A representation cost heuristic rejects brick candidates with more bounding triangles than the source subtree.
3. The maximum voxel-cell diagonal supplies a spatial support error, made monotonic up the hierarchy. GPU breadth-first queues choose a resident cut using its projected error. This is not a measured image/opacity error bound. Full resolution requests original leaves; memory pressure can temporarily retain parent fallbacks.
4. Variable-sized geometry pages are compressed with gzip into IndexedDB, keyed by the source attributes and a format version. Only root and pending page data need to remain in the CPU page cache. Quota/storage failures retain an in-memory fallback. Source geometry and hierarchy metadata remain in memory for the original renderer and traversal. This is local persistent page streaming, not an HTTP geometry CDN.
5. GPU demand is read asynchronously, at most every 50 ms. The geometry arena is normally 32 MiB per asset. Uploads share a 256 KiB/frame budget. Complete replacement groups are published together; parents remain available through incomplete uploads, eviction and camera movement.
6. Selected clusters enter separate GPU triangle and brick bins. Triangles use hardware visibility rasterization; bricks use projected rectangles and fragment ray traversal through occupied cells. Distant transparency uses directional coverage with stable cluster/instance-based stochastic sampling.
7. The existing atomic OR coverage masks, visibility history and current-frame seed/HZB/recovery passes remain. Shading runs on final visible samples. Nearby triangle shading retains hardware-interpolated UVs; distant bricks approximate filtered material and normal distributions.

The UI reports padded triangle slots and brick clusters separately. A reduction in triangle slots is not a claim that brick work is free or faster.

## Validation

- Unit tests verify original leaf triangle identity and UV preservation, monotonic error, sparse occupancy, complete replacement publication, cancellation and asynchronous page loading.
- Dawn/Tint compiles all production shader modules. The native Vulkan harness executes the actual Three.js-integrated renderer, including traversal, indirect binning, triangle/brick rasterization and atomic HZB.
- The small close-view fixture produces identical pixels at error 0 and error 1. Native tests at multiple distances report no GPU validation errors.
- A Chromium test exercised the worker, compressed IndexedDB persistence, asynchronous residency and reopening a cached asset without rebuilding it.
- On the actual 262,720-triangle source tree, a CPU cut audit at 800-pixel height and 1-pixel error retained all triangles at 10/25 units. At 100 units it selected 37,504 original triangles plus 22,762 bricks; at 400 units, 128 triangles plus 4,240 bricks. These are work counts, not FPS.
- The actual GPU renderer was exercised with two source trees at 192×128. At 12 units it submitted 2,322 triangle clusters and 5,104 brick clusters; at 80 units, 9 and 749; at 160 units, 5 and 86. These include the ground fixture and seed/recovery draws. This low-resolution software-Vulkan test does not predict phone performance.

Run `npm test`, `npm run validate`, `npm run build`, and `node scripts/emulation/run-cluster-renderer.mjs` with a Vulkan adapter. `--tree` exercises the actual landscape tree; an optional `/tmp/cluster-tree.v8` asset avoids recooking it. Raw render targets and statistics are written to `/tmp`.

## Scope and limits

This is a Nanite-inspired experimental pathway, not Epic's implementation. It follows the cluster/representation/streaming approach described in [Nanite](https://dev.epicgames.com/documentation/unreal-engine/nanite-virtualized-geometry-in-unreal-engine) and [Nanite Foliage](https://dev.epicgames.com/documentation/unreal-engine/nanite-foliage).

It does not implement Epic's complete mesh simplification DAG, assemblies, skinning, offline asset compression format or software micropolygon rasterizer. Triangle parents can remain original geometry when the brick candidate is unsuitable. Normal distributions use diagonal moments, not Epic's full shading model. Coverage is an approximation of source geometry; texture alpha masks and arbitrary translucent materials are not supported by the brick builder. The supplied leaves have geometric silhouettes. Water remains its separate transparent Three.js material.

First-time cooking is substantial: the full source tree took about 142 seconds in the reference CPU environment and produced roughly 66 MB of raw asset data before page compression. The worker keeps the UI responsive; cached reloads avoid that build. No mobile speedup is claimed until measured on the same camera, viewport and quality settings.
