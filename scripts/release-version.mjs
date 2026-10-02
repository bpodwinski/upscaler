// Release-version policy: the next version from Conventional Commits, and the npm
// dist-tag a version publishes under. publish.yml uses `--next` to compute the
// version the "Run workflow" button cuts, `--describe` to validate a tag, and
// `--dist-tag` to route a version to a dist-tag given npm's current `latest`;
// `scripts/release.mjs` (npm run release) shares the same computation locally.
//
//   feat:            -> minor      fix: / perf:     -> patch
//   <type>!: / BREAKING CHANGE:    -> major (capped to minor while 0.x, so a
//                                    stray breaking change can't jump to 1.0.0)
//   docs/chore/ci/refactor/test/…  -> no release
//
// Commit classification is shared with the release notes (parseConventionalCommit),
// so a commit that shows up under "Features" is exactly a commit that bumps minor.
//
//   node scripts/release-version.mjs                 # preview: next version, or "none"
//   node scripts/release-version.mjs --next auto --preid beta
//                                                    # the version to cut, or an error
//   node scripts/release-version.mjs --describe v0.3.0-beta.1
//       # "<version> <prerelease> <latest>": "0.3.0-beta.1 true false"
//   node scripts/release-version.mjs --dist-tag 0.2.1 0.3.0
//       # the dist-tag to publish under, given npm's latest ("" if none): "v0.2-latest"
import { execFileSync } from 'node:child_process';

import { compareSemVer, isDirectRun, parseConventionalCommit, parseGitLog, parseSemVer } from './release-notes.mjs';

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
const LEVEL_BY_CATEGORY = {
    'Breaking Changes': 'major',
    Features: 'minor',
    Fixes: 'patch',
    Performance: 'patch',
};
const PREID_PATTERN = /^[A-Za-z][0-9A-Za-z-]*$/;

/**
 * The highest bump any of the commits warrants.
 *
 * @param {Array<string | { subject: string; body?: string }>} commits
 * @returns {'none' | 'patch' | 'minor' | 'major'}
 */
export function bumpLevel(commits) {
    let level = 'none';
    for (const commit of commits) {
        const parsed = parseConventionalCommit(commit);
        const commitLevel = parsed ? LEVEL_BY_CATEGORY[parsed.category] : 'none';
        if (RANK[commitLevel] > RANK[level]) level = commitLevel;
    }
    return level;
}

/**
 * Applies a bump to a version's core, capping major to minor while 0.x.
 *
 * @param {string} version - Base version; any prerelease/build suffix is dropped.
 * @param {'none' | 'patch' | 'minor' | 'major'} level
 * @param {{ capZeroMajor?: boolean }} [options] - `capZeroMajor: false` lets an
 *   explicitly requested major leave 0.x.
 * @returns {string | null} The bumped stable version, or null for `none`.
 */
export function applyBump(version, level, { capZeroMajor = true } = {}) {
    if (level === 'none') return null;
    const { major, minor, patch } = parseSemVer(version);
    const [maj, min, pat] = [major, minor, patch].map(Number);
    const effective = capZeroMajor && maj === 0 && level === 'major' ? 'minor' : level;
    if (effective === 'major') return `${maj + 1}.0.0`;
    if (effective === 'minor') return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${pat + 1}`;
}

/**
 * The next prerelease of `stable` for a prerelease identifier.
 *
 * Continues the current series (0.3.0-beta.0 → 0.3.0-beta.1) when the current
 * version is already that prerelease of the same core; otherwise starts it at 0.
 *
 * @param {string} current - The version in package.json.
 * @param {string} stable - The stable version the prerelease leads up to.
 * @param {string} preid - Prerelease identifier, e.g. `beta`.
 * @returns {string}
 */
export function nextPrerelease(current, stable, preid) {
    if (!PREID_PATTERN.test(preid))
        throw new Error(`Invalid --preid ${JSON.stringify(preid)}: use letters, digits and hyphens, starting with a letter.`);
    const parsed = parseSemVer(current);
    const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
    const [id, counter, ...rest] = parsed.prerelease;
    if (core === stable && id === preid && /^\d+$/.test(counter ?? '') && rest.length === 0)
        return `${stable}-${preid}.${Number(counter) + 1}`;
    return `${stable}-${preid}.0`;
}

/**
 * The npm dist-tag that keeps installing a stable version's release line:
 * `v<major>.<minor>-latest` (0.2.1 → `v0.2-latest`). Never a valid SemVer range,
 * which npm refuses as a dist-tag.
 *
 * @param {string} version
 * @returns {string}
 */
export function lineDistTag(version) {
    const { major, minor } = parseSemVer(version);
    return `v${major}.${minor}-latest`;
}

/**
 * The npm dist-tag a version publishes under.
 *
 * Prereleases use their first identifier (0.3.0-beta.1 → `beta`), and
 * numeric-only prereleases (0.3.0-0) use `next`, so a prerelease never moves
 * `latest`. A stable version takes `latest` only when it is at or above npm's
 * current `latest` (or npm has none yet), the same rule as the GitHub Release;
 * an older one, such as a maintenance release on a previous line, publishes
 * under its line tag (`v0.2-latest`) so `latest` never moves backwards.
 *
 * @param {string} version
 * @param {string | null} npmLatest - npm's current `latest` version; null or
 *   empty when the package (or its `latest` tag) doesn't exist yet.
 * @returns {string}
 * @throws {Error} When either version isn't SemVer.
 */
export function distTagFor(version, npmLatest) {
    const { prerelease } = parseSemVer(version);
    if (prerelease.length > 0) return /^\d+$/.test(prerelease[0]) ? 'next' : prerelease[0];
    if (!npmLatest) return 'latest';
    let current;
    try {
        current = parseSemVer(npmLatest);
    } catch {
        throw new Error(`npm's latest dist-tag is not a SemVer version: ${JSON.stringify(npmLatest)}`);
    }
    return compareSemVer(version, current) >= 0 ? 'latest' : lineDistTag(version);
}

/**
 * Validates a release tag and describes how it publishes.
 *
 * @param {unknown} tag - Must be `v` + SemVer, e.g. `v0.3.0`.
 * @returns {{ version: string; prerelease: boolean }}
 * @throws {Error} When the tag isn't a v-prefixed SemVer.
 */
export function describeReleaseTag(tag) {
    if (typeof tag !== 'string' || !tag.startsWith('v'))
        throw new Error(`Release tags must be "v" + SemVer (e.g. v0.3.0), received: ${String(tag)}`);
    const version = tag.slice(1);
    try {
        parseSemVer(version);
    } catch {
        throw new Error(`Release tags must be "v" + SemVer (e.g. v0.3.0), received: ${tag}`);
    }
    return { version, prerelease: parseSemVer(version).prerelease.length > 0 };
}

/**
 * Whether a release should become the repository's latest GitHub Release.
 *
 * Only a stable version at or above every stable `v*` tag qualifies, so
 * backfilling an old tag's Release never takes "latest" from a newer one.
 *
 * @param {string} version
 * @param {string[]} tags - Every tag in the repository; non-release tags are ignored.
 * @returns {boolean}
 */
export function isLatestRelease(version, tags) {
    if (parseSemVer(version).prerelease.length > 0) return false;
    for (const tag of tags) {
        if (!tag.startsWith('v')) continue;
        let other;
        try {
            other = parseSemVer(tag.slice(1));
        } catch {
            continue;
        }
        if (other.prerelease.length === 0 && compareSemVer(other, version) > 0) return false;
    }
    return true;
}

/**
 * The most recent stable `v*` tag reachable from HEAD, or null.
 *
 * @param {(args: string[]) => string} runGit
 * @returns {string | null}
 */
export function findLastStableTag(runGit) {
    let tag;
    try {
        tag = runGit(['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', 'v*-*']).trim();
    } catch {
        return null; // no stable tag yet
    }
    return tag || null;
}

const LEVELS = ['patch', 'minor', 'major'];

/**
 * Validates a version spec: `auto`, `patch`, `minor`, `major`, or an explicit
 * SemVer (a leading `v` is accepted and dropped).
 *
 * @param {string} spec
 * @returns {string} The normalized spec.
 */
export function normalizeSpec(spec) {
    if (spec === 'auto' || LEVELS.includes(spec)) return spec;
    const version = typeof spec === 'string' ? spec.replace(/^v/, '') : spec;
    try {
        parseSemVer(version);
    } catch {
        throw new Error(`Expected auto, patch, minor, major or a version like 0.3.0, received: ${String(spec)}`);
    }
    return version;
}

/**
 * Computes the next release version.
 *
 * `auto` bumps by the commits since the last stable tag (0.x caps a breaking
 * change to minor); `patch`/`minor`/`major` force that bump (uncapped: asking
 * for major on 0.x means 1.0.0); an explicit version is taken as-is. The base
 * is the last stable tag's version (package.json's when there is no tag), so
 * graduating 0.3.0-beta.2 yields 0.3.0, not 0.4.0. `preid` turns the bumped
 * version into the next prerelease of it.
 *
 * @param {{
 *   runGit: (args: string[]) => string;
 *   packageVersion: string;
 *   spec?: string;
 *   preid?: string;
 * }} options
 * @returns {{
 *   previousTag: string | null;
 *   commits: Array<{ sha: string; subject: string; body: string }>;
 *   level: 'none' | 'patch' | 'minor' | 'major';
 *   version: string | null;
 * }} `level` is what the commits warrant; `version` is null when `auto` finds
 *   nothing to release.
 * @throws {Error} On an invalid spec or preid, or a preid with an explicit version.
 */
export function computeNextVersion({ runGit, packageVersion, spec = 'auto', preid }) {
    const normalized = normalizeSpec(spec);
    const explicit = normalized !== 'auto' && !LEVELS.includes(normalized);
    if (explicit && preid) throw new Error('A prerelease id cannot be combined with an explicit version.');

    const previousTag = findLastStableTag(runGit);
    const range = previousTag ? [`${previousTag}..HEAD`] : ['HEAD'];
    const commits = parseGitLog(runGit(['log', '-z', '--format=%H%x00%s%x00%b', ...range]));
    const level = bumpLevel(commits);
    if (explicit) return { previousTag, commits, level, version: normalized };

    const base = previousTag ? previousTag.slice(1) : packageVersion;
    const stable =
        normalized === 'auto' ? applyBump(base, level) : applyBump(base, normalized, { capZeroMajor: false });
    const version = stable && preid ? nextPrerelease(packageVersion, stable, preid) : stable;
    return { previousTag, commits, level, version };
}

/**
 * Throws unless `next` is strictly newer than `current`.
 *
 * @param {string} next
 * @param {string} current
 */
export function assertNewer(next, current) {
    if (compareSemVer(next, current) <= 0)
        throw new Error(`Version ${next} is not newer than package.json's ${current}.`);
}

function main() {
    const args = process.argv.slice(2);
    const runGit = (gitArgs) =>
        execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    try {
        if (args[0] === '--describe' && args.length === 2) {
            const { version, prerelease } = describeReleaseTag(args[1]);
            const tags = runGit(['tag', '--list', 'v*']).split(/\r?\n/).filter(Boolean);
            process.stdout.write(`${version} ${prerelease} ${isLatestRelease(version, tags)}\n`);
            return;
        }
        if (args[0] === '--dist-tag' && (args.length === 2 || args.length === 3)) {
            // The dist-tag for a version, given npm's current latest ("" or absent: none).
            process.stdout.write(`${distTagFor(args[1], args[2] || null)}\n`);
            return;
        }
        if (args[0] === '--compare' && args.length === 3) {
            // SemVer precedence of A vs B: -1, 0 or 1.
            process.stdout.write(`${compareSemVer(args[1], args[2])}\n`);
            return;
        }
        const usage =
            'Usage: node scripts/release-version.mjs [--describe vX.Y.Z | --dist-tag X.Y.Z [<npm latest>] | --compare A B | --next <auto|patch|minor|major|X.Y.Z> [--preid <id>]]';
        const packageVersion = JSON.parse(runGit(['show', 'HEAD:package.json'])).version;
        if (args[0] === '--next') {
            // The release button: print the version to cut, or fail loudly.
            if (!(args.length === 2 || (args.length === 4 && args[2] === '--preid'))) throw new Error(usage);
            const preid = args[3] || undefined;
            const { version, previousTag } = computeNextVersion({ runGit, packageVersion, spec: args[1], preid });
            if (!version)
                throw new Error(
                    `No feat/fix/perf or breaking commits since ${previousTag ?? 'the first commit'}; nothing to release. ` +
                        'Choose patch/minor/major or an explicit version to release anyway.',
                );
            assertNewer(version, packageVersion);
            process.stdout.write(`${version}\n`);
            return;
        }
        if (args.length !== 0) throw new Error(usage);
        const { version } = computeNextVersion({ runGit, packageVersion });
        process.stdout.write(`${version ?? 'none'}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (isDirectRun(import.meta.url)) main();
