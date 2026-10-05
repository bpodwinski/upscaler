#!/usr/bin/env node
/**
 * GPU-timing overhead meter (issue #70). Drives bench/timer-overhead.html over
 * CDP and measures what per-pass timestamp profiling costs, from outside the
 * timer: wall-clock throughput with the GPU kept busy (a bounded number of
 * frames in flight), plus CPU time spent encoding/submitting.
 *
 * Each condition runs --blocks repetitions of A B B A legs (A = gpuTiming on,
 * B = off). Per block, overhead = mean(A) / mean(B) − 1; the report is the
 * median over blocks next to a noise floor, the median |A₁ − A₂| / A of the
 * two on-legs (the harness disagreeing with itself). A delta inside the noise
 * floor is not a measurement.
 *
 * Usage:
 *   node scripts/measure-timer-overhead.mjs
 *     [--conditions temporal:2:dispatch,temporal:2:frame,spatial:2:dispatch,bilinear:2:dispatch]
 *     [--size 1920x1080] [--frames 400] [--warmup 60] [--blocks 6] [--inflight 2]
 *     [--attach-only] [--label baseline] [--port 9333] [--url http://127.0.0.1:5199]
 *
 * --attach-only keeps the timer allocated through the B legs and only stops
 * attaching timestamp work (isolates per-frame cost from allocation).
 * A condition's optional 4th field picks what an attach-only A leg runs:
 * full (default), writes (per-pass timestampWrites only), resolve (+ resolve
 * and copy, no mapAsync), sampled:N (the full timer every Nth frame), none (A/A control: harness bias), e.g.
 * temporal:2:dispatch:writes. A variant implies --attach-only.
 * Starts the bench dev server on --url's port if nothing answers there.
 * Writes bench/results/raw/timer-overhead/<label>/summary.json.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
    DEFAULT_BENCH_URL,
    parsePort,
    removeTempDirectory,
    resolveServerUrl,
    spawnVite,
    stopChild,
    waitForUrl,
} from './local-processes.mjs';

const ROOT = resolve(import.meta.dirname, '..');

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
const conditions = String(
    cli.conditions ?? 'temporal:2:dispatch,temporal:2:frame,spatial:2:dispatch,bilinear:2:dispatch',
)
    .split(',')
    .map((spec) => {
        const [path, ratio, mode, ...variant] = spec.split(':');
        return {
            spec,
            path,
            ratio: Number(ratio),
            mode: mode || 'dispatch',
            variant: variant.length ? variant.join(':') : undefined,
        };
    });
const [width, height] = String(cli.size ?? '1920x1080').split('x').map(Number);
const frames = Number(cli.frames ?? 400);
const warmup = Number(cli.warmup ?? 60);
const blocks = Number(cli.blocks ?? 6);
const inflight = Number(cli.inflight ?? 2);
const attachOnly = cli['attach-only'] === true;
const label = cli.label ?? 'baseline';
const port = parsePort(cli.port, '--port') ?? 9333;
const server = resolveServerUrl(cli.url, DEFAULT_BENCH_URL);
const outputDirectory = join(ROOT, 'bench/results/raw/timer-overhead', label);

function chromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find((candidate) => existsSync(candidate));
    if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH.');
    return executable;
}

//* CDP
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
    const response = await client.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? 'Browser evaluation failed.');
    return response.result.value;
}

//* Statistics
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

function summarize(result) {
    const perBlock = result.blocks.map((legs) => {
        const on = legs.filter((leg) => leg.timing);
        const off = legs.filter((leg) => !leg.timing);
        const onMs = mean(on.map((leg) => leg.msPerFrame));
        const offMs = mean(off.map((leg) => leg.msPerFrame));
        return {
            onMs,
            offMs,
            overhead: onMs / offMs - 1,
            deltaMs: onMs - offMs,
            noise: Math.abs(on[0].msPerFrame - on[1].msPerFrame) / onMs,
            cpuOn: mean(on.map((leg) => leg.cpuMsPerFrame)),
            cpuOff: mean(off.map((leg) => leg.cpuMsPerFrame)),
            timedShare: mean(on.map((leg) => leg.timedFrames)) / frames,
            timerGpuMs: mean(on.map((leg) => leg.timerGpuMs ?? 0)),
        };
    });
    const pick = (key) => median(perBlock.map((block) => block[key]));
    return {
        onMs: pick('onMs'),
        offMs: pick('offMs'),
        deltaMs: pick('deltaMs'),
        overhead: pick('overhead'),
        noise: pick('noise'),
        overheadRange: [
            Math.min(...perBlock.map((block) => block.overhead)),
            Math.max(...perBlock.map((block) => block.overhead)),
        ],
        cpuOn: pick('cpuOn'),
        cpuOff: pick('cpuOff'),
        timedShare: pick('timedShare'),
        timerGpuMs: pick('timerGpuMs'),
        perBlock,
    };
}

const pct = (value) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
const ms = (value) => `${value.toFixed(3)} ms`;

//* Main
async function main() {
    let viteServer = null;
    let chrome = null;
    let profile = null;
    let client = null;
    try {
        try {
            await waitForUrl(server.origin, { attempts: 1 });
        } catch {
            viteServer = spawnVite('bench/vite.config.ts', server);
            await waitForUrl(server.origin, { child: viteServer });
        }

        profile = await mkdtemp(join(tmpdir(), 'upscaler-timer-overhead-'));
        chrome = spawn(
            chromeExecutable(),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--window-size=800,600',
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: ['ignore', 'ignore', 'ignore'] },
        );
        const cdpBase = `http://127.0.0.1:${port}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const created = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
        client = new CdpClient(created.webSocketDebuggerUrl);
        const logRecords = [];
        client.on('Log.entryAdded', ({ entry }) => {
            if (!/favicon/.test(entry.url ?? '')) logRecords.push(`[${entry.level}] ${entry.text}`);
        });
        client.on('Runtime.consoleAPICalled', ({ type, args }) => {
            if (type === 'warning' || type === 'error')
                logRecords.push(`[console.${type}] ${args.map((arg) => arg.value ?? arg.description).join(' ')}`);
        });
        client.on('Runtime.exceptionThrown', ({ exceptionDetails }) =>
            logRecords.push(`[exception] ${exceptionDetails.exception?.description ?? exceptionDetails.text}`),
        );
        await Promise.all([client.call('Page.enable'), client.call('Runtime.enable'), client.call('Log.enable')]);
        await client.call('Page.navigate', { url: `${server.origin}/timer-overhead.html` });
        for (let attempt = 0; ; attempt++) {
            if ((await evaluate(client, 'window.__timerOverhead?.ready === true')) === true) break;
            if (attempt > 300) throw new Error(`Timed out waiting for the probe page.\n${logRecords.join('\n')}`);
            await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }

        console.log(
            `${width}x${height}, ${frames} frames/leg, ${warmup} warmup, ${blocks} ABBA blocks, ` +
                `${inflight} in flight${attachOnly ? ', attach-only' : ''}`,
        );
        const results = [];
        let header = null;
        for (const condition of conditions) {
            const request = {
                path: condition.path,
                ratio: condition.ratio,
                mode: condition.mode,
                width,
                height,
                frames,
                warmup,
                blocks,
                inflight,
                attachOnly: attachOnly || condition.variant !== undefined,
                variant: condition.variant,
            };
            const raw = await evaluate(client, `window.__timerOverhead.run(${JSON.stringify(request)})`);
            if (!header) {
                header = { adapter: raw.adapter, timestampQuery: raw.timestampQuery };
                console.log(`adapter: ${JSON.stringify(raw.adapter)}, timestamp-query: ${raw.timestampQuery}\n`);
            }
            const summary = summarize(raw);
            console.log(
                `${condition.spec.padEnd(30)} render ${raw.renderSize.join('x')}\n` +
                    `  wall  on ${ms(summary.onMs)}  off ${ms(summary.offMs)}  Δ ${ms(summary.deltaMs)}  ` +
                    `overhead ${pct(summary.overhead)} (blocks ${pct(summary.overheadRange[0])} … ` +
                    `${pct(summary.overheadRange[1])}), noise floor ±${(summary.noise * 100).toFixed(2)}%\n` +
                    `  cpu   on ${ms(summary.cpuOn)}  off ${ms(summary.cpuOff)}  Δ ${ms(summary.cpuOn - summary.cpuOff)}\n` +
                    `  timer saw ${ms(summary.timerGpuMs)} upscale GPU/frame; timed ${(summary.timedShare * 100).toFixed(0)}% of on-leg frames`,
            );
            results.push({ condition, request, renderSize: raw.renderSize, summary, blocks: raw.blocks });
        }
        const pageErrors = await evaluate(client, 'window.__timerOverhead.errors');

        await mkdir(outputDirectory, { recursive: true });
        await writeFile(
            join(outputDirectory, 'summary.json'),
            `${JSON.stringify({ width, height, frames, warmup, blocks, inflight, attachOnly, ...header, results, pageErrors, logRecords }, null, 2)}\n`,
        );
        if (pageErrors.length) console.log(`\nGPU errors:\n${pageErrors.join('\n')}`);
        if (logRecords.length) console.log(`\nbrowser log:\n${logRecords.join('\n')}`);
        console.log(`\nartifacts: ${outputDirectory}`);
    } finally {
        client?.close();
        await stopChild(chrome);
        await removeTempDirectory(profile, 'Chrome profile');
        await stopChild(viteServer);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
