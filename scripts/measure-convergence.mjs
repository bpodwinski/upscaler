#!/usr/bin/env node
/**
 * Still-scene convergence meter — quantifies temporal churn on a deterministic
 * benchmark scenario by stepping the bench frame-by-frame and measuring the
 * consecutive-frame mean absolute pixel difference (0–255 scale) of the
 * presented canvas after a settle period.
 *
 * A converged temporal accumulator on a static scene + still camera should
 * drive this toward ~0 (the consumer's converging reference accumulator
 * measures ~0.04–0.24; sustained values ≥0.15 read as visible shimmer).
 *
 * Usage:
 *   node scripts/measure-convergence.mjs [--scenario Q1] [--ratio 2]
 *     [--settle 180] [--pairs 12] [--width 1280] [--height 720]
 *     [--views final,accumulation-age] [--label baseline] [--port 9333]
 *     [--url http://127.0.0.1:5199] [--subrun static]
 *     [--settings '{"detectShadingChanges":false}']
 *
 * --url is the bench origin to drive; if nothing answers there, the bench dev
 * server is started on exactly that host + port. --port is Chrome's DevTools
 * (CDP) port. Run with --help for the full list.
 *
 * --subrun selects a scenario subrun (Q14: off/static/rotating/builtin);
 * --settings overrides the canonical capture settings (lockThinFeatures,
 * detectShadingChanges, autoExposure, rcasDenoise, maxAccumulation) for an A/B.
 *
 * Outputs per-pair diffs + a summary JSON, plus debug-view PNGs, under
 * bench/results/raw/convergence/<label>-<scenario>[-<subrun>]-<ratio>x/.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
    DEFAULT_BENCH_URL,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl as waitForServer,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

//* CLI
function parseArguments(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (!value.startsWith('--')) continue;
        const key = value.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) options[key] = true;
        else {
            options[key] = next;
            index++;
        }
    }
    return options;
}

const cli = parseArguments(process.argv.slice(2));
if (cli.help || cli.h) {
    console.log(`Usage: node scripts/measure-convergence.mjs [options]
  --scenario <id>        bench scenario (default Q1)
  --ratio <n>            upscale ratio (default 2)
  --settle <frames>      frames to step before measuring (default 180)
  --pairs <n>            consecutive frame pairs to diff (default 12)
  --width <px> --height <px>   canvas size (default 1280x720)
  --views <list>         debug views to capture (default final,accumulation-age)
  --label <name>         output folder prefix (default baseline)
  --url <origin>         bench origin (default ${DEFAULT_BENCH_URL}); if nothing answers,
                         the bench dev server is started on that host + port (--strictPort)
  --port <n>             Chrome DevTools (CDP) port (default 9333)
  --subrun <name>        scenario subrun, e.g. Q14 off|static|rotating|builtin
  --settings <json>      capture-setting overrides for an A/B, e.g.
                         '{"lockThinFeatures":false}' (also detectShadingChanges,
                         autoExposure, rcasDenoise, maxAccumulation)
Writes to bench/results/raw/convergence/<label>-<scenario>[-<subrun>]-<ratio>x/.`);
    process.exit(0);
}
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const scenario = cli.scenario ?? 'Q1';
const ratio = Number(cli.ratio ?? 2);
const settle = Number(cli.settle ?? 180);
const pairs = Number(cli.pairs ?? 12);
const width = Number(cli.width ?? 1280);
const height = Number(cli.height ?? 720);
const label = cli.label ?? 'baseline';
const port = parsePort(cli.port, '--port') ?? 9333;
const views = (cli.views ?? 'final,accumulation-age').split(',').filter(Boolean);
const subrun = typeof cli.subrun === 'string' ? cli.subrun : null;
const captureSettings = typeof cli.settings === 'string' ? JSON.parse(cli.settings) : {};
const outputDirectory = join(
    ROOT,
    'bench/results/raw/convergence',
    `${label}-${scenario}${subrun ? `-${subrun}` : ''}-${String(ratio).replace('.', '_')}x`,
);

//* PNG decode (RGB8/RGBA8, non-interlaced) — same contract as run-benchmark.mjs
function decodePng(bytes) {
    if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('Invalid PNG signature.');
    let offset = 8;
    let pngWidth = 0;
    let pngHeight = 0;
    let bitDepth = 0;
    let colorType = 0;
    const compressed = [];
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('ascii', offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + length);
        if (type === 'IHDR') {
            pngWidth = data.readUInt32BE(0);
            pngHeight = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === 'IDAT') compressed.push(data);
        else if (type === 'IEND') break;
        offset += length + 12;
    }
    if (bitDepth !== 8 || ![2, 6].includes(colorType))
        throw new Error(`PNG contract requires RGB8/RGBA8; got depth=${bitDepth}, type=${colorType}.`);
    const packed = inflateSync(Buffer.concat(compressed));
    const bytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = pngWidth * bytesPerPixel;
    const raw = Buffer.alloc(stride * pngHeight);
    let source = 0;
    for (let y = 0; y < pngHeight; y++) {
        const filter = packed[source++];
        for (let x = 0; x < stride; x++) {
            const value = packed[source++];
            const left = x >= bytesPerPixel ? raw[y * stride + x - bytesPerPixel] : 0;
            const above = y > 0 ? raw[(y - 1) * stride + x] : 0;
            const upperLeft = y > 0 && x >= bytesPerPixel ? raw[(y - 1) * stride + x - bytesPerPixel] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = above;
            else if (filter === 3) predictor = Math.floor((left + above) / 2);
            else if (filter === 4) {
                const p = left + above - upperLeft;
                const pa = Math.abs(p - left);
                const pb = Math.abs(p - above);
                const pc = Math.abs(p - upperLeft);
                predictor = pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft;
            } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
            raw[y * stride + x] = (value + predictor) & 0xff;
        }
    }
    return { width: pngWidth, height: pngHeight, bytesPerPixel, stride, raw };
}

/** Mean absolute RGB difference (0–255) between two decoded canvases. */
function meanAbsDiff(a, b) {
    if (a.width !== b.width || a.height !== b.height)
        throw new Error(`Size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
    let sum = 0;
    const pixels = a.width * a.height;
    for (let p = 0; p < pixels; p++) {
        const ia = p * a.bytesPerPixel;
        const ib = p * b.bytesPerPixel;
        sum +=
            Math.abs(a.raw[ia] - b.raw[ib]) +
            Math.abs(a.raw[ia + 1] - b.raw[ib + 1]) +
            Math.abs(a.raw[ia + 2] - b.raw[ib + 2]);
    }
    return sum / (pixels * 3);
}

//* CDP plumbing (subset of run-benchmark.mjs)
function chromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find(existsSync);
    if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH.');
    return executable;
}

async function waitForUrl(url, attempts = 100) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // Still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.opened = new Promise((resolveOpen, rejectOpen) => {
            this.socket.addEventListener('open', resolveOpen, { once: true });
            this.socket.addEventListener('error', rejectOpen, { once: true });
        });
        this.socket.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id) {
                const request = this.pending.get(message.id);
                if (!request) return;
                this.pending.delete(message.id);
                if (message.error) request.reject(new Error(message.error.message));
                else request.resolve(message.result);
                return;
            }
            for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
        });
    }
    async call(method, params = {}) {
        await this.opened;
        const id = this.nextId++;
        const response = new Promise((resolveCall, rejectCall) => {
            this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
        });
        this.socket.send(JSON.stringify({ id, method, params }));
        return response;
    }
    on(method, listener) {
        const listeners = this.listeners.get(method) ?? [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }
    close() {
        this.socket.close();
    }
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

async function captureCanvas(client) {
    const bounds = await evaluate(
        client,
        `(() => {
            const canvas = document.querySelector('canvas');
            if (!canvas) throw new Error('Canvas not found.');
            const rect = canvas.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        })()`,
    );
    const screenshot = await client.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { ...bounds, scale: 1 },
    });
    return Buffer.from(screenshot.data, 'base64');
}

//* Main
async function main() {
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    try {
        try {
            await waitForUrl(server.origin, 1);
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForServer(server.origin, { child: viteServer });
        }

        profile = join(tmpdir(), `upscaler-convergence-${process.pid}-${Date.now()}`);
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                `--window-size=${width + 40},${height + 40}`,
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
            r.json(),
        );
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => logRecords.push(`[log] ${entry.text}`));
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([
            client.call('Page.enable'),
            client.call('Runtime.enable'),
            client.call('Log.enable'),
        ]);

        const url = new URL(server.origin);
        url.searchParams.set('benchMode', 'capture');
        url.searchParams.set('scenario', scenario);
        url.searchParams.set('ratio', String(ratio));
        url.searchParams.set('width', String(width));
        url.searchParams.set('height', String(height));
        if (subrun) url.searchParams.set('subrun', subrun);
        await client.call('Page.navigate', { url: url.href });
        for (let attempt = 0; ; attempt++) {
            const ready = await evaluate(client, 'window.__UPSCALER_BENCH__?.ready === true');
            if (ready === true) break;
            if (attempt > 300) throw new Error('Timed out waiting for window.__UPSCALER_BENCH__.');
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        // Settle: canonical capture settings + deterministic reset + step to
        // the settle frame (capture() also drains the GPU queue).
        const settleInfo = await evaluate(
            client,
            `window.__UPSCALER_BENCH__.capture({ frame: ${settle}, debugView: 'final', settings: ${JSON.stringify(captureSettings)} })`,
        );
        const jitterPeriod = settleInfo.jitterPeriod;

        //* Consecutive-frame churn
        const frames = [];
        let previous = decodePng(await captureCanvas(client));
        await writeFile(join(outputDirectory, `final-f${settle}.png`), await captureCanvas(client));
        const diffs = [];
        for (let index = 1; index <= pairs; index++) {
            const frame = settle + index;
            await evaluate(
                client,
                `window.__UPSCALER_BENCH__.step(${frame}).then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))`,
            );
            const png = await captureCanvas(client);
            const decoded = decodePng(png);
            const diff = meanAbsDiff(previous, decoded);
            diffs.push({ frame, meanAbsDiff: diff });
            console.log(`frame ${frame - 1} -> ${frame}: meanAbsDiff ${diff.toFixed(4)}`);
            frames.push({ frame, decoded });
            previous = decoded;
            if (index === pairs) await writeFile(join(outputDirectory, `final-f${frame}.png`), png);
        }

        // Phase-locked residual: same jitter phase one period apart (isolates
        // non-jitter churn from the per-phase pattern).
        let phaseLocked = null;
        if (frames.length > jitterPeriod) {
            const a = frames[0];
            const b = frames[jitterPeriod];
            phaseLocked = {
                frames: [a.frame, b.frame],
                meanAbsDiff: meanAbsDiff(a.decoded, b.decoded),
            };
            console.log(
                `phase-locked ${a.frame} vs ${b.frame} (period ${jitterPeriod}): meanAbsDiff ${phaseLocked.meanAbsDiff.toFixed(4)}`,
            );
        }

        //* Debug views at the end of the run
        for (const view of views) {
            if (view === 'final') continue;
            try {
                await evaluate(
                    client,
                    `window.__UPSCALER_BENCH__.capture({ frame: ${settle + pairs}, debugView: '${view}', settings: ${JSON.stringify(captureSettings)} })`,
                );
                await writeFile(join(outputDirectory, `${view}-f${settle + pairs}.png`), await captureCanvas(client));
            } catch (error) {
                console.warn(`debug view ${view} skipped: ${error.message}`);
            }
        }

        const values = diffs.map((entry) => entry.meanAbsDiff);
        const summary = {
            scenario,
            subrun,
            settings: captureSettings,
            ratio,
            settle,
            pairs,
            width,
            height,
            jitterPeriod,
            diffs,
            phaseLocked,
            mean: values.reduce((total, value) => total + value, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            logRecords,
        };
        await writeFile(join(outputDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
        console.log(
            `\n${label} ${scenario} ${ratio}x: mean ${summary.mean.toFixed(4)}, ` +
                `min ${summary.min.toFixed(4)}, max ${summary.max.toFixed(4)} ` +
                `(over ${pairs} consecutive pairs after ${settle} settle frames)`,
        );
        console.log(`artifacts: ${outputDirectory}`);
        if (logRecords.some((record) => /error|exception|validation/i.test(record)))
            console.warn(`browser log records:\n${logRecords.join('\n')}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

await main();
