package dev.yanmo.ime;

import android.content.Context;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Random;
import java.util.UUID;

/** Synthetic legacy fixtures are created only inside the instrumentation application. */
final class ManuscriptStoreProbe {
    private ManuscriptStoreProbe() {}

    static void verify(Context context) throws Exception {
        File legacy = new File(context.getNoBackupFilesDir(), "manuscripts");
        String id = System.currentTimeMillis() + "-" + UUID.randomUUID();
        File folder = new File(legacy, id);
        check(folder.mkdirs(), "fixture directory");
        String raw = "旧语稿 with English";
        String polished = "旧语稿 with English。\n";
        String captureStatus = "截屏尚未返回";
        byte[] wav = bytes(5 * 1024 * 1024 + 47);
        byte[] screenshot = bytes(3 * 1024 * 1024 + 19);
        Files.write(new File(folder, "raw.txt.bak").toPath(), raw.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(folder, "polished.txt").toPath(), polished.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(folder, "capture-status.txt").toPath(), captureStatus.getBytes(StandardCharsets.UTF_8));
        Files.write(new File(folder, "audio.wav").toPath(), wav);
        Files.write(new File(folder, "screen.png").toPath(), screenshot);
        Manuscripts.migrate(context);
        check(!folder.exists(), "legacy files were not cleaned after commit");
        check(Arrays.asList(Manuscripts.history(context)).contains(id), "migrated entry missing from history");
        check(raw.equals(Manuscripts.read(context, id, "raw")), "raw text or AtomicFile backup lost");
        check(polished.equals(Manuscripts.read(context, id, "polished")), "changed polished text");
        check(captureStatus.equals(Manuscripts.read(context, id, "capture-status")), "capture status lost");
        check(Manuscripts.size(context, id, "audio") == wav.length, "incorrect WAV size");
        check(Manuscripts.size(context, id, "screenshot") == screenshot.length, "incorrect PNG size");
        check(Arrays.equals(wav, Manuscripts.media(context, id, "audio")), "multi-window WAV changed");
        check(Arrays.equals(screenshot, Manuscripts.media(context, id, "screenshot")), "multi-window PNG changed");
        verifyAudioSource(context, id, wav);

        // Simulate a crash after commit but before legacy cleanup, and a delayed capture after deletion.
        check(folder.mkdir(), "could not restore a stale legacy directory");
        Files.write(new File(folder, "raw.txt").toPath(), raw.getBytes(StandardCharsets.UTF_8));
        Manuscripts.delete(context, id);
        Manuscripts.saveScreenshot(context, id, screenshot);
        Manuscripts.captureStatus(context, id, captureStatus);
        Manuscripts.migrate(context);
        check(!Arrays.asList(Manuscripts.history(context)).contains(id), "a deleted manuscript returned");
        check(Manuscripts.media(context, id, "audio") == null, "audio remained after deletion");
        check(Manuscripts.media(context, id, "screenshot") == null, "late capture recreated media");
        check(!folder.exists(), "stale legacy files not cleaned");
        check(Manuscripts.openAudio(context, id) == null, "deleted WAV could still be opened");
    }

    private static void verifyAudioSource(Context context, String id, byte[] wav) throws IOException {
        Manuscripts.AudioSource playback = Manuscripts.openAudio(context, id);
        check(playback != null, "could not open migrated WAV");
        try (Manuscripts.AudioSource source = playback) {
            check(source.getSize() == wav.length, "wrong streaming length");
            byte[] buffer = new byte[600_013];
            int crossChunks = 550_000;
            int start = 256 * 1024 - 6;
            check(source.readAt(start, buffer, 7, crossChunks) == crossChunks,
                    "stream did not read across chunk boundaries");
            check(Arrays.equals(Arrays.copyOfRange(wav, start, start + crossChunks),
                    Arrays.copyOfRange(buffer, 7, 7 + crossChunks)), "stream changed cross-chunk bytes");
            check(source.readAt(wav.length - 5, buffer, 0, 12) == 5, "stream overran file end");
            check(Arrays.equals(Arrays.copyOfRange(wav, wav.length - 5, wav.length),
                    Arrays.copyOf(buffer, 5)), "wrong bytes at file end");
            check(source.readAt(wav.length, buffer, 0, 1) == -1, "missing EOF");
            check(source.readAt(wav.length, buffer, 0, 0) == 0, "zero-length read at EOF");
            check(source.readAt(0, buffer, 0, 20) == 20, "could not seek backward");
            check(Arrays.equals(Arrays.copyOf(wav, 20), Arrays.copyOf(buffer, 20)), "wrong bytes after seek");
        }
        try {
            playback.readAt(0, new byte[1], 0, 1);
            throw new AssertionError("closed stream could still read");
        } catch (IOException expected) {
            // Closed sources do not read or keep a cached chunk.
        }
    }

    private static byte[] bytes(int size) {
        byte[] data = new byte[size];
        new Random(size).nextBytes(data);
        return data;
    }

    private static void check(boolean condition, String issue) {
        if (!condition) throw new AssertionError(issue);
    }
}
