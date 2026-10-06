import { describe, expect, it } from 'vitest';
import { browserCandidates, browserExecutable } from './browser-executable.mjs';

describe('browser executable selection', () => {
    it('honors an explicit executable with spaces before the environment', () => {
        const path = 'C:/Program Files/Microsoft/Edge/Application/msedge.exe';
        expect(browserExecutable(path, { env: { CHROME_PATH: '/other' }, exists: p => p === path })).toBe(path);
    });
    it('honors CHROME_PATH before standard installs', () => {
        expect(browserExecutable(undefined, { env: { CHROME_PATH: '/chosen' }, exists: () => true })).toBe('/chosen');
    });
    it('does not silently replace an invalid explicit path', () => {
        expect(() => browserExecutable('/missing', { exists: () => false })).toThrow('/missing');
        expect(() => browserExecutable(true)).toThrow('needs a value');
    });
    it('finds Chrome or falls back to Edge on Windows', () => {
        const paths = browserCandidates('win32', { ProgramFiles: 'C:/Program Files', LOCALAPPDATA: 'C:/Users/Test/AppData/Local' });
        const chrome = paths.find(p => p.endsWith('chrome.exe'));
        const edge = paths.find(p => p.endsWith('msedge.exe'));
        expect(browserExecutable(undefined, { platform: 'win32', env: {}, exists: p => p === chrome })).toBe(chrome);
        expect(browserExecutable(undefined, { platform: 'win32', env: {}, exists: p => p === edge })).toBe(edge);
    });
    it('retains Mac and Linux discovery', () => {
        for (const platform of ['darwin', 'linux']) {
            const paths = browserCandidates(platform, {});
            expect(browserExecutable(undefined, { platform, env: {}, exists: p => p === paths[0] })).toBe(paths[0]);
        }
    });
    it('reports absent browsers clearly', () => {
        expect(() => browserExecutable(undefined, { platform: 'win32', env: {}, exists: () => false })).toThrow('Chrome/Edge not found');
    });
});
