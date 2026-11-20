package dev.yanmo.ime;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.inputmethodservice.InputMethodService;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.InputType;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** One dictation at a time. The main thread owns the editor and session state. */
public final class VoiceSession {
    public static final int IDLE = 0;
    public static final int RECORDING = 1;
    public static final int PROCESSING = 2;
    public static final int POLISHING = 3;
    private static final String TAG = "YanmoVoice";

    private static final int SAMPLE_RATE = 16_000;
    private static final int FRAME_BYTES = 2;
    private static final int WAV_HEADER = 44;
    private static final int WINDOW_BYTES = SAMPLE_RATE * FRAME_BYTES * 24;

    public interface Listener {
        void onVoiceState(int state);
    }

    interface Recorder {
        void record(ByteArrayOutputStream pcm, BooleanSupplier stopped) throws IOException;
    }

    interface Transcriber {
        String transcribe(byte[] wav, Consumer<String> saveRaw) throws Exception;
    }

    private final InputMethodService host;
    private final Context app;
    private final String speechPackage;
    private final Listener listener;
    private final Recorder recorder;
    private final BooleanSupplier composing;
    private final Transcriber transcriber;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private final ExecutorService learning = Executors.newSingleThreadExecutor();
    private final Runnable correctionTimeout = this::finishCorrection;
    private CorrectionWindow correction;
    private Recording active;
    private volatile boolean destroyed;

    public VoiceSession(InputMethodService host, String speechPackage, Listener listener) {
        this(host, speechPackage, listener, VoiceSession::record, null, () -> false);
    }

    VoiceSession(InputMethodService host, String speechPackage, Listener listener, BooleanSupplier composing) {
        this(host, speechPackage, listener, VoiceSession::record, null, composing);
    }

    VoiceSession(InputMethodService host, String speechPackage, Listener listener, Recorder recorder,
                 Transcriber transcriber) {
        this(host, speechPackage, listener, recorder, transcriber, () -> false);
    }

    private VoiceSession(InputMethodService host, String speechPackage, Listener listener, Recorder recorder,
                         Transcriber transcriber, BooleanSupplier composing) {
        this.host = host;
        this.app = host.getApplicationContext();
        this.speechPackage = speechPackage;
        this.listener = listener;
        this.recorder = recorder;
        this.transcriber = transcriber;
        this.composing = composing;
    }

    public boolean isRecording() {
        return getState() == RECORDING;
    }

    public int getState() {
        if (active == null) return IDLE;
        if (active.polishing) return POLISHING;
        return active.stopped ? PROCESSING : RECORDING;
    }

    public boolean start() {
        if (active != null || destroyed) return false;
        InputConnection editor = host.getCurrentInputConnection();
        EditorInfo info = host.getCurrentInputEditorInfo();
        if (editor == null || info == null || info.inputType == InputType.TYPE_NULL || passwordField(info)) {
            Log.i(TAG, "start rejected: editor unavailable or password");
            notice("当前输入框无法使用语音输入");
            return false;
        }
        if (host.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "start rejected: microphone permission");
            notice("请先为言墨开启麦克风权限");
            return false;
        }
        clearCorrection();
        try {
            boolean privateEditor = EditorContext.privateEditor(info);
            EditorContext context = !privateEditor && EditorContext.enabled(app)
                    ? EditorContext.capture(editor) : EditorContext.EMPTY;
            Recording recording = new Recording(Manuscripts.begin(app), editor, info.packageName, context, privateEditor);
            active = recording;
            recording.event("录音开始");
            worker.execute(() -> process(recording));
            listener.onVoiceState(RECORDING);
            return true;
        } catch (RuntimeException error) {
            Log.w(TAG, "start failed: manuscript");
            notice("无法创建文稿");
            return false;
        }
    }

    public void stop() {
        Recording recording = active;
        if (recording == null || recording.stopped) return;
        recording.stopped = true;
        recording.finishRecording = true;
        recording.event("松手，开始处理");
        try {
            Manuscripts.capture(app, recording.id);
        } catch (RuntimeException ignored) {
            // A screenshot failure must not discard the recording or prevent transcription.
        } finally {
            recording.readyToSave.countDown();
        }
        listener.onVoiceState(PROCESSING);
    }

    public void cancel() {
        Recording recording = active;
        if (recording == null) return;
        recording.editor = null;
        recording.event(recording.stopped ? "处理期间输入连接失效" : "录音取消");
        if (recording.stopped) return;
        recording.stopped = true;
        recording.cancelled = true;
        recording.finishRecording = true;
        recording.readyToSave.countDown();
        listener.onVoiceState(PROCESSING);
    }

    public void editorEnded() {
        clearCorrection();
        cancel();
    }

    void editorEnded(String event) {
        if (active != null) active.event(event);
        editorEnded();
    }

    void manualCommit(InputConnection editor, String text) {
        if (correction == null) return;
        long now = SystemClock.uptimeMillis();
        if (now >= correction.deadline) clearCorrection();
        else correction.manualCommit(editor, text, now);
    }

    void submitCorrection(InputConnection editor) {
        if (correction != null && correction.editor == editor && SystemClock.uptimeMillis() < correction.deadline) {
            finishCorrection();
        }
    }

    private void clearCorrection() {
        correction = null;
        main.removeCallbacks(correctionTimeout);
    }

    private void finishCorrection() {
        CorrectionWindow completed = correction;
        clearCorrection();
        if (completed == null || destroyed || composing.getAsBoolean() || !Polish.enabled(app)
                || completed.editor != host.getCurrentInputConnection()) return;
        String edited = completed.corrected();
        if (edited == null) return;
        learning.execute(() -> {
            try {
                List<String> terms = Polish.correctionTerms(app, completed.original, edited, completed.raw);
                if (destroyed || !Polish.enabled(app)) return;
                List<String> added = Lexicon.learn(app, terms, completed.group);
                if (!added.isEmpty()) main.post(() -> {
                    if (!destroyed) notice("已加入词库：" + String.join("、", added));
                });
            } catch (Exception ignored) {
                // An extraction or save failure must not interrupt typing.
            }
        });
    }

    public void destroy() {
        destroyed = true;
        editorEnded();
        worker.shutdown();
        learning.shutdownNow();
    }

    private void process(Recording recording) {
        String textToCommit = null;
        String failure = null;
        String stage = "录音";
        try {
            byte[] wav = collect(recording);
            if (recording.cancelled) {
                failure = "录音已取消";
            } else if (wav.length <= WAV_HEADER) {
                failure = "未采集到音频";
            } else {
                stage = "语音识别";
                List<Lexicon.Entry> entries = Collections.emptyList();
                if (!recording.privateEditor) {
                    try {
                        entries = Lexicon.list(app);
                    } catch (IOException ignored) {
                        // A damaged lexicon must not prevent dictation.
                    }
                }
                recording.terms = Lexicon.scoped(entries, recording.group);
                Consumer<String> saveRaw = text -> Manuscripts.raw(app, recording.id, text);
                String raw = transcriber == null
                        ? transcribe(recording, wav, saveRaw, Lexicon.hotwords(entries, recording.group))
                        : transcriber.transcribe(wav, saveRaw);
                recording.raw = raw;
                if (raw.trim().isEmpty()) {
                    failure = "未识别到语音";
                } else if (!Polish.enabled(app)) {
                    textToCommit = raw;
                } else {
                    stage = "文字整理";
                    recording.event("开始文字整理");
                    main.post(() -> {
                        if (active == recording && !destroyed && !recording.cancelled) {
                            recording.polishing = true;
                            listener.onVoiceState(POLISHING);
                        }
                    });
                    String polished = Polish.generate(app, raw, recording.application, recording.group,
                            recording.context, recording.terms);
                    if (polished.trim().isEmpty()) {
                        failure = "文字 API 返回空结果";
                    } else {
                        stage = "保存成文";
                        Manuscripts.polished(app, recording.id, polished);
                        textToCommit = polished;
                    }
                }
            }
        } catch (LocalAsr.Failure error) {
            failure = asrFailure(error.reason);
        } catch (Polish.Failure error) {
            failure = error.getMessage();
        } catch (Exception error) {
            // Preserve only stage-level diagnostics. Remote exceptions may contain request data.
            failure = stage + "失败";
        }
        String result = textToCommit;
        String error = failure;
        main.post(() -> complete(recording, result, error));
    }

    private void complete(Recording recording, String text, String failure) {
        try {
            if (text != null) {
                InputConnection target = recording.editor;
                if (destroyed || target == null || target != host.getCurrentInputConnection()) {
                    failure = "输入框已切换，文字已保存到文稿";
                } else {
                    CorrectionWindow observation = !recording.privateEditor && Polish.enabled(app) && !composing.getAsBoolean()
                            ? CorrectionWindow.beforeWrite(target, text, recording.raw, recording.group,
                                    SystemClock.uptimeMillis()) : null;
                    if (!target.commitText(text, 1)) {
                        failure = "无法写入输入框，文字已保存到文稿";
                    } else {
                        if (!recording.terms.isEmpty()) worker.execute(() -> {
                            try {
                                Lexicon.recordMatches(app, recording.terms, text);
                            } catch (IOException ignored) {
                                // Frequency updates do not affect delivered text.
                            }
                        });
                        if (observation != null && observation.confirmWrite()) {
                            correction = observation;
                            main.postAtTime(correctionTimeout, observation.deadline);
                        }
                    }
                }
            }
        } catch (RuntimeException error) {
            failure = "无法写入输入框，文字已保存到文稿";
        } finally {
            recording.event(failure == null ? "已写入输入框" : failure);
            try {
                if (failure != null) Manuscripts.fail(app, recording.id, failure);
                Manuscripts.saveDiagnostics(app, recording.id, recording.diagnostics.toString());
            } catch (RuntimeException ignored) {
                // Always release the session when the storage layer reports an error.
            } finally {
                Manuscripts.end(app, recording.id);
                active = null;
                if (!destroyed) listener.onVoiceState(IDLE);
            }
        }
        if (failure != null && !destroyed && !recording.cancelled) notice(failure);
    }

    private byte[] collect(Recording recording) throws IOException, InterruptedException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        output.write(new byte[WAV_HEADER], 0, WAV_HEADER);
        recorder.record(output, () -> recording.finishRecording);
        if (!recording.finishRecording) {
            main.post(() -> {
                if (active == recording && !recording.stopped) {
                    stop();
                    notice("录音已达到当前可用内存上限，正在处理");
                }
            });
        }
        // Wait until the end of the take has requested its screenshot.
        recording.readyToSave.await();
        return saveAudio(recording, output);
    }

    private byte[] saveAudio(Recording recording, ByteArrayOutputStream output) {
        byte[] wav = output.toByteArray();
        if (wav.length > WAV_HEADER) {
            writeHeader(wav);
            Manuscripts.saveAudio(app, recording.id, wav);
        }
        return wav;
    }

    private static void record(ByteArrayOutputStream output, BooleanSupplier stopped) throws IOException {
        if (stopped.getAsBoolean()) return;
        int byteLimit = recordingByteLimit();
        if (byteLimit <= WAV_HEADER) throw new IOException("Not enough heap for recording");
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) throw new IOException("Unsupported recording format");
        byte[] buffer = new byte[3200];
        AudioRecord mic = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer, buffer.length));
        try {
            if (mic.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
            mic.startRecording();
            if (mic.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone unavailable");
            while (!stopped.getAsBoolean() && output.size() < byteLimit) {
                int available = Math.min(buffer.length, byteLimit - output.size());
                int count = mic.read(buffer, 0, available, AudioRecord.READ_NON_BLOCKING);
                if (count > 0 && count % FRAME_BYTES == 0) {
                    output.write(buffer, 0, count);
                } else if (count == 0) {
                    SystemClock.sleep(10);
                } else {
                    throw new IOException("Microphone read failed");
                }
            }
        } finally {
            try {
                if (mic.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) mic.stop();
            } finally {
                mic.release();
            }
        }
    }

    private static int recordingByteLimit() {
        Runtime runtime = Runtime.getRuntime();
        long used = runtime.totalMemory() - runtime.freeMemory();
        long available = Math.max(0, runtime.maxMemory() - used);
        // Leave headroom for the growing buffer, its final WAV copy, SQLite binding,
        // and work by the keyboard while dictation is active.
        long pcmBudget = Math.min(available / 8, Integer.MAX_VALUE - WAV_HEADER);
        return WAV_HEADER + (int) (pcmBudget - pcmBudget % FRAME_BYTES);
    }

    private String transcribe(Recording recording, byte[] wav, Consumer<String> saveRaw,
                              List<String> hotwords) throws Exception {
        StringBuilder raw = new StringBuilder();
        EditorContext context = recording.context;
        recording.event("连接本地语音识别服务");
        try (LocalAsr client = new LocalAsr(app, speechPackage, recording::event)) {
            client.requireReady();
            int count = client.acceptsHints() ? hotwords.size() : 0;
            boolean hasContext = client.acceptsHints() && (!context.before.isEmpty() || !context.after.isEmpty());
            recording.event("本地识别就绪 · 热词 " + count + " 个 · 光标上下文" + (hasContext ? "已提供" : "未提供"));
            byte[] window = new byte[WAV_HEADER + Math.min(WINDOW_BYTES, wav.length - WAV_HEADER)];
            for (int offset = WAV_HEADER; offset < wav.length; offset += WINDOW_BYTES) {
                int length = Math.min(WINDOW_BYTES, wav.length - offset);
                if (window.length != WAV_HEADER + length) window = new byte[WAV_HEADER + length];
                System.arraycopy(wav, offset, window, WAV_HEADER, length);
                writeHeader(window);
                String recognized = client.transcribeWindow(window, hotwords, context);
                if (!recognized.trim().isEmpty()) {
                    if (raw.length() > 0) raw.append('\n');
                    raw.append(recognized);
                    saveRaw.accept(raw.toString());
                }
            }
        }
        return raw.toString();
    }

    static void writeHeader(byte[] wav) {
        ByteBuffer header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        header.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(wav.length - 8);
        header.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
        header.putShort((short) 1).putShort((short) 1); // PCM, mono
        header.putInt(SAMPLE_RATE).putInt(SAMPLE_RATE * FRAME_BYTES);
        header.putShort((short) FRAME_BYTES).putShort((short) 16);
        header.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(wav.length - WAV_HEADER);
    }

    private static boolean passwordField(EditorInfo info) {
        int type = info.inputType & (InputType.TYPE_MASK_CLASS | InputType.TYPE_MASK_VARIATION);
        return type == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD)
                || type == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)
                || type == (InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)
                || type == (InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
    }

    private static String asrFailure(String reason) {
        switch (reason) {
            case "SERVICE_NOT_INSTALLED": return "未安装本地语音识别服务";
            case "SIGNATURE_MISMATCH": return "言墨和语音识别服务需要使用同一签名";
            case "ACCESS_DENIED": return "言墨没有访问本地语音识别服务的权限";
            case "SERVICE_NOT_AVAILABLE": return "已安装的应用未提供本地语音识别服务";
            case "BIND_FAILED":
                if ("HONOR".equalsIgnoreCase(android.os.Build.MANUFACTURER)) {
                    return "无法连接本地语音识别服务。请在系统「应用启动管理」中为 AI SDK 开启「允许关联启动」";
                }
                return "无法启动本地语音识别服务，请检查系统应用启动设置";
            case "UNSUPPORTED_DEVICE": return "当前设备不支持本地 HTP 语音识别";
            case "MODELS_NOT_INSTALLED":
            case "RUNTIME_NOT_INSTALLED": return "请先安装本地语音识别模型和运行时";
            case "DISCONNECTED": return "本地语音识别服务已断开";
            case "TIMEOUT": return "本地语音识别超时";
            case "BUSY": return "本地语音识别服务正忙";
            default: return "本地语音识别失败";
        }
    }

    private void notice(String message) {
        Toast.makeText(host, message, Toast.LENGTH_SHORT).show();
    }

    private static final class Recording {
        final String id;
        final String application;
        final String group;
        final EditorContext context;
        final boolean privateEditor;
        final long startedAt = SystemClock.elapsedRealtime();
        final StringBuffer diagnostics = new StringBuffer();
        String raw;
        List<Lexicon.Entry> terms = Collections.emptyList();
        final CountDownLatch readyToSave = new CountDownLatch(1);
        InputConnection editor;
        boolean stopped;
        boolean polishing;
        volatile boolean finishRecording;
        volatile boolean cancelled;

        synchronized void event(String message) {
            Log.i(TAG, message);
            if (diagnostics.length() < 2_048) {
                diagnostics.append('+').append(SystemClock.elapsedRealtime() - startedAt)
                        .append(" ms  ").append(message).append('\n');
            }
        }

        Recording(String id, InputConnection editor, String application, EditorContext context, boolean privateEditor) {
            this.id = id;
            this.application = application;
            this.group = Lexicon.applicationGroup(application);
            this.context = context;
            this.privateEditor = privateEditor;
            this.editor = editor;
        }
    }
}
