# @pmndrs/upscaler

[![npm](https://img.shields.io/npm/v/@pmndrs/upscaler?color=cb3837&label=npm)](https://www.npmjs.com/package/@pmndrs/upscaler) [![live demos](https://img.shields.io/badge/demos-live-7dd3fc)](https://pmndrs.github.io/upscaler/) [![license](https://img.shields.io/npm/l/@pmndrs/upscaler?color=blue)](./LICENSE)

AMD FidelityFX Super Resolution (FSR) brought to **three.js `WebGPURenderer`** as raw **WGSL compute passes**, with an interactive test bench.

Three ships an official [`FSR1Node`](https://threejs.org/docs/#FSR1Node) — spatial-only upscaling. This package goes further: three's WebGPU renderer already produces every temporal input FSR2/3 needs (depth, per-pixel motion vectors via the `velocity` node, jitterable projections), so we can run a **temporal** upscaler — the architecture behind FSR 2/3, DLSS, and XeSS — which reconstructs detail spatial upscalers can't, and anti-aliases for free.

> **WebGPU only.** The passes are hand-written WGSL dispatched straight on the renderer's `GPUDevice` — no TSL, no WebGL fallback. This is deliberate: the goal is a performance-first pipeline with sources that read like the FidelityFX originals.

## Install

```bash
npm install @pmndrs/upscaler three
```

WebGPU only — needs a WebGPU-capable browser (Chrome/Edge 113+) and `three` **r186+** (a peer dependency). r184/r185 still work but are deprecated — the TSL node warns once and falls back to the pre-r186 render-pipeline hooks; that fallback will be removed. There is no WebGL fallback.

**▶ Live demos: [pmndrs.github.io/upscaler](https://pmndrs.github.io/upscaler/)** — 11 interactive examples: spatial vs temporal, the aliasing-torture scene, transparency + reactive masks, the composable TSL node, SSGI/SSR upscaled in one post graph, and more.

## Using the upscaler

The recommended integration is the **TSL node** — drop it in as the output of a `THREE.PostProcessing` graph and it renders your scene at a reduced resolution and upscales it back, jitter and all:

```ts
import * as THREE from 'three/webgpu';
import { upscaleScene, QualityMode } from '@pmndrs/upscaler';

// The upscaler remains linear/HDR. Choose presentation independently.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const post = new THREE.PostProcessing(renderer);
post.outputNode = upscaleScene(scene, camera, { quality: QualityMode.Quality });

renderer.setAnimationLoop(() => post.render());
```

That's the whole thing — no manual jitter, MRT, or velocity wiring. `upscaleScene` renders the scene _in-graph_ as an FSR input, so the sub-pixel jitter lands on it and you get real reconstruction (not just a smart blur).

**Composing with other effects.** If you already render a reduced-resolution G-buffer feeding SSGI / SSR / GTAO, feed those texture nodes to the composable `upscale()` node and it upscales the composited result — the scene, effects, and upscale are one post graph:

```ts
import { pass, mrt, output, velocity } from 'three/tsl';
import { upscale } from '@pmndrs/upscaler';

const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, velocity }));
scenePass.setResolutionScale(0.5); // render at half res per axis
// …composite your SSGI/SSR onto the reduced-res color here…

post.outputNode = upscale(
    composedColor,
    scenePass.getTextureNode('depth'),
    scenePass.getTextureNode('velocity'),
    camera,
    { ratio: 2, reactive /* optional mask */, exposureTexture /* optional */ },
);
```

Color-only input with no motion data? `upscaleSpatial(color)` runs the spatial (FSR1) path — no history, no depth/velocity. The [live demos](https://pmndrs.github.io/upscaler/) cover every node path (examples 07–11).

### Low-level API

When you are **not** in a post-processing graph — compositing in your own render-target loop — drive the imperative `Upscaler` directly. (`UpscalePass` bakes this exact MRT/jitter/velocity/present recipe into a renderer-agnostic drop-in if you want it done for you.)

```ts
import { Upscaler, QualityMode } from '@pmndrs/upscaler';
import { velocity, mrt, output } from 'three/tsl';

const upscaler = new Upscaler({ renderer });
upscaler.init();
upscaler.configure({
    displayWidth: canvas.width,
    displayHeight: canvas.height,
    qualityMode: QualityMode.Quality, // renders at 1/1.5 res per axis
    path: 'temporal',
});

// Scene render target: color + velocity MRT at *render* resolution.
const rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
    count: 2,
    type: THREE.HalfFloatType,
    depthTexture: new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight),
});
// Motion vectors must be jitter-free — feed the velocity node the upscaler's
// unjittered projection (stable instance, refreshed per frame).
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

//* Per frame
upscaler.beginFrame(camera); // applies sub-pixel jitter (setViewOffset)
renderer.setMRT(mrt({ output, velocity }));
renderer.setRenderTarget(rt);
renderer.render(scene, camera);
renderer.setRenderTarget(null);
renderer.setMRT(null);
upscaler.endFrame(camera); // clears the jitter offset

upscaler.dispatch(
    { color: rt.textures[0], depth: rt.depthTexture, velocity: rt.textures[1], deltaTime },
    camera,
);
// upscaler.outputTexture is a display-resolution linear/HDR texture. Present it
// through the renderer's normal output transform or continue post-processing it.
```

Runtime knobs live on `upscaler.settings` (`sharpness`, `maxAccumulation`, `exposure`, `debugView`) and take effect next frame. `upscaler.resetHistory()` drops accumulation on camera cuts.

## How it works

### Why temporal upscaling works

Each frame the projection is offset by a sub-pixel **jitter** (Halton(2,3) sequence, `8·ratio²` phases — at 2× upscale, 32 frames sweep 32 distinct sample positions per pixel). A static scene therefore delivers a _super-sampled_ image over time; the upscaler's job is to integrate those samples — and to know when **not** to (movement, disocclusion, shading change), falling back to spatial reconstruction there.

### The pipeline

```
                       render res                                    display res
              ┌──────────────────────────┐              ┌────────────────────────────────┐
   depth ────▶│ dilate                   │              │                                 │
   velocity ─▶│  nearest-depth 3×3       │─ motion ────▶│ accumulate                     │
              │  motion + linear depth   │─ depth ─┐    │  jitter-aware Lanczos2 upsample │
              └──────────────────────────┘         │    │  Catmull-Rom history reproject  │──▶ history
              ┌──────────────────────────┐         │    │  YCoCg variance clip            │      │
   history ──▶│ depth clip               │◀────────┘    │  disocclusion-weighted blend    │      ▼
   depth  ───▶│  disocclusion mask       │─ mask ──────▶│                                 │   ┌──────┐
              └──────────────────────────┘              └────────────────────────────────┘   │ RCAS │──▶ output
                                                                                              └──────┘
```

1. **Dilate** — per render pixel, find the nearest depth in a 3×3 ring and take _that_ texel's motion vector (foreground silhouettes drag their motion), storing linearized view depth.
2. **Depth clip** — reproject into last frame's dilated depth; when the previous surface was meaningfully nearer, the pixel was occluded and its history is poisoned → disocclusion mask.
3. **Accumulate** — the core. Upsamples the current frame with a jitter-aware Lanczos2 kernel, samples history through the motion vector with a 9-tap Catmull-Rom, rectifies history against the current neighborhood's YCoCg variance box, and blends with a per-pixel accumulation counter (stored in history alpha) so fresh regions converge fast and stable regions stay smooth. Runs in invertible-tonemap space so HDR fireflies can't dominate.
4. **RCAS** — FSR's analytically-bounded contrast-adaptive sharpener counteracts the mild softness of temporal integration.

The **spatial path** (`path: 'spatial'`) is a faithful FSR1 port: EASU's edge-direction-rotated, anisotropically-stretched 12-tap Lanczos kernel, then RCAS. No history, no motion vectors — also the fallback story for content that can't produce velocity.

### Alpha

Every path upscales **RGBA**, not RGB: the input's alpha is filtered and accumulated alongside color rather than replaced with 1.0, so a transparent canvas stays transparent through the upscale and composites over the page — the same convention as three's own `FSR1Node`. EASU runs one kernel over all four channels; RCAS sharpens color and passes coverage through untouched; the temporal path resolves alpha with the accumulate pass's own jitter-aware taps and blend weight, so a coverage edge converges on the same schedule as the color it belongs to.

There is no option for it. With an opaque input (alpha 1 everywhere) every stage resolves to alpha exactly 1, so an opaque render comes out opaque; carrying the fourth channel costs a few tens of microseconds of display-resolution work.

> **Coming from 0.2:** earlier versions wrote alpha 1.0 everywhere. three's `WebGPURenderer` defaults to `alpha: true` and clears to alpha 0, so a scene with no `scene.background` (and no opaque clear color) presented through `UpscalePass` or the TSL nodes now shows the page through its empty regions — exactly what three does without the upscaler. For the old look, set `scene.background` or `renderer.setClearColor(color, 1)`, or create the renderer with `alpha: false`. (A hand-rolled present quad with an opaque material still resolves alpha to 1.) Likewise, a post graph that scales the upscaled `vec4` by a scalar — `upscale(...).mul(vignette)` — now scales alpha too; multiply by `vec4(vec3(vignette), 1)` to darken color only.

Live references: `examples/14-pathtracer-alpha` (`three-gpu-pathtracer` accumulating at half resolution behind a transparent canvas, spatial path) and `examples/15-transparent-canvas` (the temporal path, where jitter reconstructs coverage rather than just interpolating it).

Full per-pass details and deviations from the FidelityFX reference: [`src/shaders/README.md`](./src/shaders/README.md). Where and why this diverges from FSR 3.1.5, with measurements: [`PARITY.md`](./docs/research/PARITY.md).

### Integration approach

Three doesn't expose its WebGPU internals publicly, so the upscaler grabs `renderer.backend.device` and the `GPUTexture` handles behind render-target attachments (`internal/threeWebGPU.ts` documents exactly which internals we touch and throws loudly if a three upgrade changes them). Compute passes are encoded on our own `GPUCommandEncoder` and submitted between three's scene render and the presentation draw — queue order guarantees correctness with zero synchronization code. The final image lands in a three `StorageTexture` so presenting it is ordinary three code.

### Temporal guides

Dilated motion, dilated depth, and disocclusion are **frame properties, not upscaler properties** — every temporal effect upstream (SSGI/SSR temporal reprojection, denoisers, any TAA-class pass) needs them and usually re-derives worse versions privately. The upscaler publishes its internal working set as the **temporal guides** bundle (`upscaler.guides`, ordinary three textures), and the frame can be driven split so the geometry guides exist *before* the final color does:

```ts
upscaler.dispatchGuides({ depth, velocity }, camera); // right after the G-buffer
// … effects sample upscaler.guides.dilatedMotion / .disocclusion / .dilatedDepth …
upscaler.dispatchUpscale({ color, deltaTime }, camera); // finish the frame
```

An app that never upscales can run `path: 'guides'` for the geometry products alone. Reactivity is bidirectional: an explicit mask **merges** (per-pixel `max`) with the auto-generated one, and effects can write into `guides.reactive` mid-frame. The standalone `MomentsPass` rounds out the bundle — per-pixel `(E[x], E[x²])` of a configurable scalar (linear luma or YCoCg Y) over *any* float texture plus one coarse level, the statistics half an SVGF-class denoiser needs, with no beauty/exposure assumption baked in.

The same surface exists declaratively for `THREE.PostProcessing` graphs: `temporalGuides(depth, velocity, camera)` publishes the bundle as texture nodes (`guides.getTextureNode('disocclusion')`), and `upscale(color, depth, velocity, camera, { guides })` shares one computation — the guides dispatch runs as soon as the G-buffer has rendered, in-graph effects consume the products, and the upscale finishes the split frame.

Per-product contracts (format, space, resolution, latency) are documented on the `TemporalGuides` type. The former working specification is retained in the [documentation archive](./docs/archive/temporal-guides/TEMPORAL-GUIDES-SPEC.md); `examples/12-temporal-guides` (raw) and `examples/13-guides-node` (TSL) are the live references. The contract is **accepted**: an external SSGI/SVGF consumer swapped its private temporal front-end for the raw bundle and measured bit-identical still-camera stability (spec M6). The linked TSL surface is also graduated: Example 13 is built and real-GPU smoke-tested through the packed npm artifact, proving shared ownership, stable guide-node identity with ping-pong re-pointing, and steady-state split execution across the package boundary. This is package-boundary verification of the maintained reference graph, not a claim of an independent external TSL integration.

## Status

The pipeline is **feature-complete and GPU-verified**: spatial (FSR1) and temporal paths, RGBA (alpha) passthrough, luminance-stability locks, auto-exposure (+ external and host pre-exposure inputs), multi-scale shading-change detection, reactive masks (explicit + auto-generated), RCAS with opt-in denoise, imperative `UpscalePass`, the composable TSL nodes (`upscale` / `upscaleScene` / `upscaleSpatial`), and the raw + linked-TSL temporal-guides surfaces. A benchmarking program A/B-compared this implementation against source-style FSR 3.1.5 pass graphs on-GPU; its measurements and design rationale are in [`PARITY.md`](./docs/research/PARITY.md).

Deliberately **not** planned:

- **Frame generation** (the other half of "FSR3") — needs swapchain-level frame pacing browsers don't expose.
- **MSAA input** — FSR's temporal path _is_ the anti-aliaser; a multisampled input is redundant and can't bind to the compute passes.
- **Perf-only micro-optimizations** (`textureGather` tap packing, f16 arithmetic, bind-group caching) — each adds correctness risk to a core path with no image-quality gain; deferred until performance is an actual bottleneck on real content.

## Package layout

```
src/
  Upscaler.ts      — public API / pass orchestration
  types.ts             — quality modes, config, settings
  math/                — Halton, jitter sequencing, resolution presets (unit-tested)
  shaders/             — WGSL sources as TS modules + assembler (unit-tested)
  internal/            — device access, constants UBO, pass + timestamp helpers
bench/                 — Vite test bench (npm run dev)
docs/                  — design records, research, and implementation plans
```

## Develop

Clone the repo, then:

```bash
npm install
npm run dev        # interactive bench   → http://localhost:5199
npm run examples   # example gallery      → http://localhost:5300
npm test           # unit tests (GPU-free)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm run build      # library build → dist/
```

The bench (in [`bench/`](./bench/README.md)) renders an aliasing-hostile scene and lets you flip between native rendering, bilinear upscaling, FSR1 spatial, and FSR3 temporal — with quality presets, sharpness control, debug views, and per-pass GPU timings. The [example gallery](https://pmndrs.github.io/upscaler/) is what's deployed to GitHub Pages.

## Releasing

Publishing is automated — **just push to `main`**. A GitHub Action reads your [Conventional Commit](https://www.conventionalcommits.org/) messages since the last release and, if any warrant one, bumps the version, publishes to npm, pushes the release commit + tag back, and creates a GitHub Release. [GitHub Releases](https://github.com/pmndrs/upscaler/releases) are the project's changelog, with grouped Conventional Commit notes and links to the included commits and full comparison. Auth is OIDC **Trusted Publishing** (no tokens, provenance attached); `npm publish` runs the full lint/typecheck/test/build gate first.

| Commit type on `main`                     | Bump              | Example         |
| ----------------------------------------- | ----------------- | --------------- |
| `feat: …`                                 | minor             | 0.1.0 → 0.2.0   |
| `fix: …` / `perf: …`                       | patch             | 0.1.0 → 0.1.1   |
| `feat!: …` / `BREAKING CHANGE:`            | major\*           | 0.1.0 → 0.2.0\* |
| `docs:` / `chore:` / `ci:` / `refactor:` …| _no release_      | —               |

\* While in `0.x`, a breaking change bumps **minor** (not `1.0.0`) so a stray break can't cut a major. Edit [`scripts/release-version.mjs`](./scripts/release-version.mjs) to change the policy.

**Manual / prerelease override.** Set an explicit version yourself and the Action publishes exactly that instead of auto-bumping. `npm version` creates the required `v<version>` tag; push it with the existing `--follow-tags` command because the release finalizer verifies that tag at the triggering commit and never creates or moves it:

```bash
npm version prerelease --preid next   # 0.2.0-next.0
git push origin main --follow-tags    # → publishes to the `next` tag
```

Stable versions publish to npm's `latest` dist-tag and become the latest GitHub Release. Prereleases publish to the dist-tag named by their first prerelease identifier; numeric-only prereleases use `next`. They are marked as GitHub prereleases and never become latest. Stable release notes compare against the previous stable tag; prerelease notes are incremental from the previous SemVer tag.

| You set                       | Publishes to | Install                        |
| ----------------------------- | ------------ | ------------------------------ |
| `0.2.0` (stable)              | `latest`     | `npm i @pmndrs/upscaler`       |
| `0.2.0-next.0`                | `next`       | `npm i @pmndrs/upscaler@next`  |
| `0.2.0-beta.0`                | `beta`       | `npm i @pmndrs/upscaler@beta`  |
| `1.0.0-rc.0`                  | `rc`         | `npm i @pmndrs/upscaler@rc`    |

Preview the generated notes from local Git history without changing Git, npm, or GitHub:

```bash
node scripts/release-notes.mjs --tag v0.2.0
```

If npm publication and the tag succeed but release-note generation or GitHub Release creation fails, rerunning the workflow can create only the missing Release when it proves either the tag at the checked-out commit or the exact automatic-release child commit. Existing Releases are left unchanged; the repair does not infer releases from unrelated tags or npm versions, and it does not repair or rewrite tags.

## References

- [FidelityFX Super Resolution 2/3 (GPUOpen)](https://gpuopen.com/fidelityfx-superresolution-3/) — algorithm & source (MIT)
- [`ffx_fsr1.h`](https://github.com/GPUOpen-Effects/FidelityFX-FSR) — EASU/RCAS reference the WGSL ports follow
- ["Filmic SMAA / temporal reprojection" (Jimenez, SIGGRAPH 2016)](https://advances.realtimerendering.com/s2016/) — Catmull-Rom history filtering
- ["Temporal Reprojection Anti-Aliasing" (Playdead)](https://github.com/playdeadgames/temporal) — variance clipping
- three.js `TRAANode` — jitter/velocity integration pattern this package mirrors

## Credits

Built by **[Dennis Smolek](https://github.com/DennisSmolek)**. Maintained under the [Poimandres](https://github.com/pmndrs) collective.

Based on AMD's [FidelityFX Super Resolution](https://github.com/GPUOpen-Effects/FidelityFX-FSR) — this package ports its MIT-licensed EASU/RCAS shaders and follows the FSR2/3 temporal-upscaling architecture. "FSR" and "FidelityFX" are AMD's; this is an independent, unaffiliated implementation for three.js.

## License

MIT — see [LICENSE](./LICENSE). The EASU/RCAS shaders derive from AMD's MIT-licensed [FidelityFX Super Resolution](https://github.com/GPUOpen-Effects/FidelityFX-FSR); AMD's copyright notice is included in the license file.
