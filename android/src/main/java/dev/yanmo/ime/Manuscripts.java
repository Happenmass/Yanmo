package dev.yanmo.ime;

import android.content.Context;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

final class Manuscripts {
    private static final Set<String> ACTIVE = new HashSet<>();

    private Manuscripts() {}

    static synchronized String begin(Context context) {
        String id = System.currentTimeMillis() + "-" + UUID.randomUUID();
        if (!directory(context, id).mkdirs()) {
            throw new UncheckedIOException(new IOException("无法创建文稿，请检查设备储存空间。"));
        }
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
        ACTIVE.remove(id);
        File directory = directory(context, id);
        File[] files = directory.listFiles();
        if (files == null && !directory.exists()) return;
        if (files == null) throw new IOException("无法读取文稿附件。");
        for (File file : files) {
            if (!file.delete() && file.exists()) throw new IOException("无法删除文稿附件。");
        }
        if (!directory.delete() && directory.exists()) throw new IOException("无法删除文稿。");
    }

    static synchronized void delete(Context context, String id) throws IOException {
        if (active(id)) throw new IOException("这篇文稿正在处理中，请稍后重试。");
        discard(context, id);
    }

    static File audio(Context context, String id) {
        return new File(directory(context, id), "audio.wav");
    }

    static File screenshot(Context context, String id) {
        return new File(directory(context, id), "screen.png");
    }

    static void capture(Context context, String id) {
        ScreenCapture.capture(context, id);
    }

    static synchronized void captureStatus(Context context, String id, String status) {
        File folder = directory(context, id);
        if (!folder.isDirectory()) return;
        try {
            save(new File(folder, "capture-status.txt"), status);
        } catch (UncheckedIOException ignored) {
            // A capture status is optional and cannot prevent audio or text from being saved.
        }
    }

    static void raw(Context context, String id, String text) {
        save(new File(directory(context, id), "raw.txt"), text);
    }

    static void polished(Context context, String id, String text) {
        save(new File(directory(context, id), "polished.txt"), text);
    }

    static void fail(Context context, String id, String error) {
        save(new File(directory(context, id), "error.txt"), error);
    }

    static String[] history(Context context) {
        String[] ids = root(context).list((file, name) ->
                name.matches("[0-9]{13}-[0-9a-f-]{36}") && new File(file, name).isDirectory());
        if (ids == null) return new String[0];
        Arrays.sort(ids, Comparator.reverseOrder());
        return ids;
    }

    static String read(Context context, String id, String name) throws IOException {
        File file = new File(directory(context, id), name + ".txt");
        if (!file.exists() && !new File(file.getPath() + ".bak").exists()) return "";
        return new String(new AtomicFile(file).readFully(), StandardCharsets.UTF_8);
    }

    private static File root(Context context) {
        return new File(context.getNoBackupFilesDir(), "manuscripts");
    }

    private static File directory(Context context, String id) {
        return new File(root(context), id);
    }

    private static void save(File file, String value) {
        AtomicFile atomic = new AtomicFile(file);
        FileOutputStream output = null;
        try {
            output = atomic.startWrite();
            output.write(value.getBytes(StandardCharsets.UTF_8));
            atomic.finishWrite(output);
        } catch (IOException failure) {
            atomic.failWrite(output);
            throw new UncheckedIOException("无法保存文稿，请检查设备储存空间。", failure);
        }
    }
}
