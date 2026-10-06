# Current path-tracer demo integration

The demo uses upstream commit
[5f0ad5154a44224ae4b6c801b65778471dabf367](https://github.com/gkjohnson/three-gpu-pathtracer/commit/5f0ad5154a44224ae4b6c801b65778471dabf367),
pinned in package.json and the lockfile. npm's published latest remains 0.0.26;
this development snapshot is 36 commits ahead of that tag.

Upstream changes include bounce-reset and compute-kernel disposal fixes, updated
upscaler ownership, improved lighting/MIS, shadow sidedness/alpha handling, and atlas
handling for render-target textures. These are cross-platform changes; they are not
all Windows-specific performance fixes.

## Optional FSR integration

The path tracer exports FSRUpscaler from three-gpu-pathtracer/webgpu. It accepts the
application's Upscaler constructor, so this demo uses this repository's source class
and does not install a separate upscaler copy.

A small spatial subclass seeds the spatial configuration before the wrapper calls
init(). That preserves the async contract and avoids compiling temporal passes that
a path tracer without motion vectors cannot use. The host explicitly awaits the
retained driver before rendering.

WebGPUPathTracer.renderSample() owns tracing, optional upscaling and presentation.
The old second present quad and manual dispatch are removed. Disabling FSR detaches
and disposes its driver; re-enabling creates a prepared driver. Page teardown disposes
the attached adapter through the path tracer and explicitly handles the detached case.

The async compute warmup from the Windows follow-up is retained for startup and
reconfiguration. The scoped TextureSource compatibility transform remains necessary
with the installed three.js version.

## Windows verification

Chrome and Edge cold/warm GPU captures render the rover with the transparent page backdrop.
These demo captures selected Intel Gen-12LP; the exposure timing below was measured
on the RTX 3060 Laptop. Cold-page logs contain only the missing favicon request.
Startup uses 15 async compute pipelines (12 path-tracer plus three spatial upscale)
and zero synchronous compute creations.

Resize/DPR and all four ratio settings pass. Four repeated FSR detach/attach cycles
retain a tracked texture count of 17 after every cycle. Switching the settled render
from five bounces to three and back passes without validation errors. The adapter is
the upstream FSRUpscaler and its active driver reports ready.

[Recorded lifecycle evidence](windows-evidence/pathtracer-current.json)

The tracked texture count is evidence for this scenario, not a proof of all buffer
lifetimes or a long-duration memory benchmark. The previous exposure runtime result
(about 43% lower pass time) remains the measured steady-state optimization from our
Windows work; startup warming and driver sharing should not be presented as a
whole-application FPS improvement.

Reproduce the lifecycle check with:
```powershell
node scripts/audit-windows.mjs --demos 14-pathtracer-alpha --exercise
# To repeat in Edge, pass --browser with the installed msedge.exe path.
```
