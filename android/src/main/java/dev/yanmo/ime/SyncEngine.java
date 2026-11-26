package dev.yanmo.ime;

import android.content.Context;

import org.json.JSONObject;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Orchestrates encrypted pull/push replication, conflict resolution, and on-demand blob transfer.
 */
final class SyncEngine {
    static final class ConfiguredSpace {
        final String deviceId;
        final String vaultId;
        final byte[] dataEncKey;
        final byte[] keyMacKey;

        ConfiguredSpace(String deviceId, String vaultId, byte[] dataEncKey, byte[] keyMacKey) {
            this.deviceId = deviceId;
            this.vaultId = vaultId;
            this.dataEncKey = dataEncKey;
            this.keyMacKey = keyMacKey;
        }
    }

    private final Context app;
    private final SyncStore store;
    private final SyncPairing pairing;

    SyncEngine(Context context, SyncStore store, SyncPairing pairing) {
        this.app = context.getApplicationContext();
        this.store = store;
        this.pairing = pairing;
    }

    ConfiguredSpace ensureConfigured(boolean forceSeed) throws Exception {
        byte[] rootSeed = pairing.getRootSeed();
        if (rootSeed == null) return null;
        SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
        SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
        store.ensureSeededFromLocal(space.vaultId, dev.deviceId, space.keyMacKey, forceSeed);
        return new ConfiguredSpace(dev.deviceId, space.vaultId, space.dataEncKey, space.keyMacKey);
    }

    SyncModels.SyncRunResult syncWithHub(
            SyncModels.KnownHub targetHub,
            SyncModels.DiscoveredHub discovered,
            boolean uploadBlobs
    ) throws Exception {
        ConfiguredSpace space = ensureConfigured(false);
        if (space == null) {
            throw new IOException("尚未开启或加入个人同步空间。");
        }
        AcpmSyncClient client = pairing.createClientForHub(targetHub, discovered);

        PullResult pull1 = pullFromHub(client, targetHub.hubInstanceId, space);
        PushResult push1 = pushToHub(client, targetHub.hubInstanceId, space, uploadBlobs);

        int totalPulled = pull1.pulled;
        int totalAppliedLocal = pull1.appliedLocal;
        int totalPushed = push1.pushed;
        int totalAppliedRemote = push1.appliedRemote;
        int totalNoopRemote = push1.noopRemote;
        int totalStaleRemote = push1.staleRemote;
        long latestSeq = Math.max(pull1.latestSeq, push1.latestSeq);

        if (push1.staleRemote > 0) {
            PullResult pull2 = pullFromHub(client, targetHub.hubInstanceId, space);
            PushResult push2 = pushToHub(client, targetHub.hubInstanceId, space, uploadBlobs);
            totalPulled += pull2.pulled;
            totalAppliedLocal += pull2.appliedLocal;
            totalPushed += push2.pushed;
            totalAppliedRemote += push2.appliedRemote;
            totalNoopRemote += push2.noopRemote;
            totalStaleRemote += push2.staleRemote;
            latestSeq = Math.max(latestSeq, Math.max(pull2.latestSeq, push2.latestSeq));
        }

        return new SyncModels.SyncRunResult(
                targetHub.hubInstanceId,
                totalPulled,
                totalAppliedLocal,
                totalPushed,
                totalAppliedRemote,
                totalNoopRemote,
                totalStaleRemote,
                latestSeq
        );
    }

    private PullResult pullFromHub(AcpmSyncClient client, String hubId, ConfiguredSpace space) throws Exception {
        long sinceSeq = store.getHubCursor(hubId).lastPulledSeq;
        int pulled = 0;
        int appliedLocal = 0;
        long latestSeq = sinceSeq;

        while (true) {
            SyncModels.PullChangesResponse page = client.pullSyncChanges(space.vaultId, sinceSeq, 200);
            if (!page.hubInstanceId.isEmpty() && !hubId.equals(page.hubInstanceId)) {
                throw new IOException("远端同步节点 ID 与预期不一致。");
            }
            latestSeq = Math.max(latestSeq, page.latestSeq);
            if (page.changes.isEmpty()) {
                long nextSeq = Math.max(sinceSeq, page.latestSeq);
                store.setHubCursor(hubId, nextSeq, System.currentTimeMillis());
                break;
            }

            pulled += page.changes.size();
            long maxItemSeq = 0L;
            for (SyncModels.SyncChangeItem c : page.changes) {
                if (c.seq != null && c.seq > maxItemSeq) maxItemSeq = c.seq;
            }
            long batchLastSeq = page.hasMore
                    ? Math.max(sinceSeq, maxItemSeq)
                    : Math.max(sinceSeq, Math.max(page.latestSeq, maxItemSeq));
            if (page.hasMore && batchLastSeq <= sinceSeq) {
                throw new IOException("远端同步游标未递增，已中止拉取。");
            }

            long now = System.currentTimeMillis();
            List<SyncStore.DecryptedChange> valid = new ArrayList<>();
            for (SyncModels.SyncChangeItem change : page.changes) {
                try {
                    if (!SyncModels.COLLECTION_LEXICON.equals(change.collection)
                            && !SyncModels.COLLECTION_MANUSCRIPT.equals(change.collection)) {
                        continue;
                    }
                    SyncHlc.ParsedHlc parsed = SyncHlc.parseHlc(change.versionHlc);
                    if (parsed.ms > now + SyncHlc.MAX_REMOTE_CLOCK_DRIFT_MS) {
                        continue;
                    }
                    JSONObject payload = SyncMerge.decryptSyncRecord(space.dataEncKey, space.vaultId, change);
                    if (!change.deleted) {
                        if (SyncModels.COLLECTION_LEXICON.equals(change.collection)) {
                            String term = payload.opt("term") instanceof String ? (String) payload.opt("term") : "";
                            if (SyncCrypto.normalizeTermKey(term).isEmpty()) continue;
                        } else {
                            if (!(payload.opt("date") instanceof Number)
                                    || !(payload.opt("text") instanceof String)
                                    || !(payload.opt("original") instanceof String)) {
                                continue;
                            }
                        }
                    }
                    valid.add(new SyncStore.DecryptedChange(change, payload));
                } catch (Exception ignored) {
                    // Quarantine corrupt record without blocking the rest of the batch or cursor.
                }
            }

            appliedLocal += store.applyRemotePullBatch(hubId, space.deviceId, space.keyMacKey, valid, batchLastSeq, now);
            sinceSeq = batchLastSeq;
            if (!page.hasMore) break;
        }

        return new PullResult(pulled, appliedLocal, latestSeq);
    }

    private PushResult pushToHub(
            AcpmSyncClient client,
            String hubId,
            ConfiguredSpace space,
            boolean uploadBlobs
    ) throws Exception {
        int pushed = 0;
        int appliedRemote = 0;
        int noopRemote = 0;
        int staleRemote = 0;
        long latestSeq = store.getHubCursor(hubId).lastPulledSeq;

        while (true) {
            List<SyncModels.SyncEntryRow> pending = store.getPendingSyncEntries(hubId, 200);
            if (pending.isEmpty()) break;

            if (uploadBlobs) {
                for (SyncModels.SyncEntryRow entry : pending) {
                    if (SyncModels.COLLECTION_MANUSCRIPT.equals(entry.collection) && !entry.deleted) {
                        uploadManuscriptBlobs(client, entry.localId != null ? entry.localId : entry.recordKey, space);
                    }
                }
            }

            List<Lexicon.Entry> lexiconList = Lexicon.list(app);
            List<SyncModels.SyncChangeItem> batch = new ArrayList<>();
            for (SyncModels.SyncEntryRow entry : pending) {
                SyncModels.SyncEntryRow latest = (uploadBlobs && SyncModels.COLLECTION_MANUSCRIPT.equals(entry.collection))
                        ? store.getSyncEntry(SyncModels.COLLECTION_MANUSCRIPT, entry.recordKey)
                        : entry;
                if (latest == null) latest = entry;

                JSONObject payload;
                if (SyncModels.COLLECTION_LEXICON.equals(latest.collection)) {
                    Lexicon.Entry term = findLexiconEntry(lexiconList, space.keyMacKey, latest.localId, latest.recordKey);
                    payload = SyncMerge.buildOutgoingLexiconPayload(
                            latest, term != null ? SyncStore.toLexiconRecord(term) : null, space.deviceId, space.keyMacKey
                    );
                } else {
                    String mId = latest.localId != null ? latest.localId : latest.recordKey;
                    SyncModels.ManuscriptRecord record = latest.deleted ? null : Manuscripts.readRecord(app, mId);
                    payload = SyncMerge.buildOutgoingManuscriptPayload(latest, record, space.deviceId);
                }
                if (payload == null) continue;

                String ciphertext = SyncMerge.encryptSyncRecord(
                        space.dataEncKey, space.vaultId, latest.collection, latest.recordKey,
                        latest.versionHlc, latest.deleted, payload, latest.originDeviceId
                );
                batch.add(new SyncModels.SyncChangeItem(
                        null, latest.collection, latest.recordKey, latest.versionHlc,
                        latest.originDeviceId, latest.deleted, ciphertext, null
                ));
            }
            if (batch.isEmpty()) break;

            SyncModels.PushChangesResponse res = client.pushSyncChanges(space.vaultId, batch);
            pushed += batch.size();
            latestSeq = Math.max(latestSeq, res.latestSeq);

            Map<String, SyncModels.SyncChangeItem> sentByKey = new HashMap<>();
            for (SyncModels.SyncChangeItem item : batch) {
                sentByKey.put(item.collection + ":" + item.recordKey, item);
            }
            Set<String> seenKeys = new HashSet<>();
            List<SyncModels.SyncChangeItem> acks = new ArrayList<>();
            boolean sawStale = false;
            for (SyncModels.PushChangeResult result : res.results) {
                String k = result.collection + ":" + result.recordKey;
                SyncModels.SyncChangeItem sent = sentByKey.get(k);
                if (sent == null || !seenKeys.add(k)) continue;
                if ("applied".equals(result.status)) {
                    appliedRemote += 1;
                    acks.add(sent);
                } else if ("noop".equals(result.status)) {
                    noopRemote += 1;
                    acks.add(sent);
                } else {
                    staleRemote += 1;
                    sawStale = true;
                }
            }
            if (!acks.isEmpty()) store.markHubAcked(hubId, acks);
            if (seenKeys.size() < batch.size()) {
                throw new IOException("Hub 返回的同步写入确认不完整。");
            }
            if (acks.isEmpty() && !sawStale) {
                throw new IOException("Hub 未确认任何同步变更。");
            }
            if (sawStale || batch.size() < 200) break;
        }

        return new PushResult(pushed, appliedRemote, noopRemote, staleRemote, latestSeq);
    }

    private void uploadManuscriptBlobs(AcpmSyncClient client, String manuscriptId, ConfiguredSpace space) {
        try {
            byte[] audio = Manuscripts.media(app, manuscriptId, "audio");
            byte[] screenshot = Manuscripts.media(app, manuscriptId, "screenshot");
            SyncModels.SyncEntryRow existing = store.getSyncEntry(SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
            SyncModels.BlobRef existingAudio = existing != null
                    ? SyncModels.BlobRef.fromJson(existing.meta.optJSONObject("audioBlob")) : null;
            SyncModels.BlobRef existingShot = existing != null
                    ? SyncModels.BlobRef.fromJson(existing.meta.optJSONObject("screenshotBlob")) : null;

            SyncModels.BlobRef nextAudio = uploadOneBlob(client, space, audio, existingAudio, detectAudioFormat(audio));
            SyncModels.BlobRef nextShot = uploadOneBlob(client, space, screenshot, existingShot, detectImageFormat(screenshot));
            if (nextAudio != null || nextShot != null) {
                store.updateManuscriptBlobRefs(manuscriptId, nextAudio, nextShot);
            }
        } catch (Exception ignored) {
            // Do not fail metadata sync if a single attachment upload is transiently unavailable.
        }
    }

    private static SyncModels.BlobRef uploadOneBlob(
            AcpmSyncClient client,
            ConfiguredSpace space,
            byte[] bytes,
            SyncModels.BlobRef existingRef,
            String fallbackFormat
    ) throws Exception {
        if (bytes == null || bytes.length == 0) return null;
        String sha256 = SyncCrypto.sha256Hex(bytes);
        String blobId = SyncCrypto.computeBlobId(space.keyMacKey, sha256);
        if (!client.hasSyncBlob(space.vaultId, blobId)) {
            byte[] encrypted = SyncMerge.encryptSyncBlob(space.dataEncKey, space.vaultId, blobId, bytes);
            client.uploadSyncBlob(space.vaultId, blobId, encrypted);
        }
        String format = existingRef != null && !existingRef.format.isEmpty() ? existingRef.format : fallbackFormat;
        return new SyncModels.BlobRef(blobId, format, bytes.length);
    }

    boolean ensureManuscriptAttachments(
            String manuscriptId,
            List<SyncModels.KnownHub> hubs,
            Map<String, SyncModels.DiscoveredHub> discoveredByHub
    ) throws Exception {
        ConfiguredSpace space = ensureConfigured(false);
        if (space == null) return false;
        SyncModels.SyncEntryRow entry = store.getSyncEntry(SyncModels.COLLECTION_MANUSCRIPT, manuscriptId);
        if (entry == null) return false;

        SyncModels.BlobRef audioRef = SyncModels.BlobRef.fromJson(entry.meta.optJSONObject("audioBlob"));
        SyncModels.BlobRef shotRef = SyncModels.BlobRef.fromJson(entry.meta.optJSONObject("screenshotBlob"));
        boolean needAudio = Manuscripts.size(app, manuscriptId, "audio") <= 44 && audioRef != null;
        boolean needShot = Manuscripts.size(app, manuscriptId, "screenshot") <= 0 && shotRef != null;
        if (!needAudio && !needShot) return true;

        byte[] fetchedAudio = null;
        byte[] fetchedShot = null;

        List<SyncModels.KnownHub> sorted = new ArrayList<>(hubs);
        sorted.sort((a, b) -> {
            int ad = discoveredByHub.containsKey(a.hubInstanceId) ? 0 : 1;
            int bd = discoveredByHub.containsKey(b.hubInstanceId) ? 0 : 1;
            if (ad != bd) return Integer.compare(ad, bd);
            return Long.compare(b.lastSeenAtMs, a.lastSeenAtMs);
        });

        for (SyncModels.KnownHub hub : sorted) {
            AcpmSyncClient client;
            try {
                client = pairing.createClientForHub(hub, discoveredByHub.get(hub.hubInstanceId));
            } catch (Exception unavailable) {
                continue;
            }
            if (needAudio && fetchedAudio == null && audioRef != null) {
                try {
                    fetchedAudio = fetchVerifiedBlob(client, space, audioRef.blobId);
                } catch (Exception ignored) {}
            }
            if (needShot && fetchedShot == null && shotRef != null) {
                try {
                    fetchedShot = fetchVerifiedBlob(client, space, shotRef.blobId);
                } catch (Exception ignored) {}
            }
            if ((!needAudio || fetchedAudio != null) && (!needShot || fetchedShot != null)) break;
        }

        if (fetchedAudio != null) Manuscripts.saveCachedMedia(app, manuscriptId, "audio", fetchedAudio);
        if (fetchedShot != null) Manuscripts.saveCachedMedia(app, manuscriptId, "screenshot", fetchedShot);
        return (!needAudio || fetchedAudio != null) && (!needShot || fetchedShot != null);
    }

    private static byte[] fetchVerifiedBlob(AcpmSyncClient client, ConfiguredSpace space, String blobId) throws Exception {
        byte[] encrypted = client.downloadSyncBlob(space.vaultId, blobId);
        byte[] plain = SyncMerge.decryptSyncBlob(space.dataEncKey, space.vaultId, blobId, encrypted);
        String actualId = SyncCrypto.computeBlobId(space.keyMacKey, SyncCrypto.sha256Hex(plain));
        if (!actualId.equals(blobId.toLowerCase(Locale.ROOT))) {
            throw new IOException("同步附件内容校验失败。");
        }
        return plain;
    }

    private static String detectAudioFormat(byte[] bytes) {
        if (bytes != null && bytes.length >= 4) {
            if (bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F') return "wav";
            if (bytes[0] == 'f' && bytes[1] == 'L' && bytes[2] == 'a' && bytes[3] == 'C') return "flac";
            if (bytes[0] == 'O' && bytes[1] == 'g' && bytes[2] == 'g' && bytes[3] == 'S') return "opus";
        }
        return "wav";
    }

    private static String detectImageFormat(byte[] bytes) {
        if (bytes != null && bytes.length >= 4) {
            if ((bytes[0] & 0xff) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') return "png";
            if ((bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xd8) return "jpeg";
        }
        return "png";
    }

    private static Lexicon.Entry findLexiconEntry(List<Lexicon.Entry> entries, byte[] keyMacKey,
                                                String localId, String recordKey) throws Exception {
        if (localId != null) {
            for (Lexicon.Entry e : entries) {
                if (localId.equals(e.id)) return e;
            }
        }
        for (Lexicon.Entry e : entries) {
            if (!SyncCrypto.normalizeTermKey(e.term).isEmpty()
                    && recordKey.equals(SyncCrypto.computeLexiconRecordKey(keyMacKey, e.term, e.group))) {
                return e;
            }
        }
        return null;
    }

    private static final class PullResult {
        final int pulled;
        final int appliedLocal;
        final long latestSeq;

        PullResult(int pulled, int appliedLocal, long latestSeq) {
            this.pulled = pulled;
            this.appliedLocal = appliedLocal;
            this.latestSeq = latestSeq;
        }
    }

    private static final class PushResult {
        final int pushed;
        final int appliedRemote;
        final int noopRemote;
        final int staleRemote;
        final long latestSeq;

        PushResult(int pushed, int appliedRemote, int noopRemote, int staleRemote, long latestSeq) {
            this.pushed = pushed;
            this.appliedRemote = appliedRemote;
            this.noopRemote = noopRemote;
            this.staleRemote = staleRemote;
            this.latestSeq = latestSeq;
        }
    }
}
