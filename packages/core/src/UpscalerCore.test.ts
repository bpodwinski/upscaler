import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore, depthClipKfov, tanHalfFovY } from './UpscalerCore';
import { FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
import type { CoreTexture, CoreTextureDescriptor } from './textures';

//* Mock Device — answers every create* call with a stub so the core runs
// end to end without a GPU or an engine (raw GPUTexture inputs only).

function mockDevice() {
    const writes: Uint32Array[] = [];
    // The label of each writeBuffer target, parallel to `writes`.
    const writeTargets: Array<string | undefined> = [];
    const resource = (descriptor: { size?: number; label?: string } = {}) => ({
        label: descriptor.label,
        width: 16,
        height: 16,
        sampleCount: 1,
        format: 'rgba16float',
        getBindGroupLayout: () => ({}),
        createView: () => ({}),
        getMappedRange: () => new ArrayBuffer(descriptor.size ?? 4),
        unmap: () => {},
        destroy: vi.fn(),
    });
    const encoder = {
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
        finish: () => ({}),
    };
    const device = {
        lost: new Promise<GPUDeviceLostInfo>(() => {}),
        features: new Set<string>(),
        queue: {
            writeBuffer: vi.fn((buffer: { label?: string }, _offset: number, data: ArrayBuffer) => {
                writeTargets.push(buffer.label);
                writes.push(new Uint32Array(data.slice(0)));
            }),
            writeTexture: vi.fn(),
            submit: vi.fn(),
        },
        createShaderModule: resource,
        createComputePipelineAsync: async () => resource(),
        createSampler: resource,
        createBuffer: resource,
        createTexture: vi.fn(resource),
        createBindGroup: vi.fn(resource),
        createCommandEncoder: vi.fn(() => encoder),
    };
    return { device, writes, writeTargets, encoder, gpu: (label: string) => resource({ label }) as unknown as GPUTexture };
}

// The flags word of the most recent constants upload (ConstantsBuffer u32[20]).
const lastFlags = (writes: Uint32Array[]) => writes[writes.length - 1][20];

describe('UpscalerCore without an engine', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('allocates the published set through the allocator and returns its handles', async () => {
        const { device } = mockDevice();
        const allocated: CoreTextureDescriptor[] = [];
        const allocateTexture = (descriptor: CoreTextureDescriptor): CoreTexture<{ name: string }> => {
            allocated.push(descriptor);
            return { gpu: device.createTexture() as unknown as GPUTexture, handle: { name: descriptor.label }, destroy: vi.fn() };
        };
        const core = new UpscalerCore({ device: device as unknown as GPUDevice, allocateTexture });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();

        expect(core.output).toEqual({ name: 'upscale-output' });
        expect(core.guides.dilatedMotion).toEqual({ name: 'upscale-dilated-motion' });
        expect(core.guides.history).toEqual({ name: 'upscale-history-0' });
        const byLabel = new Map(allocated.map((d) => [d.label, d]));
        expect(byLabel.get('upscale-output')).toMatchObject({ width: 64, height: 32, format: 'rgba16float' });
        expect(byLabel.get('upscale-dilated-depth-0')).toMatchObject({ width: 32, height: 16, format: 'r32float' });
        expect(byLabel.get('upscale-masks')).toMatchObject({ format: 'rgba8unorm' });
    });

    it('defaults to raw GPUTexture handles', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.output).toMatchObject({ label: 'upscale-output' });
    });

    it('stages camera facts from plain frame data', async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, reversedDepth: true });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET))
            .toBe(FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET);

        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false });
        expect(lastFlags(writes) & (FLAG_PERSPECTIVE | FLAG_REVERSED_DEPTH | FLAG_RESET)).toBe(0);
    });

    it("reads the projection type from a denoiser-style camera's matrix", async () => {
        const { device, writes, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        const perspective = new Float32Array(16);
        perspective[11] = -1; // w = −z
        const orthographic = new Float32Array(16);
        orthographic[15] = 1;

        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: perspective });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, projection: orthographic });
        expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(0);
        expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100 })).toThrow(/perspective/);
    });

    it('encodes into a host encoder without submitting', async () => {
        const { device, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };

        core.encodeGuides(encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera);
        expect(core.guidesPending).toBe(true);
        core.encodeUpscale(encoder as unknown as GPUCommandEncoder, { color: gpu('color') }, camera);
        expect(core.guidesPending).toBe(false);
        expect(device.createCommandEncoder).not.toHaveBeenCalled();
        expect(device.queue.submit).not.toHaveBeenCalled();
    });

    // Issue #96: `queue.writeBuffer` lands before anything in the encoder
    // executes, so a split frame recorded into one encoder is only correct if
    // each stage reads constants the other stage's write cannot touch.
    it('gives each stage of a split frame its own constants buffer', async () => {
        const { device, writes, writeTargets, encoder, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        await core.prepare();
        const camera = { near: 0.1, far: 100, perspective: true };
        const constantsOf = (call: unknown[]) => {
            const { label, entries } = call[0] as {
                label: string; entries: Array<{ resource: { buffer?: { label?: string } } }>;
            };
            return [label, entries[0].resource.buffer?.label] as const;
        };
        const early = ['upscale-reconstruct', 'upscale-depth-clip'];

        const run = (stage: () => void) => {
            writes.length = 0;
            writeTargets.length = 0;
            device.createBindGroup.mockClear();
            stage();
            return device.createBindGroup.mock.calls.map(constantsOf);
        };

        //* Split frame, both stages in the host's one encoder.
        const guides = run(() => core.encodeGuides(
            encoder as unknown as GPUCommandEncoder, { depth: gpu('depth'), velocity: gpu('velocity') }, camera,
        ));
        expect(guides.map(([label]) => label)).toEqual(early);
        expect(guides.every(([, buffer]) => buffer === 'upscale-constants-early')).toBe(true);
        expect(writeTargets).toEqual(['upscale-constants-early']);

        const late = run(() => core.encodeUpscale(
            encoder as unknown as GPUCommandEncoder, { color: gpu('color'), reactive: gpu('reactive') }, camera,
        ));
        expect(late.length).toBeGreaterThan(0);
        expect(late.every(([, buffer]) => buffer === 'upscale-constants-late')).toBe(true);
        // The late write must not touch what the still-unsubmitted guides read.
        expect(writeTargets).toEqual(['upscale-constants-late']);

        //* Monolithic frame: same split per pass, each buffer written once.
        const frame = run(() => core.dispatch(
            { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, camera,
        ));
        for (const [label, buffer] of frame) {
            expect(buffer).toBe(early.includes(label) ? 'upscale-constants-early' : 'upscale-constants-late');
        }
        expect(writeTargets).toEqual(['upscale-constants-early', 'upscale-constants-late']);
        expect(writes[0]).toEqual(writes[1]);
        expect(device.queue.submit).toHaveBeenCalledTimes(1);
    });

    it('writes only the late constants on the paths with no guides stage', async () => {
        const { device, writeTargets, gpu } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        await core.prepare();
        core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, perspective: true });
        expect(writeTargets).toEqual(['upscale-constants-late']);
    });

    it('advances jitter only on the temporal path with jitter on', async () => {
        const { device } = mockDevice();
        const core = new UpscalerCore({ device: device as unknown as GPUDevice });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
        expect(core.beginFrame()).toBe(core.jitter);
        expect(core.jitterPhase).toBe(1);
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false });
        expect(core.beginFrame()).toBeNull();
        core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial' });
        expect(core.beginFrame()).toBeNull();
    });
});

//* Depth Clip Tolerance — FSR2's Kfov (ffx_fsr2_depth_clip.h)

describe('depth clip FOV factor', () => {
    beforeEach(() => {
        vi.stubGlobal('GPUBufferUsage', { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 });
        vi.stubGlobal('GPUTextureUsage', { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8 });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    // ConstantsBuffer f32[24] = byte offset 96, `depthClipKfov` in FsrConstants.
    const kfovOf = (write: Uint32Array) => new Float32Array(write.buffer)[24];
    const lastKfov = (writes: Uint32Array[]) => kfovOf(writes[writes.length - 1]);
    // Render 32×16 (64×32 at ratio 2): aspect 2.
    const expected = (fovY: number) => Math.sqrt(1 + Math.tan(fovY / 2) ** 2 * (1 + 2 * 2));

    async function temporalCore(path: 'temporal' | 'guides' = 'temporal') {
        const mock = mockDevice();
        const core = new UpscalerCore({ device: mock.device as unknown as GPUDevice });
        core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, path });
        await core.prepare();
        const inputs = { color: mock.gpu('color'), depth: mock.gpu('depth'), velocity: mock.gpu('velocity') };
        return { ...mock, core, inputs };
    }

    it('is the corner/center distance ratio of the view plane', () => {
        expect(depthClipKfov(true, 0, 1)).toBe(1);
        expect(depthClipKfov(true, 1, 1)).toBeCloseTo(Math.sqrt(3));
        // 90° vertical FOV, 16:9.
        expect(depthClipKfov(true, 1, 16 / 9)).toBeCloseTo(Math.sqrt(2 + (16 / 9) ** 2));
        expect(depthClipKfov(false, 1, 16 / 9)).toBe(1);
    });

    it('reads tan(fovY / 2) from fovY, else from the projection, else unknown', () => {
        expect(tanHalfFovY({ near: 0.1, far: 10, fovY: Math.PI / 2 })).toBeCloseTo(1);
        const projection = new Float32Array(16);
        projection[5] = 1 / Math.tan(Math.PI / 6);
        projection[11] = -1;
        expect(tanHalfFovY({ near: 0.1, far: 10, projection })).toBeCloseTo(Math.tan(Math.PI / 6));
        // A flipped y axis (Y-down render targets) is the same FOV.
        const flipped = Float32Array.from(projection);
        flipped[5] = -flipped[5];
        expect(tanHalfFovY({ near: 0.1, far: 10, projection: flipped })).toBeCloseTo(Math.tan(Math.PI / 6));
        // fovY wins over the matrix.
        expect(tanHalfFovY({ near: 0.1, far: 10, fovY: Math.PI / 2, projection })).toBeCloseTo(1);
        expect(tanHalfFovY({ near: 0.1, far: 10, perspective: true })).toBeNull();
        expect(tanHalfFovY({ near: 0.1, far: 10, projection: new Float32Array(16) })).toBeNull();
    });

    it.each([0, -1, Math.PI, 4, Number.NaN, Number.POSITIVE_INFINITY])('rejects fovY = %s', (fovY) => {
        expect(() => tanHalfFovY({ near: 0.1, far: 10, perspective: true, fovY })).toThrow(/fovY/);
    });

    it('stages the camera FOV with the render aspect', async () => {
        const { core, inputs, writes } = await temporalCore();
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, fovY: (50 * Math.PI) / 180 });
        expect(lastKfov(writes)).toBeCloseTo(expected((50 * Math.PI) / 180), 6);
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, fovY: Math.PI / 2 });
        expect(lastKfov(writes)).toBeCloseTo(Math.sqrt(1 + 1 * 5), 6);
    });

    it('derives it from a denoiser-style projection matrix', async () => {
        const { core, inputs, writes } = await temporalCore();
        const projection = new Float32Array(16);
        projection[5] = 1 / Math.tan(Math.PI / 8);
        projection[11] = -1;
        core.dispatch(inputs, { near: 0.1, far: 100, projection });
        expect(lastKfov(writes)).toBeCloseTo(expected(Math.PI / 4), 6);
    });

    it('is 1 for an orthographic camera, whatever FOV it carries', async () => {
        const { core, inputs, writes } = await temporalCore();
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: false, fovY: Math.PI / 2 });
        expect(lastKfov(writes)).toBe(1);
    });

    it('writes the same factor to both stage buffers', async () => {
        const { core, inputs, writes, writeTargets } = await temporalCore();
        writes.length = 0;
        writeTargets.length = 0;
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, fovY: 1 });
        expect(writeTargets).toEqual(['upscale-constants-early', 'upscale-constants-late']);
        expect(kfovOf(writes[0])).toBeCloseTo(expected(1), 6);
        expect(kfovOf(writes[1])).toBe(kfovOf(writes[0]));
    });

    it('stages it on the guides path, which runs the depth clip alone', async () => {
        const { core, inputs, writes } = await temporalCore('guides');
        core.dispatchGuides({ depth: inputs.depth, velocity: inputs.velocity }, { near: 0.1, far: 100, perspective: true, fovY: 1 });
        expect(lastKfov(writes)).toBeCloseTo(expected(1), 6);
    });

    it('falls back to 1 and warns once for a perspective camera without a FOV', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { core, inputs, writes } = await temporalCore();
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true });
        core.dispatch(inputs, { near: 0.1, far: 100, perspective: true });
        expect(lastKfov(writes)).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/fovY/);
    });

    it('does not warn on the spatial paths, which run no depth clip', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const path of ['spatial', 'bilinear'] as const) {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, path });
            await core.prepare();
            core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, perspective: true });
        }
        expect(warn).not.toHaveBeenCalled();
    });

    it('rejects an invalid fovY at dispatch', async () => {
        const { core, inputs } = await temporalCore();
        expect(() => core.dispatch(inputs, { near: 0.1, far: 100, perspective: true, fovY: 0 })).toThrow(/fovY/);
    });
});
