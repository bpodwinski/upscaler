/**
 * Public option/enum types for the FSR3 upscaler.
 *
 * Terminology follows the FidelityFX SDK where possible:
 * - "render resolution" — the (lower) resolution the scene is rasterized at
 * - "display resolution" — the (higher) resolution presented to the user
 * - "upscale ratio" — displaySize / renderSize per axis (uniform in practice)
 */

/**
 * Quality presets matching the official FSR3 scaling ratios.
 *
 * `NativeAA` renders at display resolution and uses the temporal pipeline
 * purely as an anti-aliasing solution (equivalent to AMD's "Native AA" mode).
 */
export enum QualityMode {
    NativeAA = 'native-aa',
    Quality = 'quality',
    Balanced = 'balanced',
    Performance = 'performance',
    UltraPerformance = 'ultra-performance',
}

/**
 * Which upscaling path the pipeline runs.
 *
 * - `bilinear` — plain bilinear sample + display transform. The naive
 *   baseline every other mode is compared against (and, at ratio 1, the
 *   "native" passthrough mode).
 * - `spatial` — single-frame FSR1 (EASU + RCAS). No history, no motion
 *   vectors required.
 * - `temporal` — FSR2/3-style jittered temporal accumulation. Requires depth
 *   and motion vectors.
 * - `guides` — the temporal path's geometry front-end only (dilated
 *   depth/motion + disocclusion via {@link Upscaler.dispatchGuides}), for
 *   apps that consume the {@link TemporalGuides} bundle without upscaling.
 *   No color input, no history, no output texture.
 */
export type UpscalePath = 'bilinear' | 'spatial' | 'temporal' | 'guides';

/**
 * A sub-pixel jitter offset in render pixels, each axis in `[-0.5, 0.5]`.
 * x points right and y points down (texel coordinates, top-left origin): the
 * sample for render texel `(i, j)` sits at `(i + 0.5 + x, j + 0.5 + y)` in the
 * unjittered image's pixel coordinates. See {@link Upscaler.jitter}.
 */
export interface JitterOffset {
    readonly x: number;
    readonly y: number;
}

/**
 * Debug visualization modes rendered by the debug pass instead of the final
 * image. Useful for validating pipeline inputs while integrating.
 */
export enum DebugView {
    /** Normal output — no debug visualization. */
    None = 0,
    /** Dilated motion vectors, magnitude/direction encoded as color. */
    MotionVectors = 1,
    /** Depth-clip disocclusion mask (white = history rejected). */
    Disocclusion = 2,
    /** Linearized dilated depth. */
    Depth = 3,
    /** History accumulation age (white = fully converged history). */
    AccumulationAge = 4,
    /** Luminance-stability locks (white = a locked thin feature). */
    Locks = 5,
    /** Auto-exposed scene luminance (should sit near mid-grey everywhere). */
    Exposure = 6,
    /** Shading-change factor (white = history aged because shading changed). */
    ShadingChange = 7,
    /** Reactive mask (white = pixel flagged reactive, favouring the current frame). */
    Reactivity = 8,
}

/**
 * Runtime tuning knobs that can change every frame without a pipeline rebuild.
 */
export interface RuntimeSettings {
    /**
     * RCAS sharpening amount in `[0, 1]`. `1` is maximum sharpness (0 stops
     * of attenuation in FidelityFX terms), `0` disables sharpening.
     */
    sharpness: number;
    /**
     * Enable RCAS's denoise variant (FSR1 `FSR_RCAS_DENOISE`): attenuate
     * sharpening on lone luma outliers so grain from noisy inputs (reduced-res
     * SSR/GI, raw path tracing) isn't amplified. Off by default — turn it on
     * only for noisy sources; it slightly softens fine detail. Pairs with a
     * spatial denoiser upstream.
     */
    rcasDenoise: boolean;
    /**
     * Maximum number of accumulated frames in the temporal history. Higher
     * values are more stable but ghost longer. FSR3 uses ~32 internally.
     */
    maxAccumulation: number;
    /**
     * Pre-exposure applied before the invertible tonemap. Used directly when
     * {@link autoExposure} is off; ignored when it is on (the value is computed
     * from scene luminance each frame). Divided back out before display either
     * way, so it conditions accumulation without changing final brightness.
     */
    exposure: number;
    /**
     * Compute the pre-exposure from the scene's average luminance each frame
     * (with eye-adaptation), instead of using the fixed {@link exposure}. Keeps
     * the invertible-tonemap accumulation well-conditioned across HDR scenes of
     * very different brightness. On by default.
     */
    autoExposure: boolean;
    /**
     * Protect stable thin sub-pixel features (wires, fence pickets, foliage)
     * from history rectification via luminance-stability locks. Reduces the
     * dimming/shimmer such features otherwise show under motion. On by default.
     */
    lockThinFeatures: boolean;
    /**
     * Detect genuine shading changes (a light turning on, an animated material)
     * versus mere motion, and age the history there so the changed surface
     * re-converges quickly instead of ghosting its old shading. Measured on
     * averaged luminance so sub-pixel aliasing doesn't trip it. On by default.
     */
    detectShadingChanges: boolean;
    /** Debug visualization mode. */
    debugView: DebugView;
}

/** Configuration applied only between frames. */
export interface CoreConfiguration {
    renderWidth: number;
    renderHeight: number;
    displayWidth: number;
    displayHeight: number;
    path?: UpscalePath;
    depthMode?: 'hardware' | 'linear';
    exposureMode?: 'upstream' | 'provided';
    correctConditioningExposure?: boolean;
    rcasAgeKnee?: number;
}

export interface TextureResource {
    texture: GPUTexture;
    /** A single-mip storage view, or a depth-only view for combined depth/stencil. */
    view: GPUTextureView;
}
export interface TextureHistory { read: TextureResource; write: TextureResource }
export type ResourceName = 'output' | 'exposure' | 'dummy' | 'easuOutput' | 'dilatedDepth' |
    'dilatedMotion' | 'masks' | 'history' | 'locks' | 'reactiveGenerated' | 'shadingLumaHistory' |
    'shadingSignal' | 'shadingBlockMemory';
export type CoreResources = Partial<Record<ResourceName, TextureResource | TextureHistory>> & {
    color?: TextureResource;
    depth?: TextureResource;
    velocity?: TextureResource;
    reactive?: TextureResource;
    reactiveOpaqueColor?: TextureResource;
    exposureTexture?: TextureResource;
    preExposureTexture?: TextureResource;
    /** Previous dilated depth published to guides consumers (not used by production reconstruction). */
    previousDepth?: TextureResource;
};
export interface FrameData {
    frameIndex: number;
    jitter?: JitterOffset;
    jitterPrevious?: JitterOffset;
    motionScale?: JitterOffset;
    near?: number;
    far?: number;
    perspective?: boolean;
    reversedDepth?: boolean;
    deltaTime?: number;
    reset?: boolean;
    /** Host exposure baked into input color; default 1, preserved at output. */
    hostPreExposure?: number;
    settings?: Partial<RuntimeSettings>;
    /** Bench-only current-view to previous-view reprojection constants. */
    reprojection?: Float32Array;
}
export interface ResourceDescriptor {
    name: ResourceName;
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: GPUTextureUsageFlags;
    history: boolean;
    sampling: 'linear' | 'load';
    initialization: 'zero';
}

export const DEFAULT_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
    sharpness: 0.8, rcasDenoise: false, maxAccumulation: 24, exposure: 1,
    autoExposure: true, lockThinFeatures: true, detectShadingChanges: true, debugView: DebugView.None,
});
