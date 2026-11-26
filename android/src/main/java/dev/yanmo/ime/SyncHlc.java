package dev.yanmo.ime;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Hybrid Logical Clock matching {@code desktop/sync-hlc.ts}.
 * Format: {@code <14-digit-ms>-<4-hex-counter>-<deviceId>}.
 */
final class SyncHlc {
    static final long MAX_REMOTE_CLOCK_DRIFT_MS = 300_000L;
    private static final Pattern HLC_PATTERN = Pattern.compile("^(\\d{14})-([0-9a-f]{4})-(.+)$");

    private SyncHlc() {}

    interface NowMillis {
        long nowMs();
    }

    static final class ParsedHlc {
        final long ms;
        final int counter;
        final String deviceId;

        ParsedHlc(long ms, int counter, String deviceId) {
            this.ms = ms;
            this.counter = counter;
            this.deviceId = deviceId;
        }
    }

    static final class ReceiveResult {
        final String hlc;
        final boolean driftClamped;

        ReceiveResult(String hlc, boolean driftClamped) {
            this.hlc = hlc;
            this.driftClamped = driftClamped;
        }
    }

    static String formatHlc(long ms, int counter, String deviceId) {
        if (ms < 0) {
            throw new IllegalArgumentException("无效的 HLC 毫秒时间戳: " + ms);
        }
        if (counter < 0 || counter > 0xffff) {
            throw new IllegalArgumentException("无效的 HLC 计数器: " + counter);
        }
        String cleanDevice = deviceId == null ? "" : deviceId.trim();
        if (cleanDevice.isEmpty()) {
            throw new IllegalArgumentException("HLC deviceId 不能为空。");
        }
        return String.format(Locale.ROOT, "%014d-%04x-%s", ms, counter, cleanDevice);
    }

    static ParsedHlc parseHlc(String hlc) {
        if (hlc == null) throw new IllegalArgumentException("HLC 不能为空。");
        Matcher m = HLC_PATTERN.matcher(hlc.trim());
        if (!m.matches()) {
            throw new IllegalArgumentException("HLC 格式无效: " + hlc);
        }
        long ms = Long.parseLong(m.group(1));
        int counter = Integer.parseInt(m.group(2), 16);
        String deviceId = m.group(3);
        if (ms < 0 || counter < 0 || deviceId.isEmpty()) {
            throw new IllegalArgumentException("HLC 数值无效: " + hlc);
        }
        return new ParsedHlc(ms, counter, deviceId);
    }

    static int compareHlc(String a, String b) {
        if (a.equals(b)) return 0;
        return a.compareTo(b) < 0 ? -1 : 1;
    }

    static final class Clock {
        final String deviceId;
        private long lastMs;
        private int counter;
        private final NowMillis nowFn;

        Clock(String deviceId, long initialLastMs, int initialCounter, NowMillis nowFn) {
            if (deviceId == null || deviceId.trim().isEmpty()) {
                throw new IllegalArgumentException("HlcClock deviceId 不能为空。");
            }
            this.deviceId = deviceId.trim();
            this.lastMs = initialLastMs;
            this.counter = initialCounter;
            this.nowFn = nowFn == null ? System::currentTimeMillis : nowFn;
        }

        Clock(String deviceId, long initialLastMs, int initialCounter) {
            this(deviceId, initialLastMs, initialCounter, System::currentTimeMillis);
        }

        long lastMs() { return lastMs; }
        int counter() { return counter; }

        synchronized String tick() {
            long pt = Math.max(0L, nowFn.nowMs());
            if (pt > lastMs) {
                lastMs = pt;
                counter = 0;
            } else {
                counter += 1;
                if (counter > 0xffff) {
                    lastMs += 1;
                    counter = 0;
                }
            }
            return formatHlc(lastMs, counter, deviceId);
        }

        synchronized ReceiveResult receive(String remoteHlc) {
            ParsedHlc parsed = parseHlc(remoteHlc);
            long pt = Math.max(0L, nowFn.nowMs());
            long maxAllowedMs = pt + MAX_REMOTE_CLOCK_DRIFT_MS;
            boolean driftClamped = parsed.ms > maxAllowedMs;
            long effectiveRemoteMs = driftClamped ? maxAllowedMs : parsed.ms;

            long prevMs = lastMs;
            long nextMs = Math.max(prevMs, Math.max(effectiveRemoteMs, pt));
            if (nextMs == prevMs && nextMs == effectiveRemoteMs && !driftClamped) {
                counter = Math.max(counter, parsed.counter) + 1;
            } else if (nextMs == prevMs) {
                counter += 1;
            } else if (nextMs == effectiveRemoteMs && !driftClamped) {
                counter = parsed.counter + 1;
            } else {
                counter = 0;
            }

            if (counter > 0xffff) {
                lastMs = nextMs + 1;
                counter = 0;
            } else {
                lastMs = nextMs;
            }
            return new ReceiveResult(formatHlc(lastMs, counter, deviceId), driftClamped);
        }
    }
}
