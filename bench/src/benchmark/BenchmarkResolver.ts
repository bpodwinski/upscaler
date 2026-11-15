import * as THREE from 'three/webgpu';

import { Upscaler } from '@pmndrs/upscaler';
import {
    DEPTH_CLIP_VARIANTS,
    RECONSTRUCT_CAMERA_SHADER,
    RECONSTRUCT_CROSS_FRAME_SHADER,
    buildDepthClipVariant,
} from '@pmndrs/upscaler-core/shaders/reconstructVariants';

type CrossFrameReconstruct = { shader: string; cameraCompensated: boolean };
import { CandidateUpscaler } from '../candidates/CandidateUpscaler';
import { LinearDepthConverter } from './LinearDepthConverter';
import { scalarTexture } from '../scalarTexture';
import {
    buildShadingRecurrenceShader,
    SHADING_CHANGE_FRAME_PAIR_SHADER,
} from '../candidates/shaders/shadingChangeRange';
import {
    RCAS_HOISTED_EXPOSURE_SHADER,
    RCAS_LEGACY_SHADER,
    RCAS_PER_TAP_SHADER,
    RCAS_SHADER,
    RCAS_TONEMAP_SPACE_SHADER,
} from '@pmndrs/upscaler-core/shaders/rcas';

interface BenchmarkTimerBridge {
    readonly enabled: boolean;
    setNextFrameTag(frameTag: number): void;
    setAuthoritative(authoritative: boolean): void;
    waitForAvailableSlot(): Promise<void>;
    drain(): Promise<void>;
    reset(): void;
    takeSamples(): Array<{
        frameTag: number;
        sequence: number;
        passes: Array<{ label: string; milliseconds: number }>;
    }>;
}

/** Configuration an identity adds to every `configure()`. */
type BenchmarkExtraConfig = {
    rcasAgeKnee?: number;
    exposureMode?: 'upstream' | 'provided';
    correctConditioningExposure?: boolean;
};

/**
 * Adapts the unchanged production upscaler to the benchmark lifecycle.
 */
class BenchmarkResolverAdapter implements BenchmarkResolver {
    readonly metadata: BenchmarkVariantMetadata;

    private readonly _upscaler: Upscaler | CandidateUpscaler;
    // Set by the linear-depth identity: the same scene, handed over as view depth.
    protected _linearDepth: LinearDepthConverter | null = null;
    // Configuration an identity adds to every configure() (e.g. rcasAgeKnee, exposureMode).
    protected _extraConfig: BenchmarkExtraConfig = {};
    // Set by host-pre-exposure-cpu-v1: pass the host pre-exposure as a number.
    protected _hostPreExposureAsNumber = false;
    // Set by the exposure-texture identities: an app-supplied conditioning exposure.
    protected _exposureTexture: THREE.Texture | null = null;
    // Set by the exposure-step identities: the exposure for a scenario frame.
    protected _exposureSchedule: ((frame: number) => number) | null = null;
    protected _scheduleRenderer: THREE.WebGPURenderer | null = null;
    private readonly _scheduledExposures = new Map<number, THREE.DataTexture>();

    constructor(
        upscaler: Upscaler | CandidateUpscaler,
        metadata: BenchmarkVariantMetadata,
    ) {
        this.metadata = metadata;
        this._upscaler = upscaler;

        if (typeof metadata.settings.rcasDenoise === 'boolean')
            this._upscaler.settings.rcasDenoise = metadata.settings.rcasDenoise;
    }

    prepare(): Promise<void> { return this._upscaler.prepare(); }

    get isReady(): boolean { return this._upscaler.isReady; }

    get outputTexture(): THREE.Texture {
        return this._upscaler.outputTexture;
    }

    get renderWidth(): number {
        return this._upscaler.renderWidth;
    }

    get renderHeight(): number {
        return this._upscaler.renderHeight;
    }

    get displayWidth(): number {
        return this._upscaler.displayWidth;
    }

    get displayHeight(): number {
        return this._upscaler.displayHeight;
    }

    get upscaleRatio(): number {
        return this._upscaler.upscaleRatio;
    }

    get jitterPhaseCount(): number {
        return this._upscaler.jitterPhaseCount;
    }

    get timestampQuerySupported(): boolean {
        return this._timer.enabled;
    }

    get unjitteredProjectionMatrix(): THREE.Matrix4 {
        return this._upscaler.unjitteredProjectionMatrix;
    }

    get settings(): Record<string, unknown> {
        return this._upscaler.settings as unknown as Record<string, unknown>;
    }

    get timings(): ReadonlyMap<string, number> {
        return this._upscaler.gpuTimings;
    }

    private get _timer(): BenchmarkTimerBridge {
        // The benchmark bridge deliberately stays private to the bench. Normal
        // library users retain the existing no-op/latest-map timing behavior.
        return (this._upscaler as unknown as { _timer: BenchmarkTimerBridge })._timer;
    }

    configure(config: BenchmarkResolverConfigure): void {
        this._upscaler.configure({
            displayWidth: config.displayWidth,
            displayHeight: config.displayHeight,
            customUpscaleRatio: config.ratio,
            path: config.path,
            depthMode: this._linearDepth ? 'linear' : 'hardware',
            ...this._extraConfig,
        });
        this._linearDepth?.configure(this._upscaler.renderWidth, this._upscaler.renderHeight);
    }

    beginFrame(camera: unknown): void {
        this._upscaler.beginFrame(camera as THREE.PerspectiveCamera);
    }

    endFrame(camera: unknown): void {
        this._upscaler.endFrame(camera as THREE.PerspectiveCamera);
    }

    dispatch(inputs: BenchmarkResolverDispatch, camera: unknown): void {
        this._timer.setNextFrameTag(inputs.frameTag);
        const sceneDepth = inputs.depth as THREE.Texture | undefined;
        const dispatchInputs = {
            color: inputs.color as THREE.Texture,
            depth:
                sceneDepth && this._linearDepth
                    ? this._linearDepth.convert(sceneDepth, camera as THREE.PerspectiveCamera)
                    : sceneDepth,
            velocity: inputs.velocity as THREE.Texture | undefined,
            reactive: inputs.reactive as THREE.Texture | undefined,
            reactiveOpaqueColor: inputs.reactiveOpaqueColor as THREE.Texture | undefined,
            preExposureTexture: inputs.preExposureTexture as THREE.Texture | undefined,
            exposureTexture: this._exposureTextureFor(inputs.frameTag) ?? undefined,
            deltaTime: inputs.deltaTime,
        } as {
            color: THREE.Texture;
            depth?: THREE.Texture;
            velocity?: THREE.Texture;
            reactive?: THREE.Texture;
            reactiveOpaqueColor?: THREE.Texture;
            preExposureTexture?: THREE.Texture;
            exposureTexture?: THREE.Texture;
            hostPreExposure?: number;
            deltaTime: number;
        };
        if (this._hostPreExposureAsNumber && dispatchInputs.preExposureTexture) {
            // The bench's 1×1 DataTexture keeps its value on the CPU.
            const data = (dispatchInputs.preExposureTexture as THREE.DataTexture).image.data as Float32Array;
            dispatchInputs.hostPreExposure = data[0];
            dispatchInputs.preExposureTexture = undefined;
        }
        const dispatchCamera = camera as THREE.PerspectiveCamera;

        if (this._upscaler instanceof CandidateUpscaler) {
            this._upscaler.dispatch(
                {
                    ...dispatchInputs,
                    transparencyAndComposition: inputs.transparencyAndComposition as
                        | THREE.Texture
                        | undefined,
                },
                dispatchCamera,
            );
            return;
        }

        this._upscaler.dispatch(dispatchInputs, dispatchCamera);
    }

    private _exposureTextureFor(frame: number): THREE.Texture | null {
        if (!this._exposureSchedule || !this._scheduleRenderer) return this._exposureTexture;
        return scalarTexture(this._scheduleRenderer, this._scheduledExposures, this._exposureSchedule(frame));
    }

    reset(): void {
        this._upscaler.resetHistory();
        this._timer.reset();
    }

    resetTiming(): void {
        this._timer.reset();
    }

    setAuthoritativeTiming(authoritative: boolean): void {
        this._timer.setAuthoritative(authoritative);
    }

    waitForTimingCapacity(): Promise<void> {
        return this._timer.waitForAvailableSlot();
    }

    drainTiming(): Promise<void> {
        return this._timer.drain();
    }

    takeTimingSamples(): BenchmarkGpuFrameSample[] {
        return this._timer.takeSamples();
    }

    dispose(): void {
        this._exposureTexture?.dispose();
        for (const texture of this._scheduledExposures.values()) texture.dispose();
        this._scheduledExposures.clear();
        this._linearDepth?.dispose();
        this._upscaler.dispose();
    }
}

function createProductionUpscaler(
    renderer: THREE.WebGPURenderer,
    rcasShader?: string,
    spatialRcasShader?: string,
    shadingChangeShader?: string,
    crossFrameReconstruct?: CrossFrameReconstruct,
    depthClipShader?: string,
    rcasAgeKneeUngated?: boolean,
): Upscaler {
    // The bench always times: its HUD and the benchmark protocol read the timer.
    const options = {
        renderer,
        gpuTiming: true,
        _rcasShader: rcasShader,
        _spatialRcasShader: spatialRcasShader,
        _shadingChangeShader: shadingChangeShader,
        _crossFrameReconstruct: crossFrameReconstruct,
        _depthClipShader: depthClipShader,
        _rcasAgeKneeUngated: rcasAgeKneeUngated,
    };
    return new Upscaler(options);
}

function createCandidateUpscaler(
    renderer: THREE.WebGPURenderer,
    candidateBundle: string,
): CandidateUpscaler {
    const options = {
        renderer,
        // The source bundles run RCAS without FLAG_INPUT_REINHARD, where both
        // historical forms are identical.
        _rcasShader: RCAS_PER_TAP_SHADER,
        _candidateBundle: candidateBundle,
    };
    return new CandidateUpscaler(options);
}

/**
 * Adapts the production upscaler to the benchmark lifecycle.
 */
export class BaselineBenchmarkResolver extends BenchmarkResolverAdapter {
    /**
     * Switches this resolver to `depthMode: 'linear'`. Call before `configure()`.
     * @param converter - Produces the view-depth texture each frame
     */
    useLinearDepth(converter: LinearDepthConverter): void {
        this._linearDepth = converter;
    }

    /**
     * Adds configuration to every `configure()`. Call before the first one.
     * @param config - Extra `UpscalerConfig` fields for this identity
     */
    withConfig(config: BenchmarkExtraConfig): this {
        this._extraConfig = config;
        return this;
    }

    /**
     * Supplies a constant conditioning exposure through `exposureTexture`.
     * @param renderer - Renderer that uploads the 1×1 texture
     * @param value - The exposure it holds
     */
    withExposureTexture(renderer: THREE.WebGPURenderer, value: number): this {
        const texture = new THREE.DataTexture(new Float32Array([value, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        texture.needsUpdate = true;
        // three only uploads textures its own graph consumes; force it.
        renderer.initTexture(texture);
        this._exposureTexture = texture;
        return this;
    }

    /**
     * Supplies a conditioning exposure per scenario frame through
     * `exposureTexture` (the dispatch's frame tag is the scenario frame).
     * @param renderer - Renderer that uploads the 1×1 textures
     * @param schedule - The exposure for a frame
     */
    withExposureSchedule(renderer: THREE.WebGPURenderer, schedule: (frame: number) => number): this {
        this._scheduleRenderer = renderer;
        this._exposureSchedule = schedule;
        return this;
    }

    /** Hands the host pre-exposure over as `hostPreExposure`, not as a texture. */
    withHostPreExposureAsNumber(): this {
        this._hostPreExposureAsNumber = true;
        return this;
    }

    constructor(
        renderer: THREE.WebGPURenderer,
        metadata: BenchmarkVariantMetadata,
        rcasShader?: string,
        spatialRcasShader?: string,
        shadingChangeShader?: string,
        crossFrameReconstruct?: CrossFrameReconstruct,
        depthClipShader?: string,
        rcasAgeKneeUngated?: boolean,
    ) {
        super(
            createProductionUpscaler(
                renderer,
                rcasShader,
                spatialRcasShader,
                shadingChangeShader,
                crossFrameReconstruct,
                depthClipShader,
                rcasAgeKneeUngated,
            ),
            metadata,
        );
    }
}

/**
 * Adapts one frozen source-bundle snapshot to the benchmark lifecycle.
 */
export class CandidateBenchmarkResolver extends BenchmarkResolverAdapter {
    constructor(
        renderer: THREE.WebGPURenderer,
        metadata: BenchmarkVariantMetadata,
    ) {
        super(createCandidateUpscaler(renderer, metadata.id), metadata);
    }
}

/**
 * Creates the local baseline resolver. Its temporal path runs the frozen
 * `RCAS_LEGACY_SHADER` (the E00 `local-baseline-5d6a65e` shader identity), so
 * temporal captures and convergence records stay comparable across history.
 *
 * The spatial (FSR1) path differs by identity: `baseline` — the interactive
 * bench default — sharpens with production `RCAS_SHADER`, so spatial-path
 * changes show up in the bench. The two frozen E00 identities keep the legacy
 * shader on every path; `local-baseline-5d6a65e` is the explicit legacy FSR1
 * variant for A/B. No automated run uses the spatial path, so this changes no
 * recorded benchmark.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the selected identity
 * @returns One baseline resolver instance
 */
export function createBaselineResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        metadata.id === 'baseline' ? RCAS_SHADER : undefined,
    );
}

/**
 * Creates `linear-depth-input-v1`: the `baseline` pipeline configured with
 * `depthMode: 'linear'` and fed the scene's depth converted to view depth
 * (LinearDepthConverter), so the two depth modes can be compared on one scene.
 * The conversion is outside the upscaler's timer.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One linear-depth resolver instance
 */
export function createLinearDepthResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const resolver = new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
    );
    resolver.useLinearDepth(new LinearDepthConverter(renderer as THREE.WebGPURenderer));
    return resolver;
}

/**
 * Creates `exposure-provided-v1`: the `baseline` pipeline configured with
 * `exposureMode: 'provided'`, so the luminance measurement never runs and the
 * conditioning exposure is the fixed `settings.exposure`. Its output equals
 * `baseline` with `autoExposure: false`.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One provided-exposure resolver instance
 */
export function createProvidedExposureResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
    ).withConfig({ exposureMode: 'provided' });
}

/**
 * The conditioning exposure of the exposure-step identities, per scenario
 * frame: 1, a ×4 step up at 120, back down at 180, then a ×8 exponential ramp
 * over 240–299 (3.5 % per frame) held from 300. A still scenario converges
 * before 120, so every change after it is the exposure's alone.
 * @param frame - Scenario frame
 * @returns The exposure for that frame
 */
export function exposureStepSchedule(frame: number): number {
    if (frame < 120) return 1;
    if (frame < 180) return 4;
    if (frame < 240) return 1;
    if (frame < 300) return 8 ** ((frame - 240) / 60);
    return 8;
}

/**
 * Creates the conditioning-exposure identities (upstream issue 99):
 * - `conditioning-exposure-corrected-v1`: `baseline` with
 *   `correctConditioningExposure`, for the auto-exposure scenarios (Q9, Q11, Q15)
 * - `exposure-step-v1` / `exposure-step-corrected-v1`: `baseline` handed
 *   {@link exposureStepSchedule} as `exposureTexture`, without and with the
 *   correction
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One resolver instance
 */
export function createConditioningExposureResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const resolver = new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
    );
    if (metadata.id !== 'exposure-step-v1') resolver.withConfig({ correctConditioningExposure: true });
    if (metadata.id.startsWith('exposure-step-')) {
        resolver.withExposureSchedule(renderer as THREE.WebGPURenderer, exposureStepSchedule);
    }
    return resolver;
}

/** The exposure the exposure-texture identities supply. */
const EXPOSURE_TEXTURE_VALUE = 2;

/**
 * Creates the exposure-texture identities: `baseline` handed an
 * `exposureTexture` holding 2, in the default mode
 * (`exposure-texture-v1`: the measurement runs and is overridden) or with
 * `exposureMode: 'provided'` (`exposure-provided-texture-v1`: nothing is
 * measured). Both must equal `baseline` with `autoExposure: false` and
 * `exposure: 2`.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One resolver instance
 */
export function createExposureTextureResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const resolver = new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
    ).withExposureTexture(renderer as THREE.WebGPURenderer, EXPOSURE_TEXTURE_VALUE);
    return metadata.id === 'exposure-provided-texture-v1' ? resolver.withConfig({ exposureMode: 'provided' }) : resolver;
}

/**
 * Creates `host-pre-exposure-cpu-v1`: `baseline`, with the host pre-exposure
 * passed as the `hostPreExposure` number instead of `preExposureTexture`.
 * Its output must equal `baseline`'s (Q11 is the scenario that sets one).
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One resolver instance
 */
export function createHostPreExposureCpuResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
    ).withHostPreExposureAsNumber();
}

/**
 * Creates the `production` identity: the shipping pipeline with production
 * `RCAS_SHADER` on both the temporal and the FSR1 spatial path, i.e. what a
 * consumer gets with no bench override. `baseline` keeps the frozen legacy
 * shader on the temporal path for history comparability; use this identity
 * for anything that should describe current output quality (e.g.
 * scripts/measure-reference-quality.mjs).
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One production resolver instance
 */
export function createProductionRcasResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_SHADER,
        RCAS_SHADER,
    );
}

/**
 * Creates the age-knee identities: `production` configured with an
 * `rcasAgeKnee`, so temporal RCAS holds back on young history. No RCAS
 * override is passed (the knee is built from production RCAS by the core).
 * `rcas-age-knee-v1` is 0.5, `-25-` 0.25 and `-12-` 0.125; `-ungated-` is 0.5
 * without the still-pixel gate (age alone, the form first measured).
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the identity
 * @returns One age-knee resolver instance
 */
export function createRcasAgeKneeResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const ungated = metadata.id === 'rcas-age-knee-ungated-v1';
    const knee = metadata.id === 'rcas-age-knee-25-v1' ? 0.25 : metadata.id === 'rcas-age-knee-12-v1' ? 0.125 : 0.5;
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ungated,
    ).withConfig({ rcasAgeKnee: knee });
}

/**
 * Creates the isolated FSR 3.1.5 RCAS numeric candidate. Pinned to the
 * per-tap shader (the production form when these identities were measured) so
 * their timings stay frozen; current production is `rcas-tonemap-space-v1`.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata for the candidate identity
 * @returns One candidate resolver instance
 */
export function createRcasNumericParityResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_PER_TAP_SHADER,
    );
}

/**
 * Creates an RCAS load-strategy experiment candidate (item 1 of
 * bench/docs/NEXT-STEPS.md): production pipeline, only the RCAS shader varies.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the experiment identity
 * @returns One candidate resolver instance
 */
export function createRcasExperimentResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        metadata.id === 'rcas-hoisted-exposure-v1'
            ? RCAS_HOISTED_EXPOSURE_SHADER
            : RCAS_TONEMAP_SPACE_SHADER,
    );
}

/**
 * Creates one of the cumulative source-style benchmark candidates.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the candidate bundle ID
 * @returns One candidate resolver instance
 */
export function createSourceBundleResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    return new CandidateBenchmarkResolver(renderer as THREE.WebGPURenderer, metadata);
}

/** Block-memory shading-change candidates (NEXT-STEPS §14) by identity; `gated8` is production. */
const SHADING_MEMORY_CANDIDATES = {
    'shading-memory-range4': { mode: 'range', slots: 4 },
    'shading-memory-range8': { mode: 'range', slots: 8 },
    'shading-memory-nearest8': { mode: 'nearest', slots: 8 },
    'shading-memory-ema': { mode: 'ema', slots: 1 },
    'shading-memory-gated8-k1': { mode: 'gated', slots: 8, jumpGain: 1 },
    'shading-memory-gated4': { mode: 'gated', slots: 4, jumpGain: 1.5 },
} as const;

/**
 * Creates a shading-change candidate: the baseline identity (legacy temporal
 * RCAS, so captures compare against `baseline` and the E00 pair) with only the
 * shading-change pass swapped — for a rejected block-memory form, or for
 * `shading-frame-pair-v1`, the frozen pre-memory detector.
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the candidate identity
 * @returns One candidate resolver instance
 */
export function createShadingMemoryResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const shader =
        metadata.id === 'shading-frame-pair-v1'
            ? SHADING_CHANGE_FRAME_PAIR_SHADER
            : buildShadingRecurrenceShader(
                  SHADING_MEMORY_CANDIDATES[metadata.id as keyof typeof SHADING_MEMORY_CANDIDATES],
              );
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
        shader,
    );
}

/**
 * Creates an issue #67 depth-clip identity: the `baseline` pipeline (same
 * frozen temporal RCAS, production spatial RCAS) with the reconstruct stage
 * swapped for the pre-#67 cross-frame form or its camera-compensated variant
 * (see packages/core/src/shaders/reconstructVariants.ts).
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the experiment identity
 * @returns One experiment resolver instance
 */
export function createReconstructExperimentResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const camera = metadata.id === 'reconstruct-camera-v1';
    const variant: CrossFrameReconstruct = {
        shader: camera ? RECONSTRUCT_CAMERA_SHADER : RECONSTRUCT_CROSS_FRAME_SHADER,
        cameraCompensated: camera,
    };
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
        undefined,
        variant,
    );
}

/**
 * Creates an issue #79 depth-clip variant: the `baseline` pipeline with only
 * the depth-clip pass swapped (relief widening, best-tap vote and tolerance
 * scale toggled toward upstream FSR2 — see buildDepthClipVariant).
 * @param renderer - Initialized three WebGPU renderer
 * @param metadata - Registry metadata carrying the variant identity
 * @returns One variant resolver instance
 */
export function createDepthClipVariantResolver(
    renderer: unknown,
    metadata: BenchmarkVariantMetadata,
): BenchmarkResolver {
    const options = DEPTH_CLIP_VARIANTS[metadata.id as keyof typeof DEPTH_CLIP_VARIANTS];
    return new BaselineBenchmarkResolver(
        renderer as THREE.WebGPURenderer,
        metadata,
        RCAS_LEGACY_SHADER,
        RCAS_SHADER,
        undefined,
        undefined,
        buildDepthClipVariant(options),
    );
}
