#!/usr/bin/env node
// Runs the RGBA-passthrough A/B: `alpha-rgba-v1` (production, alpha on) against
// `alpha-opaque-v1` (production, alpha off — shaders byte-identical to the
// pre-alpha pipeline). Both sides are the same resolver on the same RCAS
// shader, so an interleaved run isolates the cost of alpha and nothing else.
//
//   npm run bench:alpha            local Chrome
//   npm run bench:alpha:device     a phone over remote debugging
//
// Anything extra is forwarded to run-benchmark.mjs, and repeating a flag wins
// over the defaults here (the parser there takes the last occurrence), so
// `npm run bench:alpha -- --ratios 2 --blocks 8` narrows the run.
//
// Evidence + the numbers this reproduces: bench/docs/NEXT-STEPS.md §6.
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH_PORT = 5199;
const DEFAULT_DEVICE_CDP = 'http://127.0.0.1:9222';

const passthrough = process.argv.slice(2).filter((arg) => arg !== '--device');
const device = process.argv.includes('--device');
const cdpIndex = passthrough.indexOf('--cdp');
const cdp = device ? (cdpIndex === -1 ? DEFAULT_DEVICE_CDP : passthrough[cdpIndex + 1]) : null;

function fail(message) {
    console.error(`\n${message}\n`);
    process.exit(1);
}

// The device has to reach two things: its own debugging port (so we can drive
// it) and the bench dev server on the *host*. run-benchmark.mjs hardcodes
// http://127.0.0.1:5199, which on a phone means the phone — `adb reverse` is
// what makes that address resolve back to this machine. Checking both here
// turns two silent timeouts into one actionable message.
async function preflightDevice() {
    let version;
    try {
        const response = await fetch(`${cdp}/json/version`, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        version = await response.json();
    } catch (error) {
        fail(
            `No DevTools endpoint at ${cdp} (${error instanceof Error ? error.message : error}).\n\n` +
                'For an Android device with USB debugging on:\n' +
                '  adb forward tcp:9222 localabstract:chrome_devtools_remote\n' +
                '  adb reverse tcp:5199 tcp:5199\n\n' +
                'Then re-run. Pass --cdp <url> if your endpoint is elsewhere.\n' +
                'iOS is not supported: Safari exposes no CDP, so this harness cannot drive it.',
        );
    }

    console.log(`Device browser: ${version['User-Agent'] ?? version.Browser ?? 'unknown'}`);

    // Soft check — adb may not be installed, or the endpoint may be reached some
    // other way (a LAN proxy, a tunnel). Warn rather than block.
    try {
        const { stdout } = await execFileAsync('adb', ['reverse', '--list']);
        if (!stdout.includes(`tcp:${BENCH_PORT}`)) {
            console.warn(
                `\nWarning: adb has no reverse mapping for tcp:${BENCH_PORT}. The device will load\n` +
                    `its own localhost and the run will time out waiting for the bench API.\n` +
                    `Fix with:  adb reverse tcp:${BENCH_PORT} tcp:${BENCH_PORT}\n`,
            );
        }
    } catch {
        console.log(
            `(adb not available — make sure the device can reach this machine's :${BENCH_PORT}.)`,
        );
    }

    console.log(
        '\nNote: timestamp-query is often absent on mobile browsers. GpuTimer no-ops when it\n' +
            'is, so the per-pass map comes back empty and only frame time is available.\n',
    );
}

if (device) await preflightDevice();

const args = [
    join(ROOT, 'scripts', 'run-benchmark.mjs'),
    '--smoke',
    '--ratios',
    '1,2,3',
    '--blocks',
    '4',
    '--warmup',
    '240',
    '--samples',
    '300',
    '--variant',
    'alpha-rgba-v1',
    '--comparison',
    'alpha-opaque-v1',
    ...(device && cdpIndex === -1 ? ['--cdp', cdp] : []),
    ...passthrough,
];

const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
