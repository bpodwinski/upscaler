import * as THREE from 'three/webgpu';
import { screenUV, smoothstep, vec3, vec4 } from 'three/tsl';

import { upscaleScene, QualityMode } from '@ruxelion/upscaler';

import { bootRenderer } from '../shared/boot';
import { addStudioLighting, createGridFloor } from '../shared/props';

//* Composing FSR3 in a post graph.
// The reason FSR3 is a node and not just an imperative driver: it slots into a
// THREE.RenderPipeline graph so other TSL effects can sit around it. Here the
// upscaled result feeds a simple vignette before hitting the screen —
// `post.outputNode = upscale(scene, camera).mul(vignette)`.

const { renderer } = await bootRenderer();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141a);
addStudioLighting(scene);
scene.add(createGridFloor());

const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.1, 0.34, 220, 28),
    new THREE.MeshStandardMaterial({ color: 0xc0c8d8, metalness: 0.9, roughness: 0.22 }),
);
knot.position.y = 2.2;
scene.add(knot);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(6, 4, 9);
camera.lookAt(0, 1.6, 0);

//* FSR3 node → vignette → screen, all in the post graph.
const post = new THREE.RenderPipeline(renderer);
const fsrNode = upscaleScene(scene, camera, { quality: QualityMode.Performance });
// Darken toward the frame edges (1 at centre, ~0.35 at the corners). Color
// only: the upscale carries alpha, so multiplying the vec4 by a bare float
// would fade the edges to *transparent* on three's default (alpha: true)
// canvas instead of darkening them.
const vignette = vec4(vec3(smoothstep(0.85, 0.25, screenUV.sub(0.5).length())), 1);
post.outputNode = fsrNode.mul(vignette);

const badge = document.getElementById('badge')!;
badge.innerHTML =
    `<b>@ruxelion/upscaler</b>  node composition\n` +
    `post.outputNode = upscaleScene(scene, camera)\n                   .mul(vignette)`;

window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
});

const timer = new THREE.Timer();
renderer.setAnimationLoop(() => {
    timer.update();
    const t = timer.getElapsed();
    knot.rotation.y = t * 0.5;
    knot.rotation.x = t * 0.35;
    camera.position.set(Math.cos(t * 0.2) * 10, 4.5, Math.sin(t * 0.2) * 10);
    camera.lookAt(0, 1.6, 0);
    post.render();
});
