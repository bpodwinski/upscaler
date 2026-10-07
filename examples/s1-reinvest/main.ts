import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    abs,
    diffuseColor,
    metalness,
    mix,
    mrt,
    normalView,
    output,
    pass,
    roughness,
    smoothstep,
    step,
    texture,
    uniform,
    uv,
    vec4,
    velocity,
} from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { denoise } from 'three/addons/tsl/display/DenoiseNode.js';
import GUI from 'lil-gui';

import { Upscaler } from '@ruxelion/upscaler';

import { displaySize, showFatal } from '../shared/boot';
import { addRenderScale } from '../shared/ui';
import { matchPassResolution } from '../shared/matchPassResolution';
import { createCourtyard, setSconceCount } from './scene';
import { GpuMeter } from './GpuMeter';
import { MeasureCycle, type Measured } from './measure';

//* S1 — "Reinvest the savings". The same GPU, the same scene, the same instant,
//* spent two ways and wiped by the mouse:
//*
//*   A (left)   render at 1/ratio → SSGI + SSR → FSR3 temporal upscale
//*   B (right)  render every display pixel, plain forward lighting, no effects
//*
//* and — the point — what each side measurably costs on this GPU. Side A follows
//* the 06 pattern (a TSL pass graph rendered into a reduced-res color target,
//* upscaled by the raw `Upscaler`) with 09's SSGI + SSR composite and its SSGI
//* recipe: `useTemporalFiltering = false` + DenoiseNode on the static pattern,
//* no TRAA, so FSR3 stays the only temporal resolver. Side B is one
//* `renderer.render()` into a display-res target. Both are presented by one
//* composite quad through the renderer's ACES + sRGB output, so the wipe
//* compares like with like.

//* Renderer — the shared boot, plus `trackTimestamp`. The examples' shared
//* bootRenderer() doesn't take that option, and it has to be set at
//* construction (three only requests per-pass timestamp writes when it's on).
async function bootTimedRenderer(): Promise<{ renderer: THREE.WebGPURenderer; dpr: number }> {
    if (!navigator.gpu) {
        showFatal('WebGPU is not available in this browser — try Chrome/Edge 113+.');
        throw new Error('WebGPU unavailable');
    }
    const dpr = Math.min(window.devicePixelRatio, 2);
    const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
    renderer.setPixelRatio(dpr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    document.body.appendChild(renderer.domElement);
    await renderer.init();
    if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) {
        showFatal('three fell back to the WebGL backend — this showcase needs real WebGPU.');
        throw new Error('WebGL fallback active');
    }
    return { renderer, dpr };
}

const { renderer, dpr } = await bootTimedRenderer();
renderer.shadowMap.enabled = true;

const { scene, spinner, sconces } = createCourtyard();

// The meter is the renderer's inspector: three tells it about every render
// pass (with its timestamp uid) before encoding it.
const meter = new GpuMeter(scene);
renderer.inspector = meter;
const cycle = new MeasureCycle(meter);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 120);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 2.4, -3);
controls.enableDamping = true;
// Keep a hand-driven camera inside the courtyard walls and above the floor.
controls.minDistance = 4;
controls.maxDistance = 11.5;
controls.minPolarAngle = 0.6;
controls.maxPolarAngle = 1.5;

//* Auto-orbit: a slow sweep across the south half rather than a full circle,
//* which would park the camera behind the colonnade facing a wall.
const orbit = { t: 0, radius: 11.5, height: 6.4, center: 0.38, swing: 0.5 };
function placeOrbitCamera(): void {
    const a = orbit.center + Math.sin(orbit.t * 0.12) * orbit.swing;
    const tgt = controls.target;
    camera.position.set(tgt.x + Math.sin(a) * orbit.radius, orbit.height, tgt.z + Math.cos(a) * orbit.radius);
    camera.lookAt(tgt);
}
placeOrbitCamera();

//* Side A — the raw upscaler (this example drives the passes itself).
const upscaler = new Upscaler({ renderer });
upscaler.settings.rcasDenoise = true; // the reduced-res effects are noisy
// Motion vectors must be jitter-free. Side B renders without an MRT, so the
// global velocity node is A's alone (see 03's note on sharing it).
velocity.setProjectionMatrix(upscaler.unjitteredProjectionMatrix);

function quadMaterial(): THREE.NodeMaterial {
    const m = new THREE.NodeMaterial();
    m.depthTest = false;
    m.depthWrite = false;
    m.fog = false;
    return m;
}
// Renders A's effect graph into its reduced-res color target.
const effectsMat = quadMaterial();
const effectsQuad = new THREE.QuadMesh(effectsMat);

//* Composite present quad — wipe between A's upscaled output and B's native target.
const split = uniform(0.5);
const uvNode = uv();
// Placeholders until configure() creates the real targets (it re-points both,
// and runs before the first render builds this material).
const aTex = texture(new THREE.Texture(), uvNode);
const bTex = texture(new THREE.Texture(), uvNode);
const isLeft = step(uvNode.x, split); // 1 on side A
const line = smoothstep(0.0015, 0.0, abs(uvNode.x.sub(split)));
const presentMat = quadMaterial();
presentMat.colorNode = mix(mix(bTex, aTex, isLeft), vec4(0.49, 0.83, 0.99, 1), line);
const presentQuad = new THREE.QuadMesh(presentMat);

const state = {
    ratio: 2.0,
    lights: 32,
    ssgi: true,
    ssr: true,
    autoOrbit: true,
    autoBalance: () => void autoBalance(),
    remeasure: () => remeasure(),
};

let colorRT: THREE.RenderTarget | null = null;
let nativeRT: THREE.RenderTarget | null = null;
let scenePass: ReturnType<typeof pass> | null = null;

// three's addon effect nodes are typed as their concrete class, which doesn't
// expose the swizzle / getTextureNode proxy members TSL adds at runtime — cast
// through the swizzle-capable node object type (same shim as 06/09).
const sw = (n: unknown) => n as ReturnType<typeof vec4>;
const texNode = (n: unknown) => (n as { getTextureNode(): unknown }).getTextureNode();

/** (Re)builds both sides for the current window size, render scale, and effects. */
function configure(): void {
    const { width, height } = displaySize(dpr);
    upscaler.configure({
        displayWidth: width,
        displayHeight: height,
        customUpscaleRatio: state.ratio,
        path: 'temporal',
    });
    const rw = upscaler.renderWidth;
    const rh = upscaler.renderHeight;

    //* Side B target — every display pixel.
    nativeRT?.dispose();
    nativeRT = new THREE.RenderTarget(width, height, { type: THREE.HalfFloatType });
    nativeRT.texture.name = 'native';

    //* Side A — reduced-res color target the composite renders into.
    colorRT?.dispose();
    colorRT = new THREE.RenderTarget(rw, rh, { type: THREE.HalfFloatType, depthBuffer: false });
    colorRT.texture.name = 'reinvest-color';

    //* G-buffer at 1/ratio. WebGPU caps color-attachment bytes/sample at 32 =
    //* four RGBA16Float targets, so the material scalars ride in alpha:
    //* roughness in normal.a, metalness in diffuse.a (09's packing).
    scenePass = pass(scene, camera);
    scenePass.setMRT(
        mrt({
            output,
            velocity,
            normal: vec4(normalView, roughness),
            diffuse: vec4(diffuseColor.rgb, metalness),
        }),
    );
    scenePass.setResolutionScale(1 / state.ratio);

    const beauty = scenePass.getTextureNode('output');
    const depth = scenePass.getTextureNode('depth');
    const normal = scenePass.getTextureNode('normal');
    const diffuseTex = scenePass.getTextureNode('diffuse');

    let rgb = beauty.rgb;
    if (state.ssgi) {
        const giPass = ssgi(beauty, depth, normal, camera);
        // SSGI's rotating temporal pattern needs a real TRAA; under FSR3 it
        // ghost-streaks off moving silhouettes. Static pattern + DenoiseNode is
        // three's documented no-TRAA recipe (see CLAUDE.md, examples 06/09).
        giPass.useTemporalFiltering = false;
        // Default intensity (10) washes the pale props out in sunlight.
        giPass.giIntensity.value = 4;
        // At render resolution: a half-res trace is cheaper but doubles the
        // size of SSGI's static sampling pattern, which then survives the
        // upscale as visible crosshatch. Fewer steps (8, from 12) instead.
        matchPassResolution(giPass, scenePass);
        giPass.stepCount.value = 8;
        const ao = sw(giPass.getAONode());
        const gi = sw(denoise(giPass.getGINode() as never, depth, normal, camera));
        // beauty · AO  +  albedo · indirect bounce
        rgb = beauty.rgb.mul(ao.r).add(diffuseTex.rgb.mul(gi.rgb));
    }
    if (state.ssr) {
        const ssrNode = ssr(beauty, depth, normal as never, {
            metalnessNode: diffuseTex.a,
            roughnessNode: normal.a,
            camera,
        });
        // Long enough to reach across the courtyard from the floor.
        const ssrUniforms = ssrNode as unknown as { maxDistance: { value: number }; quality: { value: number } };
        ssrUniforms.maxDistance.value = 14;
        ssrUniforms.quality.value = 0.4; // 26 march steps; the blur hides the rest
        matchPassResolution(ssrNode, scenePass);
        const refl = sw(denoise(texNode(ssrNode) as never, depth, normal, camera));
        rgb = rgb.add(refl.rgb);
    }
    effectsMat.colorNode = vec4(rgb, beauty.a);
    effectsMat.needsUpdate = true;

    aTex.value = upscaler.outputTexture;
    bTex.value = nativeRT.texture;
    presentMat.needsUpdate = true;

    upscaler.resetHistory();
    updateLabels();
}

//* Labels + HUD.
const labA = document.getElementById('labA')!;
const labB = document.getElementById('labB')!;
const hud = document.getElementById('hud')!;

const mp = (w: number, h: number) => `${((w * h) / 1e6).toFixed(2)} MP`;

function updateLabels(): void {
    const fx = [state.ssgi && 'SSGI', state.ssr && 'SSR'].filter(Boolean).join(' + ') || 'no effects';
    labA.innerHTML =
        `◄ <b>A · upscaled + effects</b><br>` +
        `${upscaler.renderWidth}×${upscaler.renderHeight} → ${upscaler.displayWidth}×${upscaler.displayHeight} · ${fx} · FSR3 ×${state.ratio.toFixed(2)}`;
    labB.innerHTML =
        `<b>B · native, plain</b> ►<br>` +
        `${upscaler.displayWidth}×${upscaler.displayHeight} · forward lighting · no effects`;
}

let measured: Measured | null = null;
let measuredRatio = state.ratio;
let balanceNote = '';
let balancing = false;

const fmt = (ms: number | null) => (ms === null ? '  n/a' : ms.toFixed(2).padStart(5));

/** Inline stacked bar, segment widths in ms against a shared scale. */
function bar(segments: Array<[number | null, string]>, scale: number): string {
    return segments
        .map(([ms, color]) =>
            ms === null || scale <= 0
                ? ''
                : `<span class="seg" style="width:${(ms / scale) * 100}%;background:${color}"></span>`,
        )
        .join('');
}

function updateHud(): void {
    const w = upscaler.displayWidth;
    const h = upscaler.displayHeight;
    const rw = upscaler.renderWidth;
    const rh = upscaler.renderHeight;
    const share = Math.round(((rw * rh) / (w * h)) * 100);
    let body = '';

    const why = meter.unsupportedReason;
    if (why) {
        body =
            `<div class="na">GPU timings: n/a — ${why}, so per-pass GPU time can't be ` +
            `measured (and a CPU frame timer can't split two sides drawn in one frame). ` +
            `Pixel counts are exact.</div>`;
    }
    const m = measured;
    const scale = m ? Math.max(m.aTotal ?? 0, m.b ?? 0) : 0;
    const verdict =
        m && m.aTotal !== null && m.b !== null
            ? m.aTotal <= m.b
                ? `<span class="good">A costs ${((m.aTotal / m.b) * 100).toFixed(0)}% of B</span> — effects + upscale fit in native's budget`
                : `<span class="bad">A costs ${((m.aTotal / m.b) * 100).toFixed(0)}% of B</span> — over native's budget at ×${measuredRatio.toFixed(2)}`
            : '';
    const stale = m && measuredRatio !== state.ratio ? ` <span class="dim">(measured at ×${measuredRatio.toFixed(2)})</span>` : '';

    body +=
        `<div class="cols">` +
        `<div class="col"><div class="h a">◄ A · upscaled + effects</div>` +
        `render   ${rw}×${rh}  ${mp(rw, rh)} (${share}%)\n` +
        `scene    ${fmt(m?.aScene ?? null)} ms\n` +
        `effects  ${fmt(m?.aEffects ?? null)} ms\n` +
        `upscale  ${fmt(m?.aUpscale ?? null)} ms\n` +
        `<b>total    ${fmt(m?.aTotal ?? null)} ms</b>` +
        `<div class="bar">${m ? bar([[m.aScene, '#38bdf8'], [m.aEffects, '#a78bfa'], [m.aUpscale, '#f472b6']], scale) : ''}</div></div>` +
        `<div class="col"><div class="h">B · native, plain ►</div>` +
        `render   ${w}×${h}  ${mp(w, h)} (100%)\n` +
        `scene    ${fmt(m?.b ?? null)} ms\n\n\n` +
        `<b>total    ${fmt(m?.b ?? null)} ms</b>` +
        `<div class="bar">${m ? bar([[m.b, '#94a3b8']], scale) : ''}</div></div>` +
        `</div>` +
        `<div class="foot">` +
        (cycle.busy
            ? `<span class="busy">${cycle.status}…</span>`
            : m
              ? `${verdict}${stale}`
              : why
                ? 'GPU time: n/a'
                : 'waiting for the first measurement…') +
        (balanceNote ? `\n${balanceNote}` : '') +
        `\n<span class="dim">GPU ms per frame, each side timed alone (` +
        `${m ? `${m.framesA}+${m.framesB}` : '–'} frames, 10%-trimmed mean) · shared composite ` +
        `${fmt(m?.present ?? null).trim()} ms not in either total</span></div>`;
    hud.innerHTML = body;
}

//* Measuring.

/** Runs a full A + B cycle at the current settings and shows the result. */
function remeasure(): void {
    // Without timestamps there's nothing to time — the HUD says why.
    if (balancing || meter.unsupportedReason) return;
    const ratio = state.ratio;
    void cycle.run({ sides: 'both', frames: 60, label: 'measuring' }).then((m) => {
        measured = m;
        measuredRatio = ratio;
    });
}

/**
 * Searches the render scale for the highest-quality (lowest) ratio at which
 * side A's GPU time fits inside side B's, bisecting [1, 3] to a 0.05 step.
 * Every probe times BOTH sides (alternating blocks) and decides on their ratio,
 * so a GPU whose clocks or load drift between probes can't skew the answer the
 * way a single up-front B budget would. Assumes A's cost falls as the ratio
 * rises — true for everything A does per pixel. The HUD then shows the probe
 * that decided it.
 */
async function autoBalance(): Promise<void> {
    if (balancing || meter.unsupportedReason) return;
    balancing = true;
    balanceCtrl.disable();
    remeasureCtrl.disable();
    const probes = new Map<number, Measured>();
    try {
        const fits = async (ratio: number): Promise<boolean> => {
            state.ratio = ratio;
            ratioCtrl.updateDisplay();
            configure();
            const m = await cycle.run({ sides: 'both', frames: 40, label: `auto-balance · probing ×${ratio.toFixed(2)}` });
            if (m.aTotal === null || m.b === null) throw new Error('no timings');
            probes.set(ratio, m);
            balanceNote = `<span class="dim">probe ×${ratio.toFixed(2)}: A ${m.aTotal.toFixed(2)} ms vs B ${m.b.toFixed(2)} ms</span>`;
            return m.aTotal <= m.b;
        };

        let lo = 1.0;
        let hi = 3.0;
        let result: number;
        if (!(await fits(hi))) {
            result = hi;
            balanceNote = `<span class="bad">auto-balance: even ×3.00 costs more than native here</span>`;
        } else if (await fits(lo)) {
            result = lo;
            balanceNote = `<span class="good">auto-balance: A fits at ×1.00 — effects + upscale cost no more than native</span>`;
        } else {
            // Invariant: A(lo) > B, A(hi) <= B.
            while (hi - lo > 0.05 + 1e-6) {
                const mid = Math.round(((lo + hi) / 2) * 20) / 20;
                if (mid <= lo || mid >= hi) break;
                if (await fits(mid)) hi = mid;
                else lo = mid;
            }
            result = hi;
            balanceNote =
                `<span class="good">auto-balance: ×${hi.toFixed(2)} is the finest render scale that fits</span>` +
                `<span class="dim"> (×${lo.toFixed(2)} didn't)</span>`;
        }
        state.ratio = result;
        ratioCtrl.updateDisplay();
        configure();
        measured = probes.get(result) ?? measured;
        measuredRatio = result;
    } catch (err) {
        balanceNote = `<span class="bad">auto-balance failed: ${(err as Error).message}</span>`;
    } finally {
        balancing = false;
        balanceCtrl.enable();
        remeasureCtrl.enable();
    }
}

/** Rebuild + re-time after any change that affects cost. */
function reconfigureAndMeasure(): void {
    if (balancing) return;
    configure();
    balanceNote = '';
    remeasure();
}

//* Controls.
const gui = new GUI({ title: 'Reinvest the savings' });
addRenderScale(gui, state, reconfigureAndMeasure);
const ratioCtrl = gui.controllers[gui.controllers.length - 1];
gui.add(state, 'lights', 0, sconces.length, 1)
    .name('scene lights (A + B)')
    .onChange(() => {
        setSconceCount(sconces, state.lights);
        reconfigureAndMeasure();
    });
gui.add(state, 'ssgi').name('A: SSGI (indirect)').onChange(reconfigureAndMeasure);
gui.add(state, 'ssr').name('A: SSR (reflections)').onChange(reconfigureAndMeasure);
const orbitCtrl = gui.add(state, 'autoOrbit').name('camera auto-orbit');
// Grabbing the camera hands it to OrbitControls.
controls.addEventListener('start', () => {
    state.autoOrbit = false;
    orbitCtrl.updateDisplay();
});
const remeasureCtrl = gui.add(state, 'remeasure').name('re-measure GPU time');
const balanceCtrl = gui.add(state, 'autoBalance').name('auto-balance (A ≤ B)');

window.addEventListener('pointermove', (e) => {
    // Don't wipe while the pointer is over the panel or HUD.
    if ((e.target as HTMLElement).closest('.lil-gui, #hud')) return;
    split.value = e.clientX / window.innerWidth;
});
window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    reconfigureAndMeasure();
});

setSconceCount(sconces, state.lights);
configure();
remeasure();

/** True once three has created the GPU texture behind a three Texture. */
function isBacked(tex: THREE.Texture | null | undefined): boolean {
    if (!tex) return false;
    const backend = renderer.backend as unknown as { get(t: THREE.Texture): { texture?: unknown } | undefined };
    return backend.get(tex)?.texture !== undefined;
}

//* Loop.
const timer = new THREE.Timer();
let hudClock = 0;
await Promise.all([upscaler.init()]);

renderer.setAnimationLoop(() => {
    if (!upscaler.isReady) return;
    timer.update();
    const dt = Math.min(timer.getDelta(), 0.1);
    const { sides, tag } = cycle.frame();

    // Frozen while a measurement runs, so the side that isn't being redrawn
    // still shows the same instant as the one that is.
    if (!cycle.frozen) {
        if (state.autoOrbit) {
            orbit.t += dt;
            placeOrbitCamera();
        } else {
            controls.update();
        }
        spinner.rotation.y += dt * 0.5;
        spinner.rotation.x += dt * 0.2;
    }

    meter.beginFrame(tag);

    //* Side B — one plain render at display resolution.
    if (sides !== 'a' && nativeRT) {
        meter.owner = 'b';
        renderer.setRenderTarget(nativeRT);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
    }

    //* Side A — reduced-res scene + effects (jittered), then the upscale.
    if (sides !== 'b' && colorRT && scenePass) {
        meter.owner = 'a';
        upscaler.beginFrame(camera);
        renderer.setRenderTarget(colorRT);
        effectsQuad.render(renderer); // pulls the G-buffer pass + effects in-graph
        renderer.setRenderTarget(null);
        upscaler.endFrame(camera);

        const depthTex = scenePass.renderTarget.depthTexture;
        const velocityTex = scenePass.getTexture('velocity');
        // The pass graph compiles asynchronously; feed FSR3 once it's backed.
        if (isBacked(colorRT.texture) && isBacked(depthTex) && isBacked(velocityTex)) {
            upscaler.dispatch(
                { color: colorRT.texture, depth: depthTex ?? undefined, velocity: velocityTex, deltaTime: dt },
                camera,
            );
        }
    }

    //* Present — the shared composite.
    meter.owner = 'present';
    presentQuad.render(renderer);
    meter.endFrame();
    cycle.advance();

    hudClock += dt;
    if (hudClock > 0.2) {
        hudClock = 0;
        updateHud();
    }
});

// Handle for the headless verification harness (CDP).
Object.assign(window, {
    __s1: {
        state,
        split,
        orbit,
        upscaler,
        meter,
        get measured() {
            return measured;
        },
        get busy() {
            return cycle.busy || balancing;
        },
        remeasure,
        autoBalance,
        setRatio(r: number) {
            state.ratio = r;
            ratioCtrl.updateDisplay();
            reconfigureAndMeasure();
        },
        setLights(n: number) {
            state.lights = n;
            setSconceCount(sconces, n);
            gui.controllersRecursive().forEach((c) => c.updateDisplay());
            reconfigureAndMeasure();
        },
        setEffects(ssgiOn: boolean, ssrOn: boolean) {
            state.ssgi = ssgiOn;
            state.ssr = ssrOn;
            gui.controllersRecursive().forEach((c) => c.updateDisplay());
            reconfigureAndMeasure();
        },
    },
});
