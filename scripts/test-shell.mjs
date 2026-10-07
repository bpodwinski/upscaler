import { existsSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

export function shellPath(path) {
    if (process.platform !== 'win32') return path;
    return path.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => '/' + drive.toLowerCase() + '/');
}
export function shellQuote(value) {
    return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
const candidates = [process.env.GIT_BASH_PATH,
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Git/bin/bash.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Git/bin/bash.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs/Git/bin/bash.exe')];
export const bash = process.platform === 'win32' ? candidates.find(path => path && existsSync(path)) : 'bash';
if (!bash) throw new Error('Release workflow tests need Git Bash. Set GIT_BASH_PATH to its bash.exe; WSL Bash is not suitable.');

export function shellEnvironment(extra = {}, bins = []) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
    const path = process.env.PATH ?? process.env.Path ?? '';
    const tools = process.platform === 'win32' ? [join(dirname(bash), '../usr/bin')] : [];
    return { ...inherited, ...extra, PATH: [...bins, ...tools, ...path.split(delimiter)].map(shellPath).join(':') };
}
export function which(command) {
    const result = spawnSync(bash, ['-c', 'command -v "$1"', 'resolve', command], {
        env: shellEnvironment(), encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error('Could not resolve ' + command + ' in Git Bash: ' + (result.stderr ?? result.error));
    return result.stdout.trim();
}
