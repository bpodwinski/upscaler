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

export type FrameGraphUpscaleConfiguration = Omit<CoreConfiguration, 'path'> & { path?: 'temporal' | 'spatial' | 'bilinear' };

/** Render-resolution guides owned by Babylon's texture manager, available on the temporal path. */
export interface FrameGraphUpscaleGuides {
    /** Current linear depth. Resolve with getTextureFromHandle(handle, true), as this is history.write. */
    readonly dilatedDepth: number;
    /** Dilated motion in RG, in UV units. */
    readonly dilatedMotion: number;
    /** Disocclusion in R: 1 rejects history, 0 accepts it. */
    readonly disocclusion: number;
}

export interface FrameGraphUpscaleOptions {
    configuration: FrameGraphUpscaleConfiguration;
    /**
     * Must match the conditioning/host exposure baked into the input textures.
     * In split mode this runs for each phase; geometry must stay identical until upscale finishes.
     */
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

/** Temporal, spatial or bilinear reconstruction. The texture manager owns history swaps. */
export class FrameGraphUpscaleTask extends FrameGraphTask {
    colorTexture!: number;
    depthTexture!: number;
    velocityTexture!: number;
    reactiveTexture?: number;
    reactiveOpaqueColorTexture?: number;
    exposureTexture?: number;
    preExposureTexture?: number;
    readonly outputTexture: number;
    readonly guides: FrameGraphUpscaleGuides;
    readonly settings: RuntimeSettings;
    private readonly core: UpscalerCore;
    private readonly fallback: UpscalerCore;
    private configuration: FrameGraphUpscaleConfiguration;
    private readonly frame: () => FrameData;
    private readonly handles = new Map<ResourceName, number>();
    private temporalLastFrame = false;
    private initialized = false;
    private preparation?: Promise<void>;
    private guidesTask?: FrameGraphTask;
    private guidesRecorded = false;
    private splitPending = false;
    private sequence = new JitterSequence(1);
    private restoreProjection: (() => void) | null = null;
    private currentJitter = { x: 0, y: 0 };
    private previousJitter = { x: 0, y: 0 };
    /** Use this projection when generating unjittered motion vectors. */
    unjitteredProjectionMatrix: Matrix | null = null;

    constructor(name: string, graph: FrameGraph, options: FrameGraphUpscaleOptions) {
        super(name, graph);
        this.configuration = { ...options.configuration, path: options.configuration.path ?? 'temporal' };
        getResourceDescriptors(this.configuration);
        this.frame = options.frame; this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
        const device = getBabylonDevice(graph.engine);
        this.core = new UpscalerCore({ device }); this.fallback = new UpscalerCore({ device });
        this.configure(this.configuration);
        this.outputTexture = graph.textureManager.createDanglingHandle();
        this.guides = Object.freeze({
            dilatedDepth: graph.textureManager.createDanglingHandle(),
            dilatedMotion: graph.textureManager.createDanglingHandle(),
            disocclusion: graph.textureManager.createDanglingHandle(),
        });
    }

    /** Call between frames, then rebuild the Frame Graph to allocate the new requirements. */
    configure(configuration: FrameGraphUpscaleConfiguration): void {
        if (this.splitPending) throw new Error('@ruxelion/upscaler: cannot configure during a Babylon split frame; finish upscale or resetHistory() first.');
        if (this.restoreProjection) throw new Error('@ruxelion/upscaler: cannot configure during an active Babylon frame.');
        if (this.guidesTask && (configuration.path ?? 'temporal') !== 'temporal') throw new Error('@ruxelion/upscaler: a guides task requires the temporal path.');
        if (configuration.path && !['temporal', 'spatial', 'bilinear'].includes(configuration.path)) throw new Error('@ruxelion/upscaler: Babylon task supports temporal, spatial or bilinear paths.');
        this.configuration = { ...configuration, path: configuration.path ?? 'temporal' };
        this.core.configure(this.configuration);
        this.fallback.configure({ ...this.configuration, path: 'bilinear' });
        this.temporalLastFrame = false; this.initialized = false; this.preparation = undefined; this.guidesRecorded = false;
        this.sequence.setRatio(configuration.displayWidth / configuration.renderWidth);
    }
    prepare(): Promise<void> {
        // Both tasks share compilation, including optional passes changed by frame callbacks.
        if (this.preparation) return this.preparation;
        const preparation = Promise.all([
            this.core.prepare({ ...this.settings, detectShadingChanges: true, debugView: DebugView.Depth }), this.fallback.prepare({}),
        ]).then(() => {
            if (this.preparation === preparation) this.initialized = true;
        }, error => {
            if (this.preparation === preparation) this.preparation = undefined;
            throw error;
        });
        return this.preparation = preparation;
    }
    override initAsync(): Promise<void> { return this.prepare(); }
    override isReady(): boolean { return this.initialized && this.core.isReady && this.fallback.isReady; }
    override get disabled(): boolean { return this._disabled; }
    override set disabled(value: boolean) {
        if (value === this._disabled) return;
        if (!value && !this.isReady()) throw new Error('@ruxelion/upscaler: cannot activate an unprepared Babylon task.');
        this._disabled = value; this.resetHistory();
    }
    resetHistory(): void { this.core.resetHistory(); this.splitPending = false; this.temporalLastFrame = false; this.sequence.reset(); }
    get jitter(): Readonly<{ x: number; y: number }> { return this.currentJitter; }
    /** Wrap input rendering and graph execution in beginFrame / endFrame (try/finally). */
    beginFrame(camera: Camera): void {
        if (this.restoreProjection) throw new Error('@ruxelion/upscaler: a Babylon jitter frame is already active.');
        this.sequence.advance(); const [x, y] = this.sequence.current; const [px, py] = this.sequence.previous;
        const jittered = !this.disabled && this.configuration.path === 'temporal';
        this.currentJitter = jittered ? { x, y } : { x: 0, y: 0 }; this.previousJitter = jittered ? { x: px, y: py } : { x: 0, y: 0 };
        this.unjitteredProjectionMatrix = camera.getProjectionMatrix().clone();
        const projection = this.unjitteredProjectionMatrix.clone();
        projection.fromArray(jitterProjection(projection.m, this.currentJitter, this.configuration.renderWidth, this.configuration.renderHeight));
        this.restoreProjection = freezeJitteredProjection(camera, projection);
    }
    endFrame(): void {
        this.restoreProjection?.(); this.restoreProjection = null;
        // A consumer may have thrown before the final task executed.
        if (this.splitPending) this.resetHistory();
    }

    /**
     * Opt into guides -> host consumer(s) -> upscale. Add the returned task to the same
     * graph before consumers and this task. It shares allocations and compilation with
     * its owner and produces guides even when the owner selects its disabled bilinear pass.
     */
    createGuidesTask(name = `${this.name}-guides`): FrameGraphTask {
        if (this.configuration.path !== 'temporal') throw new Error('@ruxelion/upscaler: a guides task requires the temporal path.');
        if (this.guidesTask) return this.guidesTask;
        this.guidesTask = new class extends FrameGraphTask {
            constructor(name: string, graph: FrameGraph, private readonly owner: FrameGraphUpscaleTask) { super(name, graph); }
            override initAsync(): Promise<void> { return this.owner.prepare(); }
            override isReady(): boolean { return this.owner.isReady(); }
            record(): void { this.owner.recordGuides(); }
        }(name, this._frameGraph, this);
        return this.guidesTask;
    }

    private assertGuidesOrder(): void {
        const tasks = this._frameGraph.tasks;
        const early = tasks.indexOf(this.guidesTask!); const late = tasks.indexOf(this);
        if (early < 0 || late < 0 || early >= late) throw new Error('@ruxelion/upscaler: add the guides task before its upscale task in the same Frame Graph.');
    }

    private allocateResources(): void {
        const manager = this._frameGraph.textureManager;
        this.handles.clear();
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = manager.createRenderTargetTexture(`${this.name}-${descriptor.name}`, getBabylonTextureOptions(descriptor));
            this.handles.set(descriptor.name, handle);
        }
        manager.resolveDanglingHandle(this.outputTexture, this.handles.get('output'));
        if (this.configuration.path === 'temporal') {
            manager.resolveDanglingHandle(this.guides.dilatedDepth, this.handles.get('dilatedDepth'));
            manager.resolveDanglingHandle(this.guides.dilatedMotion, this.handles.get('dilatedMotion'));
            manager.resolveDanglingHandle(this.guides.disocclusion, this.handles.get('masks'));
        }
        this.resetHistory();
    }

    private recordGuides(): void {
        this.assertGuidesOrder();
        if (this.depthTexture === undefined || this.velocityTexture === undefined) throw new Error('@ruxelion/upscaler: guides require Babylon depth and velocity handles.');
        this.allocateResources();
        const pass = this._frameGraph.addRenderPass(this.guidesTask!.name);
        pass.setRenderTarget([this.guides.dilatedDepth, this.guides.dilatedMotion, this.guides.disocclusion]);
        // Include every working allocation: the core snapshots their identities early.
        // Final color and other late inputs can be produced by intervening consumers.
        pass.addDependencies([this.depthTexture, this.velocityTexture, ...this.handles.values()]);
        pass.setExecuteFunc(() => this.executeGuides());
        this.guidesRecorded = true;
    }

    record(skipCreationOfDisabledPasses = false): void {
        const required = this.configuration.path === 'temporal' ? [['color', this.colorTexture], ['depth', this.depthTexture], ['velocity', this.velocityTexture]] : [['color', this.colorTexture]];
        for (const [name, value] of required) if (value === undefined) throw new Error(`@ruxelion/upscaler: missing Babylon ${name} handle.`);
        if (this.guidesTask) {
            this.assertGuidesOrder();
            if (!this.guidesRecorded) throw new Error('@ruxelion/upscaler: record the guides task before its upscale task.');
            this.guidesRecorded = false;
        } else this.allocateResources();
        const inputHandles = [this.colorTexture, this.depthTexture, this.velocityTexture, this.reactiveTexture, this.reactiveOpaqueColorTexture, this.exposureTexture, this.preExposureTexture].filter((h): h is number => h !== undefined);
        // Render passes are required: Babylon's lifetime analysis collects their dependencies.
        const add = (disabled: boolean): void => {
            const pass = this._frameGraph.addRenderPass(`${this.name}-${disabled ? 'bilinear' : this.configuration.path}`, disabled);
            pass.setRenderTarget(this.outputTexture);
            pass.addDependencies([...inputHandles, ...this.handles.values()]);
            pass.setExecuteFunc(() => this.executeUpscale(disabled));
        };
        add(false); if (!skipCreationOfDisabledPasses) add(true);
    }

    private resources(guidesOnly = false): CoreResources {
        const manager = this._frameGraph.textureManager; const result: CoreResources = {};
        for (const descriptor of getResourceDescriptors(this.configuration)) {
            const handle = this.handles.get(descriptor.name)!;
            result[descriptor.name] = descriptor.history
                ? { read: resolveBabylonTexture(manager, handle), write: resolveBabylonTexture(manager, handle, true) }
                : resolveBabylonTexture(manager, handle);
        }
        const inputs = guidesOnly ? { depth: this.depthTexture, velocity: this.velocityTexture } : { color: this.colorTexture, depth: this.depthTexture, velocity: this.velocityTexture, reactive: this.reactiveTexture, reactiveOpaqueColor: this.reactiveOpaqueColorTexture, exposureTexture: this.exposureTexture, preExposureTexture: this.preExposureTexture };
        for (const name of Object.keys(inputs) as (keyof typeof inputs)[]) {
            const handle = inputs[name]; if (handle !== undefined) result[name] = resolveBabylonTexture(manager, handle, true);
        }
        return result;
    }
    private frameData(): FrameData {
        const supplied = this.frame();
        return { ...supplied,
            jitter: this.disabled ? { x: 0, y: 0 } : this.restoreProjection ? this.currentJitter : supplied.jitter,
            jitterPrevious: this.disabled ? { x: 0, y: 0 } : this.restoreProjection ? this.previousJitter : supplied.jitterPrevious,
            settings: { ...this.settings, ...supplied.settings },
        };
    }
    private executeGuides(): void {
        if (!this.isReady()) throw new Error('@ruxelion/upscaler: Babylon task is unprepared; await prepare() or graph.whenReadyAsync().');
        if (this.splitPending) throw new Error('@ruxelion/upscaler: a Babylon split frame is already active; finish upscale or resetHistory() first.');
        if (!this.temporalLastFrame) this.core.resetHistory();
        this.core.encodeGuides(getBabylonEncoder(this._frameGraph.engine), this.resources(true), this.frameData());
        this.splitPending = true;
    }
    private executeUpscale(disabled: boolean): void {
        if (!this.isReady()) throw new Error('@ruxelion/upscaler: Babylon task is unprepared; await prepare() or graph.whenReadyAsync().');
        if (this.guidesTask && !this.splitPending) throw new Error('@ruxelion/upscaler: execute the guides task before the final upscale task.');
        const resources = this.resources(); const frame = this.frameData();
        const encoder = getBabylonEncoder(this._frameGraph.engine);
        if (disabled) {
            this.core.resetHistory(); this.splitPending = false; this.temporalLastFrame = false;
            this.fallback.encode(encoder, resources, { ...frame, settings: { ...frame.settings, sharpness: 0 } });
        } else {
            if (this.guidesTask) {
                this.core.encodeUpscale(encoder, resources, frame); this.splitPending = false;
            } else {
                if (!this.temporalLastFrame) this.core.resetHistory();
                this.core.encode(encoder, resources, frame);
            }
            this.temporalLastFrame = true;
        }
    }
    override dispose(): void { this.endFrame(); this.core.dispose(); this.fallback.dispose(); super.dispose(); }
}
