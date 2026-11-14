#!/usr/bin/env node
/**
 * Babylon: `depthMode: 'linear'` fed the geometry renderer's view-depth
 * texture, against hardware depth, on examples/babylon/hello.
 *
 * Each of four pages (hardware / linear, open scene / `?enclosed`) is stepped
 * through the same deterministic animation (orbiting camera, moving cubes) and
 * screenshotted: the final image, the motion-vector view and the disocclusion
 * view. Linear is then diffed against hardware for the same scene. The
 * `repeat` rows diff the enclosed hardware page against a second run of
 * itself: the run-to-run noise the other rows sit on.
 *
 * Babylon's FrameGraphGeometryRendererTask clears view depth to 0, which the
 * linear contract forbids (every texel finite and > 0). So:
 * - `?enclosed` (a sky box covers every pixel) must match hardware depth;
 * - the open scene is reported, not required to match: wherever background
 *   shows, depth 0 reads as the nearest surface and wins every 3×3 dilation.
 * Exits 1 when the enclosed pair differs by more than --tolerance, or on any
 * WebGPU error.
 *
 * Usage:
 *   node scripts/verify-babylon-linear-depth.mjs [--frames 90] [--tolerance 0.5]
 *     [--url http://127.0.0.1:5300] [--port 9333] [--chrome <path>] [--out <dir>]
 *
 * Starts the examples dev server on --url's port if nothing answers there.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { parseCliOrExit } from './cli-flags.mjs';
import { decodePng } from './image-metrics.mjs';
import {
    closeOwnedCdpBrowser,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const USAGE = `Usage: node scripts/verify-babylon-linear-depth.mjs [options]
  --frames <n>      animation frames stepped before the captures (default 90)
  --tolerance <x>   largest mean |difference| (0-255) allowed on the enclosed pair (default 0.5)
  --mode <name>     upscale path on every page: temporal (default), spatial, bilinear, native.
                    bilinear shows the color input alone, with no depth or history involved
  --query <params>  extra URL parameters for every page, e.g. tilt=20 (ground tilt, degrees), sky=sphere (a sky dome, not a box)
                    or rh (right-handed scene)
  --near <z>        camera near plane on every page (default 0.1). A farther near plane
                    gives hardware depth more precision at distance
  --url <origin>    examples origin (default http://127.0.0.1:5300)
  --port <n>        Chrome DevTools (CDP) port (default 9333)
  --chrome <path>   browser executable (default: CHROME_PATH, then a system Chrome/Edge)
  --out <dir>       where to write the PNGs (default bench/results/raw/babylon-linear-depth)`;
const cli = parseCliOrExit(process.argv.slice(2), ['frames', 'tolerance', 'near', 'mode', 'query', 'url', 'port', 'chrome', 'out'], USAGE);
const frames = Number(cli.frames ?? 90);
const tolerance = Number(cli.tolerance ?? 0.5);
const server = resolveServerUrl(cli.url, 'http://127.0.0.1:5300');
const port = parsePort(cli.port, '--port') ?? 9333;
const out = resolve(typeof cli.out === 'string' ? cli.out : 'bench/results/raw/babylon-linear-depth');
const near = typeof cli.near === 'string' ? Number(cli.near) : null;
const mode = typeof cli.mode === 'string' ? cli.mode : null;
const extraQuery = typeof cli.query === 'string' ? cli.query : null;
const WIDTH = 1280;
const HEIGHT = 720;
// DebugView ids (packages/core/src/types.ts).
const VIEWS = { final: 0, motion: 1, disocclusion: 2, depth: 3 };
const PAGES = {
    'hardware-open': '',
    'linear-open': '?depth=linear',
    'hardware-enclosed': '?enclosed',
    'linear-enclosed': '?depth=linear&enclosed',
    // The same page again: what two runs of one configuration differ by.
    'hardware-enclosed-repeat': '?enclosed',
};

/** Mean and max absolute difference (0-255, RGB) and the share of pixels off by more than 8. */
function difference(a, b) {
    const pa = decodePng(a);
    const pb = decodePng(b);
    if (pa.width !== pb.width || pa.height !== pb.height) throw new Error('Capture sizes differ.');
    let sum = 0;
    let max = 0;
    let over = 0;
    const pixels = pa.width * pa.height;
    for (let i = 0; i < pixels; i++) {
        let worst = 0;
        for (let c = 0; c < 3; c++) {
            const d = Math.abs(pa.raw[i * pa.bytesPerPixel + c] - pb.raw[i * pb.bytesPerPixel + c]);
            sum += d;
            if (d > worst) worst = d;
        }
        if (worst > max) max = worst;
        if (worst > 8) over++;
    }
    return { mean: sum / (pixels * 3), max, over: over / pixels };
}

async function capturePage(client, query) {
    client.events.length = 0;
    const extra = [near === null ? '' : `near=${near}`, mode === null ? '' : `mode=${mode}`, extraQuery ?? ''].filter(Boolean).join('&');
    const search = extra ? `${query ? `${query}&` : '?'}${extra}` : query;
    await client.send('Page.navigate', { url: new URL(`/babylon/hello/index.html${search}`, server.origin).href });
    for (let attempt = 0; ; attempt++) {
        const ready = await client
            .evaluate('window.__babylonHello?.upscaler.isReady === true && window.__babylonHello.state.frames > 2')
            .catch(() => false);
        if (ready === true) break;
        if (attempt > 300) throw new Error(`Timed out waiting for the Babylon example (${query || 'default'}).`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    const captures = {};
    // The first pass is thrown away: it starts from however many frames the
    // page's own render loop happened to draw (its jitter phase, previous
    // transforms), which leaves a trace in the accumulated image.
    for (const [view, id] of [['warm-up', VIEWS.final], ...Object.entries(VIEWS)]) {
        // The same animation for every view and page: fixed time steps, the
        // example's own render loop stopped, history dropped at the start, and
        // a fixed conditioning exposure (adaptation follows wall-clock time).
        const stepped = await client.evaluate(`(async () => {
            const h = window.__babylonHello;
            h.scene.getEngine().stopRenderLoop();
            // The badge and the gallery nav differ between pages; only the canvas is compared.
            for (const element of document.querySelectorAll('body *'))
                if (getComputedStyle(element).position === 'fixed') element.style.display = 'none';
            h.upscaler.settings.autoExposure = false;
            h.state.debugView = ${id};
            h.upscaler.resetHistory();
            // One step per animation frame: the canvas texture lives for one.
            let done = 0;
            for (let i = 0; i < ${frames}; i++) {
                await new Promise((r) => requestAnimationFrame(r));
                if (h.step(2 + i / 60)) done++;
            }
            await new Promise((r) => requestAnimationFrame(r));
            return done;
        })()`);
        if (stepped !== frames) throw new Error(`Only ${stepped} of ${frames} frames rendered (${query}).`);
        const shot = await client.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
        });
        if (view !== 'warm-up') captures[view] = Buffer.from(shot.data, 'base64');
    }
    const logs = client.events
        .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.source !== 'network')
        .filter((event) => /error|warning/.test(event.params.entry.level))
        .map((event) => event.params.entry.text);
    return { captures, logs };
}

async function main() {
    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    try {
        try {
            await waitForUrl(server.origin, { attempts: 1 });
        } catch {
            viteServer = spawnVite('examples/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }
        profile = join(tmpdir(), `upscaler-babylon-depth-${process.pid}-${Date.now()}`);
        chrome = spawn(
            browserExecutable(typeof cli.chrome === 'string' ? cli.chrome : undefined),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${WIDTH + 40},${HEIGHT + 40}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        await waitForUrl(`http://127.0.0.1:${port}/json/version`);
        const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = await CDP.connect(target.webSocketDebuggerUrl);
        await Promise.all([client.send('Page.enable'), client.send('Runtime.enable'), client.send('Log.enable')]);
        await client.send('Emulation.setDeviceMetricsOverride', {
            width: WIDTH,
            height: HEIGHT,
            deviceScaleFactor: 1,
            mobile: false,
        });

        await mkdir(out, { recursive: true });
        const results = {};
        const problems = [];
        for (const [name, query] of Object.entries(PAGES)) {
            results[name] = await capturePage(client, query);
            // Two blank frames are identical too: a page that rendered nothing must not pass.
            const final = decodePng(results[name].captures.final);
            let low = 255;
            let high = 0;
            for (let i = 0; i < final.width * final.height; i += 97) {
                const value = final.raw[i * final.bytesPerPixel + 1];
                if (value < low) low = value;
                if (value > high) high = value;
            }
            if (high - low < 32) problems.push(`${name}: the final capture is blank (green range ${low}-${high}).`);
            problems.push(...results[name].logs.map((text) => `${name}: ${text}`));
            for (const [view, png] of Object.entries(results[name].captures))
                await writeFile(join(out, `${name}-${view}.png`), png);
        }

        console.log(
            `${frames} frames, ${WIDTH}x${HEIGHT}, ${mode ?? 'temporal'} path, near plane ${near ?? 0.1}${extraQuery ? `, ${extraQuery}` : ''}; ` +
                'linear vs hardware depth, |difference| on a 0-255 scale',
        );
        console.log('scene     view           mean     max   pixels off by > 8');
        let failed = problems.length > 0;
        for (const scene of ['repeat', 'enclosed', 'open']) {
            for (const view of Object.keys(VIEWS)) {
                const other = scene === 'repeat' ? 'hardware-enclosed-repeat' : `linear-${scene}`;
                const reference = scene === 'repeat' ? 'hardware-enclosed' : `hardware-${scene}`;
                const d = difference(results[other].captures[view], results[reference].captures[view]);
                const bad = scene === 'enclosed' && d.mean > tolerance;
                failed ||= bad;
                console.log(
                    `${scene.padEnd(9)} ${view.padEnd(13)} ${d.mean.toFixed(3).padStart(6)} ${String(d.max).padStart(7)} ` +
                        `${(d.over * 100).toFixed(3).padStart(10)} %${bad ? '  FAIL' : ''}`,
                );
            }
        }
        if (problems.length) console.error(`WebGPU / browser errors:\n${[...new Set(problems)].join('\n')}`);
        console.log(`captures: ${out}`);
        console.log(failed ? 'FAIL' : 'PASS: with every pixel covered, linear view depth matches hardware depth');
        process.exitCode = failed ? 1 : 0;
    } finally {
        // On Windows the browser can outlive its launcher process, so close it over CDP first.
        await closeOwnedCdpBrowser(client);
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
