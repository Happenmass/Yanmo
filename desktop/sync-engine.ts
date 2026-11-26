import { createHash, randomUUID } from 'node:crypto';
import {
  AcpmClient,
  discoverAcpmRuntime,
  type AcpmDiscovery,
  type AcpmSyncChangeItem,
} from './acpm';
import { termKey } from './hotwords';
import {
  isTermGroup,
  manuscriptDate,
  type ASRResult,
  type Manuscript,
  type ManuscriptAttachments,
  type Term,
  type TermGroup,
} from './shared';
import type { LibraryStore, SyncEntryRow, SyncPrunedRow } from './store';
import {
  blobAad,
  computeBlobId,
  computeLexiconRecordKey,
  deriveSpaceKeys,
  openEnvelope,
  recordAad,
  sealEnvelope,
  type SyncCollection,
} from './sync-crypto';
import { resolveHubBaseUrl, type KnownHub } from './sync-discovery';
import { compareHlc, MAX_REMOTE_CLOCK_DRIFT_MS, parseHlc } from './sync-hlc';
import type { KnownHubStore, SyncSecretStore } from './sync-pairing';

export interface SyncBlobRef {
  blob_id: string;
  format?: string;
  size_bytes: number;
}

export interface LexiconSyncPayload {
  schema_version: number;
  local_id: string;
  term: string;
  hint: string;
  aliases: string[];
  removed_aliases: string[];
  group: TermGroup | null;
  device_counts: Record<string, number>;
  last_matched_at_ms: number | null;
  created_at_ms: number | null;
  intent_hlc?: string;
  position_hint?: number;
  [extra: string]: unknown;
}

export interface ManuscriptSyncPayload {
  schema_version: number;
  id: string;
  date: number;
  occurred_at: string;
  recording_ended_at_ms: number | null;
  seconds: number;
  application: string;
  original: string;
  asr_results: ASRResult[];
  text: string;
  polished: boolean;
  user_edited: boolean;
  delivery_note: string | null;
  audio_warning: string | null;
  source_device_id: string;
  audio_blob: SyncBlobRef | null;
  screenshot_blob: SyncBlobRef | null;
  [extra: string]: unknown;
}

export interface SyncRunResult {
  hubInstanceId: string;
  pulled: number;
  appliedLocal: number;
  pushed: number;
  appliedRemote: number;
  noopRemote: number;
  staleRemote: number;
  latestSeq: number;
}

const KNOWN_LEXICON_KEYS = new Set([
  'schema_version',
  'local_id',
  'term',
  'hint',
  'aliases',
  'removed_aliases',
  'group',
  'device_counts',
  'last_matched_at_ms',
  'created_at_ms',
  'position_hint',
]);

const KNOWN_MANUSCRIPT_KEYS = new Set([
  'schema_version',
  'id',
  'date',
  'occurred_at',
  'recording_ended_at_ms',
  'seconds',
  'application',
  'original',
  'asr_results',
  'text',
  'polished',
  'user_edited',
  'delivery_note',
  'audio_warning',
  'source_device_id',
  'audio_blob',
  'screenshot_blob',
]);

function extractUnknownFields(
  obj: Record<string, unknown>,
  knownKeys: Set<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  let hasExtra = false;
  for (const [k, v] of Object.entries(obj)) {
    if (!knownKeys.has(k) && v !== undefined) {
      extra[k] = v;
      hasExtra = true;
    }
  }
  return hasExtra ? extra : undefined;
}

function sumDeviceCounts(counts: Record<string, number>): number {
  let total = 0;
  for (const val of Object.values(counts)) {
    if (typeof val === 'number' && Number.isSafeInteger(val) && val > 0) {
      total += val;
    }
  }
  return total;
}

function normalizeDeviceCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [deviceId, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof deviceId === 'string' && deviceId && typeof val === 'number' && Number.isSafeInteger(val) && val >= 0) {
      out[deviceId] = val;
    }
  }
  return out;
}

function sameStringRecord(a: Record<string, number>, b: Record<string, number>): boolean {
  const keysA = Object.keys(a).filter(k => a[k] > 0).sort();
  const keysB = Object.keys(b).filter(k => b[k] > 0).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && a[k] === b[k]);
}

function dedupeAliases(aliases: string[], excludeKey: string, removedSet: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    if (typeof alias !== 'string') continue;
    const trimmed = alias.trim();
    const key = termKey(trimmed);
    if (!key || key === excludeKey || removedSet.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function sameAliases(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a.map(termKey));
  const setB = new Set(b.map(termKey));
  if (setA.size !== setB.size) return false;
  for (const k of setA) if (!setB.has(k)) return false;
  return true;
}

export function encryptSyncRecord(
  dataEncKey: Buffer,
  vaultId: string,
  collection: SyncCollection,
  recordKey: string,
  versionHlc: string,
  deleted: boolean,
  payload: Record<string, unknown>,
  originDeviceId = '',
): string {
  const aad = recordAad(vaultId, collection, recordKey, versionHlc, deleted, originDeviceId);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  return sealEnvelope(dataEncKey, plain, aad, { compress: true }).toString('base64url');
}

export function decryptSyncRecord<T extends Record<string, unknown>>(
  dataEncKey: Buffer,
  vaultId: string,
  change: Pick<AcpmSyncChangeItem, 'collection' | 'record_key' | 'version_hlc' | 'deleted' | 'ciphertext'> & { origin_device_id?: string },
): T {
  const aad = recordAad(vaultId, change.collection, change.record_key, change.version_hlc, change.deleted, change.origin_device_id ?? '');
  const plain = openEnvelope(dataEncKey, Buffer.from(change.ciphertext, 'base64url'), aad);
  return JSON.parse(plain.toString('utf8')) as T;
}

export function encryptSyncBlob(
  dataEncKey: Buffer,
  vaultId: string,
  blobId: string,
  plaintextBytes: Uint8Array,
): Buffer {
  return sealEnvelope(dataEncKey, plaintextBytes, blobAad(vaultId, blobId), { compress: false });
}

export function decryptSyncBlob(
  dataEncKey: Buffer,
  vaultId: string,
  blobId: string,
  encryptedBytes: Uint8Array,
): Buffer {
  return openEnvelope(dataEncKey, encryptedBytes, blobAad(vaultId, blobId));
}

export interface MergedLexiconOutcome {
  changed: boolean;
  deleted: boolean;
  entry?: Term;
  syncEntry: SyncEntryRow;
  fromRemoteExact: boolean;
}

export function mergeLexiconState(
  local: { entry?: Term; sync: SyncEntryRow } | null,
  remote: {
    recordKey: string;
    payload: LexiconSyncPayload;
    versionHlc: string;
    originDeviceId: string;
    deleted: boolean;
    updatedAtMs: number;
  },
  localDeviceId: string,
  tickFn: () => string,
): MergedLexiconOutcome {
  const remoteCounts = normalizeDeviceCounts(remote.payload.device_counts);
  const remoteRemoved = new Set<string>(
    Array.isArray(remote.payload.removed_aliases)
      ? remote.payload.removed_aliases.map(a => termKey(String(a))).filter(Boolean)
      : [],
  );
  const remoteUnknown = extractUnknownFields(remote.payload, KNOWN_LEXICON_KEYS);
  const remoteTermStr = typeof remote.payload.term === 'string' ? remote.payload.term.trim() : '';
  const remoteAliases = dedupeAliases(
    Array.isArray(remote.payload.aliases) ? remote.payload.aliases : [],
    termKey(remoteTermStr),
    remoteRemoved,
  );

  if (!local) {
    if (remote.deleted) {
      return {
        changed: true,
        deleted: true,
        fromRemoteExact: true,
        syncEntry: {
          collection: 'lexicon',
          recordKey: remote.recordKey,
          localId: null,
          versionHlc: remote.versionHlc,
          originDeviceId: remote.originDeviceId,
          deleted: true,
          deletedAtMs: remote.updatedAtMs,
          updatedAtMs: remote.updatedAtMs,
          meta: remoteUnknown ? { unknownFields: remoteUnknown } : {},
        },
      };
    }
    const localId = typeof remote.payload.local_id === 'string' && remote.payload.local_id ? remote.payload.local_id : randomUUID();
    const remoteIntentHlc = typeof remote.payload.intent_hlc === 'string' && remote.payload.intent_hlc
      ? remote.payload.intent_hlc
      : remote.versionHlc;
    const matchCount = sumDeviceCounts(remoteCounts);
    const entry: Term = {
      id: localId,
      term: remoteTermStr,
      hint: typeof remote.payload.hint === 'string' ? remote.payload.hint : '',
      aliases: remoteAliases,
      ...(isTermGroup(remote.payload.group) ? { group: remote.payload.group } : {}),
      ...(matchCount > 0 ? { matchCount } : {}),
      ...(typeof remote.payload.last_matched_at_ms === 'number' ? { lastMatchedAt: remote.payload.last_matched_at_ms } : {}),
      ...(typeof remote.payload.created_at_ms === 'number' ? { createdAt: remote.payload.created_at_ms } : {}),
    };
    return {
      changed: true,
      deleted: false,
      entry,
      fromRemoteExact: true,
      syncEntry: {
        collection: 'lexicon',
        recordKey: remote.recordKey,
        localId,
        versionHlc: remote.versionHlc,
        originDeviceId: remote.originDeviceId,
        deleted: false,
        deletedAtMs: null,
        updatedAtMs: remote.updatedAtMs,
        meta: {
          intentHlc: remoteIntentHlc,
          deviceCounts: remoteCounts,
          removedAliases: [...remoteRemoved].sort(),
          ...(typeof remote.payload.position_hint === 'number' ? { positionHint: remote.payload.position_hint } : {}),
          ...(remoteUnknown ? { unknownFields: remoteUnknown } : {}),
        },
      },
    };
  }

  const cmp = compareHlc(remote.versionHlc, local.sync.versionHlc);
  const localIntentHlc = (typeof local.sync.meta.intentHlc === 'string' && local.sync.meta.intentHlc)
    ? local.sync.meta.intentHlc
    : local.sync.versionHlc;
  const remoteIntentHlc = (typeof remote.payload.intent_hlc === 'string' && remote.payload.intent_hlc)
    ? remote.payload.intent_hlc
    : remote.versionHlc;

  if (local.sync.deleted || remote.deleted) {
    if (local.sync.deleted && remote.deleted) {
      return {
        changed: false,
        deleted: true,
        entry: local.entry,
        fromRemoteExact: cmp >= 0,
        syncEntry: cmp > 0
          ? { ...local.sync, versionHlc: remote.versionHlc, originDeviceId: remote.originDeviceId, updatedAtMs: remote.updatedAtMs, deletedAtMs: remote.updatedAtMs }
          : local.sync,
      };
    }
    if (local.sync.deleted && !remote.deleted) {
      if (compareHlc(remoteIntentHlc, local.sync.versionHlc) <= 0) {
        return {
          changed: false,
          deleted: true,
          entry: local.entry,
          fromRemoteExact: false,
          syncEntry: local.sync,
        };
      }
    } else if (!local.sync.deleted && remote.deleted) {
      if (compareHlc(remote.versionHlc, localIntentHlc) <= 0) {
        return {
          changed: false,
          deleted: false,
          entry: local.entry,
          fromRemoteExact: false,
          syncEntry: local.sync,
        };
      }
    }
    if (remote.deleted) {
      return {
        changed: true,
        deleted: true,
        fromRemoteExact: true,
        syncEntry: {
          collection: 'lexicon',
          recordKey: remote.recordKey,
          localId: null,
          versionHlc: remote.versionHlc,
          originDeviceId: remote.originDeviceId,
          deleted: true,
          deletedAtMs: remote.updatedAtMs,
          updatedAtMs: remote.updatedAtMs,
          meta: remoteUnknown ? { unknownFields: remoteUnknown } : {},
        },
      };
    }
    const localId = local.sync.localId
      || (typeof remote.payload.local_id === 'string' && remote.payload.local_id ? remote.payload.local_id : randomUUID());
    const matchCount = sumDeviceCounts(remoteCounts);
    const entry: Term = {
      id: localId,
      term: remoteTermStr,
      hint: typeof remote.payload.hint === 'string' ? remote.payload.hint : '',
      aliases: remoteAliases,
      ...(isTermGroup(remote.payload.group) ? { group: remote.payload.group } : {}),
      ...(matchCount > 0 ? { matchCount } : {}),
      ...(typeof remote.payload.last_matched_at_ms === 'number' ? { lastMatchedAt: remote.payload.last_matched_at_ms } : {}),
      ...(typeof remote.payload.created_at_ms === 'number' ? { createdAt: remote.payload.created_at_ms } : {}),
    };
    const nextVersionHlc = cmp >= 0 ? remote.versionHlc : tickFn();
    return {
      changed: true,
      deleted: false,
      entry,
      fromRemoteExact: cmp >= 0,
      syncEntry: {
        collection: 'lexicon',
        recordKey: remote.recordKey,
        localId,
        versionHlc: nextVersionHlc,
        originDeviceId: cmp >= 0 ? remote.originDeviceId : localDeviceId,
        deleted: false,
        deletedAtMs: null,
        updatedAtMs: remote.updatedAtMs,
        meta: {
          intentHlc: compareHlc(remoteIntentHlc, nextVersionHlc) >= 0 ? remoteIntentHlc : nextVersionHlc,
          deviceCounts: remoteCounts,
          removedAliases: [...remoteRemoved].sort(),
          ...(typeof remote.payload.position_hint === 'number' ? { positionHint: remote.payload.position_hint } : {}),
          ...(remoteUnknown ? { unknownFields: remoteUnknown } : {}),
        },
      },
    };
  }

  // Both sides are active: semantic merge (CRDT device_counts + alias union/tombstone + intent-HLC LWW scalars).
  const localEntry = local.entry!;
  const intentCmp = compareHlc(remoteIntentHlc, localIntentHlc);
  const remoteIsNewer = intentCmp !== 0 ? intentCmp > 0 : cmp > 0;
  const localCounts = normalizeDeviceCounts(local.sync.meta.deviceCounts);
  if (Object.keys(localCounts).length === 0 && (localEntry.matchCount ?? 0) > 0) {
    localCounts[localDeviceId] = localEntry.matchCount!;
  }
  const mergedCounts: Record<string, number> = { ...localCounts };
  for (const [devId, count] of Object.entries(remoteCounts)) {
    mergedCounts[devId] = Math.max(mergedCounts[devId] ?? 0, count);
  }

  const localRemoved = new Set<string>(
    Array.isArray(local.sync.meta.removedAliases)
      ? local.sync.meta.removedAliases.map(a => termKey(String(a))).filter(Boolean)
      : [],
  );
  const localAliases = localEntry.aliases ?? [];
  const winnerAliases = remoteIsNewer ? remoteAliases : localAliases;
  const loserAliases = remoteIsNewer ? localAliases : remoteAliases;
  const winnerRemoved = remoteIsNewer ? remoteRemoved : localRemoved;
  const loserRemoved = remoteIsNewer ? localRemoved : remoteRemoved;

  const winnerAliasKeys = new Set(winnerAliases.map(termKey).filter(Boolean));
  const mergedRemoved = new Set<string>(winnerRemoved);
  for (const k of loserRemoved) {
    if (!winnerAliasKeys.has(k)) mergedRemoved.add(k);
  }

  const mergedTerm = remoteIsNewer ? remoteTermStr : localEntry.term;
  const mergedHint = remoteIsNewer
    ? (typeof remote.payload.hint === 'string' ? remote.payload.hint : '')
    : localEntry.hint;
  const mergedGroup = remoteIsNewer
    ? (isTermGroup(remote.payload.group) ? remote.payload.group : undefined)
    : localEntry.group;
  const mergedAliases = dedupeAliases(
    [...winnerAliases, ...loserAliases],
    termKey(mergedTerm),
    mergedRemoved,
  );

  const localLast = localEntry.lastMatchedAt ?? null;
  const remoteLast = typeof remote.payload.last_matched_at_ms === 'number' ? remote.payload.last_matched_at_ms : null;
  const mergedLast = localLast === null ? remoteLast : remoteLast === null ? localLast : Math.max(localLast, remoteLast);

  const localCreated = localEntry.createdAt ?? null;
  const remoteCreated = typeof remote.payload.created_at_ms === 'number' ? remote.payload.created_at_ms : null;
  const mergedCreated = localCreated === null ? remoteCreated : remoteCreated === null ? localCreated : Math.min(localCreated, remoteCreated);

  const localUnknown = (local.sync.meta.unknownFields as Record<string, unknown> | undefined) ?? {};
  const mergedUnknown = remoteIsNewer
    ? { ...localUnknown, ...(remoteUnknown ?? {}) }
    : { ...(remoteUnknown ?? {}), ...localUnknown };

  const matchCount = sumDeviceCounts(mergedCounts);
  const mergedEntry: Term = {
    id: localEntry.id,
    term: mergedTerm,
    hint: mergedHint,
    aliases: mergedAliases,
    ...(mergedGroup ? { group: mergedGroup } : {}),
    ...(matchCount > 0 ? { matchCount } : {}),
    ...(mergedLast !== null ? { lastMatchedAt: mergedLast } : {}),
    ...(mergedCreated !== null ? { createdAt: mergedCreated } : {}),
  };

  const sameAsRemote = mergedTerm === remoteTermStr
    && mergedHint === (typeof remote.payload.hint === 'string' ? remote.payload.hint : '')
    && (mergedGroup ?? null) === (isTermGroup(remote.payload.group) ? remote.payload.group : null)
    && sameStringRecord(mergedCounts, remoteCounts)
    && sameAliases(mergedAliases, remoteAliases)
    && mergedLast === remoteLast
    && mergedCreated === remoteCreated;

  const sameAsLocal = mergedTerm === localEntry.term
    && mergedHint === localEntry.hint
    && (mergedGroup ?? null) === (localEntry.group ?? null)
    && sameStringRecord(mergedCounts, localCounts)
    && sameAliases(mergedAliases, localAliases)
    && mergedLast === localLast
    && mergedCreated === localCreated;

  const maxIntentHlc = intentCmp >= 0 ? remoteIntentHlc : localIntentHlc;

  if (sameAsLocal && cmp <= 0) {
    return {
      changed: false,
      deleted: false,
      entry: localEntry,
      fromRemoteExact: false,
      syncEntry: {
        ...local.sync,
        meta: { ...local.sync.meta, intentHlc: maxIntentHlc },
      },
    };
  }

  const useRemoteHlc = sameAsRemote && cmp >= 0;
  const versionHlc = useRemoteHlc ? remote.versionHlc : tickFn();
  const originDeviceId = useRemoteHlc ? remote.originDeviceId : localDeviceId;

  return {
    changed: !sameAsLocal,
    deleted: false,
    entry: mergedEntry,
    fromRemoteExact: useRemoteHlc,
    syncEntry: {
      collection: 'lexicon',
      recordKey: remote.recordKey,
      localId: localEntry.id,
      versionHlc,
      originDeviceId,
      deleted: false,
      deletedAtMs: null,
      updatedAtMs: useRemoteHlc ? remote.updatedAtMs : Math.max(local.sync.updatedAtMs, remote.updatedAtMs),
      meta: {
        intentHlc: maxIntentHlc,
        deviceCounts: mergedCounts,
        removedAliases: [...mergedRemoved].sort(),
        ...(remoteIsNewer && typeof remote.payload.position_hint === 'number'
          ? { positionHint: remote.payload.position_hint }
          : local.sync.meta.positionHint !== undefined
            ? { positionHint: local.sync.meta.positionHint }
            : {}),
        ...(Object.keys(mergedUnknown).length ? { unknownFields: mergedUnknown } : {}),
      },
    },
  };
}

export interface MergedManuscriptOutcome {
  applied: boolean;
  deleted: boolean;
  manuscript?: Manuscript;
  syncEntry?: SyncEntryRow;
  clearPruned?: boolean;
}

export function mergeManuscriptState(
  local: { sync: SyncEntryRow } | null,
  remote: {
    recordKey: string;
    payload: ManuscriptSyncPayload;
    versionHlc: string;
    originDeviceId: string;
    deleted: boolean;
    updatedAtMs: number;
  },
  prunedInfo: SyncPrunedRow | undefined,
): MergedManuscriptOutcome {
  if (!remote.deleted && prunedInfo) {
    if (!prunedInfo.prunedVersionHlc || compareHlc(remote.versionHlc, prunedInfo.prunedVersionHlc) <= 0) {
      return { applied: false, deleted: false };
    }
  }

  if (local && compareHlc(remote.versionHlc, local.sync.versionHlc) <= 0) {
    return { applied: false, deleted: local.sync.deleted };
  }

  const unknownFields = extractUnknownFields(remote.payload, KNOWN_MANUSCRIPT_KEYS);
  if (remote.deleted) {
    return {
      applied: true,
      deleted: true,
      clearPruned: Boolean(prunedInfo),
      manuscript: {
        id: remote.recordKey,
        date: 0,
        original: '',
        text: '',
        seconds: 0,
        application: '',
        polished: false,
      },
      syncEntry: {
        collection: 'manuscript',
        recordKey: remote.recordKey,
        localId: null,
        versionHlc: remote.versionHlc,
        originDeviceId: remote.originDeviceId,
        deleted: true,
        deletedAtMs: remote.updatedAtMs,
        updatedAtMs: remote.updatedAtMs,
        meta: unknownFields ? { unknownFields } : {},
      },
    };
  }

  const asrResults: ASRResult[] = Array.isArray(remote.payload.asr_results)
    ? remote.payload.asr_results.filter(r => r && typeof r.engine_name === 'string' && typeof r.transcript === 'string')
    : [];
  const manuscript: Manuscript = {
    id: remote.payload.id || remote.recordKey,
    date: Number(remote.payload.date),
    original: String(remote.payload.original ?? ''),
    text: String(remote.payload.text ?? ''),
    seconds: Math.max(0, Number(remote.payload.seconds ?? 0)),
    application: String(remote.payload.application ?? ''),
    polished: Boolean(remote.payload.polished),
    asrResults,
    ...(remote.payload.user_edited ? { userEdited: true } : {}),
    ...(typeof remote.payload.delivery_note === 'string' && remote.payload.delivery_note ? { deliveryNote: remote.payload.delivery_note } : {}),
    ...(typeof remote.payload.audio_warning === 'string' && remote.payload.audio_warning ? { audioWarning: remote.payload.audio_warning } : {}),
    ...(typeof remote.payload.recording_ended_at_ms === 'number' ? { recordingEndedAtMs: remote.payload.recording_ended_at_ms } : {}),
  };

  return {
    applied: true,
    deleted: false,
    clearPruned: Boolean(prunedInfo),
    manuscript,
    syncEntry: {
      collection: 'manuscript',
      recordKey: remote.recordKey,
      localId: manuscript.id,
      versionHlc: remote.versionHlc,
      originDeviceId: remote.originDeviceId,
      deleted: false,
      deletedAtMs: null,
      updatedAtMs: remote.updatedAtMs,
      meta: {
        sourceDeviceId: remote.payload.source_device_id || remote.originDeviceId,
        ...(remote.payload.audio_blob ? { audioBlob: remote.payload.audio_blob } : {}),
        ...(remote.payload.screenshot_blob ? { screenshotBlob: remote.payload.screenshot_blob } : {}),
        ...(unknownFields ? { unknownFields } : {}),
      },
    },
  };
}

export interface SyncEngineOptions {
  store: LibraryStore;
  secretStore: SyncSecretStore;
  hubStore: KnownHubStore;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  nowFn?: () => number;
  onLibraryUpdated?: () => void;
}

export class SyncEngine {
  private readonly store: LibraryStore;
  private readonly secretStore: SyncSecretStore;
  private readonly hubStore: KnownHubStore;
  private readonly dataDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly nowFn: () => number;
  private readonly onLibraryUpdated?: () => void;
  private syncQueue: Promise<unknown> = Promise.resolve();

  constructor(options: SyncEngineOptions) {
    this.store = options.store;
    this.secretStore = options.secretStore;
    this.hubStore = options.hubStore;
    this.dataDir = options.dataDir;
    this.fetchImpl = options.fetchImpl;
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.onLibraryUpdated = options.onLibraryUpdated;
    if (options.onLibraryUpdated && !this.store.onRemoteLibraryChanged) {
      this.store.onRemoteLibraryChanged = options.onLibraryUpdated;
    }
  }

  ensureConfigured(): { deviceId: string; vaultId: string; dataEncKey: Buffer; keyMacKey: Buffer } | null {
    const secrets = this.secretStore.load();
    if (!secrets?.rootSeedB64 || !secrets.deviceId) return null;
    const rootSeed = Buffer.from(secrets.rootSeedB64, 'base64url');
    if (rootSeed.length !== 32) return null;
    const space = deriveSpaceKeys(rootSeed);
    this.store.configureSync({
      deviceId: secrets.deviceId,
      vaultId: space.vaultId,
      keyMacKey: space.keyMacKey,
      nowFn: this.nowFn,
    });
    return {
      deviceId: secrets.deviceId,
      vaultId: space.vaultId,
      dataEncKey: space.dataEncKey,
      keyMacKey: space.keyMacKey,
    };
  }

  private createClient(hub: KnownHub, localDisc: AcpmDiscovery | null): AcpmClient {
    const secrets = this.secretStore.load();
    if (!secrets?.deviceId || !secrets?.devicePrivateSeedB64) {
      throw new Error('缺少本机同步设备密钥。');
    }
    if (localDisc?.hub_instance_id && localDisc.hub_instance_id === hub.hubInstanceId) {
      return new AcpmClient({
        mode: 'local',
        caller: 'yanmo-sync',
        dataDir: this.dataDir,
        fetchImpl: this.fetchImpl,
      });
    }
    const url = resolveHubBaseUrl(hub, { localDiscovery: localDisc });
    if (!url) {
      throw new Error(`节点 ${hub.hubName} 暂无可用同步地址。`);
    }
    return new AcpmClient({
      mode: 'remote',
      remoteBaseURL: url,
      popAuth: {
        deviceId: secrets.deviceId,
        privateSeed: Buffer.from(secrets.devicePrivateSeedB64, 'base64url'),
        serverPubkey: hub.serverPubkey,
        expectedServerPubkeyFp: hub.serverPubkeyFp,
      },
      caller: 'yanmo-sync',
      fetchImpl: this.fetchImpl,
    });
  }

  private buildOutgoingPayload(
    entry: SyncEntryRow,
    localDeviceId: string,
    keyMacKey: Buffer,
  ): Record<string, unknown> | null {
    const unknownFields = (entry.meta.unknownFields as Record<string, unknown> | undefined) ?? {};
    if (entry.collection === 'lexicon') {
      if (entry.deleted) {
        return {
          ...unknownFields,
          schema_version: 1,
          local_id: entry.localId ?? '',
          term: '',
          hint: '',
          aliases: [],
          removed_aliases: [],
          group: null,
          device_counts: {},
          last_matched_at_ms: null,
          created_at_ms: null,
        };
      }
      const term = this.store.library.lexicon.find(item => item.id === entry.localId)
        ?? this.store.library.lexicon.find(item =>
          Boolean(termKey(item.term))
          && computeLexiconRecordKey(keyMacKey, item.term, item.group) === entry.recordKey,
        );
      if (!term) return null;
      const deviceCounts = normalizeDeviceCounts(entry.meta.deviceCounts);
      if (Object.keys(deviceCounts).length === 0 && (term.matchCount ?? 0) > 0) {
        deviceCounts[localDeviceId] = term.matchCount!;
      }
      const removedAliases = Array.isArray(entry.meta.removedAliases)
        ? entry.meta.removedAliases.map(String)
        : [];
      return {
        ...unknownFields,
        schema_version: 1,
        local_id: term.id,
        term: term.term,
        hint: term.hint,
        aliases: term.aliases ?? [],
        removed_aliases: removedAliases,
        group: term.group ?? null,
        device_counts: deviceCounts,
        last_matched_at_ms: term.lastMatchedAt ?? null,
        created_at_ms: term.createdAt ?? null,
        ...(typeof entry.meta.intentHlc === 'string' && entry.meta.intentHlc ? { intent_hlc: entry.meta.intentHlc } : {}),
        ...(typeof entry.meta.positionHint === 'number' ? { position_hint: entry.meta.positionHint } : {}),
      } satisfies LexiconSyncPayload;
    }

    if (entry.deleted) {
      return {
        ...unknownFields,
        schema_version: 1,
        id: entry.recordKey,
      };
    }
    const item = this.store.library.manuscripts.find(m => m.id === (entry.localId ?? entry.recordKey));
    if (!item) return null;
    return {
      ...unknownFields,
      schema_version: 1,
      id: item.id,
      date: item.date,
      occurred_at: manuscriptDate(item.date).toISOString(),
      recording_ended_at_ms: item.recordingEndedAtMs ?? null,
      seconds: item.seconds,
      application: item.application,
      original: item.original,
      asr_results: item.asrResults ?? [],
      text: item.text,
      polished: item.polished,
      user_edited: item.userEdited === true,
      delivery_note: item.deliveryNote ?? null,
      audio_warning: item.audioWarning ?? null,
      source_device_id: (entry.meta.sourceDeviceId as string | undefined) || entry.originDeviceId || localDeviceId,
      audio_blob: (entry.meta.audioBlob as SyncBlobRef | null | undefined) ?? null,
      screenshot_blob: (entry.meta.screenshotBlob as SyncBlobRef | null | undefined) ?? null,
    } satisfies ManuscriptSyncPayload;
  }

  private async pullFromHub(
    client: AcpmClient,
    hubId: string,
    space: { deviceId: string; vaultId: string; dataEncKey: Buffer; keyMacKey: Buffer },
    signal?: AbortSignal,
  ): Promise<{ pulled: number; appliedLocal: number; latestSeq: number }> {
    let sinceSeq = this.store.getHubCursor(hubId).lastPulledSeq;
    let pulled = 0;
    let appliedLocal = 0;
    let latestSeq = sinceSeq;

    while (true) {
      const page = await client.pullSyncChanges(space.vaultId, sinceSeq, 200, signal);
      if (page.hub_instance_id && page.hub_instance_id !== hubId) {
        throw new Error('远端同步节点 ID 与预期不一致。');
      }
      latestSeq = Math.max(latestSeq, page.latest_seq);
      if (page.changes.length === 0) {
        const nextSeq = Math.max(sinceSeq, page.latest_seq);
        this.store.setHubCursor(hubId, nextSeq, this.nowFn());
        sinceSeq = nextSeq;
        break;
      }

      pulled += page.changes.length;
      const batchLastSeq = Math.max(
        sinceSeq,
        page.has_more
          ? Math.max(...page.changes.map(c => c.seq ?? sinceSeq))
          : Math.max(page.latest_seq, ...page.changes.map(c => c.seq ?? 0)),
      );
      if (page.has_more && batchLastSeq <= sinceSeq) {
        throw new Error('远端同步游标未递增，已中止拉取。');
      }

      const validRecords: { change: AcpmSyncChangeItem; payload: Record<string, unknown> }[] = [];
      for (const change of page.changes) {
        try {
          if (change.collection !== 'lexicon' && change.collection !== 'manuscript') {
            continue;
          }
          const parsedHlc = parseHlc(change.version_hlc);
          if (parsedHlc.ms > this.nowFn() + MAX_REMOTE_CLOCK_DRIFT_MS) {
            continue;
          }
          const payload = decryptSyncRecord<Record<string, unknown>>(space.dataEncKey, space.vaultId, change);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            continue;
          }
          if (!change.deleted) {
            if (change.collection === 'lexicon') {
              if (typeof payload.term !== 'string' || !termKey(payload.term)) continue;
            } else {
              if (!Number.isFinite(Number(payload.date)) || typeof payload.text !== 'string' || typeof payload.original !== 'string') {
                continue;
              }
            }
          }
          validRecords.push({ change, payload });
        } catch {
          // Quarantine malformed or tampered individual records without stalling the hub cursor.
        }
      }

      this.store.applyRemoteSyncTransaction(ctx => {
        const lexiconByRk = new Map<string, Term>();
        for (const t of this.store.library.lexicon) {
          if (termKey(t.term)) lexiconByRk.set(computeLexiconRecordKey(space.keyMacKey, t.term, t.group), t);
        }

        for (const { change, payload } of validRecords) {
          try {
            ctx.hlc.receive(change.version_hlc);
            const updatedAtMs = change.updated_at_ms ?? ctx.nowMs;

            if (change.collection === 'lexicon') {
              const existingSync = ctx.getSyncEntry('lexicon', change.record_key);
              const existingTerm = existingSync?.localId
                ? this.store.library.lexicon.find(t => t.id === existingSync.localId)
                : lexiconByRk.get(change.record_key);
              const localState = existingSync ? { entry: existingTerm, sync: existingSync } : null;
              const outcome = mergeLexiconState(
                localState,
                {
                  recordKey: change.record_key,
                  payload: payload as LexiconSyncPayload,
                  versionHlc: change.version_hlc,
                  originDeviceId: change.origin_device_id,
                  deleted: change.deleted,
                  updatedAtMs,
                },
                space.deviceId,
                () => ctx.hlc.tick(),
              );
              if (outcome.changed) {
                appliedLocal += 1;
                if (outcome.deleted) {
                  if (existingTerm) {
                    ctx.upsertRemoteLexiconTerm(existingTerm, true, existingTerm.id);
                    lexiconByRk.delete(change.record_key);
                  }
                } else if (outcome.entry) {
                  const resolvedId = ctx.upsertRemoteLexiconTerm(outcome.entry, false, existingTerm?.id);
                  if (typeof resolvedId === 'string' && resolvedId) {
                    outcome.syncEntry.localId = resolvedId;
                    outcome.entry = { ...outcome.entry, id: resolvedId };
                  }
                  lexiconByRk.set(change.record_key, outcome.entry);
                }
              }
              if (outcome.changed || !existingSync || outcome.fromRemoteExact) {
                ctx.upsertSyncEntry(outcome.syncEntry);
              }
              if (outcome.fromRemoteExact || compareHlc(outcome.syncEntry.versionHlc, change.version_hlc) <= 0) {
                ctx.markHubAcked(hubId, 'lexicon', change.record_key, change.version_hlc);
              }
            } else {
              const existingSync = ctx.getSyncEntry('manuscript', change.record_key);
              const prunedInfo = ctx.getPrunedManuscript(change.record_key);
              const outcome = mergeManuscriptState(
                existingSync ? { sync: existingSync } : null,
                {
                  recordKey: change.record_key,
                  payload: payload as ManuscriptSyncPayload,
                  versionHlc: change.version_hlc,
                  originDeviceId: change.origin_device_id,
                  deleted: change.deleted,
                  updatedAtMs,
                },
                prunedInfo,
              );
              if (outcome.applied && outcome.syncEntry) {
                appliedLocal += 1;
                if (outcome.clearPruned) ctx.clearPrunedManuscript(change.record_key);
                if (outcome.manuscript) {
                  ctx.upsertRemoteManuscript(outcome.manuscript, outcome.deleted);
                }
                ctx.upsertSyncEntry(outcome.syncEntry);
                ctx.markHubAcked(hubId, 'manuscript', change.record_key, outcome.syncEntry.versionHlc);
              } else if (!existingSync && prunedInfo) {
                ctx.markHubAcked(hubId, 'manuscript', change.record_key, change.version_hlc);
              } else if (existingSync && compareHlc(existingSync.versionHlc, change.version_hlc) >= 0) {
                ctx.markHubAcked(hubId, 'manuscript', change.record_key, change.version_hlc);
              }
            }
          } catch {
            // Skip malformed merge payload without failing the rest of the transaction.
          }
        }
        ctx.setHubCursor(hubId, batchLastSeq, this.nowFn());
      });

      sinceSeq = batchLastSeq;
      if (!page.has_more) break;
    }

    return { pulled, appliedLocal, latestSeq };
  }

  private async pushToHub(
    client: AcpmClient,
    hubId: string,
    space: { deviceId: string; vaultId: string; dataEncKey: Buffer; keyMacKey: Buffer },
    uploadBlobs = false,
    signal?: AbortSignal,
  ): Promise<{ pushed: number; appliedRemote: number; noopRemote: number; staleRemote: number; latestSeq: number }> {
    let pushed = 0;
    let appliedRemote = 0;
    let noopRemote = 0;
    let staleRemote = 0;
    let latestSeq = this.store.getHubCursor(hubId).lastPulledSeq;

    while (true) {
      const pending = this.store.getPendingSyncEntries(hubId, 200);
      if (!pending.length) break;

      if (uploadBlobs) {
        for (const entry of pending) {
          if (entry.collection === 'manuscript' && !entry.deleted) {
            await this.uploadManuscriptBlobsWithClient(client, entry.localId ?? entry.recordKey, space, signal);
          }
        }
      }

      const batch: AcpmSyncChangeItem[] = [];
      for (const entry of pending) {
        const latestEntry = entry.collection === 'manuscript' && uploadBlobs
          ? (this.store.getSyncEntry('manuscript', entry.recordKey) ?? entry)
          : entry;
        const payload = this.buildOutgoingPayload(latestEntry, space.deviceId, space.keyMacKey);
        if (!payload) continue;
        const ciphertext = encryptSyncRecord(
          space.dataEncKey,
          space.vaultId,
          latestEntry.collection,
          latestEntry.recordKey,
          latestEntry.versionHlc,
          latestEntry.deleted,
          payload,
          latestEntry.originDeviceId,
        );
        batch.push({
          collection: latestEntry.collection,
          record_key: latestEntry.recordKey,
          version_hlc: latestEntry.versionHlc,
          origin_device_id: latestEntry.originDeviceId,
          deleted: latestEntry.deleted,
          ciphertext,
        });
      }
      if (!batch.length) break;

      const res = await client.pushSyncChanges(space.vaultId, batch, signal);
      pushed += batch.length;
      latestSeq = Math.max(latestSeq, res.latest_seq);

      const batchByKey = new Map(batch.map(item => [`${item.collection}:${item.record_key}`, item]));
      const seenKeys = new Set<string>();
      const acks: { collection: SyncCollection; recordKey: string; versionHlc: string }[] = [];
      let sawStale = false;
      for (const result of res.results) {
        const key = `${result.collection}:${result.record_key}`;
        const sent = batchByKey.get(key);
        if (!sent || seenKeys.has(key)) continue;
        seenKeys.add(key);
        if (result.status === 'applied') {
          appliedRemote += 1;
          acks.push({ collection: sent.collection, recordKey: sent.record_key, versionHlc: sent.version_hlc });
        } else if (result.status === 'noop') {
          noopRemote += 1;
          acks.push({ collection: sent.collection, recordKey: sent.record_key, versionHlc: sent.version_hlc });
        } else {
          staleRemote += 1;
          sawStale = true;
        }
      }

      if (acks.length) {
        this.store.markHubAcked(hubId, acks);
      }
      if (seenKeys.size < batch.length) {
        throw new Error('Hub 返回的同步写入确认不完整。');
      }
      if (acks.length === 0 && !sawStale) {
        throw new Error('Hub 未确认任何同步变更。');
      }
      if (sawStale || batch.length < 200) {
        if (sawStale) break;
      }
    }

    return { pushed, appliedRemote, noopRemote, staleRemote, latestSeq };
  }

  private async uploadManuscriptBlobsWithClient(
    client: AcpmClient,
    manuscriptId: string,
    space: { vaultId: string; dataEncKey: Buffer; keyMacKey: Buffer },
    signal?: AbortSignal,
  ): Promise<{ uploaded: string[]; skipped: string[] }> {
    const attachments = this.store.getAttachments(manuscriptId);
    const uploaded: string[] = [];
    const skipped: string[] = [];
    const existingMeta = this.store.getSyncEntry('manuscript', manuscriptId)?.meta ?? {};
    const existingAudio = existingMeta.audioBlob as SyncBlobRef | undefined;
    const existingScreenshot = existingMeta.screenshotBlob as SyncBlobRef | undefined;
    let nextAudioRef: Record<string, unknown> | undefined;
    let nextScreenshotRef: Record<string, unknown> | undefined;

    const handleOne = async (bytes: Uint8Array, existingRef: SyncBlobRef | undefined, formatFallback: string) => {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const blobId = computeBlobId(space.keyMacKey, sha256);
      const exists = await client.hasSyncBlob(space.vaultId, blobId, signal);
      if (exists) {
        skipped.push(blobId);
      } else {
        const encrypted = encryptSyncBlob(space.dataEncKey, space.vaultId, blobId, bytes);
        await client.uploadSyncBlob(space.vaultId, blobId, encrypted, signal);
        uploaded.push(blobId);
      }
      return {
        blob_id: blobId,
        format: existingRef?.format || formatFallback,
        size_bytes: bytes.byteLength,
      };
    };

    if (attachments.audio?.byteLength) {
      nextAudioRef = await handleOne(attachments.audio, existingAudio, 'flac');
    }
    if (attachments.screenshot?.byteLength) {
      nextScreenshotRef = await handleOne(attachments.screenshot, existingScreenshot, 'jpeg');
    }
    if (nextAudioRef || nextScreenshotRef) {
      this.store.updateManuscriptBlobRefs(manuscriptId, {
        ...(nextAudioRef ? { audioBlob: nextAudioRef } : {}),
        ...(nextScreenshotRef ? { screenshotBlob: nextScreenshotRef } : {}),
      });
    }
    return { uploaded, skipped };
  }

  private resolveTargetHub(hubId?: string): { hub: KnownHub; localDisc: AcpmDiscovery | null } {
    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, true);
    } catch {
      localDisc = null;
    }
    const known = this.hubStore.load();
    const targetHub = hubId
      ? known.find(h => h.hubInstanceId === hubId)
      : (localDisc?.hub_instance_id ? known.find(h => h.hubInstanceId === localDisc!.hub_instance_id) : undefined) ?? known[0];
    if (!targetHub) {
      throw new Error('未找到已配对的 AcpmRuntime 同步节点。');
    }
    return { hub: targetHub, localDisc };
  }

  async uploadManuscriptBlobs(
    manuscriptId: string,
    hubId?: string,
    signal?: AbortSignal,
  ): Promise<{ uploaded: string[]; skipped: string[] }> {
    const space = this.ensureConfigured();
    if (!space) throw new Error('尚未开启或加入个人同步空间。');
    const { hub, localDisc } = this.resolveTargetHub(hubId);
    const client = this.createClient(hub, localDisc);
    return this.uploadManuscriptBlobsWithClient(client, manuscriptId, space, signal);
  }

  async ensureManuscriptAttachments(
    manuscriptId: string,
    hubId?: string,
    signal?: AbortSignal,
  ): Promise<ManuscriptAttachments> {
    const current = this.store.getAttachments(manuscriptId);
    const space = this.ensureConfigured();
    if (!space) return current;

    const entry = this.store.getSyncEntry('manuscript', manuscriptId);
    const audioRef = entry?.meta.audioBlob as SyncBlobRef | null | undefined;
    const screenshotRef = entry?.meta.screenshotBlob as SyncBlobRef | null | undefined;

    const needAudio = !current.audio?.byteLength && Boolean(audioRef?.blob_id);
    const needScreenshot = !current.screenshot?.byteLength && Boolean(screenshotRef?.blob_id);
    if (!needAudio && !needScreenshot) return current;

    let localDisc: AcpmDiscovery | null = null;
    try {
      localDisc = discoverAcpmRuntime(this.dataDir, true);
    } catch {
      localDisc = null;
    }
    const known = this.hubStore.load();
    const candidates = hubId
      ? known.filter(h => h.hubInstanceId === hubId)
      : [...known].sort((a, b) => {
        const aLocal = localDisc?.hub_instance_id === a.hubInstanceId ? 0 : 1;
        const bLocal = localDisc?.hub_instance_id === b.hubInstanceId ? 0 : 1;
        return aLocal - bLocal;
      });

    let fetchedAudio: Uint8Array | undefined;
    let fetchedScreenshot: Uint8Array | undefined;

    const fetchVerifiedBlob = async (client: AcpmClient, blobId: string): Promise<Buffer | undefined> => {
      const timeoutSig = AbortSignal.timeout(8000);
      const reqSig = signal ? AbortSignal.any([signal, timeoutSig]) : timeoutSig;
      const encrypted = await client.downloadSyncBlob(space.vaultId, blobId, reqSig);
      const plain = decryptSyncBlob(space.dataEncKey, space.vaultId, blobId, encrypted);
      const actualId = computeBlobId(space.keyMacKey, createHash('sha256').update(plain).digest('hex'));
      if (actualId !== blobId) {
        throw new Error('同步附件内容校验失败。');
      }
      return plain;
    };

    for (const hub of candidates) {
      let client: AcpmClient;
      try {
        client = this.createClient(hub, localDisc);
      } catch {
        continue;
      }
      if (needAudio && !fetchedAudio && audioRef?.blob_id) {
        try {
          fetchedAudio = await fetchVerifiedBlob(client, audioRef.blob_id);
        } catch { /* Try next hub if unavailable or missing blob. */ }
      }
      if (needScreenshot && !fetchedScreenshot && screenshotRef?.blob_id) {
        try {
          fetchedScreenshot = await fetchVerifiedBlob(client, screenshotRef.blob_id);
        } catch { /* Try next hub if unavailable or missing blob. */ }
      }
      if ((!needAudio || fetchedAudio) && (!needScreenshot || fetchedScreenshot)) break;
    }

    if (fetchedAudio || fetchedScreenshot) {
      this.store.saveCachedAttachments(manuscriptId, {
        ...(fetchedAudio ? { audioOpus: fetchedAudio } : {}),
        ...(fetchedScreenshot ? { screenshotImage: fetchedScreenshot } : {}),
      });
    }
    return this.store.getAttachments(manuscriptId);
  }

  syncWithHub(hubId?: string, signal?: AbortSignal, options?: { uploadBlobs?: boolean }): Promise<SyncRunResult> {
    const run = this.syncQueue.then(() => this.runSyncWithHub(hubId, signal, options));
    this.syncQueue = run.catch(() => {});
    return run;
  }

  private async runSyncWithHub(
    hubId?: string,
    signal?: AbortSignal,
    options?: { uploadBlobs?: boolean },
  ): Promise<SyncRunResult> {
    const space = this.ensureConfigured();
    if (!space) {
      throw new Error('尚未开启或加入个人同步空间。');
    }

    const { hub: targetHub, localDisc } = this.resolveTargetHub(hubId);
    const uploadBlobs = options?.uploadBlobs === true;

    const client = this.createClient(targetHub, localDisc);
    const pull1 = await this.pullFromHub(client, targetHub.hubInstanceId, space, signal);
    const push1 = await this.pushToHub(client, targetHub.hubInstanceId, space, uploadBlobs, signal);

    let totalPulled = pull1.pulled;
    let totalAppliedLocal = pull1.appliedLocal;
    let totalPushed = push1.pushed;
    let totalAppliedRemote = push1.appliedRemote;
    let totalNoopRemote = push1.noopRemote;
    let totalStaleRemote = push1.staleRemote;
    let latestSeq = Math.max(pull1.latestSeq, push1.latestSeq);

    if (push1.staleRemote > 0) {
      const pull2 = await this.pullFromHub(client, targetHub.hubInstanceId, space, signal);
      const push2 = await this.pushToHub(client, targetHub.hubInstanceId, space, uploadBlobs, signal);
      totalPulled += pull2.pulled;
      totalAppliedLocal += pull2.appliedLocal;
      totalPushed += push2.pushed;
      totalAppliedRemote += push2.appliedRemote;
      totalNoopRemote += push2.noopRemote;
      totalStaleRemote += push2.staleRemote;
      latestSeq = Math.max(latestSeq, pull2.latestSeq, push2.latestSeq);
    }

    const freshKnown = this.hubStore.load();
    const updatedHubs = freshKnown.map(h => h.hubInstanceId === targetHub.hubInstanceId
      ? { ...h, lastSeenAtMs: this.nowFn() }
      : h);
    this.hubStore.save(updatedHubs);

    if (totalAppliedLocal > 0 && !this.store.onRemoteLibraryChanged) {
      this.onLibraryUpdated?.();
    }

    return {
      hubInstanceId: targetHub.hubInstanceId,
      pulled: totalPulled,
      appliedLocal: totalAppliedLocal,
      pushed: totalPushed,
      appliedRemote: totalAppliedRemote,
      noopRemote: totalNoopRemote,
      staleRemote: totalStaleRemote,
      latestSeq,
    };
  }

  async syncAllKnownHubs(
    signal?: AbortSignal,
    options?: { uploadBlobs?: boolean },
  ): Promise<{ results: SyncRunResult[]; errors: { hubInstanceId: string; message: string }[] }> {
    const known = this.hubStore.load();
    const results: SyncRunResult[] = [];
    const errors: { hubInstanceId: string; message: string }[] = [];
    for (const hub of known) {
      try {
        results.push(await this.syncWithHub(hub.hubInstanceId, signal, options));
      } catch (error) {
        errors.push({ hubInstanceId: hub.hubInstanceId, message: (error as Error).message });
      }
    }
    return { results, errors };
  }
}
