import type * as THREE from 'three/webgpu';

/** The slice of three's `NodeFrame` an effect's `updateBefore` reads. */
interface EffectFrame {
    renderer: THREE.WebGPURenderer;
}

/** The slice of a PassNode this helper reads. */
interface ScaledPass {
    getResolutionScale(): number;
}

type SizeQuery = (target: THREE.Vector2) => THREE.Vector2;

/** Marks an installed shim with the real drawing-buffer query it wraps. */
const UNPINNED = Symbol('unpinnedGetDrawingBufferSize');

/**
 * Makes a three screen-space effect node (SSGI, SSR, GTAO, recurrentDenoise,
 * temporalReproject, …) run at the resolution of the scene pass it consumes,
 * instead of the canvas resolution.
 *
 * Why this exists: those nodes size their own render targets from
 * `renderer.getDrawingBufferSize()` every frame in `updateBefore`, ignoring
 * the size of their G-buffer inputs (three r185–r186). A scene pass at
 * `setResolutionScale(1 / ratio)` therefore feeds a full-canvas trace, which
 * spends the cost the reduced render resolution was meant to save, and SSGI
 * has no `resolutionScale` knob to undo it. This wrapper reports the drawing
 * buffer to the effect scaled by the pass's own scale, with the pass's own
 * `Math.floor` rounding, so the effect's targets match the G-buffer texel for
 * texel and follow resizes and ratio changes automatically.
 *
 * The bench pins effects the same way (`BenchPipeline._pinEffectResolution`).
 *
 * @param effect - The effect node, as returned by `ssgi()`, `ssr()`, `ao()`, …
 * @param scenePass - The scene `pass()` whose textures the effect consumes
 * @returns The same effect node, for chaining
 */
export function matchPassResolution<T>(effect: T, scenePass: ScaledPass): T {
    const node = effect as unknown as { updateBefore?: (frame: EffectFrame) => unknown };
    const updateBefore = node.updateBefore;
    if (typeof updateBefore !== 'function')
        throw new Error('matchPassResolution: effect node has no updateBefore() to wrap.');

    node.updateBefore = function updateAtPassResolution(frame: EffectFrame): unknown {
        const renderer = frame.renderer;
        const getDrawingBufferSize = renderer.getDrawingBufferSize;
        const hadOwn = Object.prototype.hasOwnProperty.call(renderer, 'getDrawingBufferSize');
        // An effect that consumes another pinned effect (recurrentDenoise →
        // temporalReproject) updates it from inside this call — scale from the
        // real query, never from an outer shim, or the inner one double-scales.
        const realSize =
            (getDrawingBufferSize as SizeQuery & { [UNPINNED]?: SizeQuery })[UNPINNED] ??
            getDrawingBufferSize;
        const scale = scenePass.getResolutionScale();
        // Shadow the method only for the duration of this effect's update; the
        // pass itself has already sized from the real drawing buffer.
        const pinned = (target: THREE.Vector2): THREE.Vector2 => {
            realSize.call(renderer, target);
            return target.set(Math.floor(target.x * scale), Math.floor(target.y * scale));
        };
        renderer.getDrawingBufferSize = Object.assign(pinned, { [UNPINNED]: realSize });
        try {
            return updateBefore.call(this, frame);
        } finally {
            if (hadOwn) renderer.getDrawingBufferSize = getDrawingBufferSize;
            else delete (renderer as { getDrawingBufferSize?: unknown }).getDrawingBufferSize;
        }
    };
    return effect;
}
