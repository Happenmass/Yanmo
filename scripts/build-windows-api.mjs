import { spawnSync } from 'node:child_process';
if (process.platform !== 'win32') throw new Error('Run package:win:arti on Windows x64.');
const build = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/bundle-windows-api.ps1'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
