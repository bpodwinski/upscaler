// Release-version policy: the next version from Conventional Commits, and the npm
// dist-tag a version publishes under. `scripts/release.mjs` (npm run release)
// uses it to pick the version it tags; publish.yml uses `--describe` to validate
// a pushed tag and route it to a dist-tag.
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
//   node scripts/release-version.mjs --describe v0.3.0-beta.1
//       # "<version> <prerelease> <dist-tag> <latest>": "0.3.0-beta.1 true beta false"
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
 * @returns {string | null} The bumped stable version, or null for `none`.
 */
export function applyBump(version, level) {
    if (level === 'none') return null;
    const { major, minor, patch } = parseSemVer(version);
    const [maj, min, pat] = [major, minor, patch].map(Number);
    const effective = maj === 0 && level === 'major' ? 'minor' : level;
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
 * The npm dist-tag a version publishes under.
 *
 * Stable → `latest`. Prereleases use their first identifier (0.3.0-beta.1 →
 * `beta`), and numeric-only prereleases (0.3.0-0) use `next`, so a prerelease
 * never moves `latest`.
 *
 * @param {string} version
 * @returns {string}
 */
export function distTagFor(version) {
    const { prerelease } = parseSemVer(version);
    if (prerelease.length === 0) return 'latest';
    return /^\d+$/.test(prerelease[0]) ? 'next' : prerelease[0];
}

/**
 * Validates a release tag and describes how it publishes.
 *
 * @param {unknown} tag - Must be `v` + SemVer, e.g. `v0.3.0`.
 * @returns {{ version: string; prerelease: boolean; distTag: string }}
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
    return {
        version,
        prerelease: parseSemVer(version).prerelease.length > 0,
        distTag: distTagFor(version),
    };
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

/**
 * Computes the next release from the commits since the last stable tag.
 *
 * The base is the last stable tag's version (package.json's when there is no
 * tag), so graduating 0.3.0-beta.2 yields 0.3.0, not 0.4.0.
 *
 * @param {{
 *   runGit: (args: string[]) => string;
 *   packageVersion: string;
 *   preid?: string;
 * }} options
 * @returns {{
 *   previousTag: string | null;
 *   commits: Array<{ sha: string; subject: string; body: string }>;
 *   level: 'none' | 'patch' | 'minor' | 'major';
 *   version: string | null;
 * }} `version` is null when no commit warrants a release.
 */
export function computeNextVersion({ runGit, packageVersion, preid }) {
    const previousTag = findLastStableTag(runGit);
    const range = previousTag ? [`${previousTag}..HEAD`] : ['HEAD'];
    const commits = parseGitLog(runGit(['log', '-z', '--format=%H%x00%s%x00%b', ...range]));
    const level = bumpLevel(commits);
    const base = previousTag ? previousTag.slice(1) : packageVersion;
    const stable = applyBump(base, level);
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
            const { version, prerelease, distTag } = describeReleaseTag(args[1]);
            const tags = runGit(['tag', '--list', 'v*']).split(/\r?\n/).filter(Boolean);
            process.stdout.write(`${version} ${prerelease} ${distTag} ${isLatestRelease(version, tags)}\n`);
            return;
        }
        if (args.length !== 0)
            throw new Error('Usage: node scripts/release-version.mjs [--describe vX.Y.Z]');
        const packageVersion = JSON.parse(runGit(['show', 'HEAD:package.json'])).version;
        const { version } = computeNextVersion({ runGit, packageVersion });
        process.stdout.write(`${version ?? 'none'}\n`);
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (isDirectRun(import.meta.url)) main();
