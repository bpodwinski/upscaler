import { expect, test } from 'vitest';

async function loadHarness() {
    try {
        return await import('./verify-packed-guides.mjs');
    } catch {
        return {};
    }
}

test('parses build-only and Chrome path options', async () => {
    const harness = await loadHarness();

    expect(harness.parseArguments).toBeTypeOf('function');
    expect(
        harness.parseArguments([
            '--build-only',
            '--chrome',
            '/Applications/Chrome Test.app/Contents/MacOS/Chrome Test',
        ]),
    ).toEqual({
        buildOnly: true,
        chrome: '/Applications/Chrome Test.app/Contents/MacOS/Chrome Test',
        keepTemp: false,
        help: false,
        port: undefined,
        cdpPort: undefined,
    });
});

test('parses --help and pinned ports, and rejects unknown options', async () => {
    const { parseArguments } = await loadHarness();

    // --help must short-circuit before the full GPU smoke, not be ignored.
    expect(parseArguments(['--help']).help).toBe(true);
    expect(parseArguments(['-h']).help).toBe(true);
    expect(parseArguments(['--port', '5600', '--cdp-port', '9600'])).toMatchObject({
        port: 5600,
        cdpPort: 9600,
    });
    expect(() => parseArguments(['--port', 'abc'])).toThrowError(/--port must be a port number/);
    expect(() => parseArguments(['--bogus'])).toThrowError(/Unknown option --bogus/);
});

test('reports WebGPU, WGSL, console, and runtime browser failures', async () => {
    const { browserLogFailures } = await loadHarness();
    const records = [
        { channel: 'Log.entryAdded', level: 'warning', text: 'WebGPU validation error' },
        { channel: 'Log.entryAdded', level: 'info', text: 'Parsing WGSL failed' },
        { channel: 'Runtime.consoleAPICalled', level: 'error', text: 'consumer crashed' },
        { channel: 'Runtime.exceptionThrown', level: 'error', text: 'uncaught exception' },
        { channel: 'Runtime.consoleAPICalled', level: 'warning', text: 'deprecation only' },
    ];

    expect(browserLogFailures).toBeTypeOf('function');
    expect(browserLogFailures(records).map(({ text }) => text)).toEqual([
        'WebGPU validation error',
        'Parsing WGSL failed',
        'consumer crashed',
        'uncaught exception',
    ]);
});

test('rejects a packed guides probe that violates linked split invariants', async () => {
    const { assertProbeResult } = await loadHarness();
    const invalid = {
        sharedUpscaler: false,
        stableNodeIdentity: false,
        backingTextureCount: 1,
        dispatchGuides: 0,
        dispatchUpscale: -1,
        monolithicDispatch: 1,
        measuredFrames: 1,
        dispatchSequence: [
            { frame: 0, phase: 'dispatchGuides' },
            { frame: 0, phase: 'dispatchUpscale' },
        ],
    };

    expect(assertProbeResult).toBeTypeOf('function');
    expect(() => assertProbeResult(invalid)).toThrowError(
        [
            'guides and upscale nodes do not share an upscaler',
            'guide texture-node identity changed',
            'ping-ponged backing texture did not repoint',
            'dispatchGuides did not run during steady state',
            'dispatchUpscale did not run during steady state',
            'steady-state split dispatch counts differ',
            'monolithic dispatch fallback ran after warmup',
        ].join('\n'),
    );
});

test('rejects missing, duplicate, or reordered per-frame split dispatches', async () => {
    const { assertProbeResult } = await loadHarness();
    const base = {
        sharedUpscaler: true,
        stableNodeIdentity: true,
        backingTextureCount: 2,
        dispatchGuides: 2,
        dispatchUpscale: 2,
        monolithicDispatch: 0,
        measuredFrames: 2,
    };
    const invalidSequences = [
        [
            { frame: 0, phase: 'dispatchGuides' },
            { frame: 0, phase: 'dispatchUpscale' },
            { frame: 1, phase: 'dispatchGuides' },
        ],
        [
            { frame: 0, phase: 'dispatchGuides' },
            { frame: 0, phase: 'dispatchUpscale' },
            { frame: 1, phase: 'dispatchGuides' },
            { frame: 1, phase: 'dispatchGuides' },
            { frame: 1, phase: 'dispatchUpscale' },
        ],
        [
            { frame: 0, phase: 'dispatchGuides' },
            { frame: 0, phase: 'dispatchUpscale' },
            { frame: 1, phase: 'dispatchUpscale' },
            { frame: 1, phase: 'dispatchGuides' },
        ],
    ];

    for (const dispatchSequence of invalidSequences)
        expect(() => assertProbeResult({ ...base, dispatchSequence })).toThrowError(
            'ordered per-frame split dispatch sequence is invalid',
        );
});
