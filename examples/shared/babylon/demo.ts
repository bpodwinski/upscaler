import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js';
import '@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import { babylonWebGPU } from '@ruxelion/upscaler/babylon';
import { BabylonScenePresenter } from './BabylonScenePresenter';
import { createSceneContent, type DemoKind } from './scenes';
import { readTexture } from './readback';
import './style.css';

const descriptions: Record<DemoKind, [string, string]> = {
    hello: ['Hello Babylon', 'A real mesh scene: HDR color, linear depth, motion vectors and temporal reconstruction.'],
    aliasing: ['Aliasing torture', 'Thin pickets, crossing wires and a receding checkerboard. Freeze motion to inspect convergence.'],
    compare: ['Native / temporal comparison', 'Native resolution on the left; reconstructed low resolution on the right. Both use the same scene and display transform.'],
    transparency: ['Transparency', 'Moving alpha-blended glass and emissive patches. Toggle the reactive mask to inspect history rejection.'],
    spatial: ['Spatial / temporal comparison', 'Spatial EASU + RCAS on the left; temporal reconstruction on the right. Both scenes render at the selected low resolution.'],
    compose: ['Frame Graph composition', 'The reconstructed texture feeds a separate full-resolution color pass. Toggle the vignette without resetting temporal history.'],
    reactive: ['Authored reactive mask', 'A dedicated geometry pass draws transparent coverage against opaque depth. Inspect the authored mask and toggle its effect on reconstruction.'],
    'canvas-alpha': ['Transparent canvas', 'Temporal reconstruction preserves silhouette coverage. The page background and text remain visible through the canvas.'],
};

export async function startDemo(kind: DemoKind): Promise<void> {
    const [title, description] = descriptions[kind];
    const comparison = kind === 'compare' || kind === 'spatial', reactive = kind === 'transparency' || kind === 'reactive';
    document.title = title + ' — Babylon.js — Upscaler';
    document.body.innerHTML = `<header><a href="../#babylon">← Examples</a><span class="badge">BABYLON.JS · WEBGPU</span><h1>${title}</h1><p>${description}</p></header>
        <main><div class="viewport ${kind === 'canvas-alpha' ? 'transparent-stage' : ''}">${kind === 'canvas-alpha' ? '<div class="html-backdrop">HTML BEHIND THE CANVAS</div>' : ''}<canvas aria-label="${title} rendered scene"></canvas>${comparison ? `<div class="comparison-labels"><span>${kind === 'spatial' ? 'Spatial · EASU + RCAS' : 'Native · no AA'}</span><span id="right-label">Temporal</span></div>` : ''}</div>
        <div class="controls">
        <label>Reconstruction <select id="mode"><option value="temporal">Temporal</option><option value="bilinear">Bilinear (no history)</option></select></label>
        <label>Resolution <select id="ratio"><option value="1.5">Quality · 1.5×</option><option value="1">NativeAA · 1×</option><option value="1.7">Balanced · 1.7×</option><option value="2" selected>Performance · 2×</option><option value="3">Ultra performance · 3×</option></select></label>
        <label><input id="objects" type="checkbox" checked> Animate objects</label><label><input id="camera" type="checkbox"> Move camera</label>
        ${reactive ? '<label><input id="reactive" type="checkbox" checked> Reactive mask</label>' : ''}
        ${kind === 'reactive' ? '<label><input id="show-mask" type="checkbox"> Show mask</label>' : ''}
        ${kind === 'compose' ? '<label><input id="composition" type="checkbox" checked> Vignette</label><label>Strength <input id="vignette" aria-label="Vignette strength" type="range" min="0" max="1" step="0.05" value="0.8"></label>' : ''}
        ${kind === 'canvas-alpha' ? '<label>Page background <select id="backdrop"><option value="grid">Grid</option><option value="light">Light</option><option value="dark">Dark</option></select></label>' : ''}
        ${comparison ? '<label>Divider <input id="split" aria-label="Comparison divider" type="range" min="0" max="100" value="50"></label>' : ''}
        <button id="reset">Reset history</button></div>
        <p id="status" role="status">Preparing shaders…</p><p class="note">Babylon 9.29 · Single-sample inputs · Linear HDR accumulation · Reinhard display transform. ${comparison ? 'The comparison adds a second scene render; this is a visual comparison, not a performance benchmark.' : ''}</p></main>`;
    const status = document.querySelector('#status')!;
    if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a WebGPU-compatible browser and GPU.');
    const canvas = document.querySelector('canvas')!;
    const engine = new WebGPUEngine(canvas, { antialias: false, premultipliedAlpha: kind === 'canvas-alpha' }); await engine.initAsync();
    const scene = new Scene(engine), camera = new FreeCamera('camera', new Vector3(0, 3.8, -10.5), scene);
    scene.activeCamera = camera;
    const update = createSceneContent(scene, camera, kind); update(0, 0);
    const device = babylonWebGPU.getBabylonDevice(engine), errors: string[] = [];
    const report = (error: unknown) => { const message = String(error); errors.push(message); status.textContent = message; console.error(error); };
    device.addEventListener('uncapturederror', event => report(event.error.message));
    let presenter: BabylonScenePresenter | undefined, rebuilding = false, disposed = false, failed = false;
    let objectTime = 0, cameraTime = 0, frames = 0, ratio = 2, paused = false;
    const checked = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.checked ?? false;
    let rebuildChain = Promise.resolve();
    function resize(width?: number, height?: number, newRatio = ratio, optimize = true): Promise<void> {
        rebuilding = true;
        const next = rebuildChain.then(async () => {
            if (disposed) return;
            ratio = newRatio;
            (document.querySelector('#ratio') as HTMLSelectElement).value = String(ratio);
            const w = width ?? Math.max(1, canvas.clientWidth), h = height ?? Math.max(1, canvas.clientHeight);
            presenter?.dispose(); presenter = undefined;
            engine.setSize(w, h);
            status.textContent = 'Preparing shaders…';
            const candidate = new BabylonScenePresenter(engine, scene, camera, canvas, w, h, ratio, reactive, kind === 'compare', optimize, { spatialComparison: kind === 'spatial', composition: kind === 'compose', authoredReactive: kind === 'reactive', transparentCanvas: kind === 'canvas-alpha' });
            try { await candidate.prepare(); } catch (error) { candidate.dispose(); throw error; }
            if (disposed) { candidate.dispose(); return; }
            presenter = candidate;
        });
        rebuildChain = next.catch(error => { failed = true; report(error); });
        const settled = rebuildChain;
        void settled.finally(() => { if (rebuildChain === settled) rebuilding = false; });
        return next;
    }
    await resize();
    document.querySelector('#reset')!.addEventListener('click', () => presenter?.reset());
    document.querySelector('#backdrop')?.addEventListener('change', event => { (document.querySelector('.viewport') as HTMLElement).dataset.backdrop = (event.target as HTMLSelectElement).value; });
    document.querySelector('#ratio')!.addEventListener('change', event => { void resize(undefined, undefined, Number((event.target as HTMLSelectElement).value)).catch(() => {}); });
    let resizeTimer: ReturnType<typeof setTimeout>;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { void resize().catch(() => {}); }, 150); });
    engine.runRenderLoop(() => {
        if (!presenter || rebuilding || disposed || failed || paused) return;
        const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
        if (checked('objects')) objectTime += dt;
        if (checked('camera')) cameraTime += dt;
        update(objectTime, cameraTime);
        presenter.setMode((document.querySelector('#mode') as HTMLSelectElement).value === 'temporal');
        presenter.reactive = checked('reactive'); presenter.split = Number((document.querySelector('#split') as HTMLInputElement | null)?.value ?? 50) / 100;
        presenter.showReactive = checked('show-mask');
        if (presenter.composition) presenter.composition.vignette = checked('composition') ? Number((document.querySelector('#vignette') as HTMLInputElement).value) : 0;
        try { presenter.render(); frames++; } catch (error) { failed = true; report(error); return; }
        const c = presenter.config;
        status.textContent = `${c.renderWidth} × ${c.renderHeight} → ${c.displayWidth} × ${c.displayHeight} · ${presenter.upscale.disabled ? 'Bilinear' : 'Temporal'} · ${frames} frames`;
        const label = document.querySelector('#right-label'); if (label) label.textContent = presenter.upscale.disabled ? 'Bilinear' : 'Temporal';
    });
    const cleanup = () => { disposed = true; clearTimeout(resizeTimer); engine.stopRenderLoop(); presenter?.dispose(); scene.dispose(); engine.dispose(); };
    window.addEventListener('pagehide', cleanup, { once: true });
    void device.lost.then(info => { if (!disposed) { failed = true; report('GPU device lost: ' + info.message + '. Reload this page.'); } });
    Object.assign(window, { __BabylonSceneDemo: {
        errors, get frames() { return frames; }, pause(value: boolean) { paused = value; }, resize,
        reset() { presenter?.reset(); },
        async probe() {
            const current = presenter!;
            const [output, depth, motion, reactive, native, presented] = await Promise.all([current.output(), ...current.inputs(), current.native(), current.presented()].map(texture => readTexture(device, texture)));
            return { output, depth, motion, reactive, native, presented, config: current.config };
        },
    } });
}

export function showError(error: unknown): void {
    console.error(error);
    const status = document.querySelector('#status'); if (status) status.textContent = 'Unable to initialize: ' + String(error);
}
