// Runtime pre-check: probes the Windows local environment and decides the shared runtime status.
// See docs/architecture/electron_01_Runtime_运行时与预检查.md.
import { execFile } from 'node:child_process';
import { arch } from 'node:os';
import { Capability, LocalEnvironment, OnlineEndpoint, RuntimeState } from './shared';

// The locked PyTorch is the CUDA 13.0 build, which dropped Maxwell, Pascal and Volta.
const MIN_COMPUTE = 7.5;
// Single quotes only, so Windows command-line quoting cannot alter it.
const CUDA_PROBE = "import json,torch;c=torch.cuda.is_available();print(json.dumps({'cuda':c,'device':torch.cuda.get_device_name(0) if c else '','torch':torch.__version__}))";

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; missing?: boolean; stdout: string }>;
export const runCommand: Run = (file, args, timeoutMs) => new Promise(resolve => {
  execFile(file, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
    resolve({ ok: !error, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT', stdout });
  });
});

export function parseGPUs(stdout: string) {
  return stdout.split(/\r?\n/).map(line => line.split(',').map(part => part.trim())).filter(parts => parts[0])
    .map(([name, memory, compute]) => ({ name, memoryMB: Number(memory) || 0, compute: compute && Number.isFinite(Number(compute)) ? Number(compute) : undefined }));
}

/** runtime.current: the local runtime's completion marker matches the shipped lock. */
export async function probeWindows(runtime: { python: string; current: boolean }, run: Run = runCommand, cpu: string = arch()): Promise<LocalEnvironment> {
  if (cpu !== 'x64') return { environment: 'unsupported', issues: ['本地模式仅支持 x64 Windows。'] };
  const query = ['--format=csv,noheader,nounits'];
  let smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,compute_cap', ...query], 15000);
  // Older drivers reject the compute_cap field; the CUDA step then decides.
  if (!smi.ok && !smi.missing) smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', ...query], 15000);
  const gpus = smi.ok ? parseGPUs(smi.stdout) : [];
  if (!gpus.length) return { environment: 'unsupported', issues: ['未检测到 NVIDIA GPU 或驱动。'] };
  const gpu = gpus.filter(item => item.compute === undefined || item.compute >= MIN_COMPUTE).sort((a, b) => b.memoryMB - a.memoryMB)[0];
  if (!gpu) return { environment: 'unsupported', issues: [`${gpus[0].name} 的 CUDA 算力 ${gpus[0].compute} 低于 CUDA 13 运行库要求的 ${MIN_COMPUTE}。`] };
  const label = gpu.name + (gpu.memoryMB ? ` · ${Math.round(gpu.memoryMB / 1024)} GB` : '');
  const repair = (issue: string): LocalEnvironment => ({ environment: 'repair', issues: [issue], gpu: label });
  if (!runtime.current) return repair('言墨本地运行库尚未安装或需要更新。');
  const probe = await run(runtime.python, ['-c', CUDA_PROBE], 120000);
  let cuda = false;
  try { cuda = probe.ok && JSON.parse(probe.stdout.trim().split(/\r?\n/).pop()!).cuda === true; } catch { /* Unreadable output counts as unavailable. */ }
  if (!cuda) return repair('本地运行库无法使用 CUDA：请更新 NVIDIA 驱动后重新检测。');
  return { environment: 'ready', issues: [], gpu: label };
}

export function decideRuntime(online: Record<Capability, OnlineEndpoint>, models: Record<Capability, boolean>, local?: LocalEnvironment): RuntimeState {
  const capability = (name: Capability) => online[name].enabled ? 'online' as const : local?.environment === 'ready' && models[name] ? 'local' as const : 'unavailable' as const;
  const capabilities = { asr: capability('asr'), text: capability('text') };
  const values = Object.values(capabilities);
  const base = { issues: local?.issues ?? [], gpu: local?.gpu, capabilities };
  if (!values.includes('unavailable')) return { ...base, status: values.includes('online') ? 'online-ready' : 'local-ready' };
  if (!local) return { ...base, status: 'checking' };
  if (local.environment === 'repair') return { ...base, status: 'local-repair' };
  if (local.environment === 'ready') return { ...base, status: 'models-pending' };
  return { ...base, status: values.includes('online') ? 'api-pending' : 'recommend-online' };
}
