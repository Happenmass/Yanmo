// Windows: prepare the local environment, then download the CUDA models, without the desktop app.
// Run from the repository on the target PC: `npx tsx scripts/setup-windows-runtime.mts [--models-only]`.
// Step 2 may show a UAC prompt to enable WSL2; after the restart it asks for, run this again.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { prepareWindowsRuntime, wslPrepareModels } from '../desktop/windows-runtime.ts';
import { defaultSettings, WINDOWS_MODELS } from '../desktop/shared.ts';

const root = resolve(import.meta.dirname, '..');
if (!process.argv.includes('--models-only')) {
  const result = await prepareWindowsRuntime({ root, dataDir: join(process.env.LOCALAPPDATA!, 'Yanmo', 'wsl') }, message => console.log(message));
  if (result === 'reboot') { console.log('WSL2 已启用：请重启电脑后再次运行本脚本。'); process.exit(0); }
}
const [command, args] = wslPrepareModels(root, homedir(), ['--source', defaultSettings().modelSource, '--asr', WINDOWS_MODELS.asrModel, '--llm', WINDOWS_MODELS.llmModel]);
const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, WSL_UTF8: '1' } });
createInterface({ input: child.stdout! }).on('line', line => console.log(line));
child.on('close', code => { console.log(code === 0 ? '运行环境与模型已就绪（本地推理 P1 尚未接入）。' : '模型准备未完成，可重新运行本脚本继续。'); process.exit(code ?? 1); });
