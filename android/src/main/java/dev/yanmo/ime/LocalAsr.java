package dev.yanmo.ime;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.ParcelFileDescriptor;
import android.os.ProxyFileDescriptorCallback;
import android.os.RemoteException;
import android.os.storage.StorageManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Android Agent SDK SpeechWire V1 client for the prototype's Java overlay. */
final class LocalAsr implements AutoCloseable {
    private static final String ACTION = "dev.androidagent.action.SPEECH_SERVICE_V1";
    private static final int STATUS = 1;
    private static final int ASR = 2;
    private static final int CANCEL = 4;

    private final Context app;
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
    private HandlerThread audioCallbacks;

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
        this.app = app;
        int match = app.getPackageManager().checkSignatures(app.getPackageName(), servicePackage);
        if (match == PackageManager.SIGNATURE_UNKNOWN_PACKAGE) throw new Failure("SERVICE_NOT_INSTALLED");
        if (match != PackageManager.SIGNATURE_MATCH) throw new Failure("ACCESS_DENIED");
        try {
            bound = app.bindService(new Intent(ACTION).setPackage(servicePackage), connection, Context.BIND_AUTO_CREATE);
        } catch (SecurityException error) {
            throw new Failure("ACCESS_DENIED");
        }
        if (!bound) throw new Failure("SERVICE_NOT_INSTALLED");
    }

    void requireReady() throws Failure {
        String status = request(STATUS, new Bundle(), 5).getString("asr");
        if (status == null) throw new Failure("INVALID_REPLY");
        if (!status.equals("READY")) throw new Failure(status);
    }

    String transcribeWindow(byte[] window) throws IOException {
        ParcelFileDescriptor memory;
        try {
            memory = openProxyAudio(new WavReader(window));
        } catch (IOException unavailable) {
            memory = null;
        }
        try (ParcelFileDescriptor audio = memory != null ? memory : openUnlinkedAudio(window)) {
            String text = requestAudio(ASR, audio, 120).getString("text");
            if (text == null) throw new Failure("INVALID_REPLY");
            return text;
        }
    }

    Bundle requestAudio(int operation, ParcelFileDescriptor audio, long timeoutSeconds) throws Failure {
        Bundle input = new Bundle();
        input.putParcelable("audio", audio);
        return request(operation, input, timeoutSeconds);
    }

    ParcelFileDescriptor openProxyAudio(WavReader reader) throws IOException {
        StorageManager storage = app.getSystemService(StorageManager.class);
        if (storage == null) throw new IOException("Proxy file descriptors are unavailable");
        if (audioCallbacks == null) {
            audioCallbacks = new HandlerThread("YanmoAsrAudio");
            audioCallbacks.start();
        }
        ParcelFileDescriptor audio = storage.openProxyFileDescriptor(ParcelFileDescriptor.MODE_READ_ONLY,
                reader, new Handler(audioCallbacks.getLooper()));
        if (audio.getStatSize() == reader.onGetSize()) return audio;
        audio.close();
        throw new IOException("The proxy descriptor does not report its audio size");
    }

    static class WavReader extends ProxyFileDescriptorCallback {
        private final byte[] wav;

        WavReader(byte[] wav) {
            this.wav = wav;
        }

        @Override public long onGetSize() {
            return wav.length;
        }

        @Override public int onRead(long offset, int size, byte[] buffer) {
            if (offset >= wav.length || size <= 0) return 0;
            int count = Math.min(size, wav.length - (int) offset);
            System.arraycopy(wav, (int) offset, buffer, 0, count);
            return count;
        }

        @Override public void onRelease() {}
    }

    private ParcelFileDescriptor openUnlinkedAudio(byte[] window) throws IOException {
        File file = File.createTempFile("asr-", ".wav", app.getCacheDir());
        try (FileOutputStream output = new FileOutputStream(file)) {
            ParcelFileDescriptor audio = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
            boolean success = false;
            try {
                // Remove the name before writing a byte, including for process death mid-request.
                if (!file.delete()) throw new IOException("Cannot unlink the temporary ASR window");
                output.write(window);
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
        Messenger server = await(connected, 5, "DISCONNECTED");
        Request request = new Request();
        pending = request;
        if (disconnected) {
            pending = null;
            throw new Failure("DISCONNECTED");
        }
        data.putString("id", request.id);
        boolean received = false;
        try {
            send(server, operation, data);
            Bundle reply = await(request.reply, timeoutSeconds, "TIMEOUT");
            received = true;
            String error = reply.getString("error");
            if (error != null) throw new Failure(error);
            return reply;
        } catch (RemoteException failure) {
            throw new Failure("DISCONNECTED");
        } finally {
            pending = null;
            if (!received) {
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
        if (audioCallbacks != null) audioCallbacks.quitSafely();
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

        Failure(String reason) {
            this.reason = reason;
        }
    }
}
