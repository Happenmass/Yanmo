package dev.yanmo.ime;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Shared immutable data models for Yanmo cross-device sync. */
final class SyncModels {
    static final String PLATFORM_ANDROID = "android";
    static final String COLLECTION_LEXICON = "lexicon";
    static final String COLLECTION_MANUSCRIPT = "manuscript";

    private SyncModels() {}

    static final class SyncSecrets {
        final String deviceId;
        final String devicePrivateSeedB64;
        final String rootSeedB64;

        SyncSecrets(String deviceId, String devicePrivateSeedB64, String rootSeedB64) {
            this.deviceId = deviceId;
            this.devicePrivateSeedB64 = devicePrivateSeedB64;
            this.rootSeedB64 = rootSeedB64;
        }
    }

    static final class KnownHub {
        final String hubInstanceId;
        final String hubName;
        final String serverPubkey;
        final String serverPubkeyFp;
        final String lastKnownUrl;
        final String manualRemoteUrl;
        final long pairedAtMs;
        final long lastSeenAtMs;

        KnownHub(String hubInstanceId, String hubName, String serverPubkey, String serverPubkeyFp,
                 String lastKnownUrl, String manualRemoteUrl, long pairedAtMs, long lastSeenAtMs) {
            this.hubInstanceId = hubInstanceId;
            this.hubName = hubName;
            this.serverPubkey = serverPubkey;
            this.serverPubkeyFp = serverPubkeyFp;
            this.lastKnownUrl = lastKnownUrl;
            this.manualRemoteUrl = manualRemoteUrl;
            this.pairedAtMs = pairedAtMs;
            this.lastSeenAtMs = lastSeenAtMs;
        }

        KnownHub withUpdatedUrl(String nextLastKnownUrl, long nextLastSeenAtMs) {
            return new KnownHub(hubInstanceId, hubName, serverPubkey, serverPubkeyFp,
                    nextLastKnownUrl, manualRemoteUrl, pairedAtMs, nextLastSeenAtMs);
        }

        KnownHub withManualUrl(String nextManualUrl) {
            return new KnownHub(hubInstanceId, hubName, serverPubkey, serverPubkeyFp,
                    lastKnownUrl, nextManualUrl, pairedAtMs, lastSeenAtMs);
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("hubInstanceId", hubInstanceId);
            obj.put("hubName", hubName);
            obj.put("serverPubkey", serverPubkey);
            obj.put("serverPubkeyFp", serverPubkeyFp);
            if (lastKnownUrl != null && !lastKnownUrl.isEmpty()) obj.put("lastKnownUrl", lastKnownUrl);
            if (manualRemoteUrl != null && !manualRemoteUrl.isEmpty()) obj.put("manualRemoteUrl", manualRemoteUrl);
            obj.put("pairedAtMs", pairedAtMs);
            if (lastSeenAtMs > 0) obj.put("lastSeenAtMs", lastSeenAtMs);
            return obj;
        }

        static KnownHub fromJson(JSONObject obj) {
            String id = obj.optString("hubInstanceId", "").trim();
            String pk = obj.optString("serverPubkey", "").trim();
            String fp = obj.optString("serverPubkeyFp", "").trim().toLowerCase();
            if (id.isEmpty() || pk.isEmpty() || fp.isEmpty()) return null;
            return new KnownHub(
                    id,
                    obj.optString("hubName", id),
                    pk,
                    fp,
                    emptyToNull(obj.optString("lastKnownUrl", "")),
                    emptyToNull(obj.optString("manualRemoteUrl", "")),
                    obj.optLong("pairedAtMs", 0L),
                    obj.optLong("lastSeenAtMs", 0L)
            );
        }
    }

    static final class DiscoveredHub {
        final String serviceName;
        final String host;
        final List<String> addresses;
        final int port;
        final String hubInstanceId;
        final String serverPubkeyFp;
        final boolean syncEnabled;
        final String apiPrefix;

        DiscoveredHub(String serviceName, String host, List<String> addresses, int port,
                      String hubInstanceId, String serverPubkeyFp, boolean syncEnabled, String apiPrefix) {
            this.serviceName = serviceName;
            this.host = host;
            this.addresses = Collections.unmodifiableList(new ArrayList<>(addresses));
            this.port = port;
            this.hubInstanceId = hubInstanceId;
            this.serverPubkeyFp = serverPubkeyFp;
            this.syncEnabled = syncEnabled;
            this.apiPrefix = apiPrefix;
        }
    }

    static final class BlobRef {
        final String blobId;
        final String format;
        final long sizeBytes;

        BlobRef(String blobId, String format, long sizeBytes) {
            this.blobId = blobId;
            this.format = format == null ? "" : format;
            this.sizeBytes = Math.max(0L, sizeBytes);
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("blob_id", blobId);
            if (!format.isEmpty()) obj.put("format", format);
            obj.put("size_bytes", sizeBytes);
            return obj;
        }

        static BlobRef fromJson(JSONObject obj) {
            if (obj == null) return null;
            String id = obj.optString("blob_id", "").trim();
            if (id.isEmpty()) return null;
            return new BlobRef(id, obj.optString("format", ""), obj.optLong("size_bytes", 0L));
        }
    }

    static final class AsrResult {
        final String engineName;
        final String transcript;

        AsrResult(String engineName, String transcript) {
            this.engineName = engineName == null ? "" : engineName;
            this.transcript = transcript == null ? "" : transcript;
        }

        static JSONArray toJsonArray(List<AsrResult> list) throws JSONException {
            JSONArray arr = new JSONArray();
            if (list != null) {
                for (AsrResult r : list) {
                    JSONObject obj = new JSONObject();
                    obj.put("engine_name", r.engineName);
                    obj.put("transcript", r.transcript);
                    arr.put(obj);
                }
            }
            return arr;
        }

        static List<AsrResult> fromJsonArray(JSONArray arr) {
            if (arr == null) return Collections.emptyList();
            List<AsrResult> out = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                Object eng = item.opt("engine_name");
                Object tr = item.opt("transcript");
                if (eng instanceof String && tr instanceof String) {
                    out.add(new AsrResult((String) eng, (String) tr));
                }
            }
            return out;
        }
    }

    static final class LexiconRecord {
        final String id;
        final String term;
        final String hint;
        final List<String> aliases;
        final String group;
        final long matchCount;
        final long lastMatchedAtMs;
        final long createdAtMs;

        LexiconRecord(String id, String term, String hint, List<String> aliases, String group,
                      long matchCount, long lastMatchedAtMs, long createdAtMs) {
            this.id = id;
            this.term = term;
            this.hint = hint == null ? "" : hint;
            this.aliases = aliases == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(aliases));
            this.group = group;
            this.matchCount = Math.max(0L, matchCount);
            this.lastMatchedAtMs = Math.max(0L, lastMatchedAtMs);
            this.createdAtMs = Math.max(0L, createdAtMs);
        }
    }

    static final class ManuscriptRecord {
        final String id;
        final long createdAtMs;
        final String original;
        final String polishedText;
        final String error;
        final String captureStatus;
        final String application;
        final double seconds;
        final boolean userEdited;
        final String deliveryNote;
        final String audioWarning;
        final List<AsrResult> asrResults;
        final String sourceDeviceId;

        ManuscriptRecord(String id, long createdAtMs, String original, String polishedText, String error,
                         String captureStatus, String application, double seconds, boolean userEdited,
                         String deliveryNote, String audioWarning, List<AsrResult> asrResults, String sourceDeviceId) {
            this.id = id;
            this.createdAtMs = createdAtMs;
            this.original = original == null ? "" : original;
            this.polishedText = polishedText == null ? "" : polishedText;
            this.error = error == null ? "" : error;
            this.captureStatus = captureStatus == null ? "" : captureStatus;
            this.application = application == null ? "" : application;
            this.seconds = Math.max(0.0, seconds);
            this.userEdited = userEdited;
            this.deliveryNote = emptyToNull(deliveryNote);
            this.audioWarning = emptyToNull(audioWarning);
            this.asrResults = asrResults == null ? Collections.emptyList() : Collections.unmodifiableList(new ArrayList<>(asrResults));
            this.sourceDeviceId = emptyToNull(sourceDeviceId);
        }
    }

    static final class SyncEntryRow {
        final String collection;
        final String recordKey;
        final String localId;
        final String versionHlc;
        final String originDeviceId;
        final boolean deleted;
        final Long deletedAtMs;
        final long updatedAtMs;
        final JSONObject meta;

        SyncEntryRow(String collection, String recordKey, String localId, String versionHlc,
                     String originDeviceId, boolean deleted, Long deletedAtMs, long updatedAtMs, JSONObject meta) {
            this.collection = collection;
            this.recordKey = recordKey;
            this.localId = localId;
            this.versionHlc = versionHlc;
            this.originDeviceId = originDeviceId;
            this.deleted = deleted;
            this.deletedAtMs = deletedAtMs;
            this.updatedAtMs = updatedAtMs;
            this.meta = meta == null ? new JSONObject() : meta;
        }
    }

    static final class SyncHubCursorRow {
        final String hubInstanceId;
        final long lastPulledSeq;
        final Long lastSyncAtMs;

        SyncHubCursorRow(String hubInstanceId, long lastPulledSeq, Long lastSyncAtMs) {
            this.hubInstanceId = hubInstanceId;
            this.lastPulledSeq = lastPulledSeq;
            this.lastSyncAtMs = lastSyncAtMs;
        }
    }

    static final class SyncPrunedRow {
        final String manuscriptId;
        final long prunedAtMs;
        final String prunedVersionHlc;

        SyncPrunedRow(String manuscriptId, long prunedAtMs, String prunedVersionHlc) {
            this.manuscriptId = manuscriptId;
            this.prunedAtMs = prunedAtMs;
            this.prunedVersionHlc = emptyToNull(prunedVersionHlc);
        }
    }

    static final class PairingQrPayload {
        final String mode; // "invite" or "join_wait"
        final String hubId;
        final String fp;
        final List<String> addrs;
        final int port;
        final String sid;
        final String code;
        final String sec; // invite only
        final String epk; // join_wait only

        PairingQrPayload(String mode, String hubId, String fp, List<String> addrs, int port,
                         String sid, String code, String sec, String epk) {
            this.mode = mode;
            this.hubId = hubId;
            this.fp = fp;
            this.addrs = Collections.unmodifiableList(new ArrayList<>(addrs));
            this.port = port;
            this.sid = sid;
            this.code = code;
            this.sec = sec;
            this.epk = epk;
        }
    }

    static final class HubIdentityResponse {
        final String hubInstanceId;
        final String protocolVersion;
        final String serverPubkey;
        final String serverPubkeyFp;
        final List<String> capabilities;

        HubIdentityResponse(String hubInstanceId, String protocolVersion, String serverPubkey,
                            String serverPubkeyFp, List<String> capabilities) {
            this.hubInstanceId = hubInstanceId;
            this.protocolVersion = protocolVersion;
            this.serverPubkey = serverPubkey;
            this.serverPubkeyFp = serverPubkeyFp;
            this.capabilities = capabilities;
        }
    }

    static final class PairingSessionResponse {
        final String sessionId;
        final String mode;
        final String status;
        final long expiresAtMs;
        final String joinerEphPubkey;
        final String senderEphPubkey;
        final String encryptedSeedBox;

        PairingSessionResponse(String sessionId, String mode, String status, long expiresAtMs,
                               String joinerEphPubkey, String senderEphPubkey, String encryptedSeedBox) {
            this.sessionId = sessionId;
            this.mode = mode;
            this.status = status;
            this.expiresAtMs = expiresAtMs;
            this.joinerEphPubkey = emptyToNull(joinerEphPubkey);
            this.senderEphPubkey = emptyToNull(senderEphPubkey);
            this.encryptedSeedBox = emptyToNull(encryptedSeedBox);
        }
    }

    static final class RedeemPairingResponse {
        final String sessionId;
        final String mode;
        final String status;
        final String vaultId;
        final String encryptedSeedBox;

        RedeemPairingResponse(String sessionId, String mode, String status, String vaultId, String encryptedSeedBox) {
            this.sessionId = sessionId;
            this.mode = mode;
            this.status = status;
            this.vaultId = emptyToNull(vaultId);
            this.encryptedSeedBox = emptyToNull(encryptedSeedBox);
        }
    }

    static final class PairedDeviceDTO {
        final String deviceId;
        final String deviceName;
        final String platform;
        final String devicePubkey;
        final List<String> scopes;
        final long pairedAtMs;
        final long lastSeenAtMs;
        final Long revokedAtMs;

        PairedDeviceDTO(String deviceId, String deviceName, String platform, String devicePubkey,
                        List<String> scopes, long pairedAtMs, long lastSeenAtMs, Long revokedAtMs) {
            this.deviceId = deviceId;
            this.deviceName = deviceName;
            this.platform = platform;
            this.devicePubkey = devicePubkey;
            this.scopes = scopes;
            this.pairedAtMs = pairedAtMs;
            this.lastSeenAtMs = lastSeenAtMs;
            this.revokedAtMs = revokedAtMs;
        }
    }

    static final class SyncChangeItem {
        final Long seq;
        final String collection;
        final String recordKey;
        final String versionHlc;
        final String originDeviceId;
        final boolean deleted;
        final String ciphertext;
        final Long updatedAtMs;

        SyncChangeItem(Long seq, String collection, String recordKey, String versionHlc,
                       String originDeviceId, boolean deleted, String ciphertext, Long updatedAtMs) {
            this.seq = seq;
            this.collection = collection;
            this.recordKey = recordKey;
            this.versionHlc = versionHlc;
            this.originDeviceId = originDeviceId;
            this.deleted = deleted;
            this.ciphertext = ciphertext;
            this.updatedAtMs = updatedAtMs;
        }

        JSONObject toJson() throws JSONException {
            JSONObject obj = new JSONObject();
            obj.put("collection", collection);
            obj.put("record_key", recordKey);
            obj.put("version_hlc", versionHlc);
            obj.put("origin_device_id", originDeviceId);
            obj.put("deleted", deleted);
            obj.put("ciphertext", ciphertext);
            return obj;
        }
    }

    static final class PullChangesResponse {
        final String vaultId;
        final String hubInstanceId;
        final long sinceSeq;
        final long latestSeq;
        final boolean hasMore;
        final List<SyncChangeItem> changes;

        PullChangesResponse(String vaultId, String hubInstanceId, long sinceSeq, long latestSeq,
                            boolean hasMore, List<SyncChangeItem> changes) {
            this.vaultId = vaultId;
            this.hubInstanceId = hubInstanceId;
            this.sinceSeq = sinceSeq;
            this.latestSeq = latestSeq;
            this.hasMore = hasMore;
            this.changes = changes;
        }
    }

    static final class PushChangeResult {
        final String collection;
        final String recordKey;
        final String status; // "applied" | "noop" | "stale"
        final long seq;

        PushChangeResult(String collection, String recordKey, String status, long seq) {
            this.collection = collection;
            this.recordKey = recordKey;
            this.status = status;
            this.seq = seq;
        }
    }

    static final class PushChangesResponse {
        final String vaultId;
        final String hubInstanceId;
        final long latestSeq;
        final List<PushChangeResult> results;

        PushChangesResponse(String vaultId, String hubInstanceId, long latestSeq, List<PushChangeResult> results) {
            this.vaultId = vaultId;
            this.hubInstanceId = hubInstanceId;
            this.latestSeq = latestSeq;
            this.results = results;
        }
    }

    static final class SyncRunResult {
        final String hubInstanceId;
        final int pulled;
        final int appliedLocal;
        final int pushed;
        final int appliedRemote;
        final int noopRemote;
        final int staleRemote;
        final long latestSeq;

        SyncRunResult(String hubInstanceId, int pulled, int appliedLocal, int pushed,
                      int appliedRemote, int noopRemote, int staleRemote, long latestSeq) {
            this.hubInstanceId = hubInstanceId;
            this.pulled = pulled;
            this.appliedLocal = appliedLocal;
            this.pushed = pushed;
            this.appliedRemote = appliedRemote;
            this.noopRemote = noopRemote;
            this.staleRemote = staleRemote;
            this.latestSeq = latestSeq;
        }
    }

    static final class SyncStateSummary {
        final boolean enabled;
        final String vaultId;
        final String deviceId;
        final List<KnownHub> knownHubs;

        SyncStateSummary(boolean enabled, String vaultId, String deviceId, List<KnownHub> knownHubs) {
            this.enabled = enabled;
            this.vaultId = vaultId;
            this.deviceId = deviceId;
            this.knownHubs = knownHubs;
        }
    }

    static String emptyToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
