import { describe, expect, it, vi } from 'vitest';
import { Matrix4, Texture } from 'three';
import type * as THREE from 'three/webgpu';

// GPU-free: the Upscaler (device, pipelines, textures) is replaced by a stub, so
// only UpscalePass's own three objects — plain JS until a renderer touches
// them — are exercised.
vi.mock('./Upscaler', () => ({
    Upscaler: class {
        readonly unjitteredProjectionMatrix = new Matrix4();
        init = vi.fn();
        dispose = vi.fn();
        configure = vi.fn();
        renderWidth = 8;
        renderHeight = 8;
        outputTexture = new Texture();
    },
}));

const { UpscalePass } = await import('./UpscalePass');

type PassInternals = {
    _quad: THREE.QuadMesh;
    _quadMaterial: THREE.NodeMaterial;
    _rt: THREE.RenderTarget | null;
};

describe('UpscalePass.dispose', () => {
    it('disposes the present material, the render target and the upscaler', () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        const internals = pass as unknown as PassInternals;
        const materialDisposed = vi.fn();
        internals._quadMaterial.addEventListener('dispose', materialDisposed);
        const rtDispose = vi.fn();
        internals._rt = { dispose: rtDispose } as unknown as THREE.RenderTarget;

        pass.dispose();

        expect(materialDisposed).toHaveBeenCalledTimes(1);
        expect(rtDispose).toHaveBeenCalledTimes(1);
        expect(internals._rt).toBeNull();
        expect(pass.upscaler.dispose).toHaveBeenCalledTimes(1);
    });

    it("leaves three's shared quad geometry alone", () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        const geometryDisposed = vi.fn();
        (pass as unknown as PassInternals)._quad.geometry.addEventListener('dispose', geometryDisposed);

        pass.dispose();

        expect(geometryDisposed).not.toHaveBeenCalled();
    });
});

describe('UpscalePass.configure', () => {
    const configured = (config: Parameters<InstanceType<typeof UpscalePass>['configure']>[0]) => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        pass.configure(config);
        const configure = pass.upscaler.configure as unknown as ReturnType<typeof vi.fn>;
        return configure.mock.calls[0][0] as Record<string, unknown>;
    };

    it('forwards rcasAgeKnee to the upscaler, and leaves it unset by default', () => {
        expect(configured({ displayWidth: 64, displayHeight: 32, rcasAgeKnee: 0.5 })).toMatchObject({
            displayWidth: 64,
            displayHeight: 32,
            path: 'temporal',
            rcasAgeKnee: 0.5,
        });
        expect(configured({ displayWidth: 64, displayHeight: 32 }).rcasAgeKnee).toBeUndefined();
    });

    it("rejects the 'guides' path before touching the upscaler", () => {
        const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
        expect(() => pass.configure({ displayWidth: 64, displayHeight: 32, path: 'guides' })).toThrow(/guides/);
        expect(pass.upscaler.configure).not.toHaveBeenCalled();
    });
});

describe('UpscalePass.configure exposureMode', () => {
    it('forwards the mode beside the knee, and leaves it unset by default', () => {
        const configure = (config: Parameters<InstanceType<typeof UpscalePass>['configure']>[0]) => {
            const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
            pass.configure(config);
            return (pass.upscaler.configure as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
        };
        expect(configure({ displayWidth: 64, displayHeight: 32, exposureMode: 'provided', rcasAgeKnee: 0.5 })).toMatchObject({
            exposureMode: 'provided',
            rcasAgeKnee: 0.5,
        });
        expect(configure({ displayWidth: 64, displayHeight: 32 }).exposureMode).toBeUndefined();
    });
});

describe('UpscalePass.configure correctConditioningExposure', () => {
    it('forwards the flag beside the exposure mode, and leaves it unset by default', () => {
        const configure = (config: Parameters<InstanceType<typeof UpscalePass>['configure']>[0]) => {
            const pass = new UpscalePass({} as THREE.WebGPURenderer, { shareVelocityMatrix: false });
            pass.configure(config);
            return (pass.upscaler.configure as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
        };
        expect(configure({ displayWidth: 64, displayHeight: 32, correctConditioningExposure: true, exposureMode: 'provided' }))
            .toMatchObject({ correctConditioningExposure: true, exposureMode: 'provided' });
        expect(configure({ displayWidth: 64, displayHeight: 32 }).correctConditioningExposure).toBeUndefined();
    });
});
