export interface ParsedHlc {
  ms: number;
  counter: number;
  deviceId: string;
}

export const MAX_REMOTE_CLOCK_DRIFT_MS = 300_000;
const HLC_PATTERN = /^(\d{14})-([0-9a-f]{4})-(.+)$/;

export function formatHlc(ms: number, counter: number, deviceId: string): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error(`无效的 HLC 毫秒时间戳: ${ms}`);
  }
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffff) {
    throw new Error(`无效的 HLC 计数器: ${counter}`);
  }
  const cleanDevice = deviceId.trim();
  if (!cleanDevice) {
    throw new Error('HLC deviceId 不能为空。');
  }
  const msPart = String(ms).padStart(14, '0');
  const counterPart = counter.toString(16).padStart(4, '0');
  return `${msPart}-${counterPart}-${cleanDevice}`;
}

export function parseHlc(hlc: string): ParsedHlc {
  const match = HLC_PATTERN.exec(hlc.trim());
  if (!match) {
    throw new Error(`HLC 格式无效: ${hlc}`);
  }
  const ms = Number(match[1]);
  const counter = Number.parseInt(match[2], 16);
  const deviceId = match[3];
  if (!Number.isSafeInteger(ms) || !Number.isInteger(counter) || !deviceId) {
    throw new Error(`HLC 数值无效: ${hlc}`);
  }
  return { ms, counter, deviceId };
}

export function compareHlc(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface HlcReceiveResult {
  hlc: string;
  driftClamped: boolean;
}

export class HlcClock {
  private lastMs: number;
  private counter: number;
  private readonly nowFn: () => number;

  constructor(
    readonly deviceId: string,
    initial: { lastMs?: number; counter?: number } = {},
    nowFn: () => number = () => Date.now(),
  ) {
    if (!deviceId.trim()) throw new Error('HlcClock deviceId 不能为空。');
    this.nowFn = nowFn;
    this.lastMs = initial.lastMs ?? 0;
    this.counter = initial.counter ?? 0;
  }

  snapshot(): { lastMs: number; counter: number } {
    return { lastMs: this.lastMs, counter: this.counter };
  }

  tick(): string {
    const pt = Math.max(0, Math.floor(this.nowFn()));
    if (pt > this.lastMs) {
      this.lastMs = pt;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > 0xffff) {
        this.lastMs += 1;
        this.counter = 0;
      }
    }
    return formatHlc(this.lastMs, this.counter, this.deviceId);
  }

  receive(remoteHlc: string): HlcReceiveResult {
    const parsed = parseHlc(remoteHlc);
    const pt = Math.max(0, Math.floor(this.nowFn()));
    const maxAllowedMs = pt + MAX_REMOTE_CLOCK_DRIFT_MS;
    const driftClamped = parsed.ms > maxAllowedMs;
    const effectiveRemoteMs = driftClamped ? maxAllowedMs : parsed.ms;

    const prevMs = this.lastMs;
    const nextMs = Math.max(prevMs, effectiveRemoteMs, pt);
    if (nextMs === prevMs && nextMs === effectiveRemoteMs && !driftClamped) {
      this.counter = Math.max(this.counter, parsed.counter) + 1;
    } else if (nextMs === prevMs) {
      this.counter += 1;
    } else if (nextMs === effectiveRemoteMs && !driftClamped) {
      this.counter = parsed.counter + 1;
    } else {
      this.counter = 0;
    }

    if (this.counter > 0xffff) {
      this.lastMs = nextMs + 1;
      this.counter = 0;
    } else {
      this.lastMs = nextMs;
    }

    return {
      hlc: formatHlc(this.lastMs, this.counter, this.deviceId),
      driftClamped,
    };
  }
}
