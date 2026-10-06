import { describe, expect, it, vi } from 'vitest';
import { ComputePass } from './ComputePass';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}

function mockDevice() {
    const lost = deferred<GPUDeviceLostInfo>();
    const jobs: ReturnType<typeof deferred<GPUComputePipeline>>[] = [];
    const device = {
        lost: lost.promise,
        createShaderModule: vi.fn(() => ({})),
        createComputePipelineAsync: vi.fn(() => {
            const job = deferred<GPUComputePipeline>();
            jobs.push(job);
            return job.promise;
        }),
        createBindGroup: vi.fn(value => value),
    };
    return { device: device as unknown as GPUDevice, spy: device, jobs, lost };
}
const pipeline = () => ({ getBindGroupLayout: vi.fn(() => ({})) }) as unknown as GPUComputePipeline;

describe('async compute pipeline cache', () => {
    it('shares in-flight pipelines by source and sorted constants, retaining per-pass metadata', async () => {
        const { device, spy, jobs } = mockDevice();
        const a = ComputePass.create(device, 'a', 'source', { constants: { B: 2, A: 1 }, shaderKey: 'a' });
        const b = ComputePass.create(device, 'b', 'source', { constants: { A: 1, B: 2 }, shaderKey: 'b' });
        expect(spy.createComputePipelineAsync).toHaveBeenCalledTimes(1);
        jobs[0].resolve(pipeline());
        const [first, second] = await Promise.all([a, b]);
        expect(first.pipeline).toBe(second.pipeline);
        expect(first.metadata.shaderKey).toBe('a');
        expect(second.metadata.shaderKey).toBe('b');
        first.createBindGroup([]);
        expect(spy.createBindGroup).toHaveBeenCalledWith(expect.objectContaining({
            layout: first.pipeline.getBindGroupLayout(0),
        }));
    });

    it('separates sources, specialization constants and devices, sharing modules by source', async () => {
        const one = mockDevice(), two = mockDevice();
        const requests = [
            ComputePass.create(one.device, 'same', 'one', { constants: { A: 1 } }),
            ComputePass.create(one.device, 'same', 'one', { constants: { A: 2 } }),
            ComputePass.create(one.device, 'same', 'two'),
            ComputePass.create(two.device, 'same', 'one', { constants: { A: 1 } }),
        ];
        expect(one.spy.createShaderModule).toHaveBeenCalledTimes(2);
        expect(two.spy.createShaderModule).toHaveBeenCalledTimes(1);
        [...one.jobs, ...two.jobs].forEach(job => job.resolve(pipeline()));
        const passes = await Promise.all(requests);
        expect(new Set(passes.map(pass => pass.pipeline)).size).toBe(4);
    });

    it('limits compilation to four requests across callers', async () => {
        const { device, spy, jobs } = mockDevice();
        const requests = Array.from({ length: 9 }, (_, i) => ComputePass.create(device, String(i), String(i)));
        expect(spy.createComputePipelineAsync).toHaveBeenCalledTimes(4);
        for (let i = 0; i < 9; i++) {
            jobs[i].resolve(pipeline());
            await requests[i];
        }
        expect(spy.createComputePipelineAsync).toHaveBeenCalledTimes(9);
    });

    it('evicts failures so an explicit retry can compile again', async () => {
        const { device, spy, jobs } = mockDevice();
        const first = ComputePass.create(device, 'a', 'source');
        jobs[0].reject(new Error('bad shader'));
        await expect(first).rejects.toThrow('bad shader');
        const second = ComputePass.create(device, 'a', 'source');
        jobs[1].resolve(pipeline());
        await second;
        expect(spy.createComputePipelineAsync).toHaveBeenCalledTimes(2);
    });

    it('rejects queued and active work on loss and never reuses a lost device', async () => {
        const { device, jobs, lost } = mockDevice();
        const requests = Array.from({ length: 6 }, (_, i) => ComputePass.create(device, String(i), String(i)));
        const results = Promise.allSettled(requests);
        lost.resolve({} as GPUDeviceLostInfo);
        await Promise.resolve();
        jobs.forEach(job => job.resolve(pipeline()));
        expect((await results).every(result => result.status === 'rejected')).toBe(true);
        await expect(ComputePass.create(device, 'new', 'new')).rejects.toThrow('device lost');
    });
});
