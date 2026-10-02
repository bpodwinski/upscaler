// `npm run release` against a scripted git/npm: no repository, network or npm
// registry is touched. GPU-free.
import { describe, expect, test } from 'vitest';

import { checkPreconditions, parseReleaseArgs, release } from './release.mjs';

const PACKAGE = JSON.stringify({ name: '@pmndrs/upscaler', version: '0.2.0' });

/**
 * A runner that answers the read-only git queries release.mjs makes and records
 * every call, so tests can assert exactly which side effects happened.
 */
function fakeRunner({
    status = '',
    branch = 'main',
    aheadBehind = '0\t0',
    packageJson = PACKAGE,
    lastStableTag = 'v0.2.0',
    commits = [['feat!: carry alpha unconditionally'], ['fix: relax the alpha clamp'], ['docs: words']],
    existingTags = [],
    failOn,
} = {}) {
    const calls = [];
    const run = (command, args, options = {}) => {
        const line = `${command} ${args.join(' ')}`;
        calls.push({ line, inherit: Boolean(options.inherit) });
        if (failOn && line.startsWith(failOn)) throw new Error(`${line} failed`);
        if (command === 'git') {
            switch (args[0]) {
                case 'status':
                    return status;
                case 'rev-parse':
                    return `${branch}\n`;
                case 'fetch':
                    return '';
                case 'rev-list':
                    return `${aheadBehind}\n`;
                case 'show':
                    return packageJson;
                case 'describe':
                    return `${lastStableTag}\n`;
                case 'log':
                    return commits
                        .map(([subject, body = ''], index) => `${String(index + 1).repeat(40)}\0${subject}\0${body}\0`)
                        .join('');
                case 'tag':
                    return existingTags.includes(args[2]) ? `${args[2]}\n` : '';
                case 'push':
                    return '';
            }
        }
        if (command === 'npm') return '';
        throw new Error(`unexpected ${line}`);
    };
    return { run, calls };
}

function capture() {
    const lines = [];
    const warnings = [];
    return { lines, warnings, log: (line) => lines.push(line), warn: (line) => warnings.push(line) };
}

const SIDE_EFFECTS = /^(npm (run|test|version)|git push)/;
const sideEffects = (calls) => calls.map((call) => call.line).filter((line) => SIDE_EFFECTS.test(line));

describe('arguments', () => {
    test('parses version, preid and flags', () => {
        expect(parseReleaseArgs([])).toEqual({ spec: 'auto', push: false, dryRun: false, help: false });
        expect(parseReleaseArgs(['v0.3.0', '--push'])).toMatchObject({ spec: '0.3.0', push: true });
        expect(parseReleaseArgs(['minor', '--preid', 'beta'])).toMatchObject({ spec: 'minor', preid: 'beta' });
        expect(parseReleaseArgs(['--preid=rc', '--dry-run'])).toMatchObject({ spec: 'auto', preid: 'rc', dryRun: true });
    });

    test.each([
        [['0.3'], /expected auto, patch, minor, major or a version/i],
        [['0.3.0', '--preid', 'beta'], /either an explicit version or --preid/],
        [['--preid'], /needs a value/],
        [['--push', '--dry-run'], /mutually exclusive/],
        [['--force'], /unknown option/i],
        [['0.3.0', '0.4.0'], /only one version/i],
    ])('rejects %j', (argv, message) => {
        expect(() => parseReleaseArgs(argv)).toThrow(message);
    });
});

describe('preconditions', () => {
    test.each([
        ['a dirty working tree', { status: ' M src/index.ts\n' }, /working tree is not clean/],
        ['a branch other than main', { branch: 'feature/x' }, /not on main \(on feature\/x\)/],
        ['a checkout behind origin/main', { aheadBehind: '0\t2' }, /behind origin\/main by 2/],
        ['unpushed commits', { aheadBehind: '1\t0' }, /ahead of origin\/main by 1/],
    ])('refuses %s and changes nothing', (_scenario, state, message) => {
        const { run, calls } = fakeRunner(state);
        const output = capture();

        expect(() => release({ argv: [], run, ...output })).toThrow(message);
        expect(sideEffects(calls)).toEqual([]);
    });

    test('fetches origin main before comparing', () => {
        const { run, calls } = fakeRunner();
        expect(checkPreconditions(run)).toEqual([]);

        const lines = calls.map((call) => call.line);
        expect(lines.indexOf('git fetch --quiet --tags origin main')).toBeLessThan(
            lines.indexOf('git rev-list --left-right --count HEAD...origin/main'),
        );
    });
});

describe('computing the version', () => {
    test('prints the commits and the computed version', () => {
        const { run } = fakeRunner();
        const output = capture();

        const result = release({ argv: ['--dry-run'], run, ...output });

        expect(result).toEqual({ version: '0.3.0', tag: 'v0.3.0', pushed: false });
        const text = output.lines.join('\n');
        expect(text).toContain('@pmndrs/upscaler 0.2.0 → 0.3.0 (npm dist-tag: latest)');
        expect(text).toContain('Commits since v0.2.0 (3):');
        expect(text).toContain('feat!: carry alpha unconditionally');
        expect(text).toContain('Bump: minor (a breaking change bumps minor while 0.x)');
    });

    test('uses an explicit version', () => {
        const { run } = fakeRunner();
        expect(release({ argv: ['--dry-run', '1.0.0'], run, ...capture() }).version).toBe('1.0.0');
    });

    test.each([
        ['patch', '0.2.1'],
        ['minor', '0.3.0'],
        ['major', '1.0.0'],
    ])('forces a %s bump', (spec, version) => {
        const { run } = fakeRunner();
        expect(release({ argv: ['--dry-run', spec], run, ...capture() }).version).toBe(version);
    });

    test('computes a prerelease', () => {
        const { run } = fakeRunner();
        const output = capture();
        expect(release({ argv: ['--dry-run', '--preid', 'beta'], run, ...output }).version).toBe('0.3.0-beta.0');
        expect(output.lines.join('\n')).toContain('(npm dist-tag: beta)');
    });

    test.each([
        ['nothing warrants a release', { commits: [['docs: words']] }, [], /nothing to release/],
        ['the version is not newer', {}, ['0.2.0'], /not newer/],
        ['the tag already exists', { existingTags: ['v0.3.0'] }, [], /already exists/],
    ])('refuses when %s', (_scenario, state, argv, message) => {
        const { run, calls } = fakeRunner(state);
        expect(() => release({ argv, run, ...capture() })).toThrow(message);
        expect(sideEffects(calls)).toEqual([]);
    });
});

describe('--dry-run', () => {
    test('has no side effects', () => {
        const { run, calls } = fakeRunner();
        release({ argv: ['--dry-run'], run, ...capture() });

        expect(sideEffects(calls)).toEqual([]);
        expect(calls.every((call) => call.line.startsWith('git '))).toBe(true);
    });

    test('reports, rather than stops at, what a real run would refuse', () => {
        const { run, calls } = fakeRunner({ status: '?? notes.md\n', branch: 'fix/x' });
        const output = capture();

        expect(release({ argv: ['--dry-run'], run, ...output }).version).toBe('0.3.0');
        expect(output.warnings.join('\n')).toMatch(/would refuse: the working tree is not clean/);
        expect(output.warnings.join('\n')).toMatch(/would refuse: not on main/);
        expect(sideEffects(calls)).toEqual([]);
    });
});

describe('cutting the release', () => {
    test('runs the gate, then npm version, and prints the push command without --push', () => {
        const { run, calls } = fakeRunner();
        const output = capture();

        expect(release({ argv: [], run, ...output })).toEqual({ version: '0.3.0', tag: 'v0.3.0', pushed: false });
        expect(sideEffects(calls)).toEqual([
            'npm run lint',
            'npm run typecheck',
            'npm test',
            'npm run build',
            'npm version 0.3.0 -m release: v%s [skip ci]',
        ]);
        expect(output.lines.join('\n')).toContain('git push --atomic origin main refs/tags/v0.3.0');
    });

    test('pushes main and the tag atomically with --push', () => {
        const { run, calls } = fakeRunner();

        expect(release({ argv: ['--push'], run, ...capture() }).pushed).toBe(true);
        expect(sideEffects(calls).at(-1)).toBe('git push --atomic origin main refs/tags/v0.3.0');
    });

    test('stops before tagging when the gate fails', () => {
        const { run, calls } = fakeRunner({ failOn: 'npm test' });

        expect(() => release({ argv: ['--push'], run, ...capture() })).toThrow(/npm test failed/);
        expect(sideEffects(calls).some((line) => line.startsWith('npm version'))).toBe(false);
        expect(sideEffects(calls).some((line) => line.startsWith('git push'))).toBe(false);
    });
});
