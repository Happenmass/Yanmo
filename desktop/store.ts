import { mkdirSync, readFileSync, existsSync, renameSync, copyFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DailyUsage, Library, LLMPurpose, Manuscript, Settings, TermGroup, cocoaNow, isTermGroup, localDayDate, manuscriptDate, shiftLocalDay, validateSettings } from './shared';

const SCHEMA_VERSION = 3;
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

export function parseLibrary(value: unknown): Library {
  const library = value as Library;
  if (!library || !Array.isArray(library.manuscripts) || !Array.isArray(library.lexicon)) throw new Error('文稿库格式无效。');
  const ids = new Set<string>();
  for (const item of library.manuscripts) {
    if (typeof item.id !== 'string' || ids.has(item.id) || !Number.isFinite(item.date) || !Number.isFinite(item.seconds) || item.seconds < 0 || typeof item.text !== 'string' || typeof item.original !== 'string' || typeof item.application !== 'string' || typeof item.polished !== 'boolean' || (item.hasAudio !== undefined && typeof item.hasAudio !== 'boolean') || (item.audioWarning !== undefined && typeof item.audioWarning !== 'string')) throw new Error('文稿库中存在无效内容。');
    ids.add(item.id);
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

export interface ManuscriptAudio { id: string; data: Uint8Array }
export interface AppInputEvent {
  eventId: string; occurredAtMs: number; appKey: string; appName: string; characters: number; confirmed: boolean;
}

export class LibraryStore {
  readonly dbPath: string;
  error = '';
  library: Library = { manuscripts: [], lexicon: [] };
  settings: Settings;
  private db?: DatabaseSync;
  private savedManuscripts = new Map<string, string>();
  private savedLexicon = new Map<string, string>();
  private savedSettings = '';
  private audioIds = new Set<string>();

  constructor(readonly directory: string, defaults: Settings, legacyLibrary?: string) {
    this.dbPath = join(directory, 'yanmo.db');
    this.settings = structuredClone(defaults);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const db = this.openDatabase();
      const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
      const populated = Number(db.prepare('SELECT (SELECT count(*) FROM settings) + (SELECT count(*) FROM manuscripts) + (SELECT count(*) FROM lexicon) AS n').get()!.n) > 0;
      // A populated v0 database came from the unreleased SQLite prototype. It is
      // already authoritative: stale JSON must never overwrite committed rows.
      if (version > 0 || populated) this.readDatabase(defaults);
      else this.readLegacy(defaults, legacyLibrary);
      if (version === 0) this.writeDatabase(undefined, true);
      else {
        if (version < SCHEMA_VERSION) {
          db.exec('BEGIN IMMEDIATE');
          try {
            this.initializeStatistics(db);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
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

  private readLegacy(defaults: Settings, legacyLibrary?: string) {
    const settingsPath = join(this.directory, 'settings.json');
    const libraryPath = join(this.directory, 'library.json');
    if (existsSync(settingsPath)) {
      const { llmModel: _old, ...saved } = JSON.parse(readFileSync(settingsPath, 'utf8'));
      this.settings = { ...defaults, ...saved };
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

  private readDatabase(defaults: Settings) {
    const db = this.openDatabase();
    const saved: Record<string, unknown> = {};
    for (const row of db.prepare('SELECT key, value FROM settings WHERE key != ?').all(STATISTICS_START)) saved[String(row.key)] = JSON.parse(String(row.value));
    const { llmModel: _old, ...settings } = saved;
    this.settings = { ...defaults, ...settings } as Settings;
    validateSettings(this.settings);
    const rows = db.prepare('SELECT id, date, length(audio_opus) > 0 AS has_audio, seconds, application, original, asr_results, text, polished, user_edited, delivery_note, audio_warning FROM manuscripts ORDER BY date DESC').all();
    this.library = parseLibrary({
      manuscripts: rows.map(row => ({
        id: row.id, date: row.date, original: row.original, text: row.text,
        seconds: row.seconds, application: row.application, polished: row.polished === 1,
        asrResults: JSON.parse(String(row.asr_results)),
        ...(row.user_edited === 1 ? { userEdited: true } : {}),
        ...(row.delivery_note ? { deliveryNote: row.delivery_note } : {}),
        ...(row.audio_warning ? { audioWarning: row.audio_warning } : {}),
        ...(row.has_audio ? { hasAudio: true } : {}),
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

  private remember() {
    this.savedManuscripts = new Map(this.library.manuscripts.map(item => [item.id, this.serialized(item)]));
    this.savedLexicon = new Map(this.library.lexicon.map((entry, index) => [entry.id, JSON.stringify([index, entry])]));
    this.savedSettings = JSON.stringify(this.settings);
  }

  private writeDatabase(audio?: ManuscriptAudio, initialize = false) {
    const db = this.openDatabase();
    if (audio && (!audio.data.byteLength || !this.library.manuscripts.some(item => item.id === audio.id))) throw new Error('录音没有对应的文稿。');
    db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = db.prepare(`
        INSERT INTO manuscripts (id, date, occurred_at, audio_opus, seconds, application, original, asr_results, text, polished, user_edited, delivery_note, audio_warning)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          date=excluded.date, occurred_at=excluded.occurred_at,
          audio_opus=COALESCE(excluded.audio_opus, manuscripts.audio_opus),
          seconds=excluded.seconds, application=excluded.application, original=excluded.original,
          asr_results=excluded.asr_results, text=excluded.text, polished=excluded.polished,
          user_edited=excluded.user_edited, delivery_note=excluded.delivery_note, audio_warning=excluded.audio_warning
      `);
      const ids = new Set<string>();
      for (const item of this.library.manuscripts) {
        ids.add(item.id);
        if (this.savedManuscripts.get(item.id) === this.serialized(item) && audio?.id !== item.id) continue;
        upsert.run(item.id, item.date, manuscriptDate(item.date).toISOString(), audio?.id === item.id ? Buffer.from(audio.data) : null,
          item.seconds, item.application, item.original, JSON.stringify(item.asrResults || []), item.text,
          item.polished ? 1 : 0, item.userEdited ? 1 : 0, item.deliveryNote ?? null, item.audioWarning ?? null);
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
      if (initialize) this.initializeStatistics(db);
      db.exec('COMMIT');
      this.audioIds = new Set([...this.audioIds].filter(id => ids.has(id)));
      if (audio) this.audioIds.add(audio.id);
      for (const item of this.library.manuscripts) {
        if (this.audioIds.has(item.id)) item.hasAudio = true;
        else delete item.hasAudio;
      }
      this.remember();
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  /** Metadata, optional audio, pruning and preferences commit as one unit. */
  persist(audio?: ManuscriptAudio) {
    if (this.error) throw new Error(this.error);
    parseLibrary(this.library); validateSettings(this.settings);
    this.writeDatabase(audio);
  }

  private initializeStatistics(db: DatabaseSync) {
    db.exec(STATISTICS_SQL);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(STATISTICS_START, String(Date.now()));
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

  prune() {
    if (this.settings.retention) this.library.manuscripts = this.library.manuscripts.filter(item => item.date >= cocoaNow() - this.settings.retention * 86400);
  }

  close() {
    if (this.db) {
      try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
      this.db.close(); this.db = undefined;
    }
  }
}
