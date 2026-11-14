import * as THREE from 'three/webgpu';

import { getDevice, getGPUTexture } from '@pmndrs/upscaler-three/internal/threeWebGPU';

// The bench renders hardware depth. This turns it into the positive view depth
// a `depthMode: 'linear'` host would supply, with the core's own linearization
// (WGSL_DEPTH in packages/core/src/shaders/common.ts, same operations in the
// same order), so the two modes are fed the same scene.
const CONVERT_SHADER = /* wgsl */ `
struct Camera {
    near : f32,
    far : f32,
    perspective : u32,
    reversed : u32,
}
@group(0) @binding(0) var<uniform> camera : Camera;
@group(0) @binding(1) var sceneDepth : texture_depth_2d;
@group(0) @binding(2) var viewDepth : texture_storage_2d<r32float, write>;

fn linearizeDepth(d : f32) -> f32 {
    let near = camera.near;
    let far = camera.far;
    if (camera.perspective == 0u) {
        let t = select(d, 1.0 - d, camera.reversed != 0u);
        return near + t * (far - near);
    }
    if (camera.reversed != 0u) {
        return (far * near) / (near + d * (far - near));
    }
    return (far * near) / (far - d * (far - near));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid : vec3u) {
    if (any(gid.xy >= textureDimensions(sceneDepth))) { return; }
    let d = textureLoad(sceneDepth, vec2i(gid.xy), 0);
    textureStore(viewDepth, gid.xy, vec4f(linearizeDepth(d), 0.0, 0.0, 0.0));
}
`;

/**
 * Bench-only: converts the scene's hardware depth into an `r32float` view-depth
 * texture each frame, for the `linear-depth-input-v1` identity. Its own submit
 * runs before the upscaler's, so queue order makes the result visible.
 */
export class LinearDepthConverter {
    private readonly _renderer: THREE.WebGPURenderer;
    private readonly _device: GPUDevice;
    private readonly _pipeline: GPUComputePipeline;
    private readonly _uniform: GPUBuffer;
    private readonly _staging = new ArrayBuffer(16);
    private _texture: THREE.StorageTexture | null = null;

    constructor(renderer: THREE.WebGPURenderer) {
        this._renderer = renderer;
        this._device = getDevice(renderer);
        this._pipeline = this._device.createComputePipeline({
            label: 'bench-linear-depth',
            layout: 'auto',
            compute: { module: this._device.createShaderModule({ code: CONVERT_SHADER }), entryPoint: 'main' },
        });
        this._uniform = this._device.createBuffer({
            label: 'bench-linear-depth-camera',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
    }

    /**
     * (Re)allocates the view-depth target.
     * @param width - Render width in pixels
     * @param height - Render height in pixels
     */
    configure(width: number, height: number): void {
        this._texture?.dispose();
        const texture = new THREE.StorageTexture(width, height);
        texture.name = 'bench-linear-depth';
        texture.format = THREE.RedFormat;
        texture.type = THREE.FloatType;
        texture.colorSpace = THREE.NoColorSpace;
        texture.generateMipmaps = false;
        texture.minFilter = THREE.NearestFilter;
        texture.magFilter = THREE.NearestFilter;
        this._renderer.initTexture(texture);
        this._texture = texture;
    }

    /**
     * Writes this frame's view depth.
     * @param depth - The scene's hardware depth texture
     * @param camera - The camera that rendered it
     * @returns The `r32float` view-depth texture to dispatch with
     */
    convert(depth: THREE.Texture, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): THREE.Texture {
        const target = this._texture;
        if (!target) throw new Error('LinearDepthConverter: configure() must run before convert().');
        const device = this._device;
        const depthGPU = getGPUTexture(this._renderer, depth);
        new Float32Array(this._staging, 0, 2).set([camera.near, camera.far]);
        new Uint32Array(this._staging, 8, 2).set([
            (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true ? 1 : 0,
            (this._renderer as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer === true ? 1 : 0,
        ]);
        device.queue.writeBuffer(this._uniform, 0, this._staging);
        const bindGroup = device.createBindGroup({
            layout: this._pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this._uniform } },
                {
                    binding: 1,
                    resource: depthGPU.createView(
                        depthGPU.format.includes('stencil') ? { aspect: 'depth-only' } : undefined,
                    ),
                },
                { binding: 2, resource: getGPUTexture(this._renderer, target).createView() },
            ],
        });
        const encoder = device.createCommandEncoder({ label: 'bench-linear-depth' });
        const pass = encoder.beginComputePass();
        pass.setPipeline(this._pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(depthGPU.width / 8), Math.ceil(depthGPU.height / 8));
        pass.end();
        device.queue.submit([encoder.finish()]);
        return target;
    }

    /** Releases the target and the uniform buffer. */
    dispose(): void {
        this._texture?.dispose();
        this._texture = null;
        this._uniform.destroy();
    }
}
