import * as THREE from 'three/webgpu';

/**
 * The bench scene — deliberately full of upscaler torture tests:
 * - a thin-line grid floor (sub-pixel detail, shimmer magnet)
 * - rotating torus knots with specular highlights (fireflies)
 * - a picket fence of thin boxes (geometric aliasing, disocclusion)
 * - orbiting spheres (fast motion, motion-vector validation)
 */
export interface BenchScene {
    scene: THREE.Scene;
    roomScene: THREE.Scene;
    cornellScene: THREE.Scene;
    reactiveScene: THREE.Scene;
    /** Advances animations. @param time - Elapsed seconds @param animate - Freeze toggle */
    update(time: number, animate: boolean): void;
    /** Applies a deterministic absolute scenario frame. */
    applyFrame(frame: BenchmarkFrameState): void;
    /** Recreates all seeded Q5 particle constants. */
    resetDeterministicState(): void;
}

/** Builds the checkerboard+grid floor texture on a canvas (no asset deps). */
function createGridTexture(): THREE.CanvasTexture {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    //* Checkerboard base
    ctx.fillStyle = '#5c6470';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#823535';
    ctx.fillRect(0, 0, size / 2, size / 2);
    ctx.fillRect(size / 2, size / 2, size / 2, size / 2);

    //* Thin grid lines — the sub-pixel detail that shows off upscaler quality
    ctx.strokeStyle = '#e8edf4';
    ctx.lineWidth = 2;
    const cells = 8;
    for (let i = 0; i <= cells; i++) {
        const p = (i / cells) * size;
        ctx.beginPath();
        ctx.moveTo(p, 0);
        ctx.lineTo(p, size);
        ctx.moveTo(0, p);
        ctx.lineTo(size, p);
        ctx.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(12, 12);
    texture.anisotropy = 8;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

/**
 * Creates the bench scene.
 * @returns The scene and its per-frame update hook
 */
export function createBenchScene(): BenchScene {
    const scene = new THREE.Scene();
    const roomScene = new THREE.Scene();
    const reactiveScene = new THREE.Scene();
    scene.background = new THREE.Color(0x10141a);
    scene.fog = new THREE.Fog(0x10141a, 40, 90);

    //* Lighting
    const sun = new THREE.DirectionalLight(0xfff2df, 3.2);
    sun.position.set(8, 14, 6);
    scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));

    //* Screen-Space Effect Room ==============================================
    roomScene.background = new THREE.Color(0x0a0c10);
    const roomSun = new THREE.DirectionalLight(0xfff2df, 3.2);
    roomSun.position.set(8, 14, 6);
    roomScene.add(roomSun);
    roomScene.add(new THREE.HemisphereLight(0x9fb4d4, 0x2a2620, 0.9));
    roomScene.add(new THREE.AmbientLight(0x404860, 0.4));

    const roomFloor = new THREE.Mesh(
        new THREE.PlaneGeometry(60, 60),
        new THREE.MeshStandardMaterial({
            color: 0x20242c,
            metalness: 0.9,
            roughness: 0.12,
        }),
    );
    roomFloor.rotation.x = -Math.PI / 2;
    roomScene.add(roomFloor);

    const wallGeometry = new THREE.BoxGeometry(20, 10, 0.4);
    const leftWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.9 }),
    );
    leftWall.position.set(-8, 5, -4);
    leftWall.rotation.y = Math.PI / 2;
    roomScene.add(leftWall);
    const rightWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0x2ecc71, roughness: 0.9 }),
    );
    rightWall.position.set(8, 5, -4);
    rightWall.rotation.y = -Math.PI / 2;
    roomScene.add(rightWall);
    const backWall = new THREE.Mesh(
        wallGeometry,
        new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9 }),
    );
    backWall.position.set(0, 5, -12);
    roomScene.add(backWall);

    for (let i = 0; i < 5; i++) {
        const box = new THREE.Mesh(
            new THREE.BoxGeometry(1.6, 2 + i * 0.5, 1.6),
            new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 }),
        );
        box.position.set(-5 + i * 2.5, 1 + i * 0.25, -6 + (i % 2) * 3);
        roomScene.add(box);
    }
    const roomBall = new THREE.Mesh(
        new THREE.SphereGeometry(1.4, 48, 32),
        new THREE.MeshStandardMaterial({
            color: 0xdfe6f0,
            metalness: 0.5,
            roughness: 0.15,
        }),
    );
    roomBall.position.set(2, 1.6, -2);
    roomScene.add(roomBall);

    //* Cornell Convergence Room (Q12) =======================================
    // Mirrors the first consumer's still-camera repro (GUIDES-HANDOFF-RESPONSE
    // report 3): an enclosed box lit by a shadow-casting point light. three's
    // WebGPU point shadows use an IGN-dithered Vogel filter whose dither is
    // SCREEN-anchored, so under camera jitter every penumbra texel re-rolls
    // each frame — deliberately unstable input luminance. A converged temporal
    // pipeline must hold a still image against exactly this.
    const cornellScene = new THREE.Scene();
    cornellScene.background = new THREE.Color(0x05060a);
    const cornellLight = new THREE.PointLight(0xfff4e5, 60, 0, 2);
    cornellLight.position.set(0, 5.4, 0.4);
    cornellLight.castShadow = true;
    cornellLight.shadow.mapSize.set(1024, 1024);
    cornellLight.shadow.bias = -0.004;
    cornellScene.add(cornellLight);
    cornellScene.add(new THREE.AmbientLight(0x8090b0, 0.25));

    const cornellWall = (color: number, width: number, height: number) => {
        const wall = new THREE.Mesh(
            new THREE.PlaneGeometry(width, height),
            new THREE.MeshStandardMaterial({ color, roughness: 0.95 }),
        );
        wall.receiveShadow = true;
        cornellScene.add(wall);
        return wall;
    };
    const cornellFloor = cornellWall(0xd8d4cc, 6, 6);
    cornellFloor.rotation.x = -Math.PI / 2;
    const cornellCeiling = cornellWall(0xd8d4cc, 6, 6);
    cornellCeiling.rotation.x = Math.PI / 2;
    cornellCeiling.position.y = 6;
    const cornellBack = cornellWall(0xd8d4cc, 6, 6);
    cornellBack.position.set(0, 3, -3);
    const cornellLeft = cornellWall(0xb02020, 6, 6);
    cornellLeft.rotation.y = Math.PI / 2;
    cornellLeft.position.set(-3, 3, 0);
    const cornellRight = cornellWall(0x1fa03a, 6, 6);
    cornellRight.rotation.y = -Math.PI / 2;
    cornellRight.position.set(3, 3, 0);

    const cornellBoxMaterial = new THREE.MeshStandardMaterial({ color: 0xd0ccc2, roughness: 0.9 });
    const cornellTall = new THREE.Mesh(new THREE.BoxGeometry(1.9, 3.6, 1.9), cornellBoxMaterial);
    cornellTall.position.set(-1.05, 1.8, -0.7);
    cornellTall.rotation.y = 0.3;
    const cornellShort = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), cornellBoxMaterial);
    cornellShort.position.set(1.15, 0.85, 0.9);
    cornellShort.rotation.y = -0.35;
    for (const box of [cornellTall, cornellShort]) {
        box.castShadow = true;
        box.receiveShadow = true;
        cornellScene.add(box);
    }

    // Emissive ceiling panel — a bright thin region under the light, the kind
    // of high-contrast edge the convergence meter is most sensitive to.
    const cornellPanel = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 1.6),
        new THREE.MeshStandardMaterial({
            color: 0x000000,
            emissive: 0xfff4e5,
            emissiveIntensity: 4,
        }),
    );
    cornellPanel.rotation.x = Math.PI / 2;
    cornellPanel.position.set(0, 5.98, 0.4);
    cornellScene.add(cornellPanel);

    //* Floor
    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(120, 120),
        new THREE.MeshStandardMaterial({ map: createGridTexture(), roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    //* Torus Knots — specular aliasing + rotation motion
    const knots: THREE.Mesh[] = [];
    const knotMaterial = new THREE.MeshStandardMaterial({
        color: 0xc0c8d8,
        metalness: 0.9,
        roughness: 0.22,
    });
    for (let i = 0; i < 3; i++) {
        const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28), knotMaterial);
        knot.position.set(-6 + i * 6, 2.2, -4);
        scene.add(knot);
        knots.push(knot);
    }

    //* Picket Fence — thin geometry, classic temporal-upscaler stress test
    const picketMaterial = new THREE.MeshStandardMaterial({ color: 0xd8b46a, roughness: 0.6 });
    const picketGeometry = new THREE.BoxGeometry(0.09, 2.4, 0.3);
    const pickets = new THREE.InstancedMesh(picketGeometry, picketMaterial, 60);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) {
        m.setPosition(-12 + i * 0.4, 1.2, 3.5);
        pickets.setMatrixAt(i, m);
    }
    scene.add(pickets);

    //* Orbiting Spheres — fast coherent motion + disocclusion behind them
    const spheres: THREE.Mesh[] = [];
    const sphereColors = [0xe86a5f, 0x5fb1e8, 0x8fe85f, 0xe8d15f];
    for (let i = 0; i < 4; i++) {
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.55, 48, 32),
            new THREE.MeshStandardMaterial({
                color: sphereColors[i],
                roughness: 0.35,
                metalness: 0.1,
            }),
        );
        scene.add(sphere);
        spheres.push(sphere);
    }

    //* Emissive Accent — small HDR hotspot to exercise the invertible tonemap
    const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 24, 16),
        new THREE.MeshStandardMaterial({ emissive: 0xfff0c0, emissiveIntensity: 14 }),
    );
    bulb.position.set(0, 5.5, -2);
    scene.add(bulb);

    //* Seeded Transparency Fixture ============================================
    const particleCount = 128;
    const particleGeometry = new THREE.SphereGeometry(0.06, 8, 6);
    const particles = new THREE.InstancedMesh(
        particleGeometry,
        new THREE.MeshBasicMaterial({
            color: 0x7fdfff,
            transparent: true,
            opacity: 0.7,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
        particleCount,
    );
    const reactiveParticles = new THREE.InstancedMesh(
        particleGeometry,
        new THREE.MeshBasicMaterial({
            color: 0xffffff,
            depthTest: true,
            depthWrite: false,
        }),
        particleCount,
    );
    particles.layers.set(1);
    reactiveParticles.layers.set(1);
    particles.visible = false;
    reactiveParticles.visible = false;
    scene.add(particles);
    reactiveScene.add(reactiveParticles);

    const particleBase = new Float32Array(particleCount * 3);
    const particlePhase = new Float32Array(particleCount);
    const particleUp = new Float32Array(particleCount);

    function resetDeterministicState(): void {
        let seed = 0x5eed1234;
        const random = (): number => {
            seed = (seed ^ ((seed << 13) >>> 0)) >>> 0;
            seed = (seed ^ (seed >>> 17)) >>> 0;
            seed = (seed ^ ((seed << 5) >>> 0)) >>> 0;
            return seed / 4294967296;
        };

        for (let i = 0; i < particleCount; i++) {
            const ux = random();
            const uy = random();
            const uz = random();
            const up = random();
            particleBase[i * 3] = -5 + 10 * ux;
            particleBase[i * 3 + 1] = 0.7 + 4 * uy;
            particleBase[i * 3 + 2] = -5 + 10 * uz;
            particlePhase[i] = 2 * Math.PI * up;
            particleUp[i] = up;
        }
    }

    function updateObjects(time: number): void {
        knots.forEach((knot, i) => {
            knot.rotation.x = time * 0.35 + i;
            knot.rotation.y = time * 0.5;
        });
        spheres.forEach((sphere, i) => {
            const a = time * 0.9 + (i * Math.PI) / 2;
            sphere.position.set(
                Math.cos(a) * 5.5,
                1.1 + Math.sin(time * 2 + i) * 0.4,
                Math.sin(a) * 5.5,
            );
        });
    }

    function updateParticles(time: number): void {
        const matrix = new THREE.Matrix4();
        for (let i = 0; i < particleCount; i++) {
            const phase = particlePhase[i];
            const up = particleUp[i];
            const x = particleBase[i * 3] + 0.35 * Math.sin(0.7 * time + phase);
            const y =
                particleBase[i * 3 + 1] + 0.6 * ((0.35 * time + up) % 1);
            const z =
                particleBase[i * 3 + 2] + 0.35 * Math.cos(0.7 * time + phase);
            matrix.makeTranslation(x, y, z);
            particles.setMatrixAt(i, matrix);
            reactiveParticles.setMatrixAt(i, matrix);
        }
        particles.instanceMatrix.needsUpdate = true;
        reactiveParticles.instanceMatrix.needsUpdate = true;
    }

    resetDeterministicState();
    updateObjects(0);
    updateParticles(0);

    function update(time: number, animate: boolean): void {
        if (!animate) return;
        updateObjects(time);
    }

    function applyFrame(frame: BenchmarkFrameState): void {
        updateObjects(frame.animateScene ? frame.sceneTime : 0);
        updateParticles(frame.time);
        particles.visible = frame.particlesVisible;
        reactiveParticles.visible = frame.particlesVisible;
        sun.intensity = frame.directionalIntensity;
        // The Q11 host pre-exposure multiplier lives in the MRT output node,
        // which the background never passes through — scale it here so the
        // whole frame is uniformly pre-exposed like a real app's render.
        (scene.background as THREE.Color)
            .setHex(0x10141a)
            .multiplyScalar(frame.hostPreExposure ?? 1);
    }

    return { scene, roomScene, cornellScene, reactiveScene, update, applyFrame, resetDeterministicState };
}
