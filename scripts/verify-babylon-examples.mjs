// Exercises the built site (including Babylon's lazy shader chunks), not Vite dev.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { browserExecutable } from './browser-executable.mjs';
import { CDP } from './cdp-client.mjs';
import { spawnVite, waitForUrl, stopChild, removeTempDirectory } from './local-processes.mjs';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(join(root, 'examples/dist/19-babylon-hello/index.html'), 'utf8');
const base = html.match(/(?:src|href)="([^" ]*)assets\//)?.[1] ?? '/';
const origin = 'http://127.0.0.1:5428';
const profile = mkdtempSync(join(tmpdir(), 'upscaler-babylon-scenes-'));
const server = spawnVite('examples/vite.config.ts', { hostname: '127.0.0.1', port: 5428 }, { windowsHide: true, extra: ['preview'], env: { ...process.env, PAGES_BASE: base } });
const artifacts = join(root, 'output/playwright/babylon-scenes'); mkdirSync(artifacts, { recursive: true });
let chrome, client;
const report = [];
function failures() {
    return client.events.filter(e => e.method === 'Runtime.exceptionThrown' || e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' || e.method === 'Network.responseReceived' && e.params.response.status >= 400).map(e => e.method === 'Network.responseReceived' ? `${e.params.response.status} ${e.params.response.url}` : JSON.stringify(e.params));
}
async function waitFrames(target = 20) {
    for (let i = 0; i < 900; i++) {
        assert.deepEqual(failures(), [], 'Browser/HTTP error');
        if (await client.evaluate(`window.__BabylonSceneDemo?.frames >= ${target}`)) return;
        await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('No rendered frames: ' + await client.evaluate("document.querySelector('#status')?.textContent"));
}
async function settle(count = 24) { await waitFrames(await client.evaluate('window.__BabylonSceneDemo.frames') + count); }
async function probe() {
    const value = await client.evaluate('window.__BabylonSceneDemo.probe()');
    for (const key of ['output', 'depth', 'motion', 'reactive', 'native']) assert.ok(value[key].finite, key + ' must be finite');
    assert.ok(value.output.max > 0.1 && value.output.meanAbs > 0.01, 'Nonempty output');
    assert.ok(value.output.max - value.output.min > 0.1, 'The scene must have RGB contrast');
    assert.ok(value.depth.min > 0 && value.depth.max <= 120, 'Finite positive depth, including background');
    assert.deepEqual(await client.evaluate('window.__BabylonSceneDemo.errors'), []);
    assert.deepEqual(failures(), []);
    return value;
}
try {
    await waitForUrl(origin + base, { child: server });
    chrome = spawn(browserExecutable(), ['--headless=new', '--enable-unsafe-webgpu', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--remote-debugging-port=9548', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    await waitForUrl('http://127.0.0.1:9548/json/version');
    const target = await (await fetch('http://127.0.0.1:9548/json/new?about:blank', { method: 'PUT' })).json();
    client = await CDP.connect(target.webSocketDebuggerUrl);
    await client.send('Runtime.enable'); await client.send('Network.enable'); await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const example of ['19-babylon-hello', '20-babylon-aliasing', '21-babylon-compare', '22-babylon-transparency']) {
        client.events.length = 0;
        await client.send('Page.navigate', { url: origin + base + example + '/' }); await waitFrames();
        const moving = await probe();
        await client.evaluate("document.querySelector('#objects').checked = false"); await settle();
        const stationary = await probe();
        if (example.includes('hello')) assert.ok(stationary.output.cyanY > 0 && stationary.output.cyanY < stationary.output.amberY, 'The higher cyan knot must appear above the lower amber cube (offscreen Y orientation)');
        assert.ok(stationary.motion.meanAbs < 1e-6, 'Static scene motion must exclude jitter: ' + stationary.motion.meanAbs);
        assert.ok(moving.motion.meanAbs > stationary.motion.meanAbs, 'Moving meshes must publish motion');
        await client.evaluate("document.querySelector('#camera').checked = true"); await settle();
        const camera = await probe(); assert.ok(camera.motion.meanAbs > 1e-6, 'Camera motion must be represented');
        await client.evaluate("document.querySelector('#camera').checked = false"); await settle();
        if (example.includes('transparency')) {
            assert.ok(camera.reactive.max > 0.1 && camera.reactive.meanAbs > 0.0001, 'Transparent geometry must generate reactivity');
            await client.evaluate("document.querySelector('#reactive').checked = false"); await settle();
            assert.equal((await probe()).reactive.max, 0, 'Disabled mask must be zero');
            await client.evaluate("document.querySelector('#reactive').checked = true");
        } else assert.equal(stationary.reactive.max, 0);
        if (example.includes('compare')) {
            assert.ok(Math.abs(stationary.native.meanAbs - stationary.output.meanAbs) < 0.05, 'Native and reconstructed images must use the same brightness');
            for (const value of [0, 100, 50]) { await client.evaluate(`document.querySelector('#split').value = ${value}`); await settle(2); }
        }
        await client.evaluate("document.querySelector('#mode').value = 'bilinear'"); await settle(); const bilinear = await probe();
        await client.evaluate("document.querySelector('#mode').value = 'temporal'"); await settle(); const reactivated = await probe();
        await client.evaluate('window.__BabylonSceneDemo.reset()'); await settle();
        for (const optimize of [false, true]) {
            await client.evaluate(`window.__BabylonSceneDemo.resize(967, 543, 1.5, ${optimize})`); await settle();
            const resized = await probe(); assert.equal(resized.config.renderWidth, 644); assert.equal(resized.config.displayHeight, 543);
        }
        await client.evaluate('window.__BabylonSceneDemo.resize(961, 539, 1)'); await settle(40);
        const nativeAA = await probe(); assert.equal(nativeAA.config.renderWidth, 961);
        const shot = await client.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(artifacts, example + '.png'), Buffer.from(shot.data, 'base64'));
        report.push({ example, moving, stationary, camera, bilinear, reactivated, nativeAA });
        console.log(example + ': mesh/camera motion, jitter removal, mask, fallback, odd resize, aliasing and NativeAA passed');
    }
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await settle(30);
    assert.equal(await client.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Mobile controls must fit');
    writeFileSync(join(artifacts, 'mobile.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    writeFileSync(join(artifacts, 'report.json'), JSON.stringify(report, null, 2));
} finally {
    await client?.send('Browser.close', {}, 3000).catch(() => {}); client?.close();
    await stopChild(chrome); await stopChild(server); await removeTempDirectory(profile, 'Babylon examples Chrome profile');
}
