import * as THREE from 'three/webgpu';

/**
 * The S1 set: an open-roofed courtyard built to make screen-space GI and
 * reflections *matter*. Four saturated plaster walls throw colored bounce light
 * onto pale props, a hard sun cuts colonnade shadows across a polished stone
 * floor that mirrors them. Wall sconces supply the per-pixel lighting load. Everything is
 * procedural (no network assets) and every light source is either the sun or an
 * off-screen fill — no tiny bright emitters (a known weak spot, issue #51).
 */

/** Interior half-extent of the courtyard (walls sit just outside it). */
export const COURTYARD_HALF = 12;
const WALL_HEIGHT = 9;

/** Polished stone tiles with thin grout — glossy enough for SSR to read. */
function createTileTexture(): THREE.CanvasTexture {
    const size = 1024;
    const tiles = 4;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const cell = size / tiles;

    // Deterministic per-tile tone jitter so the floor reads as stone, not a grid.
    let seed = 7;
    const rand = () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647;
    };
    for (let y = 0; y < tiles; y++) {
        for (let x = 0; x < tiles; x++) {
            const l = 0.42 + rand() * 0.1;
            const base = Math.round(l * 255);
            ctx.fillStyle = `rgb(${base + 6}, ${base + 2}, ${base - 4})`;
            ctx.fillRect(x * cell, y * cell, cell, cell);
            // Faint veining: a few soft diagonal strokes per tile.
            ctx.strokeStyle = `rgba(255, 250, 240, ${0.05 + rand() * 0.05})`;
            ctx.lineWidth = 6 + rand() * 10;
            for (let v = 0; v < 3; v++) {
                ctx.beginPath();
                ctx.moveTo(x * cell + rand() * cell, y * cell);
                ctx.lineTo(x * cell + rand() * cell, (y + 1) * cell);
                ctx.stroke();
            }
        }
    }
    // Grout: a few texels wide at this size, so it stays above a render texel
    // at the default render scale rather than turning into sub-pixel shimmer.
    ctx.fillStyle = '#2a2622';
    for (let i = 0; i <= tiles; i++) {
        const p = i * cell;
        ctx.fillRect(p - 3, 0, 6, size);
        ctx.fillRect(0, p - 3, size, 6);
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 3);
    tex.anisotropy = 8;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** One plaster wall: a thick box, rough and fully diffuse so it bounces color. */
function wall(color: number, w: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, WALL_HEIGHT, 0.6),
        new THREE.MeshStandardMaterial({ color, roughness: 0.92 }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * Builds the courtyard scene: walls, floor, colonnade, props, sun + fill.
 * @returns The scene, the knot the main loop spins, and the wall sconces
 */
export function createCourtyard(): { scene: THREE.Scene; spinner: THREE.Object3D; sconces: THREE.Group[] } {
    const scene = new THREE.Scene();
    // Sky seen over the walls. Kept dim-ish so the open roof doesn't dominate.
    scene.background = new THREE.Color(0x6f93bd);

    //* Lighting — a hard sun (the only shadow caster) plus a cool sky fill.
    // The sun comes in from the south-east and low enough that it floods the
    // red (west) and plaster (north) walls; those lit walls are what SSGI
    // bounces back into the shaded half of the courtyard.
    const sun = new THREE.DirectionalLight(0xfff0d8, 5.5);
    sun.position.set(14, 20, 16);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    const sc = sun.shadow.camera;
    sc.left = -20;
    sc.right = 20;
    sc.top = 20;
    sc.bottom = -20;
    sc.near = 1;
    sc.far = 70;
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x9fbce0, 0x3a3028, 0.55));

    //* Floor — polished stone, part metallic so SSR has something to say
    // (three's mirror SSR weights each reflection by metalness) while keeping
    // a diffuse term the sun and the bounce light can land on.
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(COURTYARD_HALF * 2, COURTYARD_HALF * 2),
        new THREE.MeshPhysicalMaterial({
            map: createTileTexture(),
            metalness: 0.4,
            roughness: 0.1,
            // A lacquer-like clearcoat: a second specular lobe every light
            // evaluates per pixel — realistic shading load, not decoration.
            clearcoat: 0.6,
            clearcoatRoughness: 0.08,
        }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    //* Walls — four saturated plasters, the GI's light sources.
    const span = COURTYARD_HALF * 2 + 1.2;
    const west = wall(0xc0392b, span); // terracotta red
    west.position.set(-COURTYARD_HALF - 0.3, WALL_HEIGHT / 2, 0);
    west.rotation.y = Math.PI / 2;
    const east = wall(0x1e9c6a, span); // emerald
    east.position.set(COURTYARD_HALF + 0.3, WALL_HEIGHT / 2, 0);
    east.rotation.y = Math.PI / 2;
    const north = wall(0xe6dccb, span); // warm plaster
    north.position.set(0, WALL_HEIGHT / 2, -COURTYARD_HALF - 0.3);
    const south = wall(0x2f5fb3, span); // cobalt
    south.position.set(0, WALL_HEIGHT / 2, COURTYARD_HALF + 0.3);
    scene.add(west, east, north, south);

    //* Colonnade along the north wall — stripes of sun and shadow on the floor.
    const columnMat = new THREE.MeshStandardMaterial({ color: 0xf1ece2, roughness: 0.55 });
    const columnGeo = new THREE.CylinderGeometry(0.42, 0.5, 6.4, 40);
    const capGeo = new THREE.BoxGeometry(1.3, 0.35, 1.3);
    for (let i = 0; i < 7; i++) {
        const x = -9 + i * 3;
        const col = new THREE.Mesh(columnGeo, columnMat);
        col.position.set(x, 3.2, -8.5);
        const cap = new THREE.Mesh(capGeo, columnMat);
        cap.position.set(x, 6.55, -8.5);
        const base = new THREE.Mesh(capGeo, columnMat);
        base.position.set(x, 0.17, -8.5);
        for (const m of [col, cap, base]) {
            m.castShadow = true;
            m.receiveShadow = true;
            scene.add(m);
        }
    }
    // Lintel across the column tops.
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(20.5, 0.7, 1.4), columnMat);
    lintel.position.set(0, 7.07, -8.5);
    lintel.castShadow = true;
    lintel.receiveShadow = true;
    scene.add(lintel);

    //* Centrepiece — a pale plinth with a matte sphere that picks up every
    // wall's bounce color, and a slowly turning glazed knot (moving geometry,
    // so the upscaler's motion vectors have something to do).
    const paleMat = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.7 });
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 2.05, 0.8, 64), paleMat);
    plinth.position.set(0, 0.4, 0);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(1.05, 64, 48), paleMat);
    orb.position.set(-0.7, 1.85, 0.2);
    const spinner = new THREE.Mesh(
        new THREE.TorusKnotGeometry(0.62, 0.2, 220, 32),
        new THREE.MeshStandardMaterial({ color: 0xe0902a, roughness: 0.16 }),
    );
    spinner.position.set(1.0, 2.0, -0.8);
    for (const m of [plinth, orb, spinner]) {
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
    }

    //* Satellites — stacked blocks and a glazed vase around the plinth, kept
    // inside the camera's orbit.
    const blockMats = [
        new THREE.MeshStandardMaterial({ color: 0xece4d4, roughness: 0.65 }),
        new THREE.MeshStandardMaterial({ color: 0xd9cfbd, roughness: 0.65 }),
    ];
    const blocks: Array<[number, number, number, number, number]> = [
        // x, z, w, h, rotY
        [-4.8, 1.6, 1.8, 1.8, 0.3],
        [-4.7, 1.5, 1.2, 1.2, 0.8],
        [5.4, -1.2, 2.2, 1.2, -0.2],
        [5.2, -4.6, 1.6, 3.2, 0.5],
        [-4.6, -5.0, 2.4, 0.9, -0.4],
    ];
    let stackY = 0;
    blocks.forEach(([x, z, w, h, r], i) => {
        // Block 1 sits on block 0 (a small stack); the rest stand on the floor.
        const y = i === 1 ? stackY + h / 2 : h / 2;
        if (i === 0) stackY = h;
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), blockMats[i % 2]);
        b.position.set(x, y, z);
        b.rotation.y = r;
        b.castShadow = true;
        b.receiveShadow = true;
        scene.add(b);
    });
    // A glazed vase — glossy but dielectric (SSR here reflects metals only).
    const profile: THREE.Vector2[] = [];
    for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        profile.push(new THREE.Vector2(0.35 + 0.55 * Math.sin(Math.PI * t * 0.95) + 0.12 * t, t * 2.6));
    }
    const vase = new THREE.Mesh(
        new THREE.LatheGeometry(profile, 64),
        new THREE.MeshStandardMaterial({ color: 0x1d4fa0, roughness: 0.18 }),
    );
    vase.position.set(-2.4, 0, -4.6);
    vase.castShadow = true;
    vase.receiveShadow = true;
    scene.add(vase);

    //* Wall sconces — the scene's per-pixel lighting load. Every enabled
    // sconce is a point light every shaded pixel evaluates, on both sides,
    // which is what makes native resolution expensive in a real scene.
    const sconces: THREE.Group[] = [];
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x2b2722, roughness: 0.5, metalness: 0.3 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffb66e, emissiveIntensity: 1.6 });
    const perWall = 8;
    const walls: Array<[number, number, number, number]> = [
        // x0, z0, dx, dz (inward normal is implied by placement)
        [-COURTYARD_HALF + 0.35, -COURTYARD_HALF + 1.5, 0, 1],
        [COURTYARD_HALF - 0.35, -COURTYARD_HALF + 1.5, 0, 1],
        [-COURTYARD_HALF + 1.5, -COURTYARD_HALF + 0.35, 1, 0],
        [-COURTYARD_HALF + 1.5, COURTYARD_HALF - 0.35, 1, 0],
    ];
    const step = (COURTYARD_HALF * 2 - 3) / (perWall - 1);
    for (let i = 0; i < perWall; i++) {
        for (const [x0, z0, dx, dz] of walls) {
            const g = new THREE.Group();
            g.position.set(x0 + dx * step * i, 4.6, z0 + dz * step * i);
            // A dark cap and drip tray around a glowing glass body. Big
            // enough (~0.5 world units) to stay well above a render texel.
            const cap = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.5), housingMat);
            cap.position.y = 0.3;
            const tray = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.44), housingMat);
            tray.position.y = -0.27;
            const glass = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.48, 0.34), glassMat);
            const light = new THREE.PointLight(0xffb070, 5, 10, 2);
            light.position.y = -0.45;
            g.add(cap, tray, glass, light);
            g.visible = false;
            sconces.push(g);
            scene.add(g);
        }
    }

    return { scene, spinner, sconces };
}

/**
 * Turns on the first `count` sconces (interleaved around the four walls).
 * @param sconces - From {@link createCourtyard}
 * @param count - How many to enable (0–32)
 */
export function setSconceCount(sconces: THREE.Group[], count: number): void {
    sconces.forEach((g, i) => (g.visible = i < count));
}
