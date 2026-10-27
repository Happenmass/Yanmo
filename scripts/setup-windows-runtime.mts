// Windows: prepare the PyTorch runtime, then download the default models, without the desktop app.
// Run from the repository on the target PC: `npx tsx scripts/setup-windows-runtime.mts <bundled python.exe> [--models-only]`.
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { prepareWindowsRuntime, runtimePaths } from '../desktop/windows-runtime.ts';
import { defaultSettings, WINDOWS_MODELS } from '../desktop/shared.ts';

const root = resolve(import.meta.dirname, '..');
const paths = runtimePaths(join(process.env.LOCALAPPDATA!, 'Yanmo'), root);
if (!process.argv.includes('--models-only')) await prepareWindowsRuntime(paths, process.argv[2], message => console.log(message));
const child = spawn(paths.python, ['-B', '-u', '-m', 'backend.prepare_models', '--without-sensevoice', '--source', defaultSettings().modelSource, '--asr', WINDOWS_MODELS.asrModel, '--llm', WINDOWS_MODELS.llmModel], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
createInterface({ input: child.stdout! }).on('line', line => console.log(line));
child.on('close', code => { console.log(code === 0 ? '运行环境与模型已就绪。' : '模型准备未完成，可重新运行本脚本继续。'); process.exit(code ?? 1); });
