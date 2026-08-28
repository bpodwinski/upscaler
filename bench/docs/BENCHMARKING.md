# Benchmarking guide

How to measure a change in this repo, read the result, and know whether to
believe it. The other docs in this folder are *evidence* — records of specific
experiments. This one is the *manual*.

---

## TL;DR

```bash
npm run bench:alpha          # the RGBA-passthrough A/B, ratios 1, 2, 3
npm run bench:alpha:device   # the same, driven on a phone
npm run dev                  # interactive bench with a live GPU-ms readout
```

Anything past `--` overrides the defaults:

```bash
npm run bench:alpha -- --ratios 2 --blocks 8
```

---

## What the harness actually does

Two things make GPU timing hard: the GPU drifts (clocks, thermals, other
tenants), and a browser is not a quiet machine. The harness handles both by
**interleaving** rather than by measuring A and then measuring B.

Each repetition runs the pattern **A B B A**. Both configurations are measured
inside the same short window, and the symmetric ordering cancels linear drift —
if the GPU is slowly warming up, both sides absorb the same amount of it. It
also runs the pattern several times (`--blocks`) and takes the median across
repetitions, so one bad block cannot carry the result.

That is why **you cannot get a trustworthy number by running the benchmark
twice and comparing.** Two separate invocations differ in browser launch, GPU
power state, and page warmup, none of which the numbers separate from your
change. (This mistake is recorded in `NEXT-STEPS.md` §6: a two-run comparison
reported +2.6% for a change that an interleaved run measured at +5.1%.)

### The vocabulary

| term | meaning |
| --- | --- |
| **variant** | A registered pipeline configuration, by id — `alpha-rgba-v1`, `baseline`, … |
| **ratio** | Display ÷ render resolution. `2` means the scene renders at half width and half height. `1` is native-resolution AA. |
| **block / repetition** | One full A-B-B-A pattern. `--blocks 4` runs four of them. |
| **warmup** | Frames rendered and thrown away before timing starts, so shader compilation and caches are not in the sample. |
| **samples** | Timed frames per leg. More samples = tighter medians, longer runs. |
| **scenario** | A scripted camera/scene animation, `Q0`–`Q12`. See the catalogue below. |
| **noise floor** | How much the harness disagrees with *itself*. The bar your delta has to clear. |

---

## Running an A/B

Every A/B needs two registered variant ids. To see what exists, look at
`RESOLVER_FACTORIES` in `bench/src/benchmark/variants.ts`.

```bash
node scripts/run-benchmark.mjs --smoke \
  --ratios 1,2,3 --blocks 4 --warmup 240 --samples 300 \
  --variant alpha-rgba-v1 --comparison alpha-opaque-v1
```

`--smoke` is **required** for candidate A/B runs. Without it the script runs the
strict E00 baseline acceptance protocol instead — 64 runs with hard noise gates,
which is a different job and takes far longer.

A run takes a few minutes per ratio. Results land in
`bench/results/raw/E00/<timestamp>/` unless you pass `--output`.

### Registering your own variant

Three edits, all small:

1. Add the id to the union in `bench/src/types/benchmark.d.ts`.
2. Add it to `VARIANTS` in `bench/src/benchmark/config.ts` — this is the
   page-side allowlist. **Forgetting this one fails as a timeout**, not as a
   clear error: the page throws `Invalid benchmark variant` during boot and the
   script waits for an API that never appears.
3. Map it to a resolver factory in `bench/src/benchmark/variants.ts`, and give
   it a `name` in `metadata()`.

`createAlphaVariantResolver` is a good template — both of its ids are the same
production pipeline differing by one constructor flag, which is the shape you
want for a clean single-variable comparison.

---

## Reading the results

The file to open is **`abba-analysis.json`**. It is an array with one entry per
`(ratio, label)`, where label is a pass name (`accumulate`, `rcas`, …) or
`compute-sum` for the whole pipeline.

```jsonc
{
  "ratio": 2,
  "label": "compute-sum",
  "median": {
    "rows": [ { "repetition": 1, "A1": 0.74, "B1": 0.73, "B2": 0.75, "A2": 0.80,
                "meanA": 0.77, "meanB": 0.74, "comparisonDelta": 0.041 } ],
    "noiseFloor": 0.0018
  }
}
```

- `meanA` / `meanB` — mean of the two A legs and the two B legs, in milliseconds.
  A is `--variant`, B is `--comparison`.
- `comparisonDelta` — the A-vs-B difference for that repetition, as a fraction.
- **`noiseFloor`** — the harness's own A-vs-A disagreement. This is the number
  that decides whether you believe the result.

### Is my delta real?

Compare it to the noise floor:

- **≥10× the noise floor** — real. Report it.
- **3–10×** — probably real, but say so with the ratio attached rather than as a
  bare percentage.
- **<3×** — you have not measured anything yet. Add blocks and samples.

A worked example from the alpha A/B: `compute-sum` moved 5.1% against a 0.41%
noise floor (12×, solid), while `rcas` moved 27.2% against a 9.7% floor (2.8×,
believable but stated with the caveat). Same run, two very different confidence
levels — which is exactly why the floor is per-label.

### Percentages lie about small passes

A pass that costs 0.067 ms will show a huge percentage for a small absolute
change. Always look at the microseconds too. The alpha work costs a flat ~33 µs
regardless of ratio, which reads as +3.6% at ratio 1 and +5.5% at ratio 3 — the
work did not change, the rest of the frame got cheaper.

---

## Scenarios (Q0–Q12)

Scripted camera and scene animations, defined in
`bench/src/benchmark/scenarios.ts`. Performance runs use the default; capture
runs select them with `--scenarios`.

| id | name | what it exercises |
| --- | --- | --- |
| Q0 | `input-debug-validation` | Animated baseline captured through **all eight debug views**. The first thing to run when something looks wrong. |
| Q1 | `static-convergence` | Still camera, 240 frames. The convergence scenario — does a still image stop moving? |
| Q2 | `slow-aliasing-dolly` | Slow dolly across the grid floor and fence. Sub-pixel motion, worst case for aliasing. |
| Q3 | `object-motion-disocclusion` | Moving objects, so history is invalidated behind them. Disocclusion trails. |
| Q4 | `camera-motion-hold` | Orbit, then a lateral translate, then orbit again — motion that changes character. |
| Q5 | `seeded-transparency-reactivity` | Particles visible; the reactive-mask path. |
| Q6 | `isolated-screenspace-effects` | GTAO / SSR / SSGI as separate subruns, each in isolation. |
| Q7 | `in-graph-screenspace-composition` | The same effects composed in one post graph, camera moving through a room. |
| Q8 | `recurrent-denoiser-characterization` | Subruns `builtin` / `spatial` / `recurrent` — the denoiser comparison behind `DENOISING-DIRECTION.md`. |
| Q9 | `exposure-transition` | Directional light steps 3.2 → 8 at frame 60, ramps back over 120–179. Auto-exposure and the shading-change detector. |
| Q10 | `reset-cut-resize` | Hard camera cut at 60, history resets, and resizes to 1280×720 then back to 1920×1080. Lifecycle correctness. |
| Q11 | `host-pre-exposure` | Host pre-exposure steps 2.5× at 60 and ramps back. With DeltaPreExposure correct, the shading-change view stays black throughout. |
| Q12 | `cornell-still-convergence` | A consumer's Cornell-box repro: still camera, point-light shadow dither. The hardest convergence case we have. |

---

## Visual regression (capture mode)

Timing is only half of it. Capture mode renders fixed frames and diffs the PNGs,
which is how you prove a change is *visually* identical rather than merely fast.

```bash
node scripts/run-benchmark.mjs --mode capture \
  --scenarios Q0,Q1,Q3 --reloads 1 --allow-differences --review-all
```

Frames are chosen per scenario and include jitter-phase-relative picks: `P-1`,
`P`, `2*P-1`, where `P` is the jitter period. Comparing the same jitter phase
across runs is the only way to distinguish "the image changed" from "the image
is at a different point in its jitter cycle."

For convergence specifically there is a dedicated, faster tool:

```bash
node scripts/measure-convergence.mjs --scenario Q12 --ratio 2
```

It reports consecutive-frame and same-jitter-phase differences, which is the
measurement to run before and after touching anything in `accumulate.ts`.

---

## Benchmarking on a device

```bash
npm run bench:alpha:device
```

Android with Chrome only — **iOS cannot work**, because Safari exposes no
DevTools Protocol and the harness has nothing to drive.

Two ports need forwarding, and only the first is obvious:

```bash
adb forward tcp:9222 localabstract:chrome_devtools_remote   # we drive the device
adb reverse tcp:5199 tcp:5199                               # device reaches our bench
```

`run-benchmark.mjs` hardcodes `http://127.0.0.1:5199` and binds the dev server to
loopback. Without the **reverse** mapping the phone loads its own localhost, and
the run dies in a timeout with nothing useful to point at. `bench:alpha:device`
preflights the DevTools endpoint and warns if `adb reverse --list` is missing the
mapping, so you get a message instead of a hang.

Expect worse data than a desktop run, for two reasons:

- **`timestamp-query` is often unavailable** on mobile browsers. `GpuTimer`
  no-ops when it is, so the per-pass breakdown comes back empty and only frame
  time is available — noisier, and it includes the scene render.
- Driving a browser you launched yourself gives up the harness's cold-start and
  throttling controls. **Use more blocks than a local run needs.**

---

## Gotchas

- **Git worktrees read ~3× slow.** Absolute times from a benchmark launched in a
  scratchpad worktree are not comparable to repo-run records — the GPU never
  leaves its low power state. A/B comparisons *within* that environment are
  still valid; cross-environment absolutes are not.
- **A `node_modules` symlink in a worktree crashes the working-tree digest.**
  The root `.gitignore` pattern `node_modules/` does not match a symlink
  (trailing slash ≠ symlink). `.git/info/exclude` carries a slash-less entry.
- **The interactive bench reads higher than the timed runs.** `npm run dev` is
  doing more per frame than the automated protocol. Do not compare the two.
- **Register pressure does not travel.** Costs that come from ALU and register
  allocation — rather than memory traffic — behave differently on a mobile tiler
  than on desktop. Do not extrapolate a desktop microsecond count to a phone.
