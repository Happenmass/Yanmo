// Runtime pre-check: combines optional online endpoints with AcpmRuntime availability.
import { AcpmRuntimeInfo, Capability, CapabilitySource, OnlineEndpoint, RuntimeState } from './shared';

export function decideRuntime(online: Record<Capability, OnlineEndpoint>, acpm?: AcpmRuntimeInfo): RuntimeState {
  const asr: CapabilitySource = online.asr.enabled ? 'online' : acpm?.connected && acpm.asrReady ? 'acpm' : 'unavailable';
  const text: CapabilitySource = online.text.enabled ? 'online' : acpm?.connected && acpm.textReady ? 'acpm' : 'unavailable';
  const capabilities = { asr, text };
  const issues = asr === 'unavailable' && acpm
    ? [acpm.connected
        ? 'AcpmRuntime 中所选语音识别模型尚未安装，请在 AcpmRuntime 中安装或切换已安装模型。'
        : (acpm.error || '未检测到运行中的 AcpmRuntime，请先启动 AcpmRuntime。')]
    : [];
  if (asr !== 'unavailable') {
    return { status: text !== 'unavailable' ? 'ready' : 'asr-ready', issues, capabilities };
  }
  if (!acpm) return { status: 'checking', issues, capabilities };
  if (!acpm.connected) return { status: 'acpm-disconnected', issues, capabilities };
  return { status: 'models-pending', issues, capabilities };
}
