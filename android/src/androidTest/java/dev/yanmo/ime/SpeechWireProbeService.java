package dev.yanmo.ime;

import android.app.Service;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.ParcelFileDescriptor;
import android.os.RemoteException;
import android.util.Log;

import java.io.DataInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/** Test-only SpeechWire endpoint in another process. It validates the audio before returning text. */
public final class SpeechWireProbeService extends Service {
    private static final int SAMPLE_RATE = 16_000;
    private static final int FIRST_BYTES = SAMPLE_RATE * 2 * 24;
    private static final int TAIL_BYTES = 2_014;
    private static final String[] TEXT = {"我我明天", "跟 Kai 开会"};
    static final String TRANSCRIPT = TEXT[0] + "\n" + TEXT[1];

    private final Messenger endpoint = new Messenger(new Handler(Looper.getMainLooper(), this::receive));
    private int windows;
    private boolean ready;

    static byte[] pcm() {
        byte[] pcm = new byte[FIRST_BYTES + TAIL_BYTES];
        for (int i = 0; i < pcm.length; i++) pcm[i] = sampleByte(i);
        return pcm;
    }

    @Override public IBinder onBind(Intent intent) {
        return endpoint.getBinder();
    }

    private boolean receive(Message message) {
        Bundle data = message.getData();
        Bundle response = new Bundle();
        response.putString("id", data.getString("id"));
        try {
            switch (message.what) {
                case 1: // STATUS
                    require(!ready, "duplicate status request");
                    ready = true;
                    response.putString("asr", "READY");
                    response.putBoolean("asrHints", true);
                    break;
                case 2: // ASR
                    try (ParcelFileDescriptor audio = data.getParcelable("audio")) {
                        require(ready && windows < 2 && audio != null, "unexpected ASR request");
                        require(java.util.Arrays.asList("Kai Chen", "项目晨星").equals(data.getStringArrayList("hotwords")),
                                "wrong ASR term scope or order");
                        String before = data.getString("textBeforeCursor");
                        String after = data.getString("textAfterCursor");
                        require(before != null && after != null && before.length() == 300 && after.length() == 300
                                        && before.charAt(0) == '前' && after.charAt(299) == '后',
                                "wrong ASR cursor context");
                        validate(audio, windows);
                        response.putString("text", TEXT[windows++]);
                        response.putDouble("prepareMs", 3);
                        response.putDouble("audioTransferMs", 4);
                        response.putDouble("inferenceMs", 50);
                        response.putDouble("modelLoadMs", 18);
                        response.putDouble("frontendMs", 11);
                        response.putDouble("decodeMs", 20);
                    }
                    break;
                default:
                    throw new AssertionError("unexpected speech opcode: " + message.what);
            }
        } catch (AssertionError | IOException error) {
            Log.e("SpeechWireProbe", "invalid request", error);
            response.putString("error", "INVALID_AUDIO");
        }
        Message reply = Message.obtain();
        reply.setData(response);
        try {
            message.replyTo.send(reply);
        } catch (RemoteException ignored) {
            // The test caller has stopped.
        }
        return true;
    }

    private static void validate(ParcelFileDescriptor audio, int window) throws IOException {
        int length = window == 0 ? FIRST_BYTES : TAIL_BYTES;
        int offset = window == 0 ? 0 : FIRST_BYTES;
        require(audio.getStatSize() == length + 44L, "wrong descriptor length at window " + window);
        try (DataInputStream input = new DataInputStream(
                new ParcelFileDescriptor.AutoCloseInputStream(audio.dup()))) {
            byte[] bytes = new byte[8192];
            input.readFully(bytes, 0, 44);
            ByteBuffer header = ByteBuffer.wrap(bytes, 0, 44).order(ByteOrder.LITTLE_ENDIAN);
            tag(header, "RIFF");
            require(header.getInt() == length + 36, "wrong RIFF length");
            tag(header, "WAVEfmt ");
            require(header.getInt() == 16 && header.getShort() == 1 && header.getShort() == 1,
                    "expected PCM mono");
            require(header.getInt() == SAMPLE_RATE && header.getInt() == SAMPLE_RATE * 2,
                    "wrong sample or byte rate");
            require(header.getShort() == 2 && header.getShort() == 16, "expected PCM16 alignment");
            tag(header, "data");
            require(header.getInt() == length, "wrong payload length");
            for (int read = 0; read < length;) {
                int count = Math.min(bytes.length, length - read);
                input.readFully(bytes, 0, count);
                for (int i = 0; i < count; i++) {
                    if (bytes[i] != sampleByte(offset + read + i)) {
                        throw new AssertionError("wrong PCM byte at " + (offset + read + i));
                    }
                }
                read += count;
            }
            require(input.read() == -1, "unexpected trailing PCM");
        }
    }

    private static byte sampleByte(int offset) {
        int value = offset * 0x6d2b79f5;
        return (byte) (value ^ (value >>> 16));
    }

    private static void tag(ByteBuffer header, String expected) {
        byte[] tag = new byte[expected.length()];
        header.get(tag);
        require(expected.equals(new String(tag, StandardCharsets.US_ASCII)), "missing WAV tag: " + expected);
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
