import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler';

// GPU-free: the core is a stub, so only what the three adapter hands it is checked.
function upscalerWithCore() {
    const gpuOf = new Map<object, { label: string }>();
    const renderer = {
        reversedDepthBuffer: false,
        backend: {
            device: {},
            get: (texture: object) => {
                if (!gpuOf.has(texture)) gpuOf.set(texture, { label: `gpu-${gpuOf.size}` });
                return { texture: gpuOf.get(texture) };
            },
        },
    } as unknown as WebGPURenderer;
    const upscaler = new Upscaler({ renderer });
    const core = { configure: vi.fn(), dispatch: vi.fn(), dispatchUpscale: vi.fn() };
    Object.assign(upscaler as unknown as object, { _core: core });
    return { upscaler, core, gpu: (texture: object) => gpuOf.get(texture) };
}

describe('three Upscaler exposure inputs', () => {
    it('passes exposureMode to the core with the rest of the configuration', () => {
        const { upscaler, core } = upscalerWithCore();
        const config = { displayWidth: 64, displayHeight: 32, exposureMode: 'provided' as const };
        upscaler.configure(config);
        expect(core.configure.mock.calls[0][0]).toBe(config);
    });

    it('forwards the exposure textures as GPU textures and hostPreExposure as a number', () => {
        const { upscaler, core, gpu } = upscalerWithCore();
        const color = new Texture();
        const exposureTexture = new Texture();
        const preExposureTexture = new Texture();
        upscaler.dispatch({ color, exposureTexture, preExposureTexture, hostPreExposure: 2.5 }, new PerspectiveCamera());
        expect(core.dispatch.mock.calls[0][0]).toMatchObject({
            color: gpu(color),
            exposureTexture: gpu(exposureTexture),
            preExposureTexture: gpu(preExposureTexture),
            hostPreExposure: 2.5,
        });

        upscaler.dispatchUpscale({ color, hostPreExposure: 0.5 }, new PerspectiveCamera());
        expect(core.dispatchUpscale.mock.calls[0][0]).toMatchObject({ hostPreExposure: 0.5 });
    });

    it('leaves the inputs undefined when the app passes none', () => {
        const { upscaler, core } = upscalerWithCore();
        upscaler.dispatch({ color: new Texture() }, new PerspectiveCamera());
        const inputs = core.dispatch.mock.calls[0][0] as Record<string, unknown>;
        expect(inputs.exposureTexture).toBeUndefined();
        expect(inputs.preExposureTexture).toBeUndefined();
        expect(inputs.hostPreExposure).toBeUndefined();
    });
});
