import type { TextureResource } from '@ruxelion/upscaler/core';

/** Diagnostic readback only, never used in the render loop. */
export async function readTexture(device: GPUDevice, { texture }: TextureResource): Promise<{ finite: boolean; min: number; max: number; meanAbs: number; cyanY: number; amberY: number }> {
    const single = texture.format === 'r32float', byte = texture.format === 'rgba8unorm';
    // Alpha=1 must not make a black color texture pass the nonempty-image checks.
    const channels = single ? 1 : 3, pixelBytes = single || byte ? 4 : 8;
    const bytesPerRow = Math.ceil(texture.width * pixelBytes / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * texture.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
        const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width: texture.width, height: texture.height }); device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const data = new DataView(buffer.getMappedRange());
        let min = Infinity, max = -Infinity, sum = 0, finite = true;
        let cyanY = 0, cyanCount = 0, amberY = 0, amberCount = 0;
        for (let y = 0; y < texture.height; y++) for (let x = 0; x < texture.width; x++) {
            const rgb = [];
            for (let c = 0; c < channels; c++) {
                const offset = y * bytesPerRow + x * pixelBytes + c * (byte ? 1 : single ? 4 : 2);
                let value: number;
                if (single) value = data.getFloat32(offset, true);
                else if (byte) value = data.getUint8(offset) / 255;
                else {
                    const bits = data.getUint16(offset, true), exp = (bits >> 10) & 31, mantissa = bits & 1023;
                    value = (bits & 32768 ? -1 : 1) * (exp === 0 ? mantissa * 2 ** -24 : exp === 31 ? Infinity : (1 + mantissa / 1024) * 2 ** (exp - 15));
                }
                finite &&= Number.isFinite(value); min = Math.min(min, value); max = Math.max(max, value); sum += Math.abs(value); rgb.push(value);
            }
            if (channels === 3) {
                if (rgb[0] < rgb[1] * 0.55 && rgb[1] > 0.15 && rgb[2] > 0.1) { cyanY += y; cyanCount++; }
                if (rgb[0] > 0.15 && rgb[1] > 0.08 && rgb[2] < rgb[1] * 0.6) { amberY += y; amberCount++; }
            }
        }
        return { finite, min, max, meanAbs: sum / (texture.width * texture.height * channels), cyanY: cyanCount ? cyanY / cyanCount / texture.height : -1, amberY: amberCount ? amberY / amberCount / texture.height : -1 };
    } finally { buffer.destroy(); }
}
