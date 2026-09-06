# Optional cluster lighting

Open [Willowmere with the cluster renderer](https://samg-coder.github.io/ThreeNaniteTest/?scene=landscape&renderer=clusters), then open Controls. **Cluster ray shadows** and **Cluster water reflections** are independent, default-off options. Reflections require the Willowmere water surface.

The compute pass reuses resident triangle and sparse-brick geometry pages. An all-instance bounding hierarchy includes off-screen geometry, then near-first traversal descends resident source hierarchies. Triangle hits interpolate source UVs; brick hits use stored material and directional foliage coverage. Existing atomic visibility, coverage and HZB recovery remain unchanged. No second full scene geometry render is added.

Shadows attenuate direct sunlight while retaining ambient illumination. Water reflections trace one planar reflected ray and blend geometry hits into the animated water shader; misses retain its analytic sky. Water ripples distort the reflection sample. These are software ray queries, not a full Unreal Nanite or Lumen implementation.

## Cost and limitations

- Effects use one-quarter width and height (one-sixteenth pixel count), sharing one compute dispatch. Unchanged camera/geometry results are reused. Both disabled means no lighting-ray dispatch, although small textures, hierarchy and pipeline resources remain allocated.
- Rays have a 200-unit range and bounded hierarchy/primitive work. Exhausted queries fall back to unshadowed sunlight or sky reflection; the HUD reports budget fallbacks.
- Secondary rays do not request additional geometry pages. Off-screen objects can therefore appear at coarse resident detail. Geometry loading, camera movement and output changes invalidate cached results.
- Sparse foliage coverage is stochastic. Coarse cells require a self-intersection bias, which can lose contact shadows. Quarter-resolution sampling can blur thin branches and leak across silhouettes.
- Reflection materials use approximate lighting and filtered source textures. There are no recursive bounces, reflected dynamic water waves, or general reflective materials. The instance hierarchy assumes the current static forest transforms.

## Validation

`npm test`, `npm run validate`, and `npm run build` cover the normal project gates. `node scripts/emulation/run-cluster-renderer.mjs --lighting` additionally creates the actual native WebGPU pipelines, checks each toggle combination, asserts both blocked and unblocked shadow samples and valid water reflection hits, and confirms zero lighting rays with both options disabled. This emulated GPU check does not predict mobile FPS.
