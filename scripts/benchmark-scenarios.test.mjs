import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { describe, expect, test } from 'vitest';

import {
    loadScenarioRegistry,
    scenarioSubruns,
    selectScenarios,
} from './benchmark-scenarios.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
    readFileSync(join(ROOT, 'bench/results/experiments/e00-harness.json'), 'utf8'),
);
const registry = await loadScenarioRegistry(ROOT);

describe('benchmark scenario registry (run-benchmark --scenarios)', () => {
    test('every registered scenario is selectable, including the post-manifest Q12+', () => {
        const ids = registry.map((scenario) => scenario.id);
        expect(ids).toEqual(expect.arrayContaining(['Q12', 'Q13', 'Q14', 'Q15', 'Q16', 'Q17']));
        expect(selectScenarios(registry, ids).map((scenario) => scenario.id)).toEqual(ids);
        expect(selectScenarios(registry, ['Q17', 'Q0']).map((scenario) => scenario.id)).toEqual([
            'Q0',
            'Q17',
        ]);
    });

    test('unknown ids are an error, never silently dropped', () => {
        expect(() => selectScenarios(registry, ['Q0', 'Q99', 'q1'])).toThrowError(
            /Unknown --scenarios id\(s\): Q99, q1\./,
        );
    });

    test('the registry reproduces the frozen manifest capture specs it supersedes', () => {
        for (const frozen of manifest.scenarios.required) {
            const [scenario] = selectScenarios(registry, [frozen.id]);
            expect(scenario.name).toBe(frozen.name);
            expect(scenario.captures).toEqual({
                frames: frozen.captures.frames,
                debug_views: frozen.captures.debug_views,
                rois: frozen.captures.rois,
            });
        }
    });

    // Spawns plain Node (not vitest's transform), so this also proves the
    // runtime TypeScript import of the registry works. Exits during argument
    // validation, before any server, browser or output directory exists.
    test('run-benchmark rejects an unknown id up front', () => {
        const result = spawnSync(
            process.execPath,
            [join(ROOT, 'scripts/run-benchmark.mjs'), '--mode', 'capture', '--smoke', '--scenarios', 'Q12,Q99'],
            { encoding: 'utf8', timeout: 20_000 },
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Unknown --scenarios id(s): Q99.');
    });

    test('subruns come from the registry (Q6/Q8 as before, Q14 now too)', () => {
        const subruns = (id) => scenarioSubruns(selectScenarios(registry, [id])[0]);
        expect(subruns('Q1')).toEqual([null]);
        expect(subruns('Q6')).toEqual(['gtao', 'ssr', 'ssgi']);
        expect(subruns('Q8')).toEqual(['builtin', 'spatial', 'recurrent']);
        expect(subruns('Q14')).toEqual(['off', 'static', 'rotating', 'builtin']);
    });
});
