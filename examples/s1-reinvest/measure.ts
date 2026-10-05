import { trimmedMean, type FrameTimes, type GpuMeter } from './GpuMeter';

//* The measurement cycle: times each side IN ISOLATION.
//*
//* Even with per-pass attribution (GpuMeter), measuring both sides in the same
//* frame lets them interfere — shared caches, bandwidth, the GPU's power state.
//* So a cycle runs blocks of frames that render only one side (plus the shared
//* composite), alternating A, B, A, B so slow drift (clocks, thermals) hits
//* both equally. The scene is frozen while it runs, so the side that isn't
//* rendering still shows the same instant. Each block starts with a few
//* untimed settle frames.

/** Which sides a frame renders. */
export type Sides = 'both' | 'a' | 'b';

interface Step {
    sides: Sides;
    /** Meter tag for timed frames; null = untimed (warm-up / settle). */
    tag: 'A' | 'B' | null;
    frames: number;
}

/** Averaged GPU milliseconds per bucket; null = not measured / unavailable. */
export interface Measured {
    aScene: number | null;
    aEffects: number | null;
    aUpscale: number | null;
    aTotal: number | null;
    b: number | null;
    present: number | null;
    framesA: number;
    framesB: number;
}

const WARM_FRAMES = 30;
const SETTLE_FRAMES = 4;

/**
 * Drives a measurement cycle one frame at a time from the render loop.
 */
export class MeasureCycle {
    private readonly _meter: GpuMeter;
    private _steps: Step[] = [];
    private _stepFrame = 0;
    private _collectFrames = 0;
    private _resolve: ((m: Measured) => void) | null = null;
    private _resultA: FrameTimes[] = [];
    private _resultB: FrameTimes[] = [];
    private _want = { a: false, b: false };
    private _label = '';

    constructor(meter: GpuMeter) {
        this._meter = meter;
    }

    /** True while a cycle is rendering its timed blocks (scene must stay frozen). */
    get frozen(): boolean {
        return this._steps.length > 0;
    }

    /** True from start until the result is delivered. */
    get busy(): boolean {
        return this._resolve !== null;
    }

    /** Human-readable progress for the HUD. */
    get status(): string {
        if (!this.busy) return '';
        if (this._steps.length === 0) return `${this._label} · resolving timestamps`;
        const s = this._steps[0];
        const what = s.tag === null ? (s.sides === 'both' ? 'warming up' : 'settling') : `timing side ${s.tag}`;
        return `${this._label} · ${what}`;
    }

    /**
     * Starts a cycle. Any cycle already running is abandoned.
     * @param options.sides - Which sides to time (B never depends on the
     *   render scale, so auto-balance times it once and then only A)
     * @param options.frames - Timed frames per side (split over two blocks)
     * @param options.label - Progress label for the HUD
     * @returns The averaged result once every timed frame has resolved
     */
    run(options: { sides: Sides; frames?: number; label?: string }): Promise<Measured> {
        const per = Math.max(2, Math.round((options.frames ?? 60) / 2));
        const a = options.sides !== 'b';
        const b = options.sides !== 'a';
        this._want = { a, b };
        this._label = options.label ?? 'measuring';
        this._steps = [{ sides: 'both', tag: null, frames: WARM_FRAMES }];
        for (let i = 0; i < 2; i++) {
            if (a) this._steps.push({ sides: 'a', tag: null, frames: SETTLE_FRAMES }, { sides: 'a', tag: 'A', frames: per });
            if (b) this._steps.push({ sides: 'b', tag: null, frames: SETTLE_FRAMES }, { sides: 'b', tag: 'B', frames: per });
        }
        this._stepFrame = 0;
        this._collectFrames = 0;
        this._resultA = [];
        this._resultB = [];
        this._meter.clear();
        return new Promise((resolve) => {
            this._resolve = resolve;
        });
    }

    /**
     * Called at the top of every frame.
     * @returns What this frame should render and the meter tag to record under
     */
    frame(): { sides: Sides; tag: 'A' | 'B' | null } {
        if (this._steps.length === 0) return { sides: 'both', tag: null };
        const s = this._steps[0];
        return { sides: s.sides, tag: s.tag };
    }

    /** Called at the end of every frame — advances the cycle. */
    advance(): void {
        if (!this._resolve) return;
        if (this._steps.length > 0) {
            if (++this._stepFrame >= this._steps[0].frames) {
                this._steps.shift();
                this._stepFrame = 0;
            }
            return;
        }
        //* Collecting — timestamps resolve a few frames late; wait for them,
        //* but never forever (a lost query just drops that frame).
        this._resultA.push(...this._meter.take('A'));
        this._resultB.push(...this._meter.take('B'));
        const open = this._meter.openFrames('A') + this._meter.openFrames('B');
        if (open > 0 && ++this._collectFrames < 120) return;

        const A = this._resultA;
        const B = this._resultB;
        const aScene = this._want.a ? trimmedMean(A, 'aScene') : null;
        const aEffects = this._want.a ? trimmedMean(A, 'aEffects') : null;
        const aUpscale = this._want.a ? trimmedMean(A, 'aUpscale') : null;
        const parts = [aScene, aEffects, aUpscale];
        const result: Measured = {
            aScene,
            aEffects,
            aUpscale,
            aTotal: parts.every((p) => p !== null) ? parts.reduce((s, p) => s! + p!, 0) : null,
            b: this._want.b ? trimmedMean(B, 'b') : null,
            present: trimmedMean([...A, ...B], 'present'),
            framesA: A.length,
            framesB: B.length,
        };
        const resolve = this._resolve;
        this._resolve = null;
        resolve(result);
    }
}
