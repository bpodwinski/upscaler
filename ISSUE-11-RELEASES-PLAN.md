# Issue #11 GitHub Releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task.

**Goal:** Add deterministic GitHub Releases after the existing npm publish
paths without redesigning versioning, publication, or tag ownership.

**Architecture:** A tested repository-only notes module renders grouped
Conventional Commits. Existing publish steps expose their successful version,
then one append-only finalizer verifies the existing tag, supports the narrowly
defined rerun identities, and creates or no-ops the GitHub Release.

**Tech stack:** Node 22 ESM, Vitest, GitHub Actions, `gh`, npm OIDC publishing.

## Global constraints

- Follow `ISSUE-11-RELEASES-DESIGN.md` exactly.
- Keep Path A and Path B versioning/publish sequencing unchanged.
- Do not change `scripts/release-version.mjs`.
- Do not add dependencies, `CHANGELOG.md`, PATs, npm tokens, or test releases.
- Never create, move, or force-push a release tag from the finalizer.
- Keep all automated tests CPU-only and free of npm/GitHub mutations.

## Task 1: Deterministic release notes

**Files:**

- Create: `scripts/release-notes.mjs`
- Create: `scripts/release-notes.test.mjs`

**Produces:**

- Pure SemVer parsing/comparison.
- Previous-tag selection for stable and prerelease targets.
- Conventional Commit classification.
- Deterministic Markdown rendering.
- A read-only `--tag vX.Y.Z` preview CLI.

- [x] Write failing fixtures for every notes/range rule in the design.
- [x] Run `npx vitest run scripts/release-notes.test.mjs` and confirm expected
  failures.
- [x] Implement the pure functions and argument-based Git collection.
- [x] Re-run the focused tests and preview notes for `v0.2.0`.

## Task 2: Append-only workflow finalizer

**Files:**

- Modify: `.github/workflows/publish.yml`
- Create: `scripts/release-workflow.test.mjs`

**Consumes:**

- `scripts/release-notes.mjs --tag v<version>`

**Produces:**

- Successful version outputs from both existing publish paths.
- No-op behavior when no release is due.
- Strict current-tag and direct-child repair identities.
- Existing-Release no-op.
- Stable/prerelease `gh release create` flags.

- [x] Write failing workflow contract tests for the load-bearing invariants in
  the design.
- [x] Run `npx vitest run scripts/release-workflow.test.mjs` and confirm the
  expected failures.
- [x] Add publish outputs and the finalizer without changing existing npm/tag
  sequencing.
- [x] Run focused release tests and `actionlint` when available.

## Task 3: Documentation and verification

**Files:**

- Modify: `README.md`
- Verify: all files above plus `ISSUE-11-RELEASES-DESIGN.md`

- [x] Document GitHub Releases as the changelog, Path A's tag requirement,
  prerelease behavior, preview command, and narrow rerun repair.
- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm run build`.
- [x] Run the `v0.2.0` notes preview and inspect its grouping/range.
- [x] Confirm no npm package, Git tag, GitHub Release, or remote branch was
  mutated during verification.
- [x] Review the complete diff against the design and acceptance checklist.
