import { describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';
import { prepareComputeAction } from './prepareComputeAction';

function fixture() {
    const events: unknown[] = [];
    const renderer = {
        backend: { device: {} },
        compileComputeAsync: vi.fn(async node => { events.push(['compile',node]); }),
        compute: vi.fn((node) => events.push(['compute',node.parameters.layer.value])),
        copyTextureToTexture: vi.fn(() => events.push(['copy'])),
    };
    return { renderer, gpu: renderer as unknown as WebGPURenderer, events };
}
describe('async setup compute preparation', () => {
    it('replays changing uniform values and copies in order after preparation', async () => {
        const { renderer, gpu, events } = fixture();
        const node = { version:0, parameters:{layer:{value:0}} };
        await prepareComputeAction(gpu, () => {
            for (let i=0;i<3;i++) {
                node.parameters.layer.value=i;
                gpu.compute(node as never);
                if(i===0) gpu.copyTextureToTexture({} as never,{} as never);
            }
            node.parameters.layer.value=9;
        });
        expect(events).toEqual([['compile',node],['compute',0],['copy'],['compute',1],['compute',2]]);
        expect(node.parameters.layer.value).toBe(9);
        expect(renderer.compileComputeAsync).toHaveBeenCalledTimes(1);
    });
    it('keeps copied resources alive until their recorded dispatch is submitted', async () => {
        const { renderer, gpu, events } = fixture();
        const resource = { alive:true, dispose:vi.fn(() => { resource.alive=false; events.push(['dispose']); }) };
        const original = resource.dispose;
        const node = { parameters:{layer:{value:1},source:{value:resource}} };
        renderer.compute=vi.fn(() => { expect(resource.alive).toBe(true); return events.push(['dispatch']); });
        await prepareComputeAction(gpu,()=>{ gpu.compute(node as never); resource.dispose(); expect(resource.alive).toBe(true); });
        expect(events).toEqual([['compile',node],['dispatch'],['dispose']]);
        expect(resource.dispose).toBe(original);
        expect(original).toHaveBeenCalledOnce();
    });

    it('restores methods and releases ownership after setup or compiler failure', async () => {
        const { renderer, gpu } = fixture();
        const compute=renderer.compute, copy=renderer.copyTextureToTexture;
        await expect(prepareComputeAction(gpu,()=>{throw new Error('setup');})).rejects.toThrow('setup');
        expect(renderer.compute).toBe(compute); expect(renderer.copyTextureToTexture).toBe(copy);
        renderer.compileComputeAsync.mockRejectedValueOnce(new Error('compile'));
        const node={parameters:{layer:{value:0}}};
        await expect(prepareComputeAction(gpu,()=>gpu.compute(node as never))).rejects.toThrow('compile');
        await prepareComputeAction(gpu,()=>gpu.compute(node as never));
        expect(renderer.compute).toBe(compute);
    });

    it('releases recorded disposals when shader preparation fails', async () => {
        const { renderer, gpu } = fixture();
        const resource = { dispose:vi.fn() };
        const original=resource.dispose;
        const node={parameters:{layer:{value:1},source:{value:resource}}};
        renderer.compileComputeAsync.mockRejectedValueOnce(new Error('compile'));
        await expect(prepareComputeAction(gpu,()=>{gpu.compute(node as never);resource.dispose();})).rejects.toThrow('compile');
        expect(resource.dispose).toBe(original);
        expect(original).toHaveBeenCalledOnce();
    });

    it('prepares all nodes of an array before dispatch and isolates devices', async () => {
        const one=fixture(),two=fixture();
        const a={version:0,parameters:{layer:{value:1}}},b={version:0,parameters:{layer:{value:2}}};
        one.renderer.compute=vi.fn(()=>one.events.push(['dispatch']));
        await prepareComputeAction(one.gpu,()=>one.gpu.compute([a,b] as never));
        expect(one.events).toEqual([['compile',a],['compile',b],['dispatch']]);
        await prepareComputeAction(two.gpu,()=>two.gpu.compute(a as never));
        expect(two.renderer.compileComputeAsync).toHaveBeenCalledOnce();
        one.renderer.backend.device={};
        await prepareComputeAction(one.gpu,()=>one.gpu.compute(a as never));
        expect(one.renderer.compileComputeAsync).toHaveBeenCalledTimes(3);
    });
});
