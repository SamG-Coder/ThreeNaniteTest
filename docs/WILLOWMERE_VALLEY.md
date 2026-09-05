# Willowmere Valley

[Open the new test scene](https://samg-coder.github.io/ThreeNaniteTest/?scene=landscape).
It is also available under **Controls → Build Willowmere Valley**. The original
Emerald Basin forest remains available through **Build forest**.

The valley starts in Full resolution with the streaming/coverage-voxel renderer:
GPU cluster selection, resident page fallback, atomic visibility masks,
current-frame HZB recovery and final-visible-pixel shading. Trees retain the
foliage coverage correction and one-pixel voxel error limit. Grass is actual
blade geometry merged into the terrain asset, so it participates in the same
selection, paging and visibility path. It is not an extra alpha-card draw.

The scene includes rolling terrain, a shaped lake basin, a dirt route around
the bank, granite outcrops, high-detail shared trees and grass concentrated around
the shore. The spawn faces across the lake. Existing touch joystick, swipe-to-look,
jump and desktop controls remain in use. The water is not swimmable: collision
uses the terrain height along the actual shoreline rather than one large circle.

| Density | Trees | Grass clumps | Terrain segments |
| --- | ---: | ---: | ---: |
| Compact | 80 | 7,000 | 192 × 192 |
| Dense | 160 | 16,000 | 320 × 320 |
| Extreme | 320 | 30,000 | 448 × 448 |

Each grass clump has four bent blades with real front/back triangles. Grass is
static in this version. Density controls change the workload, so compare renderer
modes within the same scene and preset. Streaming fallback may temporarily or
persistently reduce detail when the requested geometry exceeds the cache.

## Water and sky

The water uses a dedicated Three.js TSL shader with four animated wave components,
analytic ripple normals, depth-dependent shallow/deep color, Fresnel reflection
of the procedural sky, a sun highlight, shallow-bed light patterns and animated
shoreline foam. A depth attribute derived from the terrain clips the water to the
bank and attenuates waves near shore. The water mesh has 35,840 triangles.

Sky reflection is analytic; it does not reflect trees or render the scene a
second time. The apparent shallow-bed effect is procedural, not refracted scene
geometry. Water stays an ordinary opaque shaded surface in the existing
sky/water composition pass, outside the geometry triangle statistics. These
choices keep the experiment bounded; they are not a full fluid simulation.

The sky uses a horizon gradient, procedural clouds and a sun lobe. Sky and water
use the existing forest fog color and lighting direction for a consistent view.
No external textures, model downloads or new runtime libraries are required.

## Validation

- Terrain/grass indices and normals, tagged tree foliage, exact sampled ground
  heights, dry spawn and shoreline collision are tested.
- Actual generated water and sky vertex/fragment WGSL compiles under Dawn/Tint.
- The Three.js water/sky shaders and comparison geometry were rendered through
  Dawn/SwiftShader at 640×400 and visually inspected.
- The compact valley's paged atomic visibility path was exercised at 128×192,
  including camera movement and distant coverage geometry. Depth, coverage,
  triangle IDs and colors matched the unculled reference in all three frames.
- [GPU result](emulation-gpu/valley-visibility.json). This harness excludes water
  composition and browser orchestration; the separate visual render covers the
  actual water/sky shaders. Neither test establishes phone FPS.

```sh
npm test
npm run validate
npm run build
# Native visual smoke test; writes raw 640×400 RGBA pixels.
# Requires a Vulkan adapter, e.g. VK_ICD_FILENAMES pointing to SwiftShader.
node scripts/emulation/render-landscape.mjs /tmp/landscape.rgba
# Actual scene geometry through the atomic visibility path.
node scripts/emulation/export-gpu.mjs /tmp/valley --scene=landscape --density=compact --width=128 --height=192 --geometry=full --voxels=true --pitch=-.09 --yaw=.856
node scripts/emulation/export-paged.mjs /tmp/valley /tmp/valley-paged
python scripts/emulation/run-visibility.py /tmp/valley-paged --frames=3
```
