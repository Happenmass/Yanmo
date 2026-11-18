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

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

final class Manuscripts {
    private static final Set<String> ACTIVE = new HashSet<>();
    private static final Object LEGACY_LOCK = new Object();
    private static final int CHUNK_BYTES = 256 * 1024;
    private static final String[] LEGACY_TEXT = {"raw", "polished", "error", "capture-status"};
    private static volatile Store store;

    private Manuscripts() {}

    static synchronized String begin(Context context) {
        String id = System.currentTimeMillis() + "-" + UUID.randomUUID();
        ContentValues initial = new ContentValues();
        initial.put("id", id);
        database(context).insertOrThrow("manuscript", null, initial);
        ACTIVE.add(id);
        return id;
    }

    static synchronized void end(Context context, String id) {
        ACTIVE.remove(id);
    }

    static synchronized boolean active(String id) {
        return ACTIVE.contains(id);
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

        Summary(String id, String preview) {
            this.id = id;
            this.preview = preview;
        }
    }

    static ArrayList<Summary> summaries(Context context) {
        ArrayList<Summary> result = new ArrayList<>();
        try (Cursor rows = database(context).rawQuery(
                "SELECT id, substr(coalesce(nullif(polished, ''), nullif(raw, ''), nullif(error, ''),"
                    + " CASE WHEN EXISTS(SELECT 1 FROM attachment WHERE attachment.id = manuscript.id"
                    + " AND kind = 'audio' AND (part > 0 OR length(data) > 44)) THEN '录音' ELSE '录音未完成' END),"
                    + " 1, 300) FROM manuscript ORDER BY id DESC", null)) {
            while (rows.moveToNext()) result.add(new Summary(rows.getString(0), rows.getString(1)));
        }
        return result;
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
        // CursorWindow refills must see the same attachment version even during deletion.
        if (Build.VERSION.SDK_INT >= 35) db.beginTransactionReadOnly();
        else db.beginTransactionNonExclusive();
        try {
            long length = size(db, id, kind);
            if (length == 0) return null;
            byte[] bytes = new byte[Math.toIntExact(length)];
            int offset = 0;
            try (Cursor parts = db.rawQuery(
                    "SELECT data FROM attachment WHERE id = ? AND kind = ? ORDER BY part",
                    new String[] { id, kind })) {
                while (parts.moveToNext()) {
                    byte[] data = parts.getBlob(0);
                    System.arraycopy(data, 0, bytes, offset, data.length);
                    offset += data.length;
                }
            }
            db.setTransactionSuccessful();
            return bytes;
        } finally {
            db.endTransaction();
        }
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

    private static SQLiteDatabase database(Context context) {
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
                    null, 1);
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
                    + " error TEXT, capture_status TEXT)");
            db.execSQL("CREATE TABLE attachment (id TEXT NOT NULL REFERENCES manuscript(id) ON DELETE CASCADE,"
                    + " kind TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, kind, part))");
            db.execSQL("CREATE TABLE legacy_import (id TEXT PRIMARY KEY)");
        }

        @Override public void onUpgrade(SQLiteDatabase db, int previous, int current) {}
    }
}
