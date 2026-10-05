import * as THREE from 'three/webgpu';

import { addStudioLighting, createGridFloor } from '../shared/props';

//* Convergence scene — procedural, no network assets.
// Built so every debug view has something to say: a resolution chart (a
// Siemens star + line-pair bars, finer than a render pixel at 2×) for detail
// that only jitter can recover, thin wires for locks, flat swatches and a
// matte pedestal for quiet areas where age should simply whiten, and one
// moving object whose wake disoccludes the chart behind it.

/** Where things sit, shared with main.ts for camera framing and the magnifier's default focus. */
export const LAYOUT = {
    wallZ: -2,
    wallCenter: new THREE.Vector3(0, 3, -2),
    wallSize: new THREE.Vector2(12, 6),
    /** World position of the Siemens star's center (on the wall plane). */
    starCenter: new THREE.Vector3(-3, 3, -1.99),
    cameraPosition: new THREE.Vector3(0.6, 2.9, 12.5),
    cameraTarget: new THREE.Vector3(0.6, 2.5, 0),
};

/** The scene plus the one animated object. */
export interface ConvergenceScene {
    scene: THREE.Scene;
    /** The moving object; {@link poseMover} places it for a given simulation time. */
    mover: THREE.Mesh;
}

/**
 * Builds the convergence scene.
 *
 * @returns The scene and its moving object
 */
export function buildScene(): ConvergenceScene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);
    addStudioLighting(scene);
    scene.add(createGridFloor(10));

    //* Resolution-chart wall
    const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(LAYOUT.wallSize.x, LAYOUT.wallSize.y),
        new THREE.MeshStandardMaterial({ map: createChartTexture(), roughness: 0.95 }),
    );
    wall.position.copy(LAYOUT.wallCenter);
    scene.add(wall);

    //* Thin wires in front of the wall
    // ~0.02 world units across at ~11 units away is well under one render pixel
    // at 2× — the jitter only catches them on some phases, which is exactly what
    // the luminance locks exist to protect.
    const wireMat = new THREE.MeshStandardMaterial({ color: 0xe6ecf5, metalness: 0.6, roughness: 0.3 });
    const wireGeo = new THREE.CylinderGeometry(0.011, 0.011, 1, 6);
    const wires = new THREE.Group();
    for (let i = 0; i < 9; i++) {
        const wire = new THREE.Mesh(wireGeo, wireMat);
        wire.scale.y = 5.2;
        wire.position.set(1.1 + i * 0.42, 2.6, 0.4);
        wires.add(wire);
    }
    // Two diagonals and a rail, so locks also form on slanted thin lines.
    for (const tilt of [0.55, -0.55]) {
        const wire = new THREE.Mesh(wireGeo, wireMat);
        wire.scale.y = 5.6;
        wire.rotation.z = tilt;
        wire.position.set(2.8, 2.6, 0.42);
        wires.add(wire);
    }
    const rail = new THREE.Mesh(wireGeo, wireMat);
    rail.scale.y = 4.4;
    rail.rotation.z = Math.PI / 2;
    rail.position.set(2.8, 4.9, 0.42);
    wires.add(rail);
    scene.add(wires);

    //* Flat, matte pedestal — a quiet area
    const pedestal = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 0.9, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x3a4a63, roughness: 0.9 }),
    );
    pedestal.position.set(-5.2, 0.45, 1.6);
    scene.add(pedestal);

    //* The moving object — faceted so its silhouette and shading read clearly
    const mover = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.62, 1),
        new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            metalness: 0.15,
            roughness: 0.35,
            flatShading: true,
        }),
    );
    scene.add(mover);
    poseMover(mover, 0);

    return { scene, mover };
}

/**
 * Places the moving object for a simulation time. Deterministic in `t`, so
 * stepping a frame always moves it by the same amount.
 *
 * @param mover - The object returned by {@link buildScene}
 * @param t - Simulation time in seconds
 */
export function poseMover(mover: THREE.Mesh, t: number): void {
    // Glides across the chart in front of the wall: whatever it uncovers is a
    // disocclusion trail; everything else stays still and converges.
    mover.position.set(Math.sin(t * 0.8) * 3.6, 2.3 + Math.sin(t * 1.6) * 0.35, 0.9);
    mover.rotation.set(t * 0.6, t * 0.9, 0);
}

//* Chart Texture

// Not mipmapped on purpose. At render resolution the screen-space derivatives
// are `ratio`× larger than at display resolution, so a mip chain would pick a
// level that is already blurred — detail the upscaler could never get back.
// FSR's integration guide asks for a negative mip bias of log2(render/display);
// three has no per-material LOD bias, so the chart samples the base level only
// and aliases at render resolution, which is the honest input to show.
function createChartTexture(): THREE.CanvasTexture {
    const w = 2048;
    const h = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#1b2230';
    ctx.fillRect(0, 0, w, h);

    //* Siemens star — 72 spokes: the center is finer than any pixel grid,
    //* so how far in the spokes stay resolved is a direct resolution readout.
    const cx = w * 0.25;
    const cy = h * 0.5;
    const radius = h * 0.42;
    ctx.fillStyle = '#eef2f8';
    const spokes = 72;
    for (let i = 0; i < spokes; i++) {
        const a0 = (i / spokes) * Math.PI * 2;
        const a1 = ((i + 0.5) / spokes) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, a0, a1);
        ctx.closePath();
        ctx.fill();
    }
    ctx.strokeStyle = '#eef2f8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.stroke();

    //* Line-pair bars — vertical and horizontal groups getting finer
    ctx.fillStyle = '#eef2f8';
    const barsX = w * 0.53;
    const periods = [16, 12, 9, 7, 5, 4, 3];
    let y = 70;
    for (const p of periods) {
        const half = p / 2;
        for (let x = 0; x < 260; x += p) ctx.fillRect(barsX + x, y, half, 90);
        for (let k = 0; k < 90; k += p) ctx.fillRect(barsX + 300, y + k, 120, half);
        y += 125;
    }

    //* Flat swatches — areas with nothing to resolve
    const swatches = ['#c2410c', '#15803d', '#1d4ed8', '#a1a1aa'];
    swatches.forEach((color, i) => {
        ctx.fillStyle = color;
        ctx.fillRect(w * 0.79, 80 + i * 220, 330, 180);
    });

    // A few thin, high-contrast hairlines across the swatches.
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) ctx.fillRect(w * 0.79 + 30 + i * 52, 60, 2, h - 120);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
}
