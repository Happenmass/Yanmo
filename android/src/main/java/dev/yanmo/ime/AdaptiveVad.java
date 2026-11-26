package dev.yanmo.ime;

import java.util.regex.Pattern;

/**
 * Adaptive-noise-floor 20 ms frame VAD (Balanced Tier) and transcript joining helpers,
 * matching Mac's {@code AdaptiveVad.swift} and {@code desktop/prompts.ts}.
 */
final class AdaptiveVad {
    static final int SAMPLE_RATE = 16_000;
    static final int FRAME_BYTES = 2;
    static final int FRAME_MS = 20;
    static final int FRAME_PCM_BYTES = SAMPLE_RATE * FRAME_BYTES * FRAME_MS / 1000; // 640 bytes

    static final int MIN_SPEECH_MS = 260;
    static final int POST_PAD_MS = 320;
    static final int SHORT_UTTERANCE_MS = 2_500;
    static final int LONG_UTTERANCE_MS = 15_000;
    static final int PAUSE_SHORT_MS = 1_200;
    static final int PAUSE_MEDIUM_MS = 800;
    static final int PAUSE_LONG_MS = 400;
    static final int MAX_SEGMENT_MS = 24_000;

    private static final double MIN_NOISE_FLOOR = 0.0004;
    private static final double MAX_NOISE_FLOOR = 0.025;
    private static final double MIN_ENTER_THRESHOLD = 0.0025;
    private static final double MIN_EXIT_THRESHOLD = 0.0016;
    private static final Pattern PRIOR_ASCII_TAIL = Pattern.compile(".*[A-Za-z0-9.,!?;:]$", Pattern.DOTALL);
    private static final Pattern NEXT_ASCII_HEAD = Pattern.compile("^[A-Za-z0-9].*", Pattern.DOTALL);

    static final class Segment {
        final int startByte;
        final int endByte;
        final int speechMs;

        Segment(int startByte, int endByte, int speechMs) {
            this.startByte = startByte;
            this.endByte = endByte;
            this.speechMs = speechMs;
        }
    }

    private final int sampleRate;
    private final int postPadBytes;
    private final int silentCapKeepBytes;
    private int emittedCount = 0;
    private double noiseRms = 0.0015;
    private boolean initialized = false;
    private boolean inSpeech = false;
    private boolean hasSpeech = false;
    private int lastCutByte = 0;
    private int speechOnsetByte = 0;
    private int lastSpeechEndByte = 0;
    private int speechMs = 0;
    private double tailPeakRms = 0.0;

    AdaptiveVad() {
        this(SAMPLE_RATE);
    }

    AdaptiveVad(int sampleRate) {
        this.sampleRate = Math.max(1, sampleRate);
        this.postPadBytes = alignEven((int) Math.round(this.sampleRate * FRAME_BYTES * (POST_PAD_MS / 1000.0)));
        this.silentCapKeepBytes = alignEven((int) Math.round(this.sampleRate * FRAME_BYTES * 0.5));
    }

    int emittedCount() {
        return emittedCount;
    }

    Segment feedPcmFrame(byte[] pcm, int offset, int length, int pcmStartByte) {
        if (length < FRAME_BYTES) return null;
        int samples = length / FRAME_BYTES;
        double sumSq = 0.0;
        for (int i = 0; i < samples; i++) {
            int idx = offset + i * FRAME_BYTES;
            short sample = (short) ((pcm[idx] & 0xff) | (pcm[idx + 1] << 8));
            double norm = sample / 32768.0;
            sumSq += norm * norm;
        }
        double rms = Math.sqrt(sumSq / samples);
        int endByte = pcmStartByte + samples * FRAME_BYTES;
        return feedRms(rms, pcmStartByte, endByte);
    }

    Segment feedRms(double frameRms, int frameStartByte, int frameEndByte) {
        if (frameEndByte <= frameStartByte) return null;
        int frameMs = bytesToMs(frameEndByte - frameStartByte);

        if (!initialized) {
            initialized = true;
            noiseRms = clampNoise(Math.min(frameRms, 0.003));
        } else if (frameRms < noiseRms) {
            noiseRms = clampNoise(0.85 * noiseRms + 0.15 * frameRms);
        }

        double enterThreshold = Math.max(MIN_ENTER_THRESHOLD, noiseRms * 2.6);
        double exitThreshold = Math.max(MIN_EXIT_THRESHOLD, noiseRms * 1.7);
        boolean isSpeech = inSpeech ? (frameRms >= exitThreshold) : (frameRms >= enterThreshold);
        if (frameRms > tailPeakRms) {
            tailPeakRms = frameRms;
        }

        if (isSpeech) {
            if (!hasSpeech) {
                hasSpeech = true;
                speechOnsetByte = frameStartByte;
                speechMs = 0;
            }
            inSpeech = true;
            lastSpeechEndByte = frameEndByte;
            speechMs += frameMs;
        } else {
            inSpeech = false;
            if (frameRms < enterThreshold) {
                noiseRms = clampNoise(0.995 * noiseRms + 0.005 * frameRms);
            }
            if (hasSpeech) {
                int silenceMs = bytesToMs(frameEndByte - lastSpeechEndByte);
                int utteranceMs = bytesToMs(lastSpeechEndByte - speechOnsetByte);
                int pauseThreshold = pauseThresholdMs(utteranceMs);
                if (silenceMs >= pauseThreshold) {
                    if (speechMs >= MIN_SPEECH_MS) {
                        int pad = alignEven(Math.min(postPadBytes, (frameEndByte - lastSpeechEndByte) / 2));
                        int cut = alignEven(Math.min(frameEndByte, lastSpeechEndByte + pad));
                        if (cut > lastCutByte) {
                            Segment seg = emit(lastCutByte, cut, speechMs);
                            resetSegment();
                            return seg;
                        }
                    } else {
                        resetSegment();
                        return null;
                    }
                }
            }
        }

        if (bytesToMs(frameEndByte - lastCutByte) >= MAX_SEGMENT_MS) {
            if (hasSpeech && speechMs >= MIN_SPEECH_MS) {
                Segment seg = emit(lastCutByte, frameEndByte, speechMs);
                resetSegment();
                return seg;
            } else if (!hasSpeech && emittedCount == 0) {
                lastCutByte = Math.max(lastCutByte, alignEven(frameEndByte - silentCapKeepBytes));
                resetSegment();
            }
        }
        return null;
    }

    Segment finish(int totalPcmBytes) {
        int alignedTotal = alignEven(Math.max(0, totalPcmBytes));
        if (alignedTotal <= 0) return null;
        if (emittedCount == 0) {
            Segment seg = emit(0, alignedTotal, bytesToMs(alignedTotal));
            resetSegment();
            return seg;
        }
        if (alignedTotal <= lastCutByte) return null;
        double exitThreshold = Math.max(MIN_EXIT_THRESHOLD, noiseRms * 1.7);
        if (hasSpeech || tailPeakRms >= exitThreshold) {
            Segment seg = emit(lastCutByte, alignedTotal, Math.max(speechMs, 1));
            resetSegment();
            return seg;
        }
        return null;
    }

    static String joinDelta(String prior, String next) {
        String cleanNext = next == null ? "" : next.trim();
        if (cleanNext.isEmpty()) return "";
        String cleanPrior = prior == null ? "" : prior.trim();
        if (cleanPrior.isEmpty()) return cleanNext;
        boolean needsSpace = PRIOR_ASCII_TAIL.matcher(cleanPrior).matches()
                && NEXT_ASCII_HEAD.matcher(cleanNext).matches();
        return (needsSpace ? " " : "") + cleanNext;
    }

    static String joinTranscript(String prior, String next) {
        String cleanPrior = prior == null ? "" : prior.trim();
        String delta = joinDelta(cleanPrior, next);
        if (delta.isEmpty()) return cleanPrior;
        return cleanPrior.isEmpty() ? delta : cleanPrior + delta;
    }

    static String combineBeforeContext(String editorBefore, String priorTranscript, int maxChars) {
        String cleanEditor = editorBefore == null ? "" : editorBefore.trim();
        String cleanPrior = priorTranscript == null ? "" : priorTranscript.trim();
        String combined;
        if (cleanPrior.isEmpty()) {
            combined = cleanEditor;
        } else if (cleanEditor.isEmpty()) {
            combined = cleanPrior;
        } else {
            combined = joinTranscript(cleanEditor, cleanPrior);
        }
        if (combined.length() <= maxChars) return combined;
        return combined.substring(combined.length() - maxChars);
    }

    private Segment emit(int startByte, int endByte, int speechMs) {
        emittedCount += 1;
        lastCutByte = endByte;
        tailPeakRms = 0.0;
        return new Segment(startByte, endByte, speechMs);
    }

    private void resetSegment() {
        inSpeech = false;
        hasSpeech = false;
        speechOnsetByte = lastCutByte;
        lastSpeechEndByte = lastCutByte;
        speechMs = 0;
    }

    private static int pauseThresholdMs(int utteranceMs) {
        if (utteranceMs < SHORT_UTTERANCE_MS) return PAUSE_SHORT_MS;
        if (utteranceMs < LONG_UTTERANCE_MS) return PAUSE_MEDIUM_MS;
        return PAUSE_LONG_MS;
    }

    private int bytesToMs(int bytes) {
        if (bytes <= 0) return 0;
        return (int) Math.round((bytes * 1000.0) / (sampleRate * (double) FRAME_BYTES));
    }

    private static int alignEven(int bytes) {
        return bytes - (bytes % FRAME_BYTES);
    }

    private static double clampNoise(double value) {
        return Math.min(MAX_NOISE_FLOOR, Math.max(MIN_NOISE_FLOOR, value));
    }
}
