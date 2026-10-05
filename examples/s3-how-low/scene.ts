import * as THREE from 'three/webgpu';

//* A procedural "legibility yard": everything in it is the kind of detail a
//* low render resolution destroys first — text at many sizes, sub-pixel wires,
//* lattices, a fine floor pattern. No network assets; every texture is drawn on
//* a canvas at load. Deliberately no tiny bright emitters (issue #51 — a lone
//* sub-texel light is a known weak spot of the temporal path, not this demo's
//* subject).

/** The built scene plus the handles the demo animates. */
export interface HowLowScene {
    scene: THREE.Scene;
    /** The spoked wheel — spins while animation is on (object motion, not just camera). */
    wheel: THREE.Object3D;
    /** Where the camera orbit looks. */
    focus: THREE.Vector3;
}

/** Deterministic PRNG so every load (and every screenshot) is identical. */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Creates a canvas + 2D context of the given size. */
function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return [canvas, canvas.getContext('2d')!];
}

/** Wraps a canvas as an sRGB, mipmapped, anisotropic texture. */
function toTexture(canvas: HTMLCanvasElement, repeat = 1): THREE.CanvasTexture {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    if (repeat !== 1) {
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(repeat, repeat);
    }
    return tex;
}

//* Textures

/** Herringbone stone floor with 2px grout — a moiré magnet at grazing angles. */
function floorTexture(): THREE.CanvasTexture {
    const size = 1024;
    const [canvas, ctx] = canvas2d(size, size);
    const rand = mulberry32(7);
    ctx.fillStyle = '#2a2d33';
    ctx.fillRect(0, 0, size, size);
    // Herringbone = zig-zag strips of (horizontal, vertical) brick pairs, each
    // pair stepping (u, u); strips repeat every (2u, -2u). Both lattice vectors
    // divide 1024, so the texture tiles seamlessly.
    const u = 32;
    const brick = (x: number, y: number, w: number, h: number): void => {
        if (x > size || y > size || x + w < 0 || y + h < 0) return;
        const s = 0.72 + rand() * 0.28;
        ctx.fillStyle = `rgb(${Math.round(156 * s)},${Math.round(142 * s)},${Math.round(122 * s)})`;
        ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    };
    for (let m = -20; m <= 20; m++) {
        for (let k = -48; k <= 48; k++) {
            const x = k * u + m * 2 * u;
            const y = k * u - m * 2 * u;
            brick(x, y, 2 * u, u);
            brick(x, y + u, u, 2 * u);
        }
    }
    // Fine survey markings: thin lines + tick numbers every tile.
    ctx.strokeStyle = 'rgba(240, 236, 220, 0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, size - 2, size - 2);
    ctx.fillStyle = 'rgba(240, 236, 220, 0.9)';
    ctx.font = 'bold 22px ui-monospace, Menlo, monospace';
    for (let i = 0; i < 8; i++) ctx.fillRect(i * 128, 0, 2, 24);
    ctx.fillText('N 51°', 14, 50);
    return toTexture(canvas, 14);
}

/** Running-bond brick wall with mortar lines — the backdrop. */
function brickTexture(): THREE.CanvasTexture {
    const w = 1024;
    const h = 512;
    const [canvas, ctx] = canvas2d(w, h);
    const rand = mulberry32(19);
    ctx.fillStyle = '#4a4440';
    ctx.fillRect(0, 0, w, h);
    const bw = 64;
    const bh = 24;
    for (let row = 0; row * bh < h; row++) {
        const offset = row % 2 ? bw / 2 : 0;
        for (let x = -bw; x < w + bw; x += bw) {
            const s = 0.7 + rand() * 0.3;
            ctx.fillStyle = `rgb(${Math.round(150 * s)},${Math.round(72 * s)},${Math.round(56 * s)})`;
            ctx.fillRect(x + offset + 2, row * bh + 2, bw - 4, bh - 4);
        }
    }
    return toTexture(canvas, 1);
}

/** A Snellen-style eye chart — the legibility test, literally. */
function eyeChartTexture(): THREE.CanvasTexture {
    const w = 1024;
    const h = 1536;
    const [canvas, ctx] = canvas2d(w, h);
    ctx.fillStyle = '#f3f1ea';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#1b1d22';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    const rows: Array<[string, number, string]> = [
        ['E', 300, '20/200'],
        ['F P', 170, '20/100'],
        ['T O Z', 125, '20/70'],
        ['L P E D', 95, '20/50'],
        ['P E C F D', 74, '20/40'],
        ['E D F C Z P', 58, '20/30'],
        ['F E L O P Z D', 44, '20/25'],
        ['D E F P O T E C', 34, '20/20'],
        ['L E F O D P C T', 26, '20/15'],
        ['F D P L T C E O', 20, '20/13'],
        ['P E Z O L C F T D', 15, '20/10'],
    ];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    let y = 60;
    for (const [letters, px, acuity] of rows) {
        y += px * 1.18;
        ctx.fillStyle = '#121418';
        ctx.font = `bold ${px}px "Helvetica Neue", Arial, sans-serif`;
        ctx.fillText(letters, w / 2, y);
        ctx.fillStyle = '#7a1f1f';
        ctx.font = '18px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(acuity, 30, y);
        ctx.textAlign = 'center';
        y += 14;
    }
    // Red/green duochrome bar, as on a real chart.
    ctx.fillStyle = '#b3262b';
    ctx.fillRect(40, h - 110, w / 2 - 40, 70);
    ctx.fillStyle = '#2d7a3a';
    ctx.fillRect(w / 2, h - 110, w / 2 - 40, 70);
    ctx.fillStyle = '#f3f1ea';
    ctx.font = 'bold 40px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('9 6 3', w / 4 + 20, h - 60);
    ctx.fillText('5 8 2', (w * 3) / 4 - 20, h - 60);
    return toTexture(canvas);
}

/** A notice board of body copy at four point sizes, down to unreadable. */
function noticeTexture(): THREE.CanvasTexture {
    const w = 1024;
    const h = 768;
    const [canvas, ctx] = canvas2d(w, h);
    ctx.fillStyle = '#e9e4d6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1d3b5c';
    ctx.fillRect(0, 0, w, 96);
    ctx.fillStyle = '#f4f1e8';
    ctx.font = 'bold 56px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('NOTICE TO RENDERERS', 32, 68);

    const body =
        'Every pixel on this board was drawn by a renderer that skipped most of them. ' +
        'At 2x per axis it shaded a quarter of the frame; at 4x one sixteenth; at 8x one ' +
        'sixty-fourth. The rest is reconstructed from sub-pixel jitter, accumulated over ' +
        'many frames and reprojected through motion vectors. Hold still and it sharpens. ' +
        'Move and it has to start again, one jitter phase at a time.';
    ctx.fillStyle = '#16181c';
    let y = 140;
    for (const px of [30, 22, 16, 12]) {
        ctx.font = `${px}px Georgia, "Times New Roman", serif`;
        y = wrapText(ctx, body, 32, y, w - 64, px * 1.3) + px * 0.9;
    }
    // Fine print: a table of numbers, 10px.
    ctx.font = '11px ui-monospace, Menlo, monospace';
    for (let r = 0; r < 6; r++) {
        const ratio = [1, 1.5, 2, 3, 4, 8][r];
        ctx.fillText(
            `ratio ${ratio.toFixed(1)}x   pixels ${(100 / (ratio * ratio)).toFixed(2)}%   phases ${Math.round(8 * ratio * ratio)}`,
            32,
            y + r * 15,
        );
    }
    return toTexture(canvas);
}

/** Word-wraps `text` into the box; returns the y after the last line. */
function wrapText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    maxWidth: number,
    lineHeight: number,
): number {
    let line = '';
    for (const word of text.split(' ')) {
        const test = line ? `${line} ${word}` : word;
        if (ctx.measureText(test).width > maxWidth && line) {
            ctx.fillText(line, x, y);
            line = word;
            y += lineHeight;
        } else line = test;
    }
    ctx.fillText(line, x, y);
    return y + lineHeight;
}

/** A green street sign with white lettering. */
function streetSignTexture(text: string, sub: string): THREE.CanvasTexture {
    const w = 1024;
    const h = 256;
    const [canvas, ctx] = canvas2d(w, h);
    ctx.fillStyle = '#1f6b43';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#f2f4ef';
    ctx.lineWidth = 8;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    ctx.fillStyle = '#f2f4ef';
    ctx.textAlign = 'center';
    ctx.font = 'bold 104px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(text, w / 2, 140);
    ctx.font = '40px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(sub, w / 2, 210);
    return toTexture(canvas);
}

/** A clock face: 60 hairline ticks + numerals. */
function clockTexture(): THREE.CanvasTexture {
    const s = 512;
    const [canvas, ctx] = canvas2d(s, s);
    ctx.fillStyle = '#f5f3ee';
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(s / 2, s / 2);
    ctx.fillStyle = '#16181c';
    for (let i = 0; i < 60; i++) {
        const major = i % 5 === 0;
        ctx.save();
        ctx.rotate((i / 60) * Math.PI * 2);
        ctx.fillRect(-(major ? 4 : 1.5), -s / 2 + 18, major ? 8 : 3, major ? 34 : 18);
        ctx.restore();
    }
    ctx.font = 'bold 44px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 1; i <= 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        ctx.fillText(String(i), Math.sin(a) * 170, -Math.cos(a) * 170);
    }
    // Hands at 10:09, the watchmaker's pose.
    ctx.lineCap = 'round';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(-0.32 * Math.PI) * 120, -Math.cos(-0.32 * Math.PI) * 120);
    ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(0.3 * Math.PI) * 190, -Math.cos(0.3 * Math.PI) * 190);
    ctx.stroke();
    return toTexture(canvas);
}

//* Geometry helpers

const _up = new THREE.Vector3(0, 1, 0);

/** Instanced thin cylinders, one per segment (a → b). */
function struts(
    segments: Array<[THREE.Vector3, THREE.Vector3]>,
    radius: number,
    material: THREE.Material,
): THREE.InstancedMesh {
    const geo = new THREE.CylinderGeometry(radius, radius, 1, 6, 1, true);
    const mesh = new THREE.InstancedMesh(geo, material, segments.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    segments.forEach(([a, b], i) => {
        dir.subVectors(b, a);
        const len = dir.length();
        q.setFromUnitVectors(_up, dir.normalize());
        mid.addVectors(a, b).multiplyScalar(0.5);
        s.set(1, len, 1);
        m.compose(mid, q, s);
        mesh.setMatrixAt(i, m);
    });
    mesh.castShadow = true;
    return mesh;
}

/** A sign board: a textured front face on a dark slab. */
function board(tex: THREE.Texture, w: number, h: number, depth = 0.06): THREE.Group {
    const group = new THREE.Group();
    const slab = new THREE.Mesh(
        new THREE.BoxGeometry(w + 0.08, h + 0.08, depth),
        new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.6, metalness: 0.4 }),
    );
    slab.castShadow = true;
    group.add(slab);
    const face = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }),
    );
    face.position.z = depth / 2 + 0.002;
    group.add(face);
    return group;
}

//* Scene

/**
 * Builds the showcase scene.
 * @returns The scene, the animated wheel and the orbit focus point
 */
export function buildHowLowScene(): HowLowScene {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151a22);
    scene.fog = new THREE.Fog(0x151a22, 26, 70);

    //* Lighting — a low warm sun with shadows (the fence and lattice throw
    //* fine shadow patterns onto the floor) plus a cool sky fill.
    const sun = new THREE.DirectionalLight(0xffecd2, 3.0);
    sun.position.set(9, 13, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -14;
    sun.shadow.camera.right = 14;
    sun.shadow.camera.top = 14;
    sun.shadow.camera.bottom = -14;
    sun.shadow.camera.far = 50;
    sun.shadow.bias = -0.0005;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0xa8bcdc, 0x2c2822, 1.1));

    //* Floor.
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshStandardMaterial({ map: floorTexture(), roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    //* Back wall (brick) with a clock.
    const brick = brickTexture();
    brick.wrapS = THREE.RepeatWrapping;
    brick.wrapT = THREE.RepeatWrapping;
    brick.repeat.set(20, 3);
    const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(80, 12),
        new THREE.MeshStandardMaterial({ map: brick, roughness: 0.9 }),
    );
    wall.position.set(0, 6, -8);
    wall.receiveShadow = true;
    scene.add(wall);

    const clock = new THREE.Mesh(
        new THREE.CircleGeometry(1.1, 96),
        new THREE.MeshStandardMaterial({ map: clockTexture(), roughness: 0.5 }),
    );
    clock.position.set(-2.9, 5.7, -7.95);
    scene.add(clock);
    const bezel = new THREE.Mesh(
        new THREE.TorusGeometry(1.12, 0.06, 12, 96),
        new THREE.MeshStandardMaterial({ color: 0xb08d57, metalness: 0.9, roughness: 0.3 }),
    );
    bezel.position.copy(clock.position);
    scene.add(bezel);

    //* Chain-link fence in front of the wall — two sets of hairline bars at ±45°.
    const wireMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.75, roughness: 0.35 });
    const fenceSegs: Array<[THREE.Vector3, THREE.Vector3]> = [];
    const fenceZ = -6.2;
    const fenceH = 3.2;
    for (let x = -14; x <= 14; x += 0.32) {
        // Each bar runs diagonally from the ground to the fence top.
        fenceSegs.push([new THREE.Vector3(x, 0, fenceZ), new THREE.Vector3(x + fenceH, fenceH, fenceZ)]);
        fenceSegs.push([new THREE.Vector3(x, 0, fenceZ), new THREE.Vector3(x - fenceH, fenceH, fenceZ)]);
    }
    scene.add(struts(fenceSegs, 0.009, wireMat));
    const postMat = new THREE.MeshStandardMaterial({ color: 0x5b636e, metalness: 0.6, roughness: 0.5 });
    const posts: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let x = -12; x <= 12; x += 3) posts.push([new THREE.Vector3(x, 0, fenceZ), new THREE.Vector3(x, fenceH + 0.1, fenceZ)]);
    posts.push([new THREE.Vector3(-14, fenceH, fenceZ), new THREE.Vector3(14, fenceH, fenceZ)]);
    scene.add(struts(posts, 0.04, postMat));

    //* The eye chart, centre stage, on two legs.
    const chart = board(eyeChartTexture(), 2.2, 3.3);
    chart.position.set(0, 2.45, -1.5);
    scene.add(chart);
    const legMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.5, roughness: 0.5 });
    scene.add(
        struts(
            [
                [new THREE.Vector3(-0.8, 0, -1.56), new THREE.Vector3(-0.8, 0.8, -1.56)],
                [new THREE.Vector3(0.8, 0, -1.56), new THREE.Vector3(0.8, 0.8, -1.56)],
            ],
            0.04,
            legMat,
        ),
    );

    //* Notice board, angled toward the viewer on the left.
    const notice = board(noticeTexture(), 2.6, 1.95);
    notice.position.set(-3.6, 2.1, -1.0);
    notice.rotation.y = 0.38;
    scene.add(notice);
    scene.add(
        struts(
            [
                [new THREE.Vector3(-4.65, 0, -0.6), new THREE.Vector3(-4.65, 1.2, -0.6)],
                [new THREE.Vector3(-2.55, 0, -1.4), new THREE.Vector3(-2.55, 1.2, -1.4)],
            ],
            0.04,
            legMat,
        ),
    );

    //* Street sign on a pole, high on the right.
    const sign = board(streetSignTexture('HOW LOW CAN YOU GO', 'render less · reconstruct more'), 3.2, 0.8);
    sign.position.set(3.3, 4.4, -2.6);
    sign.rotation.y = -0.2;
    scene.add(sign);
    scene.add(struts([[new THREE.Vector3(3.3, 0, -2.75), new THREE.Vector3(3.3, 4.0, -2.75)]], 0.06, postMat));

    //* Overhead cables: sagging catenaries between two masts, crossing the view.
    const mastL = new THREE.Vector3(-8, 0, -3.5);
    const mastR = new THREE.Vector3(8.5, 0, -4.5);
    scene.add(
        struts(
            [
                [mastL, mastL.clone().setY(7.2)],
                [mastR, mastR.clone().setY(7.2)],
            ],
            0.08,
            postMat,
        ),
    );
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.7 });
    for (let i = 0; i < 5; i++) {
        const a = mastL.clone().setY(6.9 - i * 0.28);
        const b = mastR.clone().setY(6.9 - i * 0.28);
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 32; k++) {
            const t = k / 32;
            const p = a.clone().lerp(b, t);
            p.y -= Math.sin(Math.PI * t) * (0.9 + i * 0.12); // sag
            pts.push(p);
        }
        const tube = new THREE.Mesh(
            new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 96, 0.012, 5, false),
            cableMat,
        );
        tube.castShadow = true;
        scene.add(tube);
    }

    //* Geodesic lattice sphere on a plinth (right).
    const latticeMat = new THREE.MeshStandardMaterial({ color: 0xd9b26a, metalness: 0.85, roughness: 0.28 });
    const ico = new THREE.IcosahedronGeometry(1.15, 3);
    const edges = new THREE.EdgesGeometry(ico, 1);
    const ep = edges.getAttribute('position');
    const center = new THREE.Vector3(3.4, 2.05, 0.4);
    const latticeSegs: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let i = 0; i < ep.count; i += 2) {
        latticeSegs.push([
            new THREE.Vector3().fromBufferAttribute(ep, i).add(center),
            new THREE.Vector3().fromBufferAttribute(ep, i + 1).add(center),
        ]);
    }
    scene.add(struts(latticeSegs, 0.011, latticeMat));
    const plinth = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.65, 0.9, 48),
        new THREE.MeshStandardMaterial({ color: 0x8c8f96, roughness: 0.4, metalness: 0.2 }),
    );
    plinth.position.set(center.x, 0.45, center.z);
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    scene.add(plinth);

    //* Spoked wheel on a stand (left-front) — 48 hairline spokes, slowly spinning.
    const wheel = new THREE.Group();
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.9, roughness: 0.25 });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.035, 10, 128), rimMat);
    rim.castShadow = true;
    wheel.add(rim);
    const tyre = new THREE.Mesh(
        new THREE.TorusGeometry(1.06, 0.05, 10, 128),
        new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.9 }),
    );
    tyre.castShadow = true;
    wheel.add(tyre);
    const spokes: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const hubSide = i % 2 ? 0.05 : -0.05; // laced from both hub flanges
        const hubA = a + (i % 2 ? 0.2 : -0.2);
        spokes.push([
            new THREE.Vector3(Math.cos(hubA) * 0.08, Math.sin(hubA) * 0.08, hubSide),
            new THREE.Vector3(Math.cos(a) * 0.98, Math.sin(a) * 0.98, 0),
        ]);
    }
    wheel.add(struts(spokes, 0.005, rimMat));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 24), rimMat);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);
    wheel.position.set(-5.4, 1.35, 0.9);
    wheel.rotation.y = 0.75;
    scene.add(wheel);
    scene.add(
        struts(
            [
                [new THREE.Vector3(-5.4, 0, 0.9), new THREE.Vector3(-5.4, 1.3, 0.9)],
                [new THREE.Vector3(-5.65, 0, 1.15), new THREE.Vector3(-5.15, 0, 0.65)],
            ],
            0.035,
            legMat,
        ),
    );

    //* Torus knot (polished) beside the lattice.
    const knot = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.45, 0.13, 256, 24, 3, 5),
        // Dielectric, not chrome: with no environment map a mirror metal renders black.
        new THREE.MeshStandardMaterial({ color: 0x2f8f9d, metalness: 0.1, roughness: 0.25 }),
    );
    knot.position.set(1.7, 0.75, 1.5);
    knot.castShadow = true;
    scene.add(knot);

    //* Railing along the front-right walkway: rails + dense balusters.
    const railMat = new THREE.MeshStandardMaterial({ color: 0x7c6a52, metalness: 0.4, roughness: 0.5 });
    const railSegs: Array<[THREE.Vector3, THREE.Vector3]> = [];
    const r0 = new THREE.Vector3(5.2, 0, 3.5);
    const r1 = new THREE.Vector3(9.0, 0, -3.0);
    for (const h of [0.95, 0.55]) railSegs.push([r0.clone().setY(h), r1.clone().setY(h)]);
    scene.add(struts(railSegs, 0.025, railMat));
    const balusters: Array<[THREE.Vector3, THREE.Vector3]> = [];
    for (let t = 0; t <= 1.0001; t += 1 / 50) {
        const p = r0.clone().lerp(r1, t);
        balusters.push([p.clone().setY(0), p.clone().setY(0.95)]);
    }
    scene.add(struts(balusters, 0.008, railMat));

    return { scene, wheel, focus: new THREE.Vector3(0, 2.4, -1.5) };
}
