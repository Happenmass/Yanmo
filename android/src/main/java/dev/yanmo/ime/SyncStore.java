package dev.yanmo.ime;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteStatement;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * SQLite-backed sync state, HLC persistence, pending queue, hub cursors, and atomic remote apply.
 * Shares {@code no_backup/manuscripts.sqlite3} via {@link Manuscripts#database(Context)}.
 */
final class SyncStore {
    static final long TOMBSTONE_RETENTION_MS = 90L * 24L * 60L * 60L * 1000L;
    private static final String KEY_SUBSTANTIVE_DIRTY = "substantive_dirty_count";
    private static final String KEY_SEEDED_VAULT = "local_seeded_vault_id";

    private final Context app;

    SyncStore(Context context) {
        this.app = context.getApplicationContext();
    }

    SQLiteDatabase db() {
        return Manuscripts.database(app);
    }

    synchronized SyncHlc.Clock loadClock(String deviceId, SyncHlc.NowMillis nowFn) {
        SQLiteDatabase db = db();
        long lastMs = 0L;
        int counter = 0;
        String msStr = getState(db, "hlc_last_ms");
        String counterStr = getState(db, "hlc_counter");
        if (msStr != null) {
            try { lastMs = Long.parseLong(msStr); } catch (NumberFormatException ignored) {}
        }
        if (counterStr != null) {
            try { counter = Integer.parseInt(counterStr); } catch (NumberFormatException ignored) {}
        }
        return new SyncHlc.Clock(deviceId, lastMs, counter, nowFn);
    }

    private static void saveClock(SQLiteDatabase db, SyncHlc.Clock clock) {
        setState(db, "hlc_last_ms", Long.toString(clock.lastMs()));
        setState(db, "hlc_counter", Integer.toString(clock.counter()));
    }

    String getState(String key) {
        return getState(db(), key);
    }

    void setState(String key, String value) {
        setState(db(), key, value);
    }

    long getLongState(String key, long fallback) {
        String raw = getState(key);
        if (raw == null || raw.isEmpty()) return fallback;
        try {
            return Long.parseLong(raw);
        } catch (NumberFormatException ignored) {
            return fallback;
        }
    }

    void setLongState(String key, long value) {
        setState(key, Long.toString(value));
    }

    int getSubstantiveDirtyCount() {
        long val = getLongState(KEY_SUBSTANTIVE_DIRTY, 0L);
        return (int) Math.max(0L, Math.min(Integer.MAX_VALUE, val));
    }

    void resetSubstantiveDirtyCount() {
        setState(KEY_SUBSTANTIVE_DIRTY, "0");
    }

    boolean isSeededForVault(String vaultId) {
        if (vaultId == null || vaultId.isEmpty()) return false;
        return vaultId.equals(getState(KEY_SEEDED_VAULT));
    }

    private static void incrementSubstantiveDirty(SQLiteDatabase db, int delta) {
        if (delta <= 0) return;
        int cur = 0;
        String raw = getState(db, KEY_SUBSTANTIVE_DIRTY);
        if (raw != null && !raw.isEmpty()) {
            try {
                cur = Math.max(0, Integer.parseInt(raw));
            } catch (NumberFormatException ignored) {
            }
        }
        setState(db, KEY_SUBSTANTIVE_DIRTY, Integer.toString(cur + delta));
    }

    private static String getState(SQLiteDatabase db, String key) {
        try (Cursor c = db.rawQuery("SELECT value FROM sync_state WHERE key = ?", new String[] { key })) {
            return c.moveToFirst() ? c.getString(0) : null;
        }
    }

    private static void setState(SQLiteDatabase db, String key, String value) {
        if (value == null) {
            db.delete("sync_state", "key = ?", new String[] { key });
            return;
        }
        ContentValues cv = new ContentValues();
        cv.put("key", key);
        cv.put("value", value);
        db.insertWithOnConflict("sync_state", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    SyncModels.SyncHubCursorRow getHubCursor(String hubId) {
        try (Cursor c = db().rawQuery(
                "SELECT last_pulled_seq, last_sync_at_ms FROM sync_hub_cursors WHERE hub_instance_id = ?",
                new String[] { hubId })) {
            if (c.moveToFirst()) {
                Long ts = c.isNull(1) ? null : c.getLong(1);
                return new SyncModels.SyncHubCursorRow(hubId, c.getLong(0), ts);
            }
        }
        return new SyncModels.SyncHubCursorRow(hubId, 0L, null);
    }

    void setHubCursor(String hubId, long seq, long syncedAtMs) {
        setHubCursor(db(), hubId, seq, syncedAtMs);
    }

    private static void setHubCursor(SQLiteDatabase db, String hubId, long seq, long syncedAtMs) {
        ContentValues cv = new ContentValues();
        cv.put("hub_instance_id", hubId);
        cv.put("last_pulled_seq", seq);
        cv.put("last_sync_at_ms", syncedAtMs);
        db.insertWithOnConflict("sync_hub_cursors", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    SyncModels.SyncEntryRow getSyncEntry(String collection, String recordKey) {
        return getSyncEntry(db(), collection, recordKey);
    }

    private static SyncModels.SyncEntryRow getSyncEntry(SQLiteDatabase db, String collection, String recordKey) {
        try (Cursor c = db.rawQuery(
                "SELECT local_id, version_hlc, origin_device_id, deleted, deleted_at_ms, updated_at_ms, meta_json "
                        + "FROM sync_entries WHERE collection = ? AND record_key = ?",
                new String[] { collection, recordKey })) {
            if (!c.moveToFirst()) return null;
            return rowFromCursor(collection, recordKey, c, 0);
        }
    }

    private static SyncModels.SyncEntryRow rowFromCursor(String collection, String recordKey, Cursor c, int startCol) {
        String localId = c.isNull(startCol) ? null : c.getString(startCol);
        String versionHlc = c.getString(startCol + 1);
        String originDeviceId = c.getString(startCol + 2);
        boolean deleted = c.getInt(startCol + 3) != 0;
        Long deletedAtMs = c.isNull(startCol + 4) ? null : c.getLong(startCol + 4);
        long updatedAtMs = c.getLong(startCol + 5);
        String metaStr = c.isNull(startCol + 6) ? "{}" : c.getString(startCol + 6);
        JSONObject meta;
        try {
            meta = new JSONObject(metaStr);
        } catch (JSONException e) {
            meta = new JSONObject();
        }
        return new SyncModels.SyncEntryRow(collection, recordKey, localId, versionHlc, originDeviceId,
                deleted, deletedAtMs, updatedAtMs, meta);
    }

    private static void upsertSyncEntry(SQLiteDatabase db, SyncModels.SyncEntryRow row) {
        ContentValues cv = new ContentValues();
        cv.put("collection", row.collection);
        cv.put("record_key", row.recordKey);
        if (row.localId != null) cv.put("local_id", row.localId);
        else cv.putNull("local_id");
        cv.put("version_hlc", row.versionHlc);
        cv.put("origin_device_id", row.originDeviceId);
        cv.put("deleted", row.deleted ? 1 : 0);
        if (row.deletedAtMs != null) cv.put("deleted_at_ms", row.deletedAtMs);
        else cv.putNull("deleted_at_ms");
        cv.put("updated_at_ms", row.updatedAtMs);
        cv.put("meta_json", row.meta.toString());
        db.insertWithOnConflict("sync_entries", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    void updateManuscriptBlobRefs(String manuscriptId, SyncModels.BlobRef audioBlob, SyncModels.BlobRef screenshotBlob) {
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            SyncModels.SyncEntryRow entry = getSyncEntry(db, SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
            if (entry != null) {
                JSONObject meta = new JSONObject(entry.meta.toString());
                if (audioBlob != null) meta.put("audioBlob", audioBlob.toJson());
                if (screenshotBlob != null) meta.put("screenshotBlob", screenshotBlob.toJson());
                upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                        entry.collection, entry.recordKey, entry.localId, entry.versionHlc, entry.originDeviceId,
                        entry.deleted, entry.deletedAtMs, entry.updatedAtMs, meta
                ));
            }
            db.setTransactionSuccessful();
        } catch (JSONException ignored) {
        } finally {
            db.endTransaction();
        }
    }

    List<SyncModels.SyncEntryRow> getPendingSyncEntries(String hubId, int limit) {
        List<SyncModels.SyncEntryRow> out = new ArrayList<>();
        try (Cursor c = db().rawQuery(
                "SELECT s.collection, s.record_key, s.local_id, s.version_hlc, s.origin_device_id, "
                        + "s.deleted, s.deleted_at_ms, s.updated_at_ms, s.meta_json "
                        + "FROM sync_entries s "
                        + "LEFT JOIN sync_hub_acked a "
                        + "  ON a.hub_instance_id = ? AND a.collection = s.collection AND a.record_key = s.record_key "
                        + "WHERE a.acked_version_hlc IS NULL OR a.acked_version_hlc < s.version_hlc "
                        + "ORDER BY s.updated_at_ms ASC, s.collection ASC, s.record_key ASC "
                        + "LIMIT ?",
                new String[] { hubId, Integer.toString(limit) })) {
            while (c.moveToNext()) {
                out.add(rowFromCursor(c.getString(0), c.getString(1), c, 2));
            }
        }
        return out;
    }

    int countPendingEntriesForFirstHub(List<SyncModels.KnownHub> hubs) {
        if (hubs == null || hubs.isEmpty()) return 0;
        String hubId = hubs.get(0).hubInstanceId;
        try (SQLiteStatement st = db().compileStatement(
                "SELECT COUNT(*) FROM sync_entries s "
                        + "LEFT JOIN sync_hub_acked a "
                        + "  ON a.hub_instance_id = ? AND a.collection = s.collection AND a.record_key = s.record_key "
                        + "WHERE a.acked_version_hlc IS NULL OR a.acked_version_hlc < s.version_hlc")) {
            st.bindString(1, hubId);
            return (int) st.simpleQueryForLong();
        }
    }

    void markHubAcked(String hubId, List<SyncModels.SyncChangeItem> items) {
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            for (SyncModels.SyncChangeItem item : items) {
                markHubAcked(db, hubId, item.collection, item.recordKey, item.versionHlc);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static void markHubAcked(SQLiteDatabase db, String hubId, String collection,
                                     String recordKey, String versionHlc) {
        ContentValues cv = new ContentValues();
        cv.put("hub_instance_id", hubId);
        cv.put("collection", collection);
        cv.put("record_key", recordKey);
        cv.put("acked_version_hlc", versionHlc);
        db.insertWithOnConflict("sync_hub_acked", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private static SyncModels.SyncPrunedRow getPrunedManuscript(SQLiteDatabase db, String manuscriptId) {
        try (Cursor c = db.rawQuery(
                "SELECT pruned_at_ms, pruned_version_hlc FROM sync_pruned WHERE manuscript_id = ?",
                new String[] { manuscriptId })) {
            if (!c.moveToFirst()) return null;
            return new SyncModels.SyncPrunedRow(manuscriptId, c.getLong(0), c.isNull(1) ? null : c.getString(1));
        }
    }

    synchronized void ensureSeededFromLocal(String vaultId, String deviceId, byte[] keyMacKey, boolean force) throws Exception {
        if (!force && isSeededForVault(vaultId)) return;
        List<Lexicon.Entry> lexicon = Lexicon.list(app);
        List<SyncModels.ManuscriptRecord> manuscripts = Manuscripts.listFinishedRecords(app);
        Set<String> activeIds = Manuscripts.activeIds();
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            String storedVault = getState(db, "vault_id");
            if (storedVault != null && !storedVault.isEmpty() && !storedVault.equals(vaultId)) {
                db.delete("sync_entries", null, null);
                db.delete("sync_hub_cursors", null, null);
                db.delete("sync_hub_acked", null, null);
                db.delete("sync_pruned", null, null);
                db.delete("sync_state", "key IN (?,?,?,?,?,?,?,?)", new String[] {
                        "hlc_last_ms", "hlc_counter", KEY_SUBSTANTIVE_DIRTY,
                        "last_full_sync_at_ms", "last_sync_at_ms", "last_sync_summary",
                        "last_sync_error", "last_gc_at_ms"
                });
            }
            setState(db, "vault_id", vaultId);

            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            long now = System.currentTimeMillis();
            boolean ticked = false;

            for (Lexicon.Entry entry : lexicon) {
                if (SyncCrypto.normalizeTermKey(entry.term).isEmpty()) continue;
                String rk = SyncCrypto.computeLexiconRecordKey(keyMacKey, entry.term, entry.group);
                if (getSyncEntry(db, SyncModels.COLLECTION_LEXICON, rk) == null) {
                    String hlc = clock.tick();
                    ticked = true;
                    JSONObject meta = new JSONObject();
                    meta.put("intentHlc", hlc);
                    JSONObject counts = new JSONObject();
                    if (entry.matchCount > 0) counts.put(deviceId, entry.matchCount);
                    meta.put("deviceCounts", counts);
                    meta.put("removedAliases", new JSONArray());
                    upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                            SyncModels.COLLECTION_LEXICON, rk, entry.id, hlc, deviceId,
                            false, null, entry.createdAt > 0 ? entry.createdAt : now, meta
                    ));
                }
            }

            for (SyncModels.ManuscriptRecord m : manuscripts) {
                if (activeIds.contains(m.id)) continue;
                if (m.original.isEmpty() && m.polishedText.isEmpty()) continue;
                if (getSyncEntry(db, SyncModels.COLLECTION_MANUSCRIPT, m.id) == null) {
                    String hlc = clock.tick();
                    ticked = true;
                    JSONObject meta = new JSONObject();
                    meta.put("sourceDeviceId", m.sourceDeviceId != null ? m.sourceDeviceId : deviceId);
                    upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                            SyncModels.COLLECTION_MANUSCRIPT, m.id, m.id, hlc, deviceId,
                            false, null, m.createdAtMs > 0 ? m.createdAtMs : now, meta
                    ));
                }
            }

            if (ticked) saveClock(db, clock);
            setState(db, KEY_SEEDED_VAULT, vaultId);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    synchronized void recordLocalManuscriptFinished(String deviceId, String manuscriptId) {
        SyncModels.ManuscriptRecord record = Manuscripts.readRecord(app, manuscriptId);
        if (record == null) return;
        if (record.original.isEmpty() && record.polishedText.isEmpty()) return;
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            String hlc = clock.tick();
            saveClock(db, clock);
            SyncModels.SyncEntryRow prev = getSyncEntry(db, SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
            JSONObject meta = prev != null ? new JSONObject(prev.meta.toString()) : new JSONObject();
            if (!meta.has("sourceDeviceId")) meta.put("sourceDeviceId", deviceId);
            upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_MANUSCRIPT, manuscriptId, manuscriptId, hlc, deviceId,
                    false, null, System.currentTimeMillis(), meta
            ));
            incrementSubstantiveDirty(db, 1);
            db.setTransactionSuccessful();
        } catch (JSONException ignored) {
        } finally {
            db.endTransaction();
        }
    }

    synchronized void recordLocalManuscriptDeleted(String deviceId, String manuscriptId) {
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            SyncModels.SyncEntryRow prev = getSyncEntry(db, SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            String hlc = clock.tick();
            saveClock(db, clock);
            long now = System.currentTimeMillis();
            JSONObject meta = new JSONObject();
            if (prev != null && prev.meta.has("unknownFields")) {
                meta.put("unknownFields", prev.meta.get("unknownFields"));
            }
            upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_MANUSCRIPT, manuscriptId, null, hlc, deviceId,
                    true, now, now, meta
            ));
            incrementSubstantiveDirty(db, 1);
            db.setTransactionSuccessful();
        } catch (JSONException ignored) {
        } finally {
            db.endTransaction();
        }
    }

    synchronized void recordLocalLexiconUpsert(String deviceId, byte[] keyMacKey,
                                               Lexicon.Entry prevEntry, Lexicon.Entry nextEntry) {
        if (nextEntry == null || SyncCrypto.normalizeTermKey(nextEntry.term).isEmpty()) return;
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            long now = System.currentTimeMillis();
            String nextRk = SyncCrypto.computeLexiconRecordKey(keyMacKey, nextEntry.term, nextEntry.group);
            if (prevEntry != null && !SyncCrypto.normalizeTermKey(prevEntry.term).isEmpty()) {
                String prevRk = SyncCrypto.computeLexiconRecordKey(keyMacKey, prevEntry.term, prevEntry.group);
                if (!prevRk.equals(nextRk)) {
                    SyncModels.SyncEntryRow oldSync = getSyncEntry(db, SyncModels.COLLECTION_LEXICON, prevRk);
                    if (oldSync == null || !oldSync.deleted) {
                        String tombHlc = clock.tick();
                        JSONObject tombMeta = new JSONObject();
                        if (oldSync != null && oldSync.meta.has("unknownFields")) {
                            tombMeta.put("unknownFields", oldSync.meta.get("unknownFields"));
                        }
                        upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                                SyncModels.COLLECTION_LEXICON, prevRk, null, tombHlc, deviceId,
                                true, now, now, tombMeta
                        ));
                    }
                }
            }
            SyncModels.SyncEntryRow existing = getSyncEntry(db, SyncModels.COLLECTION_LEXICON, nextRk);
            String hlc = clock.tick();
            JSONObject meta = existing != null ? new JSONObject(existing.meta.toString()) : new JSONObject();
            meta.put("intentHlc", hlc);
            JSONObject counts = meta.optJSONObject("deviceCounts");
            if (counts == null) counts = new JSONObject();
            if (counts.length() == 0 && nextEntry.matchCount > 0) {
                counts.put(deviceId, nextEntry.matchCount);
            }
            meta.put("deviceCounts", counts);
            if (!meta.has("removedAliases")) meta.put("removedAliases", new JSONArray());

            upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_LEXICON, nextRk, nextEntry.id, hlc, deviceId,
                    false, null, now, meta
            ));
            incrementSubstantiveDirty(db, 1);
            saveClock(db, clock);
            db.setTransactionSuccessful();
        } catch (Exception ignored) {
        } finally {
            db.endTransaction();
        }
    }

    synchronized void recordLocalLexiconDeleted(String deviceId, byte[] keyMacKey, Lexicon.Entry removedEntry) {
        if (removedEntry == null || SyncCrypto.normalizeTermKey(removedEntry.term).isEmpty()) return;
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            String rk = SyncCrypto.computeLexiconRecordKey(keyMacKey, removedEntry.term, removedEntry.group);
            SyncModels.SyncEntryRow prev = getSyncEntry(db, SyncModels.COLLECTION_LEXICON, rk);
            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            String hlc = clock.tick();
            saveClock(db, clock);
            long now = System.currentTimeMillis();
            JSONObject meta = new JSONObject();
            if (prev != null && prev.meta.has("unknownFields")) {
                meta.put("unknownFields", prev.meta.get("unknownFields"));
            }
            upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_LEXICON, rk, null, hlc, deviceId,
                    true, now, now, meta
            ));
            incrementSubstantiveDirty(db, 1);
            db.setTransactionSuccessful();
        } catch (Exception ignored) {
        } finally {
            db.endTransaction();
        }
    }

    synchronized void recordLocalLexiconMatches(String deviceId, byte[] keyMacKey, List<Lexicon.Entry> updatedEntries) {
        if (updatedEntries == null || updatedEntries.isEmpty()) return;
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            SyncHlc.Clock clock = loadClock(deviceId, System::currentTimeMillis);
            long now = System.currentTimeMillis();
            boolean changed = false;
            for (Lexicon.Entry entry : updatedEntries) {
                if (SyncCrypto.normalizeTermKey(entry.term).isEmpty()) continue;
                String rk = SyncCrypto.computeLexiconRecordKey(keyMacKey, entry.term, entry.group);
                SyncModels.SyncEntryRow prev = getSyncEntry(db, SyncModels.COLLECTION_LEXICON, rk);
                String hlc = clock.tick();
                changed = true;
                JSONObject meta = prev != null ? new JSONObject(prev.meta.toString()) : new JSONObject();
                if (!meta.has("intentHlc")) {
                    meta.put("intentHlc", prev != null ? prev.versionHlc : hlc);
                }
                JSONObject counts = meta.optJSONObject("deviceCounts");
                if (counts == null) counts = new JSONObject();
                counts.put(deviceId, counts.optLong(deviceId, 0L) + 1L);
                meta.put("deviceCounts", counts);
                if (!meta.has("removedAliases")) meta.put("removedAliases", new JSONArray());
                upsertSyncEntry(db, new SyncModels.SyncEntryRow(
                        SyncModels.COLLECTION_LEXICON, rk, entry.id, hlc, deviceId,
                        false, null, now, meta
                ));
            }
            if (changed) saveClock(db, clock);
            db.setTransactionSuccessful();
        } catch (Exception ignored) {
        } finally {
            db.endTransaction();
        }
    }

    interface RemoteApplyResult {
        int appliedLocal();
    }

    synchronized int applyRemotePullBatch(
            String hubId,
            String deviceId,
            byte[] keyMacKey,
            List<DecryptedChange> validChanges,
            long batchLastSeq,
            long nowMs
    ) throws Exception {
        SQLiteDatabase db = db();
        List<Lexicon.Entry> currentLexicon = Lexicon.list(app);
        List<Lexicon.Entry> mutableLexicon = new ArrayList<>(currentLexicon);
        boolean lexiconDirty = false;
        int appliedLocal = 0;

        boolean committed = false;
        db.beginTransactionNonExclusive();
        try {
            SyncHlc.Clock clock = loadClock(deviceId, () -> nowMs);
            for (DecryptedChange dc : validChanges) {
                try {
                    clock.receive(dc.change.versionHlc);
                    long updatedAtMs = dc.change.updatedAtMs != null ? dc.change.updatedAtMs : nowMs;
                    if (SyncModels.COLLECTION_LEXICON.equals(dc.change.collection)) {
                        SyncModels.SyncEntryRow existingSync = getSyncEntry(db, SyncModels.COLLECTION_LEXICON, dc.change.recordKey);
                        Lexicon.Entry existingTerm = findLexiconEntry(mutableLexicon, keyMacKey,
                                existingSync != null ? existingSync.localId : null, dc.change.recordKey);
                        SyncModels.LexiconRecord localRec = existingTerm == null ? null : toLexiconRecord(existingTerm);

                        SyncMerge.LexiconOutcome outcome = SyncMerge.mergeLexiconState(
                                localRec, existingSync, dc.change.recordKey, dc.payload,
                                dc.change.versionHlc, dc.change.originDeviceId, dc.change.deleted,
                                updatedAtMs, deviceId, clock::tick
                        );
                        if (outcome.changed) {
                            appliedLocal += 1;
                            lexiconDirty = true;
                            if (outcome.deleted) {
                                if (existingTerm != null) {
                                    mutableLexicon.removeIf(e -> e.id.equals(existingTerm.id));
                                }
                            } else if (outcome.entry != null) {
                                final SyncModels.LexiconRecord mergedEntry = outcome.entry;
                                final String targetId = existingTerm != null ? existingTerm.id : mergedEntry.id;
                                final String mergedKey = SyncCrypto.normalizeTermKey(mergedEntry.term);
                                mutableLexicon.removeIf(e -> e.id.equals(targetId)
                                        || SyncCrypto.normalizeTermKey(e.term).equals(mergedKey));
                                mutableLexicon.add(new Lexicon.Entry(
                                        targetId, mergedEntry.term, mergedEntry.hint, mergedEntry.aliases,
                                        mergedEntry.group, mergedEntry.matchCount,
                                        mergedEntry.lastMatchedAtMs, mergedEntry.createdAtMs
                                ));
                                outcome = new SyncMerge.LexiconOutcome(
                                        outcome.changed, outcome.deleted, mergedEntry,
                                        new SyncModels.SyncEntryRow(
                                                outcome.syncEntry.collection, outcome.syncEntry.recordKey, targetId,
                                                outcome.syncEntry.versionHlc, outcome.syncEntry.originDeviceId,
                                                outcome.syncEntry.deleted, outcome.syncEntry.deletedAtMs,
                                                outcome.syncEntry.updatedAtMs, outcome.syncEntry.meta
                                        ),
                                        outcome.fromRemoteExact
                                );
                            }
                        }
                        if (outcome.changed || existingSync == null || outcome.fromRemoteExact) {
                            upsertSyncEntry(db, outcome.syncEntry);
                        }
                        if (outcome.fromRemoteExact
                                || SyncHlc.compareHlc(outcome.syncEntry.versionHlc, dc.change.versionHlc) <= 0) {
                            markHubAcked(db, hubId, SyncModels.COLLECTION_LEXICON, dc.change.recordKey, dc.change.versionHlc);
                        }
                    } else if (SyncModels.COLLECTION_MANUSCRIPT.equals(dc.change.collection)) {
                        SyncModels.SyncEntryRow existingSync = getSyncEntry(db, SyncModels.COLLECTION_MANUSCRIPT, dc.change.recordKey);
                        SyncModels.SyncPrunedRow prunedInfo = getPrunedManuscript(db, dc.change.recordKey);
                        SyncMerge.ManuscriptOutcome outcome = SyncMerge.mergeManuscriptState(
                                existingSync, dc.change.recordKey, dc.payload,
                                dc.change.versionHlc, dc.change.originDeviceId, dc.change.deleted,
                                updatedAtMs, prunedInfo
                        );
                        if (outcome.applied && outcome.syncEntry != null) {
                            appliedLocal += 1;
                            if (outcome.clearPruned) {
                                db.delete("sync_pruned", "manuscript_id = ?", new String[] { dc.change.recordKey });
                            }
                            if (outcome.manuscript != null) {
                                if (outcome.deleted) {
                                    db.delete("manuscript", "id = ?", new String[] { dc.change.recordKey });
                                } else {
                                    Manuscripts.upsertFromSync(db, outcome.manuscript);
                                }
                            }
                            upsertSyncEntry(db, outcome.syncEntry);
                            markHubAcked(db, hubId, SyncModels.COLLECTION_MANUSCRIPT,
                                    dc.change.recordKey, outcome.syncEntry.versionHlc);
                        } else if (existingSync == null && prunedInfo != null) {
                            markHubAcked(db, hubId, SyncModels.COLLECTION_MANUSCRIPT, dc.change.recordKey, dc.change.versionHlc);
                        } else if (existingSync != null
                                && SyncHlc.compareHlc(existingSync.versionHlc, dc.change.versionHlc) >= 0) {
                            markHubAcked(db, hubId, SyncModels.COLLECTION_MANUSCRIPT, dc.change.recordKey, dc.change.versionHlc);
                        }
                    }
                } catch (Exception ignored) {
                    // Quarantine individual malformed records without stalling cursor.
                }
            }
            saveClock(db, clock);
            setHubCursor(db, hubId, batchLastSeq, nowMs);
            db.setTransactionSuccessful();
            committed = true;
        } finally {
            db.endTransaction();
        }
        if (lexiconDirty && committed) {
            Lexicon.replaceAllFromSync(app, mutableLexicon);
        }
        return appliedLocal;
    }

    int gcExpiredTombstones() {
        long cutoff = System.currentTimeMillis() - TOMBSTONE_RETENTION_MS;
        SQLiteDatabase db = db();
        db.beginTransactionNonExclusive();
        try {
            db.execSQL(
                    "DELETE FROM sync_hub_acked WHERE EXISTS ("
                            + "SELECT 1 FROM sync_entries s WHERE s.collection = sync_hub_acked.collection "
                            + "AND s.record_key = sync_hub_acked.record_key AND s.deleted = 1 "
                            + "AND COALESCE(s.deleted_at_ms, s.updated_at_ms) < ?)",
                    new Object[] { cutoff });
            int deleted = db.delete(
                    "sync_entries",
                    "deleted = 1 AND COALESCE(deleted_at_ms, updated_at_ms) < ?",
                    new String[] { Long.toString(cutoff) });
            db.setTransactionSuccessful();
            return deleted;
        } finally {
            db.endTransaction();
        }
    }

    private static Lexicon.Entry findLexiconEntry(List<Lexicon.Entry> entries, byte[] keyMacKey,
                                                String localId, String recordKey) throws Exception {
        if (localId != null) {
            for (Lexicon.Entry e : entries) {
                if (localId.equals(e.id)) return e;
            }
        }
        for (Lexicon.Entry e : entries) {
            if (!SyncCrypto.normalizeTermKey(e.term).isEmpty()
                    && recordKey.equals(SyncCrypto.computeLexiconRecordKey(keyMacKey, e.term, e.group))) {
                return e;
            }
        }
        return null;
    }

    static SyncModels.LexiconRecord toLexiconRecord(Lexicon.Entry entry) {
        return new SyncModels.LexiconRecord(
                entry.id, entry.term, entry.hint, entry.aliases, entry.group,
                entry.matchCount, entry.lastMatchedAt, entry.createdAt
        );
    }

    static final class DecryptedChange {
        final SyncModels.SyncChangeItem change;
        final JSONObject payload;

        DecryptedChange(SyncModels.SyncChangeItem change, JSONObject payload) {
            this.change = change;
            this.payload = payload;
        }
    }
}
