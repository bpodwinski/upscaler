import { describe, expect, test } from 'vitest';

import { parsePackJson } from './npm-pack-json.mjs';

const result = {
    id: '@ruxelion/upscaler@0.3.0',
    name: '@ruxelion/upscaler',
    filename: 'pmndrs-upscaler-0.3.0.tgz',
    files: [{ path: 'dist/index.js' }, { path: 'package.json' }],
};

describe('parsePackJson', () => {
    test('reads the npm ≤11 array shape', () => {
        expect(parsePackJson(JSON.stringify([result]))).toEqual([result]);
    });

    test('reads the npm 12 object-keyed-by-name shape', () => {
        expect(parsePackJson(JSON.stringify({ [result.name]: result }))).toEqual([result]);
    });

    test('rejects non-JSON output with the raw text', () => {
        expect(() => parsePackJson('npm warn something')).toThrow(/non-JSON[\s\S]*npm warn something/);
    });

    test('rejects shapes without file lists', () => {
        expect(() => parsePackJson('[]')).toThrow(/unrecognised shape/);
        expect(() => parsePackJson('{}')).toThrow(/unrecognised shape/);
        expect(() => parsePackJson(JSON.stringify([{ name: 'x' }]))).toThrow(/unrecognised shape/);
    });
});
