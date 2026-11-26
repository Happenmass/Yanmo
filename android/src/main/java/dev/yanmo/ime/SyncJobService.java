package dev.yanmo.ime;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * JobScheduler service triggering daily background full synchronization.
 */
public final class SyncJobService extends JobService {
    static final int JOB_ID = 0x594D5359;
    private static final long MIN_LATENCY_MS = 15_000L;
    private static final long WINDOW_FLEX_MS = 2L * 60L * 60L * 1000L;

    @Override
    public boolean onStartJob(JobParameters params) {
        SyncManager.get(getApplicationContext()).runScheduledDailyJob(() -> jobFinished(params, false));
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return false;
    }

    static void scheduleNext(Context context, long delayMs, boolean requireUnmetered) {
        Context app = context.getApplicationContext();
        JobScheduler scheduler = app.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        long latency = Math.max(MIN_LATENCY_MS, delayMs);
        JobInfo info = new JobInfo.Builder(JOB_ID, new ComponentName(app, SyncJobService.class))
                .setMinimumLatency(latency)
                .setOverrideDeadline(latency + WINDOW_FLEX_MS)
                .setRequiredNetworkType(requireUnmetered ? JobInfo.NETWORK_TYPE_UNMETERED : JobInfo.NETWORK_TYPE_ANY)
                .build();
        try {
            scheduler.schedule(info);
        } catch (RuntimeException ignored) {
        }
    }

    static void cancel(Context context) {
        JobScheduler scheduler = context.getApplicationContext().getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        try {
            scheduler.cancel(JOB_ID);
        } catch (RuntimeException ignored) {
        }
    }
}
