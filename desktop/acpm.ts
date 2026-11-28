import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskAudio } from './processes';
import {
  computePubkeyFingerprint,
  signPopHeaders,
  verifyServerResponse,
  type SignedMembershipCert,
  type SyncCollection,
  type SyncPlatform,
} from './sync-crypto';

export type AcpmScope = 'inference' | 'yanmo.sync';

export interface AcpmDiscovery {
  version: number;
  pid: number;
  started_at: string;
  http_base_url: string;
  native_ipc_path: string;
  token: string;
  platform: string;
  capabilities: string[];
  mdns_hostname?: string | null;
  mdns_base_url?: string | null;
  hub_instance_id?: string | null;
  server_pubkey_fp?: string | null;
}

export interface AcpmHubIdentityResponse {
  hub_instance_id: string;
  server_pubkey: string;
  server_pubkey_fp: string;
  capabilities: string[];
  sync_protocol_version: number;
}

export interface AcpmRegisterVaultRequest {
  vault_id: string;
  owner_pubkey: string;
  device_id: string;
  device_pubkey: string;
  device_name: string;
  platform: SyncPlatform;
  membership_cert: SignedMembershipCert;
}

export interface AcpmRegisterVaultResponse {
  vault_id: string;
  device_id: string;
  scopes: AcpmScope[];
}

export interface AcpmCreatePairingSessionRequest {
  mode: 'inviter' | 'join_wait';
  scopes?: AcpmScope[];
  vault_id?: string;
  encrypted_seed_box?: string;
  joiner_eph_pubkey?: string;
}

export interface AcpmCreatePairingSessionResponse {
  session_id: string;
  acpm_pair_code: string;
  expires_at_ms: number;
}

export interface AcpmGetPairingSessionResponse {
  session_id: string;
  mode: 'inviter' | 'join_wait';
  status: 'waiting' | 'fulfilled';
  expires_at_ms: number;
  joiner_eph_pubkey?: string;
  sender_eph_pubkey?: string;
  encrypted_seed_box?: string;
}

export interface AcpmRedeemPairingRequest {
  session_id: string;
  acpm_pair_code: string;
  device_id: string;
  device_pubkey: string;
  device_name: string;
  platform: SyncPlatform;
  sender_eph_pubkey?: string;
  encrypted_seed_box?: string;
}

export interface AcpmRedeemPairingResponse {
  session_id: string;
  mode: 'inviter' | 'join_wait';
  device_id: string;
  scopes: AcpmScope[];
  encrypted_seed_box?: string;
}

export interface AcpmPairedDeviceDTO {
  device_id: string;
  device_pubkey: string;
  device_name: string;
  platform: SyncPlatform;
  scopes: AcpmScope[];
  vault_id?: string | null;
  paired_at_ms: number;
  last_seen_at_ms?: number | null;
  revoked_at_ms?: number | null;
}

export interface AcpmSyncChangeItem {
  seq?: number;
  collection: SyncCollection;
  record_key: string;
  version_hlc: string;
  origin_device_id: string;
  deleted: boolean;
  ciphertext: string;
  updated_at_ms?: number;
}

export interface AcpmPullChangesResponse {
  hub_instance_id: string;
  latest_seq: number;
  has_more: boolean;
  changes: AcpmSyncChangeItem[];
}

export interface AcpmPushChangeResult {
  collection: SyncCollection;
  record_key: string;
  status: 'applied' | 'noop' | 'stale';
  seq?: number;
  current_version_hlc?: string;
}

export interface AcpmPushChangesResponse {
  latest_seq: number;
  results: AcpmPushChangeResult[];
}

export interface AcpmModelDTO {
  id: string;
  capability: string;
  display_name: string;
  selected_variant?: string | null;
  installed: boolean;
  state: string;
  pin_policy: string;
  idle_timeout_sec: number;
  idle_remaining_sec?: number | null;
  available_quants?: string[] | null;
  model_path?: string | null;
  memory?: {
    unified_mb?: number | null;
    system_ram_mb?: number | null;
    gpu_vram_mb?: Record<string, number> | null;
  };
}

export interface AcpmHealthResponse {
  status: string;
  version: string;
  platform: string;
  mdns_hostname?: string | null;
  mdns_base_url?: string | null;
}

export interface AcpmVadResponse {
  segments: { start_ms: number; end_ms: number }[];
  duration_ms: number;
}

export interface AcpmTranscriptionResponse {
  text: string;
  language?: string | null;
  duration_ms?: number;
  segments?: { start_ms: number; end_ms: number; text: string }[];
}

export interface AcpmAsrStreamStartResponse {
  session_id: string;
  model: string;
  sample_rate: number;
}

export interface AcpmAsrStreamChunkResponse {
  session_id: string;
  confirmed_text: string;
  provisional_text: string;
  language?: string | null;
  decode_ms: number;
}

export interface AcpmAsrStreamStatusResponse {
  session_id: string;
  status: string;
}

export interface AcpmAsrStreamFinishResponse {
  session_id: string;
  text: string;
  language?: string | null;
  decode_ms: number;
}

export interface AcpmChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string | null;
    };
    finish_reason: string | null;
  }[];
  usage?: Record<string, unknown>;
}

export type AcpmPriority = 'interactive' | 'normal' | 'batch';

export class AcpmDiscoveryError extends Error {
  constructor(readonly kind: 'missing' | 'stale' | 'invalid', message: string) {
    super(message);
    this.name = 'AcpmDiscoveryError';
  }
}

export class AcpmError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly stage: string,
    readonly detail: string,
    readonly nativeCode: string | null = null,
    readonly elapsedMs: number = 0,
    readonly retryable: boolean = false,
    readonly httpStatus: number = 500,
  ) {
    super(message);
    this.name = 'AcpmError';
  }
}

export function defaultAcpmDataDir(): string {
  if (process.env.YANMO_ACPM_DATA_DIR) return process.env.YANMO_ACPM_DATA_DIR;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'acpm-desktop');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'acpm-desktop');
  return join(homedir(), '.local', 'share', 'acpm-desktop');
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'EPERM';
  }
}

export function discoverAcpmRuntime(dataDir?: string, verifyAlive = true): AcpmDiscovery {
  const dir = dataDir || defaultAcpmDataDir();
  const runtimePath = join(dir, 'runtime.json');
  let content: string;
  try {
    content = readFileSync(runtimePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      throw new AcpmDiscoveryError('missing', '未检测到运行中的 AcpmRuntime，请先启动 AcpmRuntime。');
    }
    throw new AcpmDiscoveryError('invalid', '无法读取 AcpmRuntime 发现文件，请检查 AcpmRuntime 状态。');
  }
  let raw: Partial<AcpmDiscovery>;
  try {
    raw = JSON.parse(content) as Partial<AcpmDiscovery>;
  } catch {
    throw new AcpmDiscoveryError('invalid', 'AcpmRuntime 发现文件格式无效，请重启 AcpmRuntime。');
  }
  if (!raw || typeof raw !== 'object' || typeof raw.http_base_url !== 'string' || !raw.http_base_url.trim()
    || typeof raw.token !== 'string' || !raw.token.trim() || !Number.isInteger(raw.pid) || (raw.pid ?? 0) <= 0) {
    throw new AcpmDiscoveryError('invalid', 'AcpmRuntime 发现文件缺少必要字段，请重启 AcpmRuntime。');
  }
  if (verifyAlive && !isPidAlive(raw.pid!)) {
    throw new AcpmDiscoveryError('stale', 'AcpmRuntime 服务未在运行，请重新启动 AcpmRuntime。');
  }
  return {
    version: Number(raw.version ?? 1),
    pid: raw.pid!,
    started_at: String(raw.started_at ?? ''),
    http_base_url: raw.http_base_url.trim().replace(/\/+$/, ''),
    native_ipc_path: String(raw.native_ipc_path ?? ''),
    token: raw.token.trim(),
    platform: String(raw.platform ?? ''),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities.map(String) : [],
    mdns_hostname: raw.mdns_hostname ?? null,
    mdns_base_url: typeof raw.mdns_base_url === 'string' ? raw.mdns_base_url.trim().replace(/\/+$/, '') : null,
    hub_instance_id: typeof raw.hub_instance_id === 'string' && raw.hub_instance_id.trim() ? raw.hub_instance_id.trim() : null,
    server_pubkey_fp: typeof raw.server_pubkey_fp === 'string' && raw.server_pubkey_fp.trim() ? raw.server_pubkey_fp.trim().toLowerCase() : null,
  };
}

const LANGUAGE_ALIASES: Record<string, string> = {
  zh: 'Chinese',
  'zh-cn': 'Chinese',
  'zh-hans': 'Chinese',
  'zh-hant': 'Chinese',
  'zh-tw': 'Chinese',
  chinese: 'Chinese',
  en: 'English',
  'en-us': 'English',
  'en-gb': 'English',
  english: 'English',
  ja: 'Japanese',
  jp: 'Japanese',
  japanese: 'Japanese',
  de: 'German',
  german: 'German',
};

export function normalizeAsrLanguage(raw?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (['auto', 'none', 'unknown'].includes(lower)) return null;
  return LANGUAGE_ALIASES[lower] ?? trimmed;
}

export function friendlyAcpmError(error: unknown): string {
  if (error instanceof AcpmDiscoveryError) return error.message;
  if (error instanceof AcpmError) {
    switch (error.code) {
      case 'MODEL_NOT_INSTALLED':
        return 'AcpmRuntime 中所选模型尚未安装或未绑定，请在 AcpmRuntime「模型」页安装或绑定后再试。';
      case 'UNAUTHORIZED':
        return 'AcpmRuntime 鉴权失败，请检查或重新复制 Bearer Token。';
      case 'FORBIDDEN':
        return 'AcpmRuntime 拒绝了本次连接请求，请检查服务地址配置。';
      case 'NOT_FOUND':
        return 'AcpmRuntime 中未找到请求的模型或接口。';
      case 'AUDIO_VALIDATION_FAILED':
        return '音频格式或内容无法被 AcpmRuntime 读取。';
      case 'INVALID_REQUEST':
        return '请求参数无效，请检查模型配置后重试。';
      case 'INSUFFICIENT_MEMORY':
        return 'AcpmRuntime 统一内存不足，请在 AcpmRuntime 设置中提高内存预算或改选更小规格模型。';
      case 'SCHEDULER_BUSY':
        return 'AcpmRuntime 调度器正忙，请稍后重试。';
      case 'QUEUE_TIMEOUT':
        return 'AcpmRuntime 请求排队超时，请稍后重试。';
      case 'WORKER_CRASHED':
        return 'AcpmRuntime 推理工作进程异常退出，请重试。';
      case 'CANCELLED':
        return '任务已取消。';
      case 'UNSUPPORTED_PLATFORM':
        return '当前平台不支持所选模型规格。';
      case 'INFERENCE_FAILED':
        return 'AcpmRuntime 推理执行失败，请查看 AcpmRuntime 日志或重试。';
      default:
        return error.message || 'AcpmRuntime 请求失败。';
    }
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return '连接 AcpmRuntime 超时，请检查服务是否正常运行。';
    }
    const causeCode = (error as Error & { cause?: { code?: string } }).cause?.code;
    if (error.name === 'TypeError' || ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET'].includes(causeCode ?? '')) {
      return '无法连接到 AcpmRuntime，请确认 AcpmRuntime 正在运行且地址可访问。';
    }
    return error.message || 'AcpmRuntime 连接失败。';
  }
  return 'AcpmRuntime 连接失败。';
}

export interface AcpmPopAuthOptions {
  deviceId: string;
  privateSeed: Buffer | Uint8Array;
  serverPubkey?: string;
  expectedServerPubkeyFp?: string;
}

export interface AcpmClientOptions {
  mode: 'local' | 'remote';
  remoteBaseURL?: string;
  remoteToken?: string;
  popAuth?: AcpmPopAuthOptions;
  caller?: string;
  dataDir?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AcpmClient {
  readonly mode: 'local' | 'remote';
  private readonly remoteBaseURL: string;
  private readonly remoteToken: string;
  private readonly popAuth?: AcpmPopAuthOptions;
  private readonly caller: string;
  private readonly dataDir?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AcpmClientOptions) {
    this.mode = options.mode;
    this.remoteBaseURL = (options.remoteBaseURL ?? '').trim().replace(/\/+$/, '');
    this.remoteToken = (options.remoteToken ?? '').trim();
    this.popAuth = options.popAuth;
    this.caller = options.caller || 'yanmo-ime';
    this.dataDir = options.dataDir;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private resolveTarget(authenticated: boolean, usePop: boolean): { baseURL: string; token: string } {
    if (this.mode === 'local') {
      const info = discoverAcpmRuntime(this.dataDir, true);
      return { baseURL: info.http_base_url, token: info.token };
    }
    if (!this.remoteBaseURL) {
      throw new Error('请先在设置中填写远程 AcpmRuntime 服务地址。');
    }
    if (authenticated && !usePop && !this.remoteToken) {
      throw new Error('请先在设置中填写远程 AcpmRuntime 的 Bearer Token。');
    }
    return { baseURL: this.remoteBaseURL, token: this.remoteToken };
  }

  private async parseError(response: Response): Promise<AcpmError> {
    const rawText = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(rawText) as { error?: Record<string, unknown> };
      const err = parsed?.error;
      if (err && typeof err === 'object' && typeof err.code === 'string') {
        return new AcpmError(
          err.code,
          typeof err.message === 'string' ? err.message : `HTTP ${response.status}`,
          typeof err.request_id === 'string' ? err.request_id : 'unknown',
          typeof err.stage === 'string' ? err.stage : 'HTTP_ADMISSION',
          typeof err.detail === 'string' ? err.detail : `HTTP_${response.status}`,
          typeof err.native_code === 'string' ? err.native_code : null,
          Number(err.elapsed_ms ?? 0),
          Boolean(err.retryable ?? false),
          response.status,
        );
      }
    } catch { /* Fall through to generic AcpmError. */ }
    const fallbackCode = response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : response.status === 404 ? 'NOT_FOUND' : 'INFERENCE_FAILED';
    return new AcpmError(fallbackCode, rawText || `HTTP ${response.status}`, 'unknown', 'HTTP_ADMISSION', `HTTP_${response.status}`, null, 0, false, response.status);
  }

  private async requestWithMeta<T>(
    method: string,
    path: string,
    options: {
      json?: unknown;
      formData?: FormData;
      binaryBody?: Uint8Array;
      responseType?: 'json' | 'binary';
      headers?: Record<string, string>;
      priority?: AcpmPriority;
      authenticated?: boolean;
      preferPop?: boolean;
      serverVerifyNonce?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ data: T; rawText: string; rawBytes: Buffer; status: number; headers: Headers; requestId: string; popNonce?: string }> {
    const authenticated = options.authenticated ?? true;
    const usePop = authenticated && Boolean(this.popAuth) && (this.mode === 'remote' || options.preferPop === true);
    const priority = options.priority ?? 'normal';
    const responseType = options.responseType ?? 'json';
    let refreshedLocalAuth = false;
    let retriedTransient = false;
    let overrideTarget: { baseURL: string; token: string } | undefined;

    while (true) {
      options.signal?.throwIfAborted();
      const target = overrideTarget ?? this.resolveTarget(authenticated, usePop);
      overrideTarget = undefined;
      const requestId = randomUUID();
      const headers: Record<string, string> = {
        'X-AI-Priority': priority,
        'X-AI-Caller': this.caller,
        'X-AI-Request-Id': requestId,
        ...options.headers,
      };

      let body: BodyInit | undefined;
      let bodyBytes: Buffer | undefined;
      if (options.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        const jsonText = JSON.stringify(options.json);
        body = jsonText;
        bodyBytes = Buffer.from(jsonText, 'utf8');
      } else if (options.binaryBody !== undefined) {
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
        bodyBytes = Buffer.from(options.binaryBody);
        body = new Uint8Array(bodyBytes);
      } else if (options.formData !== undefined) {
        if (usePop) {
          const serialized = new Response(options.formData);
          const contentType = serialized.headers.get('content-type');
          if (contentType) headers['Content-Type'] = contentType;
          bodyBytes = Buffer.from(await serialized.arrayBuffer());
          body = new Uint8Array(bodyBytes);
        } else {
          body = options.formData;
        }
      }

      let popNonce: string | undefined;
      if (authenticated) {
        if (usePop && this.popAuth) {
          const pop = signPopHeaders(this.popAuth.deviceId, this.popAuth.privateSeed, method, path, bodyBytes);
          Object.assign(headers, pop);
          popNonce = pop['X-Acpm-Nonce'];
        } else {
          headers.Authorization = `Bearer ${target.token}`;
        }
      }

      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

      const response = await this.fetchImpl(`${target.baseURL}${path}`, {
        method,
        headers,
        body,
        signal,
        redirect: 'error',
      });

      if (response.ok) {
        const rawBytes = method.toUpperCase() === 'HEAD'
          ? Buffer.alloc(0)
          : Buffer.from(await response.arrayBuffer());
        const rawText = responseType === 'json' && rawBytes.length ? rawBytes.toString('utf8') : '';
        const serverSig = response.headers.get('x-acpm-server-signature');
        const serverTs = response.headers.get('x-acpm-server-timestamp');
        if (this.popAuth?.serverPubkey && (serverSig || (usePop && responseType === 'json' && method.toUpperCase() !== 'HEAD'))) {
          const tsNum = serverTs !== null ? Number(serverTs) : Number.NaN;
          const tsFresh = Number.isFinite(tsNum) && Math.abs(Date.now() - tsNum) <= 120_000;
          const valid = Boolean(serverSig && serverTs !== null && tsFresh && verifyServerResponse(
            this.popAuth.serverPubkey,
            options.serverVerifyNonce ?? popNonce ?? requestId,
            serverTs,
            rawBytes,
            serverSig,
          ));
          if (!valid) {
            throw new AcpmError(
              'FORBIDDEN',
              'AcpmRuntime 服务端响应签名缺失、已过期或校验失败。',
              requestId,
              'RESPONSE_VERIFY',
              serverSig ? 'INVALID_SERVER_SIGNATURE' : 'MISSING_SERVER_SIGNATURE',
              null,
              0,
              false,
              403,
            );
          }
        }
        const data = responseType === 'binary'
          ? (rawBytes as unknown as T)
          : ((rawText ? JSON.parse(rawText) : {}) as T);
        return {
          data,
          rawText,
          rawBytes,
          status: response.status,
          headers: response.headers,
          requestId,
          popNonce,
        };
      }

      const acpmError = await this.parseError(response);
      if (acpmError.httpStatus === 401 && this.mode === 'local' && authenticated && !usePop && !refreshedLocalAuth) {
        refreshedLocalAuth = true;
        const fresh = discoverAcpmRuntime(this.dataDir, true);
        if (fresh.token !== target.token || fresh.http_base_url !== target.baseURL) {
          overrideTarget = { baseURL: fresh.http_base_url, token: fresh.token };
          continue;
        }
      }
      if (acpmError.retryable && !retriedTransient && !options.signal?.aborted) {
        retriedTransient = true;
        await delay(300, undefined, { signal: options.signal });
        continue;
      }
      throw acpmError;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      json?: unknown;
      formData?: FormData;
      binaryBody?: Uint8Array;
      responseType?: 'json' | 'binary';
      headers?: Record<string, string>;
      priority?: AcpmPriority;
      authenticated?: boolean;
      preferPop?: boolean;
      serverVerifyNonce?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    const result = await this.requestWithMeta<T>(method, path, options);
    return result.data;
  }

  async hubIdentity(nonce?: string, signal?: AbortSignal): Promise<AcpmHubIdentityResponse> {
    const clientNonce = nonce || randomBytes(16).toString('base64url');
    const path = `/v1/hub/identity?nonce=${encodeURIComponent(clientNonce)}`;
    const { data, rawText, headers, requestId } = await this.requestWithMeta<AcpmHubIdentityResponse>('GET', path, {
      authenticated: false,
      priority: 'normal',
      serverVerifyNonce: clientNonce,
      signal,
    });
    const derivedFp = computePubkeyFingerprint(data.server_pubkey);
    if (derivedFp !== data.server_pubkey_fp.toLowerCase()) {
      throw new AcpmError('FORBIDDEN', 'AcpmRuntime 节点公钥与指纹不匹配。', requestId, 'HUB_IDENTITY', 'FINGERPRINT_MISMATCH', null, 0, false, 403);
    }
    if (this.popAuth?.expectedServerPubkeyFp && derivedFp !== this.popAuth.expectedServerPubkeyFp.toLowerCase()) {
      throw new AcpmError('FORBIDDEN', 'AcpmRuntime 节点指纹与已保存节点不一致。', requestId, 'HUB_IDENTITY', 'EXPECTED_FP_MISMATCH', null, 0, false, 403);
    }
    const serverSig = headers.get('x-acpm-server-signature');
    const serverTs = headers.get('x-acpm-server-timestamp');
    const tsNum = serverTs !== null ? Number(serverTs) : Number.NaN;
    const tsFresh = Number.isFinite(tsNum) && Math.abs(Date.now() - tsNum) <= 120_000;
    if (!serverSig || !serverTs || !tsFresh || !verifyServerResponse(data.server_pubkey, clientNonce, serverTs, rawText, serverSig)) {
      throw new AcpmError('FORBIDDEN', 'AcpmRuntime 节点身份签名验证失败或已过期。', requestId, 'HUB_IDENTITY', 'INVALID_SERVER_SIGNATURE', null, 0, false, 403);
    }
    return data;
  }

  async registerVault(payload: AcpmRegisterVaultRequest, signal?: AbortSignal): Promise<AcpmRegisterVaultResponse> {
    return this.request<AcpmRegisterVaultResponse>('POST', '/v1/sync/vaults/register', {
      json: payload,
      priority: 'normal',
      signal,
    });
  }

  async createPairingSession(
    payload: AcpmCreatePairingSessionRequest,
    signal?: AbortSignal,
  ): Promise<AcpmCreatePairingSessionResponse> {
    return this.request<AcpmCreatePairingSessionResponse>('POST', '/v1/pairing/sessions', {
      json: payload,
      priority: 'normal',
      signal,
    });
  }

  async getPairingSession(
    sessionId: string,
    pairCode?: string,
    signal?: AbortSignal,
  ): Promise<AcpmGetPairingSessionResponse> {
    const path = `/v1/pairing/sessions/${encodeURIComponent(sessionId)}`;
    if (pairCode) {
      return this.request<AcpmGetPairingSessionResponse>('GET', path, {
        authenticated: false,
        headers: { 'X-Acpm-Pair-Code': pairCode },
        priority: 'normal',
        signal,
      });
    }
    return this.request<AcpmGetPairingSessionResponse>('GET', path, {
      priority: 'normal',
      signal,
    });
  }

  async redeemPairingSession(
    payload: AcpmRedeemPairingRequest,
    signal?: AbortSignal,
  ): Promise<AcpmRedeemPairingResponse> {
    return this.request<AcpmRedeemPairingResponse>('POST', '/v1/pairing/redeem', {
      json: payload,
      authenticated: false,
      priority: 'normal',
      signal,
    });
  }

  async listDevices(signal?: AbortSignal): Promise<AcpmPairedDeviceDTO[]> {
    const res = await this.request<{ devices?: AcpmPairedDeviceDTO[] }>('GET', '/v1/devices', {
      priority: 'normal',
      signal,
    });
    return Array.isArray(res.devices) ? res.devices : [];
  }

  async updateDevice(
    deviceId: string,
    patch: { device_name?: string; scopes?: AcpmScope[] },
    signal?: AbortSignal,
  ): Promise<AcpmPairedDeviceDTO> {
    return this.request<AcpmPairedDeviceDTO>('PATCH', `/v1/devices/${encodeURIComponent(deviceId)}`, {
      json: patch,
      priority: 'normal',
      signal,
    });
  }

  async revokeDevice(deviceId: string, signal?: AbortSignal): Promise<{ device_id: string; revoked_at_ms: number }> {
    return this.request<{ device_id: string; revoked_at_ms: number }>(
      'DELETE',
      `/v1/devices/${encodeURIComponent(deviceId)}`,
      { priority: 'normal', signal },
    );
  }

  async pullSyncChanges(
    vaultId: string,
    sinceSeq = 0,
    limit = 200,
    signal?: AbortSignal,
  ): Promise<AcpmPullChangesResponse> {
    const query = `since_seq=${Math.max(0, Math.floor(sinceSeq))}&limit=${Math.max(1, Math.min(500, Math.floor(limit)))}`;
    return this.request<AcpmPullChangesResponse>(
      'GET',
      `/v1/sync/vaults/${encodeURIComponent(vaultId)}/changes?${query}`,
      { priority: 'normal', signal },
    );
  }

  async pushSyncChanges(
    vaultId: string,
    changes: AcpmSyncChangeItem[],
    signal?: AbortSignal,
  ): Promise<AcpmPushChangesResponse> {
    return this.request<AcpmPushChangesResponse>(
      'POST',
      `/v1/sync/vaults/${encodeURIComponent(vaultId)}/changes`,
      { json: { changes }, priority: 'normal', signal },
    );
  }

  async hasSyncBlob(vaultId: string, blobId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.requestWithMeta<unknown>(
        'HEAD',
        `/v1/sync/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
        { priority: 'normal', signal },
      );
      return true;
    } catch (error) {
      if (error instanceof AcpmError && error.httpStatus === 404) return false;
      throw error;
    }
  }

  async uploadSyncBlob(
    vaultId: string,
    blobId: string,
    encryptedBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/v1/sync/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      { binaryBody: encryptedBytes, priority: 'normal', signal },
    );
  }

  async downloadSyncBlob(vaultId: string, blobId: string, signal?: AbortSignal): Promise<Buffer> {
    return this.request<Buffer>(
      'GET',
      `/v1/sync/vaults/${encodeURIComponent(vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      { responseType: 'binary', priority: 'normal', signal },
    );
  }

  async health(signal?: AbortSignal): Promise<AcpmHealthResponse> {
    return this.request<AcpmHealthResponse>('GET', '/healthz', { authenticated: false, priority: 'normal', signal });
  }

  async models(signal?: AbortSignal): Promise<AcpmModelDTO[]> {
    const res = await this.request<{ models?: AcpmModelDTO[] }>('GET', '/v1/models', { priority: 'normal', signal });
    return Array.isArray(res.models) ? res.models : [];
  }

  async prewarm(models: string[], promptCacheKeys?: string[], signal?: AbortSignal): Promise<AcpmModelDTO[]> {
    const payload: Record<string, unknown> = { models };
    if (promptCacheKeys?.length) payload.prompt_cache_keys = promptCacheKeys;
    const res = await this.request<{ models?: AcpmModelDTO[] }>('POST', '/v1/models/prewarm', { json: payload, priority: 'normal', signal });
    return Array.isArray(res.models) ? res.models : [];
  }

  private async toAudioBlob(audio: TaskAudio, signal?: AbortSignal): Promise<Blob> {
    const buf = typeof audio === 'string' ? await readFile(audio, { signal }) : audio;
    return new Blob([new Uint8Array(buf)], { type: 'audio/wav' });
  }

  async vad(
    audio: TaskAudio,
    options: { model?: string; minSpeechMs?: number; minSilenceMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<AcpmVadResponse> {
    const model = options.model || 'speech-vad-pyannote';
    const minSpeechMs = options.minSpeechMs ?? 250;
    const minSilenceMs = options.minSilenceMs ?? 300;
    if (typeof audio === 'string' && this.mode === 'local') {
      return this.request<AcpmVadResponse>('POST', '/v1/audio/vad', {
        json: { model, file_path: audio, min_speech_ms: minSpeechMs, min_silence_ms: minSilenceMs },
        priority: 'interactive',
        signal,
      });
    }
    const form = new FormData();
    form.set('model', model);
    form.set('min_speech_ms', String(minSpeechMs));
    form.set('min_silence_ms', String(minSilenceMs));
    form.set('file', await this.toAudioBlob(audio, signal), 'recording.wav');
    return this.request<AcpmVadResponse>('POST', '/v1/audio/vad', {
      formData: form,
      priority: 'interactive',
      signal,
    });
  }

  async transcribe(
    audio: TaskAudio,
    options: { model: string; language?: string; vadFilter?: boolean; timestamps?: boolean; prompt?: string },
    signal?: AbortSignal,
  ): Promise<AcpmTranscriptionResponse> {
    const language = options.language ?? 'auto';
    const vadFilter = options.vadFilter ?? true;
    const timestamps = options.timestamps ?? false;
    if (typeof audio === 'string' && this.mode === 'local') {
      const payload: Record<string, unknown> = {
        model: options.model,
        file_path: audio,
        language,
        vad_filter: vadFilter,
        timestamps,
      };
      if (options.prompt) payload.prompt = options.prompt;
      return this.request<AcpmTranscriptionResponse>('POST', '/v1/audio/transcriptions', {
        json: payload,
        priority: 'interactive',
        signal,
      });
    }
    const form = new FormData();
    form.set('model', options.model);
    form.set('language', language);
    form.set('vad_filter', String(vadFilter));
    form.set('timestamps', String(timestamps));
    if (options.prompt) form.set('prompt', options.prompt);
    form.set('file', await this.toAudioBlob(audio, signal), 'recording.wav');
    return this.request<AcpmTranscriptionResponse>('POST', '/v1/audio/transcriptions', {
      formData: form,
      priority: 'interactive',
      signal,
    });
  }

  async startAsrStream(
    options: { model: string; language?: string; prompt?: string },
    signal?: AbortSignal,
  ): Promise<AcpmAsrStreamStartResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      language: options.language ?? 'auto',
    };
    if (options.prompt?.trim()) body.prompt = options.prompt.trim();
    return this.request<AcpmAsrStreamStartResponse>('POST', '/v1/audio/transcriptions/stream/start', {
      json: body,
      priority: 'interactive',
      signal,
    });
  }

  async feedAsrStreamChunk(
    options: { model: string; sessionId: string; pcm16Base64: string },
    signal?: AbortSignal,
  ): Promise<AcpmAsrStreamChunkResponse> {
    return this.request<AcpmAsrStreamChunkResponse>('POST', '/v1/audio/transcriptions/stream/chunk', {
      json: {
        model: options.model,
        session_id: options.sessionId,
        pcm16_base64: options.pcm16Base64,
      },
      priority: 'interactive',
      signal,
    });
  }

  async resetAsrStream(
    options: { model: string; sessionId: string; language?: string; prompt?: string },
    signal?: AbortSignal,
  ): Promise<AcpmAsrStreamStatusResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      session_id: options.sessionId,
      language: options.language ?? 'auto',
    };
    if (options.prompt?.trim()) body.prompt = options.prompt.trim();
    return this.request<AcpmAsrStreamStatusResponse>('POST', '/v1/audio/transcriptions/stream/reset', {
      json: body,
      priority: 'interactive',
      signal,
    });
  }

  async finishAsrStream(
    options: { model: string; sessionId: string; pcm16Base64?: string; closeAfter?: boolean },
    signal?: AbortSignal,
  ): Promise<AcpmAsrStreamFinishResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      session_id: options.sessionId,
      close_after: options.closeAfter ?? true,
    };
    if (options.pcm16Base64) body.pcm16_base64 = options.pcm16Base64;
    return this.request<AcpmAsrStreamFinishResponse>('POST', '/v1/audio/transcriptions/stream/finish', {
      json: body,
      priority: 'interactive',
      signal,
    });
  }

  async closeAsrStream(
    options: { model: string; sessionId: string },
    signal?: AbortSignal,
  ): Promise<AcpmAsrStreamStatusResponse> {
    return this.request<AcpmAsrStreamStatusResponse>('POST', '/v1/audio/transcriptions/stream/close', {
      json: {
        model: options.model,
        session_id: options.sessionId,
      },
      priority: 'normal',
      signal,
    });
  }

  async chatCompletions(
    payload: {
      model: string;
      messages: { role: string; content: string }[];
      temperature?: number;
      maxTokens?: number;
      separateReasoning?: boolean;
      promptCacheKey?: string;
    },
    priority: AcpmPriority = 'interactive',
    signal?: AbortSignal,
  ): Promise<AcpmChatCompletionResponse> {
    const body: Record<string, unknown> = {
      model: payload.model,
      messages: payload.messages,
      stream: false,
      temperature: payload.temperature ?? 0.0,
      max_tokens: payload.maxTokens ?? 4096,
      separate_reasoning: payload.separateReasoning ?? true,
    };
    if (payload.promptCacheKey) body.prompt_cache_key = payload.promptCacheKey;
    return this.request<AcpmChatCompletionResponse>('POST', '/v1/chat/completions', {
      json: body,
      priority,
      signal,
    });
  }
}
