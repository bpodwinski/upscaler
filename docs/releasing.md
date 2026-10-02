# Releasing

Releases are cut by pushing a version tag. **Merging to `main` never publishes**, so
pull requests can land at any pace during development.

## Cutting a release

On an up-to-date `main` with a clean working tree:

```bash
git switch main && git pull
npm run release -- --dry-run   # preview: the commits included and the computed version
npm run release                # gate, then the release commit + annotated tag (local only)
git push --atomic origin main refs/tags/vX.Y.Z   # printed by the previous step; this publishes
```

`npm run release -- --push` does the last step for you.

[`scripts/release.mjs`](../scripts/release.mjs) refuses to run unless the tree is
clean, you are on `main`, and `main` matches `origin/main` (it fetches first). It then:

1. computes the next version from the [Conventional Commits](https://www.conventionalcommits.org/)
   since the last stable tag (table below), and prints the commits and the version;
2. runs the gate: `npm run lint && npm run typecheck && npm test && npm run build`;
3. runs `npm version <version> -m "release: v%s"`, which commits `package.json` and
   `package-lock.json` and creates the annotated tag `v<version>`;
4. pushes `main` and the tag only with `--push`. Otherwise it prints the push command.

`--dry-run` computes and prints only. Off `main` or with a dirty tree it warns about
what a real run would refuse, rather than stopping. To release a specific version,
pass it: `npm run release -- 0.4.0`.

| Commits since the last stable tag        | Bump    | Example       |
| ---------------------------------------- | ------- | ------------- |
| `fix:` / `perf:`                         | patch   | 0.2.0 → 0.2.1 |
| `feat:`                                  | minor   | 0.2.0 → 0.3.0 |
| `feat!:` / `<type>!:` / `BREAKING CHANGE:` | major\* | 0.2.0 → 0.3.0 |
| `docs:` / `chore:` / `ci:` / `refactor:` … | none    | —             |

\* While on `0.x` a breaking change bumps minor, so a stray `!` can't cut `1.0.0`.
When nothing warrants a release, `npm run release` says so and stops; pass an
explicit version to release anyway. The policy lives in
[`scripts/release-version.mjs`](../scripts/release-version.mjs), and the
classification is shared with the release notes.

## What the tag push does

[`publish.yml`](../.github/workflows/publish.yml) runs on `v*` tag pushes only. Before
publishing anything, it fails the run if any of these guards fail:

- the tag is not `v` followed by a SemVer version;
- `package.json` at the tagged commit does not have exactly that version;
- the tagged commit is not on `origin/main`, so a tag on a side branch never ships.

It then publishes with `npm publish --access public --tag <dist-tag>`, whose
`prepublishOnly` gate runs lint, typecheck, test and build again. Finally it creates
the GitHub Release for that tag, with notes from
[`scripts/release-notes.mjs`](../scripts/release-notes.mjs). The workflow never
pushes commits or tags.

Preview the notes locally with `node scripts/release-notes.mjs --tag vX.Y.Z`. Stable
notes compare against the previous stable tag. Prerelease notes compare against the
previous tag of either kind.

## Prereleases

```bash
npm run release -- --preid beta   # 0.3.0-beta.0; run again for 0.3.0-beta.1
npm run release                   # later: graduates to 0.3.0
```

A prerelease publishes to the npm dist-tag named by its first identifier (`beta`,
`rc`, …). A numeric-only prerelease such as `0.3.0-0` publishes to `next`. Either way
it never moves `latest`, and its GitHub Release is marked as a prerelease.

| Version        | dist-tag | Install                        |
| -------------- | -------- | ------------------------------ |
| `0.3.0`        | `latest` | `npm i @pmndrs/upscaler`       |
| `0.3.0-beta.0` | `beta`   | `npm i @pmndrs/upscaler@beta`  |
| `1.0.0-rc.0`   | `rc`     | `npm i @pmndrs/upscaler@rc`    |
| `0.3.0-0`      | `next`   | `npm i @pmndrs/upscaler@next`  |

## Re-running a release

The workflow is idempotent. If a run fails after npm accepted the package (for
example, at the GitHub Release step), re-run it from the Actions tab: **Publish to
npm → Run workflow**, with input `tag` set to the existing tag (`v0.3.0`). A version
already on npm is not republished. A missing GitHub Release is created. An existing
Release is left unchanged and is never edited.

A dispatch takes the release scripts from the branch it runs on, normally `main`. It
can therefore also create Releases for tags cut before those scripts existed. A
Release for an older tag never takes "latest" from a newer one.

## One-time npm setup

Publishing uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC). There is no token or secret, and provenance is attached automatically. On
npmjs.com, under the package's **Settings → Trusted publishing**, register a GitHub
Actions publisher:

- Organization or user: `pmndrs`
- Repository: `upscaler`
- Workflow filename: `publish.yml`
- Environment: leave empty

The trusted publisher binds to the repository and the workflow filename, not to the
trigger. A publisher registered for the old push-to-`main` workflow therefore keeps
working for tag pushes and dispatches, as long as the file stays
`.github/workflows/publish.yml`. Trusted Publishing also needs npm ≥ 11.5.1 (the
workflow pins `npm@^11.5.1`, the same as CI), Node ≥ 22.14.0, the `id-token: write`
permission, and `repository.url` in `package.json` to match the GitHub repository.
