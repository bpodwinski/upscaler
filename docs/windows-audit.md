# Windows audit and improvement roadmap

2026-10-06 — [issue #82](https://github.com/pmndrs/upscaler/issues/82), [draft PR #83](https://github.com/pmndrs/upscaler/pull/83).
Baseline: v0.4.0 / bfb343c. Startup implementation: 3d018e1.

## Result and measurements

Default temporal startup now creates eight async pipelines, spatial creates three,
and guides-only prepares two geometry pipelines. Debug and disabled shading-change
passes remain lazy. Two-instance split comparison fell from 20 synchronous creations
to eight shared async creations. Shader math and temporal exposure behavior are preserved.

Machine: Windows 11 Home build 26200, NVIDIA RTX 3060 Laptop GPU
(driver 32.0.15.9200), Chrome 154.0.8037.98; Edge 154.0.4258.53 for cross-checks.
Three fresh-profile runs and matching reloads produced these Example 01 medians:

| Metric | v0.4.0 cold | Async cold | v0.4.0 warm | Async warm |
| --- | ---: | ---: | ---: | ---: |
| GPU-main compute-pipeline API time | 1647.425 ms | 2.077 ms | 152.924 ms | 0.958 ms |
| Synchronous creations per page | 10 | 0 | 10 | 0 |
| Async creations per page | 0 | 8 | 0 | 8 |
| Largest rAF gap | 2563.6 ms | 1024.2 ms | 121.2 ms | 78.7 ms |

Dawn traces place upscaler DXC compilation and
`CreatePipelineAsyncEvent::InitializeImpl` on `ThreadPoolForegroundWorker`.
The short async creation API calls remain on `CrGpuMain`. Render-shader DXC work
still appears on `CrGpuMain`, explaining residual first-frame stalls.

This measures removal of compute compilation from the GPU main thread, not an
equivalent reduction in total compile work or steady-state GPU cost. First queue
submission is not first visible presentation; awaiting preparation changes that metric.
The exposure shader was the largest compute compile in the cold trace. Its 32×32
sampling loop warrants a separate experiment, not an unmeasured math rewrite.

Final startup runs used fresh profiles and ran sequentially on the same adapter.
Earlier overlapping source-snapshot runs produced shared-Vite-cache warnings and
are excluded from timing conclusions. Startup timings were recorded separately from
the short steady-state candidate smoke runs.

Evidence:

- [Startup samples](windows-evidence/startup-summary.json)
- [Chrome/Edge demo results](windows-evidence/demo-results.json)
- [Resize/DPR/control checks](windows-evidence/transitions.json)
- [Moments and real device-loss checks](windows-evidence/primitives.json)
- [Candidate GPU smoke](windows-evidence/candidate-smoke.json)
- [160-file source inventory](windows-evidence/inventory.json)

The inventory labels review/test coverage; it does not claim every branch was exercised.
Screenshots and full traces are retained as local audit artifacts. Compact evidence is committed.

## Verification and coverage

The Windows validation runtime is isolated Node 22.23.3 / npm 11.5.1.
Lint, typecheck, library build, gallery build, packed-consumer build and portable
Vitest suites passed. The portable run contains 472 tests, including guides-only, retry and specialization
metadata cases.
[Ubuntu CI](https://github.com/pmndrs/upscaler/actions/runs/37443315942) passed the full
suite and build. Packed Chrome verification confirmed 16 ordered split frames,
two ping-pong textures, and zero monolithic fallbacks.

| Area | Status | Evidence / limits |
| --- | --- | --- |
| Core lifecycle, cache, math, timers | Verified | Unit coverage for sharing, four-slot cap, failures/retry, disposal, jitter and optional activation; production GPU rendering. |
| TSL / temporal guides | Verified | Linked package consumer, stable node identity, ordered split dispatch, resize/rebuild checks. |
| MomentsPass / device loss | Verified | Real moments dispatch; disposable GPU device changes readiness true→false and explicit preparation rejects after destruction. |
| Production WGSL | Verified | Assembly/structure tests plus the production demo sweep. Shader math is unchanged. |
| Three candidate bundles | Verified smoke | Filter, structural and SPD bundles completed four ABBA runs each on Q1, ratio 2, 30 warmup and 30 sampled frames; zero browser validation errors. Not a new quality/performance ranking. |
| Other experimental shaders / probes | Untested GPU coverage | Source and applicable string/CLI tests reviewed; every variant/scenario was not rerun. |
| Packaging | Verified | Direct npm CLI invocation, old-npm archive-name fallback and Windows junction; build-only and packed GPU checks pass. |
| Release-workflow harness | Reproduced failure | Native Windows run had 60 failures in 63 existing cases; YAML parsing assumes LF, executable shims/PATH assume POSIX. Ubuntu full CI passes. |
| Browser discovery | Static concern | Existing GPU tools search Mac/Linux paths; explicit browser paths work on Windows. |
| Teardown | Static concern | One exploratory browser startup timed out. Windows process-tree/profile cleanup needs stress coverage. |
| Workflows | Static concern | Verification is Ubuntu-only. Publishing was not dispatched. |

All 20 Chrome demos (01–16 and S1–S4) rendered in cold/warm captures without
upscaler validation errors, exceptions or device loss. Most cold pages requested a
missing favicon; that 404 is separated from rendering failures.

Edge also rendered 01, 06, 07, 13, 15 and 16. Resize and DPR changes were exercised on
02, 13, 15, 16 and S4, with 32 available mode/debug selections cycled without errors.
This covers representative transitions, not every control in every demo.

Demo 14 successfully loaded its remote model/HDRI. Its upscaler creates three async
spatial pipelines, but `three-gpu-pathtracer` still creates 12 synchronous compute
pipelines and emits a `Source`/TextureSource deprecation warning. S1/S2 also contain
substantial effect/raymarch render shaders; async library compute does not eliminate
their scene startup costs. S2 also reads upscaler GPU timings without opting into GPU timing;
its upscale/total HUD remains n/a despite available render timestamps.

The local Homefig wiki index, Windows notes and TemporalResolver consumer were readable.
The newer `wiki/development/windows-shader-perf/` directory referenced by #82 was absent.
Older notes warned against unlimited compile concurrency; this library uses four slots
per device. Homefig's availability probe still constructs and disposes a throwaway
upscaler. Its migration should use the capability check and handle real preparation
failure separately. Homefig was not modified.

## Prioritized improvements

| Priority | Improvement | Evidence / impact | Proposed work and dependency | Acceptance |
| --- | --- | --- | --- | --- |
| P0 | Windows regression harness | Native release tests fail. | Normalize YAML newlines; adapt executable shims, Bash paths and PATH. Preserve Linux workflow semantics. | Intended Windows tests pass without hiding failures. |
| P0 | Windows CI | Ubuntu misses native command/path regressions. | Add Node 22/npm 11.5.1 Windows verification after harness portability; retain Ubuntu release emulation. | Fresh runner passes tests, types, lint, build and packed consumer. |
| P0 | Shared browser discovery | Ten GPU scripts duplicate Mac/Linux lists. | One Chrome/Edge resolver preserving explicit flag and CHROME_PATH precedence, including spaces. | Standard Windows installs work without manual paths. |
| P0 | Owned-process cleanup | Windows teardown differs; a startup timed out. | Verify owned process trees, wait for CDP shutdown, then retry removal of owned profiles only. | Repeated/interrupted runs leave no orphan servers/browsers, locked profiles or stale ports. |
| P1 | Homefig migration | Probe compiles unnecessarily; raw API now requires awaiting. | Replace throwaway probe; integrate readiness and preparation-error handling after #83 is released. | No probe compile; usable panes during preparation and actionable failures. |
| P1 | S2 timing HUD | Upscaler timing is off by default, while S2 reads its timing map. | Opt in to GPU timing explicitly and distinguish unsupported, warming and disabled states. | Upscale and total GPU costs populate on supported hardware. |
| P1 | Startup UI and metrics | Render compiles still stall; optional features can be pending. | Expose preparing/ready/error in hosts; measure first visible frame, preparation and GPU runtime separately. | Responsive controls and correctly labeled metrics. |
| P1 | Automated demo coverage | GPU coverage is still local. | Maintain this harness with image/readback assertions, isolated Vite caches and external-asset classifications. | Detect blank output, bad alpha/HDR, guide order and transition regressions. |
| P1 | Path-tracer upstream work | Demo 14 retains 12 dependency-origin sync creations. | Contribute async preparation and TextureSource cleanup to three-gpu-pathtracer. | Equivalent alpha/model output with no sync dependency compute calls. |
| P2 | Exposure compilation | Metering dominates compile and runs for manual/external exposure. | Measure splitting lightweight exposure publication from metering; preserve guide channels and host correction. | Lower compile cost with equivalent exposure/HDR/alpha/history readbacks. |
| P2 | Loop and variant cost | Large constant-bound loops and S2 render shaders need compiler evidence. | Inspect HLSL and timings before changing bounds/factoring; preserve deterministic WGSL. | Proven compile reduction, equivalent images and acceptable GPU runtime. |

## Reproduction and limits

Run with the CI Node/npm versions and an explicit browser executable:

```powershell
node scripts/audit-windows.mjs --browser 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node scripts/audit-windows.mjs --browser 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --demos 01-hello,06-screenspace-gi,07-tsl-node,13-guides-node,15-transparent-canvas,16-spatial-node
node scripts/audit-windows.mjs --browser 'C:\Program Files\Google\Chrome\Application\chrome.exe' --demos 01-hello --runs 3 --trace
node scripts/audit-windows.mjs --browser 'C:\Program Files\Google\Chrome\Application\chrome.exe' --demos 02-fsr1-vs-fsr3,13-guides-node,15-transparent-canvas,16-spatial-node,s4-convergence --exercise
npm exec -- vitest run --exclude scripts/release-workflow.test.mjs
npm run verify:packed-guides:gpu -- --chrome 'C:\Program Files\Google\Chrome\Application\chrome.exe'
```

The exclusion is the explicitly reported portable subset; the native Windows full
suite did not pass. Use sequential baseline/updated runs, fresh profiles and isolated
Vite caches. Trace categories are `gpu.dawn`, `gpu.dawn.validation` and `toplevel`;
attribute GPU-main time only to labeled upscaler compute API events.

Not covered: forced FXC, non-NVIDIA Windows adapters, all experimental variants,
long-duration loss/recovery, or a full Homefig integration.
