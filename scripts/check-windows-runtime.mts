// Read-only Windows runtime pre-check: queries nvidia-smi and WSL, and starts only the Yanmo distribution.
// Run on the target machine with `npx tsx scripts/check-windows-runtime.mts`; nothing is installed or uploaded.
import { decideRuntime, probeWindows } from '../desktop/precheck.ts';
import { defaultSettings } from '../desktop/shared.ts';

const environment = await probeWindows();
const runtime = decideRuntime(defaultSettings().online, { asr: false, text: false }, environment);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), environment, status: runtime.status }, null, 2));
