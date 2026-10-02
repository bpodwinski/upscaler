/**
 * Parse `npm pack --json` output across npm majors.
 *
 * npm ≤11 prints an array of pack results; npm 12 prints an object keyed by
 * package name. The publish workflow runs a newer npm than CI's bundled one
 * (Trusted Publishing needs ≥11.5.1), so a parser that only knew the array
 * shape passed CI and then failed every release inside `prepublishOnly`.
 *
 * GPU-free and side-effect-free on import, so it is unit-tested in CI.
 */

/**
 * Normalize `npm pack --json` stdout into a list of pack results.
 *
 * @param {string} stdout - Raw stdout from `npm pack --json`.
 * @returns {Array<{ name?: string, filename?: string, files: Array<{ path: string }> }>}
 *   One entry per packed package, in npm's reported order.
 * @throws {Error} When the output isn't JSON or carries no pack results.
 */
export function parsePackJson(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (error) {
        throw new Error(`npm pack --json printed non-JSON output:\n${stdout}`, { cause: error });
    }

    const entries = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
            ? Object.values(parsed)
            : [];
    if (!entries.length || !entries.every((entry) => Array.isArray(entry?.files)))
        throw new Error(`npm pack --json printed an unrecognised shape:\n${stdout}`);
    return entries;
}
