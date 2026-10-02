// Drives publish.yml's shell steps end to end against throwaway Git
// repositories (a bare "origin" plus a checkout), with fake `npm` and `gh` on
// PATH. Each step's `if:` and `env:` are read from the YAML and evaluated the
// way Actions would, so these tests break when the workflow drifts. GPU-free.
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, test } from 'vitest';

const workflow = readFileSync(
    new URL('../.github/workflows/publish.yml', import.meta.url),
    'utf8',
);
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

//* Workflow Parsing ===

/**
 * Splits the single job's steps into { name, id, if, env, run } records.
 * Only the YAML shapes publish.yml uses are understood; anything else throws.
 */
function parseSteps(text) {
    const body = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
    const chunks = body.split(/\n(?= {6}- )/);
    return chunks.map((chunk) => {
        const lines = chunk.split('\n');
        const step = { env: {} };
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].replace(/^ {6}- /, '        ');
            let match;
            if ((match = line.match(/^ {8}name: (.+)$/))) step.name = match[1];
            else if ((match = line.match(/^ {8}id: (.+)$/))) step.id = match[1];
            else if ((match = line.match(/^ {8}if: (.+)$/))) step.if = match[1];
            else if ((match = line.match(/^ {8}uses: (.+)$/))) step.uses = match[1];
            else if ((match = line.match(/^ {8}run: (?!\|)(.+)$/))) step.run = match[1];
            else if (/^ {8}run: \|$/.test(line)) {
                const script = [];
                while (index + 1 < lines.length && (lines[index + 1] === '' || /^ {10}/.test(lines[index + 1])))
                    script.push(lines[++index].slice(10));
                step.run = script.join('\n');
            } else if (/^ {8}env:$/.test(line)) {
                while (index + 1 < lines.length && /^ {10}\S/.test(lines[index + 1])) {
                    const [, key, value] = lines[++index].match(/^ {10}([A-Z_]+): (.+)$/);
                    step.env[key] = value;
                }
            }
        }
        return step;
    });
}

const steps = parseSteps(workflow);

function step(name) {
    const found = steps.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`Missing workflow step: ${name}`);
    return found;
}

/** Evaluates the handful of `${{ }}` expressions the workflow uses. */
function evaluate(expression, context) {
    const trimmed = expression.trim();
    let match;
    if ((match = trimmed.match(/^steps\.([\w-]+)\.outputs\.([\w-]+)$/)))
        return context.outputs[match[1]]?.[match[2]] ?? '';
    const values = {
        'github.event_name': context.event,
        'github.ref': context.ref,
        'inputs.tag': context.inputTag ?? '',
        'github.token': 'test-token',
        'github.repository': 'pmndrs/upscaler',
    };
    if (trimmed in values) return values[trimmed];
    throw new Error(`Unsupported workflow expression: ${trimmed}`);
}

function interpolate(value, context) {
    return value.replace(/\$\{\{(.+?)\}\}/g, (_, expression) => evaluate(expression, context));
}

function condition(expression, context) {
    if (!expression) return true;
    const match = expression.match(/^steps\.([\w-]+)\.outputs\.([\w-]+) == '([^']*)'$/);
    if (!match) throw new Error(`Unsupported workflow condition: ${expression}`);
    return (context.outputs[match[1]]?.[match[2]] ?? '') === match[3];
}

//* Fixtures ===

function git(cwd, args, input) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
}

function writePackage(directory, version) {
    writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({ name: '@pmndrs/upscaler', version }, null, 4)}\n`,
    );
}

function commit(directory, message) {
    git(directory, ['add', '-A']);
    git(directory, ['commit', '-q', '--allow-empty', '-m', message]);
    return git(directory, ['rev-parse', 'HEAD']);
}

const FAKE_NPM = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_LOG"
case "$1" in
    install|ci) exit 0 ;;
    publish)
        [[ "$NPM_PUBLISH_MODE" == "fail" ]] && { printf 'npm error code E403\\n' >&2; exit 1; }
        exit 0
        ;;
    view)
        version="\${2##*@}"
        case "$NPM_MODE" in
            published) printf '%s\\n' "$version" ;;
            absent) printf 'npm error code E404\\n' >&2; exit 1 ;;
            auth) printf 'npm error code E401\\n' >&2; exit 1 ;;
            network) printf 'npm error code ECONNRESET\\n' >&2; exit 1 ;;
            server) printf 'npm error code E500\\n' >&2; exit 1 ;;
            indeterminate) printf 'unexpected registry response\\n' >&2; exit 1 ;;
            *) printf 'unexpected NPM_MODE: %s\\n' "$NPM_MODE" >&2; exit 2 ;;
        esac
        ;;
    *) printf 'unexpected npm command: %s\\n' "$*" >&2; exit 2 ;;
esac
`;

const FAKE_GH = `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "release" && "$2" == "create" ]]; then
    printf '%s\\n' "$*" >> "$GH_LOG"
    exit 0
fi
case "$GH_MODE" in
    missing) printf 'HTTP/2.0 404 Not Found\\r\\n'; exit 1 ;;
    existing) printf 'HTTP/2.0 200 OK\\r\\n'; exit 0 ;;
    forbidden) printf 'HTTP/2.0 403 Forbidden\\r\\n' >&2; exit 1 ;;
    network) printf 'dial tcp: network unreachable\\n' >&2; exit 1 ;;
    *) printf 'unexpected GH_MODE: %s\\n' "$GH_MODE" >&2; exit 2 ;;
esac
`;

/**
 * Builds origin + a checkout. History on main:
 *   v0.2.0 (no release scripts — a legacy tag) → "ci: add release tooling"
 *   → "feat: a feature" → "release: v<version>" tagged v<version>.
 *
 * @param {{
 *   version?: string;        // version in the release commit's package.json
 *   tag?: string;            // tag name put on the release commit
 *   offMain?: boolean;       // release commit lives on a side branch, not main
 * }} options
 */
function createFixture({ version = '0.3.0', tag = `v${version}`, offMain = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'release-workflow-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const work = join(root, 'work');
    const bin = join(root, 'bin');
    const temp = join(root, 'runner-temp');
    for (const directory of [seed, bin, temp]) mkdirSync(directory);
    git(root, ['init', '-q', '--bare', '-b', 'main', origin]);

    git(seed, ['init', '-q', '-b', 'main']);
    git(seed, ['config', 'user.name', 'Workflow Test']);
    git(seed, ['config', 'user.email', 'workflow@example.test']);
    writePackage(seed, '0.2.0');
    commit(seed, 'release: v0.2.0 [skip ci]');
    git(seed, ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);

    mkdirSync(join(seed, 'scripts'));
    for (const script of ['release-notes.mjs', 'release-version.mjs'])
        copyFileSync(new URL(`./${script}`, import.meta.url), join(seed, 'scripts', script));
    commit(seed, 'ci: add release tooling');
    commit(seed, 'feat: a feature');

    if (offMain) git(seed, ['checkout', '-q', '-b', 'side']);
    writePackage(seed, version);
    commit(seed, `release: v${version}`);
    git(seed, ['tag', '-a', tag, '-m', tag]);
    if (offMain) git(seed, ['checkout', '-q', 'main']);

    git(seed, ['remote', 'add', 'origin', origin]);
    git(seed, ['push', '-q', 'origin', 'main', '--tags']);
    git(root, ['clone', '-q', origin, work]);

    writeFileSync(join(bin, 'npm'), FAKE_NPM, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
    return { root, work, bin, temp, tag };
}

function withFixture(options, callback) {
    const fixture = createFixture(options);
    try {
        return callback(fixture);
    } finally {
        rmSync(fixture.root, { recursive: true, force: true });
    }
}

function readLog(path) {
    try {
        return readFileSync(path, 'utf8').split('\n').filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Runs the job's `run:` steps in order, as Actions would after actions/checkout.
 *
 * @param {ReturnType<typeof createFixture>} fixture
 * @param {{
 *   event?: 'push' | 'workflow_dispatch';
 *   ref?: string;          // github.ref; defaults to refs/tags/<fixture tag> for a push
 *   inputTag?: string;     // workflow_dispatch input
 *   npm?: string;          // NPM_MODE for `npm view`
 *   gh?: string;           // GH_MODE for `gh api`
 *   publish?: string;      // NPM_PUBLISH_MODE: 'success' | 'fail'
 * }} [scenario]
 */
function runJob(fixture, { event = 'push', ref, inputTag, npm = 'absent', gh = 'missing', publish = 'success' } = {}) {
    const context = {
        event,
        ref: ref ?? (event === 'push' ? `refs/tags/${fixture.tag}` : 'refs/heads/main'),
        inputTag,
        outputs: {},
    };
    // actions/checkout: the pushed tag, or the dispatching branch.
    git(fixture.work, ['checkout', '-q', '--detach', context.ref.replace(/^refs\/heads\//, 'origin/')]);

    const npmLog = join(fixture.root, 'npm.log');
    const ghLog = join(fixture.root, 'gh.log');
    const executed = [];
    let failed = null;
    let output = '';
    for (const [index, current] of steps.entries()) {
        if (!current.run || !condition(current.if, context)) continue;
        const outputPath = join(fixture.root, `output-${index}`);
        writeFileSync(outputPath, '');
        const env = Object.fromEntries(
            Object.entries(current.env).map(([key, value]) => [key, interpolate(value, context)]),
        );
        expect(current.run, `${current.name ?? current.run} must not inline expressions`).not.toMatch(/\$\{\{/);
        const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', current.run], {
            cwd: fixture.work,
            encoding: 'utf8',
            env: {
                ...process.env,
                ...env,
                PATH: `${fixture.bin}:${process.env.PATH}`,
                RUNNER_TEMP: fixture.temp,
                GITHUB_OUTPUT: outputPath,
                NPM_LOG: npmLog,
                GH_LOG: ghLog,
                NPM_MODE: npm,
                GH_MODE: gh,
                NPM_PUBLISH_MODE: publish,
            },
        });
        executed.push(current.name ?? current.run);
        output += result.stdout + result.stderr;
        if (current.id)
            context.outputs[current.id] = Object.fromEntries(
                readFileSync(outputPath, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
            );
        if (result.status !== 0) {
            failed = current.name ?? current.run;
            break;
        }
    }

    const npmCalls = readLog(npmLog);
    return {
        failed,
        output,
        executed,
        outputs: context.outputs,
        publishes: npmCalls.filter((line) => line.startsWith('publish')),
        installs: npmCalls.filter((line) => line === 'ci'),
        releases: readLog(ghLog),
        notes: (() => {
            try {
                return readFileSync(join(fixture.temp, 'release-notes.md'), 'utf8');
            } catch {
                return null;
            }
        })(),
    };
}

//* Trigger ===

describe('trigger', () => {
    const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));

    test('publishes on v* tag pushes and never on branch pushes', () => {
        expect(on).toMatch(/\n {2}push:\n {4}tags: \['v\*'\]\n/);
        expect(on).not.toMatch(/branches/);
        expect(on).not.toMatch(/pull_request|schedule/);
    });

    test('allows a manual re-run that names an existing tag', () => {
        expect(on).toMatch(/workflow_dispatch:\n {4}inputs:\n {6}tag:\n/);
        expect(on).toMatch(/required: true/);
    });
});

//* Publishing ===

describe('publishing a pushed tag', () => {
    test('publishes a stable tag to latest and creates its Release', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture);

            expect(job.failed, job.output).toBeNull();
            expect(job.outputs.release).toEqual({
                tag: 'v0.3.0',
                version: '0.3.0',
                prerelease: 'false',
                dist_tag: 'latest',
                latest: 'true',
            });
            expect(job.installs).toHaveLength(1);
            expect(job.publishes).toEqual(['publish --access public --tag latest']);
            expect(job.releases).toHaveLength(1);
            expect(job.releases[0]).toMatch(/^release create v0\.3\.0 .*--verify-tag/);
            expect(job.releases[0]).toMatch(/ --latest$/);
            expect(job.notes).toContain('## Features');
            expect(job.notes).toContain('a feature');
            expect(job.notes).toContain('compare/v0.2.0...v0.3.0');
        }));

    test.each([
        ['0.3.0-beta.1', 'beta'],
        ['0.3.0-rc.0', 'rc'],
        ['0.3.0-0', 'next'],
    ])('publishes prerelease %s to dist-tag %s as a GitHub prerelease', (version, distTag) =>
        withFixture({ version }, (fixture) => {
            const job = runJob(fixture);

            expect(job.failed, job.output).toBeNull();
            expect(job.publishes).toEqual([`publish --access public --tag ${distTag}`]);
            expect(job.releases[0]).toMatch(/--prerelease --latest=false$/);
        }));

    test('creates no Release when npm publish fails', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture, { publish: 'fail' });

            expect(job.failed).toBe('Publish to npm');
            expect(job.publishes).toHaveLength(1);
            expect(job.releases).toEqual([]);
        }));
});

//* Guards ===

describe('guards', () => {
    test.each([
        ['a tag that disagrees with package.json', { version: '0.3.0', tag: 'v0.3.1' }, /names version '0\.3\.1' but package\.json at \w+ has '0\.3\.0'/],
        ['a tag on a commit that never reached main', { offMain: true }, /not on origin\/main/],
        ['a tag that is not SemVer', { tag: 'v0.3' }, /not a v-prefixed SemVer/],
        ['a v-prefixed tag that is not a version', { tag: 'vnext' }, /not a v-prefixed SemVer/],
    ])('rejects %s before publishing anything', (_scenario, options, message) =>
        withFixture(options, (fixture) => {
            const job = runJob(fixture);

            expect(job.failed).toBe('Verify release tag');
            expect(job.output).toMatch(message);
            expect(job.outputs.release).toEqual({});
            expect(job.installs).toEqual([]);
            expect(job.publishes).toEqual([]);
            expect(job.releases).toEqual([]);
        }));

    test('rejects a dispatch for a tag that does not exist', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture, { event: 'workflow_dispatch', inputTag: 'v9.9.9' });

            expect(job.failed).toBe('Verify release tag');
            expect(job.output).toMatch(/Tag v9\.9\.9 does not exist/);
            expect(job.publishes).toEqual([]);
        }));

    test('rejects a dispatch for a tag without the v prefix', () =>
        withFixture({ tag: '0.3.0' }, (fixture) => {
            const job = runJob(fixture, { event: 'workflow_dispatch', inputTag: '0.3.0' });

            expect(job.failed).toBe('Verify release tag');
            expect(job.output).toMatch(/not a v-prefixed SemVer/);
            expect(job.publishes).toEqual([]);
        }));

    test('rejects a branch push even if one were routed to it', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture, { ref: 'refs/heads/main' });

            expect(job.failed).toBe('Verify release tag');
            expect(job.output).toMatch(/only for tag pushes/);
        }));
});

//* Idempotency ===

describe('re-runs', () => {
    test('a version already on npm skips publish but still creates a missing Release', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture, { npm: 'published', gh: 'missing' });

            expect(job.failed, job.output).toBeNull();
            expect(job.output).toContain('already on npm; skipping publish');
            expect(job.installs).toEqual([]);
            expect(job.publishes).toEqual([]);
            expect(job.releases).toHaveLength(1);
        }));

    test('an existing Release is left unchanged', () =>
        withFixture({}, (fixture) => {
            const job = runJob(fixture, { npm: 'published', gh: 'existing' });

            expect(job.failed, job.output).toBeNull();
            expect(job.output).toContain('already exists; leaving it unchanged');
            expect(job.releases).toEqual([]);
        }));

    test('a dispatch repairs a legacy tag with the dispatching branch\'s scripts, without taking "latest"', () =>
        withFixture({}, (fixture) => {
            // v0.2.0's tree predates scripts/; the dispatch runs from main.
            const job = runJob(fixture, {
                event: 'workflow_dispatch',
                inputTag: 'v0.2.0',
                npm: 'published',
                gh: 'missing',
            });

            expect(job.failed, job.output).toBeNull();
            expect(git(fixture.work, ['rev-parse', 'HEAD'])).toBe(git(fixture.work, ['rev-parse', 'v0.2.0^{commit}']));
            expect(job.outputs.release.latest).toBe('false');
            expect(job.publishes).toEqual([]);
            expect(job.releases).toHaveLength(1);
            expect(job.releases[0]).toMatch(/^release create v0\.2\.0 .* --latest=false$/);
        }));

    test.each(['auth', 'network', 'server', 'indeterminate'])(
        'an npm %s failure stops the run instead of publishing',
        (mode) =>
            withFixture({}, (fixture) => {
                const job = runJob(fixture, { npm: mode });

                expect(job.failed).toBe('Check npm for this version');
                expect(job.output).toMatch(/unable to determine whether .* exists on npm/i);
                expect(job.publishes).toEqual([]);
                expect(job.releases).toEqual([]);
            }),
    );

    test.each(['forbidden', 'network'])(
        'a GitHub %s failure creates no Release',
        (mode) =>
            withFixture({}, (fixture) => {
                const job = runJob(fixture, { npm: 'published', gh: mode });

                expect(job.failed).toBe('Create GitHub Release');
                expect(job.releases).toEqual([]);
            }),
    );
});

//* Structure ===

describe('workflow structure', () => {
    test('keeps one least-privilege job on OIDC, with no token secrets', () => {
        const jobs = workflow.match(/^ {2}[A-Za-z0-9_-]+:\n {4}runs-on:/gm) ?? [];

        expect(jobs).toHaveLength(1);
        expect(workflow).toMatch(/permissions:\n {2}contents: write.*\n {2}id-token: write/);
        expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|personal.access.token|secrets\./i);
    });

    test('never writes to the repository beyond the Release', () => {
        for (const current of steps) {
            expect(current.run ?? '').not.toMatch(/\bgit (push|tag|commit)\b/);
            expect(current.run ?? '').not.toMatch(/\bnpm version\b/);
        }
        expect(workflow).not.toContain('[skip ci]');
    });

    test('writes release notes outside the checkout', () => {
        expect(step('Generate GitHub Release notes').run).toContain('> "$RUNNER_TEMP/release-notes.md"');
        expect(step('Create GitHub Release').run).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    });
});

describe('npm version parity', () => {
    test('CI runs the same pinned npm that publishes', () => {
        const spec = (text) => text.match(/npm install -g (npm@\S+)/)?.[1];

        expect(spec(workflow)).toBeDefined();
        expect(spec(workflow)).not.toBe('npm@latest');
        expect(spec(ci)).toBe(spec(workflow));
    });
});
