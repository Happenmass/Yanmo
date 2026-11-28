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
import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Runs the real voice coordinator and text request with synthetic audio and a deterministic HTTPS response. */
public final class VoiceSessionProbe extends Instrumentation {
    private static final String RAW = "我我明天跟 Kai 开会";
    private static final String POLISHED = "明天跟 Kai 开会。\n";
    private int requests;
    private int extractionRequests;
    private final CountDownLatch extracted = new CountDownLatch(1);
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
            if ("true".equals(arguments.getString("verifyFailureRestart"))) {
                VoiceFailureHistory.Entry latest = VoiceFailureHistory.recent(context).get(0);
                check(latest.code.equals("INFERENCE_FAILED") && latest.detail.contains("sdkStage=AUDIO_READ"),
                        "Failure diagnostics did not persist across process restart");
                result.putString("stream", "Voice session passed: failure history persisted across restart.\n");
                finish(Activity.RESULT_OK, result);
                return;
            }
            ManuscriptStoreProbe.verify(context);
            check(Polish.settings(context).edit().clear().commit(), "could not reset probe settings");
            verifyLexicon(context);
            check(!EditorContext.enabled(context), "context must start disabled");
            EditorContext.setEnabled(context, true);
            boolean diagnosticsOnly = "true".equals(arguments.getString("diagnosticsOnly"));
            if (!diagnosticsOnly) {
                runTake(false, false, 1);
                check(requests == 0, "unconfigured text API received a request");
                Polish.save(context, true, "https://voice-probe.invalid/v1", "synthetic", "", true);
                runTake(false, false, 1, true);
                check(extractionRequests == 1, "manual correction did not trigger one extraction");
                runTake(true, false, 0);
                runTake(false, true, 0);
                check(requests == 2, "expected two calls to the enabled text API");
                Polish.save(context, false, "https://voice-probe.invalid/v1", "synthetic", "", true);
                runTake(false, false, 1);
                check(requests == 2, "disabled text API received a request");
            }
            Lexicon.save(context, null, "SyntheticFailureMarker", Lexicon.AI_TOOLS);
            runTake(false, false, 0, false, true);
            VoiceFailureHistory.Entry latest = VoiceFailureHistory.recent(context).get(0);
            check(latest.code.equals("INFERENCE_FAILED") && latest.detail.contains("request=")
                    && latest.detail.contains("sdkStage=AUDIO_READ") && latest.detail.contains("native=errno 5")
                    && latest.detail.contains("sdkMs=7") && latest.detail.contains("fd=FILE")
                    && !latest.detail.contains("SyntheticFailureMarker"), "incorrect independent failure history");
            if ("true".equals(arguments.getString("checkFailureBinder"))) {
                try (LocalAsr asr = new LocalAsr(context, "dev.androidagent.sample.fixture")) {
                    asr.requireReady();
                    try {
                        asr.transcribeWindow(new byte[64], java.util.Collections.emptyList(), EditorContext.EMPTY);
                        throw new AssertionError("Expected invalid WAV error from SDK");
                    } catch (LocalAsr.Failure failure) {
                        check(failure.reason.equals("INFERENCE_FAILED") && failure.details.contains("sdkStage=WAV_VALIDATION")
                                && failure.details.contains("sdkDetail=INVALID_WAV"), "unexpected real SDK failure reply");
                        result.putString("correlation", failure.details);
                    }
                }
            }
            if ("true".equals(arguments.getString("checkBinder"))) {
                result.putString("binder", verifyFileBinder(context));
            }
            result.putString("stream", diagnosticsOnly
                    ? "Voice session passed: persisted ASR failure metadata.\n"
                    : "Voice session passed: raw/polished commit, editor switch, cancellation, SQLite media, ranked words, both cursor sides and hotwords on both ASR Binder windows, manual correction extraction, and persisted ASR failure metadata.\n");
            finish(Activity.RESULT_OK, result);
        } catch (Exception | AssertionError failure) {
            result.putString("stream", android.util.Log.getStackTraceString(failure));
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private static void verifyLexicon(Context context) throws Exception {
        for (Lexicon.Entry item : Lexicon.list(context)) Lexicon.remove(context, item.id);
        Lexicon.save(context, null, "Kai", Lexicon.GLOBAL);
        String id = Lexicon.list(context).get(0).id;
        Lexicon.save(context, id, "Kai Chen", Lexicon.AI_TOOLS);
        check(Lexicon.list(context).get(0).id.equals(id), "editing replaced the term ID");
        check(Lexicon.list(context).get(0).group.equals(Lexicon.AI_TOOLS), "editing lost the classification");
        try {
            Lexicon.save(context, null, "ＫＡＩ chen", Lexicon.GLOBAL);
            throw new AssertionError("duplicate spelling was saved");
        } catch (java.io.IOException expected) {
            check(Lexicon.list(context).size() == 1, "a duplicate changed the dictionary");
        }
        Lexicon.save(context, null, "Temporary", Lexicon.GLOBAL);
        for (Lexicon.Entry item : Lexicon.list(context)) {
            if (item.term.equals("Temporary")) Lexicon.remove(context, item.id);
        }
        check(Lexicon.list(context).size() == 1, "deleting a word did not persist");
        Lexicon.save(context, null, "项目晨星", Lexicon.GLOBAL);
        List<Lexicon.Entry> entries = Lexicon.list(context);
        Lexicon.recordMatches(context, entries, "项目晨星和 Kai Chenn，项目晨星");
        Lexicon.recordMatches(context, entries, "Kai Chen");
        check(Lexicon.list(context).stream().allMatch(entry -> entry.matchCount == 1), "wrong hit count");
        check(Lexicon.hotwords(Lexicon.list(context), Lexicon.GLOBAL).equals(Arrays.asList("项目晨星")),
                "unrelated app got scoped words");
    }

    private String verifyFileBinder(Context context) throws Exception {
        byte[] wav = new byte[44 + 16_000 * 2 * 2];
        VoiceSession.writeHeader(wav);
        try (LocalAsr asr = new LocalAsr(context, "dev.androidagent.sample.fixture");
             ParcelFileDescriptor audio = asr.openUnlinkedAudio(wav)) {
            check(audio.getStatSize() == wav.length, "file descriptor did not report WAV length");
            // SPEAKERS uses the same SDK withAudio() path as ASR and does not gate on HTP.
            try {
                check(asr.requestAudio(3, audio, 30).getLongArray("turns") != null, "invalid SDK speaker reply");
            } catch (LocalAsr.Failure failure) {
                // The emulator SDK fixture can omit speaker weights.
                check("INFERENCE_FAILED".equals(failure.reason), "SDK speaker error: " + failure.reason);
            }
            try {
                asr.requireReady();
                throw new AssertionError("emulator unexpectedly supports HTP");
            } catch (LocalAsr.Failure failure) {
                check("UNSUPPORTED_DEVICE".equals(failure.reason), "Binder ASR status: " + failure.reason);
            }
        }
        return "Signed SDK speaker request exercised with a read-only file FD; HTP returned UNSUPPORTED_DEVICE.";
    }

    private void runTake(boolean switchEditor, boolean cancel, int commits) throws Exception {
        runTake(switchEditor, cancel, commits, false);
    }

    private void runTake(boolean switchEditor, boolean cancel, int commits, boolean learn) throws Exception {
        runTake(switchEditor, cancel, commits, learn, false);
    }

    private void runTake(boolean switchEditor, boolean cancel, int commits, boolean learn, boolean sdkFailure) throws Exception {
        Context context = getTargetContext();
        String[] previous = Manuscripts.history(context);
        boolean realWindows = commits > 0 || sdkFailure;
        byte[] pcm = realWindows ? SpeechWireProbeService.pcm() : new byte[] {1, 2, 3, 4};
        String expectedRaw = realWindows ? SpeechWireProbeService.TRANSCRIPT : RAW;
        expectedApiRaw = expectedRaw;
        CountDownLatch complete = new CountDownLatch(1);
        CountDownLatch recording = new CountDownLatch(1);
        CountDownLatch allowAsr = new CountDownLatch(1);
        TestIme[] service = new TestIme[1];
        VoiceSession[] voice = new VoiceSession[1];
        List<Integer> states = new ArrayList<>();
        ProbeConnection[] original = new ProbeConnection[1];
        ProbeConnection[] other = new ProbeConnection[1];
        runOnMainSync(() -> {
            TestIme ime = new TestIme(context);
            original[0] = new ProbeConnection(context);
            other[0] = new ProbeConnection(context);
            ime.editor = original[0];
            service[0] = ime;
            voice[0] = new VoiceSession(ime, context.getPackageName(), state -> {
                states.add(state);
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
        if (learn) {
            runOnMainSync(() -> {
                original[0].text = "明天跟 凯岑开会。\n";
                voice[0].manualCommit(original[0], "岑");
            });
            check(extracted.await(14, TimeUnit.SECONDS), "corrected text never reached the API");
            long deadline = SystemClock.uptimeMillis() + 5000;
            while (Lexicon.list(context).stream().noneMatch(entry -> entry.term.equals("凯岑"))
                    && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(25);
            Lexicon.Entry learned = Lexicon.list(context).stream().filter(entry -> entry.term.equals("凯岑"))
                    .findFirst().orElseThrow(() -> new AssertionError("correction was not stored"));
            check(learned.group.equals(Lexicon.AI_TOOLS), "correction lost the app scope");
            Lexicon.remove(context, learned.id);
            original[0].text = POLISHED;
        }
        runOnMainSync(() -> voice[0].destroy());
        check(original[0].commits == commits, "original editor commit count " + original[0].commits
                + ", manuscript error: " + Manuscripts.read(context, id, "error"));
        check(other[0].commits == 0, "wrote to the replacement editor");
        boolean enabled = Polish.enabled(context);
        List<Integer> expectedStates = new ArrayList<>(Arrays.asList(VoiceSession.RECORDING, VoiceSession.PROCESSING));
        if (enabled && !cancel) expectedStates.add(VoiceSession.POLISHING);
        expectedStates.add(VoiceSession.IDLE);
        check(states.equals(expectedStates), "unexpected voice stages: " + states);
        if (commits > 0) check((enabled ? POLISHED : expectedRaw).equals(original[0].text), "commit changed the model output");

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
        check(Manuscripts.read(context, id, "raw").equals(cancel || sdkFailure ? "" : expectedRaw), "incorrect raw transcript");
        check(Manuscripts.read(context, id, "polished").equals(cancel || !enabled ? "" : POLISHED), "incorrect polished transcript");
        check(Manuscripts.read(context, id, "error").isEmpty() == !(switchEditor || cancel || sdkFailure), "incorrect manuscript error");
        String diagnostics = Manuscripts.diagnostics(context, id);
        check(diagnostics.contains("录音开始"), "missing persisted recording diagnostic");
        if (sdkFailure) check(diagnostics.contains(VoiceFailureHistory.recent(context).get(0).detail),
                "manuscript and independent history must save the same request metadata");
        if (commits > 0) check(diagnostics.contains("光标上下文已提供") && diagnostics.contains("已写入输入框")
                && !diagnostics.contains("Kai") && !diagnostics.contains("前前"), "incorrect persisted ASR diagnostics");
        if (commits > 0) {
            String windowTiming = "权重准备 3 ms · 音频交接 4 ms · 推理总计 50 ms · 模型加载 18 ms · 前端与预填 11 ms · 解码 20 ms";
            check(diagnostics.indexOf(windowTiming) >= 0 && diagnostics.indexOf(windowTiming) != diagnostics.lastIndexOf(windowTiming),
                    "both ASR windows must save the individual SDK timings");
        }
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
        private boolean extraction;

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
                extraction = payload.has("CORRECTED");
                if (extraction) {
                    check(payload.getString("ORIGINAL").equals(POLISHED), "correction baseline was not the inserted text");
                    check(payload.getString("CORRECTED").equals("明天跟 凯岑开会。\n"), "correction included text outside dictation");
                    extractionRequests++;
                } else {
                    check(!payload.getJSONObject("AUDIO_CONTEXT").has("lexicon"),
                            "text API must not receive lexicon entries");
                    check(payload.getJSONArray("ASR_RESULTS").getJSONObject(0).getString("transcript").equals(expectedApiRaw),
                            "recognition text changed before text API");
                    JSONObject editor = payload.getJSONObject("context");
                    check(editor.getString("text_before_cursor").equals(ProbeConnection.BEFORE.substring(7)),
                            "left cursor context was missing");
                    check(editor.getString("text_after_cursor").equals(ProbeConnection.AFTER.substring(0, 300)),
                            "right cursor context was missing");
                    requests++;
                }
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
            return 200;
        }
        @Override public ByteArrayInputStream getInputStream() {
            String response = "{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"content\":" + JSONObject.quote(extraction ? "[\"凯岑\"]" : POLISHED) + "}}]}";
            if (extraction) extracted.countDown();
            return new ByteArrayInputStream(response.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static final class TestIme extends InputMethodService {
        private InputConnection editor;
        private final EditorInfo info = new EditorInfo();

        TestIme(Context context) {
            attachBaseContext(context);
            info.packageName = "com.openai.chatgpt";
            info.inputType = InputType.TYPE_CLASS_TEXT;
        }

        @Override public InputConnection getCurrentInputConnection() { return editor; }
        @Override public EditorInfo getCurrentInputEditorInfo() { return info; }
        @Override public int checkSelfPermission(String permission) { return PackageManager.PERMISSION_GRANTED; }
    }

    private static final class ProbeConnection extends BaseInputConnection {
        static final String BEFORE = "1234567" + repeat("前", 300);
        static final String AFTER = repeat("后", 300) + "7654321";
        String text;

        private static String repeat(String item, int count) {
            char[] chars = new char[count];
            Arrays.fill(chars, item.charAt(0));
            return new String(chars);
        }

        @Override public CharSequence getTextBeforeCursor(int length, int flags) { return BEFORE; }
        @Override public CharSequence getTextAfterCursor(int length, int flags) { return AFTER; }

        @Override public ExtractedText getExtractedText(ExtractedTextRequest request, int flags) {
            ExtractedText result = new ExtractedText();
            result.text = BEFORE + (text == null ? "" : text) + AFTER;
            result.selectionStart = result.selectionEnd = BEFORE.length() + (text == null ? 0 : text.length());
            result.partialStartOffset = result.partialEndOffset = -1;
            return result;
        }
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
