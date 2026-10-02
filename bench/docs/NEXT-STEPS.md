# Post-parity adoption record (2026-07-21) — all items landed

Outcome of the parity program: no candidate bundle adopted wholesale (see
[PARITY-DECISIONS.md](PARITY-DECISIONS.md) and the consumer-facing
[`PARITY.md`](../../docs/research/PARITY.md)). Four items survived as adoption-worthy, and
**all four landed on 2026-07-21** — this document is the evidence record for
each. Nothing from the parity program remains open. Items 5+ are later
consumer-reported defects recorded in the same format.

Every item follows the same gate: `npm test && npm run typecheck && npm run lint`,
then an A/B timing + capture run
(`node scripts/run-benchmark.mjs --smoke --ratios 2 --blocks 4 --warmup 240 --samples 300 --variant <A> --comparison <B>`,
plus `--mode capture --scenarios Q0,Q1,Q3 --reloads 1 --allow-differences --review-all`).
≥5% repeatable = actionable, <3% = noise; any visual regression rejects.

## 1. RCAS input-range investigation — DONE (adopted: conditioned-space sharpening)

The measured "resolver history made RCAS 47% cheaper" was **not** a value-range
effect — production history texels are bounded [0,1). Reading the wiring showed the
cost: with `FLAG_INPUT_REINHARD`, production RCAS paid a 1×1 exposure load + a
`tonemapInvert` division + an exposure division **per tap** (5 taps/pixel); the
resolver ran with the flag off (plain loads).

- Two isolating variants were built and ABBA-timed (warm blocks, ratio 2):
  `rcas-hoisted-exposure-v1` (identical math, hoisted exposure) → **−20% RCAS**;
  `rcas-tonemap-space-v1` (sharpen the bounded tonemapped texels, invert once)
  → **−34% RCAS** (0.103 → 0.068 ms), −5.7% total pipeline compute.
- Captures Q0/Q1/Q3 + Q9 HDR stress: full-frame RMSE ≤ 1.8/255, HDR-bulb ROI
  ≤ 9/255 max — visually indistinguishable, no overshoot.
- **Adopted** as production `RCAS_SHADER`. The per-tap form is frozen as
  `RCAS_PER_TAP_SHADER` behind the `rcas-fsr315-limiter` / `rcas-fsr315-numeric`
  bench identities; the timing variants remain in the registry for re-testing.

## 2. Host pre-exposure correction — DONE (DeltaPreExposure semantics)

- Pyramid publishes host pre-exposure in the exposure texel's `.b` (1.0 when no
  `preExposureTexture` is supplied) and **meters host-invariantly** — auto-exposure
  must not chase a step the app already metered (found on GPU: without this, the
  conditioning re-adapts for ~2s after a host step and the drift reads as a
  full-screen shading change on flat regions).
- Accumulate ratio-corrects reprojected history in linear space when the host value
  changed (binding 11 = previous frame's exposure texel). Self-gating: identity
  without the input.
- Validated on the new **Q11 host-pre-exposure scenario** (bench drives the scene
  MRT color and `preExposureTexture` together; manifest updated): 2.5× step + ramp
  leaves the shading detector at baseline, never resets accumulation age, and output
  brightness tracks the drive. No-input captures are **byte-identical** pre/post.

## 3. AMD disocclusion constant — DONE (in the fused reconstruct pass)

- `DEPTH_SEPARATION_SCALE`/`DEPTH_SIMILARITY_FLOOR` guesses replaced by AMD's
  per-bilinear-tap confidence voting with the viewport/depth-scaled tolerance
  (`1.37e-5 · halfViewportWidth · max(depth)`), lifted from the GPU-verified
  candidate port. Fused single-pass structure kept (the source's atomic scatter +
  separate pass measured +30%/+22% with no visual win).
- Q3 validation: thin stable silhouette outlines, still scenes near-black, age
  resets confined to trails; finals shift RMSE ≤ 1.1/255; reconstruct pass time
  unchanged (0.035 ms at ratio 2).

## 4. Multi-scale shading-change detector — DONE

The long-standing roadmap item (the source's SPD coarse-mip detector concept)
landed as `src/shaders/shadingChange.ts`: one fused half-resolution
dispatch (an 8×8 workgroup covers a 16×16 render tile, so the 4×4/8×8 reductions are
workgroup-local) that maintains a 1-frame luma history, compares jitter-aligned
block-mean luma per scale with base + contrast-scaled noise floors, neutralizes
disoccluded texels, and feeds accumulate's `FLAG_SHADING_CHANGE` aging path (binding
12). Locks kept their self-referential break — untouched, per the documented trap.

Five GPU tuning iterations were needed (all evidence in
`bench/results/raw/E00/pre-spd-reference` + `post-spd-v*`):
1. The candidate's mean-of-per-texel-signed-ratios floored at ~0.10 still-scene
   response — the relative-difference metric weights the darker side of alias
   residue, a coherent bias signed averaging cannot cancel.
2. Jitter-delta-aligned bilinear reprojection helped but did not fix it.
3. Ratio-of-block-means (average first) collapsed the floor.
4. Disocclusion neutralization + coefficient-of-variation-scaled floors fixed
   moving-silhouette false fires.
5. Dropping the 2×2 scale (thin features flicker at that scale regardless) hit the
   full acceptance matrix: still scene at the old detector's baseline (Q1 ≈ 2 vs
   1.1), **fewer** false positives under camera motion on high-frequency content
   (Q4 worst 3.6 vs old 4.9), light steps fire as clean single-frame spikes (Q9:
   137/255 vs old 84 with a 20-frame decay tail), host pre-exposure steps quiet
   (Q11), finals within 1.6/255 RMSE of the old detector.

Cost: **0.044 ms** at ratio 2 (the candidate's two-pass form measured 0.231 ms;
5× cheaper), zero when `settings.detectShadingChanges` is off. Slow ramps
deliberately do not fire (the 1-frame comparison sees only the per-frame delta;
blend + variance clip track ramps — verified no lag/ghosting on Q9 ramp finals).

## 5. Still-scene convergence defect — DONE (2026-07-24, consumer report 3)

The first full-pipeline consumer (ssgiDev demo 16, GUIDES-HANDOFF-RESPONSE
report 3) observed visible still-camera output jitter, flickering
`Disocclusion` silhouettes, and a never-settling rolling `AccumulationAge` —
at every ratio including NativeAA, immune to every exposed knob. Reproduced
in OUR bench (Q1, capture mode — no consumer code): sustained
consecutive-frame meanAbsDiff **0.211** after 3 s settle, and — decisive —
**same-jitter-phase** diff 0.182 one period apart, so history itself churned
aperiodically, not just the benign per-phase pattern. Metrology tool:
`scripts/measure-convergence.mjs` (CDP, deterministic capture API,
consecutive + phase-locked diffs, debug-view PNGs). Three stacked defects:

1. **Reconstruct depth-clip vote starved of agreement** (`reconstruct.ts`).
   Only positive-separation taps voted OR carried weight, so at a still
   silhouette one bilinear tap straddling the previous frame's dilated-depth
   quantization (boundary lands up to a texel away per phase) became the sole
   voter → disocclusion 1.0 at edges, re-flipping with jitter phase. Fix:
   every valid tap votes (taps at/behind the surface = confidence 1) and the
   **best tap wins** (max, not weighted mean) — any tap recognizing the
   current surface means same surface; a genuine trail has every tap on the
   old occluder and still reads ~1. This supersedes the 2026-07-22 "skip,
   never veto" semantics (skipping still let lone outliers decide).
2. **Clip-magnitude history aging** (`accumulate.ts`, removed). Aging
   `sampleCount` by `clipAmount` put convergence out of reach wherever the
   converged mean sat outside one jitter phase's variance box (any contrasty
   edge; normalized by `extents` it also fired on numerically-tiny deviations
   on flat walls) — equilibrium age stayed low, alpha stayed high, the age
   view rolled forever. FSR2 never ages on rectification strength; stale
   shading is the clip's + shading detector's job.
3. **Clip write-back re-snapping converged history** (`accumulate.ts`).
   With 1+2 fixed, phase-locked diff was STILL 0.183: the blend stores the
   *clipped* history, so each phase's box re-snaps the buffer regardless of
   alpha (clip fully disabled: 0.005). Fix: `STILL_CLAMP_RELAX` — widen the
   box ×9 only at full stillness (<0.05 render-texel motion) × converged
   history × no disocclusion/shading-change/reactivity; any signal restores
   full rectification. The locks mechanism generalized softly to everywhere.

Q1 ratio 2 ladder (consecutive / phase-locked meanAbsDiff, 0–255): pre
0.211/0.182 → fix 1+2: 0.182/0.183 → +relax ×4: 0.116/0.038 → **+relax ×8:
0.112/0.018** (shipped) → rectification off (floor): 0.109/0.005. NativeAA
ratio 1: 0.081/0.003. New **Q12 cornell-still-convergence** (enclosed box,
IGN-dithered Vogel point-light shadows — the consumer's screen-anchored-
dither aggravator, camera per their repro pose): **0.024/0.012**, disocclusion
view fully black, age saturated (consumer's cornell measured 0.19–0.76; their
converging SVGF reference is 0.039). No-regression: Q3 disocclusion shows the
documented thin trailing crescents only, final ghost-free; Q4 mid-orbit final
clean (the relax fades out above 0.5 texel/frame motion). Runs under
`bench/results/raw/convergence/` (pre-fix / post-fix / exp-noclip /
exp-still8 / post-fix2 labels).

## 6. Alpha (RGBA) passthrough — DONE (2026-08-25, issue #15)

Consumer report (gkjohnson, [#15](https://github.com/pmndrs/upscaler/issues/15)):
the upscaler forces `vec4f(pix, 1.0)` in `easu.ts`/`rcas.ts`, so a transparent
canvas over page content comes back fully opaque. Not the transparency the T&C
mask ([#6](https://github.com/pmndrs/upscaler/issues/6)) is about — that one is
partially-transparent *objects* in the scene; this is the alpha of the final
buffer. #6 remains deferred and untouched.

Reproduced and fixed:

- **Where alpha lives.** The history texture's `.a` is the accumulation age, and
  moving it would change the age's reprojection filter (Catmull-Rom → bilinear) on
  the most convergence-sensitive path. So the resolved alpha goes in the **locks
  texture's spare `.a`** (previously written as a literal `0.0`), and RCAS/blit read
  it through a new binding (rcas 4, blit 5). On the bilinear and spatial paths that
  binding is the color input itself, so one branch-free code path covers all three.
- **Cost.** Zero extra fetch while locks are on: the lock path already samples
  `locksIn` at `prevUV`, and that fetch is now hoisted so alpha shares it. EASU's
  12 taps widen from `vec3f` to `vec4f`.
- **Alpha rectification** is the local 3×3 alpha range, not the variance AABB. At a
  coverage edge the jittered taps span 0..1, so the box is wide and history
  accumulates; on a flat region the box collapses and stale alpha cannot ghost.
  **Amended 2026-10-02 (PR #18 review):** the clamp now takes item 5's still-scene
  relax — `mix(clamp(h, min, max), h, stillRelax / STILL_CLAMP_RELAX)` — because a
  feature thinner than a render texel *does* have the per-phase churn the first draft
  said coverage lacked (see "Alpha still-scene convergence" below).
- **Unconditional — no option (decided in the PR #18 review).** The first draft
  shipped an `alpha` constructor option defaulting to `renderer.alpha`, with
  RGB-only builds of EASU / accumulate / RCAS / blit byte-identical to the
  pre-alpha shaders. Review (gkjohnson, then the maintainer) found the default
  backwards in practice: three's `WebGPURenderer` defaults to `alpha: true`
  (`Renderer.js`, r184–r186), so the RGBA builds already ran for nearly everyone
  and the opaque builds only ran on an explicit `alpha: false`. With alpha-1
  inputs the RGBA builds produce identical RGB and alpha exactly 1 (EASU's dering
  clamp and accumulate's alpha box collapse to [1, 1], `mix(1, 1, w)` stores 1.0
  in rgba16float, RCAS passes the center alpha, blit samples a constant 1), so the
  option bought only the ~33 µs below at the price of a second code path, an API
  surface, a linked-guides mismatch warning, and a bind-group footgun (the bench's
  `_rcasShader` overrides declared the alpha binding while the opaque `Upscaler`
  did not bind it). Removed along with the `alpha-rgba-v1` / `alpha-opaque-v1`
  bench identities and `npm run bench:alpha`; the table below is kept as the
  measured cost of carrying alpha. three's own `FSR1Node` makes the same call.

Cost — interleaved ABBA, `--variant alpha-rgba-v1 --comparison alpha-opaque-v1`
(identities since retired; see above), 300 samples/block, both sides then-current
production on the production RCAS shader:

| ratio | compute-sum (opaque → RGBA) | delta | accumulate | rcas |
| --- | --- | --- | --- | --- |
| 1 | 0.8887 → 0.9206 ms | +3.6% | +3.3% | +26.7% |
| 2 | 0.6427 → 0.6753 ms | **+5.1%** | +3.4% | +27.2% |
| 3 | 0.6006 → 0.6337 ms | +5.5% | +3.3% | +27.5% |

The absolute cost is **flat at ~33 µs** (+14.6 µs accumulate, +18.1 µs rcas):
both passes are display-resolution, so it does not scale with the ratio. The
percentage only moves because the rest of the frame gets cheaper as the ratio
rises. Noise floors: 0.3–0.4% on compute-sum and accumulate (delta is 10–15×
that, solidly real); 9.7% on rcas, where the delta is ~2.8× the floor.

**RCAS is the surprise: +27%.** Production RCAS is the cheap conditioned-space
form at 0.067 ms (NEXT-STEPS item 1), so one extra display-resolution texture
load is a large *relative* addition even though it is small in absolute terms. On
the temporal path that load genuinely hits a second texture (the locks buffer);
on the spatial path `alphaSource` is the color input itself and should be
cache-warm, which this temporal-path benchmark does not measure.

**Correction to an earlier measurement.** A first pass reported +2.6% total. That
run compared two *separate* invocations (not interleaved) and, more importantly,
used the default bench variant — which resolves to `RCAS_LEGACY_SHADER`, the
heavy per-tap form. Against that baseline the same absolute load is a small
relative cost, which understated the real figure. The table above supersedes it.

**Reproducing it.** The A/B pair was retired with the option, so this table can no
longer be re-run as-is; reproducing it would mean restoring the opaque builds on a
scratch branch. Device setup for mobile runs (CDP forward + `adb reverse` for the
bench port, and why `timestamp-query` is often missing on phones) lives in
`bench/docs/BENCHMARKING.md`. The cost is ALU and register pressure, exactly what
diverges between desktop and a mobile tiler, so do not assume ~33 µs transfers.

**Open alternative, not taken.** Putting alpha in the history texture's `.a` and
moving the accumulation age into the locks buffer would make RCAS's alpha free
(it would read the texture it already loads), removing ~18 µs of the 33 µs. It
was rejected to keep the age on its exact Catmull-Rom reprojection rather than
bilinear. The +27% figure is new evidence that this trade deserves a second look
— but only behind `scripts/measure-convergence.mjs` on Q1/Q12, since it changes
the most convergence-sensitive path in the pipeline. Do not do it casually.

GPU verification (headless Chrome + CDP, Apple Metal-3, 2026-08-25):

- **Spatial:** new `examples/14-pathtracer-alpha` — `three-gpu-pathtracer`'s WebGPU
  branch accumulating an RGBA buffer at half resolution behind a transparent canvas.
  Page content reads through the render at display resolution; forcing alpha back to
  1.0 in the same scene reproduces the reported fully-opaque canvas exactly.
- **Temporal:** transparent-canvas scene (torus knot + a thin bar), still and under
  camera motion. Silhouette pixels measured as a clean 2-pixel ramp from the page
  color into the object; no halo, no alpha trail under motion.
- **Surfaces:** raw `Upscaler`, `UpscalePass`, and `upscaleScene()` all composite.
  `UpscalePass`'s present quad needed `transparent: true` + `NoBlending` — an opaque
  material resolves alpha to 1, and a full-screen present is an overwrite, not a
  composite.
- **No regressions:** examples 01/02/03/05/09/12/13 re-captured unchanged; locks and
  accumulation-age debug views unchanged.

Frozen-identity note: the alpha-source binding was added to **every** RCAS form, so
`rcasPerTap` (and `easuSourceApprox`, which derives from `EASU_SHADER`) re-fingerprint.
Their A/B pairings stay valid — candidate and baseline gained the same plumbing — and
the new fingerprints are recorded in the two shader tests. Removing the option did not
change a byte of any RGBA shader (all eight exported EASU/RCAS/blit/accumulate strings
compared identical before/after), so every production fingerprint is unchanged by it.

**Alpha still-scene convergence (review nit, measured 2026-10-02).** The concern:
the alpha history was hard-clamped to the current phase's 3×3 alpha range with no
lock protection and no `STILL_CLAMP_RELAX`, so a feature thinner than a render texel
gets jitter phases whose 3×3 is all-0 (or all-1) and re-snaps the converged coverage
every cycle — convergence rule 2's failure, for alpha. New meter
`scripts/measure-alpha-convergence.mjs` drives `examples/15-transparent-canvas`
(sub-texel wires + knot over a zero-alpha background) with the animation frozen and
the camera still, steps frames through three's animation loop, reads the
rgba16float output texture back from the GPU, and reports per-pixel churn over two
jitter cycles. Coverage pixels (temporal-mean alpha in (0.02, 0.98) or any per-frame
swing > 0.02), 960×540, sharpness 0.8, settle 300–400; `cons` / `std` are mean
consecutive |Δα| and per-pixel temporal std-dev on the 0–255 scale, `rel` is std/mean
for alpha | for display-mapped luma (premultiplied by coverage here, so shared
coverage flicker shows equally in both):

| ratio | shading detector | alpha clamp | α cons | α std | α rel | luma rel | pixels with α swing > 0.25 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | on (default) | hard (as reviewed) | 2.877 | 3.197 | 0.033 | 0.064 | 303 |
| 2 | on | **still-relaxed (adopted)** | 2.761 | 2.986 | 0.032 | 0.063 | 301 |
| 2 | on | none (floor) | 2.747 | 2.963 | 0.032 | 0.064 | 301 |
| 3 | on | hard | 5.006 | 7.416 | 0.105 | 0.150 | 2052 |
| 3 | on | **still-relaxed** | 4.853 | 6.933 | 0.099 | 0.148 | 2026 |
| 3 | on | none | 4.268 | 5.706 | 0.072 | 0.148 | 1922 |
| 2 | off | hard | 1.562 | 1.938 | 0.018 | 0.041 | 2 |
| 2 | off | still-relaxed | 1.478 | 1.726 | 0.017 | 0.041 | 0 |
| 3 | off | hard | 3.719 | 6.632 | 0.094 | 0.133 | 1716 |
| 3 | off | still-relaxed | 3.479 | 5.713 | 0.084 | 0.131 | 1691 |
| 3 | off | none | 2.979 | 4.679 | 0.058 | 0.131 | 1594 |

Same-jitter-phase |Δα| was ≤ 0.003 in every run: the output is a settled periodic
orbit, so all of the churn is the per-phase pattern. Reading it:

- **The mechanism is real but a minority share.** Removing the clamp entirely (the
  floor) cuts alpha churn 5% at ratio 2 and 15–23% at ratio 3, where the wires
  (~0.66 render px) are genuinely sub-texel.
- **Most of the wire shimmer is shared with color, not alpha-specific.** Color's
  relative flicker is 1.4–2× alpha's in every configuration, and turning the
  shading-change detector off roughly halves alpha churn at ratio 2: the
  accumulation-age and shading-change debug views show the detector firing in
  render-space blocks along the still wires (full-contrast sub-texel geometry over an
  empty background), ageing color and alpha history together. That is the color
  path's live "shading-change tuning" landmine on this content, not something the
  alpha resolve can or should fix — left as a follow-up.
- **Adopted the still-scene relax** (the color path's own rule-2 signal): it reaches
  the floor at ratio 2 and closes about a third (detector on) to half (detector off)
  of the gap at ratio 3. It cannot close all of it because `stillRelax` requires
  converged history, which the shading detector keeps resetting on those wires.
  Motion, disocclusion, shading change and reactivity all fold into `stillRelax`, so
  everywhere the color box is at full rectification the alpha clamp is too —
  behavior under motion is unchanged. An opaque input still resolves to alpha
  exactly 1 (every term of the mix is 1). Color is untouched: Q1 2x 0.112 and Q12 2x
  0.026 consecutive (recorded 0.112 / 0.024), `measure-convergence.mjs` after the
  change. Re-measured after rebasing onto three r186.1: Q1 0.114, Q12 0.026, and the
  adopted rows above reproduce within 0.001 (ratio 2: 2.760 / 2.985; ratio 3: 4.854 /
  6.934).

Reproduce: `node scripts/measure-alpha-convergence.mjs --ratio 3 [--settings
'{"detectShadingChanges":false}']`; artifacts (summary JSON, alpha-mean and
alpha-range PNGs, the six worst pixels traced over a cycle) land under
`bench/results/raw/alpha-convergence/`. Footgun the meter documents: stepping frames
in a bare `for` loop never advances three's node frame, so the velocity node keeps
the camera's last move in every motion vector and history never settles — step
through `renderer.setAnimationLoop` instead.

**Behaviour change for consumers.** 0.2 wrote alpha 1.0 everywhere. With a default
`WebGPURenderer` (`alpha: true`, clear alpha 0) and no `scene.background` / opaque clear
color, empty regions are now transparent through `UpscalePass` and the TSL nodes —
matching three without the upscaler. Set `scene.background` or an opaque clear color
(or `alpha: false` on the renderer) for the old look. A post graph that scales the
upscaled `vec4` by a scalar now scales alpha too — example 08's `.mul(vignette)` faded
its frame edges to transparent over the page until the vignette became
`vec4(vec3(v), 1)` (caught by rendering every opaque example over a magenta page).
Flagged as a breaking change in the release notes (README "Alpha" carries the migration
note).

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.
- T&C as a distinct softer channel — revisit only on user demand with real content.
- Conditioning-exposure history correction (beyond host pre-exposure): eased
  adaptation keeps the per-frame mismatch under the shading detector's threshold;
  correcting it changes output for every auto-exposure user. Revisit with evidence.
