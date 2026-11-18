package dev.yanmo.ime;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.inputmethodservice.InputMethodService;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.text.InputType;
import android.view.View;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Runs the real voice coordinator and text request with synthetic audio and a deterministic HTTPS response. */
public final class VoiceSessionProbe extends Instrumentation {
    private static final String RAW = "我我明天跟 Kai 开会";
    private static final String POLISHED = "明天跟 Kai 开会。\n";
    private int requests;
    private volatile String expectedApiRaw;
    private Bundle arguments;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            URL.setURLStreamHandlerFactory(protocol -> {
                if (!protocol.equals("https")) return null;
                return new URLStreamHandler() {
                    @Override protected HttpURLConnection openConnection(URL url) {
                        return new Response(url);
                    }
                };
            });
            Context context = getTargetContext();
            ManuscriptStoreProbe.verify(context);
            Polish.save(context, true, "https://voice-probe.invalid/v1", "synthetic", "", true);
            runTake(false, false, 1);
            runTake(true, false, 0);
            runTake(false, true, 0);
            check(requests == 2, "expected two calls to the enabled text API");
            Polish.save(context, false, "", "", "", true);
            runTake(false, false, 0);
            check(requests == 2, "disabled text API received a request");
            if ("true".equals(arguments.getString("checkBinder"))) {
                result.putString("binder", verifyMemoryBinder(context));
            }
            result.putString("stream", "Voice session passed: active editor once, switched/cancelled/disabled editor never; Production ASR Binder verified two WAV windows; SQLite WAV, raw text, finished text and PNG verified.\n");
            finish(Activity.RESULT_OK, result);
        } catch (Exception | AssertionError failure) {
            result.putString("stream", android.util.Log.getStackTraceString(failure));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private String verifyMemoryBinder(Context context) throws Exception {
        byte[] wav = new byte[44 + 16_000 * 2 * 2];
        VoiceSession.writeHeader(wav);
        AtomicInteger bytesRead = new AtomicInteger();
        LocalAsr.WavReader observer = new LocalAsr.WavReader(wav) {
            @Override public int onRead(long offset, int size, byte[] buffer) {
                int count = super.onRead(offset, size, buffer);
                bytesRead.addAndGet(count);
                return count;
            }
        };
        try (LocalAsr asr = new LocalAsr(context, "dev.androidagent.sample.fixture");
             ParcelFileDescriptor audio = asr.openProxyAudio(observer)) {
            check(audio.getStatSize() == wav.length, "proxy descriptor did not report WAV length");
            // SPEAKERS uses the same SDK withAudio() path as ASR and does not gate on HTP.
            try {
                check(asr.requestAudio(3, audio, 30).getLongArray("turns") != null, "invalid SDK speaker reply");
            } catch (LocalAsr.Failure failure) {
                // The emulator fixture can omit speaker weights. Verify the service has already read
                // the complete WAV in withAudio() before treating that diagnostic as expected.
                check("INFERENCE_FAILED".equals(failure.reason), "SDK speaker error: " + failure.reason);
            }
            check(bytesRead.get() == wav.length, "SDK did not read all WAV bytes: " + bytesRead.get());
            try {
                asr.requireReady();
                throw new AssertionError("emulator unexpectedly supports HTP");
            } catch (LocalAsr.Failure failure) {
                check("UNSUPPORTED_DEVICE".equals(failure.reason), "Binder ASR status: " + failure.reason);
            }
        }
        return "Signed SDK read " + bytesRead.get() + " WAV bytes via read-only memory FD; HTP returned UNSUPPORTED_DEVICE.";
    }

    private void runTake(boolean switchEditor, boolean cancel, int commits) throws Exception {
        Context context = getTargetContext();
        String[] previous = Manuscripts.history(context);
        boolean realWindows = commits > 0;
        byte[] pcm = realWindows ? SpeechWireProbeService.pcm() : new byte[] {1, 2, 3, 4};
        String expectedRaw = realWindows ? SpeechWireProbeService.TRANSCRIPT : RAW;
        expectedApiRaw = expectedRaw;
        CountDownLatch complete = new CountDownLatch(1);
        CountDownLatch recording = new CountDownLatch(1);
        CountDownLatch allowAsr = new CountDownLatch(1);
        TestIme[] service = new TestIme[1];
        VoiceSession[] voice = new VoiceSession[1];
        ProbeConnection[] original = new ProbeConnection[1];
        ProbeConnection[] other = new ProbeConnection[1];
        runOnMainSync(() -> {
            TestIme ime = new TestIme(context);
            original[0] = new ProbeConnection(context);
            other[0] = new ProbeConnection(context);
            ime.editor = original[0];
            service[0] = ime;
            voice[0] = new VoiceSession(ime, context.getPackageName(), state -> {
                if (state == VoiceSession.IDLE) complete.countDown();
            }, (wav, stopped) -> {
                wav.write(pcm);
                recording.countDown();
                while (!stopped.getAsBoolean()) SystemClock.sleep(1);
            }, realWindows ? null : (wav, saveRaw) -> {
                check(allowAsr.await(5, TimeUnit.SECONDS), "ASR was blocked");
                saveRaw.accept(RAW);
                return RAW;
            });
            check(voice[0].start(), "recording did not start");
        });
        check(recording.await(5, TimeUnit.SECONDS), "fake recorder did not start");
        String id = Manuscripts.history(context)[0];
        check(Manuscripts.size(context, id, "audio") == 0L, "audio was stored before release");
        runOnMainSync(() -> {
            if (cancel) {
                voice[0].cancel();
            } else {
                voice[0].stop();
                voice[0].stop();
            }
            if (switchEditor) {
                voice[0].editorEnded();
                service[0].editor = other[0];
            }
        });
        byte[] png = commits > 0 ? screenshot() : null;
        if (png != null) Manuscripts.saveScreenshot(context, id, png);
        allowAsr.countDown();
        check(complete.await(20, TimeUnit.SECONDS), "voice coordinator did not finish");
        runOnMainSync(() -> voice[0].destroy());
        check(original[0].commits == commits, "original editor commit count " + original[0].commits
                + ", manuscript error: " + Manuscripts.read(context, id, "error"));
        check(other[0].commits == 0, "wrote to the replacement editor");
        if (commits > 0) check(POLISHED.equals(original[0].text), "commit changed the model output");

        String[] after = Manuscripts.history(context);
        check(after.length == previous.length + 1, "expected one manuscript");
        check(after[0].equals(id), "unexpected manuscript order");
        byte[] wav = Manuscripts.media(context, id, "audio");
        byte[] expectedWav = new byte[44 + pcm.length];
        System.arraycopy(pcm, 0, expectedWav, 44, pcm.length);
        VoiceSession.writeHeader(expectedWav);
        check(Manuscripts.size(context, id, "audio") == expectedWav.length && Arrays.equals(wav, expectedWav),
                "SQLite WAV readback differs from captured audio");
        if (png != null) {
            byte[] result = Manuscripts.media(context, id, "screenshot");
            check(Manuscripts.size(context, id, "screenshot") == png.length && Arrays.equals(result, png),
                    "SQLite PNG readback differs from submitted screenshot");
            Bitmap decoded = BitmapFactory.decodeByteArray(result, 0, result.length);
            check(decoded != null && decoded.getPixel(0, 0) == Color.MAGENTA, "SQLite screenshot could not be decoded");
            decoded.recycle();
        }
        check(Manuscripts.read(context, id, "raw").equals(cancel ? "" : expectedRaw), "incorrect raw transcript");
        boolean enabled = Polish.enabled(context);
        check(Manuscripts.read(context, id, "polished").equals(cancel || !enabled ? "" : POLISHED), "incorrect polished transcript");
        if (switchEditor || !enabled || cancel) check(!Manuscripts.read(context, id, "error").isEmpty(), "failure missing");
    }

    private static byte[] screenshot() {
        Bitmap bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        bitmap.eraseColor(Color.MAGENTA);
        ByteArrayOutputStream png = new ByteArrayOutputStream();
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, png), "failed to generate test screenshot");
        bitmap.recycle();
        return png.toByteArray();
    }

    private final class Response extends HttpURLConnection {
        private final ByteArrayOutputStream body = new ByteArrayOutputStream();

        Response(URL url) { super(url); }

        @Override public void connect() {}
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public ByteArrayOutputStream getOutputStream() { return body; }
        @Override public int getResponseCode() {
            check(url.getPath().equals("/v1/chat/completions"), "unexpected completion endpoint");
            try {
                JSONArray messages = new JSONObject(body.toString("UTF-8")).getJSONArray("messages");
                check(messages.getJSONObject(0).getString("role").equals("system"), "system prompt missing");
                check(!messages.getJSONObject(0).getString("content").isEmpty(), "empty system prompt");
                JSONObject payload = new JSONObject(messages.getJSONObject(1).getString("content"));
                check(payload.getJSONArray("ASR_RESULTS").getJSONObject(0).getString("transcript").equals(expectedApiRaw),
                        "recognition text changed before text API");
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
            requests++;
            return 200;
        }
        @Override public ByteArrayInputStream getInputStream() {
            String response = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":" + JSONObject.quote(POLISHED) + "}}]}";
            return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static final class TestIme extends InputMethodService {
        private InputConnection editor;
        private final EditorInfo info = new EditorInfo();

        TestIme(Context context) {
            attachBaseContext(context);
            info.packageName = "probe.editor";
            info.inputType = InputType.TYPE_CLASS_TEXT;
        }

        @Override public InputConnection getCurrentInputConnection() { return editor; }
        @Override public EditorInfo getCurrentInputEditorInfo() { return info; }
        @Override public int checkSelfPermission(String permission) { return PackageManager.PERMISSION_GRANTED; }
    }

    private static final class ProbeConnection extends BaseInputConnection {
        String text;
        int commits;

        ProbeConnection(Context context) { super(new View(context), false); }

        @Override public boolean commitText(CharSequence data, int newCursorPosition) {
            check(newCursorPosition == 1, "incorrect cursor positioning");
            commits++;
            text = data.toString();
            return true;
        }
    }

    private static void check(boolean condition, String failure) {
        if (!condition) throw new AssertionError(failure);
    }
}
