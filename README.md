# @pmndrs/upscaler

[![npm](https://img.shields.io/npm/v/@pmndrs/upscaler?color=cb3837&label=npm)](https://www.npmjs.com/package/@pmndrs/upscaler) [![live demos](https://img.shields.io/badge/demos-live-7dd3fc)](https://pmndrs.github.io/upscaler/) [![license](https://img.shields.io/npm/l/@pmndrs/upscaler?color=blue)](./LICENSE)

AMD FidelityFX Super Resolution (FSR) brought to **three.js `WebGPURenderer`** as raw **WGSL compute passes**, with an interactive test bench.

Three ships an official [`FSR1Node`](https://threejs.org/docs/#FSR1Node) — spatial-only upscaling. This package goes further: three's WebGPU renderer already produces every temporal input FSR2/3 needs (depth, per-pixel motion vectors via the `velocity` node, jitterable projections), so we can run a **temporal** upscaler — the architecture behind FSR 2/3, DLSS, and XeSS — which reconstructs detail spatial upscalers can't, and anti-aliases for free.

> **WebGPU only.** The passes are hand-written WGSL dispatched straight on the renderer's `GPUDevice` — no TSL, no WebGL fallback. This is deliberate: the goal is a performance-first pipeline with sources that read like the FidelityFX originals.

## Install

```bash
npm install @pmndrs/upscaler three
```

WebGPU only: you need a WebGPU-capable browser (Chrome/Edge 113+) and `three`
**r186+** (a peer dependency). r184/r185 still work but are deprecated. The TSL node
warns once and falls back to the pre-r186 render-pipeline hooks, and that fallback
will be removed. There is no WebGL fallback. See
[Compatibility](./docs/compatibility.md).

**▶ Live demos: [pmndrs.github.io/upscaler](https://pmndrs.github.io/upscaler/)**: 15
interactive examples, covering spatial vs temporal, the aliasing-torture scene,
transparency and reactive masks, the composable TSL node, SSGI/SSR upscaled in one post
graph, temporal guides, and transparent-canvas alpha.

## Quick start

The recommended integration is the **TSL node**. Make it the output of a
`RenderPipeline`, and it renders your scene at reduced resolution and upscales it
back, jitter and all:

```ts
import * as THREE from 'three/webgpu';
import { upscaleScene, QualityMode } from '@pmndrs/upscaler';

// The upscaler stays linear/HDR; presentation is the renderer's job.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
scene.background = new THREE.Color(0x10141a); // or empty regions stay transparent (see Alpha)

const pipeline = new THREE.RenderPipeline(renderer);
pipeline.outputNode = upscaleScene(scene, camera, { quality: QualityMode.Quality });

renderer.setAnimationLoop(() => pipeline.render());
```

That's the whole integration: no manual jitter, MRT or velocity wiring.
`upscaleScene` renders the scene *in-graph* as the upscaler's input, so the sub-pixel
jitter lands on it and you get real reconstruction rather than a smart blur.

| Integration | When |
| --- | --- |
| `upscaleScene(scene, camera)` | A scene, rendered through a `RenderPipeline`. |
| `upscale(color, depth, velocity, camera)` | A reduced-resolution effect graph (SSGI/SSR/GTAO) in the same pipeline. |
| `upscaleSpatial(color)` | Only a color texture: single-frame FSR1, no motion data. |
| `UpscalePass` | A plain render loop with no post-processing graph. |
| `Upscaler` | Your own render-target loop, split frames, or inputs the others don't expose. |
| `temporalGuides()` / `upscaler.guides` | Other temporal effects sharing the upscaler's motion, depth and disocclusion. |

**[Getting started](./docs/getting-started.md)** walks through each one.
**[Inputs and contracts](./docs/inputs-and-contracts.md)** specifies what color, depth,
velocity, jitter, reactive masks and exposure must contain. Most integration bugs are
contract bugs.

### Alpha

Every path upscales **RGBA**: the input's alpha is filtered and accumulated, not
replaced with 1.0, so a transparent canvas stays transparent through the upscale.
This is the same convention as three's `FSR1Node`. An opaque input comes out with
alpha exactly 1.

> **Coming from 0.2:** earlier versions wrote alpha 1.0 everywhere. three's
> `WebGPURenderer` defaults to `alpha: true` and clears to alpha 0, so a scene with no
> `scene.background` (and no opaque clear color) presented through `UpscalePass` or
> the TSL nodes now shows the page through its empty regions, exactly as three does
> without the upscaler. For the old look, set `scene.background` or
> `renderer.setClearColor(color, 1)`, or create the renderer with `alpha: false`.
> Likewise, a post graph that scales the upscaled `vec4` by a scalar, such as
> `upscale(...).mul(vignette)`, now scales alpha too. Multiply by
> `vec4(vec3(vignette), 1)` to darken color only. Details:
> [Alpha](./docs/inputs-and-contracts.md#alpha).

## Documentation

- [Getting started](./docs/getting-started.md): the integration surfaces and runtime
  settings
- [Inputs and contracts](./docs/inputs-and-contracts.md): color, depth, velocity,
  jitter, reactive, exposure, output, alpha
- [Temporal guides](./docs/temporal-guides.md): the published motion/disocclusion
  bundle and the split frame
- [Debugging](./docs/debugging.md): debug views, symptoms, real-GPU verification
- [Compatibility](./docs/compatibility.md): three.js versions, WebGPU, limitations
- [Architecture](./docs/architecture.md): the pass graph and internals, for
  contributors
- [Design rationale vs FSR 3.1.5](./docs/research/PARITY.md), and the
  [full index](./docs/README.md)

## Status

The pipeline is **feature-complete and GPU-verified**. It covers the spatial (FSR1)
and temporal paths, RGBA (alpha) passthrough, luminance-stability locks, auto-exposure
(plus external and host pre-exposure inputs), multi-scale shading-change detection,
reactive masks (explicit and auto-generated), RCAS with opt-in denoise, the imperative
`UpscalePass`, the composable TSL nodes, and the raw and linked-TSL temporal-guides
surfaces. A benchmarking program A/B-compared this implementation against
source-style FSR 3.1.5 pass graphs on the GPU. The measurements and the reasoning for
each divergence are in [PARITY.md](./docs/research/PARITY.md).

Deliberately **not** planned:

- **Frame generation** (the other half of "FSR3"). It needs swapchain-level frame
  pacing, which browsers don't expose.
- **MSAA input.** FSR's temporal path *is* the anti-aliaser; a multisampled input is
  redundant and can't bind to the compute passes.
- **Perf-only micro-optimizations** (`textureGather` tap packing, f16 arithmetic,
  bind-group caching). Each adds correctness risk to a core path with no image-quality
  gain, so they wait until performance is an actual bottleneck on real content.

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

The bench (in [`bench/`](./bench/README.md)) renders an aliasing-hostile scene and
lets you flip between native rendering, bilinear upscaling, FSR1 spatial, and FSR3
temporal, with quality presets, sharpness control, debug views, and per-pass GPU
timings. The [example gallery](https://pmndrs.github.io/upscaler/) is what's deployed
to GitHub Pages. CI is GPU-free, so changes to shaders or passes need a real-GPU run;
see [Debugging](./docs/debugging.md#verifying-on-a-real-gpu). The code layout is in
[Architecture](./docs/architecture.md).

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
