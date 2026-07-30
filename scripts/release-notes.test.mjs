import { describe, expect, test, vi } from 'vitest';

import {
    collectReleaseData,
    compareSemVer,
    parseArguments,
    parseConventionalCommit,
    parseGitLog,
    parseSemVer,
    renderReleaseNotes,
    runGit,
    selectPreviousTag,
} from './release-notes.mjs';

const repositoryUrl = 'https://github.com/pmndrs/upscaler';

describe('SemVer', () => {
    test('parses stable and prerelease versions without losing numeric precision', () => {
        expect(parseSemVer('v1.2.3')).toEqual({
            major: '1',
            minor: '2',
            patch: '3',
            prerelease: [],
            build: [],
        });
        expect(parseSemVer('1.2.3-beta.9007199254740993+metal.3')).toEqual({
            major: '1',
            minor: '2',
            patch: '3',
            prerelease: ['beta', '9007199254740993'],
            build: ['metal', '3'],
        });
    });

    test.each([
        '',
        '1.2',
        '1.2.3.4',
        '01.2.3',
        '1.02.3',
        '1.2.03',
        '1.2.3-01',
        '1.2.3-beta..1',
        'version-1.2.3',
    ])('rejects invalid version %j', (value) => {
        expect(() => parseSemVer(value)).toThrow(/invalid semver/i);
    });

    test('orders core versions and ignores build metadata', () => {
        expect(compareSemVer('1.9.0', '1.10.0')).toBeLessThan(0);
        expect(compareSemVer('2.0.0', '1.999.999')).toBeGreaterThan(0);
        expect(compareSemVer('1.2.3+first', '1.2.3+second')).toBe(0);
    });

    test('implements SemVer prerelease precedence', () => {
        const ordered = [
            '1.0.0-alpha',
            '1.0.0-alpha.1',
            '1.0.0-alpha.beta',
            '1.0.0-beta',
            '1.0.0-beta.2',
            '1.0.0-beta.11',
            '1.0.0-rc.1',
            '1.0.0',
        ];

        for (let index = 1; index < ordered.length; index++)
            expect(compareSemVer(ordered[index - 1], ordered[index])).toBeLessThan(0);
    });

    test('compares large numeric identifiers as integers rather than floats', () => {
        expect(
            compareSemVer(
                '1.0.0-alpha.9007199254740992',
                '1.0.0-alpha.9007199254740993',
            ),
        ).toBeLessThan(0);
        expect(
            compareSemVer('9007199254740992.0.0', '9007199254740993.0.0'),
        ).toBeLessThan(0);
    });
});

describe('previous comparison tag selection', () => {
    test('stable targets select the highest prior stable tag', () => {
        expect(
            selectPreviousTag('v1.0.0', [
                'v0.9.0',
                'v1.0.0-beta.1',
                'v0.10.0',
                'not-a-version',
                '1.0.0-rc.1',
                'v1.0.0',
            ]),
        ).toBe('v0.10.0');
    });

    test('prerelease targets select the highest prior stable or prerelease tag', () => {
        expect(
            selectPreviousTag('v1.0.0-rc.2', [
                'v0.9.0',
                'v1.0.0-beta.2',
                'v1.0.0-rc.1',
                'v1.0.0',
                'v1.0.0-rc.2',
            ]),
        ).toBe('v1.0.0-rc.1');
    });

    test('returns null when no valid prior comparison tag exists', () => {
        expect(selectPreviousTag('v0.1.0', ['v0.1.0', 'latest', '0.0.1'])).toBeNull();
    });
});

describe('Conventional Commit parsing', () => {
    test.each([
        ['feat: add temporal guides', 'Features', undefined],
        ['feat(guides): expose temporal products', 'Features', 'guides'],
        ['fix: preserve ping-pong identity', 'Fixes', undefined],
        ['fix(node): register the dependency', 'Fixes', 'node'],
        ['perf: fuse the detector', 'Performance', undefined],
        ['perf(rcas): avoid repeated inversion', 'Performance', 'rcas'],
    ])('classifies %s', (subject, category, scope) => {
        expect(parseConventionalCommit({ subject, body: '' })).toMatchObject({
            category,
            scope,
            description: subject.slice(subject.indexOf(':') + 1).trim(),
            breaking: false,
        });
    });

    test('classifies subject markers and breaking footers as breaking changes', () => {
        expect(
            parseConventionalCommit({
                subject: 'feat(api)!: replace dispatch options',
                body: '',
            }),
        ).toMatchObject({
            category: 'Breaking Changes',
            scope: 'api',
            description: 'replace dispatch options',
            breaking: true,
        });
        expect(
            parseConventionalCommit({
                subject: 'fix: correct the output domain',
                body: 'BREAKING CHANGE: output is now linear HDR',
            }),
        ).toMatchObject({
            category: 'Breaking Changes',
            breaking: true,
        });
    });

    test.each([
        'docs: explain temporal guides',
        'chore: update fixtures',
        'ci: exercise packed output',
        'test: cover ordering',
        'refactor: rename local helper',
        'release: v0.2.0',
        'Merge pull request #11 from pmndrs/releases',
        'plain non-conventional subject',
    ])('omits non-actionable commit %j', (subject) => {
        expect(parseConventionalCommit({ subject, body: '' })).toBeNull();
    });
});

describe('release-note rendering', () => {
    const release = {
        tag: 'v0.3.0',
        previousTag: 'v0.2.0',
        repositoryUrl,
        commits: [
            {
                sha: 'ddddddd4444444',
                subject: 'perf(rcas): avoid repeated inversion',
                body: '',
            },
            {
                sha: 'bbbbbbb2222222',
                subject: 'feat: add release previews',
                body: '',
            },
            {
                sha: 'aaaaaaa1111111',
                subject: 'feat(guides): expose temporal products',
                body: '',
            },
            {
                sha: 'ccccccc3333333',
                subject: 'fix(history): preserve the latest write',
                body: '',
            },
            {
                sha: 'eeeeeee5555555',
                subject: 'feat(api)!: replace the dispatch contract',
                body: '',
            },
            {
                sha: 'fffffff6666666',
                subject: 'docs: document the new contract',
                body: '',
            },
        ],
    };

    test('renders non-empty sections in a fixed order and preserves commit order', () => {
        expect(renderReleaseNotes(release)).toBe(
            [
                '## Breaking Changes',
                '',
                '- **api:** replace the dispatch contract',
                `  ([eeeeeee](${repositoryUrl}/commit/eeeeeee5555555))`,
                '',
                '## Features',
                '',
                '- add release previews',
                `  ([bbbbbbb](${repositoryUrl}/commit/bbbbbbb2222222))`,
                '- **guides:** expose temporal products',
                `  ([aaaaaaa](${repositoryUrl}/commit/aaaaaaa1111111))`,
                '',
                '## Fixes',
                '',
                '- **history:** preserve the latest write',
                `  ([ccccccc](${repositoryUrl}/commit/ccccccc3333333))`,
                '',
                '## Performance',
                '',
                '- **rcas:** avoid repeated inversion',
                `  ([ddddddd](${repositoryUrl}/commit/ddddddd4444444))`,
                '',
                `**Full Changelog:** ${repositoryUrl}/compare/v0.2.0...v0.3.0`,
                '',
            ].join('\n'),
        );
    });

    test('renders breaking commits once and omits non-actionable sections', () => {
        const notes = renderReleaseNotes({
            ...release,
            commits: [release.commits[4], release.commits[5]],
        });

        expect(notes.match(/replace the dispatch contract/g)).toHaveLength(1);
        expect(notes).not.toContain('## Features');
        expect(notes).not.toContain('document the new contract');
    });

    test('omits the comparison link when there is no prior tag', () => {
        const notes = renderReleaseNotes({
            ...release,
            previousTag: null,
            commits: [release.commits[1]],
        });

        expect(notes).toContain('## Features');
        expect(notes).not.toContain('Full Changelog');
        expect(notes).not.toContain('/compare/');
    });

    test('produces identical Markdown for identical release data', () => {
        expect(renderReleaseNotes(release)).toBe(renderReleaseNotes(release));
    });
});

describe('read-only Git data collection', () => {
    test('collects reachable tags and the selected range through argument arrays', () => {
        const controlBody = 'body with record byte \x1e and unit byte \x1f';
        const runGit = vi.fn((args) => {
            if (args[0] === 'rev-parse') return 'abc123\n';
            if (args[0] === 'tag') return 'v0.1.0\nv0.2.0-beta.1\nv0.2.0\n';
            if (args[0] === 'log')
                return [
                    `abcdef0123456789\0feat(cli): add notes preview\0${controlBody}\0`,
                    'fedcba9876543210\0fix: preserve ranges\0\0',
                ].join('');
            throw new Error(`Unexpected git arguments: ${args.join(' ')}`);
        });

        expect(collectReleaseData('v0.2.0', { runGit, repositoryUrl })).toEqual({
            tag: 'v0.2.0',
            previousTag: 'v0.1.0',
            repositoryUrl,
            commits: [
                {
                    sha: 'abcdef0123456789',
                    subject: 'feat(cli): add notes preview',
                    body: controlBody,
                },
                {
                    sha: 'fedcba9876543210',
                    subject: 'fix: preserve ranges',
                    body: '',
                },
            ],
        });
        expect(runGit.mock.calls.map(([args]) => args)).toEqual([
            ['rev-parse', '--verify', 'v0.2.0^{commit}'],
            ['tag', '--merged', 'v0.2.0', '--list', 'v*'],
            [
                'log',
                '-z',
                '--reverse',
                '--format=%H%x00%s%x00%b',
                'v0.1.0..v0.2.0',
            ],
        ]);
    });

    test('collects all target history when there is no prior tag', () => {
        const runGit = vi.fn((args) => {
            if (args[0] === 'tag') return 'v0.1.0\n';
            if (args[0] === 'log') return '';
            return 'abc123\n';
        });

        expect(
            collectReleaseData('v0.1.0', { runGit, repositoryUrl }).previousTag,
        ).toBeNull();
        expect(runGit.mock.calls.at(-1)[0]).toEqual([
            'log',
            '-z',
            '--reverse',
            '--format=%H%x00%s%x00%b',
            'v0.1.0',
        ]);
    });

    test('rejects a CLI target that is not a v-prefixed SemVer tag before running Git', () => {
        const runGit = vi.fn();

        expect(() =>
            collectReleaseData('0.2.0', { runGit, repositoryUrl }),
        ).toThrow(/v-prefixed semver tag/i);
        expect(runGit).not.toHaveBeenCalled();
    });

    test('preserves legal commit-message control characters in fixed NUL fields', () => {
        const body = 'first line\x1e\nsecond line\x01\nBREAKING CHANGE: keep framing';
        const subject = 'feat(parser): preserve \x1f control bytes';
        const log = `abcdef0123456789\0${subject}\0${body}\0`;

        expect(parseGitLog(log)).toEqual([
            {
                sha: 'abcdef0123456789',
                subject,
                body,
            },
        ]);
    });

    test('rejects an incomplete fixed-field Git record', () => {
        expect(() => parseGitLog('abcdef\0feat: incomplete\0')).toThrow(
            /fixed-field git log/i,
        );
    });

    test('sets a generous buffer for long release histories', () => {
        const execute = vi.fn(() => 'git output');

        expect(runGit(['log', 'v0.1.0..v0.2.0'], execute)).toBe('git output');
        expect(execute).toHaveBeenCalledWith(
            'git',
            ['log', 'v0.1.0..v0.2.0'],
            {
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        );
    });
});

describe('preview CLI arguments', () => {
    test('accepts only a single v-prefixed SemVer tag option', () => {
        expect(parseArguments(['--tag', 'v0.2.0'])).toEqual({ tag: 'v0.2.0' });
        expect(() => parseArguments([])).toThrow(/usage/i);
        expect(() => parseArguments(['--tag', '0.2.0'])).toThrow(
            /v-prefixed semver tag/i,
        );
        expect(() => parseArguments(['--tag', 'v0.2.0', '--other'])).toThrow(
            /usage/i,
        );
    });
});
