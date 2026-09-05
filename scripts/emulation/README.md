# Forest emulation

This tool replays the actual generated forest assets, not a substitute low-poly scene. It has two levels:

1. `node scripts/emulate-forest.mjs --out=docs/emulation-spawn --pitch=-.05` builds the pinned meshoptimizer assets, emulates selection, projection, clipping, tile lists, mask batches and depth/ID resolution, and reports work counts. Default: 256 trees, full geometry, 384×704, deterministic initial camera with supplied pitch. All pixels are compared across variants; six pixels are also checked by exhaustive triangle scanning. `--pitch=.55` tests the canopy. `--order=reverse` changes serial insertion order. `--geometry=auto|hierarchy` exercises LOD selection with original visible-list caps. Output JSON contains exact settings and source hashes; PPMs show triangle IDs, not material rendering.
2. `node scripts/emulation/export-gpu.mjs /tmp/forest-gpu` exports the real full-detail forest at 160×288 and deterministic CPU-selected meshlet lists. `VK_ICD_FILENAMES=/path/to/vk_swiftshader_icd.json python scripts/emulation/run-swiftshader.py /tmp/forest-gpu` executes all actual raster entrypoints on an installed software Vulkan adapter via Python `wgpu`. The adapter must identify itself as CPU. No native browser or hardware presentation is emulated.

The tested environment uses wgpu 0.32.0 and SwiftShader packaged in @sparticuz/chromium 149.0.0. These are optional developer tooling, not browser dependencies. SwiftShader exposes only 10 storage buffers/stage; the harness concatenates terrain/tree Vertex arrays and rewrites only the second array lookup offset/removes binding 5. The raster math and entrypoints are unchanged. Original and adapted WGSL are saved separately with source hashes. Adapter limits are respected rather than overridden.

`--stats=1` enables diagnostic counters for a controlled instrumented run. `--dispatch=visible` dispatches only the supplied visible-list count instead of maximum capacity; it is a harness experiment, not a renderer modification or a claim that CPU readback should drive production dispatch. An eventual renderer implementation should generate indirect dispatch arguments on the GPU.

The CPU model is deliberately memoized to finish in useful time: repeated shader setup is counted, not physically re-executed. Work counts describe logical shader operations, not cache misses, memory bus bytes or cycle estimates. GPU parallel insertion order, FMA/rounding, register allocation, warp scheduling and Android drivers are not simulated. The model aborts if its tile pool overflows; exhaustive overflow scanning remains covered by existing small correctness tests, not full-scene emulation. Pipeline presentation/lighting/UI are audited, not reproduced by the CPU model. Six exhaustive probes supplement whole-image cross-variant comparison; they do not prove equivalence to hardware rasterization.

Software-adapter timestamps are real measurements of a CPU implementation of the shader. They are **not phone GPU timings**. Each variant includes a warmup execution followed by a measured execution. Shader compilation time is reported separately. Inspect depth/ID mismatches; a fast result with wrong visibility is a failure.

The harness-only `--empty-bounds` switch inserts a conservative empty-pixel-centre bounding-box test before bin allocation. Compare checksums against the unmodified run, not just between the two modified variants. The CPU equivalent is `--empty=1`. Neither option changes the deployed renderer.


One way to obtain the tested optional software driver without system installation:

```sh
npm install --prefix /tmp/forest-gpu-tools @sparticuz/chromium@149.0.0
```

The package contains `bin/swiftshader.tar.br`. Decompress with Node's `brotliDecompressSync` and extract with `tar --no-same-owner` into a local directory. Set `VK_ICD_FILENAMES` to that directory's `vk_swiftshader_icd.json`. Install Python `wgpu==0.32.0` in your preferred environment. No Chromium launch is required. The usual Chromium helper also extracts fonts and may attempt ownership changes; this harness only needs the driver archive. Do not infer a phone GPU's properties from this CPU adapter.
