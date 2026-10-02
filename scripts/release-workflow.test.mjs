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

function stepBody(name) {
    const marker = `      - name: ${name}`;
    const start = workflow.indexOf(marker);
    if (start === -1) throw new Error(`Missing workflow step: ${name}`);

    const next = workflow.indexOf('\n      - ', start + marker.length);
    return workflow.slice(start, next === -1 ? workflow.length : next);
}

function stepScript(name) {
    const step = stepBody(name);
    const marker = '        run: |\n';
    const start = step.indexOf(marker);
    if (start === -1) throw new Error(`Missing run script: ${name}`);

    return step
        .slice(start + marker.length)
        .split('\n')
        .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
        .join('\n');
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: 'utf8',
        ...options,
    });
    if (result.status !== 0)
        throw new Error(
            `${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`,
        );
    return result.stdout.trim();
}

function writePackage(directory, version) {
    writeFileSync(
        join(directory, 'package.json'),
        `${JSON.stringify({ name: '@pmndrs/upscaler', version }, null, 4)}\n`,
    );
}

function createFixture({
    child = false,
    childSubject = 'release: v0.3.0 [skip ci]',
    currentTag = false,
    grandchild = false,
    unrelated = false,
} = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'release-workflow-'));
    const binDirectory = join(directory, 'bin');
    const scriptsDirectory = join(directory, 'scripts');
    mkdirSync(binDirectory);
    mkdirSync(scriptsDirectory);
    copyFileSync(
        new URL('./release-notes.mjs', import.meta.url),
        join(scriptsDirectory, 'release-notes.mjs'),
    );

    writePackage(directory, '0.2.0');
    run('git', ['init', '-q'], { cwd: directory });
    run('git', ['config', 'user.name', 'Workflow Test'], { cwd: directory });
    run('git', ['config', 'user.email', 'workflow@example.test'], {
        cwd: directory,
    });
    run('git', ['add', 'package.json'], { cwd: directory });
    run('git', ['commit', '-q', '-m', 'feat: trigger release'], { cwd: directory });
    const triggerCommit = run('git', ['rev-parse', 'HEAD'], { cwd: directory });
    if (currentTag) run('git', ['tag', 'v0.2.0'], { cwd: directory });

    if (child || grandchild) {
        if (grandchild) {
            writeFileSync(join(directory, 'intermediate.txt'), 'intermediate\n');
            run('git', ['add', 'intermediate.txt'], { cwd: directory });
            run('git', ['commit', '-q', '-m', 'chore: intermediate commit'], {
                cwd: directory,
            });
        }

        writePackage(directory, '0.3.0');
        run('git', ['add', 'package.json'], { cwd: directory });
        run('git', ['commit', '-q', '-m', childSubject], { cwd: directory });
        run('git', ['tag', 'v0.3.0'], { cwd: directory });
        run('git', ['checkout', '-q', '--detach', triggerCommit], { cwd: directory });
    }

    if (unrelated) {
        const packageJson = `${JSON.stringify(
            { name: '@pmndrs/upscaler', version: '0.3.0' },
            null,
            4,
        )}\n`;
        const blob = run('git', ['hash-object', '-w', '--stdin'], {
            cwd: directory,
            input: packageJson,
        });
        const tree = run('git', ['mktree'], {
            cwd: directory,
            input: `100644 blob ${blob}\tpackage.json\n`,
        });
        const commit = run('git', ['commit-tree', tree], {
            cwd: directory,
            input: `${childSubject}\n`,
        });
        run('git', ['tag', 'v0.3.0', commit], { cwd: directory });
    }

    const npmPath = join(binDirectory, 'npm');
    writeFileSync(
        npmPath,
        `#!/usr/bin/env bash
set -euo pipefail
version="\${2##*@}"

case "$NPM_MODE" in
    published)
        printf '%s\\n' "$version"
        ;;
    absent)
        printf 'npm error code E404\\n' >&2
        exit 1
        ;;
    auth)
        printf 'npm error code E401\\n' >&2
        exit 1
        ;;
    network)
        printf 'npm error code ECONNRESET\\n' >&2
        exit 1
        ;;
    server)
        printf 'npm error code E500\\n' >&2
        exit 1
        ;;
    indeterminate)
        printf 'unexpected registry response\\n' >&2
        exit 1
        ;;
    *)
        printf 'unexpected NPM_MODE: %s\\n' "$NPM_MODE" >&2
        exit 2
        ;;
esac
`,
        { mode: 0o755 },
    );

    const gitPath = join(binDirectory, 'git');
    writeFileSync(
        gitPath,
        `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "push" && "$GIT_PUSH_MODE" == "fail" ]]; then
    printf 'remote tag push rejected\\n' >&2
    exit 1
fi
exec "$REAL_GIT" "$@"
`,
        { mode: 0o755 },
    );

    const ghPath = join(binDirectory, 'gh');
    writeFileSync(
        ghPath,
        `#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "release" && "$2" == "create" ]]; then
    printf 'create\\n' >> "$GH_LOG"
    exit 0
fi

case "$GH_MODE" in
    missing)
        printf 'HTTP/2.0 404 Not Found\\r\\n'
        exit 1
        ;;
    existing)
        printf 'HTTP/2.0 200 OK\\r\\n'
        exit 0
        ;;
    forbidden)
        printf 'HTTP/2.0 403 Forbidden\\r\\n' >&2
        exit 1
        ;;
    network)
        printf 'dial tcp: network unreachable\\n' >&2
        exit 1
        ;;
    *)
        printf 'unexpected GH_MODE: %s\\n' "$GH_MODE" >&2
        exit 2
        ;;
esac
`,
        { mode: 0o755 },
    );

    return {
        directory,
        outputPath: join(directory, 'github-output'),
        ghLogPath: join(directory, 'gh.log'),
        env: {
            ...process.env,
            PATH: `${binDirectory}:${process.env.PATH}`,
            GH_TOKEN: 'test-token',
            REPOSITORY: 'pmndrs/upscaler',
            GITHUB_OUTPUT: join(directory, 'github-output'),
            GH_LOG: join(directory, 'gh.log'),
            REAL_GIT: run('sh', ['-c', 'command -v git']),
        },
    };
}

function executeScript(script, fixture, environment = {}) {
    return spawnSync(
        'bash',
        ['-e', '-o', 'pipefail', '-c', script],
        {
            cwd: fixture.directory,
            env: {
                ...fixture.env,
                RUNNER_TEMP: fixture.directory,
                PATH_A_VERSION: '',
                PATH_B_VERSION: '',
                GH_MODE: 'missing',
                NPM_MODE: 'published',
                GIT_PUSH_MODE: 'success',
                ...environment,
            },
            encoding: 'utf8',
        },
    );
}

function executeStep(name, fixture, environment = {}) {
    return executeScript(stepScript(name), fixture, environment);
}

function readOutputs(fixture) {
    try {
        return Object.fromEntries(
            readFileSync(fixture.outputPath, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => {
                    const separator = line.indexOf('=');
                    return [line.slice(0, separator), line.slice(separator + 1)];
                }),
        );
    } catch {
        return {};
    }
}

function withFixture(options, callback) {
    const fixture = createFixture(options);
    try {
        return callback(fixture);
    } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
    }
}

describe('release resolver behavior', () => {
    test.each([
        ['an unrelated tagged commit', { unrelated: true }],
        ['a tagged grandchild', { grandchild: true }],
        ['an ordinary tagless push', {}],
    ])('does not resolve %s without a publish output', (_scenario, options) =>
        withFixture(options, (fixture) => {
            const result = executeStep('Resolve GitHub Release target', fixture, {
                GH_MODE: 'missing',
            });

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain('No GitHub Release is due.');
            expect(readOutputs(fixture)).toEqual({});
            expect(() => readFileSync(fixture.ghLogPath, 'utf8')).toThrow();
        }));

    test('resolves a Path B direct-child release for the emitted version', () =>
        withFixture({ child: true }, (fixture) => {
            const result = executeStep('Resolve GitHub Release target', fixture, {
                PATH_B_VERSION: '0.3.0',
                GH_MODE: 'missing',
            });

            expect(result.status, result.stderr).toBe(0);
            expect(readOutputs(fixture)).toMatchObject({
                version: '0.3.0',
                tag: 'v0.3.0',
            });
        }));

    test('passes an existing Path B direct-child Release to the idempotent finalizer', () =>
        withFixture({ child: true }, (fixture) => {
            const resolver = executeStep(
                'Resolve GitHub Release target',
                fixture,
                {
                    PATH_B_VERSION: '0.3.0',
                    GH_MODE: 'existing',
                },
            );
            expect(resolver.status, resolver.stderr).toBe(0);

            const release = executeStep('Create GitHub Release', fixture, {
                VERSION: '0.3.0',
                TAG: 'v0.3.0',
                PRERELEASE: 'false',
                GH_MODE: 'existing',
            });
            expect(release.status, release.stderr).toBe(0);
            expect(release.stdout).toContain('already exists');
            expect(() => readFileSync(fixture.ghLogPath, 'utf8')).toThrow();
        }));

    test('rejects a Path B output whose child identity is invalid', () =>
        withFixture(
            { child: true, childSubject: 'release: v0.3.0' },
            (fixture) => {
                const result = executeStep(
                    'Resolve GitHub Release target',
                    fixture,
                    {
                        PATH_B_VERSION: '0.3.0',
                    },
                );

                expect(result.status).not.toBe(0);
                expect(readOutputs(fixture)).toEqual({});
            },
        ));

    test('fails rather than guessing between current and child repair identities', () =>
        withFixture({ child: true, currentTag: true }, (fixture) => {
            const result = executeStep('Resolve GitHub Release target', fixture, {
                GH_MODE: 'missing',
            });

            expect(result.status).not.toBe(0);
            expect(result.stdout + result.stderr).toMatch(/ambiguous|more than one/i);
            expect(readOutputs(fixture)).toEqual({});
        }));

    test('resolves a confirmed npm version after an explicit GitHub 404', () =>
        withFixture({ currentTag: true }, (fixture) => {
            const result = executeStep('Resolve GitHub Release target', fixture, {
                GH_MODE: 'missing',
                NPM_MODE: 'published',
            });

            expect(result.status, result.stderr).toBe(0);
            expect(readOutputs(fixture).version).toBe('0.2.0');
        }));

    test('does not repair a version explicitly absent from npm', () =>
        withFixture({ currentTag: true }, (fixture) => {
            const result = executeStep('Resolve GitHub Release target', fixture, {
                NPM_MODE: 'absent',
            });

            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toContain('No GitHub Release is due.');
            expect(readOutputs(fixture)).toEqual({});
        }));

    test.each(['auth', 'network', 'server', 'indeterminate'])(
        'propagates an npm %s failure while checking repair state',
        (mode) =>
            withFixture({ currentTag: true }, (fixture) => {
                const result = executeStep(
                    'Resolve GitHub Release target',
                    fixture,
                    {
                        NPM_MODE: mode,
                    },
                );

                expect(result.status).not.toBe(0);
                expect(result.stdout + result.stderr).toMatch(
                    /unable to determine whether .* exists on npm/i,
                );
                expect(readOutputs(fixture)).toEqual({});
            }),
    );

    test.each(['forbidden', 'network'])(
        'propagates a GitHub %s failure while checking repair state',
        (mode) =>
            withFixture({ child: true }, (fixture) => {
                const result = executeStep(
                    'Resolve GitHub Release target',
                    fixture,
                    {
                        GH_MODE: mode,
                    },
                );

                expect(result.status).not.toBe(0);
                expect(readOutputs(fixture)).toEqual({});
            }),
    );

    test('creates a Release only after an explicit GitHub 404', () =>
        withFixture({ currentTag: true }, (fixture) => {
            const result = executeStep('Create GitHub Release', fixture, {
                VERSION: '0.2.0',
                TAG: 'v0.2.0',
                PRERELEASE: 'false',
                GH_MODE: 'missing',
            });

            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(fixture.ghLogPath, 'utf8')).toBe('create\n');
        }));

    test.each(['forbidden', 'network'])(
        'does not create a Release after a GitHub %s failure',
        (mode) =>
            withFixture({ currentTag: true }, (fixture) => {
                const result = executeStep('Create GitHub Release', fixture, {
                    VERSION: '0.2.0',
                    TAG: 'v0.2.0',
                    PRERELEASE: 'false',
                    GH_MODE: mode,
                });

                expect(result.status).not.toBe(0);
                expect(() => readFileSync(fixture.ghLogPath, 'utf8')).toThrow();
            }),
    );
});

describe('publish outputs', () => {
    test('manual publication exposes its version only after npm succeeds', () => {
        const step = stepBody('Publish (manual version)');

        expect(step).toContain('id: publish_manual');
        expect(step.indexOf('npm publish')).toBeLessThan(
            step.indexOf('version=$VERSION'),
        );
        expect(step).toContain('>> "$GITHUB_OUTPUT"');
    });

    test('automatic publication exposes its version only after tag push completes', () => {
        const step = stepBody('Publish (auto-bump)');
        const outputs = [...step.matchAll(/version=\$NEXT/g)].map(
            (match) => match.index,
        );

        expect(step).toContain('id: publish_auto');
        expect(outputs).toHaveLength(2);
        expect(step.indexOf('git push origin "v$NEXT"')).toBeLessThan(outputs[0]);
        expect(step).not.toContain('git push origin "v$NEXT" || true');
        expect(step.indexOf('npm version "$NEXT"')).toBeLessThan(
            step.indexOf('npm publish --access public'),
        );
        expect(step.indexOf('npm publish --access public')).toBeLessThan(
            step.indexOf('git push origin HEAD:main --follow-tags'),
        );
        expect(step.indexOf('git push origin HEAD:main --follow-tags')).toBeLessThan(
            outputs[1],
        );
    });

    test('does not expose the recovery version when its remote tag push fails', () =>
        withFixture({}, (fixture) => {
            const script = stepScript('Publish (auto-bump)').replace(
                '${{ steps.next.outputs.version }}',
                '0.3.0',
            );
            const result = executeScript(script, fixture, {
                GIT_PUSH_MODE: 'fail',
            });

            expect(result.status).not.toBe(0);
            expect(readOutputs(fixture)).toEqual({});
        }));
});

describe('release target resolution', () => {
    test('runs after both publish paths and resolves manual before automatic output', () => {
        const resolver = stepBody('Resolve GitHub Release target');
        const resolverIndex = workflow.indexOf(
            '      - name: Resolve GitHub Release target',
        );

        expect(resolverIndex).toBeGreaterThan(
            workflow.indexOf('      - name: Publish (manual version)'),
        );
        expect(resolverIndex).toBeGreaterThan(
            workflow.indexOf('      - name: Publish (auto-bump)'),
        );
        expect(resolver.indexOf('PATH_A_VERSION')).toBeLessThan(
            resolver.indexOf('PATH_B_VERSION'),
        );
        expect(resolver).toContain('id: release_target');
    });

    test('verifies successful targets against the existing tag at HEAD', () => {
        const resolver = stepBody('Resolve GitHub Release target');

        expect(resolver).toContain('git rev-parse --verify');
        expect(resolver).toContain('"$tag^{commit}"');
        expect(resolver).toContain('git rev-parse HEAD');
        expect(resolver).not.toMatch(/\bgit tag\s+(?!--list)/);
        expect(resolver).not.toMatch(/\bgit push\b/);
    });

    test('requires the complete current-tag repair identity', () => {
        const resolver = stepBody('Resolve GitHub Release target');

        expect(resolver).toContain('package.json');
        expect(resolver).toContain('npm view "$NAME@$version" version');
        expect(resolver).toContain('gh api --include --method GET');
        expect(resolver).toContain('"$status" == "404"');
        expect(resolver).toContain('"$tag_commit" == "$head_commit"');
    });

    test('requires the exact single-parent automatic release child identity', () => {
        const resolver = stepBody('Resolve GitHub Release target');

        expect(resolver).toContain('release: v$version [skip ci]');
        expect(resolver).toContain('git show -s --format=%P');
        expect(resolver).toContain('parents');
        expect(resolver).toContain('"${#parent_list[@]}" -eq 1');
        expect(resolver).toContain('"${parent_list[0]}" == "$head_commit"');
        expect(resolver).toContain('"$tagged_version" == "$version"');
        expect(resolver).toContain('candidates');
        expect(resolver).toMatch(/more than one|multiple/i);
    });

    test('strictly validates versions before constructing tags or npm specs', () => {
        const resolver = stepBody('Resolve GitHub Release target');
        const run = resolver.slice(resolver.indexOf('        run: |'));

        expect(resolver).toContain('parseSemVer');
        expect(resolver).toContain('VERSION_TO_VALIDATE');
        expect(run).not.toMatch(/\$\{\{\s*steps\.[^}]+\}\}/);
    });

    test('classifies prereleases from parsed SemVer identifiers', () => {
        const resolver = stepBody('Resolve GitHub Release target');

        expect(resolver).toContain('.prerelease.length');
        expect(resolver).not.toContain('[[ "$version" == *-* ]]');
    });
});

describe('append-only GitHub Release finalizer', () => {
    test('skips notes and release creation when no target is due', () => {
        const notes = stepBody('Generate GitHub Release notes');
        const release = stepBody('Create GitHub Release');

        expect(notes).toContain(
            "if: steps.release_target.outputs.version != ''",
        );
        expect(release).toContain(
            "if: steps.release_target.outputs.version != ''",
        );
    });

    test('writes notes outside the checkout', () => {
        const notes = stepBody('Generate GitHub Release notes');
        const release = stepBody('Create GitHub Release');

        expect(notes).toContain('node scripts/release-notes.mjs --tag "$TAG"');
        expect(notes).toContain('> "$RUNNER_TEMP/release-notes.md"');
        expect(release).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    });

    test('leaves an existing release untouched', () => {
        const release = stepBody('Create GitHub Release');

        expect(release).toContain('gh api --include --method GET');
        expect(release.indexOf('github_release_state "$TAG"')).toBeLessThan(
            release.indexOf('gh release create "$TAG"'),
        );
        expect(release).toMatch(/already exists[\s\S]*exit 0/);
    });

    test('creates only verified stable or prerelease releases', () => {
        const release = stepBody('Create GitHub Release');

        expect(release).toContain('gh release create "$TAG"');
        expect(release).toContain('--verify-tag');
        expect(release).toContain('--latest');
        expect(release).toContain('--prerelease');
        expect(release).toContain('--latest=false');
        expect(release).not.toMatch(/\bgit tag\b/);
        expect(release).not.toMatch(/\bgit push\b/);
    });

    test('uses the workflow token and retains one least-privilege publish job', () => {
        const resolver = stepBody('Resolve GitHub Release target');
        const release = stepBody('Create GitHub Release');
        const jobs =
            workflow.match(/^ {2}[A-Za-z0-9_-]+:\n {4}runs-on:/gm) ?? [];

        expect(resolver).toContain('GH_TOKEN: ${{ github.token }}');
        expect(release).toContain('GH_TOKEN: ${{ github.token }}');
        expect(workflow).toContain('contents: write');
        expect(workflow).toContain('id-token: write');
        expect(workflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|personal.access.token/i);
        expect(jobs).toHaveLength(1);
    });
});

describe('npm version parity', () => {
    test('CI runs the same pinned npm that publishes', () => {
        const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
        const spec = (text) => text.match(/npm install -g (npm@\S+)/)?.[1];

        expect(spec(workflow)).toBeDefined();
        expect(spec(workflow)).not.toBe('npm@latest');
        expect(spec(ci)).toBe(spec(workflow));
    });
});
