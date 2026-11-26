package dev.yanmo.ime;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;
import android.media.MediaDataSource;
import android.os.Build;
import android.util.AtomicFile;

import org.json.JSONArray;
import org.json.JSONException;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

final class Manuscripts {
    private static final int DB_VERSION = 2;
    private static final Set<String> ACTIVE = new HashSet<>();
    private static final Object LEGACY_LOCK = new Object();
    private static final int CHUNK_BYTES = 256 * 1024;
    private static final String[] LEGACY_TEXT = {"raw", "polished", "error", "capture-status"};
    private static volatile Store store;
    private static volatile SyncHook syncHook;

    interface SyncHook {
        void onFinished(String id);
        void onDeleted(String id);
    }

    static void setSyncHook(SyncHook hook) {
        syncHook = hook;
    }

    private Manuscripts() {}

    static synchronized String begin(Context context) {
        long now = System.currentTimeMillis();
        String id = now + "-" + UUID.randomUUID();
        ContentValues initial = new ContentValues();
        initial.put("id", id);
        initial.put("created_at_ms", now);
        database(context).insertOrThrow("manuscript", null, initial);
        ACTIVE.add(id);
        return id;
    }

    static void setMetadata(Context context, String id, String application, double seconds) {
        try {
            ContentValues values = new ContentValues();
            values.put("application", application == null ? "" : application);
            values.put("seconds", Math.max(0.0, seconds));
            database(context).update("manuscript", values, "id = ?", new String[] { id });
        } catch (SQLiteException ignored) {
        }
    }

    static synchronized void end(Context context, String id) {
        ACTIVE.remove(id);
        SyncHook hook = syncHook;
        if (hook != null) hook.onFinished(id);
    }

    static synchronized boolean active(String id) {
        return ACTIVE.contains(id);
    }

    static synchronized Set<String> activeIds() {
        return new HashSet<>(ACTIVE);
    }

    static synchronized void discard(Context context, String id) throws IOException {
        try {
            database(context).delete("manuscript", "id = ?", new String[] { id });
            ACTIVE.remove(id);
        } catch (SQLiteException failure) {
            throw new IOException("无法删除文稿。", failure);
        }
    }

    static synchronized void delete(Context context, String id) throws IOException {
        if (active(id)) throw new IOException("这篇文稿正在处理中，请稍后重试。");
        discard(context, id);
        SyncHook hook = syncHook;
        if (hook != null) hook.onDeleted(id);
    }

    static void capture(Context context, String id) {
        ScreenCapture.capture(context, id);
    }

    static void captureStatus(Context context, String id, String status) {
        try {
            setText(context, id, "capture_status", status);
        } catch (SQLiteException ignored) {
            // Capture status is optional and independent of the voice input.
        }
    }

    static void raw(Context context, String id, String text) {
        setText(context, id, "raw", text);
    }

    static void polished(Context context, String id, String text) {
        setText(context, id, "polished", text);
    }

    static void fail(Context context, String id, String error) {
        setText(context, id, "error", error);
    }

    private static void setText(Context context, String id, String column, String value) {
        ContentValues values = new ContentValues();
        values.put(column, value);
        database(context).update("manuscript", values, "id = ?", new String[] { id });
    }

    static String[] history(Context context) {
        ArrayList<String> ids = new ArrayList<>();
        try (Cursor rows = database(context).rawQuery("SELECT id FROM manuscript ORDER BY id DESC", null)) {
            while (rows.moveToNext()) ids.add(rows.getString(0));
        }
        return ids.toArray(new String[0]);
    }

    static final class Summary {
        final String id;
        final String preview;
        final long createdAtMs;

        Summary(String id, String preview, long createdAtMs) {
            this.id = id;
            this.preview = preview;
            this.createdAtMs = createdAtMs;
        }
    }

    static ArrayList<Summary> summaries(Context context) {
        ArrayList<Summary> result = new ArrayList<>();
        try (Cursor rows = database(context).rawQuery(
                "SELECT id, substr(coalesce(nullif(polished, ''), nullif(raw, ''), nullif(error, ''),"
                    + " CASE WHEN EXISTS(SELECT 1 FROM attachment WHERE attachment.id = manuscript.id"
                    + " AND kind = 'audio' AND (part > 0 OR length(data) > 44)) THEN '录音' ELSE '录音未完成' END),"
                    + " 1, 300), created_at_ms FROM manuscript ORDER BY created_at_ms DESC, id DESC", null)) {
            while (rows.moveToNext()) {
                long ms = rows.isNull(2) ? 0L : rows.getLong(2);
                String id = rows.getString(0);
                if (ms <= 0) ms = parseCreatedAtFromId(id);
                result.add(new Summary(id, rows.getString(1), ms));
            }
        }
        return result;
    }

    static long createdAtMs(Context context, String id) {
        try (SQLiteStatement st = database(context).compileStatement(
                "SELECT COALESCE((SELECT created_at_ms FROM manuscript WHERE id = ?), 0)")) {
            st.bindString(1, id);
            long ms = st.simpleQueryForLong();
            if (ms > 0) return ms;
        } catch (SQLiteException ignored) {
        }
        return parseCreatedAtFromId(id);
    }

    static long parseCreatedAtFromId(String id) {
        if (id == null) return 0L;
        int sep = id.indexOf('-');
        if (sep <= 0) return 0L;
        try {
            return Long.parseLong(id.substring(0, sep));
        } catch (NumberFormatException ignored) {
            return 0L;
        }
    }

    static SyncModels.ManuscriptRecord readRecord(Context context, String id) {
        try (Cursor c = database(context).rawQuery(
                "SELECT created_at_ms, raw, polished, error, capture_status, application, seconds, "
                        + "user_edited, delivery_note, audio_warning, asr_results_json, source_device_id "
                        + "FROM manuscript WHERE id = ?",
                new String[] { id })) {
            if (!c.moveToFirst()) return null;
            return recordFromCursor(id, c, 0);
        }
    }

    static List<SyncModels.ManuscriptRecord> listFinishedRecords(Context context) {
        List<SyncModels.ManuscriptRecord> out = new ArrayList<>();
        try (Cursor c = database(context).rawQuery(
                "SELECT id, created_at_ms, raw, polished, error, capture_status, application, seconds, "
                        + "user_edited, delivery_note, audio_warning, asr_results_json, source_device_id "
                        + "FROM manuscript ORDER BY created_at_ms ASC, id ASC", null)) {
            while (c.moveToNext()) {
                out.add(recordFromCursor(c.getString(0), c, 1));
            }
        }
        return out;
    }

    private static SyncModels.ManuscriptRecord recordFromCursor(String id, Cursor c, int col) {
        long ms = c.isNull(col) ? 0L : c.getLong(col);
        if (ms <= 0) ms = parseCreatedAtFromId(id);
        String raw = c.isNull(col + 1) ? "" : c.getString(col + 1);
        String polished = c.isNull(col + 2) ? "" : c.getString(col + 2);
        String error = c.isNull(col + 3) ? "" : c.getString(col + 3);
        String captureStatus = c.isNull(col + 4) ? "" : c.getString(col + 4);
        String app = c.isNull(col + 5) ? "" : c.getString(col + 5);
        double seconds = c.isNull(col + 6) ? 0.0 : c.getDouble(col + 6);
        boolean userEdited = !c.isNull(col + 7) && c.getInt(col + 7) != 0;
        String deliveryNote = c.isNull(col + 8) ? null : c.getString(col + 8);
        String audioWarning = c.isNull(col + 9) ? null : c.getString(col + 9);
        String asrJson = c.isNull(col + 10) ? null : c.getString(col + 10);
        String sourceDeviceId = c.isNull(col + 11) ? null : c.getString(col + 11);
        List<SyncModels.AsrResult> asrResults = Collections.emptyList();
        if (asrJson != null && !asrJson.isEmpty()) {
            try {
                asrResults = SyncModels.AsrResult.fromJsonArray(new JSONArray(asrJson));
            } catch (JSONException ignored) {
            }
        }
        return new SyncModels.ManuscriptRecord(
                id, ms, raw, polished, error, captureStatus, app, seconds, userEdited,
                deliveryNote, audioWarning, asrResults, sourceDeviceId
        );
    }

    static void upsertFromSync(SQLiteDatabase db, SyncModels.ManuscriptRecord item) {
        ContentValues cv = new ContentValues();
        cv.put("id", item.id);
        cv.put("created_at_ms", item.createdAtMs);
        cv.put("raw", item.original);
        if (item.polishedText != null && !item.polishedText.isEmpty()) cv.put("polished", item.polishedText);
        else cv.putNull("polished");
        cv.put("application", item.application);
        cv.put("seconds", item.seconds);
        cv.put("user_edited", item.userEdited ? 1 : 0);
        if (item.deliveryNote != null) cv.put("delivery_note", item.deliveryNote);
        else cv.putNull("delivery_note");
        if (item.audioWarning != null) cv.put("audio_warning", item.audioWarning);
        else cv.putNull("audio_warning");
        try {
            if (!item.asrResults.isEmpty()) {
                cv.put("asr_results_json", SyncModels.AsrResult.toJsonArray(item.asrResults).toString());
            } else {
                cv.putNull("asr_results_json");
            }
        } catch (JSONException ignored) {
        }
        if (item.sourceDeviceId != null) cv.put("source_device_id", item.sourceDeviceId);
        else cv.putNull("source_device_id");
        db.insertWithOnConflict("manuscript", null, cv, SQLiteDatabase.CONFLICT_REPLACE);
    }

    static void saveCachedMedia(Context context, String id, String kind, byte[] data) {
        saveMedia(context, id, kind, data);
    }

    static String read(Context context, String id, String name) throws IOException {
        try {
            String column = textColumn(name);
            // Read text via a statement as well, so long transcripts never fill a CursorWindow.
            try (SQLiteStatement query = database(context).compileStatement(
                    "SELECT COALESCE((SELECT " + column + " FROM manuscript WHERE id = ?), '')")) {
                query.bindString(1, id);
                return query.simpleQueryForString();
            }
        } catch (SQLiteException failure) {
            throw new IOException("无法读取文稿。", failure);
        }
    }

    static void saveAudio(Context context, String id, byte[] wav) {
        saveMedia(context, id, "audio", wav);
    }

    static void saveScreenshot(Context context, String id, byte[] png) {
        saveMedia(context, id, "screenshot", png);
    }

    static void saveDiagnostics(Context context, String id, String text) {
        saveMedia(context, id, "diagnostics", text.getBytes(StandardCharsets.UTF_8));
    }

    static String diagnostics(Context context, String id) {
        byte[] data = media(context, id, "diagnostics");
        return data == null ? "" : new String(data, StandardCharsets.UTF_8);
    }

    private static void saveMedia(Context context, String id, String kind, byte[] data) {
        SQLiteDatabase db = database(context);
        db.beginTransactionNonExclusive();
        try {
            // A capture can finish after deletion. The transaction prevents a late write
            // from racing the parent check, and no attachment operation creates a manuscript.
            if (exists(db, "manuscript", id)) writeMedia(db, id, kind, new ByteArrayInputStream(data));
            db.setTransactionSuccessful();
        } catch (IOException impossible) {
            throw new UncheckedIOException(impossible);
        } finally {
            db.endTransaction();
        }
    }

    static long size(Context context, String id, String kind) {
        return size(database(context), id, kind);
    }

    private static long size(SQLiteDatabase db, String id, String kind) {
        try (SQLiteStatement query = db.compileStatement(
                "SELECT COALESCE(SUM(length(data)), 0) FROM attachment WHERE id = ? AND kind = ?")) {
            query.bindString(1, id);
            query.bindString(2, kind);
            return query.simpleQueryForLong();
        }
    }

    static byte[] media(Context context, String id, String kind) {
        SQLiteDatabase db = database(context);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (Cursor parts = db.rawQuery(
                "SELECT data FROM attachment WHERE id = ? AND kind = ? ORDER BY part",
                new String[] { id, kind })) {
            while (parts.moveToNext()) {
                byte[] data = parts.getBlob(0);
                if (data != null && data.length > 0) out.write(data, 0, data.length);
            }
        }
        return out.size() == 0 ? null : out.toByteArray();
    }

    static AudioSource openAudio(Context context, String id) {
        SQLiteDatabase db = database(context);
        long length = size(db, id, "audio");
        return length == 0 ? null : new AudioSource(db, id, length);
    }

    static final class AudioSource extends MediaDataSource {
        private final SQLiteDatabase db;
        private final String id;
        private final long length;
        private long cachedPart = -1;
        private byte[] cachedBytes;
        private boolean closed;

        AudioSource(SQLiteDatabase db, String id, long length) {
            this.db = db;
            this.id = id;
            this.length = length;
        }

        @Override
        public synchronized int readAt(long offset, byte[] buffer, int start, int count) throws IOException {
            if (closed) throw new IOException("录音已关闭。");
            if (offset < 0 || start < 0 || count < 0 || start > buffer.length - count) {
                throw new IndexOutOfBoundsException();
            }
            if (count == 0) return 0;
            if (offset >= length) return -1;
            int remaining = (int) Math.min(count, length - offset);
            int total = remaining;
            while (remaining > 0) {
                long part = offset / CHUNK_BYTES;
                int withinPart = (int) (offset % CHUNK_BYTES);
                if (part != cachedPart) {
                    cachedPart = -1;
                    cachedBytes = null;
                    cachedBytes = readPart(part);
                    cachedPart = part;
                }
                if (cachedBytes == null || withinPart >= cachedBytes.length) {
                    throw new IOException("录音数据不完整。");
                }
                int read = Math.min(remaining, cachedBytes.length - withinPart);
                System.arraycopy(cachedBytes, withinPart, buffer, start, read);
                start += read;
                offset += read;
                remaining -= read;
            }
            return total;
        }

        private byte[] readPart(long part) throws IOException {
            try (Cursor row = db.rawQuery(
                    "SELECT data FROM attachment WHERE id = ? AND kind = 'audio' AND part = ?",
                    new String[] { id, Long.toString(part) })) {
                return row.moveToFirst() ? row.getBlob(0) : null;
            } catch (SQLiteException failure) {
                throw new IOException("无法读取已保存的录音。", failure);
            }
        }

        @Override public long getSize() { return length; }

        @Override
        public synchronized void close() {
            closed = true;
            cachedBytes = null;
        }
    }

    /** Called from the history worker, never from IME startup or recording. */
    static void migrate(Context context) throws IOException {
        synchronized (LEGACY_LOCK) {
            File legacy = new File(context.getNoBackupFilesDir(), "manuscripts");
            if (!legacy.isDirectory()) return;
            File[] folders = legacy.listFiles(file -> file.isDirectory()
                    && file.getName().matches("[0-9]{13}-[0-9a-f-]{36}"));
            if (folders == null) throw new IOException("无法读取旧文稿目录。");
            SQLiteDatabase db = database(context);
            boolean failed = false;
            for (File folder : folders) {
                try {
                    importLegacy(db, folder);
                    // Cleanup follows the durable commit. A crash leaves the import marker behind,
                    // including after a user deletes the imported manuscript.
                    removeImportedFiles(folder);
                } catch (IOException | SQLiteException failure) {
                    failed = true;
                }
            }
            if (failed) throw new IOException("部分旧文稿尚未迁移，原文件已保留。");
        }
    }

    private static void importLegacy(SQLiteDatabase db, File folder) throws IOException {
        String id = folder.getName();
        db.beginTransactionNonExclusive();
        try {
            if (!exists(db, "legacy_import", id)) {
                ContentValues values = new ContentValues();
                values.put("id", id);
                if (!exists(db, "manuscript", id)) {
                    values.put("created_at_ms", parseCreatedAtFromId(id));
                    for (String name : LEGACY_TEXT) {
                        File file = new File(folder, name + ".txt");
                        if (file.isFile() || new File(file.getPath() + ".bak").isFile()) {
                            values.put(textColumn(name), new String(
                                    new AtomicFile(file).readFully(), StandardCharsets.UTF_8));
                        }
                    }
                    db.insertOrThrow("manuscript", null, values);
                    importMedia(db, folder, id, "audio", "audio.wav");
                    importMedia(db, folder, id, "screenshot", "screen.png");
                }
                ContentValues marker = new ContentValues();
                marker.put("id", id);
                db.insertOrThrow("legacy_import", null, marker);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private static void importMedia(SQLiteDatabase db, File folder, String id, String kind, String filename)
            throws IOException {
        File file = new File(folder, filename);
        if (!file.isFile()) return;
        try (InputStream input = new FileInputStream(file)) {
            writeMedia(db, id, kind, input);
        }
    }

    private static void writeMedia(SQLiteDatabase db, String id, String kind, InputStream input)
            throws IOException {
        db.delete("attachment", "id = ? AND kind = ?", new String[] { id, kind });
        try (SQLiteStatement insert = db.compileStatement(
                "INSERT INTO attachment (id, kind, part, data) VALUES (?, ?, ?, ?)")) {
            insert.bindString(1, id);
            insert.bindString(2, kind);
            byte[] buffer = new byte[CHUNK_BYTES];
            int part = 0;
            int read;
            while ((read = readChunk(input, buffer)) != 0) {
                insert.bindLong(3, part++);
                insert.bindBlob(4, read == buffer.length ? buffer : Arrays.copyOf(buffer, read));
                insert.executeInsert();
            }
        }
    }

    private static int readChunk(InputStream input, byte[] buffer) throws IOException {
        int size = 0;
        while (size < buffer.length) {
            int read = input.read(buffer, size, buffer.length - size);
            if (read < 0) break;
            size += read;
        }
        return size;
    }

    private static void removeImportedFiles(File folder) {
        for (String name : LEGACY_TEXT) {
            new AtomicFile(new File(folder, name + ".txt")).delete();
        }
        new File(folder, "audio.wav").delete();
        new File(folder, "screen.png").delete();
        new File(folder, "screen.png.tmp").delete();
        folder.delete();
    }

    private static boolean exists(SQLiteDatabase db, String table, String id) {
        try (SQLiteStatement query = db.compileStatement(
                "SELECT EXISTS(SELECT 1 FROM " + table + " WHERE id = ?)")) {
            query.bindString(1, id);
            return query.simpleQueryForLong() != 0;
        }
    }

    private static String textColumn(String name) {
        switch (name) {
            case "raw": return "raw";
            case "polished": return "polished";
            case "error": return "error";
            case "capture-status": return "capture_status";
            default: throw new IllegalArgumentException("Unknown manuscript field");
        }
    }

    static SQLiteDatabase database(Context context) {
        Store current = store;
        if (current == null) {
            synchronized (Manuscripts.class) {
                current = store;
                if (current == null) {
                    current = new Store(context.getApplicationContext());
                    store = current;
                }
            }
        }
        return current.getWritableDatabase();
    }

    private static final class Store extends SQLiteOpenHelper {
        Store(Context context) {
            super(context, new File(context.getNoBackupFilesDir(), "manuscripts.sqlite3").getPath(),
                    null, DB_VERSION);
            setWriteAheadLoggingEnabled(true);
        }

        @Override
        public void onConfigure(SQLiteDatabase db) {
            db.setForeignKeyConstraintsEnabled(true);
            // The legacy files are removed after commit, so their WAL writes must be synced.
            db.execSQL("PRAGMA synchronous = FULL");
        }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE manuscript (id TEXT PRIMARY KEY, raw TEXT, polished TEXT,"
                    + " error TEXT, capture_status TEXT, created_at_ms INTEGER NOT NULL DEFAULT 0,"
                    + " application TEXT NOT NULL DEFAULT '', seconds REAL NOT NULL DEFAULT 0,"
                    + " user_edited INTEGER NOT NULL DEFAULT 0, delivery_note TEXT,"
                    + " audio_warning TEXT, asr_results_json TEXT, source_device_id TEXT)");
            db.execSQL("CREATE TABLE attachment (id TEXT NOT NULL REFERENCES manuscript(id) ON DELETE CASCADE,"
                    + " kind TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, kind, part))");
            db.execSQL("CREATE TABLE legacy_import (id TEXT PRIMARY KEY)");
            createSyncTables(db);
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int previous, int current) {
            if (previous < 2) {
                db.execSQL("ALTER TABLE manuscript ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN application TEXT NOT NULL DEFAULT ''");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN seconds REAL NOT NULL DEFAULT 0");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN user_edited INTEGER NOT NULL DEFAULT 0");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN delivery_note TEXT");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN audio_warning TEXT");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN asr_results_json TEXT");
                db.execSQL("ALTER TABLE manuscript ADD COLUMN source_device_id TEXT");
                try (Cursor rows = db.rawQuery("SELECT id FROM manuscript WHERE created_at_ms = 0", null)) {
                    while (rows.moveToNext()) {
                        String id = rows.getString(0);
                        long ms = parseCreatedAtFromId(id);
                        if (ms > 0) {
                            ContentValues cv = new ContentValues();
                            cv.put("created_at_ms", ms);
                            db.update("manuscript", cv, "id = ?", new String[] { id });
                        }
                    }
                }
                createSyncTables(db);
            }
        }

        private static void createSyncTables(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
            db.execSQL("CREATE TABLE IF NOT EXISTS sync_entries ("
                    + "collection TEXT NOT NULL,"
                    + "record_key TEXT NOT NULL,"
                    + "local_id TEXT,"
                    + "version_hlc TEXT NOT NULL,"
                    + "origin_device_id TEXT NOT NULL,"
                    + "deleted INTEGER NOT NULL DEFAULT 0,"
                    + "deleted_at_ms INTEGER,"
                    + "updated_at_ms INTEGER NOT NULL,"
                    + "meta_json TEXT NOT NULL DEFAULT '{}',"
                    + "PRIMARY KEY (collection, record_key))");
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_sync_entries_updated "
                    + "ON sync_entries(collection, updated_at_ms, record_key)");
            db.execSQL("CREATE TABLE IF NOT EXISTS sync_hub_cursors ("
                    + "hub_instance_id TEXT PRIMARY KEY,"
                    + "last_pulled_seq INTEGER NOT NULL DEFAULT 0,"
                    + "last_sync_at_ms INTEGER)");
            db.execSQL("CREATE TABLE IF NOT EXISTS sync_hub_acked ("
                    + "hub_instance_id TEXT NOT NULL,"
                    + "collection TEXT NOT NULL,"
                    + "record_key TEXT NOT NULL,"
                    + "acked_version_hlc TEXT NOT NULL,"
                    + "PRIMARY KEY (hub_instance_id, collection, record_key))");
            db.execSQL("CREATE TABLE IF NOT EXISTS sync_pruned ("
                    + "manuscript_id TEXT PRIMARY KEY,"
                    + "pruned_at_ms INTEGER NOT NULL,"
                    + "pruned_version_hlc TEXT)");
        }
    }
}
