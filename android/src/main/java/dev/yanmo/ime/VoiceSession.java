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
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.widget.Toast;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** One dictation at a time. The main thread owns the editor and session state. */
public final class VoiceSession {
    public static final int IDLE = 0;
    public static final int RECORDING = 1;
    public static final int PROCESSING = 2;

    private static final int SAMPLE_RATE = 16_000;
    private static final int FRAME_BYTES = 2;
    private static final int WAV_HEADER = 44;
    private static final int WINDOW_BYTES = SAMPLE_RATE * FRAME_BYTES * 24;

    public interface Listener {
        void onVoiceState(int state);
    }

    interface Recorder {
        void record(File wav, BooleanSupplier stopped) throws IOException;
    }

    interface Transcriber {
        String transcribe(File wav, Consumer<String> saveRaw) throws Exception;
    }

    private final InputMethodService host;
    private final Context app;
    private final String speechPackage;
    private final Listener listener;
    private final Recorder recorder;
    private final Transcriber transcriber;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private Recording active;
    private boolean destroyed;

    public VoiceSession(InputMethodService host, String speechPackage, Listener listener) {
        this(host, speechPackage, listener, VoiceSession::record, null);
    }

    VoiceSession(InputMethodService host, String speechPackage, Listener listener, Recorder recorder,
            Transcriber transcriber) {
        this.host = host;
        this.app = host.getApplicationContext();
        this.speechPackage = speechPackage;
        this.listener = listener;
        this.recorder = recorder;
        this.transcriber = transcriber == null ? this::transcribe : transcriber;
    }

    public boolean isRecording() {
        return getState() == RECORDING;
    }

    public int getState() {
        return active == null ? IDLE : active.stopped ? PROCESSING : RECORDING;
    }

    public boolean start() {
        if (active != null || destroyed) return false;
        InputConnection editor = host.getCurrentInputConnection();
        EditorInfo info = host.getCurrentInputEditorInfo();
        if (editor == null || info == null || info.inputType == InputType.TYPE_NULL || passwordField(info)) {
            notice("当前输入框无法使用语音输入");
            return false;
        }
        if (host.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            notice("请先为言墨开启麦克风权限");
            return false;
        }
        try {
            Recording recording = new Recording(Manuscripts.begin(app), editor, info.packageName);
            active = recording;
            worker.execute(() -> process(recording));
            listener.onVoiceState(RECORDING);
            return true;
        } catch (RuntimeException error) {
            notice("无法创建文稿");
            return false;
        }
    }

    public void stop() {
        Recording recording = active;
        if (recording == null || recording.stopped) return;
        recording.stopped = true;
        try {
            Manuscripts.capture(app, recording.id);
        } catch (RuntimeException ignored) {
            // A screenshot failure must not discard the recording or prevent transcription.
        } finally {
            recording.finishRecording = true;
        }
        listener.onVoiceState(PROCESSING);
    }

    public void cancel() {
        Recording recording = active;
        if (recording == null) return;
        recording.editor = null;
        if (recording.stopped) return;
        recording.stopped = true;
        recording.cancelled = true;
        recording.finishRecording = true;
        listener.onVoiceState(PROCESSING);
    }

    public void editorEnded() {
        cancel();
    }

    public void destroy() {
        destroyed = true;
        editorEnded();
        worker.shutdown();
    }

    private void process(Recording recording) {
        String polished = null;
        String failure = null;
        String stage = "录音";
        try {
            File wav = Manuscripts.audio(app, recording.id);
            recorder.record(wav, () -> recording.finishRecording);
            if (recording.cancelled) {
                failure = "录音已取消";
            } else if (wav.length() <= WAV_HEADER) {
                failure = "未采集到音频";
            } else {
                stage = "语音识别";
                String raw = transcriber.transcribe(wav, text -> Manuscripts.raw(app, recording.id, text));
                if (raw.trim().isEmpty()) {
                    failure = "未识别到语音";
                } else if (!Polish.enabled(app)) {
                    failure = "请先在言墨设置中启用文字 API";
                } else {
                    stage = "文字整理";
                    polished = Polish.generate(app, raw, recording.application);
                    if (polished.trim().isEmpty()) {
                        polished = null;
                        failure = "文字 API 返回空结果";
                    } else {
                        stage = "保存成文";
                        Manuscripts.polished(app, recording.id, polished);
                    }
                }
            }
        } catch (LocalAsr.Failure error) {
            failure = asrFailure(error.reason);
        } catch (Polish.Failure error) {
            failure = error.getMessage();
            polished = null;
        } catch (Exception error) {
            // Preserve only stage-level diagnostics. Remote exceptions may contain request data.
            failure = stage + "失败";
            polished = null;
        }
        String result = polished;
        String error = failure;
        main.post(() -> complete(recording, result, error));
    }

    private void complete(Recording recording, String text, String failure) {
        try {
            if (text != null) {
                InputConnection target = recording.editor;
                if (destroyed || target == null || target != host.getCurrentInputConnection()) {
                    failure = "输入框已切换，成文保存在文稿中";
                } else if (!target.commitText(text, 1)) {
                    failure = "无法写入输入框，成文保存在文稿中";
                }
            }
        } catch (RuntimeException error) {
            failure = "无法写入输入框，成文保存在文稿中";
        } finally {
            try {
                if (failure != null) Manuscripts.fail(app, recording.id, failure);
            } catch (RuntimeException ignored) {
                // Always release the session when the storage layer reports an error.
            } finally {
                Manuscripts.end(app, recording.id);
                active = null;
                if (!destroyed) listener.onVoiceState(IDLE);
            }
        }
        if (!destroyed && failure != null && !recording.cancelled) notice(failure);
    }

    private static void record(File wav, BooleanSupplier stopped) throws IOException {
        int minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        if (minBuffer <= 0) throw new IOException("Unsupported recording format");
        byte[] buffer = new byte[3200];
        try (RandomAccessFile output = new RandomAccessFile(wav, "rw")) {
            output.setLength(0);
            writeHeader(output, 0);
            if (stopped.getAsBoolean()) return;
            AudioRecord mic = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(minBuffer, buffer.length));
            try {
                if (mic.getState() != AudioRecord.STATE_INITIALIZED) throw new IOException("Microphone unavailable");
                mic.startRecording();
                if (mic.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) throw new IOException("Microphone unavailable");
                while (!stopped.getAsBoolean()) {
                    int count = mic.read(buffer, 0, buffer.length, AudioRecord.READ_NON_BLOCKING);
                    if (count > 0) {
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
                    writeHeader(output, (int) (output.length() - WAV_HEADER));
                }
            }
        }
    }

    private String transcribe(File wav, Consumer<String> saveRaw) throws Exception {
        File window = File.createTempFile("yanmo-asr-", ".wav", app.getCacheDir());
        StringBuilder raw = new StringBuilder();
        try (LocalAsr client = new LocalAsr(app, speechPackage);
             RandomAccessFile input = new RandomAccessFile(wav, "r");
             RandomAccessFile output = new RandomAccessFile(window, "rw")) {
            client.requireReady();
            byte[] buffer = new byte[WINDOW_BYTES];
            input.seek(WAV_HEADER);
            while (input.getFilePointer() < input.length()) {
                int length = (int) Math.min(WINDOW_BYTES, input.length() - input.getFilePointer());
                input.readFully(buffer, 0, length);
                output.setLength(0);
                writeHeader(output, length);
                output.write(buffer, 0, length);
                String recognized = client.transcribeWindow(window);
                if (!recognized.trim().isEmpty()) {
                    if (raw.length() > 0) raw.append('\n');
                    raw.append(recognized);
                    saveRaw.accept(raw.toString());
                }
            }
        } finally {
            window.delete();
        }
        return raw.toString();
    }

    private static void writeHeader(RandomAccessFile file, int length) throws IOException {
        file.seek(0);
        file.writeBytes("RIFF");
        file.writeInt(Integer.reverseBytes(36 + length));
        file.writeBytes("WAVEfmt ");
        file.writeInt(Integer.reverseBytes(16));
        file.writeShort(Short.reverseBytes((short) 1)); // PCM
        file.writeShort(Short.reverseBytes((short) 1)); // Mono
        file.writeInt(Integer.reverseBytes(SAMPLE_RATE));
        file.writeInt(Integer.reverseBytes(SAMPLE_RATE * FRAME_BYTES));
        file.writeShort(Short.reverseBytes((short) FRAME_BYTES));
        file.writeShort(Short.reverseBytes((short) 16));
        file.writeBytes("data");
        file.writeInt(Integer.reverseBytes(length));
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
            case "ACCESS_DENIED": return "言墨和语音识别服务需要使用同一签名";
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
        InputConnection editor;
        boolean stopped;
        volatile boolean finishRecording;
        volatile boolean cancelled;

        Recording(String id, InputConnection editor, String application) {
            this.id = id;
            this.application = application;
            this.editor = editor;
        }
    }
}
