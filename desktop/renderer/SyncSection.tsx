import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AcpmPairedDeviceDTO } from '../acpm';
import type { AppState, SyncHubSummary } from '../shared';
import { encodeQrMatrix } from './qrcode';

type ActionResult<T = unknown> = { ok: boolean; data?: T; error?: string };

const invoke = <T = unknown>(action: string, args?: unknown) =>
  window.yanmo.invoke(action, args) as Promise<ActionResult<T>>;

type ActiveQr =
  | { kind: 'invite'; qrUri: string; expiresAtMs: number; scopes: ('inference' | 'yanmo.sync')[] }
  | { kind: 'join_wait'; qrUri: string; sessionId: string; expiresAtMs: number };

function shortVaultId(vaultId?: string): string {
  if (!vaultId) return '';
  if (vaultId.length <= 10) return vaultId;
  return `${vaultId.slice(0, 4)}…${vaultId.slice(-4)}`;
}

function formatHost(urlStr?: string): string {
  if (!urlStr) return '';
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname;
  } catch {
    return urlStr;
  }
}

function formatRelativeTime(timestampMs?: number, nowMs = Date.now()): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 60) return '刚刚';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay === 1) return '昨天';
  return `${diffDay} 天前`;
}

function platformLabel(platform: string): string {
  if (platform === 'macos') return 'macOS';
  if (platform === 'windows') return 'Windows';
  if (platform === 'android') return 'Android';
  return platform;
}

function formatCountdown(expiresAtMs: number, nowMs: number): string {
  const remainSec = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  if (remainSec <= 0) return '已过期';
  if (remainSec < 60) return `${remainSec} 秒`;
  const min = Math.ceil(remainSec / 60);
  return `${min} 分钟`;
}

function QrSvg({ text }: { text: string }) {
  const matrix = useMemo(() => {
    try {
      return encodeQrMatrix(text);
    } catch {
      return null;
    }
  }, [text]);
  if (!matrix) return null;
  const n = matrix.length;
  const quiet = 4;
  const total = n + quiet * 2;
  const cells: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        cells.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  return (
    <svg className="sync-qr-svg" viewBox={`0 0 ${total} ${total}`} role="img" aria-label="配对二维码">
      <rect width={total} height={total} fill="#faf7f1" />
      <path d={cells.join('')} fill="#1f1d1a" shapeRendering="crispEdges" />
    </svg>
  );
}

export function SyncSection({ state }: { state: AppState }) {
  const sync = state.sync;
  const enabled = Boolean(sync?.enabled);
  const { settings } = state;

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [inviteScope, setInviteScope] = useState<'full' | 'inference'>('full');
  const [activeQr, setActiveQr] = useState<ActiveQr | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [joinFormOpen, setJoinFormOpen] = useState(false);
  const [joinInput, setJoinInput] = useState('');
  const [editingHubId, setEditingHubId] = useState<string | null>(null);
  const [hubUrlInput, setHubUrlInput] = useState('');
  const [devices, setDevices] = useState<AcpmPairedDeviceDTO[]>([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    if (!enabled) {
      setDevices([]);
      setDevicesLoaded(false);
      return;
    }
    const res = await invoke<AcpmPairedDeviceDTO[]>('syncListDevices');
    if (res.ok && Array.isArray(res.data)) {
      setDevices(res.data.filter(d => d.revoked_at_ms === null || d.revoked_at_ms === undefined));
      setDevicesLoaded(true);
    }
  }, [enabled]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    if (!activeQr) return;
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeQr]);

  // Poll join_wait completion while waiting for an already-paired device to scan.
  useEffect(() => {
    if (activeQr?.kind !== 'join_wait') return;
    let cancelled = false;
    const sessionId = activeQr.sessionId;
    const timer = setInterval(() => {
      if (cancelled || Date.now() >= activeQr.expiresAtMs) return;
      void window.yanmo.invoke('syncCompleteJoinWait', { sessionId }).then(raw => {
        const res = raw as ActionResult;
        if (!cancelled && res.ok) {
          setActiveQr(null);
          void loadDevices();
        }
      }).catch(() => {});
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeQr, loadDevices]);

  const runAction = async <T,>(key: string, action: string, args?: unknown): Promise<ActionResult<T>> => {
    setBusyAction(key);
    try {
      return await invoke<T>(action, args);
    } finally {
      setBusyAction(null);
    }
  };

  const enableLocal = async () => {
    const res = await runAction('enable', 'syncEnableLocal');
    if (res.ok) await loadDevices();
  };

  const syncNow = async (hubId?: string) => {
    const res = await runAction(hubId ? `sync:${hubId}` : 'syncAll', 'syncNow', {
      ...(hubId ? { hubId } : {}),
      uploadBlobs: settings.syncAutoCacheBlobs,
    });
    if (res.ok) await loadDevices();
  };

  const toggleRecoveryCode = async () => {
    if (recoveryCode) {
      setRecoveryCode(null);
      return;
    }
    const res = await runAction<{ recoveryCode: string }>('recovery', 'syncExportRecoveryCode');
    if (res.ok && res.data?.recoveryCode) {
      setRecoveryCode(res.data.recoveryCode);
    }
  };

  const disableSync = async () => {
    const res = await runAction('disable', 'syncDisable');
    if (res.ok) {
      setActiveQr(null);
      setRecoveryCode(null);
      setDevices([]);
      setDevicesLoaded(false);
    }
  };

  const createInvite = async () => {
    const scopes: ('inference' | 'yanmo.sync')[] =
      inviteScope === 'inference' ? ['inference'] : ['inference', 'yanmo.sync'];
    const res = await runAction<{ qrUri: string; expiresAtMs: number }>('invite', 'syncCreateInvite', { scopes });
    if (res.ok && res.data?.qrUri) {
      setActiveQr({ kind: 'invite', qrUri: res.data.qrUri, expiresAtMs: res.data.expiresAtMs, scopes });
    }
  };

  const startJoinWait = async () => {
    const res = await runAction<{ qrUri: string; sessionId: string; expiresAtMs: number }>('joinWait', 'syncCreateJoinWait');
    if (res.ok && res.data?.qrUri) {
      setActiveQr({
        kind: 'join_wait',
        qrUri: res.data.qrUri,
        sessionId: res.data.sessionId,
        expiresAtMs: res.data.expiresAtMs,
      });
    }
  };

  const submitJoinInput = async () => {
    const trimmed = joinInput.trim();
    if (!trimmed) return;
    const isRecovery = /^ym1-/i.test(trimmed);
    const res = isRecovery
      ? await runAction('joinSubmit', 'syncRestoreRecoveryCode', { code: trimmed })
      : await runAction('joinSubmit', 'syncRedeemInvite', { qr: trimmed });
    if (res.ok) {
      setJoinInput('');
      setJoinFormOpen(false);
      await loadDevices();
    }
  };

  const discoverHubs = async () => {
    await runAction('discover', 'syncDiscoverHubs', { timeoutMs: 2500 });
  };

  const openHubEditor = (hub: SyncHubSummary) => {
    if (editingHubId === hub.hubInstanceId) {
      setEditingHubId(null);
      return;
    }
    setEditingHubId(hub.hubInstanceId);
    setHubUrlInput(hub.manualRemoteUrl || hub.lastKnownUrl || '');
  };

  const saveHubUrl = async (hubId: string) => {
    const res = await runAction(`hubUrl:${hubId}`, 'syncSetHubUrl', { hubId, manualRemoteUrl: hubUrlInput.trim() });
    if (res.ok) setEditingHubId(null);
  };

  const revokeDevice = async (deviceId: string) => {
    const res = await runAction(`revoke:${deviceId}`, 'syncRevokeDevice', { deviceId });
    if (res.ok) {
      setDevices(prev => prev.filter(d => d.device_id !== deviceId));
    }
  };

  const copyText = async (label: string, text: string) => {
    await invoke('copyText', text);
    setCopiedLabel(label);
    setTimeout(() => setCopiedLabel(prev => (prev === label ? null : prev)), 1500);
  };

  const discoveredSet = new Set(sync?.discoveredHubIds ?? []);
  const spoofedCount = sync?.spoofedHubIds?.length ?? 0;

  const qrExpired = activeQr ? nowMs >= activeQr.expiresAtMs : false;
  const qrCaption = activeQr
    ? activeQr.kind === 'join_wait'
      ? `等待已有设备扫码 · ${formatCountdown(activeQr.expiresAtMs, nowMs)}内有效`
      : activeQr.scopes.includes('yanmo.sync')
        ? `仅限本人扫码 · ${formatCountdown(activeQr.expiresAtMs, nowMs)}内单次有效`
        : `仅共享推理算力 · ${formatCountdown(activeQr.expiresAtMs, nowMs)}内单次有效`
    : '';

  return (
    <section className="preference-section sync-section">
      <h3>跨端同步</h3>

      {sync?.error && (
        <p className="sync-warning" role="status">
          △ {sync.error}
        </p>
      )}

      <div className="sync-status-row">
        {enabled ? (
          <>
            <div className="sync-status-meta">
              <span className="model-dot">
                <i className="ready" />
                跨端同步 · 已开启（端到端加密）
              </span>
              {sync?.vaultId && <span className="sync-vault-id">空间 {shortVaultId(sync.vaultId)}</span>}
            </div>
            <div className="sync-status-actions">
              <button className="button primary compact" disabled={busyAction !== null} onClick={() => void syncNow()}>
                {busyAction === 'syncAll' ? '正在同步…' : '立即同步'}
              </button>
              <button className="text-button sync-link" disabled={busyAction !== null} onClick={() => void toggleRecoveryCode()}>
                {recoveryCode ? '隐藏恢复码' : '查看恢复码'}
              </button>
              <button className="text-button sync-link" disabled={busyAction !== null} onClick={() => void disableSync()}>
                停用同步
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="sync-status-meta">
              <span className="model-dot">
                <i />
                跨端同步 · 未开启
              </span>
            </div>
            <div className="sync-status-actions">
              <button className="button primary compact" disabled={busyAction !== null} onClick={() => void enableLocal()}>
                {busyAction === 'enable' ? '正在开启…' : '开启跨端同步'}
              </button>
              <button className="text-button sync-link" disabled={busyAction !== null} onClick={() => void startJoinWait()}>
                等待已有设备扫码
              </button>
              <button className="text-button sync-link" disabled={busyAction !== null} onClick={() => setJoinFormOpen(v => !v)}>
                扫码 / 粘贴加入
              </button>
            </div>
          </>
        )}
      </div>

      {recoveryCode && (
        <div className="sync-inline-box" role="region" aria-label="空间恢复码">
          <div className="sync-inline-header">
            <span>个人空间恢复码（请抄录并离线妥善保存）</span>
            <div className="sync-inline-ops">
              <button className="text-button sync-link" onClick={() => void copyText('recovery', recoveryCode)}>
                {copiedLabel === 'recovery' ? '已复制' : '复制恢复码'}
              </button>
              <button className="text-button" onClick={() => setRecoveryCode(null)}>
                收起
              </button>
            </div>
          </div>
          <code className="sync-code">{recoveryCode}</code>
        </div>
      )}

      {(enabled || activeQr || joinFormOpen) && (
        <div className="sync-subblock">
          <div className="sync-subhead">
            <h4>添加设备</h4>
          </div>
          <div className="sync-add-grid">
            <div className="sync-add-left">
              <div className="sync-add-actions">
                {enabled && (
                  <button
                    className="button compact sync-outline-btn"
                    disabled={busyAction !== null}
                    onClick={() => void createInvite()}
                  >
                    {busyAction === 'invite' ? '生成中…' : '生成邀请二维码'}
                  </button>
                )}
                <button
                  className="text-button sync-link"
                  disabled={busyAction !== null}
                  onClick={() => void startJoinWait()}
                >
                  {busyAction === 'joinWait' ? '准备中…' : '等待已有设备扫码'}
                </button>
                <button
                  className="text-button sync-link"
                  disabled={busyAction !== null}
                  onClick={() => setJoinFormOpen(v => !v)}
                >
                  扫码 / 粘贴加入
                </button>
              </div>

              {enabled && (
                <div className="sync-scope-row" role="radiogroup" aria-label="授权范围">
                  <span className="sync-scope-label">授权范围：</span>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={inviteScope === 'full'}
                    className="sync-radio"
                    onClick={() => setInviteScope('full')}
                  >
                    <i className={inviteScope === 'full' ? 'checked' : ''} />
                    <span>推理 + 同步（本人设备）</span>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={inviteScope === 'inference'}
                    className="sync-radio"
                    onClick={() => setInviteScope('inference')}
                  >
                    <i className={inviteScope === 'inference' ? 'checked' : ''} />
                    <span>仅推理（共享算力）</span>
                  </button>
                </div>
              )}

              <label className="check-setting">
                <input
                  type="checkbox"
                  checked={settings.syncAutoCacheBlobs}
                  onChange={event => void invoke('settings', { syncAutoCacheBlobs: event.target.checked })}
                />
                <span>自动上传并缓存录音与截屏附件（关闭时按需下载）</span>
              </label>

              {joinFormOpen && (
                <div className="sync-inline-box">
                  <label className="model-field">
                    <span>粘贴配对链接（yanmo-pair://…）或空间恢复码（YM1-…）</span>
                    <input
                      value={joinInput}
                      placeholder="yanmo-pair://v1?data=... 或 YM1-..."
                      spellCheck={false}
                      onChange={event => setJoinInput(event.target.value)}
                    />
                  </label>
                  <div className="online-actions">
                    <button
                      className="button primary compact"
                      disabled={!joinInput.trim() || busyAction !== null}
                      onClick={() => void submitJoinInput()}
                    >
                      {busyAction === 'joinSubmit' ? '正在加入…' : '确认加入'}
                    </button>
                    <button className="text-button" onClick={() => setJoinFormOpen(false)}>
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="sync-add-right">
              {activeQr ? (
                <>
                  <div className={'sync-qr-frame' + (qrExpired ? ' expired' : '')}>
                    <QrSvg text={activeQr.qrUri} />
                  </div>
                  <p className="sync-qr-caption">{qrCaption}</p>
                  <div className="sync-qr-ops">
                    <button className="text-button sync-link" onClick={() => void copyText('qr', activeQr.qrUri)}>
                      {copiedLabel === 'qr' ? '已复制链接' : '复制配对链接'}
                    </button>
                    <button className="text-button" onClick={() => setActiveQr(null)}>
                      收起
                    </button>
                  </div>
                </>
              ) : (
                <div className="sync-qr-placeholder">
                  <span>生成配对码后在此展示</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {(enabled || (sync?.knownHubs.length ?? 0) > 0) && (
        <div className="sync-subblock">
          <div className="sync-subhead">
            <h4>已绑定中转节点（Hub）</h4>
            <button
              className="text-button sync-link"
              disabled={busyAction !== null}
              onClick={() => void discoverHubs()}
            >
              {busyAction === 'discover' ? '正在发现…' : '发现局域网节点'}
            </button>
          </div>
          {sync?.knownHubs.length ? (
            <div className="sync-list">
              {sync.knownHubs.map(hub => {
                const isLocal = state.acpm.connected && state.settings.acpm.mode === 'local' && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(hub.lastKnownUrl || '');
                const isDiscovered = discoveredSet.has(hub.hubInstanceId) || isLocal || Boolean(hub.lastSyncAtMs && Date.now() - hub.lastSyncAtMs < 300_000);
                const addrText = hub.manualRemoteUrl || hub.lastKnownUrl || '';
                const hostLabel = formatHost(addrText);
                const syncTimeText = hub.lastSyncAtMs
                  ? `${formatRelativeTime(hub.lastSyncAtMs)}同步`
                  : isDiscovered
                    ? (hub.lastSeenAtMs ? `已连接 · ${formatRelativeTime(hub.lastSeenAtMs)}` : '已连接')
                    : hub.lastSeenAtMs
                      ? `离线 · ${formatRelativeTime(hub.lastSeenAtMs)}`
                      : '尚未同步';
                return (
                  <div className="sync-row-wrap" key={hub.hubInstanceId}>
                    <div className="sync-row sync-hub-row">
                      <span className="sync-row-name">
                        <span className="model-dot">
                          <i className={isDiscovered ? 'ready' : ''} />
                          {hub.hubName}
                        </span>
                      </span>
                      <span className="sync-row-meta">{hostLabel || hub.serverPubkeyFp}</span>
                      <span className="sync-row-state">{syncTimeText}</span>
                      <div className="sync-row-actions">
                        <button
                          className="text-button sync-link"
                          disabled={busyAction !== null}
                          onClick={() => openHubEditor(hub)}
                        >
                          编辑地址
                        </button>
                        <button
                          className="text-button sync-link"
                          disabled={busyAction !== null}
                          onClick={() => void syncNow(hub.hubInstanceId)}
                        >
                          {busyAction === `sync:${hub.hubInstanceId}` ? '同步中…' : '立即同步'}
                        </button>
                      </div>
                    </div>
                    {editingHubId === hub.hubInstanceId && (
                      <div className="sync-inline-box sync-hub-editor">
                        <label className="model-field">
                          <span>手动指定远程或局域网地址（https://、局域网 IP 或 .local；留空恢复自动发现）</span>
                          <input
                            value={hubUrlInput}
                            placeholder="http://100.64.0.12:18790 或 https://hub.example.com"
                            spellCheck={false}
                            onChange={event => setHubUrlInput(event.target.value)}
                          />
                        </label>
                        <div className="online-actions">
                          <button
                            className="button compact primary"
                            disabled={busyAction !== null}
                            onClick={() => void saveHubUrl(hub.hubInstanceId)}
                          >
                            保存地址
                          </button>
                          <button className="text-button" onClick={() => setEditingHubId(null)}>
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="fine-print">尚未绑定中转节点；开启或加入空间后会自动记录。</p>
          )}
          {spoofedCount > 0 && (
            <p className="sync-warning" role="status">
              △ 已自动忽略 {spoofedCount} 个指纹不符的局域网节点
            </p>
          )}
        </div>
      )}

      {enabled && (
        <div className="sync-subblock">
          <div className="sync-subhead">
            <h4>已配对设备</h4>
            <span className="sync-subhint">移除将同步吊销全部已知节点</span>
          </div>
          {devices.length ? (
            <div className="sync-list">
              {devices.map(dev => {
                const isSelf = dev.device_id === sync?.deviceId;
                const hasSync = dev.scopes.includes('yanmo.sync');
                const hasInf = dev.scopes.includes('inference');
                const inferenceOnly = hasInf && !hasSync;
                const activeLabel = dev.last_seen_at_ms
                  ? `${formatRelativeTime(dev.last_seen_at_ms)}活跃`
                  : '';
                return (
                  <div className="sync-row sync-device-row" key={dev.device_id}>
                    <span className="sync-row-name">{dev.device_name}</span>
                    <span className="sync-row-meta">{platformLabel(dev.platform)}</span>
                    <span className="sync-row-tags">
                      {inferenceOnly ? (
                        <span className="sync-tag inference-only">仅推理</span>
                      ) : (
                        <>
                          {hasInf && <span className="sync-tag">推理</span>}
                          {hasSync && <span className="sync-tag">同步</span>}
                        </>
                      )}
                    </span>
                    <span className="sync-row-state">{isSelf ? '' : activeLabel}</span>
                    <div className="sync-row-actions">
                      {isSelf ? (
                        <span className="sync-self">本机</span>
                      ) : (
                        <button
                          className="text-button sync-link"
                          disabled={busyAction !== null}
                          onClick={() => void revokeDevice(dev.device_id)}
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="fine-print">{devicesLoaded ? '暂无其他已配对设备。' : '正在加载设备列表…'}</p>
          )}
        </div>
      )}
    </section>
  );
}
