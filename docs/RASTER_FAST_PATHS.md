# Triangle fast paths

The main forest now offers **Bitmask · triangle fast paths**, a separate experimental option built on visible dispatch + pixel bounds. Geometry selection and detail level remain independent. [Open full detail](https://samg-coder.github.io/ThreeNaniteTest/?geometry=full&bitmaskVariant=fast).

## Changes

- When all three vertices are on or beyond the near plane, construct the projected triangle directly. Crossings still use the existing homogeneous clipper.
- During pixel resolution, a set coverage-mask bit already proves coverage and valid depth. For three-vertex triangles, repeat only depth interpolation with the same arithmetic. Clipped quads keep the original fan selection.
- Shade each triangle once per tile batch and share its colour across winning pixels. This adds 512 bytes of workgroup storage, with no new global geometry/depth cache, GPU readback or rendering pass.

All previous modes remain available. This is an arithmetic/setup optimisation, not extra LOD, streaming or Nanite.

## Measured results

SwiftShader, real forest buffers, 384×704, full detail, two warm-up frames followed by five measured frames per mode. Values are median milliseconds; total is the median of per-frame sums.

| View / mode | Bin | Raster | Total GPU |
|---|---:|---:|---:|
| Spawn / previous bounded | 519.62 | 726.44 | 1,323.37 |
| Spawn / triangle fast paths | 423.67 | 687.20 | 1,123.70 |
| Canopy / previous bounded | 252.00 | 717.65 | 969.88 |
| Canopy / triangle fast paths | 184.95 | 708.92 | 947.28 |

The total median improved about **15% at spawn** and **2% looking into the canopy**. The canopy difference is small relative to run variation. This is not a proven general speedup, and it does not predict phone FPS. Most of the consistent stage reduction is bin setup; raster work remains substantial. Spawn was run fast-first; canopy bounded-first. Reports preserve all raw samples.

[Spawn results](emulation-gpu/fast-spawn.json) · [Canopy results](emulation-gpu/fast-canopy.json).

The spawn experiment used the combined prototype; production has the same shader operations plus explanatory comments, so its source hash differs. Canopy and fixtures execute the production export.

## Rejected and isolated experiments

An alternative where each pixel scans every batch candidate was approximately 2.5× slower in rasterization (2,243 ms versus 903 ms in that short sweep), despite removing coverage-mask atomics. It was not added to the forest. Shared shading, fewer resolve checks and the unclipped setup path were also measured separately; individual results were noisy, so they are exploratory, not additive speedup claims.

[Ablations](emulation-gpu/raster-ablation.json) · [Clip-only comparison](emulation-gpu/clip-ablation.json). Reproduce prototype exports with `node scripts/emulation/export-raster-experiments.mjs /tmp/forest-profile` after exporting the workload. This overwrites `fast.wgsl` with the prototype; rerun the regular exporter for production shaders.

## Correctness

Both forest views match previous bounded depth and triangle IDs exactly, and the RGBA16F output is byte-identical. The harness now checks colour as well as visibility. This compares compute modes; their lighting still differs from Three's hardware renderer.

A small real-GPU fixture verifies near-plane crossings, exact near-plane endpoints, depth ties, degenerate padding, back faces, partial edge tiles and more than one candidate batch. A one-entry pool forces exhaustive overflow. All four display modes (shaded, meshlets, LOD and normals) match depth, IDs and colour with overflow; shaded overflow also matches the normal-pool result. [Fixture results](emulation-gpu/fast-fixtures.json). Cold fixture timings are correctness data only.

```sh
node scripts/emulation/export-raster-fixture.mjs /tmp/forest-fixture
# With the software Vulkan ICD configured as in the emulation README:
python scripts/emulation/run-swiftshader.py /tmp/forest-fixture --variants=bounded,fast --dispatch=production --warmup=0 --samples=1 --capacity=1 --mode=0
```

Repeat `--mode=1`, `2`, `3` for the other display modes. The existing Node tests and Naga shader validation include the production fast shader.
