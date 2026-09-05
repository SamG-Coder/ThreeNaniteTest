# Architecture

## Design target

The project targets the useful middle ground between normal Three.js LOD objects and a full virtualized-geometry renderer.

The renderer is GPU-driven after asset construction. JavaScript updates camera uniforms and submits a fixed sequence of compute and render passes. It does not inspect individual instances, LODs or meshlets every frame.

## 1. Asset representation

### Shared vertex streams

Every generated LOD references the original source vertices. The GPU receives:

```text
vertices          vec4<f32>
normals           vec4<f32>
uvs               vec2<f32>
```

The fourth position and normal components are padding suitable for storage-buffer alignment and matrix multiplication.

### Fixed meshlet index stream

Every cluster occupies exactly:

```text
64 triangles × 3 indices = 192 uint32 values
```

Clusters containing fewer triangles are padded with degenerate triangles. Therefore the source index for a vertex invocation is:

```text
clusterId * 192 + localVertex
```

This removes a metadata read from the vertex path and lets one non-indexed indirect draw expand every accepted meshlet.

### Cluster culling data

Each cluster stores three four-component records:

```text
bounds      centre.xyz, radius
cone apex   apex.xyz, cutoff
cone axis   axis.xyz, unused
```

The build also stores one integer LOD ID per cluster for the debug view.

### LOD table

Each LOD table entry contains:

```text
geometric error
first cluster
cluster count
original triangle count
```

The table is a read-only storage buffer indexed by `groupId * lodCount + selectedLod`. Separate group spheres enclose all referenced vertices. LOD summaries in the UI aggregate all groups; they are not contiguous cluster ranges.

## 2. Per-frame compute

### Counter clear

A small compute pass clears:

- Visible meshlet count
- Overflow flag
- Per-LOD accepted meshlet counters

### Group culling and LOD selection

One compute invocation handles one `(instance, group)` pair. Only group zero writes the shared instance world matrix; all groups calculate the same transform locally.

It creates a deterministic uniform-scale world matrix, writes that matrix once per instance into a storage buffer and tests the transformed group bounding sphere against all six frustum planes.

When HZB culling is valid, the same sphere is tested against the previous frame's depth pyramid.

LOD selection uses projected geometric error:

```text
pixelError = geometricError × scale × cot(fov / 2) × screenHeight
             -----------------------------------------------------
                           2 × distanceToSurface
```

The coarsest group LOD below the UI threshold is selected. Adjacent groups can choose different levels, with their original boundary edges locked during asset building.

### Cluster culling

The invocation loops over clusters in the selected LOD and performs:

1. Bounding-sphere frustum culling
2. Meshlet normal-cone culling
3. Previous-frame HZB sphere culling
4. Atomic append into the visible list

The current prototype follows the a bounded per-group cluster loop rather than the previous long per-instance loop. A more scalable hierarchy should replace it with queue traversal and one invocation per node or cluster.

### Visible list

Each accepted item is only two integers:

```text
instanceId
clusterId
```

The atomic counter is allowed to continue increasing after the storage capacity is reached, but writes are guarded. The indirect draw count is clamped and a separate overflow flag is set.

### Draw arguments

A one-invocation compute pass writes:

```text
vertexCount   = min(visibleMeshlets, capacity) × 192
instanceCount = 1
firstVertex   = 0
firstInstance = 0
```

The resulting `IndirectStorageBufferAttribute` is attached directly to the dummy `BufferGeometry`.

## 3. Vertex pulling

The hardware vertex stage receives only `vertexIndex` from the draw.

It calculates:

```text
visibleSlot = vertexIndex / 192
localVertex = vertexIndex % 192
```

Then it reads:

```text
visibleList[visibleSlot]
indexBuffer[clusterId * 192 + localVertex]
vertexBuffer[sourceVertex]
normalBuffer[sourceVertex]
uvBuffer[sourceVertex]
instanceWorld[instanceId]
```

World position, normal, UV, instance ID, cluster ID and LOD ID are passed to the selected node material.

## 4. HZB occlusion

The Nanite Lite scene and ordinary Three.js occluders render into an HDR render target with a float depth texture.

After rendering, compute kernels build a maximum-depth pyramid. Level zero is half resolution. Every subsequent level keeps the maximum of a 2×2 block from the previous level.

The next frame projects the closest point of a bounding sphere into the previous view and selects a pyramid level based on the sphere's projected footprint. A sphere is rejected when its nearest depth is farther than the maximum stored depth plus a bias.

The history is disabled when:

- The renderer has no prior frame
- The viewport changes
- Occluder visibility changes
- Any camera translation or rotation above a numerical tolerance
- LOD threshold changes

This path remains experimental and off by default. The inherited projected sphere footprint is not guaranteed conservative. A production implementation needs conservative projected bounds plus a second current-frame re-test pass for previously occluded nodes.

## 5. Normal-cone culling

Meshoptimizer calculates a cone containing the directions of all triangles in a meshlet. The compute pass transforms the cone axis and apex into world space.

A cluster is rejected when:

```text
dot(normalize(worldApex - cameraPosition), worldAxis) >= coneCutoff
```

Only valid cones with a cutoff in [0, 1) and a nonzero axis are eligible for rejection. Invalid/wide cones stay visible.

## 6. Debugging

The demo reads the visible count, overflow flag and LOD counters back to the CPU approximately twice per second.

Readback is diagnostic and deliberately asynchronous. A failure does not stop rendering.

Debug materials show:

- Hashed meshlet and instance IDs
- Selected cluster LOD
- World-space normals

## Device limits

The group culling shader binds 12 storage buffers; bootstrap explicitly requests this limit. Devices below it cannot run this implementation yet. The group dispatch is checked against the standard 65,535 workgroup limit. The fixed visible-list overflow behavior remains unchanged and can omit geometry; it is not a parent fallback scheme.
