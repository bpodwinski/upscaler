// The bench scenario registry (bench/src/benchmark/scenarios.ts) is the single
// source of truth for which scenarios exist and how each one is captured. The
// E00 manifest only freezes the authoritative acceptance protocol, so a
// scenario added to the registry after it (Q12+) must still be selectable.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCENARIO_REGISTRY_PATH = 'bench/src/benchmark/scenarios.ts';

/**
 * Loads the bench scenario registry. Node strips the TypeScript at import
 * (default since Node 22.18); the registry has no imports and only erasable
 * syntax, so nothing else is needed.
 * @param {string} root - Repository root
 * @returns {Promise<ReturnType<typeof toCaptureScenarios>>} Registry scenarios in capture shape
 */
export async function loadScenarioRegistry(root) {
    const url = pathToFileURL(join(root, SCENARIO_REGISTRY_PATH)).href;
    let module;
    try {
        module = await import(url);
    } catch (error) {
        throw new Error(
            `Could not load the scenario registry ${SCENARIO_REGISTRY_PATH} (needs Node >= 22.18 ` +
                `for built-in TypeScript stripping): ${error instanceof Error ? error.message : error}`,
        );
    }
    return toCaptureScenarios(module.BENCHMARK_SCENARIOS);
}

/**
 * Maps registry entries onto the manifest's capture shape, in registry order.
 * @param {Record<string, { id: string, name: string, captures: string[], debugViews: string[],
 *   rois: Record<string, number[]>, subruns: string[] }>} registry - `BENCHMARK_SCENARIOS`
 * @returns {{ id: string, name: string, subruns: string[],
 *   captures: { frames: string[], debug_views: string[], rois: Record<string, number[]> } }[]}
 */
export function toCaptureScenarios(registry) {
    return Object.values(registry).map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        subruns: [...scenario.subruns],
        captures: {
            frames: [...scenario.captures],
            debug_views: [...scenario.debugViews],
            rois: scenario.rois,
        },
    }));
}

/**
 * Resolves requested scenario ids against the registry. Unknown ids are an
 * error, never silently dropped.
 * @param {{ id: string }[]} scenarios - Registry scenarios
 * @param {Iterable<string>} requestedIds - Ids from `--scenarios`
 * @returns The requested scenarios, in registry order
 */
export function selectScenarios(scenarios, requestedIds) {
    const requested = new Set(requestedIds);
    const known = new Set(scenarios.map((scenario) => scenario.id));
    const unknown = [...requested].filter((id) => !known.has(id));
    if (unknown.length > 0)
        throw new Error(
            `Unknown --scenarios id(s): ${unknown.join(', ')}. ` +
                `Registered scenarios: ${[...known].join(', ')}.`,
        );
    return scenarios.filter((scenario) => requested.has(scenario.id));
}

/**
 * The subruns a scenario is captured under (`[null]` when it defines none).
 * @param {{ subruns: string[] }} scenario - Registry scenario
 * @returns {(string | null)[]}
 */
export function scenarioSubruns(scenario) {
    return scenario.subruns.length > 0 ? scenario.subruns : [null];
}
