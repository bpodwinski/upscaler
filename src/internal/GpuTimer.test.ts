import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GpuTimer } from './GpuTimer';

//* Mock Device — just enough WebGPU surface for GpuTimer, no GPU needed

interface MockOptions {
    timestampQuery?: boolean;
    /** What the (validation, out-of-memory) pops resolve to, in pop order. */
    scopeErrors?: [unknown, unknown];
    createQuerySetThrows?: boolean;
    mapAsyncRejects?: boolean;
}

function mockDevice(options: MockOptions = {}) {
    const { timestampQuery = true, scopeErrors = [null, null] } = options;
    const pops = [...scopeErrors];
    const scopes: string[] = [];
    const destroyed: string[] = [];
    let mapped: ArrayBuffer | null = null;

    const device = {
        features: new Set(timestampQuery ? ['timestamp-query'] : []),
        pushErrorScope: vi.fn((filter: string) => scopes.push(filter)),
        popErrorScope: vi.fn(() => {
            scopes.pop();
            return Promise.resolve(pops.shift() ?? null);
        }),
        createQuerySet: vi.fn((descriptor: { label: string }) => {
            if (options.createQuerySetThrows) throw new TypeError('createQuerySet blew up');
            return { label: descriptor.label, destroy: () => destroyed.push(descriptor.label) };
        }),
        createBuffer: vi.fn((descriptor: { label: string; size: number }) => ({
            label: descriptor.label,
            destroy: () => destroyed.push(descriptor.label),
            mapAsync: vi.fn((_mode: number, _offset: number, size: number) => {
                if (options.mapAsyncRejects) return Promise.reject(new Error('mapAsync failed'));
                // Two passes' begin/end ticks: 1ms and 2.5ms.
                const ticks = new BigUint64Array(size / 8);
                ticks.set([0n, 1_000_000n, 1_000_000n, 3_500_000n].slice(0, ticks.length));
                mapped = ticks.buffer;
                return Promise.resolve();
            }),
            getMappedRange: () => mapped!,
            unmap: () => {
                mapped = null;
            },
        })),
        queue: { onSubmittedWorkDone: () => Promise.resolve() },
    };
    return { device: device as unknown as GPUDevice, raw: device, scopes, destroyed };
}

function mockEncoder() {
    return {
        resolveQuerySet: vi.fn(),
        copyBufferToBuffer: vi.fn(),
    };
}

/** Encodes one frame the way Upscaler.dispatch does; returns the pass timestamp writes. */
function encodeFrame(timer: GpuTimer, encoder = mockEncoder()) {
    timer.beginFrame();
    const writes = [timer.passDescriptor('reconstruct'), timer.passDescriptor('accumulate')];
    timer.resolve(encoder as unknown as GPUCommandEncoder);
    timer.readback();
    return { writes, encoder };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GpuTimer', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', {
            MAP_READ: 1,
            COPY_SRC: 4,
            COPY_DST: 8,
            QUERY_RESOLVE: 512,
        });
        vi.stubGlobal('GPUMapMode', { READ: 1 });
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    //* Healthy Path

    it('allocates inside balanced out-of-memory + validation error scopes', async () => {
        const { device, raw, scopes } = mockDevice();
        const timer = new GpuTimer(device);
        expect(raw.pushErrorScope.mock.calls.map(([filter]) => filter)).toEqual([
            'out-of-memory',
            'validation',
        ]);
        expect(raw.popErrorScope).toHaveBeenCalledTimes(2);
        expect(scopes).toEqual([]);
        await timer.ready;
        expect(timer.enabled).toBe(true);
    });

    it('attaches no timestamp work until the allocation is confirmed', () => {
        const { device } = mockDevice();
        const timer = new GpuTimer(device);
        const { writes, encoder } = encodeFrame(timer);
        expect(writes).toEqual([undefined, undefined]);
        expect(encoder.resolveQuerySet).not.toHaveBeenCalled();
        expect(encoder.copyBufferToBuffer).not.toHaveBeenCalled();
    });

    it('times, resolves and reads back once the allocation is confirmed', async () => {
        const { device } = mockDevice();
        const timer = new GpuTimer(device);
        await timer.ready;

        const { writes, encoder } = encodeFrame(timer);
        expect(writes[0]).toMatchObject({ beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 });
        expect(writes[1]).toMatchObject({ beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 });
        expect(encoder.resolveQuerySet).toHaveBeenCalledOnce();
        expect(encoder.copyBufferToBuffer).toHaveBeenCalledOnce();

        await timer.drain();
        expect(Object.fromEntries(timer.timings)).toEqual({ reconstruct: 1, accumulate: 2.5 });
        expect(warn).not.toHaveBeenCalled();
    });

    it('merges per-label results across the two submits of a split frame', async () => {
        const { device } = mockDevice();
        const timer = new GpuTimer(device);
        await timer.ready;

        timer.beginFrame();
        timer.passDescriptor('reconstruct');
        timer.resolve(mockEncoder() as unknown as GPUCommandEncoder);
        timer.readback();
        timer.beginFrame();
        timer.passDescriptor('accumulate');
        timer.resolve(mockEncoder() as unknown as GPUCommandEncoder);
        timer.readback();

        await timer.drain();
        expect([...timer.timings.keys()].sort()).toEqual(['accumulate', 'reconstruct']);
    });

    it('stays a silent no-op without timestamp-query', async () => {
        const { device, raw } = mockDevice({ timestampQuery: false });
        const timer = new GpuTimer(device);
        await timer.ready;
        expect(timer.enabled).toBe(false);
        expect(raw.pushErrorScope).not.toHaveBeenCalled();
        expect(raw.createQuerySet).not.toHaveBeenCalled();
        const { writes, encoder } = encodeFrame(timer);
        expect(writes).toEqual([undefined, undefined]);
        expect(encoder.resolveQuerySet).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    //* Failure Paths — profiling must never invalidate a frame

    it.each([
        ['out-of-memory', [null, { message: 'Out of memory creating QuerySet' }]],
        ['validation', [{ message: 'Invalid QuerySet' }, null]],
    ] as const)('disables itself on a %s allocation error and warns once', async (_kind, errors) => {
        const { device, destroyed } = mockDevice({ scopeErrors: [...errors] });
        const timer = new GpuTimer(device);
        await timer.ready;

        expect(timer.enabled).toBe(false);
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0][0])).toMatch(/GPU timing disabled/);
        // The possibly-invalid resources are released, not kept around.
        expect(destroyed.length).toBeGreaterThan(0);

        for (let frame = 0; frame < 3; frame++) {
            const { writes, encoder } = encodeFrame(timer);
            expect(writes).toEqual([undefined, undefined]);
            expect(encoder.resolveQuerySet).not.toHaveBeenCalled();
            expect(encoder.copyBufferToBuffer).not.toHaveBeenCalled();
        }
        await timer.drain();
        expect(timer.timings.size).toBe(0);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('pops its error scopes and disables itself when allocation throws', async () => {
        const { device, raw, scopes } = mockDevice({ createQuerySetThrows: true });
        const timer = new GpuTimer(device);
        expect(raw.popErrorScope).toHaveBeenCalledTimes(2);
        expect(scopes).toEqual([]);
        await timer.ready;
        expect(timer.enabled).toBe(false);
        expect(warn).toHaveBeenCalledOnce();
        expect(encodeFrame(timer).writes).toEqual([undefined, undefined]);
    });

    it('disables itself when a readback fails mid-run, warning once', async () => {
        const { device } = mockDevice({ mapAsyncRejects: true });
        const timer = new GpuTimer(device);
        await timer.ready;

        // Two frames in flight; both readbacks reject.
        encodeFrame(timer);
        encodeFrame(timer);
        await flush();

        expect(timer.enabled).toBe(false);
        expect(warn).toHaveBeenCalledOnce();
        const { writes, encoder } = encodeFrame(timer);
        expect(writes).toEqual([undefined, undefined]);
        expect(encoder.resolveQuerySet).not.toHaveBeenCalled();
    });

    it('does not warn when disposed before the allocation resolves', async () => {
        const { device } = mockDevice({ scopeErrors: [null, { message: 'oom' }] });
        const timer = new GpuTimer(device);
        timer.dispose();
        await timer.ready;
        expect(warn).not.toHaveBeenCalled();
    });

    it('fails authoritative timing loudly instead of silently dropping samples', async () => {
        const { device } = mockDevice({ scopeErrors: [null, { message: 'oom' }] });
        const timer = new GpuTimer(device);
        await expect(timer.waitForAvailableSlot()).resolves.toBeUndefined();
        expect(() => timer.setAuthoritative(true)).toThrow(/GPU timer resources failed/);
        expect(() => timer.beginFrame()).toThrow(/GPU timer resources failed/);
    });
});
