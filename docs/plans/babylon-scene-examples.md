# Babylon scene examples

Approved scope: port the purpose of Three examples 01, 04, 03 and 05 to Babylon
9.29.0. No spatial adapter extension, publication, commit, push or PR.

Implementation:
- Share a mesh-based Frame Graph presenter: opaque HDR color, view depth and
  linear velocity; convert depth/background and remove jitter from motion.
- Render transparency separately and derive an optional reactive mask from the
  difference between opaque and complete color.
- Render the native comparison at display resolution with an unjittered camera.
  Apply the same display transform to native and upscaled HDR images.
- Add Hello, Aliasing, Native comparison and Transparency pages to the gallery.
- Check CPU contracts, lint, types, tests, library/site builds, then production
  browser rendering, motion, masks, resizing and disabled/reactivated history.

Validation results are recorded in docs/babylon-framegraph.md after execution.

Execution ledger:
- Implemented the shared Frame Graph host and four mesh demos; kept all library
  exports unchanged. CPU uniform contract test was observed failing before implementation.
- Production GPU checks exposed Babylon's inverted RTT orientation; flipped all
  input texels together and the native reference at presentation. Verified against
  the installed 9.29 engine/shader source and added a rendered orientation check.
- Independent review found alpha could make a black texture pass the readback
  assertion. RGB-only statistics, a contrast assertion and an opaque-black CPU
  regression test now cover this case. No deferred review findings.
- Chrome / RTX 5080: all four demos passed motion, mask, reset, disabled/reactivated,
  odd-size, NativeAA and alias-optimization checks; desktop/mobile captures inspected.
- Final validation: lint, typecheck, library build and Pages-base site build passed;
  591 tests in 39 files passed. The release-workflow fixtures inherited global GPG
  signing on the first run; the successful rerun used process-only
  `GIT_CONFIG_COUNT=2`, `commit.gpgsign=false`, `tag.gpgsign=false`. No Git
  configuration was changed. Gallery: 26 working cards, 27 built HTML pages.
- No repository commit, push, PR or publication performed.

## Second batch

User requested the next examples. Implemented four further adaptations:
Three 02 → Babylon 23 (spatial/temporal), 08 → 24 (composition), 11 → 25
(authored reactive coverage), and 15 → 26 (transparent canvas).

- Extended the Babylon task with optional spatial/bilinear paths, leaving
  temporal as the default. CPU tests first failed on the unnecessary depth
  requirement, then passed with color-only non-temporal recording and zero jitter.
- Shared color task handles RTT orientation and post-upscale vignette composition.
  Spatial comparison uses a separate unjittered low-resolution scene render.
- Authored coverage reuses opaque depth and a pass-specific white material.
- Canvas presentation preserves reconstructed alpha through HDR/display conversion.
- Independent review found no concrete defects; added canvas readback and mask
  captures to supplement output-texture checks.
- Lint/typecheck, library/site builds and three isolated packed-package consumers
  passed. Full suite: 593 tests in 39 files, with process-only GPG overrides for
  temporary release fixtures. GPU results are documented in babylon-framegraph.md.
- Commit, push, PR and deployment remain under the user's control.
