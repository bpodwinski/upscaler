import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPOSITORY_URL = 'https://github.com/pmndrs/upscaler';
const GIT_LOG_FORMAT = '%H%x00%s%x00%b';
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SECTION_ORDER = [
    'Breaking Changes',
    'Features',
    'Fixes',
    'Performance',
];

/**
 * Parses a SemVer value while retaining numeric identifiers as strings.
 *
 * String identifiers avoid precision loss when versions exceed JavaScript's
 * safe integer range.
 *
 * @param {string} value
 * @returns {{
 *   major: string;
 *   minor: string;
 *   patch: string;
 *   prerelease: string[];
 *   build: string[];
 * }}
 */
export function parseSemVer(value) {
    const match =
        typeof value === 'string'
            ? value.match(
                  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
              )
            : null;
    if (!match) throw new Error(`Invalid SemVer: ${String(value)}`);

    const prerelease = match[4]?.split('.') ?? [];
    if (prerelease.some((identifier) => /^\d+$/.test(identifier) && /^0\d/.test(identifier)))
        throw new Error(`Invalid SemVer: ${value}`);

    return {
        major: match[1],
        minor: match[2],
        patch: match[3],
        prerelease,
        build: match[5]?.split('.') ?? [],
    };
}

/**
 * Compares non-negative integer strings without floating-point conversion.
 *
 * @param {string} left
 * @param {string} right
 * @returns {-1 | 0 | 1}
 */
function compareNumericIdentifier(left, right) {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

/**
 * Compares two SemVer values according to SemVer precedence.
 *
 * @param {string | ReturnType<typeof parseSemVer>} left
 * @param {string | ReturnType<typeof parseSemVer>} right
 * @returns {-1 | 0 | 1}
 */
export function compareSemVer(left, right) {
    const a = typeof left === 'string' ? parseSemVer(left) : left;
    const b = typeof right === 'string' ? parseSemVer(right) : right;

    for (const field of ['major', 'minor', 'patch']) {
        const result = compareNumericIdentifier(a[field], b[field]);
        if (result !== 0) return result;
    }

    if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
    if (a.prerelease.length === 0) return 1;
    if (b.prerelease.length === 0) return -1;

    const identifierCount = Math.max(a.prerelease.length, b.prerelease.length);
    for (let index = 0; index < identifierCount; index++) {
        const aIdentifier = a.prerelease[index];
        const bIdentifier = b.prerelease[index];
        if (aIdentifier === undefined) return -1;
        if (bIdentifier === undefined) return 1;
        if (aIdentifier === bIdentifier) continue;

        const aNumeric = /^\d+$/.test(aIdentifier);
        const bNumeric = /^\d+$/.test(bIdentifier);
        if (aNumeric && bNumeric)
            return compareNumericIdentifier(aIdentifier, bIdentifier);
        if (aNumeric) return -1;
        if (bNumeric) return 1;
        return aIdentifier < bIdentifier ? -1 : 1;
    }

    return 0;
}

/**
 * Selects the comparison tag for a target release.
 *
 * Stable releases compare with the highest prior stable tag. Prereleases
 * compare with the highest prior tag of either kind.
 *
 * @param {string} targetVersion
 * @param {string[]} reachableTags
 * @returns {string | null}
 */
export function selectPreviousTag(targetVersion, reachableTags) {
    const target = parseSemVer(targetVersion);
    const stableTarget = target.prerelease.length === 0;
    const candidates = [];

    for (const tag of reachableTags) {
        if (typeof tag !== 'string' || !tag.startsWith('v')) continue;

        let version;
        try {
            version = parseSemVer(tag);
        } catch {
            continue;
        }

        if (compareSemVer(version, target) >= 0) continue;
        if (stableTarget && version.prerelease.length > 0) continue;
        candidates.push({ tag, version });
    }

    candidates.sort((a, b) => compareSemVer(b.version, a.version));
    return candidates[0]?.tag ?? null;
}

/**
 * Parses and classifies one commit for release-note rendering.
 *
 * @param {string | { subject: string; body?: string }} commit
 * @returns {{
 *   type: string;
 *   scope: string | undefined;
 *   description: string;
 *   breaking: boolean;
 *   category: 'Breaking Changes' | 'Features' | 'Fixes' | 'Performance';
 * } | null}
 */
export function parseConventionalCommit(commit) {
    const normalized =
        typeof commit === 'string'
            ? {
                  subject: commit.split(/\r?\n/, 1)[0],
                  body: commit.split(/\r?\n/).slice(1).join('\n'),
              }
            : {
                  subject: commit?.subject ?? '',
                  body: commit?.body ?? '',
              };
    const match = normalized.subject.match(
        /^([a-z][a-z0-9-]*)(?:\(([^()\r\n]+)\))?(!)?:\s*(\S.*)$/,
    );
    if (!match) return null;

    const [, type, scope, marker, description] = match;
    const breaking = marker === '!' || /(^|\n)BREAKING CHANGE:\s*\S/.test(normalized.body);
    let category;
    if (breaking) category = 'Breaking Changes';
    else if (type === 'feat') category = 'Features';
    else if (type === 'fix') category = 'Fixes';
    else if (type === 'perf') category = 'Performance';
    else return null;

    return { type, scope, description, breaking, category };
}

/**
 * Renders deterministic Markdown notes from collected release data.
 *
 * @param {{
 *   tag: string;
 *   previousTag: string | null;
 *   repositoryUrl?: string;
 *   commits: Array<{ sha: string; subject: string; body?: string }>;
 * }} release
 * @returns {string}
 */
export function renderReleaseNotes(release) {
    const repositoryUrl = (release.repositoryUrl ?? DEFAULT_REPOSITORY_URL).replace(
        /\/$/,
        '',
    );
    const sections = new Map(SECTION_ORDER.map((section) => [section, []]));

    for (const commit of release.commits) {
        const parsed = parseConventionalCommit(commit);
        if (!parsed) continue;

        const scope = parsed.scope ? `**${parsed.scope}:** ` : '';
        const shortSha = commit.sha.slice(0, 7);
        sections
            .get(parsed.category)
            .push(
                `- ${scope}${parsed.description}\n  ([${shortSha}](${repositoryUrl}/commit/${commit.sha}))`,
            );
    }

    const blocks = [];
    for (const section of SECTION_ORDER) {
        const bullets = sections.get(section);
        if (bullets.length > 0) blocks.push(`## ${section}\n\n${bullets.join('\n')}`);
    }
    if (release.previousTag)
        blocks.push(
            `**Full Changelog:** ${repositoryUrl}/compare/${release.previousTag}...${release.tag}`,
        );

    return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}

/**
 * Runs a read-only Git query without invoking a shell.
 *
 * @param {string[]} args
 * @param {typeof execFileSync} [execute]
 * @returns {string}
 */
export function runGit(args, execute = execFileSync) {
    return execute('git', args, {
        encoding: 'utf8',
        maxBuffer: GIT_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * Rejects values that cannot identify a release tag.
 *
 * @param {unknown} tag
 * @returns {asserts tag is string}
 */
function assertReleaseTag(tag) {
    if (typeof tag !== 'string' || !tag.startsWith('v'))
        throw new Error(`Expected a v-prefixed SemVer tag, received: ${String(tag)}`);
    try {
        parseSemVer(tag);
    } catch {
        throw new Error(`Expected a v-prefixed SemVer tag, received: ${tag}`);
    }
}

/**
 * Collects the reachable tags and commits needed to render one release.
 *
 * @param {string} tag
 * @param {{
 *   runGit?: (args: string[]) => string;
 *   repositoryUrl?: string;
 * }} [options]
 * @returns {{
 *   tag: string;
 *   previousTag: string | null;
 *   repositoryUrl: string;
 *   commits: Array<{ sha: string; subject: string; body: string }>;
 * }}
 */
export function collectReleaseData(
    tag,
    { runGit: runGitCommand = runGit, repositoryUrl = DEFAULT_REPOSITORY_URL } = {},
) {
    assertReleaseTag(tag);

    runGitCommand(['rev-parse', '--verify', `${tag}^{commit}`]);
    const reachableTags = runGitCommand([
        'tag',
        '--merged',
        tag,
        '--list',
        'v*',
    ])
        .split(/\r?\n/)
        .filter(Boolean);
    const previousTag = selectPreviousTag(tag, reachableTags);
    const range = previousTag ? `${previousTag}..${tag}` : tag;
    const log = runGitCommand([
        'log',
        '-z',
        '--reverse',
        `--format=${GIT_LOG_FORMAT}`,
        range,
    ]);

    return {
        tag,
        previousTag,
        repositoryUrl,
        commits: parseGitLog(log),
    };
}

/**
 * Parses the NUL-delimited Git format used by collectReleaseData.
 *
 * @param {string} log
 * @returns {Array<{ sha: string; subject: string; body: string }>}
 */
export function parseGitLog(log) {
    if (log === '') return [];

    const fields = log.split('\0');
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0)
        throw new Error('Invalid fixed-field Git log output.');

    const commits = [];
    for (let index = 0; index < fields.length; index += 3)
        commits.push({
            sha: fields[index],
            subject: fields[index + 1],
            body: fields[index + 2],
        });
    return commits;
}

/**
 * Parses the read-only preview CLI arguments.
 *
 * @param {string[]} args
 * @returns {{ tag: string }}
 */
export function parseArguments(args) {
    if (args.length !== 2 || args[0] !== '--tag' || !args[1])
        throw new Error('Usage: node scripts/release-notes.mjs --tag vX.Y.Z');
    assertReleaseTag(args[1]);
    return { tag: args[1] };
}

function main() {
    try {
        const { tag } = parseArguments(process.argv.slice(2));
        const release = collectReleaseData(tag);
        process.stdout.write(renderReleaseNotes(release));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    }
}

/**
 * Whether the module at `moduleUrl` is the script node was invoked with.
 *
 * Compares real paths: node resolves symlinks in `import.meta.url` but not in
 * `process.argv[1]`, so a plain comparison silently skips `main()` when the
 * script runs from a symlinked directory (macOS's /var → /private/var).
 *
 * @param {string} moduleUrl - The caller's `import.meta.url`.
 * @returns {boolean}
 */
export function isDirectRun(moduleUrl) {
    if (!process.argv[1]) return false;
    try {
        return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
    } catch {
        return false;
    }
}

if (isDirectRun(import.meta.url)) main();
