import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

// Library build for @pmndrs/upscaler. The interactive test bench has its own
// config at bench/vite.config.ts (run via `yarn dev` / `yarn bench`).
export default defineConfig({
    test: {
        environment: 'node',
        // The shader tests import bench modules, which import the package by
        // its own name. Node's self-reference resolves that through
        // package.json `exports` → `dist/`, which doesn't exist before a build
        // (CI runs `npm test` first, so it failed there while passing locally
        // off a stale dist). Point it at the source, like bench/vite.config.ts.
        alias: {
            '@pmndrs/upscaler': resolve(__dirname, 'src/index.ts'),
        },
    },
    build: {
        lib: {
            entry: resolve(__dirname, 'src/index.ts'),
            formats: ['es'],
            fileName: 'index',
        },
        rollupOptions: {
            external: ['three', 'three/tsl', 'three/webgpu'],
        },
    },
});
