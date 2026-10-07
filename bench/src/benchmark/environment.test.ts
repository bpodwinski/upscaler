import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three/webgpu';
import { collectBenchmarkEnvironment } from './environment';
afterEach(() => vi.unstubAllGlobals());
describe('benchmark environment adapter identity', () => {
    it('uses the rendering device even when a fresh/default adapter would differ', async () => {
        const requestAdapter = vi.fn(() => { throw new Error('Must not request a probe adapter'); });
        vi.stubGlobal('navigator', { userAgent:'Chrome test', platform:'Win32', gpu:{requestAdapter} });
        const renderer = { backend:{ isWebGPUBackend:true,
            device:{ adapterInfo:{vendor:'nvidia',architecture:'ampere',device:'',description:''},
                features:new Set(['timestamp-query','shader-f16']) },
            adapter:{info:{vendor:'intel',architecture:'gen-12lp'}} } };
        const config = {dimensions:{width:1280,height:720,devicePixelRatio:1},ratio:2,timestepSeconds:1/60};
        const result = await collectBenchmarkEnvironment(renderer as unknown as THREE.WebGPURenderer,
            config as BenchmarkRunConfig);
        expect(result.adapter).toBe('nvidia ampere');
        expect(result.webgpuFeatures).toEqual(['shader-f16','timestamp-query']);
        expect(requestAdapter).not.toHaveBeenCalled();
    });
});
