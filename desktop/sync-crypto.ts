import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  KeyObject,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { termGroup, termKey } from './hotwords';
import type { TermGroup } from './shared';

const SYNC_SALT = 'yanmo-sync-v1';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE32_LOOKUP = new Map<string, number>([...BASE32_ALPHABET].map((ch, idx) => [ch, idx]));

// RFC 8410 ASN.1 DER prefixes for 32-byte raw keys.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const ENVELOPE_VERSION = 0x01;
const FLAG_COMPRESSED = 0x01;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type SyncPlatform = 'macos' | 'windows' | 'android';
export type SyncCollection = 'lexicon' | 'manuscript';

export interface SpaceKeys {
  vaultId: string;
  ownerSignSeed: Buffer;
  ownerPrivateKey: KeyObject;
  ownerPublicKey: KeyObject;
  ownerPublicKeyRaw: Buffer;
  ownerPublicKeyB64: string;
  dataEncKey: Buffer;
  keyMacKey: Buffer;
}

export interface DeviceIdentity {
  deviceId: string;
  privateSeed: Buffer;
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeyRaw: Buffer;
  publicKeyB64: string;
}

export interface MembershipCertPayload {
  version: 1;
  vault_id: string;
  device_id: string;
  device_pubkey: string;
  platform: SyncPlatform;
  issued_at_ms: number;
}

export interface SignedMembershipCert extends MembershipCertPayload {
  owner_signature: string;
}

export type PopHeaders = {
  'X-Acpm-Device': string;
  'X-Acpm-Timestamp': string;
  'X-Acpm-Nonce': string;
  'X-Acpm-Signature': string;
};

export function base32Encode(data: Uint8Array, options: { lower?: boolean } = {}): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return options.lower ? out.toLowerCase() : out;
}

export function base32Decode(encoded: string): Buffer {
  const clean = encoded.trim().toUpperCase();
  if (!clean) return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_LOOKUP.get(ch);
    if (idx === undefined) {
      throw new Error('Base32 字符串包含无效字符。');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('Base32 字符串长度或填充位无效。');
  }
  return Buffer.from(bytes);
}

export function crc16CcittFalse(data: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function encodeRecoveryCode(rootSeed: Uint8Array): string {
  if (rootSeed.length !== 32) {
    throw new Error('root_seed 必须为 32 字节。');
  }
  const crc = crc16CcittFalse(rootSeed);
  const payload = Buffer.allocUnsafe(34);
  Buffer.from(rootSeed).copy(payload, 0);
  payload.writeUInt16BE(crc, 32);
  const b32 = base32Encode(payload);
  const groups = b32.match(/.{1,4}/g) ?? [];
  return `YM1-${groups.join('-')}`;
}

export function decodeRecoveryCode(code: string): Buffer {
  const normalized = code.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!normalized.startsWith('YM1') || normalized.length < 4) {
    throw new Error('恢复码格式无效，需以 YM1- 开头。');
  }
  const payload = base32Decode(normalized.slice(3));
  if (payload.length !== 34) {
    throw new Error('恢复码长度无效。');
  }
  const seed = payload.subarray(0, 32);
  const expectedCrc = payload.readUInt16BE(32);
  if (crc16CcittFalse(seed) !== expectedCrc) {
    throw new Error('恢复码校验失败，请检查是否有字符输入错误。');
  }
  return Buffer.from(seed);
}

function toRaw32(input: Buffer | Uint8Array | string, label: string): Buffer {
  const buf = typeof input === 'string' ? Buffer.from(input.trim(), 'base64url') : Buffer.from(input);
  if (buf.length !== 32) {
    throw new Error(`${label} 必须为 32 字节。`);
  }
  return buf;
}

export function ed25519PrivateKeyFromSeed(seed: Buffer | Uint8Array | string): KeyObject {
  const raw = toRaw32(seed, 'Ed25519 私钥种子');
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function ed25519PublicKeyFromRaw(rawOrB64: Buffer | Uint8Array | string): KeyObject {
  const raw = toRaw32(rawOrB64, 'Ed25519 公钥');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function extractRawPublicKey(key: KeyObject): Buffer {
  const spki = key.export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function extractRawPrivateSeed(key: KeyObject): Buffer {
  const pkcs8 = key.export({ format: 'der', type: 'pkcs8' });
  return Buffer.from(pkcs8.subarray(pkcs8.length - 32));
}

export function ed25519FromSeed(seed: Buffer | Uint8Array | string) {
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  const publicKey = createPublicKey(privateKey);
  const publicKeyRaw = extractRawPublicKey(publicKey);
  return {
    privateKey,
    publicKey,
    publicKeyRaw,
    publicKeyB64: publicKeyRaw.toString('base64url'),
  };
}

export function computePubkeyFingerprint(rawOrB64: Buffer | Uint8Array | string): string {
  const raw = toRaw32(rawOrB64, 'Ed25519 公钥');
  return createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex');
}

export function generateX25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const privateKeyRaw = extractRawPrivateSeed(privateKey);
  const publicKeyRaw = extractRawPublicKey(publicKey);
  return {
    privateKey,
    publicKey,
    privateKeyRaw,
    publicKeyRaw,
    publicKeyB64: publicKeyRaw.toString('base64url'),
  };
}

export function deriveJoinPairKey(
  myPrivRaw: Buffer | Uint8Array | string,
  peerPubRaw: Buffer | Uint8Array | string,
  sessionId: string,
): Buffer {
  const priv = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, toRaw32(myPrivRaw, 'X25519 私钥')]),
    format: 'der',
    type: 'pkcs8',
  });
  const pub = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, toRaw32(peerPubRaw, 'X25519 公钥')]),
    format: 'der',
    type: 'spki',
  });
  const sharedSecret = diffieHellman({ privateKey: priv, publicKey: pub });
  return Buffer.from(hkdfSync('sha256', sharedSecret, SYNC_SALT, `pair-join|${sessionId}`, 32));
}

export function generateRootSeed(): Buffer {
  return randomBytes(32);
}

export function deriveSpaceKeys(rootSeed: Buffer | Uint8Array): SpaceKeys {
  const seed = toRaw32(rootSeed, 'root_seed');
  const vaultBytes = Buffer.from(hkdfSync('sha256', seed, SYNC_SALT, 'vault-id', 16));
  const vaultId = base32Encode(vaultBytes, { lower: true });
  const ownerSignSeed = Buffer.from(hkdfSync('sha256', seed, SYNC_SALT, 'owner-sign-ed25519', 32));
  const dataEncKey = Buffer.from(hkdfSync('sha256', seed, SYNC_SALT, 'data-enc-aes256gcm', 32));
  const keyMacKey = Buffer.from(hkdfSync('sha256', seed, SYNC_SALT, 'record-key-hmac', 32));
  const owner = ed25519FromSeed(ownerSignSeed);
  return {
    vaultId,
    ownerSignSeed,
    ownerPrivateKey: owner.privateKey,
    ownerPublicKey: owner.publicKey,
    ownerPublicKeyRaw: owner.publicKeyRaw,
    ownerPublicKeyB64: owner.publicKeyB64,
    dataEncKey,
    keyMacKey,
  };
}

export function computeLexiconRecordKey(
  keyMacKey: Buffer | Uint8Array,
  term: string,
  group?: TermGroup | string | null,
): string {
  const normalized = termKey(term);
  if (!normalized) {
    throw new Error('词条规范键不能为空。');
  }
  const normalizedGroup = termGroup(group ?? undefined);
  return createHmac('sha256', keyMacKey).update(`term:${normalizedGroup}:${normalized}`, 'utf8').digest('hex');
}

export function computeBlobId(keyMacKey: Buffer | Uint8Array, plaintextSha256Hex: string): string {
  const cleanHash = plaintextSha256Hex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleanHash)) {
    throw new Error('附件 SHA-256 哈希格式无效。');
  }
  return createHmac('sha256', keyMacKey).update(`blob:${cleanHash}`, 'utf8').digest('hex');
}

export function generateDeviceIdentity(): DeviceIdentity {
  const deviceId = randomUUID();
  const privateSeed = randomBytes(32);
  const pair = ed25519FromSeed(privateSeed);
  return {
    deviceId,
    privateSeed,
    ...pair,
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('规范 JSON 不支持非有限数字。');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',') + '}';
  }
  throw new Error(`规范 JSON 不支持的类型: ${typeof value}`);
}

export function signMembershipCert(
  ownerPrivateKey: KeyObject,
  payload: MembershipCertPayload,
): SignedMembershipCert {
  const bytes = Buffer.from(canonicalJson(payload), 'utf8');
  const sig = cryptoSign(null, bytes, ownerPrivateKey);
  return {
    ...payload,
    owner_signature: sig.toString('base64url'),
  };
}

export function verifyMembershipCert(
  ownerPublicKey: KeyObject | Buffer | Uint8Array | string,
  cert: SignedMembershipCert,
): boolean {
  if (!cert || typeof cert !== 'object' || typeof cert.owner_signature !== 'string' || cert.version !== 1) {
    return false;
  }
  const key = ownerPublicKey instanceof KeyObject ? ownerPublicKey : ed25519PublicKeyFromRaw(ownerPublicKey);
  const payload: MembershipCertPayload = {
    version: cert.version,
    vault_id: cert.vault_id,
    device_id: cert.device_id,
    device_pubkey: cert.device_pubkey,
    platform: cert.platform,
    issued_at_ms: cert.issued_at_ms,
  };
  try {
    const bytes = Buffer.from(canonicalJson(payload), 'utf8');
    const sig = Buffer.from(cert.owner_signature, 'base64url');
    if (sig.length !== 64) return false;
    return cryptoVerify(null, bytes, key, sig);
  } catch {
    return false;
  }
}

export function recordAad(
  vaultId: string,
  collection: SyncCollection,
  recordKey: string,
  versionHlc: string,
  deleted: boolean,
  originDeviceId = '',
): Buffer {
  return Buffer.from(`yanmo-sync-v1|${vaultId}|${collection}|${recordKey}|${versionHlc}|${deleted ? 1 : 0}|${originDeviceId}`, 'utf8');
}

export function blobAad(vaultId: string, blobId: string): Buffer {
  return Buffer.from(`yanmo-blob-v1|${vaultId}|${blobId}`, 'utf8');
}

export function sealEnvelope(
  key32: Buffer | Uint8Array,
  plaintext: Buffer | Uint8Array | string,
  aad: Buffer | Uint8Array | string,
  options: { compress?: boolean } = {},
): Buffer {
  const key = toRaw32(key32, 'AES-256-GCM 密钥');
  const rawInput = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const compress = Boolean(options.compress);
  const payload = compress ? gzipSync(rawInput) : rawInput;
  const flags = compress ? FLAG_COMPRESSED : 0x00;
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([ENVELOPE_VERSION, flags]), nonce, encrypted, tag]);
}

export function openEnvelope(
  key32: Buffer | Uint8Array,
  envelope: Buffer | Uint8Array,
  aad: Buffer | Uint8Array | string,
): Buffer {
  const key = toRaw32(key32, 'AES-256-GCM 密钥');
  const buf = Buffer.from(envelope);
  if (buf.length < 2 + NONCE_BYTES + TAG_BYTES) {
    throw new Error('密文信封长度无效。');
  }
  if (buf[0] !== ENVELOPE_VERSION) {
    throw new Error(`不支持的密文信封版本: ${buf[0]}`);
  }
  const flags = buf[1];
  if ((flags & ~FLAG_COMPRESSED) !== 0) {
    throw new Error(`不支持的密文信封标记位: ${flags}`);
  }
  const nonce = buf.subarray(2, 2 + NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(2 + NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(typeof aad === 'string' ? Buffer.from(aad, 'utf8') : aad);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return (flags & FLAG_COMPRESSED) !== 0 ? gunzipSync(decrypted) : decrypted;
}

export function sealPairingSeedBox(key32: Buffer | Uint8Array, payload: unknown, aad: string): string {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  return sealEnvelope(key32, json, aad, { compress: false }).toString('base64url');
}

export function openPairingSeedBox<T = Record<string, unknown>>(
  key32: Buffer | Uint8Array,
  boxB64: string,
  aad: string,
): T {
  const envelope = Buffer.from(boxB64, 'base64url');
  const plain = openEnvelope(key32, envelope, aad);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function buildPopSigningString(
  method: string,
  pathAndQuery: string,
  bodyBytes: Buffer | Uint8Array | string | undefined,
  timestampMs: number | string,
  nonce: string,
): string {
  const body = bodyBytes === undefined
    ? Buffer.alloc(0)
    : typeof bodyBytes === 'string'
      ? Buffer.from(bodyBytes, 'utf8')
      : Buffer.from(bodyBytes);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${method.toUpperCase()}\n${pathAndQuery}\n${bodyHash}\n${String(timestampMs)}\n${nonce}`;
}

export function signPopHeaders(
  deviceId: string,
  devicePrivateKey: KeyObject | Buffer | Uint8Array | string,
  method: string,
  pathAndQuery: string,
  bodyBytes?: Buffer | Uint8Array | string,
  options: { timestampMs?: number; nonce?: string } = {},
): PopHeaders {
  const key = devicePrivateKey instanceof KeyObject ? devicePrivateKey : ed25519PrivateKeyFromSeed(devicePrivateKey);
  const timestampMs = options.timestampMs ?? Date.now();
  const nonce = options.nonce ?? randomBytes(16).toString('base64url');
  const signingString = buildPopSigningString(method, pathAndQuery, bodyBytes, timestampMs, nonce);
  const sig = cryptoSign(null, Buffer.from(signingString, 'utf8'), key);
  return {
    'X-Acpm-Device': deviceId,
    'X-Acpm-Timestamp': String(timestampMs),
    'X-Acpm-Nonce': nonce,
    'X-Acpm-Signature': sig.toString('base64url'),
  };
}

function headerLookup(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

export function verifyPopHeaders(
  devicePublicKey: KeyObject | Buffer | Uint8Array | string,
  method: string,
  pathAndQuery: string,
  bodyBytes: Buffer | Uint8Array | string | undefined,
  headers: Record<string, string | string[] | undefined>,
  options: { nowMs?: number; maxSkewMs?: number } = {},
): { ok: true; deviceId: string; timestampMs: number; nonce: string } | { ok: false; reason: string } {
  const deviceId = headerLookup(headers, 'x-acpm-device')?.trim();
  const tsRaw = headerLookup(headers, 'x-acpm-timestamp')?.trim();
  const nonce = headerLookup(headers, 'x-acpm-nonce')?.trim();
  const sigRaw = headerLookup(headers, 'x-acpm-signature')?.trim();
  if (!deviceId || !tsRaw || !nonce || !sigRaw) {
    return { ok: false, reason: 'MISSING_POP_HEADERS' };
  }
  if (!/^\d{10,16}$/.test(tsRaw)) {
    return { ok: false, reason: 'INVALID_TIMESTAMP' };
  }
  const timestampMs = Number(tsRaw);
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? 120_000;
  if (!Number.isSafeInteger(timestampMs) || Math.abs(nowMs - timestampMs) > maxSkewMs) {
    return { ok: false, reason: 'TIMESTAMP_SKEW_EXCEEDED' };
  }
  try {
    const key = devicePublicKey instanceof KeyObject ? devicePublicKey : ed25519PublicKeyFromRaw(devicePublicKey);
    const signingString = buildPopSigningString(method, pathAndQuery, bodyBytes, timestampMs, nonce);
    const sig = Buffer.from(sigRaw, 'base64url');
    if (sig.length !== 64 || !cryptoVerify(null, Buffer.from(signingString, 'utf8'), key, sig)) {
      return { ok: false, reason: 'INVALID_SIGNATURE' };
    }
    return { ok: true, deviceId, timestampMs, nonce };
  } catch {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }
}

export function buildServerResponseSigningString(
  clientNonceOrReqId: string,
  serverTimestampMs: number | string,
  responseBodyBytes: Buffer | Uint8Array | string | undefined,
): string {
  const body = responseBodyBytes === undefined
    ? Buffer.alloc(0)
    : typeof responseBodyBytes === 'string'
      ? Buffer.from(responseBodyBytes, 'utf8')
      : Buffer.from(responseBodyBytes);
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${clientNonceOrReqId}\n${String(serverTimestampMs)}\n${bodyHash}`;
}

export function signServerResponse(
  serverPrivateKey: KeyObject | Buffer | Uint8Array | string,
  clientNonceOrReqId: string,
  serverTimestampMs: number,
  responseBodyBytes?: Buffer | Uint8Array | string,
): string {
  const key = serverPrivateKey instanceof KeyObject ? serverPrivateKey : ed25519PrivateKeyFromSeed(serverPrivateKey);
  const signingString = buildServerResponseSigningString(clientNonceOrReqId, serverTimestampMs, responseBodyBytes);
  return cryptoSign(null, Buffer.from(signingString, 'utf8'), key).toString('base64url');
}

export function verifyServerResponse(
  serverPublicKey: KeyObject | Buffer | Uint8Array | string,
  clientNonceOrReqId: string,
  serverTimestampMs: number | string,
  responseBodyBytes: Buffer | Uint8Array | string | undefined,
  signatureB64: string,
): boolean {
  try {
    const key = serverPublicKey instanceof KeyObject ? serverPublicKey : ed25519PublicKeyFromRaw(serverPublicKey);
    const signingString = buildServerResponseSigningString(clientNonceOrReqId, serverTimestampMs, responseBodyBytes);
    const sig = Buffer.from(signatureB64.trim(), 'base64url');
    if (sig.length !== 64) return false;
    return cryptoVerify(null, Buffer.from(signingString, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
