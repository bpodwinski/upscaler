import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import {
    DEFAULT_BENCH_URL,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    stopChild,
    viteServerArguments,
    waitForUrl,
} from './local-processes.mjs';

test('resolves the default bench origin unchanged', () => {
    expect(DEFAULT_BENCH_URL).toBe('http://127.0.0.1:5199');
    expect(resolveServerUrl(undefined, DEFAULT_BENCH_URL)).toEqual({
        origin: 'http://127.0.0.1:5199',
        hostname: '127.0.0.1',
        port: 5199,
    });
});

test('resolves a custom origin, IPv6 hosts, and implicit ports', () => {
    expect(resolveServerUrl('http://127.0.0.1:5601', DEFAULT_BENCH_URL)).toEqual({
        origin: 'http://127.0.0.1:5601',
        hostname: '127.0.0.1',
        port: 5601,
    });
    expect(resolveServerUrl('http://[::1]:5602/', DEFAULT_BENCH_URL)).toMatchObject({
        origin: 'http://[::1]:5602',
        hostname: '::1',
        port: 5602,
    });
    expect(resolveServerUrl('http://localhost', DEFAULT_BENCH_URL).port).toBe(80);
});

test('rejects malformed or non-origin URLs', () => {
    expect(() => resolveServerUrl(true, DEFAULT_BENCH_URL)).toThrowError(/needs a value/);
    expect(() => resolveServerUrl('5601', DEFAULT_BENCH_URL)).toThrowError(/absolute http/);
    expect(() => resolveServerUrl('ftp://127.0.0.1:21', DEFAULT_BENCH_URL)).toThrowError(
        /http or https/,
    );
    expect(() =>
        resolveServerUrl('http://127.0.0.1:5601/bench?x=1', DEFAULT_BENCH_URL),
    ).toThrowError(/no path or query/);
});

test('parses optional port flags', () => {
    expect(parsePort(undefined, '--port')).toBeUndefined();
    expect(parsePort('9600', '--port')).toBe(9600);
    for (const bad of [true, '0', '70000', '12.5', 'abc'])
        expect(() => parsePort(bad, '--port')).toThrowError(/--port must be a port number/);
});

test('pins the spawned Vite server to the requested host and port', () => {
    const args = viteServerArguments('bench/vite.config.ts', { hostname: '127.0.0.1', port: 5601 });
    expect(args.slice(1)).toEqual([
        '--config',
        'bench/vite.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        '5601',
        '--strictPort',
    ]);
    const preview = viteServerArguments('x.ts', { hostname: '::1', port: 5602 }, [
        'preview',
        '--outDir',
        'out',
    ]);
    expect(preview.slice(1, 4)).toEqual(['preview', '--outDir', 'out']);
});

test('waitForUrl fails fast when the server process has already exited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)']);
    await new Promise((resolveExit) => child.once('exit', resolveExit));
    await expect(
        waitForUrl('http://127.0.0.1:1', { child, attempts: 50 }),
    ).rejects.toThrowError(/exited before answering/);
});

test('stopChild resolves only after the child has exited', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise((resolveSpawn) => child.once('spawn', resolveSpawn));
    await stopChild(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    await stopChild(child); // idempotent on an exited process
    await stopChild(null);
});

test('removeTempDirectory removes a tree and never throws', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'upscaler-local-processes-'));
    writeFileSync(join(directory, 'file'), 'x');
    expect(await removeTempDirectory(directory)).toBe(true);
    expect(existsSync(directory)).toBe(false);
    expect(await removeTempDirectory(undefined)).toBe(true);
});
