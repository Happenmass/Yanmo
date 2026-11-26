import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { termGroup, termKey } from './hotwords';
import { AcpmSettings, DailyUsage, Library, LLMPurpose, Manuscript, ManuscriptAttachments, Settings, Term, TermGroup, cocoaNow, isTermGroup, localDayDate, manuscriptDate, shiftLocalDay, validateSettings } from './shared';
import { computeBlobId, computeLexiconRecordKey, type SyncCollection } from './sync-crypto';
import { HlcClock } from './sync-hlc';

const SCHEMA_VERSION = 5;
const STATISTICS_START = 'statistics_started_at_ms';

const STATISTICS_SQL = `
CREATE TABLE llm_usage_events (
  call_id TEXT NOT NULL PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('polish', 'hotword_extract', 'translate')),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'response', 'request_error')),
  input_tokens INTEGER CHECK(input_tokens >= 0),
  output_tokens INTEGER CHECK(output_tokens >= 0),
  total_tokens INTEGER CHECK(total_tokens >= 0)
) STRICT;
CREATE INDEX llm_usage_events_time ON llm_usage_events (started_at_ms);
CREATE TABLE app_input_events (
  event_id TEXT NOT NULL PRIMARY KEY,
  occurred_at_ms INTEGER NOT NULL,
  app_key TEXT NOT NULL,
  app_name TEXT NOT NULL,
  character_count INTEGER NOT NULL CHECK(character_count > 0),
  delivery_status TEXT NOT NULL CHECK(delivery_status IN ('confirmed', 'unverified'))
) STRICT;
CREATE INDEX app_input_events_time ON app_input_events (occurred_at_ms);
`;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS manuscripts (
  id TEXT PRIMARY KEY,
  date REAL NOT NULL,
  occurred_at TEXT NOT NULL,
  audio_opus BLOB,
  seconds REAL NOT NULL,
  application TEXT NOT NULL,
  original TEXT NOT NULL,
  asr_results TEXT NOT NULL,
  text TEXT NOT NULL,
  polished INTEGER NOT NULL,
  user_edited INTEGER NOT NULL DEFAULT 0,
  delivery_note TEXT,
  audio_warning TEXT
);
CREATE TABLE IF NOT EXISTS lexicon (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  hint TEXT NOT NULL,
  aliases TEXT NOT NULL,
  position INTEGER NOT NULL,
  app_group TEXT,
  match_count INTEGER NOT NULL DEFAULT 0,
  last_matched_at INTEGER,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const SYNC_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS sync_hub_cursors (
  hub_instance_id TEXT PRIMARY KEY,
  last_pulled_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_pulled_seq >= 0),
  last_sync_at_ms INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS sync_entries (
  collection TEXT NOT NULL CHECK(collection IN ('lexicon', 'manuscript')),
  record_key TEXT NOT NULL,
  local_id TEXT,
  version_hlc TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
  deleted_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (collection, record_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sync_entries_local ON sync_entries (collection, local_id);
CREATE TABLE IF NOT EXISTS sync_hub_acked (
  hub_instance_id TEXT NOT NULL,
  collection TEXT NOT NULL CHECK(collection IN ('lexicon', 'manuscript')),
  record_key TEXT NOT NULL,
  acked_hlc TEXT NOT NULL,
  PRIMARY KEY (hub_instance_id, collection, record_key)
) STRICT;
CREATE TABLE IF NOT EXISTS sync_pruned (
  manuscript_id TEXT PRIMARY KEY,
  pruned_at_ms INTEGER NOT NULL,
  pruned_version_hlc TEXT
) STRICT;
`;

export function parseLibrary(value: unknown): Library {
  const library = value as Library;
  if (!library || !Array.isArray(library.manuscripts) || !Array.isArray(library.lexicon)) throw new Error('文稿库格式无效。');
  const ids = new Set<string>();
  for (const item of library.manuscripts) {
    if (typeof item.id !== 'string' || ids.has(item.id) || !Number.isFinite(item.date) || !Number.isFinite(item.seconds) || item.seconds < 0 || typeof item.text !== 'string' || typeof item.original !== 'string' || typeof item.application !== 'string' || typeof item.polished !== 'boolean' || (item.hasAudio !== undefined && typeof item.hasAudio !== 'boolean') || (item.audioWarning !== undefined && typeof item.audioWarning !== 'string')) throw new Error('文稿库中存在无效内容。');
    ids.add(item.id);
    if (item.recordingEndedAtMs !== undefined && (!Number.isSafeInteger(item.recordingEndedAtMs) || item.recordingEndedAtMs <= 0)) throw new Error('录音结束时间无效。');
    if (item.asrResults !== undefined && (!Array.isArray(item.asrResults) || item.asrResults.some(result => !result || typeof result.engine_name !== 'string' || typeof result.transcript !== 'string' || (result.language != null && typeof result.language !== 'string')))) throw new Error('文稿的识别对照格式无效。');
  }
  ids.clear();
  for (const item of library.lexicon) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.term !== 'string' || typeof item.hint !== 'string'
      || (item.aliases !== undefined && (!Array.isArray(item.aliases) || item.aliases.some(alias => typeof alias !== 'string')))
      || (item.group !== undefined && !isTermGroup(item.group))
      || [item.matchCount, item.lastMatchedAt, item.createdAt].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
      throw new Error('词库格式无效。');
    }
    ids.add(item.id);
  }
  return library;
}

export interface ManuscriptMedia { id: string; audioOpus?: Uint8Array; screenshotImage?: Uint8Array }
export interface AppInputEvent {
  eventId: string; occurredAtMs: number; appKey: string; appName: string; characters: number; confirmed: boolean;
}

export interface StoreSyncConfig {
  deviceId: string;
  vaultId: string;
  keyMacKey: Buffer;
  nowFn?: () => number;
}

export interface SyncEntryRow {
  collection: SyncCollection;
  recordKey: string;
  localId: string | null;
  versionHlc: string;
  originDeviceId: string;
  deleted: boolean;
  deletedAtMs: number | null;
  updatedAtMs: number;
  meta: Record<string, unknown>;
}

export interface SyncHubCursorRow {
  hubInstanceId: string;
  lastPulledSeq: number;
  lastSyncAtMs: number | null;
}

export interface SyncPrunedRow {
  manuscriptId: string;
  prunedAtMs: number;
  prunedVersionHlc: string | null;
}

export interface RemoteSyncTxContext {
  db: DatabaseSync;
  hlc: HlcClock;
  nowMs: number;
  getSyncEntry(collection: SyncCollection, recordKey: string): SyncEntryRow | undefined;
  upsertSyncEntry(entry: SyncEntryRow): void;
  getPrunedManuscript(manuscriptId: string): SyncPrunedRow | undefined;
  clearPrunedManuscript(manuscriptId: string): void;
  upsertRemoteManuscript(item: Manuscript, deleted: boolean): void;
  upsertRemoteLexiconTerm(entry: Term, deleted: boolean, matchId?: string): string;
  markHubAcked(hubInstanceId: string, collection: SyncCollection, recordKey: string, versionHlc: string): void;
  setHubCursor(hubInstanceId: string, seq: number, syncedAtMs: number): void;
}

export class LibraryStore {
  readonly dbPath: string;
  error = '';
  library: Library = { manuscripts: [], lexicon: [] };
  settings: Settings;
  private readonly defaults: Settings;
  private db?: DatabaseSync;
  private savedManuscripts = new Map<string, string>();
  private savedLexicon = new Map<string, string>();
  private savedLexiconContent = new Map<string, string>();
  private savedLexiconEntries = new Map<string, Term>();
  private savedSettings = '';
  private audioIds = new Set<string>();
  private pendingPrunedIds = new Set<string>();
  private syncConfig: StoreSyncConfig | null = null;
  private hlcClock: HlcClock | null = null;
  private _libraryVersion = 0;
  private _remoteRevision = 0;
  onRemoteLibraryChanged?: () => void;
  onLocalPersisted?: () => void;

  get libraryVersion() {
    return this._libraryVersion;
  }

  get remoteRevision() {
    return this._remoteRevision;
  }

  constructor(readonly directory: string, defaults: Settings, legacyLibrary?: string) {
    this.dbPath = join(directory, 'yanmo.db');
    this.defaults = structuredClone(defaults);
    this.settings = structuredClone(defaults);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const db = this.openDatabase();
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      const populated = Number(db.prepare('SELECT (SELECT count(*) FROM settings) + (SELECT count(*) FROM manuscripts) + (SELECT count(*) FROM lexicon) AS n').get()!.n) > 0;
      // A populated v0 database came from the unreleased SQLite prototype. It is
      // already authoritative: stale JSON must never overwrite committed rows.
      if (version === 0) {
        if (populated) this.readDatabase(defaults, false);
        else this.readLegacy(defaults, legacyLibrary);
        this.writeDatabase(undefined, true);
      } else {
        if (version < SCHEMA_VERSION) {
          db.exec('BEGIN IMMEDIATE');
          try {
            this.migrateSchema(db, version);
            this.readDatabase(defaults);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        } else this.readDatabase(defaults);
        this.remember();
      }
      // This cleanup is outside the migration transaction. An interrupted rename
      // is harmless: user_version was committed with the data, so JSON is ignored.
      for (const name of ['library.json', 'settings.json']) {
        const path = join(directory, name);
        if (existsSync(path) && !existsSync(path + '.migrated-backup')) {
          try { renameSync(path, path + '.migrated-backup'); }
          catch { /* Original remains a backup; the database stays authoritative. */ }
        }
      }
    } catch {
      this.close();
      this.error = '本机数据读取或迁移失败，原文件已保留，已暂停覆盖保存。请检查言墨数据目录。';
    }
  }

  private migrateSavedSettings(defaults: Settings, raw: Record<string, unknown>): Settings {
    const { llmModel: _oldLlm, asrModel: oldAsr, senseVoiceModel: _oldSv, modelSource: _oldSource, acpm: savedAcpm, ...rest } = raw;
    const acpm: AcpmSettings = savedAcpm && typeof savedAcpm === 'object' && !Array.isArray(savedAcpm)
      ? { ...defaults.acpm, ...(savedAcpm as Partial<AcpmSettings>) }
      : { ...defaults.acpm };
    if (!savedAcpm && typeof oldAsr === 'string' && oldAsr.toLowerCase().includes('0.6b')) {
      acpm.asrModel = 'qwen3-asr-0.6b';
    }
    return { ...defaults, ...rest, acpm } as Settings;
  }

  private readLegacy(defaults: Settings, legacyLibrary?: string) {
    const settingsPath = join(this.directory, 'settings.json');
    const libraryPath = join(this.directory, 'library.json');
    if (existsSync(settingsPath)) {
      this.settings = this.migrateSavedSettings(defaults, JSON.parse(readFileSync(settingsPath, 'utf8')));
    } else if (!legacyLibrary || !existsSync(legacyLibrary)) {
      this.settings = { ...defaults, onboarded: false };
    }
    if (existsSync(libraryPath)) this.library = parseLibrary(JSON.parse(readFileSync(libraryPath, 'utf8')));
    else if (legacyLibrary && existsSync(legacyLibrary)) {
      this.library = parseLibrary(JSON.parse(readFileSync(legacyLibrary, 'utf8')));
      const backup = join(this.directory, 'library-v0.3-backup.json');
      if (!existsSync(backup)) { copyFileSync(legacyLibrary, backup); chmodSync(backup, 0o600); }
    }
    validateSettings(this.settings);
  }

  private readDatabase(defaults: Settings, hasRecordingContext = true) {
    const db = this.openDatabase();
    const saved: Record<string, unknown> = {};
    for (const row of db.prepare('SELECT key, value FROM settings WHERE key != ?').all(STATISTICS_START)) saved[String(row.key)] = JSON.parse(String(row.value));
    this.settings = this.migrateSavedSettings(defaults, saved);
    validateSettings(this.settings);
    const endedAt = hasRecordingContext ? 'recording_ended_at_ms' : 'NULL AS recording_ended_at_ms';
    const rows = db.prepare(`SELECT id, date, length(audio_opus) > 0 AS has_audio, seconds, application, original, asr_results, text, polished, user_edited, delivery_note, audio_warning, ${endedAt} FROM manuscripts ORDER BY date DESC`).all();
    this.library = parseLibrary({
      manuscripts: rows.map(row => ({
        id: row.id, date: row.date, original: row.original, text: row.text,
        seconds: row.seconds, application: row.application, polished: row.polished === 1,
        asrResults: JSON.parse(String(row.asr_results)),
        ...(row.user_edited === 1 ? { userEdited: true } : {}),
        ...(row.delivery_note ? { deliveryNote: row.delivery_note } : {}),
        ...(row.audio_warning ? { audioWarning: row.audio_warning } : {}),
        ...(row.has_audio ? { hasAudio: true } : {}),
        ...(row.recording_ended_at_ms !== null ? { recordingEndedAtMs: row.recording_ended_at_ms } : {}),
      })),
      lexicon: db.prepare('SELECT * FROM lexicon ORDER BY position').all().map(row => ({
        id: row.id, term: row.term, hint: row.hint, aliases: JSON.parse(String(row.aliases)),
        ...(row.app_group !== null ? { group: row.app_group as TermGroup } : {}),
        ...(row.match_count ? { matchCount: row.match_count } : {}),
        ...(row.last_matched_at !== null ? { lastMatchedAt: row.last_matched_at } : {}),
        ...(row.created_at !== null ? { createdAt: row.created_at } : {}),
      })),
    });
    this.audioIds = new Set(this.library.manuscripts.filter(item => item.hasAudio).map(item => item.id));
  }

  private openDatabase(): DatabaseSync {
    if (this.db) return this.db;
    const db = this.db = new DatabaseSync(this.dbPath);
    db.exec('PRAGMA busy_timeout = 1000;');
    if (Number(db.prepare('PRAGMA user_version').get()!.user_version) > SCHEMA_VERSION) throw new Error('数据库版本高于当前应用。');
    chmodSync(this.dbPath, 0o600);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.exec(SCHEMA_SQL);
    const cols = db.prepare('PRAGMA table_info(manuscripts)').all();
    if (!cols.some(col => col.name === 'occurred_at')) db.exec("ALTER TABLE manuscripts ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''");
    if (!cols.some(col => col.name === 'audio_warning')) db.exec('ALTER TABLE manuscripts ADD COLUMN audio_warning TEXT');
    const lexiconColumns = new Set(db.prepare('PRAGMA table_info(lexicon)').all().map(col => col.name));
    const upgrades = [
      ['app_group', 'TEXT'], ['match_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_matched_at', 'INTEGER'], ['created_at', 'INTEGER'],
    ].filter(([name]) => !lexiconColumns.has(name));
    if (upgrades.length) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [name, type] of upgrades) db.exec(`ALTER TABLE lexicon ADD COLUMN ${name} ${type}`);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return db;
  }

  private serialized(item: Manuscript) {
    const { hasAudio: _derived, ...metadata } = item;
    return JSON.stringify(metadata);
  }

  private lexiconIdentityKey(entry: Pick<Term, 'term' | 'group'>): string {
    const normalized = termKey(entry.term);
    return normalized ? `${termGroup(entry.group)}:${normalized}` : '';
  }

  private lexiconIntentChanged(prev: Term | undefined, next: Term): boolean {
    if (!prev) return true;
    return prev.term !== next.term
      || prev.hint !== next.hint
      || (prev.group ?? null) !== (next.group ?? null)
      || JSON.stringify(prev.aliases ?? []) !== JSON.stringify(next.aliases ?? []);
  }

  private remember() {
    this.savedManuscripts = new Map(this.library.manuscripts.map(item => [item.id, this.serialized(item)]));
    this.savedLexicon = new Map(this.library.lexicon.map((entry, index) => [entry.id, JSON.stringify([index, entry])]));
    this.savedLexiconContent = new Map(this.library.lexicon.map(entry => [entry.id, JSON.stringify(entry)]));
    this.savedLexiconEntries = new Map(this.library.lexicon.map(entry => [entry.id, structuredClone(entry)]));
    this.savedSettings = JSON.stringify(this.settings);
  }

  private writeDatabase(media?: ManuscriptMedia, initialize = false) {
    const db = this.openDatabase();
    if (media && !this.library.manuscripts.some(item => item.id === media.id &&
        (media.audioOpus?.byteLength || media.screenshotImage?.byteLength) &&
        (!media.screenshotImage?.byteLength || item.recordingEndedAtMs))) throw new Error('录音或截图没有对应的文稿。');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (initialize) this.migrateSchema(db, 0);
      const upsert = db.prepare(`
        INSERT INTO manuscripts (id, date, occurred_at, audio_opus, seconds, application, original, asr_results, text, polished, user_edited, delivery_note, audio_warning, recording_ended_at_ms, screenshot_image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date=excluded.date, occurred_at=excluded.occurred_at,
          audio_opus=COALESCE(excluded.audio_opus, manuscripts.audio_opus),
          seconds=excluded.seconds, application=excluded.application, original=excluded.original,
          asr_results=excluded.asr_results, text=excluded.text, polished=excluded.polished,
          user_edited=excluded.user_edited, delivery_note=excluded.delivery_note, audio_warning=excluded.audio_warning,
          recording_ended_at_ms=COALESCE(excluded.recording_ended_at_ms, manuscripts.recording_ended_at_ms),
          screenshot_image=COALESCE(excluded.screenshot_image, manuscripts.screenshot_image)
      `);
      const ids = new Set<string>();
      for (const item of this.library.manuscripts) {
        ids.add(item.id);
        if (this.savedManuscripts.get(item.id) === this.serialized(item) && media?.id !== item.id) continue;
        const attachments = media?.id === item.id ? media : undefined;
        upsert.run(item.id, item.date, manuscriptDate(item.date).toISOString(), attachments?.audioOpus ?? null,
          item.seconds, item.application, item.original, JSON.stringify(item.asrResults || []), item.text,
          item.polished ? 1 : 0, item.userEdited ? 1 : 0, item.deliveryNote ?? null, item.audioWarning ?? null,
          item.recordingEndedAtMs ?? null, attachments?.screenshotImage ?? null);
      }
      const remove = db.prepare('DELETE FROM manuscripts WHERE id = ?');
      for (const id of this.savedManuscripts.keys()) if (!ids.has(id)) remove.run(id);
      const upsertTerm = db.prepare(`
        INSERT INTO lexicon (id, term, hint, aliases, position, app_group, match_count, last_matched_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET term=excluded.term, hint=excluded.hint, aliases=excluded.aliases,
          position=excluded.position, app_group=excluded.app_group, match_count=excluded.match_count,
          last_matched_at=excluded.last_matched_at, created_at=excluded.created_at
      `);
      const termIDs = new Set<string>();
      this.library.lexicon.forEach((entry, index) => {
        termIDs.add(entry.id);
        if (this.savedLexicon.get(entry.id) === JSON.stringify([index, entry])) return;
        upsertTerm.run(entry.id, entry.term, entry.hint, JSON.stringify(entry.aliases || []), index,
          entry.group ?? null, entry.matchCount ?? 0, entry.lastMatchedAt ?? null, entry.createdAt ?? null);
      });
      const removeTerm = db.prepare('DELETE FROM lexicon WHERE id = ?');
      for (const id of this.savedLexicon.keys()) if (!termIDs.has(id)) removeTerm.run(id);
      if (this.savedSettings !== JSON.stringify(this.settings)) {
        db.prepare('DELETE FROM settings WHERE key != ?').run(STATISTICS_START);
        const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
        for (const [key, value] of Object.entries(this.settings)) insert.run(key, JSON.stringify(value));
      }
      if (!initialize && this.syncConfig && this.hlcClock) {
        this.recordLocalSyncChanges(db, ids, termIDs, media);
      }
      db.exec('COMMIT');
      this._libraryVersion += 1;
      this.pendingPrunedIds.clear();
      this.audioIds = new Set([...this.audioIds].filter(id => ids.has(id)));
      if (media?.audioOpus?.byteLength) this.audioIds.add(media.id);
      for (const item of this.library.manuscripts) {
        if (this.audioIds.has(item.id)) item.hasAudio = true;
        else delete item.hasAudio;
      }
      this.remember();
      if (!initialize && this.syncConfig) this.onLocalPersisted?.();
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  /** Metadata, optional recordings and screenshots, pruning and preferences commit as one unit. */
  persist(media?: ManuscriptMedia) {
    if (this.error) throw new Error(this.error);
    parseLibrary(this.library); validateSettings(this.settings);
    this.writeDatabase(media);
  }

  private migrateSchema(db: DatabaseSync, version: number) {
    if (version < 3) {
      db.exec(STATISTICS_SQL);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(STATISTICS_START, String(Date.now()));
    }
    if (version < 4) {
      db.exec('ALTER TABLE manuscripts ADD COLUMN recording_ended_at_ms INTEGER; ALTER TABLE manuscripts ADD COLUMN screenshot_image BLOB');
    }
    if (version < 5) {
      db.exec(SYNC_SCHEMA_SQL);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  recordAppInput(event: AppInputEvent) {
    if (this.error || !this.db) throw new Error('本机统计暂不可用。');
    // An early dispatch event survives cancellation. A later verification can
    // upgrade it without changing the target, timestamp or character count.
    this.db.prepare(`
      INSERT INTO app_input_events VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET delivery_status = 'confirmed'
      WHERE excluded.delivery_status = 'confirmed' AND delivery_status = 'unverified'
    `).run(event.eventId, event.occurredAtMs, event.appKey, event.appName, event.characters, event.confirmed ? 'confirmed' : 'unverified');
  }

  startLlmCall(purpose: LLMPurpose, model: string): string | undefined {
    if (this.error || !this.db) return undefined;
    const callId = randomUUID();
    try {
      this.db.prepare(`
        INSERT INTO llm_usage_events (call_id, started_at_ms, purpose, model, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).run(callId, Date.now(), purpose, model);
      return callId;
    } catch {
      return undefined;
    }
  }

  finishLlmCall(callId: string | undefined, status: 'response' | 'request_error', usage?: Record<string, unknown>) {
    if (!callId || this.error || !this.db) return;
    const count = (value: unknown): number | null =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
    const inputTokens = count(usage?.prompt_tokens);
    const outputTokens = count(usage?.completion_tokens);
    let total = count(usage?.total_tokens);
    if (total === null && inputTokens !== null && outputTokens !== null) {
      const sum = inputTokens + outputTokens;
      total = Number.isSafeInteger(sum) ? sum : null;
    }
    try {
      this.db.prepare(`
        UPDATE llm_usage_events SET status = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?
        WHERE call_id = ?
      `).run(status, inputTokens, outputTokens, total, callId);
    } catch { /* Usage tracking never interrupts text generation. */ }
  }

  dailyUsage(day: string): DailyUsage {
    if (this.error || !this.db) throw new Error('本机统计暂不可用。');
    const db = this.db;
    const start = localDayDate(day).getTime();
    const end = localDayDate(shiftLocalDay(day, 1)).getTime();
    const previous = localDayDate(shiftLocalDay(day, -1)).getTime();
    const activated = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(STATISTICS_START)?.value);
    if (!Number.isSafeInteger(activated) || activated < 1) throw new Error('本机统计的启用日期不可用。');
    const coverage = activated >= end ? 'unrecorded' : activated > start ? 'partial' : 'recorded';
    const apps = db.prepare(`
      SELECT app_key, max(app_name) AS app_name, sum(character_count) AS sent,
        sum(CASE WHEN delivery_status = 'confirmed' THEN character_count ELSE 0 END) AS confirmed
      FROM app_input_events WHERE occurred_at_ms >= ? AND occurred_at_ms < ?
      GROUP BY app_key ORDER BY sent DESC, app_key
    `).all(start, end).map(row => {
      const sent = Number(row.sent), confirmed = Number(row.confirmed);
      return { appKey: String(row.app_key), name: String(row.app_name), sent, confirmed, unverified: sent - confirmed };
    });
    const previousSent = activated <= previous && end <= Date.now()
      ? Number(db.prepare('SELECT coalesce(sum(character_count), 0) AS sent FROM app_input_events WHERE occurred_at_ms >= ? AND occurred_at_ms < ?').get(previous, start)!.sent)
      : null;
    const byPurpose: DailyUsage['llm']['byPurpose'] = { polish: 0, hotword_extract: 0, translate: 0 };
    let unknown = 0, total = 0, measured = 0;
    for (const row of db.prepare(`
      SELECT purpose, sum(total_tokens) AS total, count(total_tokens) AS measured, count(*) AS calls
      FROM llm_usage_events WHERE started_at_ms >= ? AND started_at_ms < ? GROUP BY purpose
    `).all(start, end)) {
      byPurpose[row.purpose as LLMPurpose] = row.total === null ? null : Number(row.total);
      unknown += Number(row.calls) - Number(row.measured);
      total += Number(row.total ?? 0);
      measured += Number(row.measured);
    }
    return { coverage, apps, sent: apps.reduce((sum, item) => sum + item.sent, 0), previousSent,
      llm: { byPurpose, unknown, total: unknown > 0 && measured === 0 ? null : total } };
  }

  getAudio(id: string): Buffer | undefined {
    if (this.error) return undefined;
    const row = this.openDatabase().prepare('SELECT audio_opus FROM manuscripts WHERE id = ?').get(id);
    return row?.audio_opus instanceof Uint8Array && row.audio_opus.byteLength ? Buffer.from(row.audio_opus) : undefined;
  }

  getAttachments(id: string): ManuscriptAttachments {
    if (this.error) return {};
    const row = this.openDatabase().prepare('SELECT audio_opus, screenshot_image FROM manuscripts WHERE id = ?').get(id);
    const attachments: ManuscriptAttachments = {};
    if (row?.audio_opus instanceof Uint8Array && row.audio_opus.byteLength) attachments.audio = row.audio_opus;
    if (row?.screenshot_image instanceof Uint8Array && row.screenshot_image.byteLength) attachments.screenshot = row.screenshot_image;
    return attachments;
  }

  prune() {
    if (this.settings.retention) {
      const cutoff = cocoaNow() - this.settings.retention * 86400;
      const kept: Manuscript[] = [];
      for (const item of this.library.manuscripts) {
        if (item.date >= cutoff) kept.push(item);
        else this.pendingPrunedIds.add(item.id);
      }
      this.library.manuscripts = kept;
    }
  }

  private nowSyncMs(): number {
    return Math.floor(this.syncConfig?.nowFn ? this.syncConfig.nowFn() : Date.now());
  }

  private readSyncEntryRow(db: DatabaseSync, collection: SyncCollection, recordKey: string): SyncEntryRow | undefined {
    const row = db.prepare(`
      SELECT collection, record_key, local_id, version_hlc, origin_device_id, deleted, deleted_at_ms, updated_at_ms, meta_json
      FROM sync_entries WHERE collection = ? AND record_key = ?
    `).get(collection, recordKey);
    if (!row) return undefined;
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(String(row.meta_json || '{}')) as Record<string, unknown>; } catch { meta = {}; }
    return {
      collection: row.collection as SyncCollection,
      recordKey: String(row.record_key),
      localId: row.local_id === null ? null : String(row.local_id),
      versionHlc: String(row.version_hlc),
      originDeviceId: String(row.origin_device_id),
      deleted: Number(row.deleted) === 1,
      deletedAtMs: row.deleted_at_ms === null ? null : Number(row.deleted_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      meta,
    };
  }

  private writeSyncEntryRow(db: DatabaseSync, entry: SyncEntryRow) {
    db.prepare(`
      INSERT INTO sync_entries (collection, record_key, local_id, version_hlc, origin_device_id, deleted, deleted_at_ms, updated_at_ms, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, record_key) DO UPDATE SET
        local_id=excluded.local_id,
        version_hlc=excluded.version_hlc,
        origin_device_id=excluded.origin_device_id,
        deleted=excluded.deleted,
        deleted_at_ms=excluded.deleted_at_ms,
        updated_at_ms=excluded.updated_at_ms,
        meta_json=excluded.meta_json
    `).run(
      entry.collection,
      entry.recordKey,
      entry.localId,
      entry.versionHlc,
      entry.originDeviceId,
      entry.deleted ? 1 : 0,
      entry.deletedAtMs,
      entry.updatedAtMs,
      JSON.stringify(entry.meta || {}),
    );
  }

  private saveHlcState(db: DatabaseSync, clock: HlcClock) {
    const snap = clock.snapshot();
    const upsert = db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    upsert.run('hlc_last_ms', String(snap.lastMs));
    upsert.run('hlc_counter', String(snap.counter));
  }

  private detectAudioFormat(bytes: Uint8Array): string {
    if (bytes.byteLength >= 4) {
      if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) return 'flac';
      if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'wav';
    }
    return 'bin';
  }

  private detectImageFormat(bytes: Uint8Array): string {
    if (bytes.byteLength >= 12 && Buffer.from(bytes.subarray(4, 12)).toString('ascii') === 'ftypavif') return 'avif';
    if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
    if (bytes.byteLength >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
    return 'bin';
  }

  private buildBlobRef(keyMacKey: Buffer, bytes: Uint8Array, format: string) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      blob_id: computeBlobId(keyMacKey, sha256),
      format,
      size_bytes: bytes.byteLength,
    };
  }

  private recordLocalSyncChanges(
    db: DatabaseSync,
    currentManuscriptIds: Set<string>,
    currentTermIds: Set<string>,
    media?: ManuscriptMedia,
  ) {
    const config = this.syncConfig;
    const clock = this.hlcClock;
    if (!config || !clock) return;
    const nowMs = this.nowSyncMs();

    for (const item of this.library.manuscripts) {
      if (this.savedManuscripts.get(item.id) === this.serialized(item) && media?.id !== item.id) continue;
      const existing = this.readSyncEntryRow(db, 'manuscript', item.id);
      const meta: Record<string, unknown> = { ...(existing?.meta ?? {}) };
      if (!meta.sourceDeviceId) meta.sourceDeviceId = config.deviceId;
      if (media?.id === item.id) {
        if (media.audioOpus?.byteLength) {
          meta.audioBlob = this.buildBlobRef(config.keyMacKey, media.audioOpus, this.detectAudioFormat(media.audioOpus));
        }
        if (media.screenshotImage?.byteLength) {
          meta.screenshotBlob = this.buildBlobRef(config.keyMacKey, media.screenshotImage, this.detectImageFormat(media.screenshotImage));
        }
      }
      this.writeSyncEntryRow(db, {
        collection: 'manuscript',
        recordKey: item.id,
        localId: item.id,
        versionHlc: clock.tick(),
        originDeviceId: config.deviceId,
        deleted: false,
        deletedAtMs: null,
        updatedAtMs: nowMs,
        meta,
      });
      db.prepare('DELETE FROM sync_pruned WHERE manuscript_id = ?').run(item.id);
    }

    for (const oldId of this.savedManuscripts.keys()) {
      if (currentManuscriptIds.has(oldId)) continue;
      const existing = this.readSyncEntryRow(db, 'manuscript', oldId);
      if (this.pendingPrunedIds.has(oldId)) {
        // Retention pruning is strictly local; never propagate a global deletion tombstone.
        db.prepare('INSERT OR REPLACE INTO sync_pruned (manuscript_id, pruned_at_ms, pruned_version_hlc) VALUES (?, ?, ?)')
          .run(oldId, nowMs, existing?.versionHlc ?? null);
        db.prepare("DELETE FROM sync_entries WHERE collection = 'manuscript' AND record_key = ?").run(oldId);
        db.prepare("DELETE FROM sync_hub_acked WHERE collection = 'manuscript' AND record_key = ?").run(oldId);
      } else {
        this.writeSyncEntryRow(db, {
          collection: 'manuscript',
          recordKey: oldId,
          localId: oldId,
          versionHlc: clock.tick(),
          originDeviceId: config.deviceId,
          deleted: true,
          deletedAtMs: nowMs,
          updatedAtMs: nowMs,
          meta: existing?.meta ?? {},
        });
      }
    }

    const activeTermKeys = new Set<string>();
    for (const entry of this.library.lexicon) {
      const idKey = this.lexiconIdentityKey(entry);
      if (idKey) activeTermKeys.add(idKey);
    }

    this.library.lexicon.forEach((entry, index) => {
      if (this.savedLexiconContent.get(entry.id) === JSON.stringify(entry)) return;
      const oldEntry = this.savedLexiconEntries.get(entry.id);
      const oldIdKey = oldEntry ? this.lexiconIdentityKey(oldEntry) : '';
      const newIdKey = this.lexiconIdentityKey(entry);
      if (oldEntry && oldIdKey && newIdKey && oldIdKey !== newIdKey && !activeTermKeys.has(oldIdKey)) {
        const oldRk = computeLexiconRecordKey(config.keyMacKey, oldEntry.term, oldEntry.group);
        const oldMeta = this.readSyncEntryRow(db, 'lexicon', oldRk)?.meta ?? {};
        this.writeSyncEntryRow(db, {
          collection: 'lexicon',
          recordKey: oldRk,
          localId: null,
          versionHlc: clock.tick(),
          originDeviceId: config.deviceId,
          deleted: true,
          deletedAtMs: nowMs,
          updatedAtMs: nowMs,
          meta: oldMeta,
        });
      }
      if (!newIdKey) return;

      const rk = computeLexiconRecordKey(config.keyMacKey, entry.term, entry.group);
      const existing = this.readSyncEntryRow(db, 'lexicon', rk);
      const isRenameOrRevive = !oldEntry || oldIdKey !== newIdKey || Boolean(existing?.deleted);
      const meta: Record<string, unknown> = existing?.deleted
        ? (existing.meta.unknownFields ? { unknownFields: existing.meta.unknownFields } : {})
        : { ...(existing?.meta ?? {}) };
      const deviceCounts = isRenameOrRevive
        ? (entry.matchCount ? { [config.deviceId]: entry.matchCount } : {})
        : { ...(meta.deviceCounts as Record<string, number> | undefined) };
      if (!isRenameOrRevive && oldEntry) {
        const prevKnownTotal = oldEntry.matchCount ?? 0;
        const currentTotal = entry.matchCount ?? 0;
        const delta = currentTotal - prevKnownTotal;
        if (delta !== 0) {
          deviceCounts[config.deviceId] = Math.max(0, (deviceCounts[config.deviceId] ?? 0) + delta);
        }
      }
      meta.deviceCounts = deviceCounts;

      const removedSet = isRenameOrRevive
        ? new Set<string>()
        : new Set<string>(Array.isArray(meta.removedAliases) ? meta.removedAliases.map(String) : []);
      const currentAliases = new Set((entry.aliases ?? []).map(a => termKey(a)).filter(Boolean));
      if (!isRenameOrRevive && oldEntry) {
        for (const prevAlias of oldEntry.aliases ?? []) {
          const ak = termKey(prevAlias);
          if (ak && !currentAliases.has(ak)) removedSet.add(ak);
        }
      }
      for (const ak of currentAliases) removedSet.delete(ak);
      meta.removedAliases = [...removedSet].sort();
      meta.positionHint = index;

      const versionHlc = clock.tick();
      const intentChanged = isRenameOrRevive || !existing?.meta.intentHlc || this.lexiconIntentChanged(oldEntry, entry);
      meta.intentHlc = intentChanged ? versionHlc : existing!.meta.intentHlc;

      this.writeSyncEntryRow(db, {
        collection: 'lexicon',
        recordKey: rk,
        localId: entry.id,
        versionHlc,
        originDeviceId: config.deviceId,
        deleted: false,
        deletedAtMs: null,
        updatedAtMs: nowMs,
        meta,
      });
    });

    for (const [oldId, oldEntry] of this.savedLexiconEntries.entries()) {
      if (currentTermIds.has(oldId)) continue;
      const oldIdKey = this.lexiconIdentityKey(oldEntry);
      if (!oldIdKey || activeTermKeys.has(oldIdKey)) continue;
      const oldRk = computeLexiconRecordKey(config.keyMacKey, oldEntry.term, oldEntry.group);
      const existing = this.readSyncEntryRow(db, 'lexicon', oldRk);
      this.writeSyncEntryRow(db, {
        collection: 'lexicon',
        recordKey: oldRk,
        localId: null,
        versionHlc: clock.tick(),
        originDeviceId: config.deviceId,
        deleted: true,
        deletedAtMs: nowMs,
        updatedAtMs: nowMs,
        meta: existing?.meta ?? {},
      });
    }

    this.saveHlcState(db, clock);
  }

  configureSync(config: StoreSyncConfig | null) {
    if (this.error) throw new Error(this.error);
    this.syncConfig = config;
    if (!config) {
      this.hlcClock = null;
      return;
    }
    const db = this.openDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const storedVaultRow = db.prepare("SELECT value FROM sync_state WHERE key = 'vault_id'").get();
      const storedVaultId = storedVaultRow ? String(storedVaultRow.value) : '';
      if (storedVaultId && storedVaultId !== config.vaultId) {
        db.exec('DELETE FROM sync_entries');
        db.exec('DELETE FROM sync_hub_cursors');
        db.exec('DELETE FROM sync_hub_acked');
        db.exec('DELETE FROM sync_pruned');
        db.exec("DELETE FROM sync_state WHERE key IN ('hlc_last_ms', 'hlc_counter')");
      }
      db.prepare("INSERT INTO sync_state (key, value) VALUES ('vault_id', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(config.vaultId);

      const lastMsRow = db.prepare("SELECT value FROM sync_state WHERE key = 'hlc_last_ms'").get();
      const counterRow = db.prepare("SELECT value FROM sync_state WHERE key = 'hlc_counter'").get();
      const clock = new HlcClock(
        config.deviceId,
        {
          lastMs: lastMsRow ? Number(lastMsRow.value) : 0,
          counter: counterRow ? Number(counterRow.value) : 0,
        },
        config.nowFn,
      );
      this.hlcClock = clock;
      const nowMs = this.nowSyncMs();

      for (const item of this.library.manuscripts) {
        if (!this.readSyncEntryRow(db, 'manuscript', item.id)) {
          const att = db.prepare('SELECT audio_opus, screenshot_image FROM manuscripts WHERE id = ?').get(item.id);
          const meta: Record<string, unknown> = { sourceDeviceId: config.deviceId };
          if (att?.audio_opus instanceof Uint8Array && att.audio_opus.byteLength) {
            meta.audioBlob = this.buildBlobRef(config.keyMacKey, att.audio_opus, this.detectAudioFormat(att.audio_opus));
          }
          if (att?.screenshot_image instanceof Uint8Array && att.screenshot_image.byteLength) {
            meta.screenshotBlob = this.buildBlobRef(config.keyMacKey, att.screenshot_image, this.detectImageFormat(att.screenshot_image));
          }
          this.writeSyncEntryRow(db, {
            collection: 'manuscript',
            recordKey: item.id,
            localId: item.id,
            versionHlc: clock.tick(),
            originDeviceId: config.deviceId,
            deleted: false,
            deletedAtMs: null,
            updatedAtMs: nowMs,
            meta,
          });
        }
      }

      this.library.lexicon.forEach((entry, index) => {
        if (!termKey(entry.term)) return;
        const rk = computeLexiconRecordKey(config.keyMacKey, entry.term, entry.group);
        if (!this.readSyncEntryRow(db, 'lexicon', rk)) {
          const versionHlc = clock.tick();
          this.writeSyncEntryRow(db, {
            collection: 'lexicon',
            recordKey: rk,
            localId: entry.id,
            versionHlc,
            originDeviceId: config.deviceId,
            deleted: false,
            deletedAtMs: null,
            updatedAtMs: nowMs,
            meta: {
              intentHlc: versionHlc,
              deviceCounts: entry.matchCount ? { [config.deviceId]: entry.matchCount } : {},
              removedAliases: [],
              positionHint: index,
            },
          });
        }
      });

      this.saveHlcState(db, clock);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  resetSyncMetadata() {
    if (this.error) throw new Error(this.error);
    const db = this.openDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM sync_entries');
      db.exec('DELETE FROM sync_hub_cursors');
      db.exec('DELETE FROM sync_hub_acked');
      db.exec('DELETE FROM sync_pruned');
      db.exec('DELETE FROM sync_state');
      db.exec('COMMIT');
      this.syncConfig = null;
      this.hlcClock = null;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getHubCursor(hubInstanceId: string): SyncHubCursorRow {
    if (this.error) throw new Error(this.error);
    const row = this.openDatabase()
      .prepare('SELECT hub_instance_id, last_pulled_seq, last_sync_at_ms FROM sync_hub_cursors WHERE hub_instance_id = ?')
      .get(hubInstanceId);
    if (!row) return { hubInstanceId, lastPulledSeq: 0, lastSyncAtMs: null };
    return {
      hubInstanceId: String(row.hub_instance_id),
      lastPulledSeq: Number(row.last_pulled_seq),
      lastSyncAtMs: row.last_sync_at_ms === null ? null : Number(row.last_sync_at_ms),
    };
  }

  listHubCursors(): SyncHubCursorRow[] {
    if (this.error) throw new Error(this.error);
    return this.openDatabase()
      .prepare('SELECT hub_instance_id, last_pulled_seq, last_sync_at_ms FROM sync_hub_cursors')
      .all()
      .map(row => ({
        hubInstanceId: String(row.hub_instance_id),
        lastPulledSeq: Number(row.last_pulled_seq),
        lastSyncAtMs: row.last_sync_at_ms === null ? null : Number(row.last_sync_at_ms),
      }));
  }

  getSyncEntry(collection: SyncCollection, recordKey: string): SyncEntryRow | undefined {
    if (this.error) throw new Error(this.error);
    return this.readSyncEntryRow(this.openDatabase(), collection, recordKey);
  }

  saveCachedAttachments(id: string, media: { audioOpus?: Uint8Array; screenshotImage?: Uint8Array }): boolean {
    if (this.error) throw new Error(this.error);
    if (!media.audioOpus?.byteLength && !media.screenshotImage?.byteLength) return false;
    const db = this.openDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const exists = db.prepare('SELECT id FROM manuscripts WHERE id = ?').get(id);
      if (!exists) {
        db.exec('COMMIT');
        return false;
      }
      db.prepare(`
        UPDATE manuscripts SET
          audio_opus = COALESCE(?, audio_opus),
          screenshot_image = COALESCE(?, screenshot_image)
        WHERE id = ?
      `).run(media.audioOpus ?? null, media.screenshotImage ?? null, id);
      db.exec('COMMIT');
      if (media.audioOpus?.byteLength) {
        this.audioIds.add(id);
        const item = this.library.manuscripts.find(m => m.id === id);
        if (item) item.hasAudio = true;
      }
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  updateManuscriptBlobRefs(
    id: string,
    refs: { audioBlob?: Record<string, unknown> | null; screenshotBlob?: Record<string, unknown> | null },
  ): void {
    if (this.error) throw new Error(this.error);
    const db = this.openDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.readSyncEntryRow(db, 'manuscript', id);
      if (existing) {
        const meta: Record<string, unknown> = { ...existing.meta };
        const prevAudio = JSON.stringify(existing.meta.audioBlob ?? null);
        const prevShot = JSON.stringify(existing.meta.screenshotBlob ?? null);
        if (refs.audioBlob !== undefined) meta.audioBlob = refs.audioBlob;
        if (refs.screenshotBlob !== undefined) meta.screenshotBlob = refs.screenshotBlob;
        const nextAudio = JSON.stringify(meta.audioBlob ?? null);
        const nextShot = JSON.stringify(meta.screenshotBlob ?? null);
        if (prevAudio !== nextAudio || prevShot !== nextShot) {
          const clock = this.hlcClock;
          this.writeSyncEntryRow(db, {
            ...existing,
            versionHlc: clock ? clock.tick() : existing.versionHlc,
            originDeviceId: this.syncConfig?.deviceId ?? existing.originDeviceId,
            updatedAtMs: this.nowSyncMs(),
            meta,
          });
          if (clock) this.saveHlcState(db, clock);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getPendingSyncEntries(hubInstanceId: string, limit = 200): SyncEntryRow[] {
    if (this.error) throw new Error(this.error);
    const rows = this.openDatabase().prepare(`
      SELECT e.collection, e.record_key, e.local_id, e.version_hlc, e.origin_device_id, e.deleted, e.deleted_at_ms, e.updated_at_ms, e.meta_json
      FROM sync_entries e
      LEFT JOIN sync_hub_acked a
        ON a.hub_instance_id = ? AND a.collection = e.collection AND a.record_key = e.record_key
      WHERE a.acked_hlc IS NULL OR a.acked_hlc < e.version_hlc
      ORDER BY e.version_hlc ASC
      LIMIT ?
    `).all(hubInstanceId, Math.max(1, Math.min(500, Math.floor(limit))));
    return rows.map(row => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(String(row.meta_json || '{}')) as Record<string, unknown>; } catch { meta = {}; }
      return {
        collection: row.collection as SyncCollection,
        recordKey: String(row.record_key),
        localId: row.local_id === null ? null : String(row.local_id),
        versionHlc: String(row.version_hlc),
        originDeviceId: String(row.origin_device_id),
        deleted: Number(row.deleted) === 1,
        deletedAtMs: row.deleted_at_ms === null ? null : Number(row.deleted_at_ms),
        updatedAtMs: Number(row.updated_at_ms),
        meta,
      };
    });
  }

  markHubAcked(hubInstanceId: string, acks: { collection: SyncCollection; recordKey: string; versionHlc: string }[]) {
    if (this.error) throw new Error(this.error);
    if (!acks.length) return;
    const db = this.openDatabase();
    db.exec('BEGIN IMMEDIATE');
    try {
      const stmt = db.prepare(`
        INSERT INTO sync_hub_acked (hub_instance_id, collection, record_key, acked_hlc)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(hub_instance_id, collection, record_key) DO UPDATE SET
          acked_hlc = CASE WHEN excluded.acked_hlc > sync_hub_acked.acked_hlc THEN excluded.acked_hlc ELSE sync_hub_acked.acked_hlc END
      `);
      for (const item of acks) {
        stmt.run(hubInstanceId, item.collection, item.recordKey, item.versionHlc);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  setHubCursor(hubInstanceId: string, seq: number, syncedAtMs: number) {
    if (this.error) throw new Error(this.error);
    this.openDatabase().prepare(`
      INSERT INTO sync_hub_cursors (hub_instance_id, last_pulled_seq, last_sync_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(hub_instance_id) DO UPDATE SET
        last_pulled_seq = excluded.last_pulled_seq,
        last_sync_at_ms = excluded.last_sync_at_ms
    `).run(hubInstanceId, Math.max(0, Math.floor(seq)), syncedAtMs);
  }

  applyRemoteSyncTransaction(fn: (ctx: RemoteSyncTxContext) => void) {
    if (this.error) throw new Error(this.error);
    if (!this.syncConfig || !this.hlcClock) {
      throw new Error('同步引擎尚未配置本地存储。');
    }
    const db = this.openDatabase();
    const clock = this.hlcClock;
    const nowMs = this.nowSyncMs();
    let libraryChanged = false;

    db.exec('BEGIN IMMEDIATE');
    try {
      const ctx: RemoteSyncTxContext = {
        db,
        hlc: clock,
        nowMs,
        getSyncEntry: (collection, recordKey) => this.readSyncEntryRow(db, collection, recordKey),
        upsertSyncEntry: (entry) => this.writeSyncEntryRow(db, entry),
        getPrunedManuscript: (manuscriptId) => {
          const row = db.prepare('SELECT manuscript_id, pruned_at_ms, pruned_version_hlc FROM sync_pruned WHERE manuscript_id = ?').get(manuscriptId);
          if (!row) return undefined;
          return {
            manuscriptId: String(row.manuscript_id),
            prunedAtMs: Number(row.pruned_at_ms),
            prunedVersionHlc: row.pruned_version_hlc === null ? null : String(row.pruned_version_hlc),
          };
        },
        clearPrunedManuscript: (manuscriptId) => {
          db.prepare('DELETE FROM sync_pruned WHERE manuscript_id = ?').run(manuscriptId);
        },
        upsertRemoteManuscript: (item, deleted) => {
          libraryChanged = true;
          if (deleted) {
            db.prepare('DELETE FROM manuscripts WHERE id = ?').run(item.id);
            return;
          }
          db.prepare(`
            INSERT INTO manuscripts (id, date, occurred_at, audio_opus, seconds, application, original, asr_results, text, polished, user_edited, delivery_note, audio_warning, recording_ended_at_ms, screenshot_image)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(id) DO UPDATE SET
              date=excluded.date,
              occurred_at=excluded.occurred_at,
              seconds=excluded.seconds,
              application=excluded.application,
              original=excluded.original,
              asr_results=excluded.asr_results,
              text=excluded.text,
              polished=excluded.polished,
              user_edited=excluded.user_edited,
              delivery_note=excluded.delivery_note,
              audio_warning=excluded.audio_warning,
              recording_ended_at_ms=COALESCE(excluded.recording_ended_at_ms, manuscripts.recording_ended_at_ms)
          `).run(
            item.id,
            item.date,
            manuscriptDate(item.date).toISOString(),
            item.seconds,
            item.application,
            item.original,
            JSON.stringify(item.asrResults || []),
            item.text,
            item.polished ? 1 : 0,
            item.userEdited ? 1 : 0,
            item.deliveryNote ?? null,
            item.audioWarning ?? null,
            item.recordingEndedAtMs ?? null,
          );
        },
        upsertRemoteLexiconTerm: (entry, deleted, matchId) => {
          libraryChanged = true;
          let targetId = matchId ?? entry.id;
          if (deleted) {
            db.prepare('DELETE FROM lexicon WHERE id = ?').run(targetId);
            return targetId;
          }
          let existingRow = db.prepare('SELECT position FROM lexicon WHERE id = ?').get(targetId);
          if (!matchId && existingRow) {
            targetId = randomUUID();
            existingRow = undefined;
          }
          const nextPosition = existingRow
            ? Number(existingRow.position)
            : Number(db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM lexicon').get()!.pos);
          db.prepare(`
            INSERT INTO lexicon (id, term, hint, aliases, position, app_group, match_count, last_matched_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              term=excluded.term,
              hint=excluded.hint,
              aliases=excluded.aliases,
              app_group=excluded.app_group,
              match_count=excluded.match_count,
              last_matched_at=excluded.last_matched_at,
              created_at=excluded.created_at
          `).run(
            targetId,
            entry.term,
            entry.hint,
            JSON.stringify(entry.aliases || []),
            nextPosition,
            entry.group ?? null,
            entry.matchCount ?? 0,
            entry.lastMatchedAt ?? null,
            entry.createdAt ?? null,
          );
          return targetId;
        },
        markHubAcked: (hubInstanceId, collection, recordKey, versionHlc) => {
          db.prepare(`
            INSERT INTO sync_hub_acked (hub_instance_id, collection, record_key, acked_hlc)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(hub_instance_id, collection, record_key) DO UPDATE SET
              acked_hlc = CASE WHEN excluded.acked_hlc > sync_hub_acked.acked_hlc THEN excluded.acked_hlc ELSE sync_hub_acked.acked_hlc END
          `).run(hubInstanceId, collection, recordKey, versionHlc);
        },
        setHubCursor: (hubInstanceId, seq, syncedAtMs) => {
          db.prepare(`
            INSERT INTO sync_hub_cursors (hub_instance_id, last_pulled_seq, last_sync_at_ms)
            VALUES (?, ?, ?)
            ON CONFLICT(hub_instance_id) DO UPDATE SET
              last_pulled_seq = excluded.last_pulled_seq,
              last_sync_at_ms = excluded.last_sync_at_ms
          `).run(hubInstanceId, Math.max(0, Math.floor(seq)), syncedAtMs);
        },
      };

      fn(ctx);
      this.saveHlcState(db, clock);
      db.exec('COMMIT');

      if (libraryChanged) {
        this.readDatabase(this.defaults);
        this.remember();
        this._libraryVersion += 1;
        this._remoteRevision += 1;
        this.onRemoteLibraryChanged?.();
      }
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  gcExpiredTombstones(maxAgeMs = 90 * 86_400 * 1000, nowMs = this.nowSyncMs()): number {
    if (this.error) throw new Error(this.error);
    const db = this.openDatabase();
    const cutoff = nowMs - maxAgeMs;
    db.exec('BEGIN IMMEDIATE');
    try {
      const expired = db.prepare('SELECT collection, record_key FROM sync_entries WHERE deleted = 1 AND deleted_at_ms IS NOT NULL AND deleted_at_ms < ?').all(cutoff);
      const delEntry = db.prepare('DELETE FROM sync_entries WHERE collection = ? AND record_key = ?');
      const delAck = db.prepare('DELETE FROM sync_hub_acked WHERE collection = ? AND record_key = ?');
      for (const row of expired) {
        delEntry.run(row.collection, row.record_key);
        delAck.run(row.collection, row.record_key);
      }
      db.exec('COMMIT');
      return expired.length;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  close() {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      this.db.close(); this.db = undefined;
    }
  }
}
