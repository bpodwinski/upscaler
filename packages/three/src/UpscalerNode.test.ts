import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Texture, type Vector2 } from 'three';

import { TemporalGuidesNode } from './TemporalGuidesNode';
import { UpscalerNode, upscaleScene, type UpscalerNodeOptions } from './UpscalerNode';

// GPU-free: the nodes are constructed without a builder, their upscaler is a
// stub, and only the configuration they hand it is checked.
type NodeInternals = {
    _upscaler: unknown;
    _output: Vector2;
    _input: Vector2;
    _configureUpscaler(): void;
};

/** The configuration an upscale node passes to its upscaler for the given options. */
export function nodeConfiguration(options: UpscalerNodeOptions): Record<string, unknown> {
    const node = new UpscalerNode(null, null, null, new PerspectiveCamera(), options);
    const configure = vi.fn();
    const internals = node as unknown as NodeInternals;
    internals._upscaler = { configure, outputTexture: new Texture() };
    internals._output.set(1280, 720);
    internals._input.set(640, 360);
    internals._configureUpscaler();
    return configure.mock.calls[0][0] as Record<string, unknown>;
}

describe('UpscalerNode configuration', () => {
    it('sizes the upscaler from its input and output, with jitter on by default', () => {
        expect(nodeConfiguration({})).toMatchObject({
            displayWidth: 1280,
            displayHeight: 720,
            renderWidth: 640,
            renderHeight: 360,
            jitter: true,
        });
    });

    it('forwards depthMode, and leaves it unset by default', () => {
        expect(nodeConfiguration({ depthMode: 'linear' }).depthMode).toBe('linear');
        expect(nodeConfiguration({ depthMode: 'hardware' }).depthMode).toBe('hardware');
        expect(nodeConfiguration({}).depthMode).toBeUndefined();
    });
});

describe('upscaleScene', () => {
    it("rejects depthMode: 'linear': it renders its own hardware depth", () => {
        expect(() => upscaleScene(new Scene(), new PerspectiveCamera(), { depthMode: 'linear' })).toThrow(
            /upscaleScene\(\) renders its own hardware depth/,
        );
    });
});

describe('TemporalGuidesNode configuration', () => {
    const standalone = (options: ConstructorParameters<typeof TemporalGuidesNode>[3]) => {
        const node = new TemporalGuidesNode(null, null, new PerspectiveCamera(), options);
        const configure = vi.fn();
        const internals = node as unknown as { _upscaler: unknown; _configureStandalone(width: number, height: number): void };
        internals._upscaler = { configure };
        internals._configureStandalone(640, 360);
        return configure.mock.calls[0][0] as Record<string, unknown>;
    };

    it('configures a guides-only upscaler at its depth input size', () => {
        expect(standalone({})).toMatchObject({ path: 'guides', renderWidth: 640, renderHeight: 360, displayWidth: 640, displayHeight: 360 });
    });

    it('forwards depthMode, and leaves it unset by default', () => {
        expect(standalone({ depthMode: 'linear' }).depthMode).toBe('linear');
        expect(standalone({}).depthMode).toBeUndefined();
    });
});

describe('UpscalerNode rcasAgeKnee', () => {
    it('forwards the knee, and leaves it unset by default', () => {
        expect(nodeConfiguration({ rcasAgeKnee: 0.5 }).rcasAgeKnee).toBe(0.5);
        expect(nodeConfiguration({ rcasAgeKnee: 0 }).rcasAgeKnee).toBe(0);
        expect(nodeConfiguration({}).rcasAgeKnee).toBeUndefined();
    });

    it('keeps the other options beside it', () => {
        expect(nodeConfiguration({ rcasAgeKnee: 0.25, depthMode: 'linear', jitter: false })).toMatchObject({
            rcasAgeKnee: 0.25,
            depthMode: 'linear',
            jitter: false,
        });
    });
});

describe('UpscalerNode exposureMode', () => {
    it('forwards the mode, and leaves it unset by default', () => {
        expect(nodeConfiguration({ exposureMode: 'provided' }).exposureMode).toBe('provided');
        expect(nodeConfiguration({ exposureMode: 'upstream' }).exposureMode).toBe('upstream');
        expect(nodeConfiguration({}).exposureMode).toBeUndefined();
    });

    it('keeps the other options beside it', () => {
        expect(nodeConfiguration({ exposureMode: 'provided', rcasAgeKnee: 0.5, depthMode: 'linear' })).toMatchObject({
            exposureMode: 'provided',
            rcasAgeKnee: 0.5,
            depthMode: 'linear',
        });
    });
});

describe('UpscalerNode correctConditioningExposure', () => {
    it('forwards the flag, and leaves it unset by default', () => {
        expect(nodeConfiguration({ correctConditioningExposure: true }).correctConditioningExposure).toBe(true);
        expect(nodeConfiguration({ correctConditioningExposure: false }).correctConditioningExposure).toBe(false);
        expect(nodeConfiguration({}).correctConditioningExposure).toBeUndefined();
    });

    it('keeps the other options beside it', () => {
        expect(nodeConfiguration({ correctConditioningExposure: true, exposureMode: 'provided', rcasAgeKnee: 0.5 }))
            .toMatchObject({ correctConditioningExposure: true, exposureMode: 'provided', rcasAgeKnee: 0.5 });
    });
});
