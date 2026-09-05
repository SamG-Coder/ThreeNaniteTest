# ThreeNaniteTest

An experimental Nanite-inspired geometry renderer built with **Three.js 0.185.1** and **WebGPU**.

The prototype explores GPU-driven meshlet culling, screen-space LOD selection, and indirect rendering in the browser. It uses discrete whole-object LODs; it does not implement Unreal Engine Nanite's hierarchical geometry system.

## Get started

The source project is currently packaged in [nanite-lite-threejs.zip](nanite-lite-threejs.zip).

1. Download and extract the ZIP.
2. Open a terminal in the extracted `nanite-lite-threejs` directory.
3. Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open the local address printed by Vite, normally **http://localhost:5173**.

Requirements:

- Node.js **22.12 or newer**.
- A browser and GPU with WebGPU support.
- Serve the app through localhost or HTTPS.

To build and preview locally:

```bash
npm run build
npm run preview
```

To run the included static syntax checks:

```bash
npm run validate
```

## Features

- Six discrete LOD levels generated with meshoptimizer.
- Meshlets with up to 64 vertices and 64 triangles.
- GPU frustum culling for instances and meshlets.
- Meshlet normal-cone backface culling.
- Screen-space geometric-error LOD selection.
- Experimental previous-frame hierarchical-Z occlusion culling.
- GPU-compacted visible meshlet lists and GPU-generated indirect draw arguments.
- Storage-buffer vertex pulling and one hardware-rasterized draw for the prototype geometry.
- GPU readback statistics and LOD distribution.
- Runtime GLB loading for the largest static mesh.

The default scene contains 196 instances of a procedural torus knot with 65,536 source triangles each: approximately **12.8 million source triangles** before LOD selection and culling. This is source geometry count, not a claim about triangles rendered each frame or measured performance.

## Controls

| Control | Action |
| --- | --- |
| Left drag | Orbit |
| Mouse wheel | Zoom |
| Right drag | Pan |
| Output | Switch between shading, meshlet IDs, selected LOD, and world normals |
| LOD error | Adjust acceptable projected geometric error in pixels |
| Previous-frame HZB occlusion | Toggle experimental occlusion rejection |
| Meshlet normal-cone culling | Toggle backface cluster rejection |
| Show test occluders | Toggle the test wall |
| Load .glb | Import the largest non-skinned static mesh |

## How it works

The asset builder generates simplified index-only LODs, splits each level into meshlets, computes bounds and normal cones, and packs the data into shared GPU buffers. LODs share the original position, normal, and UV streams.

Each frame, compute passes cull instances, choose an LOD for each surviving instance, cull meshlets, and append visible meshlets to a compact list. The GPU then writes indirect draw arguments. The render shader pulls geometry from storage buffers, and a depth pyramid is built for subsequent-frame occlusion tests.

## Project layout

These paths are inside the extracted project:

```text
nanite-lite-threejs/
  src/
    main.js                  App, camera, and GLB loading
    buildNaniteLiteAsset.js   LOD generation and meshlet packing
    NaniteLiteRenderer.js     GPU culling, HZB, and indirect rendering
    config.js                Meshlet, LOD, and scene limits
    ui.js                    Controls and statistics
    styles.css               Interface styling
  docs/
    ARCHITECTURE.md           Pipeline details
    ROADMAP.md                Planned development
  scripts/
    validate.mjs             Static syntax checks
  package.json
  vite.config.js
```

## Current limitations

- Whole-object LOD chains; no recursive cluster hierarchy or cluster DAG.
- Geometry is fully resident in GPU memory; no geometry-page streaming.
- Hardware rasterization only; no dedicated software rasterizer for tiny triangles.
- One procedural material; imported material assignments are not preserved.
- GLB import selects one static mesh, rather than loading a complete scene.
- Skinned meshes, morph targets, transparency, transmission, and runtime vertex displacement are unsupported.
- Previous-frame occlusion is experimental and lacks a production two-pass recovery system.
- The visible meshlet list is capped at 16,384 entries by default.
- The dummy position buffer used for indirect rendering allocates approximately 36 MiB at the default capacity.

This is a research prototype. Browser compatibility, rendering correctness, and performance need testing on the target device.

## Development direction

The next major step is replacing whole-object LODs with a hierarchy of grouped, simplified clusters, followed by GPU traversal and geometry streaming. See `docs/ARCHITECTURE.md` and `docs/ROADMAP.md` inside the ZIP for more detail.

## Credits and license

Built with [Three.js](https://threejs.org/) and [meshoptimizer](https://github.com/zeux/meshoptimizer), using the Three.js meshoptimizer add-ons.

The source archive includes an MIT license. Dependencies retain their own licenses.
