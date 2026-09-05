# Willowmere Valley

[Open the new test scene](https://samg-coder.github.io/ThreeNaniteTest/?scene=landscape).
It is also available under **Controls → Build Willowmere Valley**. The original
Emerald Basin forest remains available through **Build forest**.

The valley starts in **Full resolution → Visibility + atomic HZB**. It keeps
source triangles resident, rasterizes depth/triangle IDs, rejects hidden clusters
using current-frame depth and atomic coverage, and shades the winning pixels.
The default does not substitute distant voxel trees or page-cache fallback
geometry. The streaming/voxel comparisons remain selectable experiments.

The valley now uses a separate alder-style tree model: tapered curved branches,
buttress roots, serrated leaves with a raised midrib, and explicit leaf backfaces.
Leaves have real silhouette gaps rather than opaque rectangular cards. Rocks use
64 × 48 surface segments. Soil, mineral, bark and leaf detail comes from an original
1024 × 256 mipmapped procedural texture atlas, baked once at startup. These are
procedural materials, not scanned assets or photographic textures.

In the default visibility mode, smooth vertex normals and world position are
reconstructed from the winning triangle using perspective-correct barycentrics.
Material tags use the unused normal W component: the existing 48-byte vertex
format and atomic protocol remain unchanged. Texture sampling is confined to
visible pixels. Hardware comparison also uses the atlas. Older software and
streaming experiments retain their original vertex-color materials.

Fog density is now 0.0018 instead of 0.008 in geometry and water shading. At
100 world units, fog blending drops from about 47% to 3%; the distant bank remains
visible. Full-detail residency can use more memory than the streaming mode.

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
modes within the same scene and preset.

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
- The new textured, full-detail atomic path was run on software Vulkan at
  128 × 192 for three frames, including camera movement. Depth and coverage
  exactly matched unculled visibility. There were 2–5 ID/color differences per
  frame from equal-depth surface ties after draw-list reordering.
- [Current GPU result](emulation-gpu/valley-material-visibility.json). The harness
  excludes water composition and browser orchestration. The separate visual
  render covers actual Three water/sky/material shaders. Neither establishes
  phone FPS. The older paged-scene result is historical.

```sh
npm test
npm run validate
npm run build
# Native visual smoke test; writes raw 640×400 RGBA pixels.
# Requires a Vulkan adapter, e.g. VK_ICD_FILENAMES pointing to SwiftShader.
node scripts/emulation/render-landscape.mjs /tmp/landscape.rgba
# Actual scene geometry through the atomic visibility path.
node scripts/emulation/export-gpu.mjs /tmp/valley --scene=landscape --density=compact --width=128 --height=192 --geometry=full --pitch=-.09 --yaw=.856
python scripts/emulation/run-visibility.py /tmp/valley --frames=3
```
