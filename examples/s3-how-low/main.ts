import * as THREE from 'three/webgpu';
import { abs, mix, smoothstep, step, texture, uniform, uv, vec4 } from 'three/tsl';
import GUI from 'lil-gui';

import { bootRenderer, displaySize } from '../shared/boot';
import { UpscalePresenter } from '../shared/UpscalePresenter';
import { Loupe } from './Loupe';
import { buildHowLowScene } from './scene';

//* "How low can you go": one slider drags the render resolution from native
//* down to 1/8 per axis (1.6% of the pixels) while the output stays at display
//* resolution. The wipe compares FSR temporal against plain bilinear from the
//* SAME render resolution — so what you see on the left beyond the right is
//* reconstruction (jitter + accumulation), not just "a bigger render". Native
//* is available as the reference, and a nearest-neighbour loupe shows both
//* sides of the wipe at the same spot, pixel for pixel.

/** Upper end of the slider. The library has no clamp; 8× (1.6% of the pixels) is past where it holds up — on purpose. */
const MAX_RATIO = 8;

const { renderer, dpr } = await bootRenderer();
renderer.shadowMap.enabled = true;

const { scene, wheel, focus } = buildHowLowScene();
const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 120);

//* Three producers sharing one renderer. Only FSR needs motion vectors, so it
//* alone owns the global velocity projection (see 03-split-compare).
const fsr = new UpscalePresenter(renderer, { shareVelocityMatrix: true });
const bilinear = new UpscalePresenter(renderer, { shareVelocityMatrix: false });
const native = new UpscalePresenter(renderer, { shareVelocityMatrix: false });

type SourceKey = 'fsr' | 'bilinear' | 'native';
const SOURCES: Record<SourceKey, { presenter: UpscalePresenter; name: string }> = {
    fsr: { presenter: fsr, name: 'FSR temporal' },
    bilinear: { presenter: bilinear, name: 'bilinear' },
    native: { presenter: native, name: 'native' },
};
const MODES: Record<string, [SourceKey, SourceKey]> = {
    'FSR ◄► bilinear': ['fsr', 'bilinear'],
    'FSR ◄► native': ['fsr', 'native'],
    'bilinear ◄► native': ['bilinear', 'native'],
};

const state = {
    ratio: 4,
    mode: 'FSR ◄► bilinear',
    loupe: true,
    // CSS px per display pixel: on a DPR-2 screen 2 is already a 4× enlargement.
    zoom: dpr >= 2 ? 2 : 4,
    autoOrbit: true,
    orbitSpeed: 1,
};

/** Display-resolution pixel size of the canvas. */
let display = displaySize(dpr);
/** Frames since the FSR history was last reset (reconfigure). */
let framesSinceReset = 0;

//* Configuration — FSR and bilinear follow the slider; native only the window.

/** (Re)builds the two producers that render at the slider's resolution; resets FSR history. */
function configureScaled(): void {
    const base = { displayWidth: display.width, displayHeight: display.height, ratio: state.ratio };
    fsr.configure({ ...base, path: 'temporal' });
    bilinear.configure({ ...base, path: 'bilinear' });
    framesSinceReset = 0;
}

/** (Re)builds the native reference (display resolution, no upscale). */
function configureNative(): void {
    native.configure({ displayWidth: display.width, displayHeight: display.height, path: 'bilinear', ratio: 1 });
}

configureScaled();
configureNative();

//* Composite present — wipe between the mode's two sources, loupe on top.
const split = uniform(0.5);
const uvNode = uv();
const leftTex = texture(fsr.outputTexture, uvNode);
const rightTex = texture(bilinear.outputTexture, uvNode);
const line = smoothstep(0.0015, 0.0, abs(uvNode.x.sub(split)));
const wiped = mix(mix(rightTex, leftTex, step(uvNode.x, split)), vec4(0.49, 0.83, 0.99, 1), line);

const loupe = new Loupe([fsr.outputTexture, bilinear.outputTexture], {
    labels: ['FSR temporal', 'bilinear'],
    dpr,
    zoom: state.zoom,
    panelSize: 240,
});
loupe.setDisplaySize(display.width, display.height);

const compositeMat = new THREE.NodeMaterial();
compositeMat.depthTest = false;
compositeMat.depthWrite = false;
compositeMat.fog = false;
compositeMat.colorNode = loupe.wrap(wiped);
const compositeQuad = new THREE.QuadMesh(compositeMat);

const labLeft = document.getElementById('labLeft')!;
const labRight = document.getElementById('labRight')!;

/** Re-points the composite + loupe at the current mode's (possibly recreated) outputs. */
function rebind(): void {
    const [l, r] = MODES[state.mode].map((k) => SOURCES[k]);
    leftTex.value = l.presenter.outputTexture;
    rightTex.value = r.presenter.outputTexture;
    const res = (s: (typeof SOURCES)[SourceKey]): string =>
        `${s.presenter.upscaler.renderWidth}×${s.presenter.upscaler.renderHeight}`;
    labLeft.textContent = `◄ ${l.name} · ${res(l)}`;
    labRight.textContent = `${r.name} · ${res(r)} ►`;
    loupe.setTextures([l.presenter.outputTexture, r.presenter.outputTexture], [l.name, r.name]);
    compositeMat.needsUpdate = true;
    updateReadout();
}

/** FSR's history went stale while it wasn't drawn — start it clean, like a cut. */
function onModeChange(): void {
    fsr.upscaler.resetHistory();
    framesSinceReset = 0;
    rebind();
}

//* The scale slider — log-mapped, so each octave of resolution gets equal travel.

const scaleInput = document.getElementById('scale') as HTMLInputElement;
const ticks = document.getElementById('ticks')!;
const readout = document.getElementById('readout')!;
const hint = document.getElementById('hint')!;

const sliderToRatio = (v: number): number => MAX_RATIO ** (v / 1000);
const ratioToSlider = (r: number): number => (Math.log(r) / Math.log(MAX_RATIO)) * 1000;

/** Named stops: familiar render heights that fit under this display, plus the 8× floor. */
function buildTicks(): void {
    ticks.textContent = '';
    const stops: Array<{ label: string; ratio: number }> = [{ label: `native`, ratio: 1 }];
    for (const h of [1440, 1080, 720, 540, 360, 270, 180, 135]) {
        const r = display.height / h;
        if (r > 1.2 && r < MAX_RATIO * 0.93) stops.push({ label: `${h}p`, ratio: r });
    }
    stops.push({ label: `${Math.floor(display.height / MAX_RATIO)}p`, ratio: MAX_RATIO });
    // Drop stops that would sit on top of each other on a narrow bar.
    const minGap = 52 / ticks.clientWidth;
    let lastPos = -1;
    for (const stop of stops) {
        const pos = ratioToSlider(stop.ratio) / 1000;
        if (pos - lastPos < minGap && stop.ratio !== MAX_RATIO) continue;
        lastPos = pos;
        const button = document.createElement('button');
        button.textContent = stop.label;
        button.style.left = `${pos * 100}%`;
        button.dataset.ratio = String(stop.ratio);
        button.addEventListener('click', () => setRatio(stop.ratio, true));
        ticks.appendChild(button);
    }
}

/** Formats a percentage with enough digits to stay meaningful below 2%. */
function percent(fraction: number): string {
    const p = fraction * 100;
    return p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2);
}

/** Render/display size, pixel share and jitter facts for the current ratio. */
function updateReadout(): void {
    const u = fsr.upscaler;
    const rendered = (u.renderWidth * u.renderHeight) / (u.displayWidth * u.displayHeight);
    const phases = u.jitterPhaseCount;
    readout.innerHTML =
        `<span class="big">${u.renderWidth}×${u.renderHeight}</span>` +
        `<span class="dim">→ ${u.displayWidth}×${u.displayHeight} (${u.upscaleRatio.toFixed(2)}× per axis)</span>` +
        `<span class="pct">rendering ${percent(rendered)}% of the pixels</span>` +
        `<span class="dim">jitter cycle ${phases} frames · history window ${u.settings.maxAccumulation} frames</span>`;
    for (const b of ticks.querySelectorAll('button'))
        b.classList.toggle('on', Math.abs(Number((b as HTMLElement).dataset.ratio) - state.ratio) < 0.02);
}

// Reconfiguring reallocates every target and resets history, so coalesce a
// slider drag to a few rebuilds per second; the final value always lands.
let pendingConfigure = false;
let lastConfigure = 0;

/**
 * Sets the render scale.
 * @param ratio - Upscale ratio per axis (1 = native)
 * @param immediate - Rebuild now instead of on the next throttled frame
 */
function setRatio(ratio: number, immediate = false): void {
    state.ratio = Math.min(MAX_RATIO, Math.max(1, ratio));
    scaleInput.value = String(Math.round(ratioToSlider(state.ratio)));
    ratioController.updateDisplay();
    pendingConfigure = true;
    if (immediate) flushConfigure();
}

/** Applies a pending ratio change (rebuild + rebind). */
function flushConfigure(): void {
    if (!pendingConfigure) return;
    pendingConfigure = false;
    lastConfigure = performance.now();
    configureScaled();
    rebind();
}

scaleInput.addEventListener('input', () => setRatio(sliderToRatio(Number(scaleInput.value))));
scaleInput.addEventListener('change', () => setRatio(sliderToRatio(Number(scaleInput.value)), true));

// Measured on this scene (1600×900, see the PR): keep it honest.
hint.innerHTML =
    'move the mouse to wipe · drag the loupe<br>' +
    'Moving, it holds to about 3× (fine print still reads); at 4× small text smears, and at 6–8× ' +
    'thin wires vanish and only big shapes survive. Paused, FSR settles within about a second — ' +
    'its 24-frame history, not the long jitter cycle, sets the pace — and wires and fences come ' +
    'back (shimmering faintly at 8×), but letters under ~4 render pixels tall never do.';

//* Controls.
const gui = new GUI({ title: 'How low can you go' });
const ratioController = gui
    .add(state, 'ratio', 1, MAX_RATIO, 0.01)
    .name('render scale ×')
    .onChange((r: number) => setRatio(r))
    .onFinishChange((r: number) => setRatio(r, true));
gui.add(state, 'mode', Object.keys(MODES)).name('compare').onChange(onModeChange);
const loupeFolder = gui.addFolder('Loupe');
loupeFolder
    .add(state, 'loupe')
    .name('show')
    .onChange((on: boolean) => {
        loupe.enabled = on;
    });
loupeFolder
    .add(state, 'zoom', [1, 2, 3, 4, 6, 8])
    .name('zoom (px per pixel)')
    .onChange((z: number) => {
        loupe.zoom = Number(z);
    });
const motion = gui.addFolder('Motion');
motion.add(state, 'autoOrbit').name('auto-orbit');
motion.add(state, 'orbitSpeed', 0.25, 3, 0.05).name('orbit speed');
// On a phone the panel would cover the labels and the loupe; start it folded.
if (window.innerWidth < 640) gui.close();

//* Pointer: the wipe follows the mouse, except over UI or while the loupe drags.
let loupeDragging = false;
loupe.onDragChange = (dragging) => {
    loupeDragging = dragging;
};
window.addEventListener('pointermove', (e) => {
    if (loupeDragging) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('.lil-gui, #scalebar')) return;
    split.value = e.clientX / window.innerWidth;
});

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    display = displaySize(dpr);
    configureScaled();
    configureNative();
    loupe.setDisplaySize(display.width, display.height);
    buildTicks();
    rebind();
});

buildTicks();
setRatio(state.ratio, true);

//* Camera — a slow pendulum orbit that keeps the chart in view. Time only
//* advances while the orbit runs, so pausing freezes the whole scene (camera
//* and wheel) and the temporal history converges on a truly still image.
let t = 0;

function placeCamera(): void {
    const az = 0.62 * Math.sin(t * 0.11);
    const radius = 9.2 - 1.2 * Math.sin(t * 0.07);
    camera.position.set(
        focus.x + Math.sin(az) * radius,
        focus.y + 0.7 + 0.5 * Math.sin(t * 0.17),
        focus.z + Math.cos(az) * radius,
    );
    camera.lookAt(focus);
    wheel.rotation.z = t * 0.35;
}

//* Loop — draw the non-jittered producers first, then FSR (which jitters the
//* camera internally and restores it in endFrame).
const timer = new THREE.Timer();
await Promise.all([fsr.init(), bilinear.init(), native.init()]);

renderer.setAnimationLoop(() => {
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    if (pendingConfigure && performance.now() - lastConfigure > 120) flushConfigure();
    if (state.autoOrbit) t += dt * state.orbitSpeed;
    placeCamera();

    const [l, r] = MODES[state.mode];
    for (const key of ['native', 'bilinear', 'fsr'] as const) {
        if (key === l || key === r) SOURCES[key].presenter.draw(scene, camera, dt);
    }
    compositeQuad.render(renderer);

    if (l === 'fsr') framesSinceReset++;
});

//* Headless-verification hooks (CDP harness) — read-only handles + setters.
Object.assign(window, {
    __howLowExample: {
        THREE,
        renderer,
        scene,
        camera,
        fsr,
        bilinear,
        native,
        loupe,
        state,
        setRatio,
        setMode: (mode: string) => {
            state.mode = mode;
            gui.controllersRecursive().forEach((c) => c.updateDisplay());
            onModeChange();
        },
        setTime: (time: number) => {
            t = time;
        },
        setSplit: (x: number) => {
            split.value = x;
        },
        get framesSinceReset() {
            return framesSinceReset;
        },
    },
});
