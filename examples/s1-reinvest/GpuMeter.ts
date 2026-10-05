import * as THREE from 'three/webgpu';

//* Per-side GPU timing for a frame that renders two pipelines.
//*
//* A CPU frame timer can't split "side A" from "side B" when both render in one
//* frame, so this meter reads WebGPU timestamps — one begin/end pair per render
//* pass, which three (r186) writes for every pass when the renderer is built
//* with `trackTimestamp: true`. Two things it adds on top of three:
//*
//* 1. Attribution. three doesn't know which *side* a pass belongs to, but it
//*    announces every render call (with the pass's timestamp uid) to the
//*    renderer's inspector before encoding it. This class IS the inspector and
//*    tags each uid with the bucket the caller declared for that stretch of the
//*    frame. Nested renders (pass graphs, effect quads, shadow maps) are
//*    announced too, so they inherit the bucket of the code that triggered them.
//*
//* 2. A timeline instead of per-pass durations. three resolves each pass to
//*    `end - begin`, and on a tile-based GPU (Apple, measured here) that is NOT
//*    the pass's cost: a full-screen pass's "begin" is stamped as soon as its
//*    vertex stage can start — usually while the previous pass is still
//*    shading — so every pass in a dependent chain reports roughly the whole
//*    chain (four SSR blur passes each "took" 6 ms of a 7 ms effect stack).
//*    Summing those over-counts several times. The begin/end stamps themselves
//*    share one GPU clock, though, so the meter keeps the raw stamps and walks
//*    the frame as a timeline: a stage costs the time from the previous stage's
//*    last *end* to its own last end. three's public API only exposes the
//*    durations, so the raw stamps are read from its query pool (r186
//*    internals — `queryOffsets` + the mapped result buffer); if that shape
//*    changes the meter reports itself unsupported rather than guessing.
//*
//* The upscaler's compute passes are raw WebGPU (three never sees them). They
//* run between side A's last render pass and the composite, which samples
//* their output and so can't start before they finish — that gap on the
//* timeline is the upscale. (The library's own `upscaler.gpuTimings` are
//* per-pass durations with the same tile-GPU overlap, so they read high here.)

/** Who a render pass is attributed to, as declared by the caller. */
export type Owner = 'a' | 'b' | 'present';

/** Per-frame GPU milliseconds of each stage (absent = stage didn't run). */
export interface FrameTimes {
    aScene?: number;
    aEffects?: number;
    aUpscale?: number;
    b?: number;
    present?: number;
}

export type Stage = keyof FrameTimes;

interface PassStamp {
    stage: 'aScene' | 'aEffects' | 'b' | 'present';
    begin: bigint;
    end: bigint;
}

interface FrameRecord {
    tag: string;
    /** Render passes announced this frame (uid → stage). */
    uids: Map<string, PassStamp['stage']>;
    stamps: PassStamp[];
    /** Stage times, once every pass has resolved. */
    times?: FrameTimes;
}

/** The r186 query-pool internals the meter reads (absent from @types/three). */
interface RawPool {
    queryOffsets: Map<string, number>;
    resultBuffer: GPUBuffer & { __s1Raw?: { latest: BigUint64Array | null } };
    pendingResolve: unknown;
}

interface TimestampBackend {
    trackTimestamp: boolean;
    timestampQueryPool: Record<string, RawPool | null>;
}

/**
 * Inspector that records three's per-render-pass GPU timestamps, attributes
 * them to caller-declared owners, and turns each frame into stage times.
 */
export class GpuMeter extends THREE.InspectorBase {
    /** Owner of the render passes issued from now on; null = not recorded. */
    owner: Owner | null = null;

    private readonly _sceneRef: THREE.Scene;
    private readonly _frames = new Map<number, FrameRecord>();
    private _frame = 0;
    private _resolving = false;
    private _broken = false;
    /** GPU tick at which the last timed frame's final pass ended. */
    private _lastEnd: bigint | null = null;
    private _capableCache: boolean | null = null;

    /**
     * @param sceneRef - The 3D scene. Side A passes that render it (the G-buffer
     *   and its shadow map) are "scene"; its other passes — effect quads, the
     *   composite into the upscaler's input — are "effects".
     */
    constructor(sceneRef: THREE.Scene) {
        super();
        this._sceneRef = sceneRef;
    }

    /** Null when timing works, else why it doesn't (shown in the HUD). */
    get unsupportedReason(): string | null {
        if (!this._capable()) return "this browser/GPU doesn't expose WebGPU's timestamp-query feature";
        if (this._broken) return "three's timestamp pool changed shape (this demo reads r186 internals)";
        return null;
    }

    /**
     * Starts a frame. Frames tagged `null` aren't recorded.
     * @param tag - Measurement phase the frame belongs to, or null
     */
    beginFrame(tag: string | null): void {
        this._frame++;
        if (tag !== null) this._frames.set(this._frame, { tag, uids: new Map(), stamps: [] });
        // Timestamps cost query writes + a readback per frame, so they're only
        // on while a measurement needs them (three checks this flag per pass).
        // Left on, three's 2048-query pool would also fill up between
        // measurements and resolve itself behind the meter's back.
        const backend = this.getRenderer().backend as unknown as TimestampBackend;
        backend.trackTimestamp = this._capable() && (tag !== null || this._frames.size > 0 || this._resolving);
    }

    /** Whether the renderer came up with timestamps (read once, before the meter toggles it). */
    private _capable(): boolean {
        if (this._capableCache === null) {
            const backend = this.getRenderer()?.backend as unknown as TimestampBackend | undefined;
            if (!backend) return false;
            this._capableCache = backend.trackTimestamp === true;
        }
        return this._capableCache;
    }

    /**
     * Ends the frame: kicks a timestamp resolve unless one is still in flight
     * (this frame's passes then ride along with the next one).
     */
    endFrame(): void {
        this.owner = null;
        if (!this._resolving && this._frames.size > 0) void this._resolve();
    }

    /**
     * Removes and returns the stage times of every resolved frame with a tag.
     * @param tag - Phase label passed to {@link beginFrame}
     */
    take(tag: string): FrameTimes[] {
        const out: FrameTimes[] = [];
        for (const [id, rec] of this._frames) {
            if (rec.tag !== tag || !rec.times) continue;
            out.push(rec.times);
            this._frames.delete(id);
        }
        return out;
    }

    /**
     * Number of frames with a tag still waiting on their timestamps.
     * @param tag - Phase label passed to {@link beginFrame}
     */
    openFrames(tag: string): number {
        let n = 0;
        for (const rec of this._frames.values()) if (rec.tag === tag) n++;
        return n;
    }

    /** Drops every recorded frame (e.g. when a measurement restarts). */
    clear(): void {
        this._frames.clear();
    }

    //* Inspector Hook

    override beginRender(uid: string, scene: THREE.Scene): void {
        const rec = this._frames.get(this._frame);
        if (!rec || this.owner === null) return;
        const stage = this.owner === 'a' ? (scene === this._sceneRef ? 'aScene' : 'aEffects') : this.owner;
        rec.uids.set(uid, stage);
    }

    //* Resolve

    private async _resolve(): Promise<void> {
        const renderer = this.getRenderer();
        const backend = renderer.backend as unknown as TimestampBackend;
        const pool = backend.timestampQueryPool?.render;
        if (!backend.trackTimestamp || !pool) return;
        if (!(pool.queryOffsets instanceof Map) || !pool.resultBuffer) {
            this._broken = true;
            return;
        }
        if (pool.pendingResolve) return; // three resolving on its own — next frame

        //* Raw stamps: three maps the result buffer, reads it into durations
        //* and unmaps it within one task. Copy the mapped range on the way past.
        const buffer = pool.resultBuffer;
        if (!buffer.__s1Raw) {
            const tap = { latest: null as BigUint64Array | null };
            const getMappedRange = buffer.getMappedRange.bind(buffer);
            buffer.getMappedRange = (offset?: number, size?: number) => {
                const range = getMappedRange(offset, size);
                tap.latest = new BigUint64Array(range.slice(0));
                return range;
            };
            buffer.__s1Raw = tap;
        }
        // three snapshots these offsets synchronously when the resolve starts.
        const offsets = new Map(pool.queryOffsets);
        const tap = buffer.__s1Raw;
        tap.latest = null;

        this._resolving = true;
        try {
            await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
            const raw = tap.latest as BigUint64Array | null;
            const newest = this._frame;
            for (const [id, rec] of this._frames) {
                if (raw) {
                    for (const [uid, stage] of rec.uids) {
                        const off = offsets.get(uid);
                        if (off === undefined || off + 1 >= raw.length) continue;
                        rec.stamps.push({ stage, begin: raw[off], end: raw[off + 1] });
                    }
                }
                // A frame whose passes span two resolves, or lost a query, is
                // dropped rather than half-counted.
                const resolved = rec.stamps.length;
                if ((resolved > 0 && resolved < rec.uids.size) || (resolved === 0 && id < newest - 30)) {
                    this._frames.delete(id);
                } else if (resolved > 0 && !rec.times) {
                    // Frames resolve in submission order, so the previous
                    // timed frame's end is known: a frame submitted while the
                    // GPU was still finishing that one starts when it's free,
                    // not when its first pass was stamped as "begun".
                    rec.times = frameTimes(rec.stamps, this._lastEnd);
                    this._lastEnd = rec.stamps.reduce((m, p) => (p.end > m ? p.end : m), rec.stamps[0].end);
                }
            }
        } finally {
            this._resolving = false;
        }
    }
}

/**
 * Turns one frame's raw pass stamps into stage times by walking the timeline
 * in end order: each stage costs the time from the previous stage's last end
 * (or its own first begin, if the GPU sat idle in between) to its own last end.
 * Side A's upscale is the gap between its last render pass and the composite.
 * @param stamps - Raw begin/end GPU ticks (ns) of every recorded pass
 * @param floor - When the GPU finished the previous timed frame, if known
 * @returns GPU milliseconds per stage
 */
function frameTimes(stamps: PassStamp[], floor: bigint | null): FrameTimes {
    const ms = (ns: bigint) => Number(ns) / 1e6;
    const by = (stage: PassStamp['stage']) => stamps.filter((s) => s.stage === stage);
    const lastEnd = (ps: PassStamp[]) => ps.reduce((m, p) => (p.end > m ? p.end : m), ps[0].end);
    const firstBegin = (ps: PassStamp[]) => ps.reduce((m, p) => (p.begin < m ? p.begin : m), ps[0].begin);
    const out: FrameTimes = {};
    let cursor = firstBegin(stamps);
    if (floor !== null && floor > cursor) cursor = floor;
    const span = (ps: PassStamp[]): number => {
        const end = lastEnd(ps);
        const start = firstBegin(ps) > cursor ? firstBegin(ps) : cursor;
        cursor = end;
        return end > start ? ms(end - start) : 0;
    };

    const aScene = by('aScene');
    const aEffects = by('aEffects');
    const b = by('b');
    const present = by('present').sort((x, y) => (x.end < y.end ? -1 : 1));
    if (aScene.length) out.aScene = span(aScene);
    if (aEffects.length) out.aEffects = span(aEffects);
    if (aScene.length && present.length) {
        // The composite samples the upscaler's output, so it can't begin
        // before the compute passes end: the gap is the upscale.
        const p0 = present[0].begin;
        out.aUpscale = p0 > cursor ? ms(p0 - cursor) : 0;
        if (p0 > cursor) cursor = p0;
    }
    if (b.length) out.b = span(b);
    if (present.length) {
        // Each present pass alone (the swap-chain wait between them is idle).
        let total = 0;
        for (const p of present) total += span([p]);
        out.present = total;
    }
    return out;
}

/**
 * Robust average over frames: a 10%-trimmed mean, so a stray hitch (pipeline
 * compile, GC, compositor) doesn't skew the result.
 * @param frames - Per-frame stage times
 * @param stage - Stage to average
 * @returns Average GPU milliseconds, or null when no frame has the stage
 */
export function trimmedMean(frames: FrameTimes[], stage: Stage): number | null {
    const v = frames.map((f) => f[stage]).filter((x): x is number => x !== undefined);
    if (v.length === 0) return null;
    v.sort((a, b) => a - b);
    const cut = Math.floor(v.length * 0.1);
    const kept = v.slice(cut, v.length - cut);
    return kept.reduce((s, x) => s + x, 0) / kept.length;
}
