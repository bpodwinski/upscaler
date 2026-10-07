import type { JitterOffset } from './types.js';

/** Compose a clip-space translation with an existing column-major projection. */
export function jitterProjection(projection: ArrayLike<number>, jitter: JitterOffset, width: number, height: number): Float32Array {
    if (projection.length !== 16 || width <= 0 || height <= 0) throw new Error('UpscalerCore: invalid projection or jitter dimensions.');
    const result = Float32Array.from(projection);
    for (let column = 0; column < 4; column++) {
        result[column * 4] -= 2 * jitter.x / width * projection[column * 4 + 3];
        result[column * 4 + 1] += 2 * jitter.y / height * projection[column * 4 + 3];
    }
    return result;
}
