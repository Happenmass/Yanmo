import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpmPairedDeviceDTO, AcpmPushChangeResult, AcpmScope, AcpmSyncChangeItem } from '../acpm';
import {
  computePubkeyFingerprint,
  ed25519FromSeed,
  signServerResponse,
  verifyMembershipCert,
  verifyPopHeaders,
  type SignedMembershipCert,
  type SyncPlatform,
} from '../sync-crypto';

interface PairingSessionRecord {
  session_id: string;
  mode: 'inviter' | 'join_wait';
  status: 'waiting' | 'fulfilled';
  acpm_pair_code: string;
  expires_at_ms: number;
  failed_attempts: number;
  scopes: AcpmScope[];
  vault_id?: string;
  encrypted_seed_box?: string;
  joiner_eph_pubkey?: string;
  sender_eph_pubkey?: string;
}

export interface MockSyncHubOptions {
  baseURL?: string;
  hubInstanceId?: string;
  localToken?: string;
  nowMs?: () => number;
}

export function createMockSyncHub(options: MockSyncHubOptions = {}) {
  const baseURL = (options.baseURL ?? 'http://192.168.1.20:18790').replace(/\/+$/, '');
  const hubInstanceId = options.hubInstanceId ?? randomUUID();
  const localToken = options.localToken ?? `local-${randomUUID()}`;
  const now = options.nowMs ?? (() => Date.now());

  const serverSeed = randomBytes(32);
  const serverKeys = ed25519FromSeed(serverSeed);
  const serverPubkeyFp = computePubkeyFingerprint(serverKeys.publicKeyRaw);

  const pairedDevices = new Map<string, AcpmPairedDeviceDTO>();
  const vaultOwners = new Map<string, string>();
  const pairingSessions = new Map<string, PairingSessionRecord>();
  const seenNonces = new Map<string, number>();
  const syncRecords = new Map<string, AcpmSyncChangeItem & { vault_id: string; seq: number; updated_at_ms: number }>();
  const syncBlobs = new Map<string, Buffer>();
  let seqCounter = 0;

  let tamperNextServerSignature = false;
  let stripNextServerSignature = false;

  const jsonResp = (
    status: number,
    payload: unknown,
    clientNonceOrReqId?: string,
  ): Response => {
    const bodyText = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (status >= 200 && status < 300 && clientNonceOrReqId) {
      if (stripNextServerSignature) {
        stripNextServerSignature = false;
      } else {
        const ts = now();
        let sig = signServerResponse(serverKeys.privateKey, clientNonceOrReqId, ts, bodyText);
        if (tamperNextServerSignature) {
          tamperNextServerSignature = false;
          sig = 'A'.repeat(86);
        }
        headers['X-Acpm-Server-Timestamp'] = String(ts);
        headers['X-Acpm-Server-Signature'] = sig;
      }
    }
    return new Response(bodyText, { status, headers });
  };

  const errResp = (status: number, code: string, message: string, detail = code): Response =>
    jsonResp(status, {
      error: {
        code,
        message,
        request_id: 'mock-req',
        stage: 'SYNC_ADMISSION',
        detail,
        elapsed_ms: 1,
        retryable: false,
      },
    });

  const pruneNonces = (currentMs: number) => {
    for (const [key, ts] of seenNonces.entries()) {
      if (currentMs - ts > 150_000) seenNonces.delete(key);
    }
  };

  const toHeaderRecord = (headers: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  };

  const authenticate = (
    headers: Record<string, string>,
    method: string,
    pathWithQuery: string,
    bodyBytes: Buffer,
    requiredScope?: AcpmScope,
    requiredVaultId?: string,
  ): { ok: true; isLocal: boolean; device?: AcpmPairedDeviceDTO; clientRef: string } | { ok: false; response: Response } => {
    const requestId = headers['x-ai-request-id'] || 'mock-req';
    if (headers.authorization === `Bearer ${localToken}`) {
      return { ok: true, isLocal: true, clientRef: requestId };
    }
    const deviceId = headers['x-acpm-device'];
    if (!deviceId) {
      return { ok: false, response: errResp(401, 'UNAUTHORIZED', '缺少设备鉴权信息') };
    }
    const device = pairedDevices.get(deviceId);
    if (!device) {
      return { ok: false, response: errResp(401, 'UNAUTHORIZED', '设备未配对') };
    }
    if (device.revoked_at_ms !== null && device.revoked_at_ms !== undefined) {
      return { ok: false, response: errResp(403, 'FORBIDDEN', '设备已被吊销') };
    }
    const currentMs = now();
    pruneNonces(currentMs);
    const pop = verifyPopHeaders(device.device_pubkey, method, pathWithQuery, bodyBytes, headers, { nowMs: currentMs });
    if (!pop.ok) {
      return { ok: false, response: errResp(401, 'UNAUTHORIZED', `PoP 鉴权失败: ${pop.reason}`, pop.reason) };
    }
    const nonceKey = `${deviceId}:${pop.nonce}`;
    if (seenNonces.has(nonceKey)) {
      return { ok: false, response: errResp(401, 'UNAUTHORIZED', '检测到重放请求 Nonce', 'REPLAY_NONCE') };
    }
    seenNonces.set(nonceKey, currentMs);
    device.last_seen_at_ms = currentMs;

    if (requiredScope && !device.scopes.includes(requiredScope)) {
      return { ok: false, response: errResp(403, 'FORBIDDEN', `缺少权限: ${requiredScope}`, 'INSUFFICIENT_SCOPE') };
    }
    if (requiredVaultId && device.vault_id !== requiredVaultId) {
      return { ok: false, response: errResp(403, 'FORBIDDEN', '无权访问该同步空间', 'VAULT_MISMATCH') };
    }
    return { ok: true, isLocal: false, device, clientRef: pop.nonce };
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!urlStr.startsWith(baseURL)) {
      throw new TypeError(`fetch failed: unreachable ${urlStr}`);
    }
    const parsed = new URL(urlStr);
    const method = (init?.method || 'GET').toUpperCase();
    const pathWithQuery = `${parsed.pathname}${parsed.search}`;
    const headers = toHeaderRecord(new Headers(init?.headers));
    let bodyBytes = Buffer.alloc(0);
    if (init?.body !== undefined && init.body !== null) {
      if (typeof init.body === 'string') {
        bodyBytes = Buffer.from(init.body, 'utf8');
      } else if (init.body instanceof Uint8Array) {
        bodyBytes = Buffer.from(init.body);
      } else {
        bodyBytes = Buffer.from(await new Response(init.body).arrayBuffer());
      }
    }
    const jsonBody = () => (bodyBytes.length ? JSON.parse(bodyBytes.toString('utf8')) : {});

    if (method === 'GET' && parsed.pathname === '/healthz') {
      return jsonResp(200, { status: 'ok', version: '1.0.0', platform: 'darwin-arm64', hub_instance_id: hubInstanceId });
    }

    if (method === 'GET' && parsed.pathname === '/v1/hub/identity') {
      const nonce = parsed.searchParams.get('nonce') || headers['x-ai-request-id'] || 'identity';
      return jsonResp(200, {
        hub_instance_id: hubInstanceId,
        server_pubkey: serverKeys.publicKeyB64,
        server_pubkey_fp: serverPubkeyFp,
        capabilities: ['inference', 'yanmo.sync'],
        sync_protocol_version: 1,
      }, nonce);
    }

    if (method === 'POST' && parsed.pathname === '/v1/sync/vaults/register') {
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes);
      if (!auth.ok) return auth.response;
      const req = jsonBody() as {
        vault_id: string;
        owner_pubkey: string;
        device_id: string;
        device_pubkey: string;
        device_name: string;
        platform: SyncPlatform;
        membership_cert: SignedMembershipCert;
      };
      const existingOwner = vaultOwners.get(req.vault_id);
      if (existingOwner && existingOwner !== req.owner_pubkey) {
        return errResp(403, 'FORBIDDEN', '空间已被其他所有者注册');
      }
      if (!verifyMembershipCert(req.owner_pubkey, req.membership_cert)
        || req.membership_cert.vault_id !== req.vault_id
        || req.membership_cert.device_id !== req.device_id
        || req.membership_cert.device_pubkey !== req.device_pubkey) {
        return errResp(403, 'FORBIDDEN', '成员归属证书签名无效');
      }
      if (!auth.isLocal && auth.device && auth.device.device_id !== req.device_id) {
        return errResp(403, 'FORBIDDEN', '设备身份与凭证不匹配');
      }
      vaultOwners.set(req.vault_id, req.owner_pubkey);
      const prev = pairedDevices.get(req.device_id);
      const scopes: AcpmScope[] = prev ? [...new Set([...prev.scopes, 'yanmo.sync' as AcpmScope])] : ['inference', 'yanmo.sync'];
      pairedDevices.set(req.device_id, {
        device_id: req.device_id,
        device_pubkey: req.device_pubkey,
        device_name: req.device_name,
        platform: req.platform,
        scopes,
        vault_id: req.vault_id,
        paired_at_ms: prev?.paired_at_ms ?? now(),
        last_seen_at_ms: now(),
        revoked_at_ms: null,
      });
      return jsonResp(200, { vault_id: req.vault_id, device_id: req.device_id, scopes }, auth.clientRef);
    }

    if (method === 'POST' && parsed.pathname === '/v1/pairing/sessions') {
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes);
      if (!auth.ok) return auth.response;
      const req = jsonBody() as {
        mode: 'inviter' | 'join_wait';
        scopes?: AcpmScope[];
        vault_id?: string;
        encrypted_seed_box?: string;
        joiner_eph_pubkey?: string;
      };
      const sessionId = `pair_${randomBytes(8).toString('hex')}`;
      const pairCode = String(10000000 + (randomBytes(4).readUInt32BE(0) % 90000000));
      const expiresAtMs = now() + 180_000;
      pairingSessions.set(sessionId, {
        session_id: sessionId,
        mode: req.mode,
        status: 'waiting',
        acpm_pair_code: pairCode,
        expires_at_ms: expiresAtMs,
        failed_attempts: 0,
        scopes: req.scopes ?? ['inference', 'yanmo.sync'],
        vault_id: req.vault_id,
        encrypted_seed_box: req.encrypted_seed_box,
        joiner_eph_pubkey: req.joiner_eph_pubkey,
      });
      return jsonResp(200, { session_id: sessionId, acpm_pair_code: pairCode, expires_at_ms: expiresAtMs }, auth.clientRef);
    }

    if (method === 'GET' && parsed.pathname.startsWith('/v1/pairing/sessions/')) {
      const sessionId = decodeURIComponent(parsed.pathname.slice('/v1/pairing/sessions/'.length));
      const session = pairingSessions.get(sessionId);
      const pairCodeHeader = headers['x-acpm-pair-code'];
      let clientRef = headers['x-ai-request-id'] || 'mock-req';
      if (pairCodeHeader) {
        if (!session || now() > session.expires_at_ms) {
          if (session) pairingSessions.delete(sessionId);
          return errResp(404, 'NOT_FOUND', '配对会话不存在或已过期');
        }
        if (session.acpm_pair_code !== pairCodeHeader) {
          session.failed_attempts += 1;
          if (session.failed_attempts >= 5) pairingSessions.delete(sessionId);
          return errResp(401, 'UNAUTHORIZED', '配对码错误');
        }
      } else {
        const auth = authenticate(headers, method, pathWithQuery, bodyBytes);
        if (!auth.ok) return auth.response;
        clientRef = auth.clientRef;
        if (!session || now() > session.expires_at_ms) {
          if (session) pairingSessions.delete(sessionId);
          return errResp(404, 'NOT_FOUND', '配对会话不存在或已过期');
        }
      }
      const responsePayload = {
        session_id: session.session_id,
        mode: session.mode,
        status: session.status,
        expires_at_ms: session.expires_at_ms,
        joiner_eph_pubkey: session.joiner_eph_pubkey,
        sender_eph_pubkey: session.sender_eph_pubkey,
        encrypted_seed_box: session.status === 'fulfilled' ? session.encrypted_seed_box : undefined,
      };
      if (session.mode === 'join_wait' && session.status === 'fulfilled' && !pairCodeHeader) {
        pairingSessions.delete(sessionId);
      }
      return jsonResp(200, responsePayload, clientRef);
    }

    if (method === 'POST' && parsed.pathname === '/v1/pairing/redeem') {
      const req = jsonBody() as {
        session_id: string;
        acpm_pair_code: string;
        device_id: string;
        device_pubkey: string;
        device_name: string;
        platform: SyncPlatform;
        sender_eph_pubkey?: string;
        encrypted_seed_box?: string;
      };
      const session = pairingSessions.get(req.session_id);
      if (!session || now() > session.expires_at_ms) {
        if (session) pairingSessions.delete(req.session_id);
        return errResp(404, 'NOT_FOUND', '配对会话不存在或已过期');
      }
      if (session.acpm_pair_code !== req.acpm_pair_code) {
        session.failed_attempts += 1;
        if (session.failed_attempts >= 5) {
          pairingSessions.delete(req.session_id);
          return errResp(403, 'FORBIDDEN', '配对码错误次数过多，会话已失效');
        }
        return errResp(401, 'UNAUTHORIZED', '配对码无效');
      }
      const grantedScopes: AcpmScope[] = ['inference'];
      pairedDevices.set(req.device_id, {
        device_id: req.device_id,
        device_pubkey: req.device_pubkey,
        device_name: req.device_name,
        platform: req.platform,
        scopes: grantedScopes,
        vault_id: null,
        paired_at_ms: now(),
        last_seen_at_ms: now(),
        revoked_at_ms: null,
      });
      if (session.mode === 'inviter') {
        const box = session.encrypted_seed_box;
        pairingSessions.delete(req.session_id);
        return jsonResp(200, {
          session_id: session.session_id,
          mode: session.mode,
          device_id: req.device_id,
          scopes: grantedScopes,
          encrypted_seed_box: box,
        });
      }
      session.sender_eph_pubkey = req.sender_eph_pubkey;
      session.encrypted_seed_box = req.encrypted_seed_box;
      session.status = 'fulfilled';
      return jsonResp(200, {
        session_id: session.session_id,
        mode: session.mode,
        device_id: req.device_id,
        scopes: grantedScopes,
      });
    }

    if (method === 'GET' && parsed.pathname === '/v1/models') {
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes, 'inference');
      if (!auth.ok) return auth.response;
      return jsonResp(200, {
        models: [
          { id: 'qwen3-asr-1.7b', capability: 'asr', display_name: 'Qwen3-ASR 1.7B', installed: true, state: 'WARM', pin_policy: 'auto', idle_timeout_sec: 1200 },
        ],
      }, auth.clientRef);
    }

    const syncMatch = parsed.pathname.match(/^\/v1\/sync\/vaults\/([^/]+)\/changes$/);
    if (syncMatch) {
      const vaultId = decodeURIComponent(syncMatch[1]);
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes, 'yanmo.sync', vaultId);
      if (!auth.ok) return auth.response;

      if (method === 'GET') {
        const sinceSeq = Math.max(0, Number(parsed.searchParams.get('since_seq') || '0'));
        const limit = Math.max(1, Math.min(500, Number(parsed.searchParams.get('limit') || '200')));
        const matching = [...syncRecords.values()]
          .filter(r => r.vault_id === vaultId && r.seq > sinceSeq)
          .sort((a, b) => a.seq - b.seq);
        const page = matching.slice(0, limit).map(({ vault_id: _v, ...rest }) => rest);
        return jsonResp(200, {
          hub_instance_id: hubInstanceId,
          latest_seq: seqCounter,
          has_more: matching.length > limit,
          changes: page,
        }, auth.clientRef);
      }

      if (method === 'POST') {
        const req = jsonBody() as { changes?: AcpmSyncChangeItem[] };
        const incoming = Array.isArray(req.changes) ? req.changes : [];
        if (incoming.length > 200) {
          return errResp(400, 'INVALID_REQUEST', '单批同步记录上限为 200 条');
        }
        const results: AcpmPushChangeResult[] = [];
        const updatedAtMs = now();
        for (const item of incoming) {
          const mapKey = `${vaultId}:${item.collection}:${item.record_key}`;
          const existing = syncRecords.get(mapKey);
          if (!existing || item.version_hlc > existing.version_hlc) {
            seqCounter += 1;
            syncRecords.set(mapKey, {
              ...item,
              vault_id: vaultId,
              seq: seqCounter,
              updated_at_ms: updatedAtMs,
            });
            results.push({ collection: item.collection, record_key: item.record_key, status: 'applied', seq: seqCounter });
          } else if (item.version_hlc === existing.version_hlc) {
            results.push({ collection: item.collection, record_key: item.record_key, status: 'noop', seq: existing.seq });
          } else {
            results.push({
              collection: item.collection,
              record_key: item.record_key,
              status: 'stale',
              current_version_hlc: existing.version_hlc,
            });
          }
        }
        return jsonResp(200, { latest_seq: seqCounter, results }, auth.clientRef);
      }
    }

    const blobMatch = parsed.pathname.match(/^\/v1\/sync\/vaults\/([^/]+)\/blobs\/([^/]+)$/);
    if (blobMatch) {
      const vaultId = decodeURIComponent(blobMatch[1]);
      const blobId = decodeURIComponent(blobMatch[2]);
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes, 'yanmo.sync', vaultId);
      if (!auth.ok) return auth.response;

      const blobKey = `${vaultId}:${blobId}`;
      if (method === 'HEAD') {
        if (!syncBlobs.has(blobKey)) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 200 });
      }
      if (method === 'PUT') {
        syncBlobs.set(blobKey, Buffer.from(bodyBytes));
        return jsonResp(200, { vault_id: vaultId, blob_id: blobId, size_bytes: bodyBytes.byteLength }, auth.clientRef);
      }
      if (method === 'GET') {
        const stored = syncBlobs.get(blobKey);
        if (!stored) return errResp(404, 'NOT_FOUND', '附件不存在');
        const ts = now();
        const sig = signServerResponse(serverKeys.privateKey, auth.clientRef, ts, stored);
        return new Response(new Uint8Array(stored), {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Acpm-Server-Timestamp': String(ts),
            'X-Acpm-Server-Signature': sig,
          },
        });
      }
    }

    if (method === 'GET' && parsed.pathname === '/v1/devices') {
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes);
      if (!auth.ok) return auth.response;
      const devices = [...pairedDevices.values()].filter(d => auth.isLocal || !auth.device?.vault_id || d.vault_id === auth.device.vault_id);
      return jsonResp(200, { devices }, auth.clientRef);
    }

    if (parsed.pathname.startsWith('/v1/devices/')) {
      const deviceId = decodeURIComponent(parsed.pathname.slice('/v1/devices/'.length));
      const auth = authenticate(headers, method, pathWithQuery, bodyBytes);
      if (!auth.ok) return auth.response;
      const target = pairedDevices.get(deviceId);
      if (!target) return errResp(404, 'NOT_FOUND', '未找到设备');
      if (method === 'PATCH') {
        const patch = jsonBody() as { device_name?: string; scopes?: AcpmScope[] };
        if (typeof patch.device_name === 'string') target.device_name = patch.device_name;
        if (Array.isArray(patch.scopes)) target.scopes = patch.scopes;
        return jsonResp(200, target, auth.clientRef);
      }
      if (method === 'DELETE') {
        const revokedAt = now();
        target.revoked_at_ms = revokedAt;
        return jsonResp(200, { device_id: deviceId, revoked_at_ms: revokedAt }, auth.clientRef);
      }
    }

    return errResp(404, 'NOT_FOUND', `未实现接口: ${method} ${parsed.pathname}`);
  };

  return {
    baseURL,
    hubInstanceId,
    serverPubkey: serverKeys.publicKeyB64,
    serverPubkeyFp,
    localToken,
    pairedDevices,
    syncRecords,
    syncBlobs,
    getLatestSeq: () => seqCounter,
    fetchImpl,
    tamperNextServerSignature() {
      tamperNextServerSignature = true;
    },
    stripNextServerSignature() {
      stripNextServerSignature = true;
    },
    writeRuntimeJson(dataDir: string) {
      writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({
        version: 1,
        pid: process.pid,
        started_at: '2026-11-25T05:00:00Z',
        http_base_url: baseURL,
        native_ipc_path: join(dataDir, 'acpmd.sock'),
        token: localToken,
        platform: 'darwin-arm64',
        capabilities: ['llm', 'asr', 'tts', 'vad'],
        mdns_hostname: 'acpm-mock.local',
        mdns_base_url: baseURL,
        hub_instance_id: hubInstanceId,
        server_pubkey_fp: serverPubkeyFp,
      }));
    },
  };
}
