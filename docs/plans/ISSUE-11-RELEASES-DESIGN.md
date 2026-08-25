# Issue #11 — GitHub Release Design

Status: implemented on `feat-github-releases` and verified against the
acceptance checklist below.

Issue: [#11 — Auto-release publishes to npm but creates no GitHub Release or changelog](https://github.com/pmndrs/upscaler/issues/11)

## Decision summary

Add a small, append-only GitHub Release finalizer to the existing npm publish
workflow.

- Keep the current Path A and Path B versioning, publication, and tag ordering.
- Generate deterministic notes from Conventional Commits.
- Use GitHub Releases as the changelog; do not add `CHANGELOG.md`.
- Require Path A's existing `npm version` tag; never create or move tags.
- Mark prereleases as prereleases and never as latest.
- Let a rerun repair only a strictly identified release where npm and the tag
  succeeded but the GitHub Release is missing.
- Do not redesign the existing npm/tag recovery model under this issue.

## Problem

The publish workflow currently produces an npm package and, on the automatic
path, a `v<version>` tag. It does not create a GitHub Release. A consumer
looking at GitHub therefore sees version tags without an actionable summary of
features, fixes, performance changes, or breaking changes.

The repository also has no `CHANGELOG.md`. Adding one inside the current
workflow would require changing the release commit or adding another commit
after publication. That is unnecessary when GitHub Releases can be the
canonical changelog.

## Current workflow

### Path A — explicit version or prerelease

1. `package.json` already contains a version that npm does not have.
2. The workflow publishes that version as-is.
3. Stable versions use the `latest` npm dist-tag.
4. Prereleases use their SemVer prerelease identifier (`next`, `beta`, `rc`,
   and so on); numeric identifiers use `next`.
5. The documented operator flow uses `npm version`, then pushes `main` with
   `--follow-tags`, so `v<version>` should already point at the triggering
   commit.

### Path B — automatic Conventional Commit release

1. The package's current version already exists on npm.
2. `scripts/release-version.mjs` scans commits since the latest `v*` tag.
3. `feat` produces a minor bump; `fix` and `perf` produce a patch; breaking
   changes produce a major, capped to minor while the package is `0.x`.
4. `npm version` creates the release commit and tag.
5. npm publishes the package.
6. The workflow pushes the release commit and tag to `main`.

The selected design starts after these existing responsibilities. It does not
change their policy or sequencing.

## Goals

- Create one GitHub Release for each npm release from either path.
- Produce useful, deterministic notes from the same repository history used
  to decide releases.
- Distinguish stable releases from prereleases correctly.
- Make GitHub Release creation safe to retry.
- Keep the implementation small enough to audit from the workflow.
- Keep all tests CPU-only and free of npm/GitHub mutations.

## Non-goals

- A tracked `CHANGELOG.md`.
- Replacing the current workflow with Release Please, Changesets,
  semantic-release, or another release manager.
- Changing Conventional Commit bump policy.
- Changing npm publish ordering or the release commit.
- Repairing an npm publish that succeeded before its tag/commit was pushed.
- Reworking the existing “version already on npm” tag-recovery branch.
- Backfilling Releases for historical versions.
- Solving npm/GitHub distributed transaction guarantees.

## Options considered

### Option 1 — append-only tested finalizer (selected)

Add a notes renderer and a final workflow stage after the existing publish
paths.

Advantages:

- Keeps the known npm flow intact.
- Produces detailed, project-controlled notes.
- Adds only one new responsibility and one narrow retry state.
- No release-management dependency or process change.

Trade-offs:

- Requires a small amount of custom SemVer and Conventional Commit parsing.
- Does not repair failures in the older npm/tag stages.

### Option 2 — GitHub-generated notes

Run `gh release create --generate-notes` after publication.

Advantages:

- Smallest implementation.
- GitHub supplies contributor and pull-request links.

Trade-offs:

- GitHub may collapse a release containing many commits into one merged-PR
  bullet.
- Output quality depends on merge strategy and repository configuration.
- It does not reliably expose the feature/fix detail this issue is intended to
  add.

### Option 3 — release-management tool

Adopt Release Please, Changesets, or semantic-release.

Advantages:

- Mature versioning, changelog, and release orchestration.
- Better support for curated notes and release pull requests.

Trade-offs:

- Replaces the current “push to `main` and ship” model.
- Adds configuration, dependencies, and a larger operational change.
- Solves a much broader problem than issue #11.

## Selected architecture

### Notes module

Add `scripts/release-notes.mjs`. It remains repository tooling and is not
included in the library's public API.

The module should expose importable pure functions for tests and a CLI entry:

```text
parseSemVer(value)
compareSemVer(a, b)
selectPreviousTag(targetVersion, reachableTags)
parseConventionalCommit(commit)
renderReleaseNotes(release)
```

The CLI reads Git through argument-based child-process calls, writes Markdown
to stdout, and performs no GitHub mutation:

```bash
node scripts/release-notes.mjs --tag v0.3.0 \
  > "$RUNNER_TEMP/release-notes.md"
```

This also serves as the local preview command.

`scripts/release-version.mjs` keeps its existing behavior and parser. The small
amount of duplicated Conventional Commit classification is deliberate: notes
generation must not silently change version-bump policy.

### Publish-step outputs

Give the existing Path A and Path B publish steps IDs and expose the version
they successfully handled.

- Path A outputs its explicit `package.json` version after npm succeeds.
- Path B outputs `NEXT` after the existing normal publish/push branch succeeds.
- Path B's existing “already on npm, tagging only” branch outputs `NEXT` after
  its current tag push completes.

No output is written before that path's existing work succeeds.

### Release-target resolver

Add one resolver step after both publish paths.

It chooses a target in this order:

1. Path A's successful version output.
2. Path B's successful version output.
3. The narrow repair state described below.
4. No target.

When there is no target, the note and Release steps are skipped.

### Tag verification

For a version emitted by a successful publish path, require:

```text
TAG = v<VERSION>
TAG^{commit} = HEAD
```

For a repair target, accept either that same relationship or exactly one
tagged automatic-release commit that is the direct child of the checked-out
trigger commit. The child form must satisfy every condition:

```text
TAG = v<VERSION>
TAG^{commit}^1 = HEAD
TAG commit subject = release: v<VERSION> [skip ci]
TAG commit package.json version = VERSION
VERSION exists on npm
GitHub Release for TAG is absent
```

If no candidate or multiple candidates satisfy the repair contract, fail
instead of guessing.

The finalizer never creates, moves, or force-pushes a tag.

This keeps the ownership boundary clear:

- Path A's operator supplies the tag through `npm version` and
  `git push --follow-tags`.
- Path B's existing workflow supplies the tag.
- The finalizer only describes a release already represented by npm and Git.

### GitHub Release creation

Generate notes into `$RUNNER_TEMP`, then:

- If `gh release view "$TAG"` succeeds, report an idempotent no-op.
- Otherwise create the Release with `--verify-tag`, an explicit title, and
  `--notes-file`.
- Supply `GH_TOKEN: ${{ github.token }}` to `gh`.

Stable release flags:

```text
--latest
```

Prerelease flags:

```text
--prerelease --latest=false
```

The existing `contents: write` permission is sufficient. No PAT, npm token, or
new secret is introduced.

## Release-note model

Only actionable Conventional Commit categories become bullets:

- `type!:` or a `BREAKING CHANGE:` footer → **Breaking Changes**
- `feat:` → **Features**
- `fix:` → **Fixes**
- `perf:` → **Performance**

Breaking commits appear only in Breaking Changes, not twice in their ordinary
category.

`docs`, `chore`, `ci`, `test`, `refactor`, `release`, and non-Conventional
merge subjects are omitted from the bullets. They remain visible through the
full compare link.

Each bullet keeps the optional Conventional Commit scope and links its short
SHA:

```markdown
## Features

- **guides:** expose temporal products to post graphs
  ([bc87430](https://github.com/pmndrs/upscaler/commit/bc87430...))
```

Only non-empty sections are rendered.

The footer links the complete comparison:

```markdown
**Full Changelog:** https://github.com/pmndrs/upscaler/compare/v0.2.0...v0.3.0
```

### Comparison-tag selection

Only valid `v<SemVer>` tags reachable from the target tag are candidates.

- Stable target: choose the highest prior stable SemVer tag. This gives the
  stable Release all changes since the previous stable, including changes
  introduced through prereleases.
- Prerelease target: choose the highest prior SemVer tag, stable or
  prerelease. Prerelease notes are incremental.
- No prior tag: render all categorized commits reachable from the target and
  omit the compare link.

Version comparison must compare numeric identifiers without converting large
SemVer numbers through imprecise floating-point values.

## Workflow data flow

### Path A success

```text
explicit version
  → existing npm publish
  → output VERSION
  → verify vVERSION at HEAD
  → render notes
  → create stable/prerelease GitHub Release
```

### Path B success

```text
compute NEXT
  → existing npm version
  → existing npm publish
  → existing release commit/tag push
  → output NEXT
  → verify vNEXT at HEAD
  → render notes
  → create GitHub Release
```

### Ordinary no-release push

```text
version computation = none
  → no publish output
  → no matching current/direct-child release identity
  → no GitHub Release work
```

### Narrow repair

The repair target is accepted only when all of the following are true:

- Neither publish path emitted a version in this run.
- Exactly one of these identities is proven:
  - Path A/current-tag form: `v<package version>` points at checked-out `HEAD`,
    its version exists on npm, and its GitHub Release is absent.
  - Path B/automatic form: a tagged direct child of checked-out `HEAD` has the
    exact release-commit subject, its tagged `package.json` version matches the
    tag, that version exists on npm, and its GitHub Release is absent.

The child form is necessary because rerunning a Path B workflow checks out the
original triggering commit, while `npm version` created and pushed the release
commit as its child during the first attempt.

These states occur when npm and the tag succeeded but notes or GitHub Release
creation failed. A rerun recreates only the missing GitHub Release.

It intentionally does not infer a release from arbitrary npm versions, tags on
unrelated commits, grandchildren, or a newer `main`.

## Failure behavior

### Notes generation fails

- Workflow fails after the existing npm/tag work.
- No Git or npm state is changed by the finalizer.
- Rerun enters the narrow repair state.

### GitHub Release creation fails

- Workflow fails.
- Existing npm and tag state remain authoritative.
- Rerun enters the narrow repair state.

### Tag is missing

- Finalizer fails with a message requiring `v<VERSION>` to be pushed.
- It does not create the tag automatically.
- For Path A, remediation is the existing documented
  `git push origin main --follow-tags`.

### Tag does not match an allowed identity

- Finalizer fails.
- It does not move or replace the tag.

### Release already exists

- Finalizer exits successfully without editing the Release.
- Updating existing notes is not part of this issue.

### Existing npm/tag recovery fails

- Behavior remains whatever the current publish workflow does.
- The finalizer does not broaden that recovery or hide its failure.

## Proposed file changes

### Create

- `scripts/release-notes.mjs` — SemVer, commit parsing, Git collection, Markdown
  rendering, and preview CLI.
- `scripts/release-notes.test.mjs` — pure fixtures for notes and range policy.

### Modify

- `.github/workflows/publish.yml` — publish-step outputs, release-target
  resolver, notes generation, and `gh release create`.
- `README.md` — GitHub Releases as changelog, prerelease behavior, preview
  command, and missing-tag requirement.

### Explicitly unchanged

- `scripts/release-version.mjs`
- `package.json` release scripts and lifecycle
- `package-lock.json`
- npm trusted-publisher configuration
- existing version and tag policy

## Testing strategy

### Unit tests

Use synthetic records rather than temporary Git repositories.

Cover:

- Stable SemVer parsing and ordering.
- Prerelease identifier ordering.
- Large numeric prerelease identifiers without precision loss.
- Stable targets ignoring prerelease tags.
- Prereleases selecting the immediately preceding SemVer tag.
- No-previous-tag behavior.
- Scoped and unscoped `feat`, `fix`, and `perf`.
- Subject `!` and `BREAKING CHANGE:` footers.
- Breaking commits rendered once.
- Omission of non-actionable commit types.
- Deterministic section and bullet ordering.
- Commit links and compare links.
- Stable versus prerelease release flags.
- Current-tag repair identity.
- Strict direct-child automatic-release repair identity.
- Rejection of ambiguous, unrelated, or deeper-descendant repair candidates.

### Workflow validation

- Run `actionlint` locally when available.
- Add focused static assertions only for load-bearing workflow contracts:
  - both publish paths expose versions after success;
  - the finalizer is ordered after them;
  - tags are verified rather than created;
  - notes are written outside the checkout;
  - prereleases use `--prerelease --latest=false`;
  - stable releases use `--latest`;
  - `GH_TOKEN` comes from `github.token`.

These assertions should remain small. They are not a simulated GitHub Actions
engine.

### Manual preview

Render notes for an existing tag without mutating GitHub:

```bash
node scripts/release-notes.mjs --tag v0.2.0
```

Review section grouping, commit links, and the comparison range.

### External integration

The first real release is the integration test for `gh release create` and
GitHub's Release UI. The implementation must not create a test Release or
publish a test npm version from CI.

## Acceptance checklist

- Both publish paths provide the finalizer a version only after their existing
  work succeeds.
- A no-release push performs no GitHub Release work.
- Stable notes span the previous stable tag.
- Prerelease notes are incremental.
- Notes contain grouped, linked Conventional Commits and a compare link.
- Existing tags are required and verified.
- Repair accepts only a tag at the checked-out commit or one strictly verified
  automatic-release child commit.
- Stable Releases are latest.
- Prereleases are marked prerelease and not latest.
- Existing Releases are no-ops.
- Rerunning after only GitHub Release failure creates the missing Release.
- No `CHANGELOG.md`, new release commit, dependency, PAT, npm token, or bump
  policy change is introduced.

## Deferred risks

The current workflow has broader recovery concerns that are real but separate:

- npm lookup treats every `npm view` failure as “not published”;
- the existing “already on npm” recovery can recreate a tag without proving
  exact published-source identity;
- npm, Git, and GitHub cannot be committed atomically.

Addressing those concerns requires a dedicated release-transaction design.
They should not be smuggled into this append-only GitHub Release change.
