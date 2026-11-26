package dev.yanmo.ime;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * Pure-Java sparse background synchronization policy and daily schedule calculations.
 */
final class SyncPolicy {
    static final int DEFAULT_CHANGE_THRESHOLD = 10;
    static final int DEFAULT_DAILY_HOUR = 22;
    static final int DEFAULT_DAILY_MINUTE = 0;
    static final long FULL_SYNC_MAX_AGE_MS = 24L * 60L * 60L * 1000L;
    static final long FAILURE_COOLDOWN_MS = 60L * 60L * 1000L;
    static final long TOMBSTONE_GC_INTERVAL_MS = 24L * 60L * 60L * 1000L;
    static final long IME_IDLE_DELAY_MS = 3_000L;

    private static final long MIN_JOB_DELAY_MS = 15_000L;
    private static final long DUE_SOON_DELAY_MS = 60_000L;

    enum AutoTrigger {
        DAILY_JOB,
        NETWORK_AVAILABLE,
        IME_IDLE,
        APP_RESUME
    }

    static final class Decision {
        final boolean shouldRun;
        final boolean fullSync;
        final String reason;

        Decision(boolean shouldRun, boolean fullSync, String reason) {
            this.shouldRun = shouldRun;
            this.fullSync = fullSync;
            this.reason = reason;
        }
    }

    private SyncPolicy() {}

    static int clampHour(int hour) {
        return Math.max(0, Math.min(23, hour));
    }

    static int clampMinute(int minute) {
        return Math.max(0, Math.min(59, minute));
    }

    static boolean isDailyFullSyncDue(
            long nowMs,
            long lastFullSyncAtMs,
            int dailyHour,
            int dailyMinute,
            ZoneId zone
    ) {
        if (lastFullSyncAtMs <= 0L) {
            return true;
        }
        if (nowMs - lastFullSyncAtMs >= FULL_SYNC_MAX_AGE_MS) {
            return true;
        }
        long todayTargetMs = todayTargetMillis(nowMs, dailyHour, dailyMinute, zone);
        return nowMs >= todayTargetMs && lastFullSyncAtMs < todayTargetMs;
    }

    static long nextDailyTriggerDelayMs(
            long nowMs,
            long lastFullSyncAtMs,
            int dailyHour,
            int dailyMinute,
            ZoneId zone
    ) {
        int hour = clampHour(dailyHour);
        int minute = clampMinute(dailyMinute);
        ZoneId safeZone = zone == null ? ZoneId.systemDefault() : zone;
        LocalDate today = Instant.ofEpochMilli(nowMs).atZone(safeZone).toLocalDate();
        ZonedDateTime todayTarget = today.atTime(hour, minute).atZone(safeZone);
        long todayTargetMs = todayTarget.toInstant().toEpochMilli();

        if (nowMs < todayTargetMs && lastFullSyncAtMs < todayTargetMs) {
            return Math.max(MIN_JOB_DELAY_MS, todayTargetMs - nowMs);
        }
        if (nowMs >= todayTargetMs && lastFullSyncAtMs < todayTargetMs) {
            return DUE_SOON_DELAY_MS;
        }
        long tomorrowTargetMs = todayTarget.plusDays(1).toInstant().toEpochMilli();
        return Math.max(MIN_JOB_DELAY_MS, tomorrowTargetMs - nowMs);
    }

    static Decision evaluateAutoSync(
            AutoTrigger trigger,
            boolean enabled,
            boolean hasNetwork,
            boolean isUnmeteredWifi,
            boolean hasManualRemoteHub,
            boolean imeActive,
            int substantiveDirtyCount,
            int changeThreshold,
            long nowMs,
            long lastFullSyncAtMs,
            long lastFailedAutoAtMs,
            int dailyHour,
            int dailyMinute,
            ZoneId zone
    ) {
        if (!enabled) {
            return new Decision(false, false, "disabled");
        }
        if (!hasNetwork) {
            return new Decision(false, false, "offline");
        }
        if (!isUnmeteredWifi && !hasManualRemoteHub) {
            return new Decision(false, false, "cellular_lan_only");
        }
        if (imeActive && trigger != AutoTrigger.DAILY_JOB) {
            return new Decision(false, false, "ime_active");
        }
        boolean dailyDue = isDailyFullSyncDue(nowMs, lastFullSyncAtMs, dailyHour, dailyMinute, zone);
        boolean thresholdReached = substantiveDirtyCount >= Math.max(1, changeThreshold);
        if (!dailyDue && !thresholdReached) {
            return new Decision(false, false, "idle");
        }
        if (trigger != AutoTrigger.DAILY_JOB
                && trigger != AutoTrigger.NETWORK_AVAILABLE
                && lastFailedAutoAtMs > 0L
                && nowMs - lastFailedAutoAtMs < FAILURE_COOLDOWN_MS) {
            return new Decision(false, false, "cooldown");
        }
        return new Decision(true, dailyDue, dailyDue ? "daily" : "threshold");
    }

    private static long todayTargetMillis(long nowMs, int dailyHour, int dailyMinute, ZoneId zone) {
        int hour = clampHour(dailyHour);
        int minute = clampMinute(dailyMinute);
        ZoneId safeZone = zone == null ? ZoneId.systemDefault() : zone;
        LocalDate today = Instant.ofEpochMilli(nowMs).atZone(safeZone).toLocalDate();
        return today.atTime(hour, minute).atZone(safeZone).toInstant().toEpochMilli();
    }
}
