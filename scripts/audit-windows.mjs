import { CDP } from './cdp-client.mjs';
import { browserExecutable } from './browser-executable.mjs';
/**
 * Reproducible Chrome/Edge demo smoke capture. Use an explicit browser executable.
 * Profiles and screenshots belong to this run; no personal browser profile is used.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseFlags } from './cli-flags.mjs';
import { removeTempDirectory, spawnVite, stopChild, waitForUrl } from './local-processes.mjs';

const options = parseFlags(process.argv.slice(2), ['browser', 'out', 'demos', 'port', 'cdp-port', 'runs', 'trace', 'exercise', 'help']);
if (options.help) {
    console.log('Usage: node scripts/audit-windows.mjs --browser <chrome.exe|msedge.exe> [--demos 01-hello,07-tsl-node] [--runs 3] [--trace] [--out directory]');
    process.exit(0);
}
const selectedBrowser = browserExecutable(options.browser);
const demos = String(options.demos ?? '01-hello,02-fsr1-vs-fsr3,03-split-compare,04-aliasing-torture,05-transparency,06-screenspace-gi,07-tsl-node,08-tsl-compose,09-kitchen-sink,10-ssgi-denoise,11-node-reactive,12-temporal-guides,13-guides-node,14-pathtracer-alpha,15-transparent-canvas,16-spatial-node,s1-reinvest,s2-fractal,s3-how-low,s4-convergence').split(',');
const out = resolve(String(options.out ?? 'bench/results/windows-local'));
const port = Number(options.port ?? 5301);
const cdpPort = Number(options['cdp-port'] ?? 9341);
const runs = Number(options.runs ?? 1);
await mkdir(out, { recursive: true });

const instrumentation = `
(() => {
    const a = window.__audit = { modules: [], pipelines: [], sync: 0, submits: 0, frames: 0, maxFrameGap: 0 };
    let previous = performance.now();
    function frame(now) { a.frames++; a.maxFrameGap = Math.max(a.maxFrameGap, now - previous); previous = now; requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
    if (!window.GPUDevice) return;
    const module = GPUDevice.prototype.createShaderModule;
    GPUDevice.prototype.createShaderModule = function(d) { a.modules.push({ label: d.label, chars: d.code.length }); return module.call(this, d); };
    const sync = GPUDevice.prototype.createComputePipeline;
    GPUDevice.prototype.createComputePipeline = function(d) { a.sync++; return sync.call(this, d); };
    const async = GPUDevice.prototype.createComputePipelineAsync;
    GPUDevice.prototype.createComputePipelineAsync = function(d) {
        const record = { label: d.label, start: performance.now(), end: null, error: null };
        a.pipelines.push(record);
        return async.call(this, d).then(p => { record.end = performance.now(); return p; }, e => { record.error = String(e); record.end = performance.now(); throw e; });
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function(commands) { a.submits++; if (!a.firstSubmit) a.firstSubmit = performance.now(); return submit.call(this, commands); };
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = function(d) {
        a.adapter = { vendor: this.info?.vendor, architecture: this.info?.architecture, device: this.info?.device, description: this.info?.description };
        return request.call(this, d).then(device => { a.features = [...device.features]; device.lost.then(info => a.lost = { reason: info.reason, message: info.message }); return device; });
    };
})();
`;

const server = spawnVite('examples/vite.config.ts', { hostname: '127.0.0.1', port });
const report = { date: new Date().toISOString(), browser: selectedBrowser, node: process.version, platform: process.platform, records: [] };
try {
    await waitForUrl('http://127.0.0.1:' + port, { child: server });
    for (let run = 0; run < runs; run++) {
      for (const demo of demos) {
        const profile = await mkdtemp(join(tmpdir(), 'upscaler-audit-'));
        const browser = spawn(selectedBrowser, ['--headless=new', '--enable-unsafe-webgpu', '--no-first-run', '--no-default-browser-check',
            '--remote-debugging-port=' + cdpPort, '--user-data-dir=' + profile, '--window-size=960,640', 'about:blank'], { stdio: 'ignore', windowsHide: true });
        let browserClient;
        try {
            await waitForUrl('http://127.0.0.1:' + cdpPort + '/json/version', { child: browser });
            const version = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).json();
            browserClient = await CDP.connect(version.webSocketDebuggerUrl);
            report.browserVersion = version.Browser;
            {
                const target = await (await fetch('http://127.0.0.1:' + cdpPort + '/json/new?about:blank', { method: 'PUT' })).json();
                const client = await CDP.connect(target.webSocketDebuggerUrl);
                try {
                    await client.send('Page.enable'); await client.send('Runtime.enable'); await client.send('Log.enable');
                    await client.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
                    if (options.trace) {
                        const categories = ['gpu.dawn', 'gpu.dawn.validation', 'toplevel'];
                        report.traceCategories = categories;
                        await client.send('Tracing.start', { categories: categories.join(','), transferMode: 'ReportEvents' });
                    }
                    for (const cache of ['cold', 'warm']) {
                        client.events = [];
                        await client.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' + demo + '/' });
                        const start = Date.now();
                        let snapshot;
                        while (Date.now() - start < (demo === '14-pathtracer-alpha' ? 60000 : 20000)) {
                            await delay(500);
                            snapshot = await client.evaluate('({audit:window.__audit, fatal:document.getElementById("fatal")?.textContent, canvas:!!document.querySelector("canvas")})');
                            if (snapshot?.audit?.submits > 30 && snapshot.audit.pipelines.every(p => p.end !== null)) break;
                            if (snapshot?.fatal) break;
                        }
                        await delay(1000);
                        snapshot = await client.evaluate('({audit:window.__audit, fatal:document.getElementById("fatal")?.textContent, canvas:!!document.querySelector("canvas")})');
                        const prefix = demo + '-r' + run + '-' + cache;
                        const screenshot = await client.send('Page.captureScreenshot', { format: 'png' });
                        await writeFile(join(out, prefix + '.png'), Buffer.from(screenshot.data, 'base64'));
                        const issues = client.events.filter(e =>
                            e.method === 'Runtime.exceptionThrown' ||
                            (e.method === 'Log.entryAdded' && ['error','warning'].includes(e.params.entry.level)) ||
                            (e.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(e.params.type)));
                        const record = { demo, run, cache, elapsedMs: Date.now() - start, snapshot, issues };
                        report.records.push(record);
                        await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
                        console.log(JSON.stringify({ demo, run, cache, sync: snapshot.audit?.sync, async: snapshot.audit?.pipelines.length, submits: snapshot.audit?.submits, issues: issues.length, fatal: snapshot.fatal }));
                    }
                    if (options.exercise) {
                        for (const metrics of [
                            { width: 800, height: 600, deviceScaleFactor: 2, mobile: false },
                            { width: 960, height: 640, deviceScaleFactor: 1, mobile: false },
                        ]) {
                            await client.send('Emulation.setDeviceMetricsOverride', metrics);
                            await delay(1500);
                        }
                        const controls = await client.evaluate(`(async () => {
                            const changed = [];
                            for (const select of document.querySelectorAll('select')) {
                                const original = select.value;
                                for (const option of select.options) {
                                    select.value = option.value;
                                    select.dispatchEvent(new Event('change', { bubbles: true }));
                                    changed.push(option.text);
                                    await new Promise(r => setTimeout(r, 250));
                                }
                                select.value = original;
                                select.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                            return changed;
                        })()`);
                        await delay(1000);
                        let primitives = null;
                        if (demo === '13-guides-node') {
                            const libraryUrl = '/@fs/' + resolve(import.meta.dirname, '../src/index.ts').replaceAll('\\', '/');
                            primitives = await client.evaluate(`(async () => {
                                const lib = await import(${JSON.stringify(libraryUrl)});
                                const api = window.__guidesNodeExample;
                                const upscaler = api.fsrNode.upscaler;
                                const moments = new lib.MomentsPass({ renderer: api.renderer });
                                moments.configure({ width: upscaler.displayWidth, height: upscaler.displayHeight });
                                await moments.init();
                                moments.dispatch({ source: upscaler.outputTexture });
                                await api.renderer.backend.device.queue.onSubmittedWorkDone();
                                const momentsReady = moments.isReady;
                                moments.dispose();
                                const adapter = await navigator.gpu.requestAdapter();
                                const device = await adapter.requestDevice();
                                const separate = new lib.Upscaler({ renderer: { backend: { device } } });
                                const supported = lib.Upscaler.isSupported(device);
                                await separate.init();
                                const readyBeforeLoss = separate.isReady;
                                device.destroy();
                                await device.lost;
                                const readyAfterLoss = separate.isReady;
                                let lossRejected = false;
                                try { await separate.prepare(); } catch { lossRejected = true; }
                                separate.dispose();
                                return { momentsReady, supported, readyBeforeLoss, readyAfterLoss, lossRejected };
                            })()`);
                        }
                        const errors = client.events.filter(e => e.method === 'Runtime.exceptionThrown' ||
                            (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !e.params.entry.url?.endsWith('/favicon.ico')) ||
                            (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
                        const finalAudit = await client.evaluate("window.__audit");
                        report.records.push({ demo, run, exercise: { resize: true, dpr: true, controls, primitives, syncComputeCalls: finalAudit.sync }, issues: errors });
                        console.log(JSON.stringify({ demo, run, exercise: true, controls: controls.length, errors: errors.length }));
                    }
                    if (options.trace) {
                        await client.send('Tracing.end');
                        for (let i = 0; i < 100 && !client.events.some(e => e.method === 'Tracing.tracingComplete'); i++) await delay(100);
                        const events = client.events.filter(e => e.method === 'Tracing.dataCollected').flatMap(e => e.params.value);
                        await writeFile(join(out, demo + '-r' + run + '-trace.json'), JSON.stringify({ traceEvents: events }));
                    }
                } catch (error) {
                    report.records.push({ demo, run, error: String(error) });
                    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
                    console.error(demo, String(error));
                } finally {
                    client.close();
                    await fetch('http://127.0.0.1:' + cdpPort + '/json/close/' + target.id);
                }
            }
        } finally {
            if (browserClient) {
                await browserClient.send('Browser.close', {}, 2000).catch(() => {});
                browserClient.close();
            }
            await stopChild(browser);
            const ownedProfile = resolve(profile);
            if (dirname(ownedProfile) === resolve(tmpdir()) && basename(ownedProfile).startsWith('upscaler-audit-'))
                await removeTempDirectory(ownedProfile, 'audit profile');
            else console.error('Refusing to remove a profile outside this audit\'s temporary directory.');
        }
      }
    }
} finally { await stopChild(server); }
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
