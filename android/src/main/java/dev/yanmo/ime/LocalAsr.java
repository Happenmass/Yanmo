package dev.yanmo.ime;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;
import android.os.SystemClock;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/** Android Agent SDK SpeechWire V1 client. */
final class LocalAsr implements AutoCloseable {
    private static final String ACTION = "dev.androidagent.action.SPEECH_SERVICE_V1";
    private static final int STATUS = 1;
    private static final int ASR = 2;
    private static final int CANCEL = 4;
    private static final Pattern CODE = Pattern.compile("[A-Z0-9_]{1,64}");
    private static final Pattern DETAIL = Pattern.compile("[A-Z0-9_]{1,64}|QNN [a-zA-Z0-9_ ]{1,60}|[A-Za-z0-9_]{1,55}(?:Exception|Error)");
    private static final Pattern NATIVE = Pattern.compile("0x[0-9a-f]{1,16}|(?:errno|exit) -?[0-9]{1,10}");

    private final Context app;
    private final Consumer<String> diagnostics;
    private final CompletableFuture<Messenger> connected = new CompletableFuture<>();
    private volatile Request pending;
    private final Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), message -> {
        Bundle data = message.getData();
        Request request = pending;
        if (request != null && request.id.equals(data.getString("id"))) request.reply.complete(data);
        return true;
    }));

    private volatile boolean disconnected;
    private boolean bound;
    private boolean acceptsHints;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            connected.complete(new Messenger(binder));
        }

        @Override public void onServiceDisconnected(ComponentName name) {
            disconnected = true;
            Failure failure = new Failure("DISCONNECTED");
            connected.completeExceptionally(failure);
            Request request = pending;
            if (request != null) request.reply.completeExceptionally(failure);
        }

        @Override public void onBindingDied(ComponentName name) {
            onServiceDisconnected(name);
        }

        @Override public void onNullBinding(ComponentName name) {
            onServiceDisconnected(name);
        }
    };

    LocalAsr(Context app, String servicePackage) throws Failure {
        this(app, servicePackage, event -> {});
    }

    LocalAsr(Context app, String servicePackage, Consumer<String> diagnostics) throws Failure {
        this.app = app;
        this.diagnostics = diagnostics;
        PackageManager packages = app.getPackageManager();
        ApplicationInfo sdk;
        try {
            sdk = packages.getApplicationInfo(servicePackage, 0);
        } catch (PackageManager.NameNotFoundException error) {
            throw new Failure("SERVICE_NOT_INSTALLED");
        }
        if (packages.checkSignatures(app.getPackageName(), servicePackage) != PackageManager.SIGNATURE_MATCH) {
            throw new Failure("SIGNATURE_MISMATCH");
        }
        Intent intent = new Intent(ACTION).setPackage(servicePackage);
        ResolveInfo resolved = packages.resolveService(intent, 0);
        if (resolved == null || resolved.serviceInfo == null || !resolved.serviceInfo.exported) {
            throw new Failure("SERVICE_NOT_AVAILABLE");
        }
        intent.setComponent(new ComponentName(resolved.serviceInfo.packageName, resolved.serviceInfo.name));
        try {
            bound = app.bindService(intent, connection, Context.BIND_AUTO_CREATE);
        } catch (SecurityException error) {
            throw new Failure("ACCESS_DENIED");
        }
        if (!bound) {
            diagnostics.accept("系统拒绝绑定 · SDK 停止标记 " +
                    ((sdk.flags & ApplicationInfo.FLAG_STOPPED) != 0 ? "开启" : "关闭"));
            try {
                app.unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // The OS may have already discarded the rejected connection.
            }
            throw new Failure("BIND_FAILED");
        }
    }

    void requireReady() throws Failure {
        Bundle result = request(STATUS, new Bundle(), 5);
        acceptsHints = result.getBoolean("asrHints");
        String status = result.getString("asr");
        if (!"READY".equals(status)) {
            throw new Failure(status == null ? "INVALID_REPLY" : code(status),
                    "stage=STATUS_REPLY request=" + result.getString("id", "-") + " sdkPid=" + result.getInt("servicePid"));
        }
    }

    boolean acceptsHints() { return acceptsHints; }

    String transcribeWindow(byte[] window, List<String> hotwords, EditorContext context) throws IOException {
        long started = SystemClock.elapsedRealtime();
        String transport = "fd=FILE wavBytes=" + window.length;
        try (ParcelFileDescriptor audio = openUnlinkedAudio(window)) {
            Bundle input = new Bundle();
            input.putParcelable("audio", audio);
            if (acceptsHints) {
                if (!hotwords.isEmpty()) input.putStringArrayList("hotwords", new ArrayList<>(hotwords));
                if (!context.before.isEmpty()) input.putString("textBeforeCursor", context.before);
                if (!context.after.isEmpty()) input.putString("textAfterCursor", context.after);
            }
            long sent = SystemClock.elapsedRealtime();
            try {
                Bundle reply = request(ASR, input, 120);
                logTiming(reply, sent - started, SystemClock.elapsedRealtime() - sent, transport);
                String text = reply.getString("text");
                if (text == null) throw new Failure("INVALID_REPLY", "stage=BINDER_REPLY request=" + reply.getString("id", "-"));
                return text;
            } catch (Failure failure) {
                diagnostics.accept("识别请求耗时 " + (SystemClock.elapsedRealtime() - sent) + " ms");
                throw new Failure(failure.reason, failure.details + " " + transport + " fdMs=" + (sent - started));
            }
        } catch (Failure failure) {
            throw failure;
        } catch (IOException failure) {
            throw new Failure("AUDIO_DESCRIPTOR_IO", "stage=AUDIO_DESCRIPTOR " + transport
                    + " throwable=" + failure.getClass().getSimpleName());
        }
    }

    private void logTiming(Bundle reply, long descriptorMs, long requestMs, String transport) {
        StringBuilder line = new StringBuilder("识别计时 · 音频描述符 ").append(descriptorMs)
                .append(" ms · 请求往返 ").append(requestMs).append(" ms");
        appendTime(line, reply, "prepareMs", "权重准备");
        appendTime(line, reply, "audioTransferMs", "音频交接");
        appendTime(line, reply, "inferenceMs", "推理总计");
        appendTime(line, reply, "modelLoadMs", "模型加载");
        appendTime(line, reply, "frontendMs", "前端与预填");
        appendTime(line, reply, "decodeMs", "解码");
        diagnostics.accept(line.append(" · ").append(transport).toString());
    }

    private static void appendTime(StringBuilder line, Bundle reply, String key, String label) {
        if (reply.containsKey(key)) {
            double value = reply.getDouble(key);
            if (Double.isFinite(value) && value >= 0) {
                line.append(" · ").append(label).append(' ').append(Math.round(value)).append(" ms");
            }
        }
    }

    Bundle requestAudio(int operation, ParcelFileDescriptor audio, long timeoutSeconds) throws Failure {
        Bundle input = new Bundle();
        input.putParcelable("audio", audio);
        return request(operation, input, timeoutSeconds);
    }

    ParcelFileDescriptor openUnlinkedAudio(byte[] window) throws IOException {
        File file = File.createTempFile("asr-", ".wav", app.getCacheDir());
        try {
            ParcelFileDescriptor audio = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            boolean success = false;
            try {
                try (FileOutputStream output = new FileOutputStream(file)) {
                    // Unlink before writing so the audio is reachable only through the open descriptors.
                    if (!file.delete()) throw new IOException("Cannot unlink the temporary ASR window");
                    output.write(window);
                }
                success = true;
                return audio;
            } finally {
                if (!success) audio.close();
            }
        } finally {
            file.delete();
        }
    }

    private Bundle request(int operation, Bundle data, long timeoutSeconds) throws Failure {
        Request request = new Request();
        Messenger server = null;
        String stage = "BINDER_CONNECT";
        long started = SystemClock.elapsedRealtime();
        boolean sent = false;
        data.putString("id", request.id);
        boolean received = false;
        try {
            server = await(connected, 5, "CONNECT_TIMEOUT");
            pending = request;
            if (disconnected) throw new Failure("DISCONNECTED");
            stage = "BINDER_SEND";
            send(server, operation, data);
            sent = true;
            stage = "BINDER_REPLY";
            Bundle reply = await(request.reply, timeoutSeconds, "TIMEOUT");
            received = true;
            String error = reply.getString("error");
            if (error != null) {
                if (operation == ASR) {
                    String phase = reply.getString("asrPhase", "");
                    switch (phase) {
                        case "prepare": diagnostics.accept("SDK 中断于权重准备"); break;
                        case "transfer": diagnostics.accept("SDK 中断于音频交接"); break;
                        case "inference": diagnostics.accept("SDK 中断于推理"); break;
                        default: break;
                    }
                }
                StringBuilder details = new StringBuilder("sdkPid=").append(reply.getInt("servicePid"));
                appendSafe(details, "asrPhase", reply.getString("asrPhase"), Pattern.compile("prepare|transfer|inference"));
                appendSafe(details, "sdkStage", reply.getString("failureStage"), CODE);
                appendSafe(details, "sdkDetail", reply.getString("failureDetail"), DETAIL);
                appendSafe(details, "native", reply.getString("nativeErrorCode"), NATIVE);
                if (reply.containsKey("failureElapsedMs")) details.append(" sdkMs=").append(reply.getLong("failureElapsedMs"));
                throw new Failure(code(error), details.toString());
            }
            return reply;
        } catch (RemoteException failure) {
            throw new Failure("DISCONNECTED", requestDetails(operation, request.id, stage, started)
                    + " throwable=" + failure.getClass().getSimpleName());
        } catch (Failure failure) {
            throw new Failure(failure.reason, requestDetails(operation, request.id, stage, started)
                    + (failure.details.isEmpty() ? "" : " " + failure.details));
        } finally {
            pending = null;
            if (sent && !received) {
                Bundle cancel = new Bundle();
                cancel.putString("id", request.id);
                try {
                    send(server, CANCEL, cancel);
                } catch (RemoteException ignored) {
                    // Service is already disconnected.
                }
            }
        }
    }

    private static String requestDetails(int operation, String requestId, String stage, long started) {
        String op = operation == ASR ? "ASR" : operation == STATUS ? "STATUS" : "SPEAKERS";
        return "operation=" + op + " stage=" + stage + " request=" + requestId
                + " roundTripMs=" + (SystemClock.elapsedRealtime() - started);
    }

    private static String code(String value) {
        return value != null && CODE.matcher(value).matches() ? value : "UNKNOWN_SDK_ERROR";
    }

    private static void appendSafe(StringBuilder details, String key, String value, Pattern pattern) {
        if (value != null && value.length() <= 64 && pattern.matcher(value).matches()) {
            details.append(' ').append(key).append('=').append(value);
        }
    }

    private void send(Messenger server, int operation, Bundle data) throws RemoteException {
        Message message = Message.obtain(null, operation);
        message.setData(data);
        message.replyTo = replies;
        server.send(message);
    }

    private static <T> T await(CompletableFuture<T> future, long seconds, String timeout) throws Failure {
        try {
            return future.get(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new Failure("CANCELLED");
        } catch (ExecutionException error) {
            throw new Failure("DISCONNECTED");
        } catch (TimeoutException error) {
            throw new Failure(timeout);
        }
    }

    @Override public void close() {
        if (bound) {
            app.unbindService(connection);
            bound = false;
        }
    }

    private static final class Request {
        final String id = UUID.randomUUID().toString();
        final CompletableFuture<Bundle> reply = new CompletableFuture<>();
    }

    static final class Failure extends IOException {
        final String reason;
        final String details;

        Failure(String reason) {
            this(reason, "");
        }

        Failure(String reason, String details) {
            this.reason = reason;
            this.details = details;
        }
    }
}
