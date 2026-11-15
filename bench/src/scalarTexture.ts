import * as THREE from 'three/webgpu';

/**
 * A 1×1 float texture holding `value` in red, cached per value. three only
 * uploads textures its own render graph consumes, so a texel rewritten in
 * place would never reach the GPU: each distinct value gets its own texture,
 * uploaded once with `initTexture()`.
 * @param renderer - Renderer that uploads the texture
 * @param cache - The caller's cache, keyed by value; the caller disposes it
 * @param value - The value the texture holds
 * @returns The cached texture for `value`
 */
export function scalarTexture(
    renderer: THREE.WebGPURenderer,
    cache: Map<number, THREE.DataTexture>,
    value: number,
): THREE.DataTexture {
    let texture = cache.get(value);
    if (!texture) {
        texture = new THREE.DataTexture(new Float32Array([value, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
        texture.needsUpdate = true;
        renderer.initTexture(texture);
        cache.set(value, texture);
    }
    return texture;
}
