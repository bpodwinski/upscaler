import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { adapterInfoRecord, gpuAuditSource } from './gpu-audit.mjs';

function fixture(options = {}) {
    const info = Object.create({ get vendor() { return 'intel'; }, get architecture() { return 'gen-12lp'; },
        get device() { return ''; }, get description() { return ''; } });
    const calls = [];
    class Adapter {
        info = info;
        async requestDevice(descriptor) {
            calls.push(descriptor);
            return { features: new Set(descriptor.requiredFeatures ?? []),
                limits: { maxTextureDimension2D: 8192, maxComputeInvocationsPerWorkgroup: 256 },
                lost: new Promise(() => {}) };
        }
    }
    const adapter = new Adapter();
    const gpu = { async requestAdapter(descriptor) { calls.push(descriptor); return adapter; } };
    const window = { GPUAdapter: Adapter };
    runInNewContext(gpuAuditSource(options), { window, navigator: { gpu }, GPUAdapter: Adapter });
    return { gpu, adapter, calls, audit: window.__gpuAudit, info };
}
describe('GPU audit identity and selection', () => {
    it('copies inherited WebIDL getters that JSON serialization omits', () => {
        const { info } = fixture();
        expect(JSON.stringify(info)).toBe('{}');
        expect(adapterInfoRecord(info)).toEqual({ vendor:'intel', architecture:'gen-12lp', device:'', description:'' });
    });
    it('preserves other request options and records the actual device', async () => {
        const { gpu, calls, audit } = fixture({ 'power-preference':'low-power', 'expected-vendor':'INTEL' });
        const adapter = await gpu.requestAdapter({ powerPreference:'high-performance', forceFallbackAdapter:false });
        await adapter.requestDevice({ requiredFeatures:['timestamp-query'] });
        expect(calls[0]).toEqual({ powerPreference:'low-power', forceFallbackAdapter:false });
        expect(audit.devices[0].info.vendor).toBe('intel');
        expect(audit.devices[0].features).toEqual(['timestamp-query']);
    });
    it('rejects a ignored preference before allocating a device', async () => {
        const { gpu, audit } = fixture({ 'expected-vendor':'nvidia' });
        await expect(gpu.requestAdapter()).rejects.toThrow('received intel');
        expect(audit.devices).toEqual([]);
    });
    it('requests a real device without timestamps while preserving other features', async () => {
        const { gpu, calls, audit } = fixture({ 'without-timestamps':true });
        await (await gpu.requestAdapter()).requestDevice({ requiredFeatures:['shader-f16','timestamp-query'] });
        expect(calls[1].requiredFeatures).toEqual(['shader-f16']);
        expect(audit.devices[0].features).toEqual(['shader-f16']);
    });
    it('rejects invalid selection flags before launching browsers', () => {
        expect(() => gpuAuditSource({ 'power-preference':true })).toThrow('power-preference');
        expect(() => gpuAuditSource({ 'expected-vendor':true })).toThrow('expected-vendor');
    });
});
