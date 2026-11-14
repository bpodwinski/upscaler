import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpscalerCore, depthClipKfov, tanHalfFovY } from './UpscalerCore';
import { FLAG_AUTO_EXPOSURE, FLAG_EXTERNAL_EXPOSURE, FLAG_PERSPECTIVE, FLAG_RESET, FLAG_REVERSED_DEPTH } from './shaders/common';
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
    const gpu = (label: string, format = 'rgba16float') => ({ ...resource({ label }), format }) as unknown as GPUTexture;
    return { device, writes, writeTargets, encoder, gpu };
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

    describe("depthMode: 'linear'", () => {
        const camera = { near: 0.1, far: 100, perspective: true, reversedDepth: true };
        const shaderLabels = (device: ReturnType<typeof mockDevice>['device']) =>
            (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls.map(
                ([descriptor]) => (descriptor as { code: string }).code,
            );

        it('compiles the linear reconstruct and never stages a device depth convention', async () => {
            const { device, writes, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();

            const sources = shaderLabels(device);
            expect(sources.some((code) => code.includes('var sceneDepth : texture_2d<f32>;'))).toBe(true);
            expect(sources.some((code) => code.includes('var sceneDepth : texture_depth_2d;'))).toBe(false);

            core.dispatch({ color: gpu('color'), depth: gpu('depth', 'r32float'), velocity: gpu('velocity') }, camera);
            expect(lastFlags(writes) & FLAG_REVERSED_DEPTH).toBe(0);
            expect(lastFlags(writes) & FLAG_PERSPECTIVE).toBe(FLAG_PERSPECTIVE);
        });

        it('keeps the hardware pipeline when reconfigured back', async () => {
            const { device, writes, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            expect(core.isReady).toBe(false);
            await core.prepare();
            expect(shaderLabels(device).some((code) => code.includes('var sceneDepth : texture_depth_2d;'))).toBe(true);

            core.dispatch({ color: gpu('color'), depth: gpu('depth', 'depth32float'), velocity: gpu('velocity') }, camera);
            expect(lastFlags(writes) & FLAG_REVERSED_DEPTH).toBe(FLAG_REVERSED_DEPTH);
        });

        it('names the mode when the depth input has the other encoding', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const inputs = (format: string) => ({ color: gpu('color'), depth: gpu('depth', format), velocity: gpu('velocity') });

            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            expect(() => core.dispatch(inputs('depth32float'), camera)).toThrow(/depthMode 'linear' needs a float texture/);

            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            expect(() => core.dispatch(inputs('r32float'), camera)).toThrow(/configure depthMode: 'linear'/);
        });

        it('rejects an unknown mode', () => {
            const { device } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            expect(() => core.configure({ displayWidth: 64, displayHeight: 32, depthMode: 'log' as 'linear' }))
                .toThrow(/unknown depthMode 'log'/);
        });

        it('runs the guides path on the linear reconstruct alone', async () => {
            const { device, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, path: 'guides', depthMode: 'linear' });
            await core.prepare();
            const sources = shaderLabels(device);
            expect(sources.filter((code) => code.includes('var sceneDepth'))).toHaveLength(1);
            expect(sources[sources.findIndex((code) => code.includes('var sceneDepth'))]).toContain('texture_2d<f32>');

            device.createBindGroup.mockClear();
            core.dispatchGuides({ depth: gpu('depth', 'r32float'), velocity: gpu('velocity') }, camera);
            const labels = device.createBindGroup.mock.calls.map(([descriptor]) => (descriptor as unknown as { label: string }).label);
            expect(labels).toEqual(['upscale-reconstruct', 'upscale-depth-clip']);
            expect(core.guidesPending).toBe(false);
        });

        it('feeds a split frame the same way as a monolithic one', async () => {
            const { device, encoder, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            const host = encoder as unknown as GPUCommandEncoder;
            expect(() => core.encodeGuides(host, { depth: gpu('depth', 'depth32float'), velocity: gpu('velocity') }, camera))
                .toThrow(/depthMode 'linear' needs a float texture/);
            // The rejected call opened no split frame.
            expect(core.guidesPending).toBe(false);
            core.encodeGuides(host, { depth: gpu('depth', 'r32float'), velocity: gpu('velocity') }, camera);
            core.encodeUpscale(host, { color: gpu('color') }, camera);
            expect(core.guidesPending).toBe(false);
        });

        it('checks the format in both directions, for every format of each family', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const dispatch = (format: string) =>
                core.dispatch({ color: gpu('color'), depth: gpu('depth', format), velocity: gpu('velocity') }, camera);

            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            for (const format of ['depth16unorm', 'depth24plus', 'depth24plus-stencil8', 'depth32float', 'depth32float-stencil8']) {
                expect(() => dispatch(format), format).toThrow(/depthMode 'linear' needs a float texture/);
            }
            // The contract names r32float; any float color format holds view depth in .r.
            for (const format of ['r32float', 'r16float', 'rgba16float', 'rgba32float']) {
                expect(() => dispatch(format), format).not.toThrow();
            }

            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            for (const format of ['r32float', 'r16float']) {
                expect(() => dispatch(format), format).toThrow(/configure depthMode: 'linear'/);
            }
            for (const format of ['depth16unorm', 'depth24plus-stencil8', 'depth32float']) {
                expect(() => dispatch(format), format).not.toThrow();
            }
        });

        it('asks for a depth-only view of a stencil format, and a plain view of linear depth', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const viewOf = (format: string) => {
                const depth = gpu('depth', format);
                const createView = vi.fn(() => ({}));
                (depth as unknown as { createView: unknown }).createView = createView;
                core.dispatch({ color: gpu('color'), depth, velocity: gpu('velocity') }, camera);
                return createView.mock.calls[0] as unknown[];
            };
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            expect(viewOf('depth24plus-stencil8')).toEqual([{ aspect: 'depth-only' }]);
            expect(viewOf('depth32float')).toEqual([undefined]);

            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            expect(viewOf('r32float')).toEqual([undefined]);
        });

        it('refuses linear depth for the cross-frame bench identities', () => {
            const { device } = mockDevice();
            const core = new UpscalerCore({
                device: device as unknown as GPUDevice,
                _crossFrameReconstruct: { shader: 'x', cameraCompensated: false },
            } as never);
            expect(() => core.configure({ displayWidth: 64, displayHeight: 32, depthMode: 'linear' })).toThrow(/hardware depth only/);
            expect(() => core.configure({ displayWidth: 64, displayHeight: 32 })).not.toThrow();
        });

        it('keeps the previous configuration when a mode is rejected', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, depthMode: 'linear' });
            await core.prepare();
            expect(() => core.configure({ displayWidth: 128, displayHeight: 64, depthMode: 'log' as 'linear' })).toThrow();
            expect([core.displayWidth, core.displayHeight]).toEqual([64, 32]);
            expect(core.isReady).toBe(true);
            // Still the linear pipeline: a float depth is accepted, a depth format is not.
            const inputs = (format: string) => ({ color: gpu('color'), depth: gpu('depth', format), velocity: gpu('velocity') });
            expect(() => core.dispatch(inputs('r32float'), camera)).not.toThrow();
            expect(() => core.dispatch(inputs('depth32float'), camera)).toThrow(/depthMode 'linear'/);
        });
    });

    describe('rcasAgeKnee', () => {
        const compiled = (device: ReturnType<typeof mockDevice>['device']) =>
            (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls.map(
                ([descriptor]) => (descriptor as { code: string }).code,
            );
        const kneeShaders = (device: ReturnType<typeof mockDevice>['device']) =>
            compiled(device).filter((code) => code.includes('//* Age Knee'));

        it('compiles nothing extra at the default 0', async () => {
            const { device } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(0);
        });

        it('runs the temporal path on a knee pipeline, cached per value', async () => {
            const { device, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const configure = (rcasAgeKnee?: number) =>
                core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee });
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            const camera = { near: 0.1, far: 100, perspective: true };

            configure(0.5);
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(1);
            expect(kneeShaders(device)[0]).toContain('smoothstep(0.0, 0.500000000, center.a)');
            // The knee pass binds production's five entries plus the dilated motion.
            device.createBindGroup.mockClear();
            core.dispatch(inputs, camera);
            const rcas = device.createBindGroup.mock.calls
                .map(([descriptor]) => descriptor as unknown as { label: string; entries: unknown[] })
                .filter((descriptor) => descriptor.label === 'upscale-rcas');
            expect(rcas.map((descriptor) => descriptor.entries.length)).toEqual([6]);

            // Another value is another pipeline; going back reuses the first.
            configure(0.25);
            expect(core.isReady).toBe(false);
            await core.prepare();
            configure(0.5);
            expect(core.isReady).toBe(true);
            expect(kneeShaders(device)).toHaveLength(2);
        });

        it('binds five entries without a knee, and for the ungated bench form', async () => {
            const sizes = async (options: object, rcasAgeKnee?: number) => {
                const { device, gpu } = mockDevice();
                const core = new UpscalerCore({ device: device as unknown as GPUDevice, ...options } as never);
                core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee });
                await core.prepare();
                core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, { near: 0.1, far: 100, perspective: true });
                return device.createBindGroup.mock.calls
                    .map(([descriptor]) => descriptor as unknown as { label: string; entries: unknown[] })
                    .filter((descriptor) => descriptor.label === 'upscale-rcas')
                    .map((descriptor) => descriptor.entries.length);
            };
            expect(await sizes({})).toEqual([5]);
            expect(await sizes({ _rcasAgeKneeUngated: true }, 0.5)).toEqual([5]);
        });

        it('accepts the ends of the range, and treats 0 as off', async () => {
            const { device } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: 0 });
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(0);
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: 1 });
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(1);
            expect(kneeShaders(device)[0]).toContain('center.a < 1.00000000)');
        });

        it('builds the pipeline for the exact knee configured, whatever its digits', async () => {
            const { device, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const knee = 0.1 + 0.2; // 0.30000000000000004: the pipeline name must round-trip it
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: knee });
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(1);
            expect(kneeShaders(device)[0]).toContain(`smoothstep(0.0, ${knee.toPrecision(9)}, center.a)`);
            expect(() => core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, { near: 0.1, far: 100, perspective: true })).not.toThrow();
        });

        it('keeps the gated and the ungated pipelines apart', async () => {
            const build = async (options: object) => {
                const { device } = mockDevice();
                device.createShaderModule = vi.fn(device.createShaderModule);
                const core = new UpscalerCore({ device: device as unknown as GPUDevice, ...options } as never);
                core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: 0.5 });
                await core.prepare();
                return kneeShaders(device)[0];
            };
            expect(await build({})).toContain('var dilatedMotion : texture_2d<f32>;');
            expect(await build({ _rcasAgeKneeUngated: true })).not.toContain('dilatedMotion');
        });

        it('does not sharpen through the knee pipeline on a debug view or at sharpness 0', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: 0.5 });
            await core.prepare();
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            const labels = () => device.createBindGroup.mock.calls.map(([descriptor]) => (descriptor as unknown as { label: string }).label);

            core.settings.sharpness = 0;
            device.createBindGroup.mockClear();
            core.dispatch(inputs, { near: 0.1, far: 100, perspective: true });
            expect(labels()).not.toContain('upscale-rcas');
            expect(labels()).toContain('upscale-blit');
        });

        it('keeps the previous configuration when a knee is rejected', async () => {
            const { device, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, rcasAgeKnee: 0.5 });
            await core.prepare();
            expect(() => core.configure({ displayWidth: 128, displayHeight: 64, customUpscaleRatio: 2, rcasAgeKnee: 2 })).toThrow(/rcasAgeKnee/);
            // Nothing moved: same sizes, still ready, still dispatching.
            expect([core.displayWidth, core.displayHeight]).toEqual([64, 32]);
            expect(core.isReady).toBe(true);
            expect(() => core.dispatch({ color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') }, { near: 0.1, far: 100, perspective: true })).not.toThrow();
        });

        it('leaves the spatial path on plain RCAS', async () => {
            const { device, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, path: 'spatial', rcasAgeKnee: 0.5 });
            await core.prepare();
            expect(kneeShaders(device)).toHaveLength(0);
            expect(() => core.dispatch({ color: gpu('color') }, { near: 0.1, far: 100, perspective: true })).not.toThrow();
        });

        it('rejects values outside [0, 1] and a knee on an overridden RCAS', () => {
            const { device } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            for (const rcasAgeKnee of [-0.1, 1.5, Number.NaN]) {
                expect(() => core.configure({ displayWidth: 64, displayHeight: 32, rcasAgeKnee })).toThrow(/rcasAgeKnee must be in \[0, 1\]/);
            }
            const overridden = new UpscalerCore({ device: device as unknown as GPUDevice, _rcasShader: 'x' } as never);
            expect(() => overridden.configure({ displayWidth: 64, displayHeight: 32, rcasAgeKnee: 0.5 })).toThrow(/_rcasShader override/);
        });
    });

    describe("exposureMode: 'provided'", () => {
        const camera = { near: 0.1, far: 100, perspective: true };
        const compiled = (device: ReturnType<typeof mockDevice>['device']) =>
            (device.createShaderModule as ReturnType<typeof vi.fn>).mock.calls.map(
                ([descriptor]) => (descriptor as { code: string }).code,
            );
        const metering = (code: string) => code.includes('EXPOSURE_TAPS');
        const publishing = (code: string) => code.includes('vec4f(exposure, 0.0, host, 0.0)');
        // Bind groups created by one dispatch, by entry count.
        const bindGroupSizes = (device: ReturnType<typeof mockDevice>['device'], run: () => void) => {
            const create = vi.fn(device.createBindGroup);
            device.createBindGroup = create;
            run();
            return create.mock.calls.map(([descriptor]) => (descriptor as unknown as { entries: unknown[] }).entries.length);
        };

        it('never compiles or runs the luminance measurement', async () => {
            const { device, writes, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, exposureMode: 'provided' });
            await core.prepare();
            expect(compiled(device).some(metering)).toBe(false);
            expect(compiled(device).filter(publishing)).toHaveLength(1);

            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            const sizes = bindGroupSizes(device, () => core.dispatch(inputs, camera));
            // The metered exposure pass binds 7 entries; the provided one binds 4.
            expect(sizes).not.toContain(7);
            expect(sizes).toContain(4);
            // settings.autoExposure defaults to true and must not reach the shaders.
            expect(core.settings.autoExposure).toBe(true);
            expect(lastFlags(writes) & FLAG_AUTO_EXPOSURE).toBe(0);
        });

        it('takes the conditioning exposure from the frame texture when one is passed', async () => {
            const { device, writes, gpu } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, exposureMode: 'provided' });
            await core.prepare();
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };

            core.dispatch(inputs, camera);
            expect(lastFlags(writes) & FLAG_EXTERNAL_EXPOSURE).toBe(0);
            core.dispatch({ ...inputs, exposureTexture: gpu('exposure') }, camera);
            expect(lastFlags(writes) & (FLAG_EXTERNAL_EXPOSURE | FLAG_AUTO_EXPOSURE)).toBe(FLAG_EXTERNAL_EXPOSURE);
        });

        it('keeps metering by default, and when reconfigured back', async () => {
            const { device, writes, gpu } = mockDevice();
            device.createShaderModule = vi.fn(device.createShaderModule);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, exposureMode: 'provided' });
            await core.prepare();
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            expect(core.isReady).toBe(false);
            await core.prepare();
            expect(compiled(device).filter(metering)).toHaveLength(1);

            const sizes = bindGroupSizes(device, () => core.dispatch(inputs, camera));
            expect(sizes).toContain(7);
            expect(lastFlags(writes) & FLAG_AUTO_EXPOSURE).toBe(FLAG_AUTO_EXPOSURE);
        });

        it('rejects an unknown mode', () => {
            const { device } = mockDevice();
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            expect(() => core.configure({ displayWidth: 64, displayHeight: 32, exposureMode: 'auto' as 'upstream' }))
                .toThrow(/unknown exposureMode 'auto'/);
        });
    });

    describe('hostPreExposure (CPU-side host pre-exposure)', () => {
        const camera = { near: 0.1, far: 100, perspective: true };
        // The texture each dispatch binds as the exposure pass's host pre-exposure
        // (its last entry), by label.
        const boundHostTextures = (device: ReturnType<typeof mockDevice>['device'], run: () => void) => {
            const create = vi.fn(device.createBindGroup);
            device.createBindGroup = create;
            run();
            return create.mock.calls
                .map(([descriptor]) => descriptor as unknown as { label: string; entries: { resource: { owner?: string } }[] })
                .filter((descriptor) => descriptor.label === 'upscale-exposure')
                .map((descriptor) => descriptor.entries.at(-1)!.resource.owner);
        };
        // Views that remember the texture they came from.
        const tracked = (device: ReturnType<typeof mockDevice>['device']) => {
            const createTexture = device.createTexture;
            device.createTexture = vi.fn((descriptor?: { label?: string }) => {
                const texture = createTexture(descriptor);
                return { ...texture, createView: () => ({ owner: descriptor?.label }) };
            }) as typeof device.createTexture;
        };

        it('reaches the exposure pass through the core-owned texel, written when the value changes', async () => {
            const { device, gpu } = mockDevice();
            tracked(device);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            const hostWrites = () =>
                device.queue.writeTexture.mock.calls.filter(
                    ([target]) => (target as { texture: { label?: string } }).texture.label === 'upscale-host-pre-exposure',
                );

            expect(boundHostTextures(device, () => core.dispatch(inputs, camera))).toEqual(['upscale-reactive-dummy']);
            expect(hostWrites()).toHaveLength(0);

            expect(boundHostTextures(device, () => core.dispatch({ ...inputs, hostPreExposure: 2.5 }, camera)))
                .toEqual(['upscale-host-pre-exposure']);
            expect(hostWrites()).toHaveLength(1);
            expect(Array.from(hostWrites()[0][1] as Float32Array)).toEqual([2.5]);

            // The same value again is not rewritten; a new one is.
            core.dispatch({ ...inputs, hostPreExposure: 2.5 }, camera);
            expect(hostWrites()).toHaveLength(1);
            core.dispatch({ ...inputs, hostPreExposure: 1.25 }, camera);
            expect(hostWrites()).toHaveLength(2);
        });

        it('lets preExposureTexture win, and rejects values that are not positive and finite', async () => {
            const { device, gpu } = mockDevice();
            tracked(device);
            const core = new UpscalerCore({ device: device as unknown as GPUDevice });
            core.configure({ displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2 });
            await core.prepare();
            const inputs = { color: gpu('color'), depth: gpu('depth'), velocity: gpu('velocity') };
            const app = { ...gpu('app'), createView: () => ({ owner: 'app-texture' }) } as unknown as GPUTexture;

            expect(boundHostTextures(device, () => core.dispatch({ ...inputs, preExposureTexture: app, hostPreExposure: 2 }, camera)))
                .toEqual(['app-texture']);
            const hostWrites = device.queue.writeTexture.mock.calls.filter(
                ([target]) => (target as { texture: { label?: string } }).texture.label === 'upscale-host-pre-exposure',
            );
            expect(hostWrites).toHaveLength(0);
            for (const hostPreExposure of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
                expect(() => core.dispatch({ ...inputs, hostPreExposure }, camera)).toThrow(/hostPreExposure must be a finite number/);
            }
        });
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
