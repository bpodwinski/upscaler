# Windows cross-device audit

This follow-up to [the initial audit](windows-audit.md) addresses the Windows part
of [issue #4](https://github.com/pmndrs/upscaler/issues/4). It is based on the draft
PR stack #83 → #84 → #85. No changes have been merged or published.

## Fixes

- Exposure captures copy GPUAdapterInfo's getter fields explicitly; serializing
  the native object had produced `{}`.
- Benchmark environment metadata now reads the rendering device's adapterInfo.
  Requesting another default adapter could report a different GPU on this laptop.
- Measurement scripts accept a power preference and expected vendor. The vendor
  is checked against the returned adapter before allocating its device. Windows
  Chrome warns that powerPreference is ignored, so the hint alone is insufficient.
- Demo 13 resizes its existing scene pass and RTT instead of rebuilding their
  identities. It disposes all owned graph products when the page exits.
- Demo 13 updates its renderer DPR, including changes arriving after a resize
  event or without a CSS-size change. Its output follows the drawing-buffer size.
- Page-exit handlers preserve pages marked as persisted, rather than disposing
  their renderer while the browser may restore the same document.
- Owned browser shutdown uses the browser CDP session, releases inherited pipe
  handles and tolerates Edge's successful launcher relaunch. The benchmark rejects
  occupied CDP ports instead of silently attaching to another process.
- Premature imperative dispatch warns once and throws a recognizable
  `UpscalerNotReadyError`, code `UPSCALER_NOT_READY`. Correctly awaited callers stay
  quiet. Ignored bare preparation rejections are observed while awaited calls still
  reject; device-loss diagnostics explain that a new working device is required.

## Verified hardware and coverage

Windows 11, Node 22.23.3; NVIDIA RTX 3060 Laptop (driver 32.0.15.9200) in Chrome
154.0.8037.98 and Intel UHD / Gen-12LP (driver 31.0.101.5333) in Edge
154.0.4258.53. Actual vendor/architecture and enabled device features are recorded.
Browser choice and GPU differ together here; this is not an isolated browser A/B.
The harness uses its own profiles and `--enable-unsafe-webgpu`.

| Area | Status | Evidence |
| --- | --- | --- |
| Adapter reporting | Verified | Getter serialization and actual-device unit coverage; vendor assertions on real devices. |
| Exposure | Verified | Three profiles per GPU, five bit-identical rgba16float readback fixtures per profile. NVIDIA retains about 44% lower pass time; Intel has no consistent runtime gain. Compile time improves on both. |
| Q12 convergence | Verified | 180 settle frames and 12 consecutive pairs, ratio 2: approximately 0.0221 NVIDIA / 0.0219 Intel, mean absolute RGB difference on the 0–255 scale. |
| Benchmark modes and debug views | Verified | Both GPUs run native, bilinear, spatial and temporal; five quality settings and all exposed debug views. Effective debug values match the selections. Zero synchronous compute creation or WebGPU validation errors. |
| Demo 13 resize / DPR | Verified | Thirty alternating size/DPR cycles per GPU retain 26 live textures, 46 buffers and eight query sets. At DPR 2, 800×600 CSS pixels produce 1600×1200 output and 800×600 input. |
| Page suspension | Verified, bounded | Built-gallery freeze/active test resumes the same document with a ready shared driver. Development-server reload trials are excluded. This is not physical OS sleep/resume. |
| Missing timestamp feature | Verified | A real NVIDIA device is requested without timestamp-query; 15 resize cycles render correctly and allocate zero query sets. |
| Fresh instance disposal | Reproduced upstream retention | Thirty cycles of four new UpscalePass instances release textures/query sets but retain six renderer binding buffers per instance, including after GC. See below. |
| Scatter and candidate timings | Smoke / noise-qualified | Sequential ABBA comparisons record their noise floors. Do not infer a Windows speed ranking where the delta fails to clear that floor. Candidate image quality was not regraded. |

NVIDIA dispatch-only timer medians were +0.24% temporal versus a 0.17% noise floor,
+0.84% spatial versus 0.55%, and +0.28% bilinear versus 7.10%. These do not clear
the guide's 3×-noise threshold. CPU encoding differences were roughly 5–10 µs.
Timing stays opt-in; these numbers do not establish a whole-application FPS gain.

[Compact evidence](windows-evidence/cross-device.json) records both completed
measurements and explicit limits. Screenshots and complete samples remain under
`bench/results/windows-local/cross-device` and `bench/results/raw`.

## Resource findings

Before the demo change, thirty resizes increased tracked live textures from
26 to 176 and buffers from 46 to 226. Disposing the abandoned targets fixes the
texture growth. Keeping scene-pass identities stable also avoids the binding
buffers retained by three's per-pass render-object cache.

A separate fresh-instance test still reproduces renderer-level retention:
46 → 70 buffers after four instances, then 766 after 120 instances. The same
pattern occurs on Intel and with timestamps disabled (30 → 390 after 60 instances).
Textures and query sets return to baseline. Weak references remain reachable after
forced GC, so this is more than a missing explicit destroy call in the counter.

This test intentionally reuses scene meshes/materials and one renderer. Three
r186.1's RenderObjects cache retains render objects for the retired target/pass
contexts; disposing their RenderTargets does not evict those objects. The library
should not evict other consumers' renderer caches or dispose shared scene materials.
An upstream lifecycle fix needs a focused reproduction and multi-consumer checks.

## Reproduce

Build the gallery before running its production lifecycle test:

```powershell
npm run examples:build
node scripts/audit-windows-lifecycle.mjs --cycles 30 --hold-seconds 60 --power-preference high-performance --expected-vendor nvidia
node scripts/audit-windows-lifecycle.mjs --cycles 15 --hold-seconds 10 --without-timestamps --power-preference high-performance --expected-vendor nvidia
node scripts/audit-windows.mjs --bench --exercise --power-preference high-performance --expected-vendor nvidia
node scripts/measure-convergence.mjs --scenario Q12 --ratio 2 --power-preference high-performance --expected-vendor nvidia --label windows-nvidia
node scripts/measure-timer-overhead.mjs --attach-only --frames 100 --blocks 12 --inflight 8 --conditions temporal:2:dispatch:none,temporal:2:dispatch,spatial:2:dispatch,bilinear:2:dispatch --power-preference high-performance --expected-vendor nvidia --label windows-nvidia
node scripts/run-benchmark.mjs --smoke --variant baseline --comparison reconstruct-cross-frame-v1 --ratios 1,2,3 --blocks 4 --warmup 60 --samples 120 --power-preference high-performance --expected-vendor nvidia
```

For the Intel runs here, use `--power-preference low-power --expected-vendor intel`
and the installed Edge executable. `--browser` selects it in the audit scripts;
`--chrome` selects it in the measurement scripts. A mismatch aborts the measurement.
Run GPU jobs sequentially and freeze source changes while measuring. A development
reload interrupted one timer trial; its incomplete results are excluded.

## Remaining priorities

1. **Renderer buffer lifetime:** upstream the retired-target reproduction. Accept
   only bounded buffers across repeated target/instance rebuilds while another
   consumer continues rendering correctly. This relates to the upstream tracker #35.
2. **DPR across the remaining demos:** audit their cached startup-DPR values and
   move shared sizing into a consistent helper. Demo 13 is verified; that is not
   proof of every demo or a physical mixed-monitor transition.
3. **Timing stability:** repeat noisy comparisons with longer warmup/sample windows
   and recorded clock/power state before adopting shader optimizations. NVIDIA P8
   at 210/405 MHz was observed during an earlier rendering hold; clocks were not
   continuously recorded for every leg.
4. **Physical Windows lifecycle:** manual sleep/resume, minimize/restore and moving
   between monitors remain untested. Check frame progress, adapter/device loss,
   drawing-buffer/output size and console errors before and after each transition.
5. **Wider adapters and compilation:** AMD, mobile tilers, forced FXC, extended
   device recovery and full Homefig integration remain outside this local matrix.

Lint, typecheck, portable tests, library artifact verification and gallery
build passed locally. The release-workflow cases run in the full CI matrix.
