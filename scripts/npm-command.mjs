import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Invoke npm's JavaScript CLI directly, avoiding Windows .cmd shell requirements. */
export function npmInvocation(args) {
    const candidates = [
        process.env.npm_execpath,
        join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
        join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
        join(dirname(process.execPath), '../../npm/bin/npm-cli.js'),
    ];
    const cli = candidates.find(path => path && existsSync(path));
    if (cli) return [process.execPath, [cli, ...args]];
    if (process.platform !== 'win32') return ['npm', args];
    throw new Error('npm CLI not found; run this command through npm or install npm beside Node.');
}
