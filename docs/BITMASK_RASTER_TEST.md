# Bitmask Raster Test (BMR)

Status: experimental, isolated test scene. This is not Nanite, geometry streaming, or a demonstrated performance improvement. It tests candidate collection using 32-bit atomic OR and a separate per-pixel visibility resolve. Three.js supplies geometry and camera math; custom WGSL supplies rasterization.

## Contract

A candidate bit identifies a triangle in a tile-local table, not a neighbouring pixel. Each pixel owns four 32-bit masks, representing up to 128 candidates in its 8×8 tile. Bits accumulate with atomic OR during coverage collection. A later dispatch gives one invocation exclusive ownership of each pixel, selecting its closest candidate and writing separate `r32float` depth and `r32uint` triangle-ID textures. No 64-bit atomics or packed depth/ID value is required. ID `0xffffffff` means background; background depth is 1. Valid samples use conventional WebGPU depth [0, 1]. Exact depth ties choose the smaller global triangle ID.

## Passes and data

1. Clear tile counts, pixel masks and diagnostic counters.
2. Project source triangles and bin their screen-space bounding boxes into 8×8 tiles. Append with atomicAdd. Store the first 128 IDs; retain the uncapped count for overflow detection.
3. Run one invocation per retained tile candidate. Test pixel centres in the tile, using positive-area winding and a top-left edge rule. For covered samples, `atomicOr(mask[pixel * 4 + slot / 32], 1u << (slot % 32))`.
4. Resolve one invocation per pixel. Scan set bits, look up their triangle IDs, recompute interpolated depth, and select the depth/ID pair. Write both textures once. Output writes do not race because each pixel has one owner.
5. If the tile's count exceeds 128, that pixel instead scans every projected source triangle. This deliberately slow correctness fallback includes candidates absent from the mask. Overflow is visible in the UI and diagnostic view; it is never treated as a speedup.
6. Present triangle colors, triangle IDs, depth, mask population, or overflow tiles through a fullscreen hardware triangle. The compute-written depth texture is not a hardware depth attachment and is not yet composited with the forest.

Storage: source and projected triangle records (64 bytes each per triangle); tile counts (4 bytes/tile); tile candidate IDs (512 bytes/tile); coverage masks (16 bytes/pixel); depth (4 bytes/pixel); IDs (4 bytes/pixel); validation mismatch image (4 bytes/pixel); uniform and counter buffers. There is no full per-pixel triangle list beyond the four masks. Internal resolution is selectable and reported; FPS is frame cadence, not GPU timing or a comparison with the forest.

## Synchronization and lifetime

Clear, project/bin, coverage, resolve and optional validation are distinct compute passes in an ordered command buffer. No same-dispatch cross-workgroup barriers or spinlocks are used. The project/bin pass does not consume another invocation's projected data; it only publishes IDs. Coverage consumes those records in the following pass. Masks remain unchanged during resolve.

A separate optional GPU reference dispatch ignores bins/masks and exhaustively tests all projected triangles. It compares depth and ID against the just-resolved textures from the same frame, then records mismatch count and pixels. This shares the coverage function, so it checks bin/mask/resolve correctness rather than independently proving raster edge rules; CPU edge-rule tests cover those separately.

Small statistics use asynchronous readback with one pending request maximum. Rendering does not await readback. A busy readback causes statistics to be skipped, not a stalled frame. Resizing and changing test cases invalidate stale readback results. Validation runs once on demand and pauses motion so its mismatch view remains meaningful.

## Test cases

- Torus knot: a rotating Three.js mesh, with drag/touch rotation and flat diagnostic colors.
- Bit 31: 32 overlapping triangles; triangle 31 is nearest. CPU tests explicitly exercise bit 31; GPU bin order is arbitrary, so the winning ID need not occupy slot 31. Together the masks exercise all 32 positions.
- Overflow: 160 overlapping triangles. Every covered pixel must select triangle 159 despite only 128 stored candidates.
- Equal depth: identical triangles at equal depth; global ID 0 must win regardless of candidate order.
- Shared edge: two triangles forming a square; their shared edge must have exactly one owner and no gap.

All source geometry is static and opaque. Controlled camera distance and scene bounds keep all vertices within near/far clip planes; partially clipped input is not supported in this milestone. Offscreen x/y portions are handled through clamped tile bounds. Degenerate triangles are ignored. There are no textures, transparency, multisampling, temporal reconstruction, checkerboarding, worker decoding or streaming in this test. Those require separate measurements and integration work.

## Acceptance criteria

- CPU reference tests preserve masks including the sign bit; duplicate OR writes are idempotent.
- Masked selection equals exhaustive selection for reordered candidates, exact ties, shared edges, empty pixels and overflow.
- All three WGSL modules parse and emit through the Naga WASM frontend in CI; this is not physical-device pipeline validation. The production build succeeds; the browser reports pipeline compilation/validation errors visibly.
- On a WebGPU device, the user-triggered validation reports zero mismatched pixels for every case and selectable resolution. Any nonzero count is a failure, never relabeled as acceptable approximation.
- Unsupported devices receive a readable error and a return link. Mobile controls remain touch-sized.
- Physical GPU correctness and performance remain unverified until those checks run on a WebGPU device. CPU tests/build alone do not satisfy that gate.

## Further experiments

Compare mask collection plus resolve against direct tile-owned exhaustive resolve and hardware rasterization with identical geometry and resolution. Measure GPU times, candidate density, memory and overflow separately. Only then investigate checkerboard shading, streamed pages and worker preprocessing. This design does not create multiple GPU queues or eliminate transfer bandwidth costs.

## Forest integration: Bitmask Raster

The main forest now offers **Geometry → Bitmask Raster · forest**. This uses the existing hierarchical LOD and meshlet culling front end for the same terrain/tree assets, instances, camera and error threshold. All selected terrain/tree triangles are rasterized in compute. The ordinary terrain/tree hardware draws are hidden in this mode; large triangles and near-plane crossings do not switch back to hardware rasterization.

The forest path differs from the small isolated test:

- Triangles are read directly from GPU-selected meshlets and GPU instance matrices; there is no per-frame CPU triangle readback or expanded projected-triangle buffer.
- A homogeneous near-plane clip produces a triangle or quadrilateral. Pixel coverage uses a fan with the top-left edge rule. Far-depth samples are rejected and offscreen bounding boxes are clamped to the viewport.
- A global linked-list pool bins candidates into 8×8 tiles. It reserves up to 8,388,608 entries (64 MiB), limited by the device's storage-binding capacity.
- Each tile workgroup consumes its list in **32-triangle batches**. Triangle invocations atomically OR bits into workgroup-local masks; after a workgroup barrier, pixel owners resolve those masks. Each pixel retains its nearest depth/ID/color across every batch. Dense tiles have no 32- or 128-triangle hard cutoff.
- If the list pool is exhausted, marked tiles scan all selected triangles in software, in the same batches. This preserves raster-stage coverage but can be extremely slow. Counters report scan tiles. Existing upstream meshlet visible-list overflow is separate and still reports dropped geometry explicitly.
- Full viewport resolution is retained. Outputs are separate r32float depth, r32uint ID and rgba16float color textures, totaling 16 bytes/pixel. There is no full-screen mask buffer in this path; the 64 masks per tile live in workgroup memory.
- Shading uses per-triangle averaged source vertex colors/normals, simple hemisphere/directional lighting and exponential fog. It does not reproduce Three.js MeshStandard shading exactly. Geometry/LOD/normals visualization remains available.
- Three.js renders the existing lake and sky, then a fullscreen depth-tested composite places the computed forest color/depth over them. Hardware handles presentation and water, not terrain/tree triangle visibility.
- One submitted software frame is allowed in flight. Queue completion is observed asynchronously; JS/input does not synchronously wait. Skipped submissions are excluded from the frame-cadence counter. Statistics readback remains asynchronous.

The bridge uses the pinned Three.js 0.185.1 backend's initialized StorageBufferAttributes and StorageTextures. Changes to Three's backend internals will require revalidation. The bin/raster kernels use 11 storage-buffer bindings and the raster kernel writes 3 storage textures, within the app's requested limits. Raster workgroup memory is below 16 KiB.

Additional tests cover near-plane intersections (including exact endpoints), batch winner persistence beyond 128 candidates, WGSL parsing/emission, disabled hardware geometry draws and submission pacing. Physical-device rendering, water depth composition, queue behavior and performance remain unverified in the hosted workspace. This is an experiment, not a performance claim or a streaming implementation.


### First forest optimisation pass

The first optimisation experiment caches covered sample depths in an 8 KiB workgroup array. Each triangle invocation writes its own sample slots; only mask-marked slots are read after the barrier. This removes the second edge/depth evaluation during mask resolution. A further 256-byte array publishes each pixel's winning depth from previous batches, so samples already proven hidden skip cache writes, mask atomics and resolution. Equal depths remain eligible for deterministic ID ties.

Lighting runs once for each final covered pixel, after all batches. Triangles entirely in front of the near plane bypass the clipping loop. Global covered-pixel and batch counters are aggregated per tile and updated only on asynchronous statistics sampling frames (at most twice per second). Overflow accounting remains active every frame. Total raster workgroup storage is about 12.2 KiB, below 16 KiB; higher shared-memory use can reduce occupancy on some GPUs, so speed must be measured on the target device.

The original forest WGSL is retained as `forestReferenceShaders.js`. Open `?bitmaskReference=0` for the optimised path or `?bitmaskReference=1` for the original shader. Both links start in the forest's Bitmask Raster mode with the same initial camera and device-selected density/resolution. The geometry readout identifies the variant after the first statistics readback. Use matching controls and allow asset building to finish before comparing FPS; alternate runs to account for phone heating. Neither path changes LOD thresholds, source geometry, viewport resolution, software overflow fallback or the one-frame queue limit.

The user reported approximately 30 FPS on a phone before this pass. No post-change device speedup is claimed. CPU regression tests compare cached resolution against exhaustive resolution across multiple batches, reversed candidate order, depth ties, shared edges, uncovered pixels and stale cache slots; both WGSL variants pass Naga parsing/emission. These tests do not replace device shader validation or visual comparison.


### Second experiment: triangle-owned coverage masks

Device feedback: the original shader ran approximately twice as fast as the first optimisation experiment. That is a regression; the original is restored as the default. Increased workgroup memory (about 12.2 KiB vs 3.9 KiB) and retained winner data are plausible contributors, but the individual causes have not been GPU-profiled.

`?bitmaskVariant=owned` selects a different calculation path, based on the original shader rather than the cache experiment:

1. Each triangle invocation calculates coverage and packs the tile's 64 pixel bits into two private u32 words.
2. Each invocation publishes those two words once to its own workgroup slot. Triangle setup and coverage happen in the same invocation, eliminating one workgroup barrier per batch. Coverage needs no atomic OR and no pixel-mask clearing.
3. After a barrier, pixel invocations read the corresponding bit from each active triangle's mask and assemble a private 32-bit candidate mask.
4. Pixel owners use the original depth interpolation, depth-range rejection, tie handling and shading code to resolve candidates. The coverage pass omits depth interpolation; it may conservatively mark a sample beyond the far plane, which the resolve pass rejects.

This restores roughly 3.9 KiB workgroup storage, with no sample-depth cache or retained final-winner triangle. Bin lists, near-plane clipping, overflow scans, statistics, source assets, LOD and resolution use the original behavior. The trade-off is up to 32 shared mask-word reads per pixel per batch. Removing atomics and redundant interpolation may help, but these extra reads may still lose on some GPUs. No faster FPS is claimed until measured.

Use `?bitmaskVariant=original` and `?bitmaskVariant=owned` for matching initial forest/camera comparisons. `?bitmaskVariant=cached` preserves the first experiment, and the old `bitmaskReference=0/1` URLs retain their meaning. The readout names the active variant. Tests cover mask transposition over both 32-bit words, stale slots after a partial batch, ties, far-depth rejection and reversed candidate orders. Naga parses/emits all three shaders. Device execution and performance of the new shader remain unverified here.

### Frame scheduling and presentation experiments

The forest controls now include a Raster experiments section, available in Bitmask Raster mode. Original WGSL remains the shader default. Selection batching and skipping unused hardware draw arguments are enabled by default; the queue limit remains one and intermediate presentation remains enabled. Each change is independently selectable without changing geometry or resolution.

- `frames=1|2`: strict maximum number of submitted frames awaiting queue completion. Lowering the limit waits for existing frames to retire before admitting more. Promise failure also releases the counter. Queue writes/copies are ordered after earlier submitted consumers; diagnostics buffers are not reused while mapped. This is CPU/GPU submission overlap on the existing queue, not multiple GPU queues.
- `batch=0|1`: separate dispatch submissions versus a stable Three compute-node array containing tree clear/cull then terrain clear/cull. Dispatch dependencies retain their original order. With batching enabled, selection uses one compute submission instead of six.
- `skipArgs=0|1`: include or omit each asset's hardware draw-argument kernel. Software raster uses GPU visible counts directly, so these arguments are unused. Original full/hierarchy hardware rendering is unchanged.
- `direct=0|1`: intermediate HDR target plus final copy, or sky/water and depth-tested forest composition directly to the screen. Direct presentation removes one render pass and final texture copy. It keeps the existing sky/water and per-pixel forest depth. Tone mapping moves to the screen materials. Canvas MSAA and output precision can differ from the single-sample half-float target, so direct mode remains experimental pending device visual comparison. HZB is disabled for the forest already; this does not silently remove active occlusion history.
- `profile=0|1`: optional GPU timestamps sampled at most twice per second, with one readback pending at a time. Feature support is checked on the actual device. Binning/raster timestamps are inside their compute passes. Selection, sky/water, composition and final-copy measurements use GPU boundary markers and include queue gaps; they are not pure shader times. Profiling adds submissions and can perturb FPS. With direct presentation the screen-copy interval is just adjacent boundary markers, not useful work.

The readout separately reports CPU submission time, median/p95 submitted-frame intervals over up to 120 frames, skipped animation callbacks, queued frames and supported GPU intervals. These are not display presentation or input-latency measurements. Ignore initial compilation and loading, and allow the sample window to refill after camera/control changes. Toggle timing off for final FPS comparison. Settings changes reset the frame window and skip counter.

For a repeatable comparison, reset the camera and keep the same density, pixel ratio, shader and output mode. Start with `?bitmaskVariant=original&frames=1&batch=0&skipArgs=0&direct=0`, then change one control. Test two queued frames first, then skip arguments, then batching, then direct presentation. Check moving-camera responsiveness, water intersections, silhouettes and colours as well as FPS. No target-device speedup or direct-presentation parity is claimed from CPU tests.


### Independent geometry and rasterizer controls

The former combined Bitmask geometry option has been removed. Geometry now selects Full resolution / Patch LOD / Hierarchical LOD; Rasterizer selects Hardware / Bitmask compute. Bitmask remains forest-only. Existing variant comparison links retain hierarchical geometry by default; append `geometry=full` for full-detail software rasterization.

Full-detail software uses the patch asset's level-zero meshlets and compiles out the LOD-selection loop entirely. It does not rely on setting the screen-error threshold to zero. Level zero retains the source triangles; group/meshlet frustum and optional cone culling still operate. Visible-list capacity is allocated for every original meshlet instance, with an explicit device-buffer-limit error instead of a hidden LOD-sized cap. Binning uses a two-dimensional dispatch when the list exceeds the device's per-dimension workgroup limit. Software-only pipelines allocate a three-vertex hardware placeholder instead of a source-scene-sized dummy vertex range. Rasterizer changes rebuild GPU pipelines while preserving the camera and cached CPU assets.

The tile-list pool remains bounded; overflow still triggers the existing exhaustive software scan and is reported. Full-detail forest compute is a stress experiment, not a promised speedup. Hardware Full resolution uses original indexed instances; the compute path uses the same triangle geometry with simplified shading. Tests generate the full-detail culling shader without a threshold uniform and verify source level-zero triangle counts and the minimal hardware placeholder. Device execution/performance remain to be measured.
