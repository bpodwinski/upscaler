import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { InternalTexture } from '@babylonjs/core/Materials/Textures/internalTexture.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { describe, expect, it, vi } from 'vitest';

import { FrameGraphUpscaleTask } from './FrameGraphUpscaleTask';
import { Upscaler } from './Upscaler';

// GPU-free: a stand-in engine, core and frame graph, checking only the wiring.
const gpuTexture = (label: string) => ({ label, destroy: vi.fn(), createView: vi.fn() }) as unknown as GPUTexture;
const internal = (gpu: GPUTexture) => ({ _hardwareTexture: { underlyingResource: gpu } }) as unknown as InternalTexture;
// A 60° vertical FOV: the projection's y scale is 1 / tan(30°).
const getProjectionMatrix = () => ({ m: [0, 0, 0, 0, 0, 1 / Math.tan(Math.PI / 6)] });
const camera = { minZ: 0.1, maxZ: 100, mode: 0, ignoreCameraMaxZ: false, getProjectionMatrix } as unknown as Camera;

function upscalerWithCore() {
    const engine = { isWebGPU: true, useReverseDepthBuffer: false, _device: {}, flushFramebuffer: () => {} };
    const upscaler = new Upscaler({ engine: engine as unknown as AbstractEngine, scene: {} as Scene });
    const core = { configure: vi.fn(), dispatch: vi.fn(), beginFrame: () => null, isReady: true, output: {} };
    // The jitter target stands in for the scene's TAA material manager.
    Object.assign(upscaler as unknown as object, { _core: core, _jitterMaterials: { jitter: { set() {} } } });
    return { upscaler, core };
}

describe('Babylon exposure inputs', () => {
    it('passes exposureMode to the core with the rest of the configuration', () => {
        const { upscaler, core } = upscalerWithCore();
        const config = { displayWidth: 64, displayHeight: 32, exposureMode: 'provided' as const };
        upscaler.configure(config);
        expect(core.configure.mock.calls[0][0]).toBe(config);
    });

    it('forwards the exposure textures as GPU textures and hostPreExposure as a number', () => {
        const { upscaler, core } = upscalerWithCore();
        const color = gpuTexture('color');
        const exposure = gpuTexture('exposure');
        const preExposure = gpuTexture('pre-exposure');
        upscaler.dispatch(
            { color: internal(color), exposureTexture: internal(exposure), preExposureTexture: internal(preExposure), hostPreExposure: 2.5 },
            camera,
        );
        expect(core.dispatch.mock.calls[0][0]).toMatchObject({
            color,
            exposureTexture: exposure,
            preExposureTexture: preExposure,
            hostPreExposure: 2.5,
        });
    });

    it('carries the frame graph task\'s hostPreExposure into the dispatch', () => {
        const { upscaler } = upscalerWithCore();
        const dispatch = vi.spyOn(upscaler, 'dispatch').mockImplementation(() => {});
        vi.spyOn(upscaler, 'beginFrame').mockImplementation(() => null);
        vi.spyOn(upscaler, 'endFrame').mockImplementation(() => {});
        Object.defineProperty(upscaler, 'outputTexture', { get: () => ({}) });
        Object.defineProperty(upscaler, 'isReady', { get: () => true });
        let execute: () => void = () => {};
        const colorTexture = internal(gpuTexture('color'));
        const frameGraph = {
            engine: { getDeltaTime: () => 20 },
            textureManager: {
                createDanglingHandle: () => 100,
                importTexture: () => 101,
                resolveDanglingHandle: () => {},
                getTextureFromHandle: () => colorTexture,
            },
            addPass: () => ({ setExecuteFunc: (run: () => void) => { execute = run; } }),
        };
        const task = new FrameGraphUpscaleTask('upscale', frameGraph as unknown as FrameGraph, upscaler);
        task.camera = camera;
        task.colorTexture = 1;
        task.hostPreExposure = 1.5;
        task.record();
        execute();
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][0]).toMatchObject({ color: colorTexture, hostPreExposure: 1.5, deltaTime: 0.02 });

        // Unset, it stays out of the way.
        task.hostPreExposure = undefined;
        task.record();
        execute();
        expect((dispatch.mock.calls[1][0] as { hostPreExposure?: number }).hostPreExposure).toBeUndefined();
    });
});
