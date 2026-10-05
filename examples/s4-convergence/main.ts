import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mrt, output, velocity } from 'three/tsl';
import GUI from 'lil-gui';

import { DebugView, Upscaler, generateJitterSequence, getJitterPhaseCount } from '@pmndrs/upscaler';

import { bootRenderer } from '../shared/boot';
import { drawJitterDiagram } from './jitterDiagram';
import { ConvergenceView, LAYERS, type LayerId, type LayerSources } from './layers';
import { STEPS } from './narration';
import { LAYOUT, buildScene, poseMover } from './scene';

//* S4 — Watch it converge.
// An explainer driven frame by frame on the real temporal pipeline: the raw
// `Upscaler` with our own render target (like examples 06/12 and the bench),
// so the jittered low-res input is a texture we can show next to the output,
// and every intermediate buffer comes from the published `upscaler.guides`.
// Paused by default: nothing advances except on a step, a play tick, or a
// camera drag — so the frame counter always equals the number of dispatched
// frames, and each one is a complete, ordinary frame of the pipeline.

// Fixed simulation step. Stepping must be deterministic (the object moves the
// same distance per frame), and the auto-exposure adaptation eases by
// deltaTime, so a real clock would make a paused-then-stepped frame differ.
const DT = 1 / 60;

const stage = document.getElementById('stage')!;
const { renderer, dpr } = await bootRenderer({ parent: stage });
// Tone mapping is applied per layer in layers.ts: color layers get the
// examples' ACES, data layers (age, locks…) are shown raw like debug.ts.
renderer.toneMapping = THREE.NoToneMapping;

const { scene, mover } = buildScene();

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
camera.position.copy(LAYOUT.cameraPosition);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(LAYOUT.cameraTarget);
// Left-drag slides the camera sideways (screen-space pan), right-drag orbits.
// A sideways move keeps every surface at the same view depth and only shifts
// near things against far ones, so disocclusion shows exactly what it is for:
// the slivers of wall uncovered beside each wire. (An orbit also changes view
// depth, which the cross-frame depth test reads as disocclusion too — see the
// narration's disocclusion step.) The wheel drives the magnifier instead.
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: null, RIGHT: THREE.MOUSE.ROTATE };
controls.screenSpacePanning = true;
controls.enableZoom = false;
controls.update();
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

//* Upscaler — raw driver, temporal path
const upscaler = new Upscaler({ renderer });
upscaler.init();
// Motion vectors must be jitter-free, or every frame's jitter reads as motion.
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);
// MRT output count must match the render target's attachment count (CLAUDE.md #7).
const sceneMrt = mrt({ output, velocity });

const state = {
    ratio: 2,
    playing: false,
    animate: true,
    magSpan: 28,
    magFollowsView: false,
};

let rt: THREE.RenderTarget | null = null;
let view: ConvergenceView | null = null;

//* Frame bookkeeping (the explainer's own, read back from public state)
let frame = 0;
let sinceReset = 0;
let simTime = 0;
let pendingSteps = 0;
let dirty = true;
// Jitters actually applied this cycle, oldest first — read from the camera's
// view offset between beginFrame/endFrame. The upscaler has no public accessor
// for the current jitter, but the offset it applies to the camera *is* it.
const trail: Array<[number, number]> = [];
let cycle: Array<[number, number]> = [];

function stageCssSize(): { w: number; h: number } {
    return { w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) };
}

function sources(): LayerSources {
    const guides = upscaler.guides;
    return {
        output: upscaler.outputTexture,
        input: rt!.textures[0],
        history: guides.history!,
        locks: guides.lockStatus!,
        exposure: guides.exposure!,
        motion: guides.dilatedMotion,
        disocclusion: guides.disocclusion,
        depth: guides.dilatedDepth,
    };
}

/** (Re)configures for the current stage size and ratio — drops all history. */
function configure(): void {
    const { w, h } = stageCssSize();
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();

    // The canvas backing store is floor(css · dpr); the display size must
    // equal it so one output texel is one canvas pixel.
    upscaler.configure({
        displayWidth: Math.floor(w * dpr),
        displayHeight: Math.floor(h * dpr),
        customUpscaleRatio: state.ratio,
        path: 'temporal',
    });

    rt?.dispose();
    const depthTexture = new THREE.DepthTexture(upscaler.renderWidth, upscaler.renderHeight);
    depthTexture.type = THREE.FloatType;
    rt = new THREE.RenderTarget(upscaler.renderWidth, upscaler.renderHeight, {
        count: 2,
        type: THREE.HalfFloatType,
        depthTexture,
    });
    // MRT routes node outputs to attachments by texture name (CLAUDE.md #1).
    rt.textures[0].name = 'output';
    rt.textures[1].name = 'velocity';

    if (!view) view = new ConvergenceView(sources());
    else view.setSources(sources());
    view.renderSize.value.set(upscaler.renderWidth, upscaler.renderHeight);
    view.displaySize.value.set(upscaler.displayWidth, upscaler.displayHeight);

    cycle = generateJitterSequence(getJitterPhaseCount(upscaler.upscaleRatio));
    markReset();
    layoutMagnifier();
}

// configure() and resetHistory() both restart the jitter sequence and drop
// history on the next dispatch; mirror that in the explainer's counters.
function markReset(): void {
    sinceReset = 0;
    trail.length = 0;
}

//* One Frame — the whole temporal recipe, exactly as an app runs it
function stepFrame(): void {
    if (state.animate) simTime += DT;
    poseMover(mover, simTime);

    upscaler.beginFrame(camera); // advances + applies the sub-pixel jitter
    const v = camera.view;
    const jitter: [number, number] = v?.enabled ? [v.offsetX, v.offsetY] : [0, 0];

    renderer.setMRT(sceneMrt);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setMRT(null);
    upscaler.endFrame(camera); // restores the camera's unjittered view

    upscaler.dispatch(
        { color: rt!.textures[0], depth: rt!.depthTexture!, velocity: rt!.textures[1], deltaTime: DT },
        camera,
    );

    frame++;
    sinceReset++;
    trail.push(jitter);
    if (trail.length > upscaler.jitterPhaseCount) trail.shift();

    // Ping-ponged guides flipped halves in that dispatch — re-point the reads.
    view!.setSources(sources());
    view!.jitter.value.set(jitter[0], jitter[1]);
    dirty = true;
}

function requestSteps(n: number): void {
    pendingSteps += n;
}

function resetHistory(): void {
    upscaler.resetHistory();
    markReset();
    pendingSteps = 0;
    requestSteps(1); // show the reset frame itself: age 1/max everywhere
}

//* UI — transport, stats, layers, narration
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statsEl = $('stats');
const layerNoteEl = $('layerNote');
const viewTagEl = $('viewTag');
const playBtn = $('btnPlay');
const jitterCanvas = $<HTMLCanvasElement>('jitter');

$('btnStep').addEventListener('click', () => requestSteps(1));
$('btnStep8').addEventListener('click', () => requestSteps(8));
$('btnReset').addEventListener('click', resetHistory);
playBtn.addEventListener('click', () => setPlaying(!state.playing));

function setPlaying(playing: boolean): void {
    state.playing = playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('on', playing);
    pendingSteps = 0;
}

let layerIndex = 0;
const layerButtons = LAYERS.map((layer, i) => {
    const button = document.createElement('button');
    button.textContent = layer.label;
    button.title = layer.note;
    button.addEventListener('click', () => setLayer(layer.id));
    $('layers').appendChild(button);
    return { button, i };
});

function setLayer(id: LayerId): void {
    layerIndex = LAYERS.findIndex((l) => l.id === id);
    for (const { button, i } of layerButtons) button.classList.toggle('on', i === layerIndex);
    const layer = LAYERS[layerIndex];
    layerNoteEl.textContent = layer.note;
    if (view) {
        view.layer.value = layerIndex;
        // The magnifier compares input against the output, unless asked to
        // follow the main view (then it zooms whatever data layer is shown).
        const follow = state.magFollowsView && id !== 'input';
        view.magLayer.value = follow ? layerIndex : 0;
        $('magOutputTag').textContent = follow ? `${layer.label.toLowerCase()} · display px` : 'output · display px';
    }
    dirty = true;
}

let stepIndex = -1;
const stepItems = STEPS.map((step, i) => {
    const li = document.createElement('li');
    const head = document.createElement('button');
    head.textContent = step.title;
    head.addEventListener('click', () => setStep(stepIndex === i ? -1 : i));
    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML =
        `<div class="where">${step.where} · view: ${LAYERS.find((l) => l.id === step.layer)!.label}</div>` +
        `${step.body}<div class="try">▸ ${step.tryIt}</div>`;
    li.append(head, body);
    $('steps').appendChild(li);
    return li;
});

function setStep(i: number): void {
    stepIndex = Math.max(-1, Math.min(STEPS.length - 1, i));
    stepItems.forEach((li, k) => li.classList.toggle('active', k === stepIndex));
    if (stepIndex >= 0) {
        setLayer(STEPS[stepIndex].layer);
        stepItems[stepIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}
$('btnPrev').addEventListener('click', () => setStep(Math.max(0, stepIndex - 1)));
$('btnNext').addEventListener('click', () => setStep(stepIndex + 1));

function fmt(n: number): string {
    return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(3);
}

function updateStats(): void {
    const n = upscaler.jitterPhaseCount;
    const [jx, jy] = trail[trail.length - 1] ?? [0, 0];
    const phase = sinceReset === 0 ? 0 : ((sinceReset - 1) % n) + 1;
    const maxAcc = upscaler.settings.maxAccumulation;
    statsEl.innerHTML =
        `frame        <b>${frame}</b>   (${sinceReset} since reset)\n` +
        `jitter phase <b>${phase} / ${n}</b>   (8·${upscaler.upscaleRatio}²)\n` +
        `offset       (${fmt(jx)}, ${fmt(jy)}) render px\n` +
        `age cap      ${Math.min(sinceReset, maxAcc)} / ${maxAcc} frames (maxAccumulation)\n` +
        `render       ${upscaler.renderWidth}×${upscaler.renderHeight}\n` +
        `display      ${upscaler.displayWidth}×${upscaler.displayHeight}  (${upscaler.upscaleRatio}×)\n` +
        `state        ${state.playing ? 'playing' : 'paused'}`;
    const layer = LAYERS[layerIndex];
    viewTagEl.innerHTML = `<b>${layer.label}</b>  ${layer.note}`;
}

function drawDiagram(): void {
    drawJitterDiagram(jitterCanvas, { ratio: upscaler.upscaleRatio, cycle, trail });
}

//* Magnifier — panels are DOM boxes; the shader fills their canvas rects
const magInputEl = $('magInput');
const magOutputEl = $('magOutput');
// Display-pixel focus; defaults to the Siemens star's center.
const magFocus = new THREE.Vector2(-1, -1);

function rectUv(el: HTMLElement): THREE.Vector4 {
    const c = renderer.domElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return new THREE.Vector4(
        (r.left - c.left + 1) / c.width,
        (r.top - c.top + 1) / c.height,
        (r.right - c.left - 1) / c.width,
        (r.bottom - c.top - 1) / c.height,
    );
}

function layoutMagnifier(): void {
    if (!view) return;
    view.magInputRect.value.copy(rectUv(magInputEl));
    view.magOutputRect.value.copy(rectUv(magOutputEl));
    if (magFocus.x < 0) focusWorld(LAYOUT.starCenter.clone().add(new THREE.Vector3(0.35, 0.35, 0)));
    setMagSpan(state.magSpan);
}

/** Centers the magnifier on a world-space point. */
function focusWorld(p: THREE.Vector3): void {
    camera.updateMatrixWorld(); // may run before the first render
    const ndc = p.clone().project(camera);
    magFocus.set(((ndc.x + 1) / 2) * upscaler.displayWidth, ((1 - ndc.y) / 2) * upscaler.displayHeight);
    view!.magCenter.value.copy(magFocus);
    dirty = true;
}

function setMagSpan(span: number): void {
    state.magSpan = Math.round(Math.min(160, Math.max(6, span)));
    view!.magSpan.value = state.magSpan;
    dirty = true;
}

//* Pointer — drag moves the camera (one frame per move), click moves the magnifier
controls.addEventListener('change', () => {
    // A camera move only exists once a frame renders it: while paused, each
    // drag update becomes exactly one pipeline frame.
    if (!state.playing && pendingSteps === 0) requestSteps(1);
});
let downAt: { x: number; y: number } | null = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
    if (e.button !== 0 || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    const c = renderer.domElement.getBoundingClientRect();
    magFocus.set(
        ((e.clientX - c.left) / c.width) * upscaler.displayWidth,
        ((e.clientY - c.top) / c.height) * upscaler.displayHeight,
    );
    view!.magCenter.value.copy(magFocus);
    dirty = true;
});
renderer.domElement.addEventListener(
    'wheel',
    (e) => {
        e.preventDefault();
        setMagSpan(state.magSpan * (e.deltaY > 0 ? 1.15 : 1 / 1.15));
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
    },
    { passive: false },
);

/** Slides the camera and its target sideways by `dx` world units, as one frame. */
function truck(dx: number): void {
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    camera.position.addScaledVector(right, dx);
    controls.target.addScaledVector(right, dx);
    controls.update(); // fires 'change' → one frame
}

/** Orbits the camera around its target by `deg` degrees, as one frame. */
function orbit(deg: number): void {
    const offset = camera.position.clone().sub(controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
    camera.position.copy(controls.target).add(offset);
    controls.update(); // fires 'change' → one frame
}

//* Settings — lil-gui
const gui = new GUI({ title: 'Scene, magnifier and pipeline', container: $('guiHost') });
gui.add(state, 'ratio', { '1× (native AA)': 1, '1.5×': 1.5, '2×': 2, '3×': 3, '4×': 4 })
    .name('upscale ratio')
    .onChange(() => {
        configure();
        requestSteps(1);
    });
gui.add(state, 'animate').name('object moves');
const motionActions = {
    truckLeft: () => truck(-0.15),
    truckRight: () => truck(0.15),
    orbitRight: () => orbit(1),
    home: () => {
        camera.position.copy(LAYOUT.cameraPosition);
        controls.target.copy(LAYOUT.cameraTarget);
        controls.update();
    },
};
gui.add(motionActions, 'truckLeft').name('◂ slide camera (one frame)');
gui.add(motionActions, 'truckRight').name('slide camera ▸ (one frame)');
gui.add(motionActions, 'orbitRight').name('orbit 1° ▸ (one frame)');
gui.add(motionActions, 'home').name('camera home');
const magFolder = gui.addFolder('Magnifier');
magFolder.add(state, 'magSpan', 6, 160, 1).name('span (display px)').onChange(setMagSpan);
magFolder
    .add(state, 'magFollowsView')
    .name('right panel follows view')
    .onChange(() => setLayer(LAYERS[layerIndex].id));
const pipeFolder = gui.addFolder('Pipeline (applies next frame)');
pipeFolder.add(upscaler.settings, 'lockThinFeatures').name('locks');
pipeFolder.add(upscaler.settings, 'detectShadingChanges').name('shading change');
pipeFolder.add(upscaler.settings, 'autoExposure').name('auto exposure');
pipeFolder.add(upscaler.settings, 'maxAccumulation', 1, 64, 1).name('max accumulation').onChange(() => (dirty = true));
pipeFolder.add(upscaler.settings, 'sharpness', 0, 1, 0.05).name('RCAS sharpness');
pipeFolder.close();

//* Keyboard
window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        requestSteps(e.shiftKey ? 8 : 1);
    } else if (e.key === 'p' || e.key === 'P') {
        setPlaying(!state.playing);
    } else if (e.key === 'r' || e.key === 'R') {
        resetHistory();
    } else if (e.key === ']') {
        setStep(stepIndex + 1);
    } else if (e.key === '[') {
        setStep(Math.max(0, stepIndex - 1));
    } else if (e.key === 'v' || e.key === 'V') {
        setLayer(LAYERS[(layerIndex + 1) % LAYERS.length].id);
    }
});

let resizeQueued = false;
new ResizeObserver(() => {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(() => {
        resizeQueued = false;
        const { w, h } = stageCssSize();
        if (Math.floor(w * dpr) === upscaler.displayWidth && Math.floor(h * dpr) === upscaler.displayHeight) {
            layoutMagnifier();
            return;
        }
        // A new display size means new textures — history starts over.
        configure();
        requestSteps(1);
    });
}).observe(stage);

//* Boot — render frame 1 of a fresh history, then wait
configure();
setLayer('output');
requestSteps(1);

renderer.setAnimationLoop(() => {
    // At most one pipeline frame per animation frame: three's velocity node
    // rolls its previous-camera matrices once per renderer frame, so two scene
    // renders in one tick would see a stale previous camera.
    if (state.playing || pendingSteps > 0) {
        stepFrame();
        if (!state.playing) pendingSteps--;
    }
    // The present is one quad — redraw it every tick (a WebGPU canvas is not
    // guaranteed to keep its last frame), but only rebuild the DOM on change.
    view!.render(renderer);
    if (dirty) {
        dirty = false;
        updateStats();
        drawDiagram();
    }
});

//* Harness handle — the headless GPU verification drives the page through this
Object.assign(window as unknown as Record<string, unknown>, {
    __s4: {
        upscaler,
        renderer,
        camera,
        controls,
        get view() {
            return view;
        },
        step: (n = 1) => requestSteps(n),
        reset: resetHistory,
        setLayer,
        setStep,
        setPlaying,
        orbit,
        truck,
        setRatio: (r: number) => {
            state.ratio = r;
            configure();
            requestSteps(1);
        },
        setAnimate: (on: boolean) => (state.animate = on),
        /** Idle once every requested frame has been dispatched and presented. */
        idle: () => pendingSteps === 0 && !dirty,
        info: () => ({
            frame,
            sinceReset,
            phaseCount: upscaler.jitterPhaseCount,
            trail: trail.slice(),
            cycle: cycle.slice(),
            render: [upscaler.renderWidth, upscaler.renderHeight],
            display: [upscaler.displayWidth, upscaler.displayHeight],
        }),
        // Cross-check for the TSL layers: route the library's own debug pass
        // into the output texture (it takes effect on the next frame).
        libraryDebug: (mode: DebugView) => {
            upscaler.settings.debugView = mode;
            view!.outputIsData.value = mode === DebugView.None ? 0 : 1;
        },
        DebugView,
    },
});
