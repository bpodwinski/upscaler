import * as THREE from 'three/webgpu';
import {
    color,
    float,
    frameId,
    hash,
    materialColor,
    pass,
    screenCoordinate,
    texture,
    uniform,
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { upscaleSpatial, type Upscaler } from '@pmndrs/upscaler';

import { bootRenderer, displaySize } from '../shared/boot';
import { addStudioLighting, createGridTexture } from '../shared/props';
import { addRenderScale, basePercent } from '../shared/ui';

//* upscaleSpatial() — the color-only node.
// Some inputs carry no depth or motion: a path tracer, a video, a buffer some
// other renderer filled. There is nothing to reproject, so the temporal
// upscale() has nothing to work with. upscaleSpatial(color) runs the
// single-frame FSR1 path instead (EASU edge-aware upscale, then RCAS
// sharpening) as an ordinary RenderPipeline output node. It keeps no history,
// so it can't reconstruct detail the input doesn't have.
//
// Two ways to feed it, switchable below:
//   - pass()     the scene rendered in-graph at 1/ratio. The node registers it
//                as a graph dependency, so three renders it inside the pipeline.
//   - texture()  a half-float render target this loop fills itself, outside
//                the pipeline. This is the case the node exists for: any
//                texture you already have, wrapped in texture().
//
// The neon bars are HDR (well above 1.0). RCAS sharpens in conditioned
// tonemap space (#30), so the edges of the bars sharpen like everything else
// instead of passing through soft. The grain slider adds per-pixel noise at
// render resolution, the kind of input `rcasDenoise` is for.

const { renderer, dpr } = await bootRenderer();

const state = {
    source: 'pass' as 'pass' | 'texture',
    ratio: 2.0,
    sharpness: 0.8,
    rcasDenoise: false,
    highlight: 6,
    grain: 0,
    orbit: true,
};

//* Uniforms the GUI drives without a graph rebuild.
const highlight = uniform(state.highlight);
const grainAmount = uniform(state.grain);

// Per-pixel, per-frame noise in [-0.5, 0.5). screenCoordinate is in render
// pixels, so the grain sits at input resolution, where a noisy renderer's would.
const pixelSeed = screenCoordinate.x.add(screenCoordinate.y.mul(4099)).add(frameId.mul(7919));
const noise = hash(pixelSeed).sub(0.5);
const grainy = (base: typeof materialColor) => base.mul(float(1).add(noise.mul(grainAmount).mul(2)));

//* Scene — fine grid lines, a glossy knot, and thin HDR neon bars.
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07090d);
addStudioLighting(scene);

const floorMaterial = new THREE.MeshStandardNodeMaterial({
    map: createGridTexture(12),
    roughness: 0.85,
});
floorMaterial.colorNode = grainy(materialColor);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), floorMaterial);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const knotMaterial = new THREE.MeshStandardNodeMaterial({
    color: 0xc0c8d8,
    metalness: 0.9,
    roughness: 0.22,
});
knotMaterial.colorNode = grainy(materialColor);
const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28), knotMaterial);
knot.position.y = 2.2;
scene.add(knot);

// Unlit, so the stored value is exactly color × highlight: the default 6 puts
// the brightest channel well past 1.0.
const neonColors = [0xff4fa3, 0x4fd8ff, 0xffc04f];
const neonMaterials = neonColors.map((hex) => {
    const material = new THREE.MeshBasicNodeMaterial();
    material.colorNode = color(hex).mul(highlight);
    return material;
});
const barGeometry = new THREE.BoxGeometry(0.05, 3.2, 0.05);
for (let i = 0; i < 15; i++) {
    const bar = new THREE.Mesh(barGeometry, neonMaterials[i % neonMaterials.length]);
    bar.position.set(-4.2 + i * 0.6, 1.6, -2.5);
    scene.add(bar);
}
const ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.03, 12, 160), neonMaterials[1]);
ring.position.set(0, 2.2, 0);
ring.rotation.x = Math.PI / 2;
scene.add(ring);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6.5, 4, 8.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.8, 0);
controls.enableDamping = true;
controls.autoRotate = state.orbit;
controls.autoRotateSpeed = 0.5;

//* The pipeline — rebuilt when the source or render scale changes.
const pipeline = new THREE.RenderPipeline(renderer);
// The external source: a half-float target (keeps the > 1.0 highlights) that
// the loop renders into before the pipeline runs. Rendering into your own
// target writes linear color; the pipeline applies tone mapping on output.
const externalTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType });
let spatialNode: ReturnType<typeof upscaleSpatial> | null = null;

function configure(): void {
    const ratio = state.ratio;
    let input;
    if (state.source === 'pass') {
        const scenePass = pass(scene, camera);
        scenePass.setResolutionScale(1 / ratio);
        input = scenePass.getTextureNode('output');
    } else {
        const { width, height } = displaySize(dpr);
        // Floor, like pass().setResolutionScale(), so both sources match in size.
        externalTarget.setSize(
            Math.max(1, Math.floor(width / ratio)),
            Math.max(1, Math.floor(height / ratio)),
        );
        input = texture(externalTarget.texture);
    }

    spatialNode?.dispose();
    // `ratio` only seeds the first configure; the node then sizes itself from
    // the input texture it actually receives.
    spatialNode = upscaleSpatial(input, { ratio, gpuTiming: true });
    pipeline.outputNode = spatialNode;
    pipeline.needsUpdate = true;
}
configure();

const upscaler = (): Upscaler | null =>
    spatialNode?.upscaler ?? null;

const gui = new GUI({ title: 'upscaleSpatial()' });
gui.add(state, 'source', { 'pass() in-graph': 'pass', 'texture() external': 'texture' })
    .name('input')
    .onChange(configure);
addRenderScale(gui, state, configure);
gui.add(state, 'sharpness', 0, 1, 0.01).name('RCAS sharpness');
gui.add(state, 'rcasDenoise').name('RCAS denoise');
gui.add(state, 'highlight', 0.5, 40, 0.5)
    .name('neon intensity')
    .onChange((v: number) => (highlight.value = v));
gui.add(state, 'grain', 0, 0.5, 0.01)
    .name('input grain')
    .onChange((v: number) => (grainAmount.value = v));
gui.add(state, 'orbit').onChange((v: boolean) => (controls.autoRotate = v));

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

const hud = document.getElementById('hud')!;
function updateHud(): void {
    const u = upscaler();
    const rcasMs = u?.gpuTimings.get('rcas');
    hud.innerHTML =
        `<b>@pmndrs/upscaler</b>  upscaleSpatial() node\n` +
        `pipeline.outputNode = upscaleSpatial(color)\n` +
        `input     ${state.source === 'pass' ? 'pass() in-graph' : 'texture() external RT'}\n` +
        `sharpen   ${state.sharpness.toFixed(2)}${state.rcasDenoise ? ' + denoise' : ''}\n` +
        `neon      ${state.highlight.toFixed(1)}× (HDR)\n` +
        (u
            ? `render    ${u.renderWidth}×${u.renderHeight}  (${basePercent(u.upscaleRatio)})\n` +
              `display   ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(2)}x)` +
              (rcasMs !== undefined ? `\nrcas      ${rcasMs.toFixed(3)} ms` : '')
            : '');
}

// Handles for the headless GPU check (CDP): drive the real GUI controllers.
(window as unknown as { __spatialExample: unknown }).__spatialExample = { gui, state, upscaler };

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    controls.update();

    const u = upscaler();
    if (u) {
        u.settings.sharpness = state.sharpness;
        u.settings.rcasDenoise = state.rcasDenoise;
    }

    if (state.source === 'texture') {
        renderer.setRenderTarget(externalTarget);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
    }
    pipeline.render();
    updateHud();
});
