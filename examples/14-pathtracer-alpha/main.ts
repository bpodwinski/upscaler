import { prepareComputeAction } from '../shared/prepareComputeAction';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { BlurredEnvMapGenerator, WebGPUPathTracer, FSRUpscaler } from 'three-gpu-pathtracer/webgpu';
import GUI from 'lil-gui';

import { Upscaler, getRenderResolution } from '@pmndrs/upscaler';

import { bootRenderer, displaySize, showFatal } from '../shared/boot';

//* Alpha survives the upscale.
//
// The canvas is transparent and sits over ordinary page content. A path
// tracer (three-gpu-pathtracer's WebGPU renderer) accumulates the scene at a
// fraction of the display resolution with a zero-alpha background, and the
// FSR1 spatial path upscales that RGBA buffer to full size — coverage
// included. The page shows through exactly where the path tracer left the
// buffer transparent, at display resolution rather than render resolution.
//
// This is the spatial path deliberately: a path tracer publishes no motion
// vectors or depth, so there is nothing for the temporal path to reproject.
// It accumulates its own samples over time instead.

// Pinned to a commit, not a branch. These are someone else's demo assets and
// they get re-published: this model was re-compressed from meshopt to Draco on
// 2026-08-25, which broke the branch URL mid-development. A commit URL is
// immutable, so the example keeps working (and keeps needing exactly one
// decoder) no matter what upstream does next.
const ASSET_BASE =
    'https://raw.githubusercontent.com/gkjohnson/3d-demo-data/fc47d954ae97389fe324573cd4602a5894d9c0c1';
const ENV_URL = `${ASSET_BASE}/hdri/chinese_garden_1k.hdr`;
// NASA's Perseverance rover: a deliberately spindly silhouette (masts, arms,
// antenna wire) so the coverage the upscaler has to reconstruct is not just a
// smooth blob outline.
const MODEL_URL = `${ASSET_BASE}/models/nasa-m2020/Perseverance.glb`;
// Google's versioned decoder build, pinned for the same reason as the assets.
const DRACO_DECODER_URL = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

const status = document.getElementById('status')!;
const badge = document.getElementById('badge')!;

document.body.dataset.backdrop = 'grid';

const { renderer, dpr } = await bootRenderer({ alpha: true });
// Nothing behind the model should be painted — the page is the backdrop.
renderer.setClearAlpha(0);

//* Scene — model only. `background = null` is what makes the path tracer's
//* background samples inherit the renderer's (zero) clear alpha.
const scene = new THREE.Scene();
scene.background = null;

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 500);
const controls = new OrbitControls(camera, renderer.domElement);

status.textContent = 'loading environment + model…';
// The pinned GLB is Draco + WebP; meshopt is wired too because the rest of this
// demo-data set still uses it, so re-pointing MODEL_URL at another model needs
// no code change. Both decoders are inert until a file actually asks for them.
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath(DRACO_DECODER_URL);
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);
gltfLoader.setMeshoptDecoder(MeshoptDecoder);
let gltf: { scene: THREE.Object3D };
let envTexture: THREE.DataTexture;
try {
    [gltf, envTexture] = await Promise.all([
        gltfLoader.loadAsync(MODEL_URL),
        new HDRLoader().loadAsync(ENV_URL),
    ]);
} catch (error) {
    // Say what actually failed. An earlier version blamed the network for every
    // error, which sent a decoder-configuration bug (a re-compressed upstream
    // model) chasing a connectivity problem that did not exist.
    console.error(error);
    showFatal(
        `Could not load the demo assets: ${error instanceof Error ? error.message : String(error)}\n\n` +
            'This example streams its model and HDRI from raw.githubusercontent.com ' +
            'and the Draco decoder from gstatic.com, so it needs network access.',
    );
    throw error;
}
dracoLoader.dispose();

envTexture.mapping = THREE.EquirectangularReflectionMapping;
// Pre-blur the environment. An unblurred HDRI's small bright sky leaves
// long-lived specular fireflies on the rover's metal (this was written when
// multiple-importance sampling was still a stub on the WebGPU renderer), and
// this demo is about coverage, not caustics.
const envGenerator = new BlurredEnvMapGenerator(renderer);
const blurredEnv = await envGenerator.generate(envTexture, 0.35);
envGenerator.dispose();
envTexture.dispose();
// Lights the scene without ever being visible: no `scene.background`, so every
// ray that escapes returns the clear color at clear alpha (0).
scene.environment = blurredEnv;
scene.add(gltf.scene);

//* Frame the model from its own bounds — the demo data is not unit-scaled.
const bounds = new THREE.Box3().setFromObject(gltf.scene);
const center = bounds.getCenter(new THREE.Vector3());
const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
camera.position.copy(center).add(new THREE.Vector3(0.9, 0.35, 1.4).setLength(radius * 2.1));
camera.near = radius / 100;
camera.far = radius * 100;
camera.updateProjectionMatrix();
controls.target.copy(center);
controls.update();

//* Optional upscaler — supplied by the application, owned by the path tracer.
const settings = { ratio: 2, sharpness: 0.8, upscale: true, bounces: 5 };
let upscaler: Upscaler | null = null;
const getUpscaler = (): Upscaler | null => upscaler;

// The optional adapter's init() is synchronous. Seed a spatial configuration
// before it starts our async init, and retain the driver so the host can await it.
class PathTracerSpatialUpscaler extends Upscaler {
    constructor(options: ConstructorParameters<typeof Upscaler>[0]) {
        super(options);
        const { width, height } = displaySize(dpr);
        this.configure({ displayWidth: width, displayHeight: height,
            customUpscaleRatio: settings.ratio, path: 'spatial' });
        // The optional adapter has no public readiness handle; retain the injected driver.
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        upscaler = this;
    }
    override init(): Promise<void> {
        const ready = super.init();
        // FSRUpscaler does not await the result; the host awaits this driver below.
        void ready.catch(() => {});
        return ready;
    }
}

status.textContent = 'preparing path-tracer resources…';
const pathTracer = await prepareComputeAction(renderer, () => new WebGPUPathTracer(renderer));
pathTracer.synchronizeRenderSize = false;
pathTracer.dynamicLowRes = false;
pathTracer.renderDelay = 0;
pathTracer.minSamples = 0;
pathTracer.filterGlossyFactor = 1;
pathTracer.maxBounces = settings.bounces;
await prepareComputeAction(renderer, () => pathTracer.setScene(scene, camera));

const fsr = new FSRUpscaler({ Upscaler: PathTracerSpatialUpscaler, sharpness: settings.sharpness });
let attached = false;
function updateUpscaler(): void {
    fsr.sharpness = settings.sharpness;
    if (settings.upscale === attached) return;
    pathTracer.setUpscaler(settings.upscale ? fsr : null);
    attached = settings.upscale;
    if (!attached) { fsr.dispose(); upscaler = null; }
}
function configure(): void {
    const { width, height } = displaySize(dpr);
    const render = getRenderResolution(width, height, settings.ratio);
    pathTracer.setSize(render.width, render.height);
    upscaler?.configure({ displayWidth: width, displayHeight: height,
        renderWidth: render.width, renderHeight: render.height, path: 'spatial' });
}
await prepareComputeAction(renderer, () => { updateUpscaler(); configure(); });
await getUpscaler()?.init();

let pendingPreparations = 0;
let preparation = Promise.resolve();
function schedulePreparation(action: () => void): void {
    pendingPreparations++;
    controls.enabled = false;
    status.textContent = 'preparing path-tracer shaders…';
    preparation = preparation.then(async () => {
        await prepareComputeAction(renderer, action);
        await getUpscaler()?.init();
        await prepareComputeAction(renderer, () => pathTracer.renderSample());
        pathTracer.reset();
    }).catch(error => {
        console.error(error);
        showFatal('Could not prepare the path tracer: ' + String(error));
    }).finally(() => {
        pendingPreparations--;
        if (!pendingPreparations) { controls.enabled = true; status.textContent = ''; }
    });
}

//* UI
const gui = new GUI({ title: 'pathtracer + optional FSR' });
gui.add(settings, 'upscale').name('FSR1 upscale').onChange(() => schedulePreparation(updateUpscaler));
gui.add(settings, 'ratio', { '1.0x (native)': 1, '1.5x': 1.5, '2.0x': 2, '3.0x': 3 })
    .name('render ratio').onChange(() => schedulePreparation(configure));
gui.add(settings, 'sharpness', 0, 1, 0.05).name('RCAS sharpness');
gui.add(settings, 'bounces', 1, 10, 1).name('bounces')
    .onChange((value: number) => schedulePreparation(() => { pathTracer.maxBounces = value; }));
gui.add({ pageStyle: switchPageStyle }, 'pageStyle').name('cycle page backdrop');
const BACKDROPS = ['grid', 'photo', 'text'];
let backdropIndex = 0;
function switchPageStyle(): void {
    backdropIndex = (backdropIndex + 1) % BACKDROPS.length;
    document.body.dataset.backdrop = BACKDROPS[backdropIndex];
}
controls.addEventListener('change', () => { if (!pendingPreparations) pathTracer.updateCamera(); });
window.addEventListener('resize', () => schedulePreparation(() => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
}));

let frames = 0;
Object.assign(window, {
    __pathtracerAlphaExample: {
        renderer, pathTracer, settings, camera, configure,
        get upscaler() { return upscaler; },
        get optionalUpscaler() { return attached ? fsr : null; },
        setUpscale(value: boolean) { settings.upscale = value; schedulePreparation(updateUpscaler); },
        setBounces(value: number) { settings.bounces = value; schedulePreparation(() => { pathTracer.maxBounces = value; }); },
        ready: () => !pendingPreparations && (!attached || Boolean(upscaler?.isReady)),
    },
    __pathtracerAlphaFrames: () => frames,
});
status.textContent = 'compiling path-tracer shaders…';
await prepareComputeAction(renderer, () => pathTracer.renderSample());
pathTracer.reset();
renderer.setAnimationLoop(() => {
    if (pendingPreparations || (attached && !upscaler?.isReady)) return;
    controls.update();
    fsr.sharpness = settings.sharpness;
    pathTracer.renderSample(); // traces, optionally upscales, and presents once
    frames++;
    status.textContent = '';
    const { width, height } = displaySize(dpr);
    const render = getRenderResolution(width, height, settings.ratio);
    badge.innerHTML =
        '<b>@pmndrs/upscaler</b>  optional FSR1 · transparent canvas\n' +
        'path trace  ' + render.width + '×' + render.height + '\n' +
        'display     ' + renderer.domElement.width + '×' + renderer.domElement.height + '  (' + settings.ratio.toFixed(1) + 'x)\n' +
        'presenting  ' + (attached ? 'path tracer + FSRUpscaler' : 'path tracer blit');
});
let pageDisposed = false;
window.addEventListener('pagehide', event => {
    if (event.persisted || pageDisposed) return;
    pageDisposed = true;
    renderer.setAnimationLoop(null);
    controls.dispose();
    if (!attached) fsr.dispose();
    pathTracer.dispose(); // owns and disposes the attached optional FSR adapter
    blurredEnv.dispose();
    renderer.dispose();
});
