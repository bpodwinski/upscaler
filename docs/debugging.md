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
| 5 | `Exposure` | Exposed scene luma reads near mid-grey overall. A dim scene (log-average below about 0.02) reads darker by design, because auto-exposure brightens at most 8× to keep highlight headroom. | All white: exposure pinned at its minimum. All black on a scene that isn't dark: invalid input luma (NaN/Inf in `color`). |
| 6 | `ShadingChange` | Black on a still, steadily lit scene; clean single-frame spikes on light changes. | Lit while still: false positives age history and cause shimmer. Toggle `detectShadingChanges` to confirm. |
| 7 | `Reactivity` | White on flagged transparents/particles, black on opaque geometry. | Empty or misaligned: the mask isn't authored, isn't passed, or isn't rendered under the same jitter as `color`. |

The per-pass reference for what each internal means is
[`src/shaders/README.md`](../src/shaders/README.md#debugging).

### Reading debug values

A debug view writes a raw value `v` (0–1) to the output texture. `UpscalePass` and the
bench present it **without tone mapping but with the renderer's output color space**, so
on an sRGB canvas `v` lands as its sRGB encoding: reactivity 0.5 reads 188/255, 1.0 reads
255. To recover `v` from a screenshot, decode the pixel with the sRGB transfer function
(188 → 0.50). Reading the output texture directly gives `v` unencoded.

Tone mapping is skipped because a tone curve remaps every reading (ACES filmic turns 0.5
into 197/255 and caps 1.0 at 227/255) and would hide clipping. The `material.toneMapped`
flag can't do this: `WebGPURenderer` ignores it and tone maps a canvas-bound frame as a
whole, from `renderer.toneMapping`. So `UpscalePass.present()` sets
`renderer.toneMapping = NoToneMapping` for the debug draw alone and restores it.

On a TSL node, the `RenderPipeline` owns the output transform, so set
`renderer.toneMapping = NoToneMapping` yourself while a debug view is on and restore it
afterwards. The pipeline picks the change up on its next `render()`
(`examples/11-node-reactive` does this).

## Symptoms

| Symptom | Likely cause |
| --- | --- |
| Black output | MRT attachment count doesn't match the MRT outputs (a `count: 2` target rendered without the `velocity` output); attachments not named `'output'`/`'velocity'`; or a temporal `upscale()` node with no depth/velocity, which warns once. |
| Smearing or trails under camera motion | Velocity not jitter-free, or jitter applied to an input that wasn't re-rendered under it (use `jitter: false` for such inputs). Check `MotionVectors` first. |
| Ghost streaks off moving silhouettes over an SSGI-lit surface | A known cost of SSGI's rotating sample pattern (`useTemporalFiltering`, on by default and in examples 06/09), shelved for the fused GI work ([#7](https://github.com/pmndrs/upscaler/issues/7)). `useTemporalFiltering = false` trades it for a fixed hatch that accumulation can't remove; see [Jitter](inputs-and-contracts.md#jitter). |
| Thin features (wires) boil on a still camera over a noisy effect, and toggling `lockThinFeatures` / `detectShadingChanges` barely helps | The effect input is re-noised every frame (a denoiser whose kernel rotates aperiodically, such as `recurrentDenoise({ accumulate: false })`), so accumulation can only average it down. Use a fixed-kernel denoiser (`DenoiseNode`; issue #17 measured it converging on SSGI's static pattern), or raise `maxAccumulation`. A reactive mask makes it worse. See issue [#17](https://github.com/pmndrs/upscaler/issues/17) and bench scenario Q14. |
| Transparent objects or particles ghost | No reactive mask; see [Reactive masks](inputs-and-contracts.md#reactive-masks). |
| Page shows through empty regions | Expected since alpha passthrough: set `scene.background` or an opaque clear color; see [Alpha](inputs-and-contracts.md#alpha). |
| Frame edges fade to transparent | A post graph scales the upscaled `vec4` (alpha included) by a scalar; multiply by `vec4(vec3(v), 1)`. |
| HDR highlights in a dark scene clip to one value, or small lights of very different brightness read alike in the linear output | The conditioning exposure is too high for the highlights; the temporal output resolves only up to about `999 / exposure`. Auto-exposure caps at 8. Check any fixed `exposure` or `exposureTexture` you supply. See [Exposure](inputs-and-contracts.md#exposure). |
| Brightness lags or trails for a moment after your app steps its own exposure | The host exposure baked into `color` isn't declared. Pass it as `preExposureTexture` (not `exposureTexture`) so history is corrected across the step. |
| Still image shimmers | Measure before tuning; see [Verifying on a real GPU](#verifying-on-a-real-gpu). Check `ShadingChange`, then `Disocclusion`. |
| `ShadingChange` lights up in blocks along thin bright features over an empty background on a still camera | Fixed for issue [#22](https://github.com/pmndrs/upscaler/issues/22): the detector's contrast floor used to read only the current frame, so a block fired whenever the jitter phase missed a sub-texel wire. If you still see it, measure it on bench scenario Q16 (`measure-convergence.mjs --scenario Q16 --shading-frames 32`). The same wires also show short `Disocclusion` dashes on a still camera; that is a known, separate effect. |
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
  scenarios. Add `--shading-frames 32` to also report how much of the frame the
  shading-change detector fires on (Q16 is its sparse-geometry stress case).
- **Lighting-drift lag:** `node scripts/measure-drift-lag.mjs --scenario Q15
  --settings '{"autoExposure":false}'` reports how many frames the output trails a
  slow, sub-detector lighting ramp against a held-light reference. This is the other
  side of the still-scene relax (`STILL_CLAMP_RELAX`); see
  [`NEXT-STEPS.md` §8](../bench/docs/NEXT-STEPS.md).
- **HDR highlight headroom:** `node scripts/measure-exposure-ceiling.mjs` reads the
  rgba16float output back exactly. The scene is emissive 0.25–64 squares in three
  sizes on a dark background, compared against native, for each conditioning exposure
  (`auto` or fixed values). See
  [`NEXT-STEPS.md` §10](../bench/docs/NEXT-STEPS.md).
- **Sub-pixel emitter retention:** `node scripts/measure-emitter-retention.mjs
  --settings '{"autoExposure":false}'` drives bench scenario Q17 and reports whether
  emitters smaller than a render pixel converge to their coverage, plus flicker and a
  switch-off ghost. See [`NEXT-STEPS.md` §11](../bench/docs/NEXT-STEPS.md).
- **Alpha convergence:** `node scripts/measure-alpha-convergence.mjs --ratio 3` reads
  the output texture back on `examples/15-transparent-canvas` (frozen, still camera).
- **Packaged TSL guides:** `npm run verify:packed-guides:gpu` builds and packs the
  library, then runs `examples/13-guides-node` against the packed artifact on a real
  GPU.
- **Benchmarks:** how to run and read A/B timing runs, the Q0–Q17 scenario catalogue,
  and device setup are in [`bench/docs/BENCHMARKING.md`](../bench/docs/BENCHMARKING.md).

Output from all of these lands under `bench/results/raw/`, which is gitignored.

When something breaks after an edit, expect failures in this order: WGSL validation
errors at pipeline creation (the console gives line and column); bind-group/layout
mismatches (a pass's bind-group entry order must match its `@binding` order); then
visual wrongness, which is what the debug views above localize.
