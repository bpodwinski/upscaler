import { describe, expect, it, vi } from 'vitest';
import type * as THREE from 'three/webgpu';

import { scalarTexture } from './scalarTexture';

describe('scalarTexture', () => {
    const renderer = () => ({ initTexture: vi.fn() }) as unknown as THREE.WebGPURenderer & { initTexture: ReturnType<typeof vi.fn> };

    it('holds the value in red, as a 1×1 float texture uploaded once', () => {
        const r = renderer();
        const cache = new Map<number, THREE.DataTexture>();
        const texture = scalarTexture(r, cache, 2.5);
        expect(Array.from(texture.image.data as Float32Array)).toEqual([2.5, 0, 0, 1]);
        expect([texture.image.width, texture.image.height]).toEqual([1, 1]);
        expect(r.initTexture).toHaveBeenCalledTimes(1);
        expect(r.initTexture).toHaveBeenCalledWith(texture);
    });

    it('returns the cached texture for a value it has seen, and a new one otherwise', () => {
        const r = renderer();
        const cache = new Map<number, THREE.DataTexture>();
        const first = scalarTexture(r, cache, 4);
        expect(scalarTexture(r, cache, 4)).toBe(first);
        const other = scalarTexture(r, cache, 1);
        expect(other).not.toBe(first);
        expect(r.initTexture).toHaveBeenCalledTimes(2);
        expect([...cache.keys()]).toEqual([4, 1]);
    });
});
