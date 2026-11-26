import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { checkAcpmURL, type SyncStateSummary } from './shared';
import {
  AcpmClient,
  AcpmError,
  discoverAcpmRuntime,
  type AcpmDiscovery,
  type AcpmHubIdentityResponse,
  type AcpmPairedDeviceDTO,
  type AcpmScope,
} from './acpm';
import {
  deriveJoinPairKey,
  deriveSpaceKeys,
  ed25519FromSeed,
  encodeRecoveryCode,
  decodeRecoveryCode,
  generateDeviceIdentity,
  generateRootSeed,
  generateX25519Keypair,
  openPairingSeedBox,
  sealPairingSeedBox,
  signMembershipCert,
  type DeviceIdentity,
  type SyncPlatform,
} from './sync-crypto';
import {
  matchKnownHubs,
  resolveHubBaseUrl,
  UdpMdnsBrowser,
  type DiscoveredAcpmHub,
  type KnownHub,
  type MdnsBrowser,
} from './sync-discovery';

export interface SyncSecretsRecord {
  deviceId: string;
  devicePrivateSeedB64: string;
  rootSeedB64?: string;
}

export interface SyncSecretStore {
  load(): SyncSecretsRecord | null;
  save(record: SyncSecretsRecord): void;
}

export interface KnownHubStore {
  load(): KnownHub[];
  save(hubs: KnownHub[]): void;
}

export class MemorySyncSecretStore implements SyncSecretStore {
  private record: SyncSecretsRecord | null = null;
  load(): SyncSecretsRecord | null {
    return this.record ? { ...this.record } : null;
  }
  save(record: SyncSecretsRecord): void {
    this.record = { ...record };
  }
}

export class MemoryKnownHubStore implements KnownHubStore {
  private hubs: KnownHub[] = [];
  load(): KnownHub[] {
    return this.hubs.map(h => ({ ...h }));
  }
  save(hubs: KnownHub[]): void {
    this.hubs = hubs.map(h => ({ ...h }));
  }
}

export class FileKnownHubStore implements KnownHubStore {
  private readonly filePath: string;
  constructor(private readonly directory: string) {
    this.filePath = join(directory, 'sync-hubs.json');
  }

  load(): KnownHub[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!Array.isArray(raw)) return [];
      return raw.filter((item): item is KnownHub => Boolean(
        item
        && typeof item === 'object'
        && typeof item.hubInstanceId === 'string'
        && typeof item.serverPubkey === 'string'
        && typeof item.serverPubkeyFp === 'string',
      ));
    } catch {
      return [];
    }
  }

  save(hubs: KnownHub[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(hubs, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.filePath);
  }
}

export interface InviteQrPayload {
  v: 1;
  mode: 'invite';
  hub_id: string;
  fp: string;
  addrs: string[];
  port: number;
  sid: string;
  code: string;
  sec: string;
}

export interface JoinWaitQrPayload {
  v: 1;
  mode: 'join_wait';
  hub_id: string;
  fp: string;
  addrs: string[];
  port: number;
  sid: string;
  code: string;
  epk: string;
}

export type PairingQrPayload = InviteQrPayload | JoinWaitQrPayload;

interface SeedBoxContent {
  root_seed_b64: string;
  vault_id: string;
  owner_pubkey: string;
}

export interface SyncPairingServiceOptions {
  secretStore: SyncSecretStore;
  hubStore: KnownHubStore;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  mdnsBrowser?: MdnsBrowser;
  localAddressesProvider?: () => string[];
}

function defaultLocalAddresses(discovery?: AcpmDiscovery | null): string[] {
  const addrs: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        addrs.push(info.address);
      }
    }
  }
  if (discovery?.mdns_hostname) {
    addrs.push(discovery.mdns_hostname);
  }
  if (!addrs.length && discovery?.http_base_url) {
    try {
      addrs.push(new URL(discovery.http_base_url).hostname);
    } catch { /* Ignore malformed URL. */ }
  }
  return [...new Set(addrs)];
}

function portFromUrl(urlStr: string): number {
  const parsed = new URL(urlStr);
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

export function encodePairingQrUri(payload: PairingQrPayload): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `yanmo-pair://v1?data=${data}`;
}

export function parsePairingQr(input: string): PairingQrPayload {
  const trimmed = input.trim();
  let jsonText = trimmed;
  if (trimmed.startsWith('yanmo-pair://')) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(trimmed);
    } catch {
      throw new Error('配对二维码链接格式无效。');
    }
    const encoded = parsedUrl.searchParams.get('data');
    if (!encoded) throw new Error('配对二维码缺少数据载荷。');
    jsonText = Buffer.from(encoded, 'base64url').toString('utf8');
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    throw new Error('配对二维码无法解析。');
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) {
    throw new Error('不支持的配对二维码版本。');
  }
  if (typeof raw.hub_id !== 'string' || !raw.hub_id.trim()
    || typeof raw.fp !== 'string' || !/^[0-9a-f]{16}$/i.test(raw.fp)
    || !Array.isArray(raw.addrs) || raw.addrs.length === 0 || raw.addrs.some(a => typeof a !== 'string' || !a.trim())
    || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port <= 0 || raw.port > 65535
    || typeof raw.sid !== 'string' || !raw.sid.trim()
    || typeof raw.code !== 'string' || !raw.code.trim()) {
    throw new Error('配对二维码缺少必要字段。');
  }
  const base = {
    v: 1 as const,
    hub_id: raw.hub_id.trim(),
    fp: raw.fp.toLowerCase(),
    addrs: raw.addrs.map(a => String(a).trim()),
    port: raw.port,
    sid: raw.sid.trim(),
    code: raw.code.trim(),
  };
  if (raw.mode === 'invite') {
    if (typeof raw.sec !== 'string' || !raw.sec.trim()) throw new Error('邀请二维码缺少传输密钥。');
    return { ...base, mode: 'invite', sec: raw.sec.trim() };
  }
  if (raw.mode === 'join_wait') {
    if (typeof raw.epk !== 'string' || !raw.epk.trim()) throw new Error('待加入二维码缺少临时公钥。');
    return { ...base, mode: 'join_wait', epk: raw.epk.trim() };
  }
  throw new Error('未知的配对二维码模式。');
}

export class SyncPairingService {
  private readonly secretStore: SyncSecretStore;
  private readonly hubStore: KnownHubStore;
  private readonly dataDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly mdnsBrowser: MdnsBrowser;
  private readonly localAddressesProvider?: () => string[];
  private readonly pendingJoinKeys = new Map<string, { privRaw: Buffer; hubId: string; fp: string; baseURL: string; expiresAtMs: number }>();

  private pruneExpiredJoinKeys(nowMs = Date.now()) {
    for (const [sid, entry] of this.pendingJoinKeys.entries()) {
      if (nowMs >= entry.expiresAtMs) {
        entry.privRaw.fill(0);
        this.pendingJoinKeys.delete(sid);
      }
    }
  }

  private assertSpaceSwitchAllowed(nextVaultId: string, allowReplaceSpace?: boolean): boolean {
    const existingSeed = this.getRootSeed();
    if (!existingSeed) return false;
    const currentVaultId = deriveSpaceKeys(existingSeed).vaultId;
    if (currentVaultId === nextVaultId) return false;
    if (!allowReplaceSpace) {
      throw new Error('本机已加入另一个个人同步空间；若确认切换，请先确认替换现有空间。');
    }
    return true;
  }

  constructor(options: SyncPairingServiceOptions) {
    this.secretStore = options.secretStore;
    this.hubStore = options.hubStore;
    this.dataDir = options.dataDir;
    this.fetchImpl = options.fetchImpl;
    this.mdnsBrowser = options.mdnsBrowser ?? new UdpMdnsBrowser();
    this.localAddressesProvider = options.localAddressesProvider;
  }

  ensureDeviceIdentity(): DeviceIdentity {
    const existing = this.secretStore.load();
    if (existing?.deviceId && existing?.devicePrivateSeedB64) {
      const privateSeed = Buffer.from(existing.devicePrivateSeedB64, 'base64url');
      return {
        deviceId: existing.deviceId,
        privateSeed,
        ...ed25519FromSeed(privateSeed),
      };
    }
    const created = generateDeviceIdentity();
    this.secretStore.save({
      deviceId: created.deviceId,
      devicePrivateSeedB64: created.privateSeed.toString('base64url'),
      ...(existing?.rootSeedB64 ? { rootSeedB64: existing.rootSeedB64 } : {}),
    });
    return created;
  }

  private getRootSeed(): Buffer | null {
    const stored = this.secretStore.load();
    if (!stored?.rootSeedB64) return null;
    const buf = Buffer.from(stored.rootSeedB64, 'base64url');
    return buf.length === 32 ? buf : null;
  }

  private saveRootSeed(rootSeed: Buffer) {
    const dev = this.ensureDeviceIdentity();
    this.secretStore.save({
      deviceId: dev.deviceId,
      devicePrivateSeedB64: dev.privateSeed.toString('base64url'),
      rootSeedB64: rootSeed.toString('base64url'),
    });
  }

  private requireRootSeed(): Buffer {
    const seed = this.getRootSeed();
    if (!seed) throw new Error('尚未启用或加入个人同步空间。');
    return seed;
  }

  private localClient(): AcpmClient {
    return new AcpmClient({
      mode: 'local',
      caller: 'yanmo-sync',
      dataDir: this.dataDir,
      fetchImpl: this.fetchImpl,
    });
  }

  private remotePopClient(
    baseURL: string,
    dev: DeviceIdentity,
    expectedServerPubkeyFp?: string,
    serverPubkey?: string,
  ): AcpmClient {
    return new AcpmClient({
      mode: 'remote',
      remoteBaseURL: baseURL,
      popAuth: {
        deviceId: dev.deviceId,
        privateSeed: dev.privateSeed,
        expectedServerPubkeyFp,
        serverPubkey,
      },
      caller: 'yanmo-sync',
      fetchImpl: this.fetchImpl,
    });
  }

  private upsertKnownHub(hub: KnownHub) {
    const list = this.hubStore.load();
    const index = list.findIndex(item => item.hubInstanceId === hub.hubInstanceId);
    if (index >= 0) {
      list[index] = {
        ...list[index],
        ...hub,
        pairedAtMs: list[index].pairedAtMs || hub.pairedAtMs,
        manualRemoteUrl: hub.manualRemoteUrl ?? list[index].manualRemoteUrl,
      };
    } else {
      list.push(hub);
    }
    this.hubStore.save(list);
  }

  private resolveClientForHub(hubId?: string): AcpmClient {
    const dev = this.ensureDeviceIdentity();
    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, true);
    } catch {
      localDisc = null;
    }

    const known = this.hubStore.load();
    if (!hubId) {
      if (localDisc) return this.localClient();
      if (known[0]) {
        const url = resolveHubBaseUrl(known[0], { localDiscovery: localDisc });
        if (url) return this.remotePopClient(url, dev, known[0].serverPubkeyFp, known[0].serverPubkey);
      }
      throw new Error('未找到可用的 AcpmRuntime 节点。');
    }

    if (localDisc?.hub_instance_id === hubId) {
      return this.localClient();
    }
    const target = known.find(item => item.hubInstanceId === hubId);
    if (!target) {
      if (localDisc) return this.localClient();
      throw new Error('未找到指定的 AcpmRuntime 节点。');
    }
    const url = resolveHubBaseUrl(target, { localDiscovery: localDisc });
    if (!url) throw new Error('指定 AcpmRuntime 节点暂无可用地址。');
    return this.remotePopClient(url, dev, target.serverPubkeyFp, target.serverPubkey);
  }

  getStatus(): SyncStateSummary {
    const stored = this.secretStore.load();
    let vaultId: string | undefined;
    if (stored?.rootSeedB64) {
      const buf = Buffer.from(stored.rootSeedB64, 'base64url');
      if (buf.length === 32) {
        vaultId = deriveSpaceKeys(buf).vaultId;
      }
    }
    const knownHubs = this.hubStore.load().map(hub => ({
      hubInstanceId: hub.hubInstanceId,
      hubName: hub.hubName,
      serverPubkeyFp: hub.serverPubkeyFp,
      lastKnownUrl: hub.lastKnownUrl,
      manualRemoteUrl: hub.manualRemoteUrl,
      lastSeenAtMs: hub.lastSeenAtMs,
    }));
    return {
      enabled: Boolean(vaultId),
      vaultId,
      deviceId: stored?.deviceId ?? '',
      knownHubs,
    };
  }

  setHubManualUrl(hubId: string, manualRemoteUrl: string): SyncStateSummary {
    const cleanId = hubId.trim();
    if (!cleanId) throw new Error('缺少同步节点 ID。');
    const cleanUrl = manualRemoteUrl.trim().replace(/\/+$/, '');
    if (cleanUrl) checkAcpmURL(cleanUrl);
    const known = this.hubStore.load();
    const index = known.findIndex(item => item.hubInstanceId === cleanId);
    if (index < 0) {
      throw new Error('未找到指定的同步节点。');
    }
    known[index] = {
      ...known[index],
      manualRemoteUrl: cleanUrl || undefined,
    };
    this.hubStore.save(known);
    return this.getStatus();
  }

  disableSync(): SyncStateSummary {
    const stored = this.secretStore.load();
    if (stored) {
      this.secretStore.save({
        deviceId: stored.deviceId,
        devicePrivateSeedB64: stored.devicePrivateSeedB64,
      });
    }
    this.hubStore.save([]);
    for (const entry of this.pendingJoinKeys.values()) {
      entry.privRaw.fill(0);
    }
    this.pendingJoinKeys.clear();
    return this.getStatus();
  }

  async enableOnLocalHub(deviceName: string, platform: SyncPlatform): Promise<SyncStateSummary> {
    const dev = this.ensureDeviceIdentity();
    let rootSeed = this.getRootSeed();
    if (!rootSeed) {
      rootSeed = generateRootSeed();
      this.saveRootSeed(rootSeed);
    }
    const space = deriveSpaceKeys(rootSeed);
    const localDisc = discoverAcpmRuntime(this.dataDir, true);
    const client = this.localClient();
    const hubIdInfo = await client.hubIdentity();

    const cert = signMembershipCert(space.ownerPrivateKey, {
      version: 1,
      vault_id: space.vaultId,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      platform,
      issued_at_ms: Date.now(),
    });

    await client.registerVault({
      vault_id: space.vaultId,
      owner_pubkey: space.ownerPublicKeyB64,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      device_name: deviceName,
      platform,
      membership_cert: cert,
    });

    const now = Date.now();
    this.upsertKnownHub({
      hubInstanceId: hubIdInfo.hub_instance_id,
      hubName: localDisc.mdns_hostname || '本机 AcpmRuntime',
      serverPubkey: hubIdInfo.server_pubkey,
      serverPubkeyFp: hubIdInfo.server_pubkey_fp,
      lastKnownUrl: localDisc.http_base_url,
      pairedAtMs: now,
      lastSeenAtMs: now,
    });
    return this.getStatus();
  }

  exportRecoveryCode(): string {
    return encodeRecoveryCode(this.requireRootSeed());
  }

  async restoreFromRecoveryCode(
    code: string,
    deviceName: string,
    platform: SyncPlatform,
    options: { registerLocal?: boolean; allowReplaceSpace?: boolean } = {},
  ): Promise<SyncStateSummary> {
    const seed = decodeRecoveryCode(code);
    const space = deriveSpaceKeys(seed);
    const replaced = this.assertSpaceSwitchAllowed(space.vaultId, options.allowReplaceSpace);
    this.saveRootSeed(seed);
    if (replaced) this.hubStore.save([]);
    if (options.registerLocal !== false) {
      return this.enableOnLocalHub(deviceName, platform);
    }
    return this.getStatus();
  }

  async createInvitePairing(options: {
    scopes?: AcpmScope[];
    hubId?: string;
    advertiseAddrs?: string[];
  } = {}): Promise<{ qrPayload: InviteQrPayload; qrUri: string; expiresAtMs: number }> {
    const rootSeed = this.requireRootSeed();
    const space = deriveSpaceKeys(rootSeed);
    const client = this.resolveClientForHub(options.hubId);
    const identity = await client.hubIdentity();

    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, false);
    } catch {
      localDisc = null;
    }
    const known = this.hubStore.load().find(item => item.hubInstanceId === identity.hub_instance_id);
    const baseUrl = (localDisc?.hub_instance_id === identity.hub_instance_id ? localDisc.http_base_url : undefined)
      ?? known?.manualRemoteUrl
      ?? known?.lastKnownUrl
      ?? localDisc?.http_base_url;
    if (!baseUrl) {
      throw new Error('无法确定当前 AcpmRuntime 的访问端口。');
    }

    const pairSecret = randomBytes(32);
    const scopes = options.scopes ?? ['inference', 'yanmo.sync'];
    const includeSync = scopes.includes('yanmo.sync');
    const aad = `yanmo-pair-invite-v1|${identity.hub_instance_id}`;
    const encryptedSeedBox = includeSync
      ? sealPairingSeedBox(pairSecret, {
        root_seed_b64: rootSeed.toString('base64url'),
        vault_id: space.vaultId,
        owner_pubkey: space.ownerPublicKeyB64,
      } satisfies SeedBoxContent, aad)
      : undefined;

    const session = await client.createPairingSession({
      mode: 'inviter',
      scopes,
      ...(includeSync ? { vault_id: space.vaultId, encrypted_seed_box: encryptedSeedBox } : {}),
    });

    const addrs = options.advertiseAddrs?.length
      ? options.advertiseAddrs
      : (this.localAddressesProvider ? this.localAddressesProvider() : defaultLocalAddresses(localDisc));
    const port = portFromUrl(baseUrl);

    const qrPayload: InviteQrPayload = {
      v: 1,
      mode: 'invite',
      hub_id: identity.hub_instance_id,
      fp: identity.server_pubkey_fp,
      addrs: addrs.length ? addrs : ['127.0.0.1'],
      port,
      sid: session.session_id,
      code: session.acpm_pair_code,
      sec: pairSecret.toString('base64url'),
    };

    return {
      qrPayload,
      qrUri: encodePairingQrUri(qrPayload),
      expiresAtMs: session.expires_at_ms,
    };
  }

  private async connectCandidateHub(
    addrs: string[],
    port: number,
    expectedHubId: string,
    expectedFp: string,
    dev: DeviceIdentity,
  ): Promise<{ baseURL: string; identity: AcpmHubIdentityResponse }> {
    let lastError: unknown;
    for (const addr of addrs) {
      let candidateUrl: string;
      if (addr.startsWith('http://') || addr.startsWith('https://')) {
        candidateUrl = addr.replace(/\/+$/, '');
      } else {
        const host = addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
        candidateUrl = `http://${host}:${port}`;
      }
      const client = this.remotePopClient(candidateUrl, dev, expectedFp);
      try {
        const identity = await client.hubIdentity();
        if (identity.hub_instance_id !== expectedHubId) {
          throw new Error('AcpmRuntime 节点 ID 与二维码不一致。');
        }
        return { baseURL: candidateUrl, identity };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('无法连接到二维码指定的 AcpmRuntime 节点。');
  }

  async redeemInvitePairing(
    qrInput: string,
    deviceName: string,
    platform: SyncPlatform,
    options: { allowReplaceSpace?: boolean } = {},
  ): Promise<SyncStateSummary> {
    const qr = parsePairingQr(qrInput);
    if (qr.mode !== 'invite') {
      throw new Error('此二维码不是邀请配对码。');
    }
    const dev = this.ensureDeviceIdentity();
    const { baseURL, identity } = await this.connectCandidateHub(qr.addrs, qr.port, qr.hub_id, qr.fp, dev);
    const anonClient = this.remotePopClient(baseURL, dev, qr.fp, identity.server_pubkey);

    const redeemed = await anonClient.redeemPairingSession({
      session_id: qr.sid,
      acpm_pair_code: qr.code,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      device_name: deviceName,
      platform,
    });

    if (redeemed.encrypted_seed_box) {
      const pairSecret = Buffer.from(qr.sec, 'base64url');
      const box = openPairingSeedBox<SeedBoxContent>(
        pairSecret,
        redeemed.encrypted_seed_box,
        `yanmo-pair-invite-v1|${identity.hub_instance_id}`,
      );
      const rootSeed = Buffer.from(box.root_seed_b64, 'base64url');
      const space = deriveSpaceKeys(rootSeed);
      if (space.vaultId !== box.vault_id || space.ownerPublicKeyB64 !== box.owner_pubkey) {
        throw new Error('个人空间密钥校验失败。');
      }
      const replaced = this.assertSpaceSwitchAllowed(space.vaultId, options.allowReplaceSpace);
      this.saveRootSeed(rootSeed);
      if (replaced) this.hubStore.save([]);

      const cert = signMembershipCert(space.ownerPrivateKey, {
        version: 1,
        vault_id: space.vaultId,
        device_id: dev.deviceId,
        device_pubkey: dev.publicKeyB64,
        platform,
        issued_at_ms: Date.now(),
      });
      const popClient = this.remotePopClient(baseURL, dev, qr.fp, identity.server_pubkey);
      await popClient.registerVault({
        vault_id: space.vaultId,
        owner_pubkey: space.ownerPublicKeyB64,
        device_id: dev.deviceId,
        device_pubkey: dev.publicKeyB64,
        device_name: deviceName,
        platform,
        membership_cert: cert,
      });
    }

    const now = Date.now();
    this.upsertKnownHub({
      hubInstanceId: identity.hub_instance_id,
      hubName: qr.addrs[0] || identity.hub_instance_id,
      serverPubkey: identity.server_pubkey,
      serverPubkeyFp: identity.server_pubkey_fp,
      lastKnownUrl: baseURL,
      pairedAtMs: now,
      lastSeenAtMs: now,
    });
    return this.getStatus();
  }

  async createJoinWaitPairing(options: {
    advertiseAddrs?: string[];
  } = {}): Promise<{ qrPayload: JoinWaitQrPayload; qrUri: string; sessionId: string; expiresAtMs: number }> {
    this.pruneExpiredJoinKeys();
    const localDisc = discoverAcpmRuntime(this.dataDir, true);
    const client = this.localClient();
    const identity = await client.hubIdentity();
    const eph = generateX25519Keypair();

    const session = await client.createPairingSession({
      mode: 'join_wait',
      joiner_eph_pubkey: eph.publicKeyB64,
    });

    this.pendingJoinKeys.set(session.session_id, {
      privRaw: eph.privateKeyRaw,
      hubId: identity.hub_instance_id,
      fp: identity.server_pubkey_fp,
      baseURL: localDisc.http_base_url,
      expiresAtMs: session.expires_at_ms,
    });

    const addrs = options.advertiseAddrs?.length
      ? options.advertiseAddrs
      : (this.localAddressesProvider ? this.localAddressesProvider() : defaultLocalAddresses(localDisc));
    const port = portFromUrl(localDisc.http_base_url);

    const qrPayload: JoinWaitQrPayload = {
      v: 1,
      mode: 'join_wait',
      hub_id: identity.hub_instance_id,
      fp: identity.server_pubkey_fp,
      addrs: addrs.length ? addrs : ['127.0.0.1'],
      port,
      sid: session.session_id,
      code: session.acpm_pair_code,
      epk: eph.publicKeyB64,
    };

    return {
      qrPayload,
      qrUri: encodePairingQrUri(qrPayload),
      sessionId: session.session_id,
      expiresAtMs: session.expires_at_ms,
    };
  }

  async fulfillJoinWaitAsExistingDevice(
    qrInput: string,
    deviceName: string,
    platform: SyncPlatform,
  ): Promise<SyncStateSummary> {
    const qr = parsePairingQr(qrInput);
    if (qr.mode !== 'join_wait') {
      throw new Error('此二维码不是待加入配对码。');
    }
    const rootSeed = this.requireRootSeed();
    const space = deriveSpaceKeys(rootSeed);
    const dev = this.ensureDeviceIdentity();

    const { baseURL, identity } = await this.connectCandidateHub(qr.addrs, qr.port, qr.hub_id, qr.fp, dev);
    const anonClient = this.remotePopClient(baseURL, dev, qr.fp, identity.server_pubkey);

    const session = await anonClient.getPairingSession(qr.sid, qr.code);
    const joinerEphPub = session.joiner_eph_pubkey || qr.epk;
    if (joinerEphPub !== qr.epk) {
      throw new Error('待加入节点的临时公钥校验不一致。');
    }

    const senderEph = generateX25519Keypair();
    const pairKey = deriveJoinPairKey(senderEph.privateKeyRaw, joinerEphPub, qr.sid);
    const encryptedSeedBox = sealPairingSeedBox(
      pairKey,
      {
        root_seed_b64: rootSeed.toString('base64url'),
        vault_id: space.vaultId,
        owner_pubkey: space.ownerPublicKeyB64,
      } satisfies SeedBoxContent,
      `yanmo-pair-join-v1|${qr.sid}`,
    );

    await anonClient.redeemPairingSession({
      session_id: qr.sid,
      acpm_pair_code: qr.code,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      device_name: deviceName,
      platform,
      sender_eph_pubkey: senderEph.publicKeyB64,
      encrypted_seed_box: encryptedSeedBox,
    });

    const cert = signMembershipCert(space.ownerPrivateKey, {
      version: 1,
      vault_id: space.vaultId,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      platform,
      issued_at_ms: Date.now(),
    });
    const popClient = this.remotePopClient(baseURL, dev, qr.fp, identity.server_pubkey);
    await popClient.registerVault({
      vault_id: space.vaultId,
      owner_pubkey: space.ownerPublicKeyB64,
      device_id: dev.deviceId,
      device_pubkey: dev.publicKeyB64,
      device_name: deviceName,
      platform,
      membership_cert: cert,
    });

    const now = Date.now();
    this.upsertKnownHub({
      hubInstanceId: identity.hub_instance_id,
      hubName: qr.addrs[0] || identity.hub_instance_id,
      serverPubkey: identity.server_pubkey,
      serverPubkeyFp: identity.server_pubkey_fp,
      lastKnownUrl: baseURL,
      pairedAtMs: now,
      lastSeenAtMs: now,
    });
    return this.getStatus();
  }

  async completeJoinWaitOnNewDevice(
    sessionId: string,
    deviceName: string,
    platform: SyncPlatform,
    joinerEphPrivRawOrOptions?: Buffer | { joinerEphPrivRaw?: Buffer; allowReplaceSpace?: boolean },
  ): Promise<SyncStateSummary> {
    this.pruneExpiredJoinKeys();
    const opts = Buffer.isBuffer(joinerEphPrivRawOrOptions)
      ? { joinerEphPrivRaw: joinerEphPrivRawOrOptions }
      : (joinerEphPrivRawOrOptions ?? {});
    const pending = this.pendingJoinKeys.get(sessionId);
    const privRaw = opts.joinerEphPrivRaw ?? pending?.privRaw;
    if (!privRaw) {
      throw new Error('未找到对应的待加入配对会话，请重新生成二维码。');
    }

    const client = this.localClient();
    const session = await client.getPairingSession(sessionId);
    if (session.status !== 'fulfilled' || !session.sender_eph_pubkey || !session.encrypted_seed_box) {
      throw new Error('等待其他已配对设备扫码确认中。');
    }

    const pairKey = deriveJoinPairKey(privRaw, session.sender_eph_pubkey, sessionId);
    const box = openPairingSeedBox<SeedBoxContent>(
      pairKey,
      session.encrypted_seed_box,
      `yanmo-pair-join-v1|${sessionId}`,
    );
    const rootSeed = Buffer.from(box.root_seed_b64, 'base64url');
    const space = deriveSpaceKeys(rootSeed);
    if (space.vaultId !== box.vault_id || space.ownerPublicKeyB64 !== box.owner_pubkey) {
      throw new Error('个人空间密钥校验失败。');
    }

    const replaced = this.assertSpaceSwitchAllowed(space.vaultId, opts.allowReplaceSpace);
    this.saveRootSeed(rootSeed);
    if (replaced) this.hubStore.save([]);
    if (pending) {
      pending.privRaw.fill(0);
      this.pendingJoinKeys.delete(sessionId);
    }
    return this.enableOnLocalHub(deviceName, platform);
  }

  async discoverKnownHubs(timeoutMs = 2500): Promise<{
    matched: { hubInstanceId: string; url: string }[];
    spoofedHubIds: string[];
    unknownCount: number;
  }> {
    const dev = this.ensureDeviceIdentity();
    const known = this.hubStore.load();
    const discovered = await this.mdnsBrowser.discover(timeoutMs);
    const result = matchKnownHubs(discovered, known);

    const verified: { hubInstanceId: string; url: string }[] = [];
    for (const item of result.matched) {
      const url = resolveHubBaseUrl(item.known, { discovered: item.discovered });
      if (!url) continue;
      try {
        const client = this.remotePopClient(url, dev, item.known.serverPubkeyFp, item.known.serverPubkey);
        const identity = await client.hubIdentity();
        if (identity.hub_instance_id === item.known.hubInstanceId) {
          this.upsertKnownHub({
            ...item.known,
            lastKnownUrl: url,
            lastSeenAtMs: Date.now(),
          });
          verified.push({ hubInstanceId: item.known.hubInstanceId, url });
        }
      } catch { /* Ignore unreachable or unverified discovery candidate. */ }
    }

    return {
      matched: verified,
      spoofedHubIds: result.spoofed.map(s => s.discovered.hubInstanceId),
      unknownCount: result.unknown.length,
    };
  }

  private resolveStrictClientForHub(hubId?: string): AcpmClient {
    const dev = this.ensureDeviceIdentity();
    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, true);
    } catch {
      localDisc = null;
    }
    const known = this.hubStore.load();
    if (!hubId) {
      return this.resolveClientForHub();
    }
    if (localDisc?.hub_instance_id === hubId) {
      return this.localClient();
    }
    const target = known.find(item => item.hubInstanceId === hubId);
    if (!target) {
      throw new Error(`未找到指定的 AcpmRuntime 节点 ${hubId}。`);
    }
    const url = resolveHubBaseUrl(target, { localDiscovery: localDisc });
    if (!url) throw new Error('指定 AcpmRuntime 节点暂无可用地址。');
    return this.remotePopClient(url, dev, target.serverPubkeyFp, target.serverPubkey);
  }

  async listDevices(hubId?: string): Promise<AcpmPairedDeviceDTO[]> {
    return this.resolveStrictClientForHub(hubId).listDevices();
  }

  async updateDevice(
    deviceId: string,
    patch: { device_name?: string; scopes?: AcpmScope[] },
    hubId?: string,
  ): Promise<AcpmPairedDeviceDTO> {
    return this.resolveStrictClientForHub(hubId).updateDevice(deviceId, patch);
  }

  async revokeDevice(
    deviceId: string,
    hubId?: string,
  ): Promise<{ device_id: string; revoked_at_ms: number }> {
    if (hubId) {
      return this.resolveStrictClientForHub(hubId).revokeDevice(deviceId);
    }
    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, true);
    } catch {
      localDisc = null;
    }
    const known = this.hubStore.load();
    const targetIds = new Set<string>(known.map(h => h.hubInstanceId));
    if (localDisc?.hub_instance_id) {
      targetIds.add(localDisc.hub_instance_id);
    }
    if (targetIds.size === 0) {
      return this.localClient().revokeDevice(deviceId);
    }
    let firstResult: { device_id: string; revoked_at_ms: number } | null = null;
    const errors: Error[] = [];
    for (const id of targetIds) {
      try {
        const res = await this.resolveStrictClientForHub(id).revokeDevice(deviceId);
        if (!firstResult) firstResult = res;
      } catch (error) {
        if (error instanceof AcpmError && error.httpStatus === 404) {
          continue;
        }
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
    if (firstResult) {
      return firstResult;
    }
    throw new Error('未在任何已配对节点上找到该设备。');
  }
}
