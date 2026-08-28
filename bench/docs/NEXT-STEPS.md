# Post-parity adoption record (2026-07-21) — all items landed

Outcome of the parity program: no candidate bundle adopted wholesale (see
[PARITY-DECISIONS.md](PARITY-DECISIONS.md) and the consumer-facing
[`PARITY.md`](../../docs/archive/research/PARITY.md)). Four items survived as adoption-worthy, and
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
- **Alpha rectification** is the local 3×3 alpha range, not the variance AABB with
  `STILL_CLAMP_RELAX`/`LOCK_CLAMP_RELAX`. At a coverage edge the jittered taps span
  0..1, so the box is wide and history accumulates; on a flat region the box
  collapses and stale alpha cannot ghost. Item 5's relax machinery exists for
  sub-texel luminance churn, which a coverage mask does not have — deliberately not
  reused here.
- **Opt-out, not opt-in.** `new Upscaler({ alpha: false })` compiles RGB-only
  builds of EASU / accumulate / RCAS / blit. Those builds are **byte-identical to
  the pre-alpha shaders** — `shaders.test.ts` pins all four fingerprints against
  the values this repo shipped before RGBA landed, so the opt-out is provably the
  old pipeline rather than a second code path that can drift. Selected at
  construction (it picks pipelines, and the opaque RCAS/blit declare no alpha
  binding, so the bind-group shapes differ). Default stays **on**: defaulting off
  would ship the reported bug.
- **Compile-time, not a runtime branch.** A `hasFlag()` around the work would be a
  uniform branch, so no divergence — but it would not recover the cost, because
  the register allocation for the wider path stays either way. Two shader builds
  do recover it (measured below).

Cost — interleaved ABBA, `--variant alpha-rgba-v1 --comparison alpha-opaque-v1`,
300 samples/block, both sides current production on the production RCAS shader:

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

**Reproducing it, including on a device.** The pair is registered in
`bench/src/benchmark/variants.ts` and wrapped in `scripts/bench-alpha.mjs`:

```bash
npm run bench:alpha                              # local Chrome, ratios 1,2,3
npm run bench:alpha -- --ratios 2 --blocks 8     # extra flags override the defaults
npm run bench:alpha:device                       # a phone over remote debugging
```

The device mode defaults to `--cdp http://127.0.0.1:9222` and preflights it,
because two things have to be reachable and only one of them is obvious:

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote   # drive the device
adb reverse tcp:5199 tcp:5199                               # device -> host bench
```

`run-benchmark.mjs` hardcodes `http://127.0.0.1:5199` and binds the dev server to
loopback, so without the **reverse** mapping the phone loads its own localhost
and the run dies in a timeout with nothing to point at. The wrapper checks the
DevTools endpoint, warns when `adb reverse --list` has no `tcp:5199`, and prints
the two commands on failure. iOS cannot work at all here — Safari exposes no CDP.

Two caveats on the numbers themselves: (1) `timestamp-query` is frequently absent
on mobile browsers, and `GpuTimer` no-ops when it is, so the per-pass map comes
back empty and only frame time is available — noisier, and it includes the scene
render; (2) the cost is ALU and register pressure, exactly what diverges between
desktop and a mobile tiler, so do not assume the ~33 µs transfers. Ratio 3 is the
interesting row for mobile, and it is already the worst percentage on desktop.
Device runs against a user-owned browser also lose the harness's cold-start and
throttling controls, so give them more blocks than a local run needs.

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
the new fingerprints are recorded in the two shader tests.

## Explicitly not planned (measured against)

- Lanczos2/bicubic history filtering (+47% accumulate, no visible win).
- Farthest depth / motion divergence signals (+30% prepareInputs, outputs unconsumed).
- Atomic depth scatter as a wholesale replacement for the fused reconstruct pass.
- T&C as a distinct softer channel — revisit only on user demand with real content.
- Conditioning-exposure history correction (beyond host pre-exposure): eased
  adaptation keeps the per-frame mismatch under the shading detector's threshold;
  correcting it changes output for every auto-exposure user. Revisit with evidence.
