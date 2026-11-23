import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { Upscaler } from './Upscaler';
import type { UpscalerConfig } from './types';

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
    const core = { configure: vi.fn(), dispatch: vi.fn(), dispatchGuides: vi.fn(), dispatchUpscale: vi.fn() };
    Object.assign(upscaler as unknown as object, { _core: core });
    return { upscaler, core, gpu: (texture: object) => gpuOf.get(texture) };
}

describe('three Upscaler forwarding', () => {
    it('hands configure() to the core unchanged, so every option reaches it', () => {
        const { upscaler, core } = upscalerWithCore();
        const config: UpscalerConfig = { displayWidth: 64, displayHeight: 32, customUpscaleRatio: 2, jitter: false, depthMode: 'linear' };
        upscaler.configure(config);
        expect(core.configure).toHaveBeenCalledTimes(1);
        expect(core.configure.mock.calls[0][0]).toBe(config);
    });

    it('resolves a linear depth texture like any other input', () => {
        const { upscaler, core, gpu } = upscalerWithCore();
        const color = new Texture();
        const depth = new Texture();
        const velocity = new Texture();
        upscaler.dispatch({ color, depth, velocity, deltaTime: 0.02 }, new PerspectiveCamera());
        expect(core.dispatch.mock.calls[0][0]).toMatchObject({ color: gpu(color), depth: gpu(depth), velocity: gpu(velocity), deltaTime: 0.02 });

        upscaler.dispatchGuides({ depth, velocity }, new PerspectiveCamera());
        expect(core.dispatchGuides.mock.calls[0][0]).toMatchObject({ depth: gpu(depth), velocity: gpu(velocity) });
    });
});
