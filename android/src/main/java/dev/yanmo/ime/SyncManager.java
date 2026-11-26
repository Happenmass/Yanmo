package dev.yanmo.ime;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;

import java.io.IOException;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Process-wide singleton coordinating Android background sync, discovery, pairing, and UI updates.
 * All Keystore, SQLite sync metadata, mDNS, and HTTP operations run exclusively on the background
 * worker thread so IME typing and dictation stay completely off-loaded from the main thread.
 */
final class SyncManager {
    private static volatile SyncManager instance;

    static final class UiState {
        final boolean enabled;
        final String vaultId;
        final String deviceId;
        final List<SyncModels.KnownHub> knownHubs;
        final Set<String> discoveredHubIds;
        final Set<String> spoofedHubIds;
        final boolean autoCacheBlobs;
        final boolean syncing;
        final int pendingCount;
        final long lastSyncAtMs;
        final String lastSyncSummary;
        final String lastError;
        final int dailySyncHour;
        final int dailySyncMinute;
        final int changeThreshold;
        final int substantiveDirtyCount;
        final long lastFullSyncAtMs;

        UiState(boolean enabled, String vaultId, String deviceId, List<SyncModels.KnownHub> knownHubs,
                Set<String> discoveredHubIds, Set<String> spoofedHubIds, boolean autoCacheBlobs,
                boolean syncing, int pendingCount, long lastSyncAtMs, String lastSyncSummary,
                String lastError, int dailySyncHour, int dailySyncMinute, int changeThreshold,
                int substantiveDirtyCount, long lastFullSyncAtMs) {
            this.enabled = enabled;
            this.vaultId = vaultId;
            this.deviceId = deviceId;
            this.knownHubs = knownHubs;
            this.discoveredHubIds = discoveredHubIds;
            this.spoofedHubIds = spoofedHubIds;
            this.autoCacheBlobs = autoCacheBlobs;
            this.syncing = syncing;
            this.pendingCount = pendingCount;
            this.lastSyncAtMs = lastSyncAtMs;
            this.lastSyncSummary = lastSyncSummary;
            this.lastError = lastError;
            this.dailySyncHour = dailySyncHour;
            this.dailySyncMinute = dailySyncMinute;
            this.changeThreshold = changeThreshold;
            this.substantiveDirtyCount = substantiveDirtyCount;
            this.lastFullSyncAtMs = lastFullSyncAtMs;
        }
    }

    interface Listener {
        void onSyncStateChanged(boolean remoteLibraryUpdated);
    }

    private final Context app;
    private final SyncStorage.KeystoreSyncSecretStore secretStore;
    private final SyncStorage.PrefsKnownHubStore hubStore;
    private final SyncPairing pairing;
    private final SyncStore store;
    private final SyncEngine engine;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(() -> {
            Process.setThreadPriority(Process.THREAD_PRIORITY_BACKGROUND);
            r.run();
        }, "yanmo-sync-worker");
        t.setDaemon(true);
        return t;
    });
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Set<Listener> listeners = new CopyOnWriteArraySet<>();
    private final Map<String, SyncModels.DiscoveredHub> discoveredByHub = new HashMap<>();
    private final Set<String> spoofedHubIds = new HashSet<>();

    private final Runnable imeIdleCheck = () -> worker.execute(() -> maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE));
    private volatile boolean imeActive;
    private volatile boolean syncing;
    private volatile boolean enabledCache;
    private volatile long lastFailedAutoAtMs;
    private volatile long lastWifiNetworkHandle;
    private volatile String transientError;
    private volatile UiState cachedSnapshot;

    private SyncManager(Context context) {
        this.app = context.getApplicationContext();
        this.secretStore = new SyncStorage.KeystoreSyncSecretStore(app);
        this.hubStore = new SyncStorage.PrefsKnownHubStore(app);
        this.pairing = new SyncPairing(secretStore, hubStore);
        this.store = new SyncStore(app);
        this.engine = new SyncEngine(app, store, pairing);

        Boolean hint = SyncStorage.syncEnabledHint(app);
        this.enabledCache = hint != null && hint;
        this.cachedSnapshot = new UiState(
                this.enabledCache,
                null,
                "",
                Collections.emptyList(),
                Collections.emptySet(),
                Collections.emptySet(),
                SyncStorage.autoCacheBlobs(app),
                false,
                0,
                0L,
                "",
                null,
                SyncStorage.dailySyncHour(app),
                SyncStorage.dailySyncMinute(app),
                SyncStorage.changeThreshold(app),
                0,
                0L
        );

        Lexicon.setSyncHook(new Lexicon.SyncHook() {
            @Override public void onSaved(Lexicon.Entry prev, Lexicon.Entry next) { onLocalLexiconSaved(prev, next); }
            @Override public void onRemoved(Lexicon.Entry removed) { onLocalLexiconRemoved(removed); }
            @Override public void onLearned(List<Lexicon.Entry> added) { onLocalLexiconLearned(added); }
            @Override public void onMatched(List<Lexicon.Entry> updated) { onLocalLexiconMatches(updated); }
        });
        Manuscripts.setSyncHook(new Manuscripts.SyncHook() {
            @Override public void onFinished(String id) { onLocalManuscriptFinished(id); }
            @Override public void onDeleted(String id) { onLocalManuscriptDeleted(id); }
        });

        registerWifiCallback();
        worker.execute(() -> {
            rebuildSnapshot();
            scheduleDailyJobInternal();
            notifyListeners(false);
        });
    }

    static SyncManager get(Context context) {
        SyncManager current = instance;
        if (current == null) {
            synchronized (SyncManager.class) {
                current = instance;
                if (current == null) {
                    current = new SyncManager(context);
                    instance = current;
                }
            }
        }
        return current;
    }

    void addListener(Listener listener) {
        if (listener != null) listeners.add(listener);
    }

    void removeListener(Listener listener) {
        if (listener != null) listeners.remove(listener);
    }

    private void notifyListeners(boolean remoteLibraryUpdated) {
        main.post(() -> {
            for (Listener l : listeners) l.onSyncStateChanged(remoteLibraryUpdated);
        });
    }

    /** Fast non-blocking check safe to call on the main thread. */
    boolean isEnabledFast() {
        return enabledCache;
    }

    private boolean isEnabledInternal() {
        try {
            boolean enabled = pairing.getRootSeed() != null;
            enabledCache = enabled;
            return enabled;
        } catch (IOException ignored) {
            return false;
        }
    }

    /** Returns the latest cached UI snapshot without blocking on Keystore or SQLite. */
    UiState snapshot() {
        return cachedSnapshot;
    }

    void refreshSnapshotAsync() {
        worker.execute(() -> {
            rebuildSnapshot();
            notifyListeners(false);
        });
    }

    private UiState rebuildSnapshot() {
        SyncModels.SyncStateSummary summary;
        try {
            summary = pairing.getStatus();
            enabledCache = summary.enabled;
        } catch (IOException e) {
            summary = new SyncModels.SyncStateSummary(false, null, "", Collections.emptyList());
        }
        int pending = 0;
        int dirty = 0;
        long lastAt = 0L;
        long lastFullAt = 0L;
        String lastSummary = "";
        String lastErr = transientError;
        try {
            pending = summary.enabled ? store.countPendingEntriesForFirstHub(summary.knownHubs) : 0;
            dirty = summary.enabled ? store.getSubstantiveDirtyCount() : 0;
            lastAt = store.getLongState("last_sync_at_ms", 0L);
            lastFullAt = store.getLongState("last_full_sync_at_ms", 0L);
            lastSummary = nullToEmpty(store.getState("last_sync_summary"));
            if (lastErr == null) lastErr = store.getState("last_sync_error");
        } catch (Exception ignored) {
        }
        Set<String> discIds;
        Set<String> spoofIds;
        synchronized (this) {
            discIds = new HashSet<>(discoveredByHub.keySet());
            spoofIds = new HashSet<>(spoofedHubIds);
        }
        UiState next = new UiState(
                summary.enabled,
                summary.vaultId,
                summary.deviceId,
                summary.knownHubs,
                discIds,
                spoofIds,
                SyncStorage.autoCacheBlobs(app),
                syncing,
                pending,
                lastAt,
                lastSummary,
                lastErr,
                SyncStorage.dailySyncHour(app),
                SyncStorage.dailySyncMinute(app),
                SyncStorage.changeThreshold(app),
                dirty,
                lastFullAt
        );
        cachedSnapshot = next;
        return next;
    }

    boolean hasRemoteAttachments(String manuscriptId) {
        try {
            if (!isEnabledInternal()) return false;
            SyncModels.SyncEntryRow entry = store.getSyncEntry(SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
            if (entry == null) return false;
            return SyncModels.BlobRef.fromJson(entry.meta.optJSONObject("audioBlob")) != null
                    || SyncModels.BlobRef.fromJson(entry.meta.optJSONObject("screenshotBlob")) != null;
        } catch (Exception ignored) {
            return false;
        }
    }

    boolean ensureManuscriptAttachments(String manuscriptId) throws Exception {
        if (!isEnabledInternal()) return false;
        List<SyncModels.KnownHub> hubs = hubStore.load();
        if (hubs.isEmpty()) return false;
        Map<String, SyncModels.DiscoveredHub> discCopy;
        synchronized (this) {
            discCopy = new HashMap<>(discoveredByHub);
        }
        if (discCopy.isEmpty() && isUnmeteredWifi()) {
            try {
                scanLANHubsInternal();
                synchronized (this) {
                    discCopy = new HashMap<>(discoveredByHub);
                }
                hubs = hubStore.load();
            } catch (Exception ignored) {
            }
        }
        return engine.ensureManuscriptAttachments(manuscriptId, hubs, discCopy);
    }

    void onImeInputViewStarted() {
        imeActive = true;
        main.removeCallbacks(imeIdleCheck);
    }

    void onImeInputViewFinished() {
        imeActive = false;
        if (!mayBeEnabledHint()) return;
        main.removeCallbacks(imeIdleCheck);
        main.postDelayed(imeIdleCheck, SyncPolicy.IME_IDLE_DELAY_MS);
    }

    void onAppResumed() {
        if (!mayBeEnabledHint()) return;
        worker.execute(() -> maybeAutoSync(SyncPolicy.AutoTrigger.APP_RESUME));
    }

    void runScheduledDailyJob(Runnable onComplete) {
        worker.execute(() -> {
            try {
                maybeAutoSync(SyncPolicy.AutoTrigger.DAILY_JOB);
            } finally {
                scheduleDailyJobInternal();
                if (onComplete != null) main.post(onComplete);
            }
        });
    }

    void setDailySyncTime(int hour, int minute, Runnable onUpdated) {
        SyncStorage.setDailySyncTime(app, hour, minute);
        worker.execute(() -> {
            scheduleDailyJobInternal();
            rebuildSnapshot();
            notifyListeners(false);
            if (onUpdated != null) main.post(onUpdated);
        });
    }

    private boolean mayBeEnabledHint() {
        return enabledCache || SyncStorage.syncEnabledHint(app) != Boolean.FALSE;
    }

    void onLocalManuscriptFinished(String manuscriptId) {
        if (!mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                if (!isEnabledInternal()) return;
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                store.recordLocalManuscriptFinished(dev.deviceId, manuscriptId);
                rebuildSnapshot();
                notifyListeners(false);
                if (!imeActive) maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE);
            } catch (Exception ignored) {
            }
        });
    }

    void onLocalManuscriptDeleted(String manuscriptId) {
        if (!mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                if (!isEnabledInternal()) return;
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                store.recordLocalManuscriptDeleted(dev.deviceId, manuscriptId);
                rebuildSnapshot();
                notifyListeners(false);
                if (!imeActive) maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE);
            } catch (Exception ignored) {
            }
        });
    }

    void onLocalLexiconSaved(Lexicon.Entry prevEntry, Lexicon.Entry nextEntry) {
        if (!mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                byte[] rootSeed = pairing.getRootSeed();
                if (rootSeed == null) return;
                SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                store.recordLocalLexiconUpsert(dev.deviceId, space.keyMacKey, prevEntry, nextEntry);
                rebuildSnapshot();
                notifyListeners(false);
                if (!imeActive) maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE);
            } catch (Exception ignored) {
            }
        });
    }

    void onLocalLexiconRemoved(Lexicon.Entry removedEntry) {
        if (!mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                byte[] rootSeed = pairing.getRootSeed();
                if (rootSeed == null) return;
                SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                store.recordLocalLexiconDeleted(dev.deviceId, space.keyMacKey, removedEntry);
                rebuildSnapshot();
                notifyListeners(false);
                if (!imeActive) maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE);
            } catch (Exception ignored) {
            }
        });
    }

    void onLocalLexiconLearned(List<Lexicon.Entry> addedEntries) {
        if (addedEntries == null || addedEntries.isEmpty() || !mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                byte[] rootSeed = pairing.getRootSeed();
                if (rootSeed == null) return;
                SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                for (Lexicon.Entry added : addedEntries) {
                    store.recordLocalLexiconUpsert(dev.deviceId, space.keyMacKey, null, added);
                }
                rebuildSnapshot();
                notifyListeners(false);
                if (!imeActive) maybeAutoSync(SyncPolicy.AutoTrigger.IME_IDLE);
            } catch (Exception ignored) {
            }
        });
    }

    void onLocalLexiconMatches(List<Lexicon.Entry> updatedEntries) {
        if (updatedEntries == null || updatedEntries.isEmpty() || !mayBeEnabledHint()) return;
        worker.execute(() -> {
            try {
                byte[] rootSeed = pairing.getRootSeed();
                if (rootSeed == null) return;
                SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
                SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
                store.recordLocalLexiconMatches(dev.deviceId, space.keyMacKey, updatedEntries);
                rebuildSnapshot();
                notifyListeners(false);
                // Passive match count increments piggyback on the next sync without waking up sync.
            } catch (Exception ignored) {
            }
        });
    }

    void syncNow(Runnable onFinished) {
        worker.execute(() -> {
            try {
                lastFailedAutoAtMs = 0L;
                runSyncInternal(true, true, false);
            } finally {
                if (onFinished != null) main.post(onFinished);
            }
        });
    }

    void scanLANHubs(Runnable onFinished) {
        worker.execute(() -> {
            try {
                scanLANHubsInternal();
            } catch (Exception failure) {
                transientError = failure.getMessage();
            } finally {
                rebuildSnapshot();
                notifyListeners(false);
                if (onFinished != null) main.post(onFinished);
            }
        });
    }

    private void scanLANHubsInternal() throws IOException {
        List<SyncModels.DiscoveredHub> found = NsdHubDiscovery.discover(app);
        SyncPairing.DiscoveryReport report = pairing.verifyDiscoveredHubs(found);
        synchronized (this) {
            discoveredByHub.clear();
            for (SyncModels.DiscoveredHub d : found) {
                for (SyncModels.KnownHub verified : report.verifiedHubs) {
                    if (verified.hubInstanceId.equals(d.hubInstanceId)) {
                        discoveredByHub.put(d.hubInstanceId, d);
                    }
                }
            }
            spoofedHubIds.clear();
            spoofedHubIds.addAll(report.spoofedHubIds);
        }
    }

    private void maybeAutoSync(SyncPolicy.AutoTrigger trigger) {
        boolean enabled = isEnabledInternal();
        if (!enabled) return;
        long now = System.currentTimeMillis();
        SyncPolicy.Decision decision = SyncPolicy.evaluateAutoSync(
                trigger,
                true,
                hasNetwork(),
                isUnmeteredWifi(),
                hasManualRemoteHub(),
                imeActive,
                store.getSubstantiveDirtyCount(),
                SyncStorage.changeThreshold(app),
                now,
                store.getLongState("last_full_sync_at_ms", 0L),
                lastFailedAutoAtMs,
                SyncStorage.dailySyncHour(app),
                SyncStorage.dailySyncMinute(app),
                ZoneId.systemDefault()
        );
        if (!decision.shouldRun) return;
        runSyncInternal(false, decision.fullSync, trigger == SyncPolicy.AutoTrigger.NETWORK_AVAILABLE);
    }

    private void runSyncInternal(boolean userTriggered, boolean fullSync, boolean forceDiscovery) {
        if (!isEnabledInternal()) return;
        if (!userTriggered && !hasNetwork()) return;
        syncing = true;
        transientError = null;
        rebuildSnapshot();
        notifyListeners(false);

        boolean remoteChanged = false;
        try {
            long now = System.currentTimeMillis();
            if (fullSync || userTriggered) {
                long lastGc = store.getLongState("last_gc_at_ms", 0L);
                if (now - lastGc >= SyncPolicy.TOMBSTONE_GC_INTERVAL_MS) {
                    try {
                        store.gcExpiredTombstones();
                        store.setLongState("last_gc_at_ms", now);
                    } catch (Exception ignored) {
                    }
                }
            }

            boolean onWifi = isUnmeteredWifi();
            boolean scannedThisRun = false;
            if (forceDiscovery && onWifi) {
                try {
                    scanLANHubsInternal();
                } catch (Exception ignored) {
                }
                scannedThisRun = true;
            }

            List<SyncModels.KnownHub> hubs = hubStore.load();
            if (hubs.isEmpty()) {
                if (userTriggered) {
                    transientError = "尚未连接任何 AcpmRuntime 同步节点。";
                }
                return;
            }

            boolean uploadBlobs = SyncStorage.autoCacheBlobs(app) && (userTriggered || (fullSync && onWifi));
            int attempted = 0;
            int succeeded = 0;
            int totalPulled = 0;
            int totalPushed = 0;
            String firstError = null;

            for (SyncModels.KnownHub hub : hubs) {
                boolean hasManual = hub.manualRemoteUrl != null && !hub.manualRemoteUrl.trim().isEmpty();
                if (!onWifi && !hasManual) continue;

                attempted += 1;
                SyncModels.DiscoveredHub disc;
                synchronized (this) {
                    disc = discoveredByHub.get(hub.hubInstanceId);
                }
                try {
                    SyncModels.SyncRunResult res = engine.syncWithHub(hub, disc, uploadBlobs);
                    succeeded += 1;
                    totalPulled += res.appliedLocal;
                    totalPushed += res.pushed;
                    if (res.appliedLocal > 0) remoteChanged = true;
                } catch (Exception hubError) {
                    boolean retriedOk = false;
                    if (onWifi && !scannedThisRun) {
                        scannedThisRun = true;
                        try {
                            scanLANHubsInternal();
                            SyncModels.DiscoveredHub nextDisc;
                            synchronized (this) {
                                nextDisc = discoveredByHub.get(hub.hubInstanceId);
                            }
                            if (nextDisc != null) {
                                String prevUrl = SyncPairing.resolveHubBaseUrl(hub, disc);
                                String nextUrl = SyncPairing.resolveHubBaseUrl(hub, nextDisc);
                                if (disc == null || (nextUrl != null && !nextUrl.equals(prevUrl))) {
                                    SyncModels.SyncRunResult res = engine.syncWithHub(hub, nextDisc, uploadBlobs);
                                    succeeded += 1;
                                    totalPulled += res.appliedLocal;
                                    totalPushed += res.pushed;
                                    if (res.appliedLocal > 0) remoteChanged = true;
                                    retriedOk = true;
                                }
                            }
                        } catch (Exception retryError) {
                            if (firstError == null) firstError = retryError.getMessage();
                            retriedOk = true;
                        }
                    }
                    if (!retriedOk && firstError == null) {
                        firstError = hubError.getMessage();
                    }
                }
            }

            if (attempted == 0) {
                if (userTriggered) {
                    transientError = "当前未连接到 Wi-Fi，且未配置远程节点地址。";
                }
                return;
            }

            long doneAt = System.currentTimeMillis();
            if (succeeded > 0) {
                lastFailedAutoAtMs = 0L;
                store.setLongState("last_sync_at_ms", doneAt);
                if (fullSync || userTriggered) {
                    store.setLongState("last_full_sync_at_ms", doneAt);
                }
                store.resetSubstantiveDirtyCount();
                store.setState("last_sync_error", null);
                store.setState("last_sync_summary",
                        "拉取更新 " + totalPulled + " 条 · 上传 " + totalPushed + " 条");
            } else {
                lastFailedAutoAtMs = doneAt;
                String errMsg = firstError != null && !firstError.isEmpty() ? firstError : "同步节点不可达。";
                store.setState("last_sync_error", errMsg);
                if (userTriggered) transientError = errMsg;
            }
        } catch (Exception failure) {
            long doneAt = System.currentTimeMillis();
            lastFailedAutoAtMs = doneAt;
            String msg = failure.getMessage() != null ? failure.getMessage() : failure.getClass().getSimpleName();
            store.setState("last_sync_error", msg);
            if (userTriggered) transientError = msg;
        } finally {
            syncing = false;
            scheduleDailyJobInternal();
            rebuildSnapshot();
            notifyListeners(remoteChanged);
        }
    }

    private void scheduleDailyJobInternal() {
        if (!isEnabledInternal()) {
            SyncJobService.cancel(app);
            return;
        }
        long now = System.currentTimeMillis();
        long delayMs = SyncPolicy.nextDailyTriggerDelayMs(
                now,
                store.getLongState("last_full_sync_at_ms", 0L),
                SyncStorage.dailySyncHour(app),
                SyncStorage.dailySyncMinute(app),
                ZoneId.systemDefault()
        );
        SyncJobService.scheduleNext(app, delayMs, !hasManualRemoteHub());
    }

    private void registerWifiCallback() {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return;
        try {
            NetworkRequest req = new NetworkRequest.Builder()
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .build();
            cm.registerNetworkCallback(req, new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    long handle = network.getNetworkHandle();
                    long prev = lastWifiNetworkHandle;
                    lastWifiNetworkHandle = handle;
                    if (prev != handle) {
                        lastFailedAutoAtMs = 0L;
                        if (mayBeEnabledHint()) {
                            worker.execute(() -> maybeAutoSync(SyncPolicy.AutoTrigger.NETWORK_AVAILABLE));
                        }
                    }
                }

                @Override
                public void onLost(Network network) {
                    if (network.getNetworkHandle() == lastWifiNetworkHandle) {
                        lastWifiNetworkHandle = 0L;
                    }
                }
            });
        } catch (RuntimeException ignored) {
        }
    }

    private boolean hasNetwork() {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return true;
        Network active = cm.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        if (caps == null) return false;
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                || caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private boolean isUnmeteredWifi() {
        ConnectivityManager cm = (ConnectivityManager) app.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network active = cm.getActiveNetwork();
        if (active == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(active);
        if (caps == null) return false;
        return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
    }

    private boolean hasManualRemoteHub() {
        for (SyncModels.KnownHub hub : hubStore.load()) {
            if (hub.manualRemoteUrl != null && !hub.manualRemoteUrl.trim().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    // Pairing & device management helpers executed on background worker

    SyncPairing pairing() {
        return pairing;
    }

    SyncModels.SyncStateSummary redeemQrBlocking(String qrInput, boolean allowReplaceSpace) throws Exception {
        String name = SyncStorage.defaultDeviceName();
        SyncModels.PairingQrPayload parsed = SyncPairing.parsePairingQr(qrInput);
        SyncModels.SyncStateSummary res;
        if ("join_wait".equals(parsed.mode) && isEnabledInternal()) {
            res = pairing.fulfillJoinWaitAsExistingDevice(qrInput, name);
        } else {
            res = pairing.redeemInvitePairing(qrInput, name, allowReplaceSpace);
        }
        enabledCache = true;
        engine.ensureConfigured(true);
        rebuildSnapshot();
        notifyListeners(false);
        lastFailedAutoAtMs = 0L;
        runSyncInternal(true, true, false);
        return res;
    }

    SyncModels.SyncStateSummary restoreRecoveryBlocking(
            String code,
            String hubUrl,
            boolean allowReplaceSpace
    ) throws Exception {
        SyncModels.SyncStateSummary res = pairing.restoreFromRecoveryCode(
                code, hubUrl, SyncStorage.defaultDeviceName(), allowReplaceSpace
        );
        enabledCache = true;
        engine.ensureConfigured(true);
        rebuildSnapshot();
        notifyListeners(false);
        if (hubUrl != null && !hubUrl.trim().isEmpty()) {
            lastFailedAutoAtMs = 0L;
            runSyncInternal(true, true, false);
        } else {
            scheduleDailyJobInternal();
        }
        return res;
    }

    void disableSyncBlocking() throws IOException {
        pairing.disableSync();
        enabledCache = false;
        SyncJobService.cancel(app);
        synchronized (this) {
            discoveredByHub.clear();
            spoofedHubIds.clear();
        }
        transientError = null;
        lastFailedAutoAtMs = 0L;
        store.setState("last_sync_error", null);
        store.setState("last_sync_summary", null);
        store.setState("last_full_sync_at_ms", null);
        store.resetSubstantiveDirtyCount();
        rebuildSnapshot();
        notifyListeners(false);
    }

    void setHubManualUrlBlocking(String hubId, String url) throws IOException {
        pairing.setHubManualUrl(hubId, url);
        scheduleDailyJobInternal();
        rebuildSnapshot();
        notifyListeners(false);
    }

    List<SyncModels.PairedDeviceDTO> listDevicesBlocking(String hubId) throws IOException {
        return pairing.listDevices(hubId);
    }

    void revokeDeviceBlocking(String deviceId, String hubId) throws IOException {
        pairing.revokeDevice(deviceId, hubId);
    }

    String exportRecoveryCodeBlocking() throws IOException {
        return pairing.exportRecoveryCode();
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
