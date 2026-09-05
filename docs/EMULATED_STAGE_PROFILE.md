# Main forest stage profile

The repeated SwiftShader run identifies tile rasterization as the largest **measured raster-pipeline stage** after visible dispatch and pixel-bounds rejection. This is a software-adapter finding. It does not identify the phone's bottleneck, and GPU selection/presentation are outside this harness.

## Workload and method

Actual Emerald Basin high-density assets, 28,172,160 source triangles, full detail, 384×704 pixels. Fixed spawn camera: `[0, 4.1146040622323286, 62]`, pitch −0.05, yaw 0. This is not a reconstruction of the screenshot camera: selection here produces 2,649,588 triangles versus approximately 5.8M in the screenshots.

The original uses production capacity dispatch; bounded uses the production GPU argument shader and `dispatchWorkgroupsIndirect`. Both execute production raster WGSL with the documented two-vertex-buffer packing needed by SwiftShader. Two warm-up frames and five measured frames per mode, serial execution without concurrent project tests. Shader compilation, assets and uploads are outside the measurements. Timing includes the existing standard batch/coverage counters; optional rejection diagnostics are off.

## Measurements

Median GPU timestamp durations, milliseconds:

| Stage | Original | Visible dispatch + pixel bounds |
|---|---:|---:|
| Clear | 0.21 | 0.24 |
| Generate indirect arguments | Not used | 0.020 |
| Bin triangles | 4,010.16 | 559.87 |
| Raster tiles | 1,416.88 | 878.70 |
| Total of stages, per-frame median | 5,360.62 | 1,483.63 |

The total is the median of per-frame sums, not the sum of independent medians. Raw samples, min/max and nearest-rank p95 are in [profile-384x704.json](emulation-gpu/profile-384x704.json). With five samples p95 equals the maximum; these numbers do not establish long-run stability. Host scheduling contributes variation.

Bounded rasterization takes about 61% of the combined bin/raster median durations. Argument generation and clear are negligible on this adapter. Reducing capacity dispatch already removed the dominant original binning cost; rasterization is now the larger target. This breakdown does not separate raster triangle reconstruction, linked-list traversal, coverage math, atomics, barriers and shading. Follow-up experiments should isolate those costs rather than assume any one of them dominates.

Tile entries fall from 1,642,483 to 734,903; batches fall from 53,878 to 25,496. No overflow scans. Both modes produce exactly the same depth/ID checksum:

`05204868c6fcad710ea0ae6af02e55fbaa776f3f659e8b4c76b640c7b24eb9f9`

## Selection and startup

The exporter records scene build (2,395 ms), asset build (5,184 ms), and CPU-equivalent selection (44.61 ms) separately. Selection is a single cold CPU measurement including camera/instance setup. It is **not** GPU selection timing and cannot be compared directly with the raster stage durations. CPU projection is skipped during GPU export because the real shader performs projection.

Three.js GPU culling, sky/water rendering, presentation, hardware raster and phone drivers remain unmeasured. No emulated duration has been converted into predicted phone FPS. Main-forest rendering behavior is unchanged by this profiling update.

## Reproduce

See [emulation instructions](../scripts/emulation/README.md#repeated-stage-profiling). Export accepts resolution, pitch/yaw, density and geometry mode; the runner accepts independent warm-up/sample counts and a report output path.
