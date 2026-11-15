import { describe, expect, test } from 'vitest';

import {
    HALF_TO_FLOAT,
    SSIM_BORDER,
    addYoung,
    decodePng,
    encodePng,
    present,
    psnr,
    referenceOffsets,
    regionMean,
    squaredErrorMap,
    ssimMap,
    summarizeYoung,
    temporalMaps,
    youngSums,
} from './image-metrics.mjs';

const FULL = [0, 0, 1, 1];

/** A w×h interleaved-RGB test card: a diagonal gradient with a bright square. */
function card(w, h, offset = 0) {
    const rgb = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
            const square = x > w / 3 && x < w / 2 && y > h / 3 && y < h / 2 ? 0.5 : 0;
            for (let c = 0; c < 3; c++) rgb[(y * w + x) * 3 + c] = Math.min(1, (x + y) / (w + h) + square * (c + 1) / 3 + offset);
        }
    return rgb;
}

describe('referenceOffsets', () => {
    test('are distinct sub-pixel offsets with an exactly zero mean', () => {
        for (const count of [1, 16, 64, 100]) {
            const offsets = referenceOffsets(count);
            const meanX = offsets.reduce((sum, [x]) => sum + x, 0) / count;
            const meanY = offsets.reduce((sum, [, y]) => sum + y, 0) / count;
            expect(Math.abs(meanX)).toBeLessThan(1e-12);
            expect(Math.abs(meanY)).toBeLessThan(1e-12);
            for (const [x, y] of offsets) expect(Math.max(Math.abs(x), Math.abs(y))).toBeLessThan(0.55);
            expect(new Set(offsets.map(String)).size).toBe(count);
        }
    });
});

describe('present', () => {
    test('keeps neutral greys neutral, monotonic and inside [0, 1]', () => {
        // Both ACES matrices have rows summing to 1, so a transposed matrix
        // (rows read as columns) tints greys — this pins the orientation.
        const greys = [0, 0.01, 0.18, 1, 4, 64, 1e4];
        const out = present(Float32Array.from(greys.flatMap((v) => [v, v, v])));
        let previous = -1;
        for (let i = 0; i < greys.length; i++) {
            expect(out[i * 3]).toBeCloseTo(out[i * 3 + 1], 5);
            expect(out[i * 3]).toBeCloseTo(out[i * 3 + 2], 5);
            expect(out[i * 3]).toBeGreaterThanOrEqual(previous);
            expect(out[i * 3]).toBeLessThanOrEqual(1);
            previous = out[i * 3];
        }
        expect(out[0]).toBeCloseTo(0, 3);
    });

    test('presents negative linear values as black, like the bench canvas', () => {
        // The ACES fit curves back up below zero; unclamped, RCAS undershoot
        // read up to 29/255 against a black canvas pixel.
        const out = present(Float32Array.from([-0.04, -0.03, -0.02, -0.04, 0.3, 0.3]));
        expect(out[0]).toBe(0);
        expect(out[1]).toBe(0);
        expect(out[2]).toBe(0);
        expect(Array.from(present(Float32Array.from([0, 0.3, 0.3])))).toEqual(Array.from(out.subarray(3)));
    });
});

describe('full-reference metrics', () => {
    test('identical images score PSNR ∞ and SSIM 1; a shift lowers both', () => {
        const w = 48;
        const h = 32;
        const reference = card(w, h);
        expect(psnr(regionMean(squaredErrorMap(reference, reference), w, h, FULL))).toBe(Infinity);
        expect(regionMean(ssimMap(reference, reference, w, h), w, h, FULL, SSIM_BORDER)).toBeCloseTo(1, 6);

        const brighter = card(w, h, 0.1);
        const mse = regionMean(squaredErrorMap(brighter, reference), w, h, FULL);
        expect(psnr(mse)).toBeGreaterThan(15);
        expect(psnr(mse)).toBeLessThan(21);
        expect(regionMean(ssimMap(brighter, reference, w, h), w, h, FULL, SSIM_BORDER)).toBeLessThan(0.99);
        expect(psnr(0.01)).toBeCloseTo(20, 10);
    });
});

describe('temporalMaps', () => {
    test('charges a frozen output for the change it misses, and nothing for tracking it', () => {
        const before = Float32Array.from([0.2, 0.2, 0.2]);
        const after = Float32Array.from([0.5, 0.5, 0.5]);
        const frozen = temporalMaps(before, before, after, before);
        expect(frozen.error[0]).toBeCloseTo(0.3, 6);
        expect(frozen.churn[0]).toBe(0);
        expect(frozen.referenceChurn[0]).toBeCloseTo(0.3, 6);
        const tracking = temporalMaps(after, before, after, before);
        expect(tracking.error[0]).toBe(0);
        expect(tracking.churn[0]).toBeCloseTo(0.3, 6);
    });
});

describe('PNG I/O', () => {
    test('round-trips 8-bit RGB', () => {
        const w = 5;
        const h = 3;
        const rgb = Float32Array.from({ length: w * h * 3 }, (_, i) => (i * 17 % 256) / 255);
        const decoded = decodePng(encodePng(rgb, w, h));
        expect([decoded.width, decoded.height, decoded.bytesPerPixel]).toEqual([w, h, 3]);
        expect([...decoded.raw]).toEqual([...rgb].map((v) => Math.round(v * 255)));
    });
});

describe('young-history sums', () => {
    // f16 bits of a value, found in the decode table the script itself uses.
    const half = (value) => {
        const bits = HALF_TO_FLOAT.findIndex((decoded) => decoded === value);
        if (bits < 0) throw new Error(`${value} is not exactly representable in f16`);
        return bits;
    };
    const W = 16;
    const H = 14;
    const flat = (value) => new Float32Array(W * H).fill(value);

    test('pools only the pixels strictly below the age threshold', () => {
        const age = new Uint16Array(W * H).fill(half(1));
        // Young: one interior pixel, one on the border, and one exactly at the threshold (not young).
        const interior = 7 * W + 8;
        const border = 0;
        const atThreshold = 6 * W + 6;
        age[interior] = half(0.25);
        age[border] = half(0);
        age[atThreshold] = half(0.5);
        const squared = flat(0);
        squared[interior] = 0.04;
        squared[border] = 0.02;
        squared[atThreshold] = 1;
        const ssim = flat(1);
        ssim[interior] = 0.5;
        ssim[border] = 0.1;

        const sums = youngSums();
        addYoung(sums, age, 0.5, squared, ssim, null, W, H);
        expect(sums).toMatchObject({ pixels: 2, total: W * H, ssimPixels: 1, temporalPixels: 0 });
        expect(sums.squared).toBeCloseTo(0.06, 6);

        const summary = summarizeYoung(sums, 0.5);
        expect(summary.ageBelow).toBe(0.5);
        expect(summary.share).toBeCloseTo(2 / (W * H), 12);
        expect(summary.psnr).toBeCloseTo(psnr(0.03), 5);
        // The border pixel has no full SSIM window, exactly as in regionMean().
        expect(summary.ssim).toBeCloseTo(0.5, 6);
        expect(summary.temporalError).toBeNull();
        expect(summary.churn).toBeNull();
    });

    test('pools across frames, and reports temporal metrics on a 0-255 scale', () => {
        const sums = youngSums();
        const young = new Uint16Array(W * H).fill(half(0.125));
        const old = new Uint16Array(W * H).fill(half(1));
        const maps = { error: flat(0.01), churn: flat(0.02), referenceChurn: flat(0.04) };
        addYoung(sums, young, 0.5, flat(0.01), flat(0.9), null, W, H); // first frame: no previous
        addYoung(sums, young, 0.5, flat(0.03), flat(0.7), maps, W, H);
        addYoung(sums, old, 0.5, flat(1), flat(0), maps, W, H); // nothing young: adds only to the total

        const summary = summarizeYoung(sums, 0.5);
        expect(summary.pixels).toBe(2 * W * H);
        expect(summary.share).toBeCloseTo(2 / 3, 12);
        expect(summary.psnr).toBeCloseTo(psnr(0.02), 4);
        expect(summary.ssim).toBeCloseTo(0.8, 5);
        // Temporal sums only cover the frame that had a previous one.
        expect(sums.temporalPixels).toBe(W * H);
        expect(summary.temporalError).toBeCloseTo(2.55, 4);
        expect(summary.churn).toBeCloseTo(5.1, 4);
        expect(summary.referenceChurn).toBeCloseTo(10.2, 4);
    });

    test('reports nulls, not Infinity or NaN, when no pixel is young', () => {
        const sums = youngSums();
        expect(summarizeYoung(sums, 0.5)).toMatchObject({ share: 0, pixels: 0, psnr: null, ssim: null, temporalError: null });
        addYoung(sums, new Uint16Array(W * H).fill(half(1)), 0.5, flat(0), flat(1), null, W, H);
        expect(summarizeYoung(sums, 0.5)).toMatchObject({ share: 0, pixels: 0, psnr: null, ssim: null, churn: null });
    });

    test('does not count NaN ages as young, and rejects a mismatched age map', () => {
        const nan = HALF_TO_FLOAT.findIndex((decoded) => Number.isNaN(decoded));
        const sums = youngSums();
        addYoung(sums, new Uint16Array(W * H).fill(nan), 0.5, flat(0), flat(1), null, W, H);
        expect(sums.pixels).toBe(0);
        expect(() => addYoung(sums, new Uint16Array(4), 0.5, flat(0), flat(1), null, W, H)).toThrow(/size/);
    });
});
