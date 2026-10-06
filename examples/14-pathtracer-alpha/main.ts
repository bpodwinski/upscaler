import { prepareComputeAction } from '../shared/prepareComputeAction';
import * as THREE from 'three/webgpu';
import { texture } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { BlurredEnvMapGenerator, WebGPUPathTracer } from 'three-gpu-pathtracer/webgpu';
import GUI from 'lil-gui';

import { Upscaler } from '@pmndrs/upscaler';

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

//* Upscaler — spatial (FSR1: EASU + RCAS), no history, no motion vectors.
const upscaler = new Upscaler({ renderer });

//* Path tracer — sized by us, not by the canvas.
// `synchronizeRenderSize` and `dynamicLowRes` both resize the accumulation
// target behind our back (the latter drops to a quarter while the camera
// moves); the upscaler is configured for one fixed render size, so both are
// off and `setSize` is driven from the upscaler's own render resolution.
status.textContent = 'preparing path-tracer resources…';
const pathTracer = await prepareComputeAction(renderer, () => new WebGPUPathTracer(renderer));
pathTracer.synchronizeRenderSize = false;
pathTracer.dynamicLowRes = false;
pathTracer.renderDelay = 0;
pathTracer.minSamples = 0;
// Upstream's default: clamps the glossy lobe so specular fireflies do not
// stay in the running average for thousands of samples.
pathTracer.filterGlossyFactor = 1;
await prepareComputeAction(renderer, () => pathTracer.setScene(scene, camera));

//* Present — the upscaled RGBA, blended over the page.
// `transparent` puts the quad on three's blended pass with premultiplied
// output; the canvas is in 'premultiplied' alpha mode, so the upscaled color
// reaches the compositor as-is.
const presentMaterial = new THREE.NodeMaterial();
presentMaterial.depthTest = false;
presentMaterial.depthWrite = false;
presentMaterial.fog = false;
presentMaterial.transparent = true;
const presentQuad = new THREE.QuadMesh(presentMaterial);

const settings = {
    ratio: 2,
    sharpness: 0.8,
    upscale: true,
    bounces: 5,
};
pathTracer.maxBounces = settings.bounces;

function configure(): void {
    const { width, height } = displaySize(dpr);
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        customUpscaleRatio: settings.ratio,
        path: 'spatial',
    });
    // The path tracer accumulates at exactly the upscaler's input resolution.
    pathTracer.setSize(upscaler.renderWidth, upscaler.renderHeight);
    // configure() allocates a fresh output texture whenever the size changes,
    // so the present node has to be re-pointed at it, not just left alone.
    presentMaterial.colorNode = texture(upscaler.outputTexture);
    presentMaterial.needsUpdate = true;
}
await prepareComputeAction(renderer, configure);

let pendingPreparations = 0;
let preparation = Promise.resolve();
function schedulePreparation(action: () => void): void {
    pendingPreparations++;
    controls.enabled = false;
    status.textContent = 'preparing path-tracer shaders…';
    preparation = preparation.then(() => prepareComputeAction(renderer, () => {
        action();
        pathTracer.renderSample();
    })).then(() => { pathTracer.reset(); }).catch(error => {
        console.error(error);
        showFatal('Could not prepare the path tracer: ' + String(error));
    }).finally(() => {
        pendingPreparations--;
        if (!pendingPreparations) { controls.enabled = true; status.textContent = ''; }
    });
}

//* UI
const gui = new GUI({ title: 'pathtracer + alpha' });
gui.add(settings, 'upscale')
    .name('FSR1 upscale')
    .onChange(() => pathTracer.reset());
gui.add(settings, 'ratio', { '1.0x (native)': 1, '1.5x': 1.5, '2.0x': 2, '3.0x': 3 })
    .name('render ratio')
    .onChange(() => {
        schedulePreparation(configure);
    });
gui.add(settings, 'sharpness', 0, 1, 0.05).name('RCAS sharpness');
gui.add(settings, 'bounces', 1, 10, 1)
    .name('bounces')
    .onChange((value: number) => {
        pathTracer.maxBounces = value;
    });
gui.add({ pageStyle: switchPageStyle }, 'pageStyle').name('cycle page backdrop');

const BACKDROPS = ['grid', 'photo', 'text'];
let backdropIndex = 0;
function switchPageStyle(): void {
    backdropIndex = (backdropIndex + 1) % BACKDROPS.length;
    document.body.dataset.backdrop = BACKDROPS[backdropIndex];
}

controls.addEventListener('change', () => pathTracer.updateCamera());

window.addEventListener('resize', () => {
    schedulePreparation(() => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        configure();
    });
});

//* Loop
let frames = 0;
// Handle for the headless CDP harness (see the alpha verification in
// bench/docs) — and a convenient console entry point when driving by hand.
Object.assign(window, {
    __pathtracerAlphaExample: { renderer, upscaler, pathTracer, settings, camera, configure },
    __pathtracerAlphaFrames: () => frames,
});

status.textContent = 'compiling path-tracer shaders…';
await Promise.all([upscaler.init()]);
await prepareComputeAction(renderer, () => pathTracer.renderSample());
pathTracer.reset();

renderer.setAnimationLoop(() => {
    if (pendingPreparations || !upscaler.isReady) return;
    controls.update();
    upscaler.settings.sharpness = settings.sharpness;

    // Accumulates one sample and blits it to the canvas; the present below
    // overdraws that blit whenever the upscaler is driving.
    pathTracer.renderSample();

    const traced = pathTracer.target;
    if (settings.upscale && traced) {
        upscaler.dispatch({ color: traced }, camera);
        presentQuad.render(renderer);
    }

    frames++;
    status.textContent = '';
    badge.innerHTML =
        `<b>@pmndrs/upscaler</b>  FSR1 spatial · transparent canvas\n` +
        `path trace  ${upscaler.renderWidth}×${upscaler.renderHeight}\n` +
        `display     ${upscaler.displayWidth}×${upscaler.displayHeight}  ` +
        `(${upscaler.upscaleRatio.toFixed(1)}x)\n` +
        `presenting  ${settings.upscale ? 'upscaled RGBA' : 'path tracer blit'}`;
});
