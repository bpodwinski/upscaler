import { Engine } from '@babylonjs/core/Engines/engine.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { FrameGraphTextureManager } from '@babylonjs/core/FrameGraph/frameGraphTextureManager.js';
import type { TextureResource } from '../core/types.js';
import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Matrix } from '@babylonjs/core/Maths/math.vector.js';

/** All Babylon 9.29 private access lives here. No independent queue submission. */
interface EngineInternals {
    _device: GPUDevice;
    _renderEncoder: GPUCommandEncoder;
    _endCurrentRenderPass(): void;
}
const views = new WeakMap<GPUTexture, GPUTextureView>();

function internals(engine: AbstractEngine): EngineInternals {
    if (!/^9\.29\./.test(Engine.Version)) throw new Error(`@ruxelion/upscaler: Babylon ${Engine.Version} is unsupported; use 9.29.x.`);
    const candidate = engine as unknown as Partial<EngineInternals>;
    if (!candidate._device || !candidate._renderEncoder || typeof candidate._endCurrentRenderPass !== 'function') throw new Error('@ruxelion/upscaler: an initialized Babylon WebGPUEngine is required.');
    return candidate as EngineInternals;
}

export function getBabylonDevice(engine: AbstractEngine): GPUDevice { return internals(engine)._device; }
/** Preserve a host-frozen projection as well as ordinary computed projections. */
export function freezeJitteredProjection(camera: Camera, projection: Matrix): () => void {
    const frozen = (camera as unknown as { _doNotComputeProjectionMatrix: boolean })._doNotComputeProjectionMatrix;
    const original = camera.getProjectionMatrix().clone(); camera.freezeProjectionMatrix(projection);
    return () => { camera.freezeProjectionMatrix(original); if (!frozen) camera.unfreezeProjectionMatrix(); };
}
export function getBabylonEncoder(engine: AbstractEngine): GPUCommandEncoder {
    const host = internals(engine); host._endCurrentRenderPass(); return host._renderEncoder;
}
export function resolveBabylonTexture(manager: FrameGraphTextureManager, handle: number, write = false): TextureResource {
    const internal = manager.getTextureFromHandle(handle, write);
    const hardware = internal?._hardwareTexture as unknown as { underlyingResource?: GPUTexture } | undefined;
    const texture = hardware?.underlyingResource;
    if (!texture) throw new Error(`@ruxelion/upscaler: Babylon texture handle ${handle} has no WebGPU allocation.`);
    let view = views.get(texture);
    if (!view) {
        view = texture.createView({ baseMipLevel: 0, mipLevelCount: 1, aspect: texture.format.startsWith('depth') ? 'depth-only' : 'all' });
        views.set(texture, view);
    }
    return { texture, view };
}
