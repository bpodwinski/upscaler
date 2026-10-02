import { describe, expect, it } from 'vitest';

import { parseBenchmarkConfig } from './config';
import { BENCHMARK_SCENARIOS, getBenchmarkScenario, resolveCaptureFrames } from './scenarios';

const capture = (scenario: string) =>
    parseBenchmarkConfig(`?benchMode=capture&scenario=${scenario}&width=1280&height=720`);

describe('benchmark scenario registry', () => {
    it('defines every scenario the page-side allowlist accepts, under its own id', () => {
        const ids = Object.keys(BENCHMARK_SCENARIOS);
        expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => `Q${i}`));
        for (const id of ids) {
            expect(BENCHMARK_SCENARIOS[id as BenchmarkScenarioId].id).toBe(id);
            expect(capture(id).scenario).toBe(id);
        }
    });

    it('resolves every capture expression within the scenario', () => {
        for (const scenario of Object.values(BENCHMARK_SCENARIOS))
            for (const period of [8, 18, 32, 72]) {
                const frames = resolveCaptureFrames(scenario.captures, period);
                expect(frames.every((frame) => Number.isInteger(frame) && frame >= 0)).toBe(true);
            }
    });
});

describe('Q13 merged-reactive-masks', () => {
    const q13 = getBenchmarkScenario('Q13');

    it('drives both reactive sources on a still, frozen scene', () => {
        const first = q13.frame(0);
        for (const frame of [1, 23, 64, q13.endFrame]) {
            const state = q13.frame(frame);
            expect(state.reactiveMerge).toBe(true);
            expect(state.animateScene).toBe(false);
            expect(state.particlesVisible).toBe(false);
            expect(state.cameraPosition).toEqual(first.cameraPosition);
            expect(state.cameraTarget).toEqual(first.cameraTarget);
            expect(state.directionalIntensity).toBe(first.directionalIntensity);
        }
    });

    it('captures the reactivity view and declares one ROI per merge region', () => {
        expect(q13.debugViews).toContain('reactivity');
        expect(Object.keys(q13.rois)).toEqual(
            expect.arrayContaining(['explicit_only', 'overlap', 'diff_only']),
        );
    });

    it('is the only scenario that enables the merged-reactive fixture', () => {
        for (const scenario of Object.values(BENCHMARK_SCENARIOS)) {
            if (scenario.id === 'Q13') continue;
            expect(scenario.frame(0).reactiveMerge ?? false).toBe(false);
        }
    });
});
