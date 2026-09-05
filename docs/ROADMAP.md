# Current hierarchy milestone

Implemented: separate Patch LOD / Full resolution / Hierarchical LOD controls; recursive boundary-preserving parent construction in meshoptimizer WASM; stackless GPU screen-space traversal; cut/coverage/boundary regression tests; offline WGSL generation.

Next performance work: device profiling, parallel work queues for large single assets, tighter error bounds, cluster repartitioning into a DAG, worker/offline preprocessing and streamed residency. WASM does not remove WebGPU limits. The earlier roadmap below remains historical context; independent patch chains are now named Patch LOD.

# Roadmap to a fuller Nanite-style renderer

The current project proves the WebGPU plumbing. The next work should change the asset and traversal model, not add visual polish first.

## Implemented intermediate step

- Deterministic spatial leaf groups with independent GPU LOD selection.
- Explicit boundary locks, including split attributes and open borders.
- Group LOD metadata in storage buffers and one compute invocation per instance/group pair.
- Correct WebGPU frustum convention, invalid-cone guard, explicit storage-buffer limit request.
- Topology regression tests; unsafe previous-frame HZB is opt-in.

This is a patch-based bridge to Phase 2, not completion of Phase 2. Boundary locks reduce the achievable coarse simplification until parent grouping can remove internal boundaries.

## Phase 1 — Harden the current prototype

- Add GPU timestamp queries for culling, HZB and raster costs.
- Add visible-list high-water telemetry and automatically sized capacities.
- Add conservative handling for invalid normal cones.
- Add a current-frame second occlusion pass for newly revealed geometry.
- Add LOD hysteresis so clusters do not switch repeatedly at one threshold.
- Separate scene transforms from the compute shader and support arbitrary static instance matrices.
- Add inverse-transpose normal matrices for non-uniform scaling.
- Process multiple GLB primitives without merging material boundaries.

## Phase 2 — Hardware-only cluster hierarchy

Replace the complete object LOD chain with grouped cluster parents.

### Offline build

1. Build leaf meshlets.
2. Construct meshlet adjacency using shared position indices rather than only split UV or normal indices.
3. Partition adjacent clusters into groups of roughly 8–24.
4. Lock each group's external boundary vertices.
5. Simplify the grouped geometry.
6. Re-cluster the simplified geometry into parent meshlets.
7. Record parent-to-child ranges, group bounds and cumulative geometric error.
8. Repeat until a small root set remains.

### Runtime traversal

Use ping-pong queues because WGSL compute has no recursion:

```text
queue A → process hierarchy level → queue B
queue B → process hierarchy level → queue A
```

For each node-instance pair:

```text
frustum test
cone test
HZB test
projected-error test
residency test

refine  → append children
accept  → append node clusters
missing → accept resident parent and request child page
```

Use a fixed maximum hierarchy depth so JavaScript submits a predictable sequence of indirect compute dispatches.

## Phase 3 — Materials

Start with a small number of bins:

```text
opaque standard
opaque alpha-tested
two-sided standard
special
```

Each bin receives its own visible list and indirect draw.

Later, move compatible textures into arrays and store a material ID per cluster. Keep clusters inside one material boundary.

Do not begin with arbitrary Three.js materials. Transparent, transmissive and order-dependent surfaces should remain on the conventional renderer.

## Phase 4 — Geometry pages

Create a binary asset format with pages around 64–256 KiB compressed.

Each page should contain contiguous node, cluster and geometry data:

```text
page header
hierarchy nodes
cluster records
quantised vertices
vertex references
micro-indices
material references
```

Keep root and coarse parent pages resident permanently.

GPU traversal emits missing page IDs into a request buffer. CPU readback uses a staging-buffer ring rather than mapping the live request buffer every frame.

The worker thread should:

1. Deduplicate requests.
2. Prioritise by projected error and distance.
3. Fetch an individual page or HTTP byte range.
4. Decode Meshoptimizer compression.
5. Upload into a free range in the GPU geometry heap.
6. Update page-table and residency buffers.

A missing fine page must render its resident parent. It must never create a hole.

## Phase 5 — Compression

After traversal is correct, reduce bandwidth:

- Object-wide or hierarchy-wide quantised position grid
- Cluster-relative anchors
- 16–21-bit position deltas depending on asset scale
- Octahedral normals and tangents
- 12–16-bit UVs
- Four 8-bit micro-indices packed into each `uint32`
- Meshoptimizer meshlet and vertex codecs for disk/network data

Keep an unpacked debug mode. Debugging hierarchy cracks and corrupted bit streams simultaneously is a waste of time.

## Phase 6 — Tiny-triangle software rasterization

Only add the compute rasterizer after profiling proves hardware primitive setup is the bottleneck.

A hybrid path should classify accepted triangles by projected bounding-box size:

- Large triangles: existing indirect hardware draw
- Tiny triangles: compute rasterization into a visibility buffer

The visibility buffer should avoid independent atomics for triangle and instance winners. Prefer one complete winner token or a compare-exchange protocol that cannot pair an ID from one fragment with depth from another.

The resolve pass reconstructs barycentrics, material coordinates, normals and motion from the winning IDs.

## Phase 7 — Production concerns

- Two-pass occlusion and disocclusion handling
- Motion vectors and temporal antialiasing
- Shadow-view cluster traversal
- Ray-query or ray-tracing representation interoperability
- Editor visualisation of hierarchy, bounds, residency and error
- Asset build caching and deterministic output
- Device-limit adaptation
- Mobile capacity presets
- Crash-safe queue overflow handling
- Validation scenes for cracks, thin surfaces and aggressive camera cuts
