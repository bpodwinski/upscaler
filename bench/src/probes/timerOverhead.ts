import * as THREE from 'three/webgpu';

import { UpscalePass, type UpscalePath } from '@pmndrs/upscaler';

import { createBenchScene } from '../BenchScene';

/**
 * GPU-timing overhead probe (issue #70), driven by
 * `scripts/measure-timer-overhead.mjs` over CDP.
 *
 * The timer can't measure its own cost, so this measures from outside:
 * wall-clock throughput with the GPU kept busy. Each leg submits frames
 * back to back with a bounded number in flight (`onSubmittedWorkDone`), so
 * the queue never drains and ms/frame tracks GPU cost plus whatever the CPU
 * adds on the critical path. CPU time inside the encode/submit call is
 * recorded separately.
 *
 * Legs alternate `gpuTiming` on/off in an A B B A pattern per block (A = on),
 * so linear drift (clocks, thermals) cancels, and the two A legs of a block
 * give a self-disagreement noise floor.
 *
 * Modes:
 * - `dispatch`: the scene is rendered once; each frame is `upscaler.dispatch`
 *   alone. Maximal sensitivity to the upscaler's own GPU work.
 * - `frame`: each frame renders the animated bench scene, upscales and
 *   presents. The overhead as a share of a whole (simple) frame.
 */

/** One measurement request from the CDP driver. */
interface ProbeRequest {
    path: UpscalePath;
    ratio: number;
    mode: 'dispatch' | 'frame';
    width: number;
    height: number;
    /** Timed frames per leg. */
    frames: number;
    /** Untimed frames before each leg (lets a re-enabled timer come up). */
    warmup: number;
    blocks: number;
    /** Frames allowed in flight before the loop waits on the oldest. */
    inflight: number;
    /**
     * Keep the timer allocated through the off legs and only stop attaching
     * timestamp work — isolates the per-frame cost from allocation.
     */
    attachOnly?: boolean;
    /**
     * What an on leg does (attach-only runs). `full`: today's timer.
     * `writes`: per-pass timestampWrites, no resolve/copy/readback — the
     * per-pass share. `resolve`: writes + resolve + copy, no mapAsync.
     * `sampled:N`: the full timer on every Nth frame only. `none`: an A/A
     * control — on legs attach nothing either, so any delta is harness bias.
     */
    variant?: string;
}

interface LegResult {
    timing: boolean;
    msPerFrame: number;
    cpuMsPerFrame: number;
    /** Frames the timer actually timestamped (sanity: ≈ frames when on). */
    timedFrames: number;
    /** Upscale GPU ms per frame as the timer saw it (on legs only). */
    timerGpuMs: number | null;
}

type TimerBridge = {
    takeSamples(): Array<{ passes: Array<{ milliseconds: number }> }>;
    beginFrame(frame?: number): void;
    resolve(encoder: GPUCommandEncoder): void;
    readback(completesFrame?: boolean): void;
    _active: { state: string } | null;
};

const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
await renderer.init();
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const device = (renderer.backend as unknown as { device: GPUDevice }).device;

const bench = createBenchScene();
const scene = bench.scene;
const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
camera.position.set(6, 3.2, 8);
camera.lookAt(0, 0.8, 0);

const pass = new UpscalePass(renderer, { gpuTiming: true });
const upscaler = pass.upscaler;

function timer(): TimerBridge | null {
    return (upscaler as unknown as { _timer: TimerBridge | null })._timer;
}

/**
 * Attach-only switch: keeps the allocation and gates the timer's per-frame
 * steps, so an on leg can run a decomposed variant of the timer's work.
 */
let suppressAttach = false;
let variant = 'full';
let submitCount = 0;
function patchAttach(): void {
    const bridge = timer();
    if (!bridge || (bridge as unknown as { __patched?: boolean }).__patched) return;
    const begin = bridge.beginFrame.bind(bridge);
    const resolve = bridge.resolve.bind(bridge);
    const readback = bridge.readback.bind(bridge);
    bridge.beginFrame = (frame?: number) => {
        const index = submitCount++;
        if (suppressAttach || variant === 'none') return;
        if (variant.startsWith('sampled:') && index % Number(variant.slice(8)) !== 0) return;
        begin(frame);
    };
    bridge.resolve = (encoder: GPUCommandEncoder) => {
        if (variant !== 'writes') resolve(encoder);
    };
    bridge.readback = (completesFrame?: boolean) => {
        if (variant === 'writes' || variant === 'resolve') {
            // Recycle the slot without mapping it.
            if (bridge._active) bridge._active.state = 'idle';
            bridge._active = null;
            return;
        }
        readback(completesFrame);
    };
    (bridge as unknown as { __patched?: boolean }).__patched = true;
}

let time = 0;
function frameWork(request: ProbeRequest): void {
    if (request.mode === 'frame') {
        time += 1 / 60;
        bench.update(time, true);
        pass.draw(scene, camera, 1 / 60);
        pass.present();
        return;
    }
    const rt = pass.renderTarget!;
    const temporal = request.path === 'temporal';
    upscaler.dispatch(
        {
            color: rt.textures[0],
            depth: rt.depthTexture ?? undefined,
            velocity: temporal ? rt.textures[1] : undefined,
            deltaTime: 1 / 60,
        },
        camera,
    );
}

async function runFrames(request: ProbeRequest, count: number): Promise<{ wall: number; cpu: number }> {
    await device.queue.onSubmittedWorkDone();
    const inflight: Promise<void>[] = [];
    let cpu = 0;
    const start = performance.now();
    for (let index = 0; index < count; index++) {
        const before = performance.now();
        frameWork(request);
        cpu += performance.now() - before;
        inflight.push(device.queue.onSubmittedWorkDone());
        if (inflight.length >= request.inflight) await inflight.shift();
    }
    await Promise.all(inflight);
    return { wall: performance.now() - start, cpu };
}

async function leg(request: ProbeRequest, timing: boolean): Promise<LegResult> {
    if (request.attachOnly) {
        upscaler.gpuTiming = true;
        patchAttach();
        suppressAttach = !timing;
        variant = request.variant ?? 'full';
    } else {
        upscaler.gpuTiming = timing;
    }
    await runFrames(request, request.warmup);
    timer()?.takeSamples();
    const { wall, cpu } = await runFrames(request, request.frames);
    // Let the last readbacks land before counting them.
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const samples = (timing ? timer()?.takeSamples() : null) ?? [];
    const gpu = samples.map((sample) => sample.passes.reduce((sum, p) => sum + p.milliseconds, 0));
    gpu.sort((a, b) => a - b);
    return {
        timing,
        msPerFrame: wall / request.frames,
        cpuMsPerFrame: cpu / request.frames,
        timedFrames: samples.length,
        timerGpuMs: gpu.length ? gpu[gpu.length >> 1] : null,
    };
}

async function run(request: ProbeRequest) {
    renderer.setSize(request.width, request.height, false);
    camera.aspect = request.width / request.height;
    camera.updateProjectionMatrix();
    pass.configure({
        displayWidth: request.width,
        displayHeight: request.height,
        ratio: request.ratio,
        path: request.path,
    });
    await pass.init();
    // Inputs for dispatch mode: one real scene render into the pass's target.
    bench.update(0, false);
    pass.draw(scene, camera, 1 / 60);
    await device.queue.onSubmittedWorkDone();

    const blocks: LegResult[][] = [];
    for (let block = 0; block < request.blocks; block++) {
        const legs: LegResult[] = [];
        for (const timing of [true, false, false, true]) legs.push(await leg(request, timing));
        blocks.push(legs);
    }
    suppressAttach = false;
    variant = 'full';
    upscaler.gpuTiming = true;
    return {
        adapter: (device as unknown as { adapterInfo?: GPUAdapterInfo }).adapterInfo
            ? {
                  vendor: device.adapterInfo.vendor,
                  architecture: device.adapterInfo.architecture,
                  description: device.adapterInfo.description,
              }
            : null,
        timestampQuery: device.features.has('timestamp-query'),
        renderSize: [upscaler.renderWidth, upscaler.renderHeight],
        blocks,
    };
}

const errors: string[] = [];
device.addEventListener('uncapturederror', (event) => {
    errors.push((event as GPUUncapturedErrorEvent).error.message);
});

(window as unknown as { __timerOverhead: unknown }).__timerOverhead = {
    ready: true,
    run,
    errors,
    // For ad-hoc CDP checks (e.g. the issue #69 stale-label verification).
    pass,
    renderFrames: (request: ProbeRequest, count: number) => runFrames(request, count),
};
