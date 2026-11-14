import type { Renderer, Texture } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

import { Upscaler } from './Upscaler';

// GPU-free: a stand-in renderer and core, checking only the adapter's wiring.
function upscalerWithCore() {
    const gpuOf = new Map<unknown, GPUTexture>();
    const renderer = {
        type: 2, // RendererType.WEBGPU
        gpu: { device: {} },
        encoder: { commandEncoder: {} },
        renderTarget: { finishRenderPass: () => {} },
        texture: {
            getGpuSource: (source: unknown) => {
                if (!gpuOf.has(source)) gpuOf.set(source, { label: `gpu-${gpuOf.size}` } as GPUTexture);
                return gpuOf.get(source)!;
            },
        },
    };
    const upscaler = new Upscaler({ renderer: renderer as unknown as Renderer });
    const core = { configure: vi.fn(), dispatch: vi.fn(), encode: vi.fn() };
    Object.assign(upscaler as unknown as object, { _core: core });
    return { upscaler, core, gpu: (texture: Texture) => renderer.texture.getGpuSource(texture.source) };
}
const texture = () => ({ source: {} }) as unknown as Texture;
const frameCamera = { near: 0.1, far: 100, perspective: true };

describe('pixi exposure inputs', () => {
    it('passes exposureMode to the core with the rest of the configuration', () => {
        const { upscaler, core } = upscalerWithCore();
        const config = { displayWidth: 8, displayHeight: 8, exposureMode: 'provided' as const };
        upscaler.configure(config);
        expect(core.configure.mock.calls[0][0]).toBe(config);
    });

    it('forwards the exposure textures as GPU textures and hostPreExposure as a number', () => {
        const { upscaler, core, gpu } = upscalerWithCore();
        upscaler.configure({ displayWidth: 8, displayHeight: 8, path: 'temporal' });
        const color = texture();
        const depth = texture();
        const velocity = texture();
        const exposureTexture = texture();
        const preExposureTexture = texture();
        upscaler.dispatch({ color, depth, velocity, exposureTexture, preExposureTexture, hostPreExposure: 2.5 }, frameCamera);
        expect(core.dispatch.mock.calls[0][0]).toMatchObject({
            color: gpu(color),
            exposureTexture: gpu(exposureTexture),
            preExposureTexture: gpu(preExposureTexture),
            hostPreExposure: 2.5,
        });
    });
});
