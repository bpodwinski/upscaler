// Cuts a release locally: `npm run release` on an up-to-date main computes the
// next version from Conventional Commits, runs the gate, then creates the
// `release: vX.Y.Z` commit and annotated tag with `npm version`. Pushing the tag
// is what publishes (.github/workflows/publish.yml); merges to main never do.
//
//   npm run release                  # version from commits; prints the push command
//   npm run release -- 0.3.0         # explicit version
//   npm run release -- --preid beta  # prerelease: 0.3.0-beta.0, then -beta.1, …
//   npm run release -- --push        # also push main + the tag (publishes)
//   npm run release -- --dry-run     # compute and print only
//
// GPU-free. Every git/npm call goes through an injected runner so the tests can
// drive it without a repository or network.
import { execFileSync } from 'node:child_process';

import { isDirectRun, parseSemVer } from './release-notes.mjs';
import { assertNewer, computeNextVersion, distTagFor } from './release-version.mjs';

const BRANCH = 'main';
const REMOTE = 'origin';
const GATE = [
    ['run', 'lint'],
    ['run', 'typecheck'],
    ['test'],
    ['run', 'build'],
];
const USAGE = `Usage: npm run release -- [version] [--preid <id>] [--push] [--dry-run]

  version        Release exactly this version (e.g. 0.3.0) instead of computing it.
  --preid <id>   Cut a prerelease (e.g. beta → 0.3.0-beta.0); publishes to that dist-tag.
  --push         Push ${BRANCH} and the new tag to ${REMOTE}. Pushing the tag publishes.
  --dry-run      Compute and print the version; change nothing.`;

/**
 * Parses the CLI arguments.
 *
 * @param {string[]} argv
 * @returns {{ version?: string; preid?: string; push: boolean; dryRun: boolean; help: boolean }}
 */
export function parseReleaseArgs(argv) {
    const options = { push: false, dryRun: false, help: false };
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--push') options.push = true;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--preid') {
            const value = argv[++index];
            if (!value || value.startsWith('-')) throw new Error('--preid needs a value, e.g. --preid beta');
            options.preid = value;
        } else if (arg.startsWith('--preid=')) options.preid = arg.slice('--preid='.length);
        else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
        else if (options.version) throw new Error(`Only one version may be given (got ${options.version} and ${arg}).`);
        else {
            const version = arg.replace(/^v/, '');
            parseSemVer(version);
            options.version = version;
        }
    }
    if (options.version && options.preid)
        throw new Error('Pass either an explicit version or --preid, not both.');
    if (options.push && options.dryRun) throw new Error('--push and --dry-run are mutually exclusive.');
    return options;
}

/**
 * Returns why the checkout can't be released from (empty when it can).
 *
 * Fetches `origin main` and its tags first so "up to date" is current.
 *
 * @param {(command: string, args: string[]) => string} run
 * @returns {string[]}
 */
export function checkPreconditions(run) {
    const problems = [];
    if (run('git', ['status', '--porcelain']).trim() !== '')
        problems.push('the working tree is not clean (commit or stash your changes first)');

    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch !== BRANCH) problems.push(`not on ${BRANCH} (on ${branch}); releases are cut from ${BRANCH}`);

    run('git', ['fetch', '--quiet', '--tags', REMOTE, BRANCH]);
    const [ahead, behind] = run('git', ['rev-list', '--left-right', '--count', `HEAD...${REMOTE}/${BRANCH}`])
        .trim()
        .split(/\s+/)
        .map(Number);
    if (behind > 0) problems.push(`behind ${REMOTE}/${BRANCH} by ${behind} commit(s); pull first`);
    if (ahead > 0)
        problems.push(
            `ahead of ${REMOTE}/${BRANCH} by ${ahead} unpushed commit(s); a release tags what is already on ${REMOTE}/${BRANCH}`,
        );
    return problems;
}

/**
 * Runs the release flow.
 *
 * @param {{
 *   argv: string[];
 *   run: (command: string, args: string[], options?: { inherit?: boolean }) => string;
 *   log?: (line: string) => void;
 *   warn?: (line: string) => void;
 * }} context
 * @returns {{ version: string; tag: string; pushed: boolean } | null}
 *   The release cut (or that would be cut, on a dry run); null for --help.
 * @throws {Error} When a precondition fails, nothing warrants a release, or a step fails.
 */
export function release({ argv, run, log = console.log, warn = console.warn }) {
    const options = parseReleaseArgs(argv);
    if (options.help) {
        log(USAGE);
        return null;
    }

    //* Preconditions ===
    // A dry run reports what a real run would refuse instead of stopping, so the
    // version can be previewed from any branch.
    const problems = checkPreconditions(run);
    if (problems.length && !options.dryRun)
        throw new Error(`Refusing to release:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    for (const problem of problems) warn(`warning: a real run would refuse: ${problem}`);

    //* Version ===
    const runGit = (args) => run('git', args);
    const packageJson = JSON.parse(runGit(['show', 'HEAD:package.json']));
    const computed = computeNextVersion({ runGit, packageVersion: packageJson.version, preid: options.preid });
    const version = options.version ?? computed.version;
    if (!version)
        throw new Error(
            `No feat/fix/perf or breaking commits since ${computed.previousTag ?? 'the first commit'}; nothing to release.\n` +
                'Pass an explicit version (npm run release -- X.Y.Z) to release anyway.',
        );
    assertNewer(version, packageJson.version);
    const tag = `v${version}`;
    if (run('git', ['tag', '--list', tag]).trim() !== '') throw new Error(`Tag ${tag} already exists.`);

    log(`${packageJson.name} ${packageJson.version} → ${version} (npm dist-tag: ${distTagFor(version)})`);
    log(`Commits since ${computed.previousTag ?? 'the first commit'} (${computed.commits.length}):`);
    for (const commit of computed.commits) log(`  ${commit.sha.slice(0, 7)} ${commit.subject}`);
    log(
        options.version
            ? `Version given explicitly (commits alone would give ${computed.version ?? 'no release'}).`
            : computed.level === 'major' && packageJson.version.startsWith('0.')
              ? 'Bump: minor (a breaking change bumps minor while 0.x)'
              : `Bump: ${computed.level}`,
    );

    const pushArgs = ['push', '--atomic', REMOTE, BRANCH, `refs/tags/${tag}`];
    if (options.dryRun) {
        log('');
        log('Dry run: nothing was changed. A real run would:');
        log(`  1. run the gate: ${GATE.map((args) => `npm ${args.join(' ')}`).join(' && ')}`);
        log(`  2. npm version ${version} -m "release: v%s"   (commit + annotated tag ${tag})`);
        log(`  3. with --push: git ${pushArgs.join(' ')}   (publishes)`);
        return { version, tag, pushed: false };
    }

    //* Gate ===
    for (const args of GATE) run('npm', args, { inherit: true });

    //* Commit + Tag ===
    run('npm', ['version', version, '-m', 'release: v%s'], { inherit: true });

    //* Push ===
    if (options.push) {
        run('git', pushArgs, { inherit: true });
        log(`Pushed ${BRANCH} and ${tag}; publish.yml is now publishing ${version}.`);
        return { version, tag, pushed: true };
    }
    log('');
    log(`Created ${tag}. Nothing is published until you push it:`);
    log(`  git ${pushArgs.join(' ')}`);
    return { version, tag, pushed: false };
}

/**
 * Runs a command, returning stdout, or streaming it when `inherit` is set.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ inherit?: boolean }} [options]
 * @returns {string}
 */
function runCommand(command, args, { inherit = false } = {}) {
    if (inherit) {
        execFileSync(command, args, { stdio: 'inherit' });
        return '';
    }
    return execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
    });
}

function main() {
    try {
        release({ argv: process.argv.slice(2), run: runCommand });
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

if (isDirectRun(import.meta.url)) main();
