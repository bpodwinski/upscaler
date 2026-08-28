import { describe, expect, it } from 'vitest';

import { Upscaler } from './Upscaler';
import type { WebGPURenderer } from 'three/webgpu';

// The constructor only reads `renderer.alpha`; nothing touches the GPU until
// init(), so the default-resolution rule is testable without a device (and CI
// has none — see CLAUDE.md).
function fakeRenderer(alpha: boolean | undefined): WebGPURenderer {
    return { alpha } as unknown as WebGPURenderer;
}

describe('alpha defaults to the renderer', () => {
    it('follows a transparent canvas', () => {
        // The case that motivated RGBA passthrough (issue #15): a transparent
        // canvas is exactly where coverage has to survive the upscale, so it
        // works with no configuration at all.
        expect(new Upscaler({ renderer: fakeRenderer(true) }).alpha).toBe(true);
    });

    it('follows an opaque canvas', () => {
        // The common case pays nothing for a channel it cannot display.
        expect(new Upscaler({ renderer: fakeRenderer(false) }).alpha).toBe(false);
    });

    it('treats a renderer without the field as opaque', () => {
        expect(new Upscaler({ renderer: fakeRenderer(undefined) }).alpha).toBe(false);
    });

    it('lets an explicit option win in both directions', () => {
        // Opaque canvas, but the output is composited somewhere that needs
        // coverage — the renderer's flag cannot see that.
        expect(new Upscaler({ renderer: fakeRenderer(false), alpha: true }).alpha).toBe(true);
        // Transparent canvas whose transparency is for something else.
        expect(new Upscaler({ renderer: fakeRenderer(true), alpha: false }).alpha).toBe(false);
    });

    it('does not treat an explicit false as "unset"', () => {
        // Guards the `??` vs `||` / `!== false` mistakes: each would silently
        // re-enable alpha on a transparent canvas that explicitly opted out.
        const upscaler = new Upscaler({ renderer: fakeRenderer(true), alpha: false });
        expect(upscaler.alpha).toBe(false);
    });
});
