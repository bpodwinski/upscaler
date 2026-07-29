import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import {
    DEBUG_SOURCE_FILTER_SHADER,
    DEBUG_SOURCE_RESOLVER_SHADER,
    DEBUG_SOURCE_STRUCTURAL_SHADER,
} from '../bench/src/candidates/shaders/candidateDebug';
import {
    ACCUMULATE_SOURCE_FILTER_SHADER,
    ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
    EASU_SOURCE_APPROX_SHADER,
} from '../bench/src/candidates/shaders/candidateFilters';
import {
    DEPTH_CLIP_SOURCE_SHADER,
    GENERATE_REACTIVE_SOURCE_SHADER,
    PREPARE_INPUTS_SOURCE_SHADER,
    PREPARE_REACTIVITY_SOURCE_SHADER,
} from '../bench/src/candidates/shaders/candidateInputs';
import {
    ACCUMULATE_SOURCE_RESOLVER_SHADER,
    EXPOSURE_HISTORY_SOURCE_SHADER,
    LUMA_INSTABILITY_SOURCE_SHADER,
    LUMA_SPD_SOURCE_SHADER,
    SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
    SHADING_CHANGE_SPD_SOURCE_SHADER,
} from '../bench/src/candidates/shaders/candidateTemporal';

describe('artifact candidate markers', () => {
    test('guards the candidate-only T&C dispatch option', () => {
        const verifier = readFileSync(
            new URL('./verify-artifacts.mjs', import.meta.url),
            'utf8',
        );

        expect(verifier).toContain("'transparencyAndComposition?:'");
    });

    test('covers every relocated candidate shader', () => {
        const verifier = readFileSync(
            new URL('./verify-artifacts.mjs', import.meta.url),
            'utf8',
        );
        const markerBlock = verifier.match(
            /const candidateMarkers = \[(.*?)\];/s,
        )?.[1];
        const markers = [...(markerBlock ?? '').matchAll(/'([^']+)'/g)].map(
            (match) => match[1],
        );
        const candidateShaders = [
            EASU_SOURCE_APPROX_SHADER,
            ACCUMULATE_SOURCE_FILTER_SHADER,
            ACCUMULATE_SOURCE_STRUCTURAL_SHADER,
            DEBUG_SOURCE_FILTER_SHADER,
            DEBUG_SOURCE_STRUCTURAL_SHADER,
            DEBUG_SOURCE_RESOLVER_SHADER,
            GENERATE_REACTIVE_SOURCE_SHADER,
            PREPARE_INPUTS_SOURCE_SHADER,
            DEPTH_CLIP_SOURCE_SHADER,
            PREPARE_REACTIVITY_SOURCE_SHADER,
            EXPOSURE_HISTORY_SOURCE_SHADER,
            LUMA_SPD_SOURCE_SHADER,
            SHADING_CHANGE_SPD_SOURCE_SHADER,
            SHADING_CHANGE_RESOLVE_SOURCE_SHADER,
            LUMA_INSTABILITY_SOURCE_SHADER,
            ACCUMULATE_SOURCE_RESOLVER_SHADER,
        ];

        for (const source of candidateShaders)
            expect(markers.some((marker) => source.includes(marker))).toBe(true);
    });
});
