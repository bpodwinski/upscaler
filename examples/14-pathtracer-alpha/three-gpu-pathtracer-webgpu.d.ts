// three-gpu-pathtracer ships types for its WebGL entry only; the WebGPU entry
// (`three-gpu-pathtracer/webgpu`) is still untyped upstream. This declares the
// slice this example drives — path-trace a scene into a texture we can hand to
// the upscaler — rather than pulling in an `any` for the whole module.
declare module 'three-gpu-pathtracer/webgpu' {
    import type {
        Camera,
        DataTexture,
        Scene,
        Texture,
        Vector2,
        WebGPURenderer,
    } from 'three/webgpu';

    /** PMREM-prefilters an equirect environment into a softer, faster-resolving copy. */
    export class BlurredEnvMapGenerator {
        constructor(renderer: WebGPURenderer);
        generate(
            texture: Texture,
            blur?: number,
            width?: number | null,
            height?: number | null,
        ): Promise<DataTexture>;
        dispose(): void;
    }

    export class WebGPUPathTracer {
        constructor(renderer: WebGPURenderer);

        /** Fraction of the drawing-buffer size the path tracer renders at. */
        renderScale: number;
        /** Keeps the path-trace size in step with the canvas size. */
        synchronizeRenderSize: boolean;
        /** Drops to `lowResScale` while the camera is moving. */
        dynamicLowRes: boolean;
        /** Resolution fraction used while `dynamicLowRes` is engaged. */
        lowResScale: number;
        /** Milliseconds after a reset spent in the low-resolution preview. */
        renderDelay: number;
        /** Per-pixel sample count to reach before fading in the full-res result. */
        minSamples: number;
        /** Softens very bright, very sharp specular lobes (firefly control). */
        filterGlossyFactor: number;
        /** Path depth. */
        bounces: number;
        /** Stops accumulating past this per-pixel sample count (0 = unlimited). */
        maxSamples: number;
        /** Skips sample accumulation without tearing down state. */
        pause: boolean;

        /** The accumulated result — an RGBA32F texture, rows stored top-down. */
        readonly target: Texture | null;

        setScene(scene: Scene, camera: Camera): void;
        setCamera(camera: Camera): void;
        updateCamera(): void;
        setSize(width: number, height: number): void;
        getSize(target: Vector2): Vector2;
        reset(): void;
        /** Accumulates one sample and blits the result to the canvas. */
        renderSample(): void;
        dispose(): void;
    }
}
