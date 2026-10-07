import { afterEach, describe, expect, it, vi } from 'vitest';
import { Constants } from '@babylonjs/core/Engines/constants.js';
import { FrameGraphUpscaleTask, getBabylonTextureOptions } from './FrameGraphUpscaleTask.js';
import { getResourceDescriptors } from '../core/resources.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';

describe('Babylon Frame Graph recording', () => {
    afterEach(() => vi.unstubAllGlobals());
    it('maps every history, storage format and odd-sized atlas to Babylon allocation options', () => {
        const descriptors = getResourceDescriptors({ renderWidth: 7, renderHeight: 5, displayWidth: 11, displayHeight: 9, exposureMode: 'provided' });
        for (const d of descriptors) {
            const options = getBabylonTextureOptions(d);
            expect(options.size).toEqual({ width: d.width, height: d.height });
            expect(options.isHistoryTexture).toBe(d.history);
            expect(options.options.creationFlags![0]).toBe(d.usage & 8 ? Constants.TEXTURE_CREATIONFLAG_STORAGE : 0);
        }
        expect(getBabylonTextureOptions(descriptors.find(d => d.name === 'shadingBlockMemory')!).options.formats).toEqual([Constants.TEXTUREFORMAT_RGBA_INTEGER]);
        expect(getBabylonTextureOptions(descriptors.find(d => d.name === 'exposure')!).options.types).toEqual([Constants.TEXTURETYPE_FLOAT]);
    });
    it.each(['temporal', 'spatial', 'bilinear'] as const)('records %s with only the inputs required by that path', path => {
        vi.stubGlobal('GPUBufferUsage', { UNIFORM: 64, COPY_DST: 8, STORAGE: 128 });
        let handle = 10;
        const passes: { disabled: boolean; output?: number; dependencies: number[] }[] = [];
        const device = { lost: new Promise(() => {}), createBuffer: (d: { size: number }) => ({ getMappedRange: () => new ArrayBuffer(d.size), unmap() {}, destroy() {} }), createSampler: () => ({}) };
        const graph = {
            engine: { _device: device, _renderEncoder: {}, _endCurrentRenderPass() {} },
            textureManager: { createDanglingHandle: () => handle++, createRenderTargetTexture: () => handle++, resolveDanglingHandle: vi.fn() },
            addRenderPass: (_name: string, disabled: boolean) => {
                const p = { disabled, dependencies: [] as number[], output: undefined as number | undefined }; passes.push(p);
                return { setRenderTarget: (h: number) => { p.output = h; }, addDependencies: (h: number[]) => p.dependencies.push(...h), setExecuteFunc() {} };
            },
        };
        const task = new FrameGraphUpscaleTask('test', graph as unknown as FrameGraph, { configuration: { renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, path }, frame: () => ({ frameIndex: 0 }) });
        task.colorTexture = 1;
        if (path === 'temporal') { task.depthTexture = 2; task.velocityTexture = 3; task.reactiveTexture = 4; task.exposureTexture = 5; }
        task.record();
        expect(passes.map(p => p.disabled)).toEqual([false, true]);
        expect(passes[0].output).toBe(passes[1].output);
        expect(passes[0].dependencies).toEqual(passes[1].dependencies);
        const inputs = path === 'temporal' ? [1, 2, 3, 4, 5] : [1];
        expect(passes[0].dependencies.slice(0, inputs.length)).toEqual(inputs);
        expect(passes[0].dependencies).toHaveLength(inputs.length + getResourceDescriptors({ renderWidth: 4, renderHeight: 4, displayWidth: 8, displayHeight: 8, path }).length);
        const projection = { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]), clone() { return { ...this, fromArray() {} }; } };
        const camera = { getProjectionMatrix: () => projection, freezeProjectionMatrix() {}, unfreezeProjectionMatrix() {} };
        task.beginFrame(camera as unknown as Parameters<typeof task.beginFrame>[0]);
        if (path !== 'temporal') expect(task.jitter).toEqual({ x: 0, y: 0 });
        task.endFrame();
        expect(task.isReady()).toBe(false);
        task.disabled = true; expect(() => { task.disabled = false; }).toThrow('activate'); task.dispose();
    });
});
