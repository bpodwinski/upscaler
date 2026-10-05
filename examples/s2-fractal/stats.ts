import type * as THREE from 'three/webgpu';

import { DebugView, type RuntimeSettings, type UpscalePath } from '@pmndrs/upscaler';

//* Measured GPU time for the three stages of a frame:
//*   raymarch — three's own render-pass timestamps (`trackTimestamp`)
//*   upscale  — the upscaler's compute-pass timestamps (`upscaler.gpuTimings`)
//*   present  — three's timestamp for the present quad
//* Nothing here is estimated: with no `timestamp-query` every value is null
//* and the HUD prints "n/a".

/** The slice of three's (internal) timestamp pool this reads. */
interface RenderTimestampPool {
    timestamps: Map<string, number>;
}

/** Rolling window, in frames (~1 s at 60 fps). */
const WINDOW = 60;

/** Per-stage GPU milliseconds averaged over the rolling window (null = not measured). */
export interface StageTimings {
    raymarch: number | null;
    upscale: number | null;
    present: number | null;
    total: number | null;
}

class Rolling {
    private _values: number[] = [];
    push(v: number): void {
        this._values.push(v);
        if (this._values.length > WINDOW) this._values.shift();
    }
    clear(): void {
        this._values = [];
    }
    get mean(): number | null {
        if (this._values.length === 0) return null;
        return this._values.reduce((a, b) => a + b, 0) / this._values.length;
    }
}

/**
 * The upscaler passes a frame actually encodes for a path + settings.
 * `gpuTimings` merges results by label and never drops a label (so the split
 * guides/upscale frame keeps both halves), which means a label from a
 * previous path or setting — `accumulate` after switching to bilinear, or the
 * debug `output` pass after turning the view off — lingers with its last
 * value. Summing only the passes this frame runs keeps the total honest.
 * @param path - Active upscale path
 * @param settings - The upscaler's runtime settings
 * @returns The pass labels encoded per frame
 */
export function encodedPasses(path: UpscalePath, settings: RuntimeSettings): string[] {
    const finish = settings.sharpness > 0 ? 'rcas' : 'blit';
    if (path === 'bilinear') return ['blit'];
    if (path === 'spatial') return ['easu', finish];
    const passes = ['reconstruct', 'exposure', 'accumulate'];
    if (settings.detectShadingChanges) passes.push('shadingChange');
    passes.push(settings.debugView !== DebugView.None ? 'output' : finish);
    return passes;
}

/** Collects and averages measured GPU stage times. */
export class GpuStats {
    /** Whether three's render timestamps are live (`timestamp-query` present). */
    readonly supported: boolean;

    private readonly _renderer: THREE.WebGPURenderer;
    private readonly _raymarch = new Rolling();
    private readonly _present = new Rolling();
    private readonly _upscale = new Rolling();
    private _resolving = false;
    private _lastFrame = -1;

    /**
     * @param renderer - A renderer created with `trackTimestamp: true`
     */
    constructor(renderer: THREE.WebGPURenderer) {
        this._renderer = renderer;
        // The backend downgrades trackTimestamp to false when the device lacks
        // the timestamp-query feature.
        this.supported = (renderer.backend as { trackTimestamp?: boolean }).trackTimestamp === true;
    }

    /** Drops the window — call when the workload changes (ratio, path, quality). */
    reset(): void {
        this._raymarch.clear();
        this._present.clear();
        this._upscale.clear();
    }

    /**
     * Records this frame's upscaler timings and kicks off an async resolve of
     * three's render timestamps (non-blocking; results land a few frames late).
     * @param upscalerTimings - `upscaler.gpuTimings`
     * @param path - Active upscale path
     * @param settings - The upscaler's runtime settings
     */
    sample(upscalerTimings: ReadonlyMap<string, number>, path: UpscalePath, settings: RuntimeSettings): void {
        if (!this.supported) return;

        let upscale = 0;
        let complete = true;
        for (const label of encodedPasses(path, settings)) {
            const ms = upscalerTimings.get(label);
            if (ms === undefined) complete = false;
            else upscale += ms;
        }
        if (complete) this._upscale.push(upscale);

        if (this._resolving) return;
        this._resolving = true;
        this._renderer
            .resolveTimestampsAsync('render')
            .then(() => this._collect())
            .finally(() => {
                this._resolving = false;
            });
    }

    private _collect(): void {
        const backend = this._renderer.backend as unknown as {
            timestampQueryPool: { render?: RenderTimestampPool };
        };
        const pool = backend.timestampQueryPool.render;
        if (!pool) return;

        // uid = 'r:<call index within the frame>:<context id>:f<frame>'. The
        // raymarch is the frame's first render call; everything after it is
        // presentation — the present quad, plus three's output pass (tone
        // mapping + sRGB to the canvas). The upscaler's compute passes run on
        // the upscaler's own timestamp queries.
        const frames = new Map<number, { call: number; ms: number }[]>();
        for (const [uid, ms] of pool.timestamps) {
            const match = /^r:(\d+):.*:f(\d+)$/.exec(uid);
            if (!match) continue;
            const frame = Number(match[2]);
            if (frame <= this._lastFrame) continue;
            const list = frames.get(frame) ?? [];
            list.push({ call: Number(match[1]), ms });
            frames.set(frame, list);
        }
        for (const [frame, calls] of [...frames].sort((a, b) => a[0] - b[0])) {
            if (calls.length < 2) continue;
            calls.sort((a, b) => a.call - b.call);
            this._raymarch.push(calls[0].ms);
            this._present.push(calls.slice(1).reduce((sum, c) => sum + c.ms, 0));
            this._lastFrame = Math.max(this._lastFrame, frame);
        }
    }

    /**
     * @returns Window-averaged stage times; null where nothing was measured
     */
    averages(): StageTimings {
        const raymarch = this._raymarch.mean;
        const upscale = this._upscale.mean;
        const present = this._present.mean;
        const total =
            raymarch !== null && upscale !== null && present !== null ? raymarch + upscale + present : null;
        return { raymarch, upscale, present, total };
    }
}
