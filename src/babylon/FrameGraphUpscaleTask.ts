import { Constants } from '@babylonjs/core/Engines/constants.js';
import { FrameGraphTask } from '@babylonjs/core/FrameGraph/frameGraphTask.js';
import type { FrameGraph } from '@babylonjs/core/FrameGraph/frameGraph.js';
import type { FrameGraphTextureCreationOptions } from '@babylonjs/core/FrameGraph/frameGraphTypes.js';
import { UpscalerCore } from '../core/UpscalerCore.js';
import { getResourceDescriptors } from '../core/resources.js';
import { DebugView, DEFAULT_SETTINGS } from '../core/types.js';
import { JitterSequence } from '../math/jitter.js';
import { jitterProjection } from '../core/projection.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Matrix } from '@babylonjs/core/Maths/math.vector.js';
import type { CoreConfiguration, CoreResources, FrameData, ResourceDescriptor, ResourceName, RuntimeSettings } from '../core/types.js';
import { freezeJitteredProjection, getBabylonDevice, getBabylonEncoder, resolveBabylonTexture } from './compatibility.js';

export interface FrameGraphUpscaleOptions {
    configuration: Omit<CoreConfiguration, 'path'>;
    /** Must match the conditioning/host exposure baked into the input textures. */
    frame: () => FrameData;
    settings?: Partial<RuntimeSettings>;
}

/** Converts the pure core requirements to Babylon-owned Frame Graph allocations. */
export function getBabylonTextureOptions(descriptor: ResourceDescriptor): FrameGraphTextureCreationOptions {
    const integer = descriptor.format === 'rgba32uint';
    const red = descriptor.format === 'r8unorm' || descriptor.format === 'r32float';
    const type = integer ? Constants.TEXTURETYPE_UNSIGNED_INTEGER : descriptor.format.includes('32float') ? Constants.TEXTURETYPE_FLOAT : descriptor.format.includes('16float') ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
    return {
        size: { width: descriptor.width, height: descriptor.height }, sizeIsPercentage: false,
        isHistoryTexture: descriptor.history,
        options: { samples: 1, createMipMaps: false, types: [type], formats: [integer ? Constants.TEXTUREFORMAT_RGBA_INTEGER : red ? Constants.TEXTUREFORMAT_RED : Constants.TEXTUREFORMAT_RGBA], creationFlags: [(descriptor.usage & 8) ? Constants.TEXTURE_CREATIONFLAG_STORAGE : 0] },
    };
}

/** Temporal-only task. The texture manager performs the only history swap. */
export class FrameGraphUpscaleTask extends FrameGraphTask {
    colorTexture!: number;
    depthTexture!: number;
    velocityTexture!: number;
    reactiveTexture?: number;
    reactiveOpaqueColorTexture?: number;
    exposureTexture?: number;
    preExposureTexture?: number;
    readonly outputTexture: number;
    readonly settings: RuntimeSettings;
    private readonly core: UpscalerCore;
    private readonly fallback: UpscalerCore;
    private configuration: CoreConfiguration;
    private readonly frame: () => FrameData;
    private readonly handles = new Map<ResourceName, number>();
    private temporalLastFrame = false;
    private initialized = false;
    private sequence = new JitterSequence(1);
    private restoreProjection: (() => void) | null = null;
    private currentJitter = { x: 0, y: 0 };
    private previousJitter = { x: 0, y: 0 };
    /** Use this projection when generating unjittered motion vectors. */
    unjitteredProjectionMatrix: Matrix | null = null;

    constructor(name: string, graph: FrameGraph, options: FrameGraphUpscaleOptions) {
        super(name, graph);
        this.configuration = { ...options.configuration, path: 'temporal' };
        getResourceDescriptors(this.configuration);
        this.frame = options.frame; this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
        const device = getBabylonDevice(graph.engine);
        this.core = new UpscalerCore({ device }); this.fallback = new UpscalerCore({ device });
        this.configure(this.configuration);
        this.outputTexture = graph.textureManager.createDanglingHandle();
    }

    /** Call between frames, then rebuild the Frame Graph to allocate the new requirements. */
    configure(configuration: Omit<CoreConfiguration, 'path'>): void {
        if (this.restoreProjection) throw new Error('@ruxelion/upscaler: cannot configure during an active Babylon frame.');
        this.configuration = { ...configuration, path: 'temporal' };
        this.core.configure(this.configuration);
        this.fallback.configure({ ...this.configuration, path: 'bilinear' });
        this.temporalLastFrame = false; this.initialized = false;
        this.sequence.setRatio(configuration.displayWidth / configuration.renderWidth);
    }
    async prepare(): Promise<void> {
        // Frame callbacks may change optional runtime settings after graph initialization.
        await Promise.all([this.core.prepare({ ...this.settings, detectShadingChanges: true, debugView: DebugView.Depth }), this.fallback.prepare({})]);
        this.initialized = true;
    }
    override initAsync(): Promise<void> { return this.prepare(); }
    override isReady(): boolean { return this.initialized && this.core.isReady && this.fallback.isReady; }
    override get disabled(): boolean { return this._disabled; }
    override set disabled(value: boolean) {
        if (value === this._disabled) return;
        if (!value && !this.isReady()) throw new Error('@ruxelion/upscaler: cannot activate an unprepared Babylon task.');
        this._disabled = value; this.resetHistory();
    }
    resetHistory(): void { this.core.resetHistory(); this.temporalLastFrame = false; this.sequence.reset(); }
    get jitter(): Readonly<{ x: number; y: number }> { return this.currentJitter; }
    /** Wrap input rendering and graph execution in beginFrame / endFrame (try/finally). */
    beginFrame(camera: Camera): void {
        if (this.restoreProjection) throw new Error('@ruxelion/upscaler: a Babylon jitter frame is already active.');
        this.sequence.advance(); const [x, y] = this.sequence.current; const [px, py] = this.sequence.previous;
        this.currentJitter = this.disabled ? { x: 0, y: 0 } : { x, y }; this.previousJitter = { x: px, y: py };
        this.unjitteredProjectionMatrix = camera.getProjectionMatrix().clone();
        const projection = this.unjitteredProjectionMatrix.clone();
        projection.fromArray(jitterProjection(projection.m, this.currentJitter, this.configuration.renderWidth, this.configuration.renderHeight));
        this.restoreProjection = freezeJitteredProjection(camera, projection);
    }
    endFrame(): void { this.restoreProjection?.(); this.restoreProjection = null; }

    record(skipCreationOfDisabledPasses = false): void {
        for (const [name, value] of [['color', this.colorTexture], ['depth', this.depthTexture], ['velocity', this.velocityTexture]] as const) if (value === undefined) throw new Error(`@ruxelion/upscaler: missing Babylon ${name} handle.`);
        const manager = this._frameGraph.textureManager;
        this.handles.clear();
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = manager.createRenderTargetTexture(`${this.name}-${descriptor.name}`, getBabylonTextureOptions(descriptor));
            this.handles.set(descriptor.name, handle);
        }
        manager.resolveDanglingHandle(this.outputTexture, this.handles.get('output'));
        const inputHandles = [this.colorTexture, this.depthTexture, this.velocityTexture, this.reactiveTexture, this.reactiveOpaqueColorTexture, this.exposureTexture, this.preExposureTexture].filter((h): h is number => h !== undefined);
        // Render passes are required: Babylon's lifetime analysis collects their dependencies.
        const add = (disabled: boolean): void => {
            const pass = this._frameGraph.addRenderPass(`${this.name}${disabled ? '-bilinear' : '-temporal'}`, disabled);
            pass.setRenderTarget(this.outputTexture);
            pass.addDependencies([...inputHandles, ...this.handles.values()]);
            pass.setExecuteFunc(() => this.executeUpscale(disabled));
        };
        add(false); if (!skipCreationOfDisabledPasses) add(true);
        this.resetHistory();
    }

    private resources(): CoreResources {
        const manager = this._frameGraph.textureManager; const result: CoreResources = {};
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = this.handles.get(descriptor.name)!;
            result[descriptor.name] = descriptor.history
                ? { read: resolveBabylonTexture(manager, handle), write: resolveBabylonTexture(manager, handle, true) }
                : resolveBabylonTexture(manager, handle);
        }
        const inputs = { color: this.colorTexture, depth: this.depthTexture, velocity: this.velocityTexture, reactive: this.reactiveTexture, reactiveOpaqueColor: this.reactiveOpaqueColorTexture, exposureTexture: this.exposureTexture, preExposureTexture: this.preExposureTexture };
        for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
            const handle = inputs[name]; if (handle !== undefined) result[name] = resolveBabylonTexture(manager, handle, true);
        }
        return result;
    }
    private executeUpscale(disabled: boolean): void {
        if (!this.isReady()) throw new Error('@ruxelion/upscaler: Babylon task is unprepared; await prepare() or graph.whenReadyAsync().');
        const resources = this.resources(); const supplied = this.frame();
        const frame = { ...supplied, jitter: this.restoreProjection ? this.currentJitter : supplied.jitter, jitterPrevious: this.restoreProjection ? this.previousJitter : supplied.jitterPrevious, settings: { ...this.settings, ...supplied.settings } };
        const encoder = getBabylonEncoder(this._frameGraph.engine);
        if (disabled) {
            this.core.resetHistory(); this.temporalLastFrame = false;
            this.fallback.encode(encoder, resources, { ...frame, settings: { ...frame.settings, sharpness: 0 } });
        } else {
            if (!this.temporalLastFrame) this.core.resetHistory();
            this.core.encode(encoder, resources, frame); this.temporalLastFrame = true;
        }
    }
    override dispose(): void { this.endFrame(); this.core.dispose(); this.fallback.dispose(); super.dispose(); }
}
