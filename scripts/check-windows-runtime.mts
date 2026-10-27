// Read-only Windows runtime pre-check: queries nvidia-smi and, if installed, the local PyTorch runtime.
// Run on the target machine with `npx tsx scripts/check-windows-runtime.mts`; nothing is installed or uploaded.
import { join, resolve } from 'node:path';
import { decideRuntime, probeWindows } from '../desktop/precheck.ts';
import { runtimeCurrent, runtimePaths } from '../desktop/windows-runtime.ts';
import { defaultSettings } from '../desktop/shared.ts';

const paths = runtimePaths(join(process.env.LOCALAPPDATA!, 'Yanmo'), resolve(import.meta.dirname, '..'));
const environment = await probeWindows({ python: paths.python, current: runtimeCurrent(paths) });
const runtime = decideRuntime(defaultSettings().online, { asr: false, text: false }, environment);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), environment, status: runtime.status }, null, 2));
