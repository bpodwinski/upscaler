import { spawn, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const EXAMPLES_CONFIG = join(ROOT, 'examples/vite.config.ts');
const EXAMPLE_PATH = '/13-guides-node/index.html';

export function parseArguments(argv) {
    const options = {
        buildOnly: false,
        chrome: undefined,
        keepTemp: false,
    };

    for (let index = 0; index < argv.length; index++) {
        const value = argv[index];
        if (value === '--build-only') options.buildOnly = true;
        else if (value === '--keep-temp') options.keepTemp = true;
        else if (value === '--chrome') options.chrome = argv[++index];
    }

    return options;
}

export function browserLogFailures(records) {
    return records.filter(
        (record) =>
            record.channel === 'Runtime.exceptionThrown' ||
            (record.channel === 'Runtime.consoleAPICalled' && record.level === 'error') ||
            /webgpu|wgsl|device lost|validation|invalid (compute|bind|command|shader)/i.test(record.text),
    );
}

export function assertProbeResult(result) {
    const failures = [];
    if (!result.sharedUpscaler)
        failures.push('guides and upscale nodes do not share an upscaler');
    if (!result.stableNodeIdentity)
        failures.push('guide texture-node identity changed');
    if (result.backingTextureCount < 2)
        failures.push('ping-ponged backing texture did not repoint');
    if (result.dispatchGuides <= 0)
        failures.push('dispatchGuides did not run during steady state');
    if (result.dispatchUpscale <= 0)
        failures.push('dispatchUpscale did not run during steady state');
    if (result.dispatchGuides !== result.dispatchUpscale)
        failures.push('steady-state split dispatch counts differ');
    if (result.monolithicDispatch !== 0)
        failures.push('monolithic dispatch fallback ran after warmup');
    const orderedSequence =
        result.measuredFrames > 0 &&
        result.dispatchSequence.length === result.measuredFrames * 2 &&
        result.dispatchSequence.every((event, index) => {
            const frame = Math.floor(index / 2);
            const phase = index % 2 === 0 ? 'dispatchGuides' : 'dispatchUpscale';
            return event.frame === frame && event.phase === phase;
        });
    if (!orderedSequence)
        failures.push('ordered per-frame split dispatch sequence is invalid');
    if (failures.length) throw new Error(failures.join('\n'));
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'inherit',
        ...options,
    });
    if (result.status !== 0)
        throw new Error(`${basename(command)} ${args.join(' ')} failed with status ${result.status}.`);
    return result;
}

function packLibrary(archiveDirectory) {
    const result = spawnSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', archiveDirectory],
        {
            cwd: ROOT,
            encoding: 'utf8',
        },
    );
    if (result.status !== 0)
        throw new Error(`npm pack failed:\n${result.stderr || result.stdout}`);

    const details = JSON.parse(result.stdout);
    const filename = details[0]?.filename;
    if (!filename) throw new Error('npm pack did not report an artifact filename.');
    return join(archiveDirectory, filename);
}

function unpackLibrary(archive, consumerDirectory) {
    run('tar', ['-xzf', archive, '-C', consumerDirectory]);
    const consumerModules = join(consumerDirectory, 'node_modules');
    mkdirSync(consumerModules);
    symlinkSync(join(ROOT, 'node_modules/three'), join(consumerModules, 'three'), 'dir');

    const packageDirectory = join(consumerDirectory, 'package');
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
    const packageEntry = join(packageDirectory, 'dist/index.js');

    if (manifest.name !== '@pmndrs/upscaler')
        throw new Error(`Packed artifact has unexpected package name: ${manifest.name}`);
    if (!existsSync(packageEntry))
        throw new Error('Packed artifact is missing dist/index.js.');
    if (packageEntry.startsWith(join(ROOT, 'src')))
        throw new Error('Package-consumer entry resolved to the source tree.');

    return packageEntry;
}

function buildConsumer(packageEntry, outputDirectory) {
    run(
        process.execPath,
        [
            VITE_BIN,
            'build',
            '--config',
            EXAMPLES_CONFIG,
            '--mode',
            'package-consumer',
            '--outDir',
            outputDirectory,
            '--emptyOutDir',
        ],
        {
            env: {
                ...process.env,
                PAGES_BASE: '/',
                UPSCALER_PACKAGE_ENTRY: packageEntry,
            },
        },
    );
}

async function freePort() {
    return new Promise((resolvePort, rejectPort) => {
        const server = createServer();
        server.once('error', rejectPort);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close();
                rejectPort(new Error('Unable to allocate a local port.'));
                return;
            }
            server.close(() => resolvePort(address.port));
        });
    });
}

async function waitForUrl(url, attempts = 150) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // The local process is still starting.
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`Timed out waiting for ${url}.`);
}

function chromeExecutable(explicit) {
    const candidates = [
        explicit,
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
    ].filter(Boolean);
    const executable = candidates.find(existsSync);
    if (!executable)
        throw new Error('Chrome was not found. Pass --chrome /path/to/chrome.');
    return executable;
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
            for (const listener of this.listeners.get(message.method) ?? [])
                listener(message.params);
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

function formatConsoleArgument(argument) {
    if (argument.value !== undefined) return String(argument.value);
    if (argument.unserializableValue !== undefined)
        return argument.unserializableValue;
    return argument.description ?? argument.type;
}

function attachLogCollection(client, records) {
    client.on('Log.entryAdded', ({ entry }) => {
        records.push({
            channel: 'Log.entryAdded',
            level: entry.level,
            text: entry.text,
        });
    });
    client.on('Runtime.consoleAPICalled', (event) => {
        records.push({
            channel: 'Runtime.consoleAPICalled',
            level: event.type,
            text: event.args.map(formatConsoleArgument).join(' '),
        });
    });
    client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
        records.push({
            channel: 'Runtime.exceptionThrown',
            level: 'error',
            text: exceptionDetails.exception?.description ?? exceptionDetails.text,
        });
    });
}

async function evaluate(client, expression) {
    const response = await client.call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
    });
    if (response.exceptionDetails)
        throw new Error(
            response.exceptionDetails.exception?.description ??
                response.exceptionDetails.text,
        );
    return response.result.value;
}

async function waitForExample(client) {
    for (let attempt = 0; attempt < 300; attempt++) {
        const ready = await evaluate(
            client,
            `Boolean(
                window.__guidesNodeExample?.guidesNode?.upscaler &&
                window.__guidesNodeExample?.fsrNode?.upscaler
            )`,
        );
        if (ready) return;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error('Timed out waiting for Example 13 to initialize.');
}

async function runProbe(client) {
    return evaluate(
        client,
        `(async () => {
            const waitFrame = () => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
            for (let frame = 0; frame < 30; frame++) await waitFrame();

            const api = window.__guidesNodeExample;
            const guidesNode = api.guidesNode;
            const fsrNode = api.fsrNode;
            const upscaler = fsrNode.upscaler;
            const guideNode = guidesNode.getTextureNode('dilatedDepth');
            const stableNodeIdentity = guidesNode.getTextureNode('dilatedDepth') === guideNode;
            const backingTextures = new Set([guideNode.value]);
            const measuredFrames = 16;
            const dispatchSequence = [];
            let measuredFrame = -1;
            const counts = {
                dispatchGuides: 0,
                dispatchUpscale: 0,
                monolithicDispatch: 0,
            };
            const originalGuides = upscaler.dispatchGuides;
            const originalUpscale = upscaler.dispatchUpscale;
            const originalDispatch = upscaler.dispatch;

            upscaler.dispatchGuides = function (...args) {
                counts.dispatchGuides++;
                dispatchSequence.push({ frame: measuredFrame, phase: 'dispatchGuides' });
                return originalGuides.apply(this, args);
            };
            upscaler.dispatchUpscale = function (...args) {
                counts.dispatchUpscale++;
                dispatchSequence.push({ frame: measuredFrame, phase: 'dispatchUpscale' });
                return originalUpscale.apply(this, args);
            };
            upscaler.dispatch = function (...args) {
                counts.monolithicDispatch++;
                return originalDispatch.apply(this, args);
            };

            try {
                for (let frame = 0; frame < measuredFrames; frame++) {
                    measuredFrame = frame;
                    await waitFrame();
                    backingTextures.add(guideNode.value);
                }
            } finally {
                measuredFrame = -1;
                upscaler.dispatchGuides = originalGuides;
                upscaler.dispatchUpscale = originalUpscale;
                upscaler.dispatch = originalDispatch;
            }

            return {
                sharedUpscaler: guidesNode.upscaler === upscaler,
                stableNodeIdentity:
                    stableNodeIdentity &&
                    guidesNode.getTextureNode('dilatedDepth') === guideNode,
                backingTextureCount: backingTextures.size,
                measuredFrames,
                dispatchSequence,
                ...counts,
            };
        })()`,
    );
}

async function runGpuSmoke(outputDirectory, packageEntry, options) {
    const serverPort = await freePort();
    const cdpPort = await freePort();
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    const exampleUrl = `${baseUrl}${EXAMPLE_PATH}`;
    const profile = join(tmpdir(), `upscaler-packed-guides-chrome-${process.pid}-${Date.now()}`);
    let preview;
    let chrome;
    let client;

    try {
        preview = spawn(
            process.execPath,
            [
                VITE_BIN,
                'preview',
                '--config',
                EXAMPLES_CONFIG,
                '--outDir',
                outputDirectory,
                '--host',
                '127.0.0.1',
                '--port',
                String(serverPort),
                '--strictPort',
            ],
            {
                cwd: ROOT,
                env: {
                    ...process.env,
                    PAGES_BASE: '/',
                    UPSCALER_PACKAGE_ENTRY: packageEntry,
                },
                stdio: 'ignore',
            },
        );
        await waitForUrl(exampleUrl);

        chrome = spawn(
            chromeExecutable(options.chrome),
            [
                '--headless=new',
                '--enable-unsafe-webgpu',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                `--remote-debugging-port=${cdpPort}`,
                `--user-data-dir=${profile}`,
                '--window-size=1280,720',
                '--force-device-scale-factor=1',
                'about:blank',
            ],
            { stdio: 'ignore' },
        );

        const cdpBase = `http://127.0.0.1:${cdpPort}`;
        await waitForUrl(`${cdpBase}/json/version`);
        const targetResponse = await fetch(`${cdpBase}/json/new?about:blank`, {
            method: 'PUT',
        });
        if (!targetResponse.ok)
            throw new Error(`Unable to create CDP page: ${targetResponse.status}`);
        const target = await targetResponse.json();
        client = new CdpClient(target.webSocketDebuggerUrl);

        const logRecords = [];
        attachLogCollection(client, logRecords);
        await Promise.all([
            client.call('Page.enable'),
            client.call('Runtime.enable'),
            client.call('Log.enable'),
        ]);
        await client.call('Page.navigate', { url: exampleUrl });
        await waitForExample(client);
        const probe = await runProbe(client);
        assertProbeResult(probe);

        const failures = browserLogFailures(logRecords);
        if (failures.length)
            throw new Error(
                `Browser validation failed:\n${failures.map(({ text }) => text).join('\n')}`,
            );

        console.log(
            `Packed guides GPU smoke passed: ${probe.dispatchGuides} split frames, ` +
                `${probe.backingTextureCount} backing textures, 0 monolithic fallbacks.`,
        );
    } finally {
        client?.close();
        chrome?.kill('SIGTERM');
        preview?.kill('SIGTERM');
        rmSync(profile, { recursive: true, force: true });
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const temporaryRoot = mkdtempSync(
        join(tmpdir(), `upscaler-packed-guides-${process.pid}-`),
    );
    const consumerDirectory = join(temporaryRoot, 'consumer');
    const outputDirectory = join(temporaryRoot, 'site');
    mkdirSync(consumerDirectory);

    try {
        console.log('Building @pmndrs/upscaler...');
        run('npm', ['run', 'build']);
        const archive = packLibrary(temporaryRoot);
        const packageEntry = unpackLibrary(archive, consumerDirectory);
        console.log(`Building Example 13 from ${packageEntry}...`);
        buildConsumer(packageEntry, outputDirectory);

        if (options.buildOnly) {
            console.log('Packed guides build-only verification passed.');
            return;
        }

        await runGpuSmoke(outputDirectory, packageEntry, options);
    } finally {
        if (options.keepTemp)
            console.log(`Kept packed guides consumer at ${temporaryRoot}`);
        else rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

const isMain =
    process.argv[1] !== undefined &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain)
    main().catch((error) => {
        console.error(error instanceof Error ? error.stack : error);
        process.exitCode = 1;
    });
