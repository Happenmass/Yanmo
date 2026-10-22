import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { mkdirSync } from 'node:fs';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
run('npx', ['tsc', '--noEmit']);
mkdirSync('.electron', { recursive: true });
if (process.platform === 'darwin') {
  run('swift', ['build', '-c', 'release', '--product', 'YanmoBridge']);
  run('swift', ['scripts/make-tray.swift', '.electron/tray.png']);
  mkdirSync('.build/Yanmo.iconset', { recursive: true });
  run('swift', ['scripts/make-icon.swift', '.build/Yanmo.iconset']);
  run('iconutil', ['-c', 'icns', '.build/Yanmo.iconset', '-o', '.electron/Yanmo.icns']);
}
await buildWeb();
for (const entry of ['main', 'preload']) {
  await build({ entryPoints: ['desktop/' + entry + '.ts'], outfile: '.electron/' + entry + '.cjs',
    platform: 'node', target: 'node22', format: 'cjs', bundle: true, external: ['electron'] });
}
