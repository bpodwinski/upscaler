import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';

import { DebugView, UpscalePass } from '@pmndrs/upscaler';

import { bootRenderer, displaySize } from '../shared/boot';

//* Alpha through the temporal path.
//
// Example 14 shows a transparent canvas on the spatial path, because a path
// tracer publishes no motion vectors. This is the other half: a normal three
// scene with depth + velocity, so the temporal path runs and coverage is
// *reconstructed* rather than interpolated.
//
// Alpha rides the accumulate pass's own jitter-aware Lanczos taps and the same
// blend weight as color. Integrating that across jitter phases converges to a
// supersampled coverage estimate — sub-pixel silhouette detail the spatial path
// cannot produce, for the same reason FSR's temporal mode beats FSR1 on color.
// Flip the path toggle on the thin wires and watch their edges against the page.

const { renderer, dpr } = await bootRenderer({ alpha: true });
// Nothing behind the geometry is painted — the page is the backdrop.
renderer.setClearAlpha(0);

//* Scene — deliberately spindly. Thin, high-contrast geometry is where a
//* coverage mask is hardest and where reconstruction shows up most clearly.
const scene = new THREE.Scene();
scene.background = null;
const key = new THREE.DirectionalLight(0xffffff, 3.2);
key.position.set(5, 7, 4);
const rim = new THREE.DirectionalLight(0x88bbff, 1.4);
rim.position.set(-6, 2, -5);
scene.add(key, rim, new THREE.AmbientLight(0x8899bb, 0.9));

const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.15, 0.3, 260, 32),
    new THREE.MeshStandardMaterial({ color: 0xff7a3d, metalness: 0.35, roughness: 0.3 }),
);
scene.add(knot);

// A fan of thin bars at slightly different angles: sub-pixel coverage at 2x,
// so their alpha edges are pure reconstruction, not interpolation.
const wires = new THREE.Group();
const wireMaterial = new THREE.MeshStandardMaterial({
    color: 0x2fd4ff,
    metalness: 0.1,
    roughness: 0.5,
});
for (let i = 0; i < 7; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.032, 2.9, 0.032), wireMaterial);
    bar.position.set(2.5 + i * 0.26, -0.15, -0.9 + i * 0.28);
    bar.rotation.z = (i - 3) * 0.07;
    wires.add(bar);
}
scene.add(wires);

const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0.6, 1.6, 9.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(1.1, 0, 0);
controls.enableDamping = true;
controls.update();

//* Upscaler — UpscalePass presents RGBA on its own (its quad is
//* `transparent` + `NoBlending`), so nothing here has to hand-roll a present.
const pass = new UpscalePass(renderer);

const settings = {
    path: 'temporal' as 'temporal' | 'spatial',
    ratio: 2,
    sharpness: 0.8,
    debugView: DebugView.None,
    orbit: true,
    backdrop: 'grid',
};

function configure(): void {
    const { width, height } = displaySize(dpr);
    pass.configure({
        displayWidth: width,
        displayHeight: height,
        ratio: settings.ratio,
        path: settings.path,
    });
}
configure();

//* UI
const gui = new GUI({ title: 'transparent canvas' });
gui.add(settings, 'path', ['temporal', 'spatial'])
    .name('FSR path')
    .onChange(configure);
gui.add(settings, 'ratio', { '1.0x (native AA)': 1, '1.5x': 1.5, '2.0x': 2, '3.0x': 3 })
    .name('render ratio')
    .onChange(configure);
gui.add(settings, 'sharpness', 0, 1, 0.05).name('RCAS sharpness');
gui.add(settings, 'debugView', {
    Off: DebugView.None,
    'Motion vectors': DebugView.MotionVectors,
    Disocclusion: DebugView.Disocclusion,
    'Accumulation age': DebugView.AccumulationAge,
    Locks: DebugView.Locks,
}).name('debug view');
gui.add(settings, 'orbit').name('auto-orbit');
gui.add(settings, 'backdrop', ['grid', 'light', 'photo'])
    .name('page backdrop')
    .onChange((value: string) => {
        document.body.dataset.backdrop = value;
    });
document.body.dataset.backdrop = settings.backdrop;

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    configure();
});

const badge = document.getElementById('badge')!;

//* Loop
const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();

    knot.rotation.y = t * 0.55;
    knot.rotation.x = t * 0.3;
    if (settings.orbit) {
        camera.position.x = Math.sin(t * 0.18) * 9.5;
        camera.position.z = Math.cos(t * 0.18) * 9.5;
        camera.lookAt(controls.target);
    } else {
        controls.update();
    }

    pass.applySettings({ sharpness: settings.sharpness, debugView: settings.debugView });
    pass.renderScene(scene, camera, dt);

    const u = pass.upscaler;
    badge.innerHTML =
        `<b>@pmndrs/upscaler</b>  FSR3 ${settings.path} · transparent canvas\n` +
        `render   ${u.renderWidth}×${u.renderHeight}\n` +
        `display  ${u.displayWidth}×${u.displayHeight}  (${u.upscaleRatio.toFixed(1)}x)`;
});

// Handle for the headless CDP verification harness.
Object.assign(window, { __transparentCanvasExample: { renderer, pass, settings, configure } });
