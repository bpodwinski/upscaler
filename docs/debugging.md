# Debugging

Most upscaler problems are input problems: the image is wrong because a contract in
[Inputs and contracts](inputs-and-contracts.md) isn't met, not because the
accumulation math is. The debug views exist to tell those apart. Each one renders a
pipeline internal instead of the final image, and checking them in order rules out one
upstream stage at a time.

## Debug views

Set `upscaler.settings.debugView` to a `DebugView` value (or
`UpscalePass.applySettings({ debugView })`; on a TSL node, set
`node.upscaler.settings.debugView`). Debug views render on the **temporal path only**.
Check them in this order:

| # | View | Healthy | If not |
| --- | --- | --- | --- |
| 1 | `MotionVectors` | Static scene + moving camera: smooth gradients, no per-object noise. | Per-object flashing: the `velocity` node is bypassed or the MRT isn't wired, so previous model matrices aren't tracked. Motion on a still camera: velocity isn't jitter-free. |
| 2 | `Disocclusion` | Thin, stable outlines around moving silhouettes; black on a still scene. | Full-screen flashing: depth linearization is wrong. Check the camera you pass (near/far, perspective vs orthographic) and the reversed-depth setting. |
| 3 | `AccumulationAge` | Saturates to white within about a second when still; resets along disocclusion trails. | Never whitening: history isn't persisting (configure called every frame, `reset` stuck on, or the camera actually moving). |
| 4 | `Locks` | Lit on thin high-contrast features (wires, fence edges, specular silhouettes), black on flat surfaces. | All black: thin features may dim under motion. Lit everywhere: ghosting risk. Toggle `lockThinFeatures` to compare. |
| 5 | `Exposure` | Exposed scene luma reads near mid-grey overall. | All black or all white: exposure pinned at its clamp, or invalid input luma (NaN/Inf in `color`). |
| 6 | `ShadingChange` | Black on a still, steadily lit scene; clean single-frame spikes on light changes. | Lit while still: false positives age history and cause shimmer. Toggle `detectShadingChanges` to confirm. |
| 7 | `Reactivity` | White on flagged transparents/particles, black on opaque geometry. | Empty or misaligned: the mask isn't authored, isn't passed, or isn't rendered under the same jitter as `color`. |

The per-pass reference for what each internal means is
[`src/shaders/README.md`](../src/shaders/README.md#debugging).

## Symptoms

| Symptom | Likely cause |
| --- | --- |
| Black output | MRT attachment count doesn't match the MRT outputs (a `count: 2` target rendered without the `velocity` output); attachments not named `'output'`/`'velocity'`; or a temporal `upscale()` node with no depth/velocity, which warns once. |
| Smearing or trails under camera motion | Velocity not jitter-free, or jitter applied to an input that wasn't re-rendered under it (use `jitter: false` for such inputs). Check `MotionVectors` first. |
| Ghost streaks off moving edges in an effect (SSGI) | The effect rotates its own sampling pattern per frame expecting a TRAA. Disable it (`SSGINode.useTemporalFiltering = false`). |
| Transparent objects or particles ghost | No reactive mask; see [Reactive masks](inputs-and-contracts.md#reactive-masks). |
| Page shows through empty regions | Expected since alpha passthrough: set `scene.background` or an opaque clear color; see [Alpha](inputs-and-contracts.md#alpha). |
| Frame edges fade to transparent | A post graph scales the upscaled `vec4` (alpha included) by a scalar; multiply by `vec4(vec3(v), 1)`. |
| Brightness lags or trails for a moment after your app steps its own exposure | The host exposure baked into `color` isn't declared. Pass it as `preExposureTexture` (not `exposureTexture`) so history is corrected across the step. |
| Still image shimmers | Measure before tuning; see [Verifying on a real GPU](#verifying-on-a-real-gpu). Check `ShadingChange`, then `Disocclusion`. |
| No sub-pixel reconstruction from `upscale()` | Another node owns the camera view offset (warns once); or the node was built outside a `RenderPipeline` output graph (warns once). |

## Console warnings

The library warns once, rather than failing silently, in these cases:

- the color, depth or velocity input is multisampled (unsupported; disable MSAA);
- `upscale()` runs the temporal path without depth + velocity texture nodes (it emits
  nothing; use `upscaleSpatial()` for color-only input);
- another node in the pipeline already jitters the camera (`traa()`/`taau()`), so
  `upscale()` runs unjittered;
- `upscale()` was built outside a `RenderPipeline` output graph and can't jitter;
- three r184/r185 is in use, so the TSL node falls back to the deprecated pre-r186
  render-pipeline hooks;
- a `temporalGuides()` node in standalone mode is asked for a late product.

It throws on contract violations: no WebGPU device (the WebGL backend), a texture not
yet on the GPU, a temporal dispatch without depth/velocity, and the split-frame and
path misuse listed in [Temporal guides](temporal-guides.md#raw-split-frame).

## Verifying on a real GPU

CI is deliberately GPU-free: unit tests cover the jitter math, quality presets and
shader-module structure, never a device. "It builds" therefore doesn't mean "it
works". Anything touching shaders, passes or integration wiring needs a run on real
WebGPU:

- **Interactively:** `npm run dev` opens the test bench (http://localhost:5199):
  native, bilinear, FSR1 and temporal modes, the debug views, and per-pass GPU timings.
  `npm run examples` opens the gallery on port 5300.
- **Headlessly:** launch Chrome with `--headless=new --enable-unsafe-webgpu
  --remote-debugging-port=<port>` and drive it over the DevTools Protocol. WGSL
  validation errors arrive as `Log.entryAdded` events; the scripts below do this for
  you, starting their own dev server if none is running.
- **Still-scene convergence:** `node scripts/measure-convergence.mjs --scenario Q12
  --ratio 2` reports consecutive and same-jitter-phase frame differences plus
  debug-view PNGs on a deterministic bench scenario. Q1 and Q12 are the reference
  scenarios.
- **Alpha convergence:** `node scripts/measure-alpha-convergence.mjs --ratio 3` reads
  the output texture back on `examples/15-transparent-canvas` (frozen, still camera).
- **Packaged TSL guides:** `npm run verify:packed-guides:gpu` builds and packs the
  library, then runs `examples/13-guides-node` against the packed artifact on a real
  GPU.
- **Benchmarks:** how to run and read A/B timing runs, the Q0–Q12 scenario catalogue,
  and device setup are in [`bench/docs/BENCHMARKING.md`](../bench/docs/BENCHMARKING.md).

Output from all of these lands under `bench/results/raw/`, which is gitignored.

When something breaks after an edit, expect failures in this order: WGSL validation
errors at pipeline creation (the console gives line and column); bind-group/layout
mismatches (a pass's bind-group entry order must match its `@binding` order); then
visual wrongness, which is what the debug views above localize.
