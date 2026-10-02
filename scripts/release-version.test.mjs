import { describe, expect, test } from 'vitest';

import {
    applyBump,
    assertNewer,
    bumpLevel,
    computeNextVersion,
    describeReleaseTag,
    distTagFor,
    findLastStableTag,
    isLatestRelease,
    nextPrerelease,
} from './release-version.mjs';

/** A git runner answering `describe` and `log` from a fixed history. */
function fakeGit({ lastStableTag = 'v0.2.0', commits = [] } = {}) {
    const calls = [];
    const runGit = (args) => {
        calls.push(args);
        if (args[0] === 'describe') {
            if (!lastStableTag) throw new Error('fatal: No names found');
            return `${lastStableTag}\n`;
        }
        if (args[0] === 'log')
            return commits
                .map(([subject, body = ''], index) => `${String(index).padStart(40, '0')}\0${subject}\0${body}\0`)
                .join('');
        throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { runGit, calls };
}

describe('bump policy', () => {
    test.each([
        [['docs: words', 'chore: tidy', 'Merge pull request #1 from x/y'], 'none'],
        [['fix: a bug', 'docs: words'], 'patch'],
        [['perf: faster'], 'patch'],
        [['fix: a bug', 'feat: a feature'], 'minor'],
        [['feat!: breaking'], 'major'],
        [['refactor(core)!: breaking'], 'major'],
        [[{ subject: 'fix: a bug', body: 'BREAKING CHANGE: it moved' }], 'major'],
    ])('%j → %s', (commits, level) => {
        expect(bumpLevel(commits)).toBe(level);
    });

    test('caps a breaking change to minor while 0.x', () => {
        expect(applyBump('0.2.0', 'major')).toBe('0.3.0');
        expect(applyBump('1.2.3', 'major')).toBe('2.0.0');
        expect(applyBump('0.2.0', 'minor')).toBe('0.3.0');
        expect(applyBump('0.2.5', 'patch')).toBe('0.2.6');
        expect(applyBump('0.2.0', 'none')).toBeNull();
    });
});

describe('prereleases', () => {
    test('starts a series at .0 and continues it', () => {
        expect(nextPrerelease('0.2.0', '0.3.0', 'beta')).toBe('0.3.0-beta.0');
        expect(nextPrerelease('0.3.0-beta.0', '0.3.0', 'beta')).toBe('0.3.0-beta.1');
        expect(nextPrerelease('0.3.0-beta.4', '0.3.0', 'rc')).toBe('0.3.0-rc.0');
        expect(nextPrerelease('0.3.0-beta.4', '0.4.0', 'beta')).toBe('0.4.0-beta.0');
    });

    test.each(['', '1', 'beta.1', 'beta!'])('rejects preid %j', (preid) => {
        expect(() => nextPrerelease('0.2.0', '0.3.0', preid)).toThrow(/invalid --preid/i);
    });

    test.each([
        ['0.3.0', 'latest'],
        ['0.3.0-beta.1', 'beta'],
        ['1.0.0-rc.0', 'rc'],
        ['0.3.0-0', 'next'],
    ])('%s publishes to dist-tag %s', (version, distTag) => {
        expect(distTagFor(version)).toBe(distTag);
    });
});

describe('release tags', () => {
    test('describes a valid tag', () => {
        expect(describeReleaseTag('v0.3.0')).toEqual({ version: '0.3.0', prerelease: false, distTag: 'latest' });
        expect(describeReleaseTag('v0.3.0-beta.1')).toEqual({
            version: '0.3.0-beta.1',
            prerelease: true,
            distTag: 'beta',
        });
    });

    test.each(['0.3.0', 'v0.3', 'vnext', 'v01.2.3', 'release-0.3.0', undefined])('rejects %j', (tag) => {
        expect(() => describeReleaseTag(tag)).toThrow(/"v" \+ SemVer/);
    });

    test('only the highest stable version becomes the latest Release', () => {
        const tags = ['v0.1.0', 'v0.2.0', 'v0.3.0-beta.1', 'not-a-version'];
        expect(isLatestRelease('0.2.0', tags)).toBe(true);
        expect(isLatestRelease('0.3.0', [...tags, 'v0.3.0'])).toBe(true);
        expect(isLatestRelease('0.1.0', tags)).toBe(false);
        expect(isLatestRelease('0.3.0-beta.1', tags)).toBe(false);
    });
});

describe('computeNextVersion', () => {
    test('bumps the last stable tag by the commits since it', () => {
        const { runGit, calls } = fakeGit({ commits: [['feat!: drop alpha option'], ['fix: x'], ['docs: y']] });
        const result = computeNextVersion({ runGit, packageVersion: '0.2.0' });

        expect(result).toMatchObject({ previousTag: 'v0.2.0', level: 'major', version: '0.3.0' });
        expect(result.commits.map((commit) => commit.subject)).toEqual(['feat!: drop alpha option', 'fix: x', 'docs: y']);
        expect(calls[0]).toEqual(['describe', '--tags', '--abbrev=0', '--match', 'v*', '--exclude', 'v*-*']);
        expect(calls[1]).toContain('v0.2.0..HEAD');
    });

    test('returns no version when nothing warrants a release', () => {
        const { runGit } = fakeGit({ commits: [['docs: y'], ['chore: z']] });
        expect(computeNextVersion({ runGit, packageVersion: '0.2.0' }).version).toBeNull();
    });

    test('graduates a prerelease to its stable version', () => {
        const { runGit } = fakeGit({ commits: [['feat: a'], ['fix: b']] });
        expect(computeNextVersion({ runGit, packageVersion: '0.3.0-beta.2' }).version).toBe('0.3.0');
    });

    test('computes a prerelease with --preid', () => {
        const { runGit } = fakeGit({ commits: [['feat: a']] });
        expect(computeNextVersion({ runGit, packageVersion: '0.2.0', preid: 'beta' }).version).toBe('0.3.0-beta.0');
        expect(computeNextVersion({ runGit, packageVersion: '0.3.0-beta.0', preid: 'beta' }).version).toBe(
            '0.3.0-beta.1',
        );
    });

    test('scans all history from package.json when there is no stable tag', () => {
        const { runGit, calls } = fakeGit({ lastStableTag: null, commits: [['fix: a']] });
        const result = computeNextVersion({ runGit, packageVersion: '0.1.0' });

        expect(result).toMatchObject({ previousTag: null, version: '0.1.1' });
        expect(calls[1]).toContain('HEAD');
        expect(findLastStableTag(runGit)).toBeNull();
    });

    test('refuses a version that is not newer', () => {
        expect(() => assertNewer('0.2.0', '0.2.0')).toThrow(/not newer/);
        expect(() => assertNewer('0.3.0-beta.0', '0.3.0')).toThrow(/not newer/);
        expect(() => assertNewer('0.3.0', '0.3.0-beta.0')).not.toThrow();
    });
});
