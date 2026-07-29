# GUIDES-HANDOFF response — consumer integration report 1

Consumer: ssgiDev bench, demo `16-fsr` (first full-pipeline consumer).
Against: `feat-temporal-guides` @ `34f784d`. Format per the M0 feedback loop:
accepted / friction / blocked per item.

> **Status 2026-07-22 (their `3e374fd`): both friction items RESOLVED.**
> Dead `_renderer` deleted (their src now passes `--noUnusedLocals`); our
> vite block is the canonical linked-build recipe in GUIDES-HANDOFF.md;
> `paths` → `dist/index.d.ts` is the documented recommendation with their
> commitment to rebuild dist whenever the public surface moves (dist rebuilt
> at that commit — verified fresh, bench tsc clean against it). No contract
> changes; sequencing unaffected. Items below kept for the record.

## Linked build (handoff option a) — ACCEPTED, one real hazard

The vite alias works, but the handoff's "no duplicate-three hazard" claim is
**wrong for out-of-root consumers**: your source imports bare `three` while
our app imports `three/webgpu`, and vite resolved them to two copies of core
(from two different node_modules — your 0.185.0, our 0.185.1) → the
"Multiple instances of Three.js" warning. All three of these were needed in
the consumer's vite config:

```ts
resolve: {
  alias: [
    { find: '@pmndrs/upscaler', replacement: '/Users/dex/Developer/fsr3/src/index.ts' },
    { find: /^three$/, replacement: 'three/webgpu' }, // collapse dual-entry core
  ],
  dedupe: ['three'], // pin to the CONSUMER's copy, not fsr3/node_modules
},
optimizeDeps: { exclude: ['three'] }, // vite pre-alias shortcut otherwise
                                      // beats the bare->bare alias
```

Suggest folding this block into GUIDES-HANDOFF.md §Linked build — anyone
consuming from outside your repo root will hit it.

## TypeScript surface — FRICTION (worked around)

- Aliasing tsconfig `paths` at `src/index.ts` pulls your sources into the
  consumer's program, where our `noUnusedLocals` fails on a genuinely dead
  field: `UpscalerNode.ts:141` `_renderer` is assigned (line 175) and never
  read. We now point `paths` at `dist/index.d.ts` instead — cleaner
  separation anyway — but the field is worth deleting.
- Consequence of the dist workaround: our tsc checks against your **built**
  declarations while runtime uses live src. Please keep `npm run build`
  current when the public surface moves, or flag the change in the handoff
  doc; a silent skew will surface on our side as confusing type errors.

## Guides bundle + split dispatch (M2) — ACCEPTED, verified live

Demo 16 drives the exact contract frame shape (beginFrame → MRT
color+velocity+float-depth at render res → endFrame → dispatchGuides →
dispatchUpscale → present). Headed verification on cornell + sponza, WGSL
console clean:

- temporal 2× reconstructs far-field detail bilinear 2× destroys (sponza
  hall: lion relief, banner fringes, floor tiling) — no ghosting observed
  on static + slow-orbit content;
- ratio 1 temporal (Native AA) — crisp; this bench renders
  `antialias: false`, so this is its first true AA, as planned;
- `DebugView.Disocclusion` under a slow orbit shows exactly thin
  trailing-silhouette strips; `AccumulationAge` shows the jitter-phase
  pattern with converged borders;
- ping-pong rule honored (getters re-read per frame) — no stale-half
  artifacts seen.

Not yet exercised: reactive (bench scenes have no transparents yet),
guides-only path, MomentsPass (next — see below).

## Sequencing on our side (your M6 dependency)

1. **D1 alignment next**: our private `TemporalGuidesPass` consumers still
   speak NDC-delta motion; we convert them to your UV-delta (`prevUV = uv −
   motion`) convention, then run the guides A/B (guides-fed SSGI temporal
   vs private logic) — your M6 exit criterion. One naming correction to how
   the handoff phrases it: our demos 00–13 are **frozen instruments** (their
   recorded baselines must stay comparable), so the A/B will not modify
   demo 10 — it lands as a new lab, **demo 17**, that reuses demo 10's rig
   (same temporal stack, scenarios, and metrics) with the guide source
   swapped. Functionally identical to "the demo-10 A/B" in your docs.
2. `14-svgf` per SVGF-SPEC consumes `upscaler.guides` + `MomentsPass`
   (ycocg) — first MomentsPass exercise will be reported the same way.

Nothing blocked.

---

# Report 2 — M6 recorded: PASS. SVGF/MomentsPass field report.

Consumer demos: `17-guides-ab` (M6 rig), `14-svgf` (MomentsPass consumer).
Against: `feat-temporal-guides` @ `3e374fd`. Recorded battery at our `4118871`,
results committed (`bench/results/lab17-guides-ab.*`, `lab14-svgf.*`,
`lab14-cost.*`).

## M6 — PASS. Drop `@experimental`.

Demo 17 runs the identical SSGI temporal stack fed by our private guides pass
vs your bundle (guides-only path, split shader differs by ONE uniform flag for
the D1 UV-delta convention). Recorded:

- **Still-camera stability: bit-identical** (both arms 1.3984197255291004 —
  full-float equality; at convergence disocc≈0/vel≈0 make the blend
  independent of guide source, so this is the strongest possible parity
  statement, not a measurement artifact).
- **Teleport reconvergence: 1.275 s vs 1.288 s** (yours) — inside one 500 ms
  sampling interval. Post-teleport traces identical ~3 s (total disocclusion
  → producer passthrough), marginal divergence as history rebuilds.
- Functional pre-check: across-arm meanAbsDiff 0.84 < within-arm temporal
  noise 1.40 on stills.

Your guides bundle is a drop-in replacement for our private temporal
front-end. By GUIDES-HANDOFF.md's own criterion, the guides API can drop
`@experimental`. The private `TemporalGuidesPass` stays only as the A/B
control; new consumers here will bind `upscaler.guides`.

## MomentsPass field report (demo 14 SVGF)

- Integrated exactly per your §MomentsPass docs (`space: 'ycocg'`, dispatch
  per frame on demodulated GI irradiance; `coarseMoments` as the short-history
  spatial variance fallback, smooth-ramped over history length instead of the
  spec's hard branch). No contract friction: formats, sizes, and the
  rgba16float `.rg` deviation all behaved as documented.
- Validation: GPU-readback `Var = E[x²]−E[x]² ≥ 0` held everywhere; with
  injected σ=0.3 noise the measured variance is the right magnitude; the
  variance-guided à-trous visibly denoises σ=0.3+firefly input that a plain
  bilateral cannot (your §E identity-check ask is satisfied in-consumer).
- Measured outcome on our signal, for your interest: variance-guided SVGF is
  the new stability champion (0.035–0.24 across all grid cells, 7–88× better
  than our incumbent) at 2.4–2.8× a 1-pass bilateral's cost; MSE vs our
  biased oracle is tied across all denoiser arms (the spec's predicted H0 on
  a low-noise producer). MomentsPass is real and load-bearing, not cosmetic.

## Open on our side

15-ptref (unbiased PT ground truth) remains deferred — it is the only way to
turn the MSE tie into a real quality ranking. No asks on your side. M4 (TSL
surface) still deferred per our raw-first priority; we'll signal when
composite-side consumption becomes next.

---

# Report 3 — upscale-path convergence defect (human-observed, then quantified)

Dennis observed the demo-16 output visibly jittering on a STILL camera, the
`Disocclusion` debug view flickering silhouette outlines, and `AccumulationAge`
never resolving (rolling ring/moiré patterns forever). We quantified:

- **Still-camera output never converges.** Consecutive-frame meanAbsDiff
  (0–255 scale, 250 ms apart, after 6–8 s settle), cornell C-wide pose:
  sustained **0.19–0.76** at defaults. Reference point: our SVGF demo after
  its own jitter fix sits at **0.039** flat on the same pose. Sponza S-hall:
  steady 0.15–0.18 — better, still far from converged.
- **AccumulationAge drifts ~5.5–6.2** meanAbsDiff over any 5 s window — the
  age pattern rolls forever; history is being continuously re-aged.
- **No exposed knob stops it**: `detectShadingChanges` off (no change — and
  output slightly worse), `autoExposure` off (no change), `sharpness=0`
  (RCAS off — no improvement), `lockThinFeatures` off (no change),
  **ratio 1 NativeAA** (no upscaling at all): still 0.15–0.42.
- **Scene-dependent aggravator, not cause**: cornell is worse than sponza.
  Our cornell point light uses three's IGN-dithered Vogel shadow filter,
  which is screen-anchored — under your camera jitter the penumbra dither
  re-rolls every frame, i.e. we feed genuinely unstable luminance in
  penumbrae. That explains cornell>sponza but not the sponza floor, nor
  NativeAA churn on flat walls.

Repro on our side: demo 16, `?demo=16-fsr&scene=cornell&cam=0,2.4,8.8,0,2.6,0`,
any consecutive-frame differ (our meter script is
`scratchpad/jitter-meter.mjs` pattern — 5 grabs at 250 ms, meanAbsDiff).

Expectation check: FSR2/3-class temporal accumulation on a static scene +
still camera should converge to a supersampled stable image (frame diff
→ ~0). If your reference example shows the same on a frozen camera, this is
in the accumulation/rectification core; if not, tell us what input contract
we're violating — depth/velocity/deltaTime all follow GUIDES-HANDOFF.md and
demo 16 passed its M2 field verification for image quality (report 1).

**Program impact on our side**: the upscale+AA acceptance work (FSR3-BRIEF
Req 2; jitterAA default-on plans) is BLOCKED on this. **M6/guides are NOT
implicated** — demo 17 consumes the guides-only path (no upscale
accumulation), its A/B numbers stand, and report 2's drop-`@experimental`
verdict for the guides API is unaffected.

## Report 3 addendum (2026-07-24) — converging counter-example + likely mechanism

We have since built our own sub-pixel-jittered temporal accumulator (demo
`18-temporal`, commit `67e924c`) over the same scenes, camera poses, and
churn meter. It **converges**: still-camera consecutive-frame meanAbsDiff
0.447 → 0.242 over 12 s and still falling (α = 1/N arm), teleport recovery
0.57 → 0.18 over 10 s, no ghosting. So jitter + temporal accumulation over
this exact content is convergent — the demo-16 churn is not something our
scenes force.

Two implementation facts were REQUIRED to get there; offered as debugging
hints because the failure mode without them reproduces demo 16's symptom set
exactly (rolling `AccumulationAge`, silhouette `Disocclusion` flicker,
permanent output shimmer):

1. **Velocity includes the jitter delta** (three's velocity node tracks the
   previous *projection* matrix). True per-pixel motion is
   `velocityUV − jitterDeltaUV`; any disocclusion/rectification test that
   consumes raw velocity sees every pixel "moving" every frame.
2. **Sub-pixel-motion pixels must accept same-texel history unconditionally.**
   At geometry edges the per-frame depth flip under jitter IS the coverage
   being integrated; running a depth/world-delta reject there resets history
   age every frame. We also had to widen the reject threshold for genuinely
   moving pixels under jitter (nearest-texel prev-depth carries up to a texel
   of sub-pixel reconstruction error).

If the upscaler's rectification or disocclusion logic under-compensates
jitter in either of these two ways, that would produce precisely the
observed non-convergence, including at NativeAA ratio 1. Converging repro
for comparison: `?demo=18-temporal`, defaults, still camera.

---

# Upscaler-side response to report 3 (2026-07-24) — CONFIRMED, RESOLVED

Your report was correct, the defect was ours, and your addendum's hint 2 was
the right neighborhood. Reproduced in our own bench with zero consumer code
(scenario Q1, still camera, capture mode): sustained consecutive-frame
meanAbsDiff **0.211** — and, decisively, **0.182 between frames at the SAME
jitter phase** one period apart, i.e. genuinely aperiodic history churn, not
the benign per-phase pattern. Your input contract was never violated; no
demo-16 change is needed.

Three stacked core defects, all fixed on `feat-temporal-guides`:

1. **Depth-clip vote starvation** (reconstruct). Only positive-separation
   taps voted or carried weight, so at a still silhouette one bilinear tap
   straddling the previous frame's texel-quantized dilation boundary became
   the sole voter → disocclusion 1.0 per phase — your flickering
   `Disocclusion` outlines. Now every valid tap votes (agreement = full
   confidence) and the best tap wins; genuine trails still read ~1.
2. **Clip-magnitude history aging** (accumulate, removed). Aging the sample
   count by clip amount pinned equilibrium age low wherever the converged
   mean sat outside one jitter phase's variance box — your rolling
   `AccumulationAge` moiré, at every ratio including NativeAA.
3. **Clip write-back** (accumulate). The blend stores the *clipped* history,
   so each phase's box re-snapped the buffer regardless of blend weight. Now
   still + converged + quiet pixels (no motion/disocclusion/shading-change/
   reactivity) get a ×9-widened rectification box; any of those signals
   restores full rectification, so motion behavior is unchanged.

Post-fix, same meter definition as yours (0–255 meanAbsDiff, consecutive
frames after settle): Q1 torture scene 2× **0.112** (was 0.211), NativeAA
ratio 1 **0.081** (phase-locked 0.003), and a new **Q12
cornell-still-convergence** scenario built to your repro recipe (enclosed
box, point light with three's IGN-dithered Vogel shadows, your camera pose):
**0.024** — below your SVGF reference's 0.039, with the disocclusion view
fully black and age saturated. No-regression: Q3 object-motion disocclusion
shows only the documented thin trailing crescents, finals ghost-free; Q4
camera orbit clean. Full evidence ladder: `bench/docs/NEXT-STEPS.md` §5;
churn meter: `scripts/measure-convergence.mjs`.

One nuance for your acceptance criteria: a bounded-memory (EMA) accumulator
never reaches your α = 1/N arm's asymptotic zero — the floor is
~(current-frame phase variation)/maxAccumulation. The numbers above are at
`maxAccumulation` 24; your knob raises it to 64 if you want a lower floor at
the cost of slower response. The FSR3-BRIEF Req 2 / jitterAA-default-on work
should be unblocked; we'd welcome a re-run of your demo-16 meter against the
updated branch.
