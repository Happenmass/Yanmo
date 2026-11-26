package dev.yanmo.ime;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.UUID;

/**
 * Pure-Java envelope encryption and semantic conflict resolution matching {@code desktop/sync-engine.ts}.
 */
final class SyncMerge {
    static final double COCOA_EPOCH_DIFF_SECONDS = 978307200.0;

    private static final Set<String> KNOWN_LEXICON_KEYS = new HashSet<>(Arrays.asList(
            "schema_version", "local_id", "term", "hint", "aliases", "removed_aliases",
            "group", "device_counts", "last_matched_at_ms", "created_at_ms", "position_hint", "intent_hlc"
    ));

    private static final Set<String> KNOWN_MANUSCRIPT_KEYS = new HashSet<>(Arrays.asList(
            "schema_version", "id", "date", "occurred_at", "recording_ended_at_ms",
            "seconds", "application", "original", "asr_results", "text", "polished",
            "user_edited", "delivery_note", "audio_warning", "source_device_id",
            "audio_blob", "screenshot_blob"
    ));

    private SyncMerge() {}

    interface TickFn {
        String tick();
    }

    static double unixMsToCocoaSeconds(long unixMs) {
        return ((double) unixMs) / 1000.0 - COCOA_EPOCH_DIFF_SECONDS;
    }

    static long cocoaSecondsToUnixMs(double cocoaSeconds) {
        return Math.round((cocoaSeconds + COCOA_EPOCH_DIFF_SECONDS) * 1000.0);
    }

    static String encryptSyncRecord(
            byte[] dataEncKey,
            String vaultId,
            String collection,
            String recordKey,
            String versionHlc,
            boolean deleted,
            JSONObject payload,
            String originDeviceId
    ) throws Exception {
        byte[] aad = SyncCrypto.recordAad(vaultId, collection, recordKey, versionHlc, deleted, originDeviceId);
        byte[] plain = payload.toString().getBytes(StandardCharsets.UTF_8);
        return SyncCrypto.base64UrlEncode(SyncCrypto.sealEnvelope(dataEncKey, plain, aad, true));
    }

    static JSONObject decryptSyncRecord(
            byte[] dataEncKey,
            String vaultId,
            SyncModels.SyncChangeItem change
    ) throws Exception {
        byte[] aad = SyncCrypto.recordAad(
                vaultId, change.collection, change.recordKey, change.versionHlc, change.deleted,
                change.originDeviceId == null ? "" : change.originDeviceId
        );
        byte[] plain = SyncCrypto.openEnvelope(dataEncKey, SyncCrypto.base64UrlDecode(change.ciphertext), aad);
        return new JSONObject(new String(plain, StandardCharsets.UTF_8));
    }

    static byte[] encryptSyncBlob(byte[] dataEncKey, String vaultId, String blobId, byte[] plaintext)
            throws Exception {
        return SyncCrypto.sealEnvelope(dataEncKey, plaintext, SyncCrypto.blobAad(vaultId, blobId), false);
    }

    static byte[] decryptSyncBlob(byte[] dataEncKey, String vaultId, String blobId, byte[] encryptedBytes)
            throws Exception {
        return SyncCrypto.openEnvelope(dataEncKey, encryptedBytes, SyncCrypto.blobAad(vaultId, blobId));
    }

    static final class LexiconOutcome {
        final boolean changed;
        final boolean deleted;
        final SyncModels.LexiconRecord entry;
        final SyncModels.SyncEntryRow syncEntry;
        final boolean fromRemoteExact;

        LexiconOutcome(boolean changed, boolean deleted, SyncModels.LexiconRecord entry,
                       SyncModels.SyncEntryRow syncEntry, boolean fromRemoteExact) {
            this.changed = changed;
            this.deleted = deleted;
            this.entry = entry;
            this.syncEntry = syncEntry;
            this.fromRemoteExact = fromRemoteExact;
        }
    }

    static final class ManuscriptOutcome {
        final boolean applied;
        final boolean deleted;
        final SyncModels.ManuscriptRecord manuscript;
        final SyncModels.SyncEntryRow syncEntry;
        final boolean clearPruned;

        ManuscriptOutcome(boolean applied, boolean deleted, SyncModels.ManuscriptRecord manuscript,
                          SyncModels.SyncEntryRow syncEntry, boolean clearPruned) {
            this.applied = applied;
            this.deleted = deleted;
            this.manuscript = manuscript;
            this.syncEntry = syncEntry;
            this.clearPruned = clearPruned;
        }
    }

    static Map<String, Long> normalizeDeviceCounts(JSONObject raw) {
        if (raw == null) return Collections.emptyMap();
        Map<String, Long> out = new TreeMap<>();
        Iterator<String> it = raw.keys();
        while (it.hasNext()) {
            String devId = it.next();
            if (devId == null || devId.isEmpty()) continue;
            Object val = raw.opt(devId);
            if (val instanceof Number) {
                long n = ((Number) val).longValue();
                double d = ((Number) val).doubleValue();
                if (n >= 0 && Double.compare(d, (double) n) == 0) {
                    out.put(devId, n);
                }
            }
        }
        return out;
    }

    static long sumDeviceCounts(Map<String, Long> counts) {
        long total = 0L;
        for (Long v : counts.values()) {
            if (v != null && v > 0) total += v;
        }
        return total;
    }

    static boolean sameDeviceCounts(Map<String, Long> a, Map<String, Long> b) {
        Map<String, Long> fa = positiveCounts(a);
        Map<String, Long> fb = positiveCounts(b);
        return fa.equals(fb);
    }

    private static Map<String, Long> positiveCounts(Map<String, Long> m) {
        Map<String, Long> out = new TreeMap<>();
        for (Map.Entry<String, Long> e : m.entrySet()) {
            if (e.getValue() != null && e.getValue() > 0) out.put(e.getKey(), e.getValue());
        }
        return out;
    }

    static List<String> dedupeAliases(List<String> aliases, String excludeKey, Set<String> removedSet) {
        Set<String> seen = new HashSet<>();
        List<String> out = new ArrayList<>();
        if (aliases == null) return out;
        for (String alias : aliases) {
            if (alias == null) continue;
            String trimmed = alias.trim();
            String key = SyncCrypto.normalizeTermKey(trimmed);
            if (key.isEmpty() || key.equals(excludeKey) || removedSet.contains(key) || !seen.add(key)) {
                continue;
            }
            out.add(trimmed);
        }
        return out;
    }

    static boolean sameAliases(List<String> a, List<String> b) {
        if (a.size() != b.size()) return false;
        Set<String> sa = new HashSet<>();
        Set<String> sb = new HashSet<>();
        for (String s : a) sa.add(SyncCrypto.normalizeTermKey(s));
        for (String s : b) sb.add(SyncCrypto.normalizeTermKey(s));
        return sa.equals(sb);
    }

    private static JSONObject extractUnknownFields(JSONObject obj, Set<String> knownKeys) throws JSONException {
        JSONObject extra = new JSONObject();
        boolean hasExtra = false;
        Iterator<String> it = obj.keys();
        while (it.hasNext()) {
            String k = it.next();
            if (!knownKeys.contains(k) && !obj.isNull(k)) {
                extra.put(k, obj.get(k));
                hasExtra = true;
            }
        }
        return hasExtra ? extra : null;
    }

    private static JSONObject mergeUnknownFields(JSONObject primary, JSONObject secondary) throws JSONException {
        JSONObject out = new JSONObject();
        if (secondary != null) {
            Iterator<String> it = secondary.keys();
            while (it.hasNext()) {
                String k = it.next();
                out.put(k, secondary.get(k));
            }
        }
        if (primary != null) {
            Iterator<String> it = primary.keys();
            while (it.hasNext()) {
                String k = it.next();
                out.put(k, primary.get(k));
            }
        }
        return out.length() > 0 ? out : null;
    }

    private static String normalizeOptionalGroup(Object raw) {
        if (!(raw instanceof String)) return null;
        String s = ((String) raw).trim();
        if ("global".equals(s) || "ai_tools".equals(s)) return s;
        return null;
    }

    private static List<String> stringListFromJson(JSONArray arr) {
        if (arr == null) return Collections.emptyList();
        List<String> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            Object v = arr.opt(i);
            if (v instanceof String) out.add((String) v);
        }
        return out;
    }

    private static JSONArray sortedStringArray(Set<String> values) {
        TreeSet<String> sorted = new TreeSet<>(values);
        JSONArray arr = new JSONArray();
        for (String s : sorted) arr.put(s);
        return arr;
    }

    private static JSONObject countsToJson(Map<String, Long> counts) throws JSONException {
        JSONObject obj = new JSONObject();
        for (Map.Entry<String, Long> e : new TreeMap<>(counts).entrySet()) {
            if (e.getValue() != null && e.getValue() >= 0) {
                obj.put(e.getKey(), e.getValue().longValue());
            }
        }
        return obj;
    }

    static LexiconOutcome mergeLexiconState(
            SyncModels.LexiconRecord localEntry,
            SyncModels.SyncEntryRow localSync,
            String recordKey,
            JSONObject remotePayload,
            String remoteVersionHlc,
            String remoteOriginDeviceId,
            boolean remoteDeleted,
            long remoteUpdatedAtMs,
            String localDeviceId,
            TickFn tickFn
    ) throws JSONException {
        Map<String, Long> remoteCounts = normalizeDeviceCounts(remotePayload.optJSONObject("device_counts"));
        Set<String> remoteRemoved = new HashSet<>();
        JSONArray removedArr = remotePayload.optJSONArray("removed_aliases");
        if (removedArr != null) {
            for (int i = 0; i < removedArr.length(); i++) {
                String k = SyncCrypto.normalizeTermKey(String.valueOf(removedArr.opt(i)));
                if (!k.isEmpty()) remoteRemoved.add(k);
            }
        }
        JSONObject remoteUnknown = extractUnknownFields(remotePayload, KNOWN_LEXICON_KEYS);
        String remoteTermStr = remotePayload.opt("term") instanceof String
                ? ((String) remotePayload.opt("term")).trim() : "";
        String remoteHint = remotePayload.opt("hint") instanceof String
                ? (String) remotePayload.opt("hint") : "";
        String remoteGroup = normalizeOptionalGroup(remotePayload.opt("group"));
        List<String> remoteAliases = dedupeAliases(
                stringListFromJson(remotePayload.optJSONArray("aliases")),
                SyncCrypto.normalizeTermKey(remoteTermStr),
                remoteRemoved
        );
        Long remoteLastMatched = remotePayload.opt("last_matched_at_ms") instanceof Number
                ? ((Number) remotePayload.opt("last_matched_at_ms")).longValue() : null;
        Long remoteCreatedAt = remotePayload.opt("created_at_ms") instanceof Number
                ? ((Number) remotePayload.opt("created_at_ms")).longValue() : null;
        Integer remotePosHint = remotePayload.opt("position_hint") instanceof Number
                ? ((Number) remotePayload.opt("position_hint")).intValue() : null;

        if (localSync == null) {
            if (remoteDeleted) {
                JSONObject meta = new JSONObject();
                if (remoteUnknown != null) meta.put("unknownFields", remoteUnknown);
                return new LexiconOutcome(true, true, null, new SyncModels.SyncEntryRow(
                        SyncModels.COLLECTION_LEXICON, recordKey, null, remoteVersionHlc,
                        remoteOriginDeviceId, true, remoteUpdatedAtMs, remoteUpdatedAtMs, meta
                ), true);
            }
            String localId = remotePayload.opt("local_id") instanceof String && !((String) remotePayload.opt("local_id")).isEmpty()
                    ? (String) remotePayload.opt("local_id") : UUID.randomUUID().toString();
            String remoteIntentHlc = remotePayload.opt("intent_hlc") instanceof String && !((String) remotePayload.opt("intent_hlc")).isEmpty()
                    ? (String) remotePayload.opt("intent_hlc") : remoteVersionHlc;
            long matchCount = sumDeviceCounts(remoteCounts);
            SyncModels.LexiconRecord entry = new SyncModels.LexiconRecord(
                    localId, remoteTermStr, remoteHint, remoteAliases,
                    remoteGroup != null ? remoteGroup : Lexicon.GLOBAL,
                    matchCount,
                    remoteLastMatched != null ? remoteLastMatched : 0L,
                    remoteCreatedAt != null ? remoteCreatedAt : 0L
            );
            JSONObject meta = new JSONObject();
            meta.put("intentHlc", remoteIntentHlc);
            meta.put("deviceCounts", countsToJson(remoteCounts));
            meta.put("removedAliases", sortedStringArray(remoteRemoved));
            if (remotePosHint != null) meta.put("positionHint", remotePosHint.intValue());
            if (remoteUnknown != null) meta.put("unknownFields", remoteUnknown);
            return new LexiconOutcome(true, false, entry, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_LEXICON, recordKey, localId, remoteVersionHlc,
                    remoteOriginDeviceId, false, null, remoteUpdatedAtMs, meta
            ), true);
        }

        int cmp = SyncHlc.compareHlc(remoteVersionHlc, localSync.versionHlc);
        String localIntentHlc = localSync.meta.optString("intentHlc", "");
        if (localIntentHlc.isEmpty()) localIntentHlc = localSync.versionHlc;
        String remoteIntentHlc = remotePayload.opt("intent_hlc") instanceof String && !((String) remotePayload.opt("intent_hlc")).isEmpty()
                ? (String) remotePayload.opt("intent_hlc") : remoteVersionHlc;

        if (localSync.deleted || remoteDeleted) {
            if (localSync.deleted && remoteDeleted) {
                SyncModels.SyncEntryRow nextSync = cmp > 0
                        ? new SyncModels.SyncEntryRow(SyncModels.COLLECTION_LEXICON, localSync.recordKey, localSync.localId,
                        remoteVersionHlc, remoteOriginDeviceId, true, remoteUpdatedAtMs, remoteUpdatedAtMs, localSync.meta)
                        : localSync;
                return new LexiconOutcome(false, true, localEntry, nextSync, cmp >= 0);
            }
            if (localSync.deleted) {
                if (SyncHlc.compareHlc(remoteIntentHlc, localSync.versionHlc) <= 0) {
                    return new LexiconOutcome(false, true, localEntry, localSync, false);
                }
            } else {
                if (SyncHlc.compareHlc(remoteVersionHlc, localIntentHlc) <= 0) {
                    return new LexiconOutcome(false, false, localEntry, localSync, false);
                }
            }
            if (remoteDeleted) {
                JSONObject meta = new JSONObject();
                if (remoteUnknown != null) meta.put("unknownFields", remoteUnknown);
                return new LexiconOutcome(true, true, null, new SyncModels.SyncEntryRow(
                        SyncModels.COLLECTION_LEXICON, recordKey, null, remoteVersionHlc,
                        remoteOriginDeviceId, true, remoteUpdatedAtMs, remoteUpdatedAtMs, meta
                ), true);
            }
            String localId = localSync.localId != null && !localSync.localId.isEmpty()
                    ? localSync.localId
                    : (remotePayload.opt("local_id") instanceof String && !((String) remotePayload.opt("local_id")).isEmpty()
                    ? (String) remotePayload.opt("local_id") : UUID.randomUUID().toString());
            long matchCount = sumDeviceCounts(remoteCounts);
            SyncModels.LexiconRecord entry = new SyncModels.LexiconRecord(
                    localId, remoteTermStr, remoteHint, remoteAliases,
                    remoteGroup != null ? remoteGroup : Lexicon.GLOBAL,
                    matchCount,
                    remoteLastMatched != null ? remoteLastMatched : 0L,
                    remoteCreatedAt != null ? remoteCreatedAt : 0L
            );
            String nextVersionHlc = cmp >= 0 ? remoteVersionHlc : tickFn.tick();
            String nextIntentHlc = SyncHlc.compareHlc(remoteIntentHlc, nextVersionHlc) >= 0 ? remoteIntentHlc : nextVersionHlc;
            JSONObject meta = new JSONObject();
            meta.put("intentHlc", nextIntentHlc);
            meta.put("deviceCounts", countsToJson(remoteCounts));
            meta.put("removedAliases", sortedStringArray(remoteRemoved));
            if (remotePosHint != null) meta.put("positionHint", remotePosHint.intValue());
            if (remoteUnknown != null) meta.put("unknownFields", remoteUnknown);
            return new LexiconOutcome(true, false, entry, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_LEXICON, recordKey, localId, nextVersionHlc,
                    cmp >= 0 ? remoteOriginDeviceId : localDeviceId, false, null, remoteUpdatedAtMs, meta
            ), cmp >= 0);
        }

        // Both sides active: CRDT device_counts + alias union/tombstones + intent-HLC LWW scalars
        int intentCmp = SyncHlc.compareHlc(remoteIntentHlc, localIntentHlc);
        boolean remoteIsNewer = intentCmp != 0 ? intentCmp > 0 : cmp > 0;
        Map<String, Long> localCounts = new TreeMap<>(normalizeDeviceCounts(localSync.meta.optJSONObject("deviceCounts")));
        if (localCounts.isEmpty() && localEntry.matchCount > 0) {
            localCounts.put(localDeviceId, localEntry.matchCount);
        }
        Map<String, Long> mergedCounts = new TreeMap<>(localCounts);
        for (Map.Entry<String, Long> e : remoteCounts.entrySet()) {
            Long prev = mergedCounts.get(e.getKey());
            if (prev == null || e.getValue() > prev) {
                mergedCounts.put(e.getKey(), e.getValue());
            }
        }

        Set<String> localRemoved = new HashSet<>();
        JSONArray localRemovedArr = localSync.meta.optJSONArray("removedAliases");
        if (localRemovedArr != null) {
            for (int i = 0; i < localRemovedArr.length(); i++) {
                String k = SyncCrypto.normalizeTermKey(String.valueOf(localRemovedArr.opt(i)));
                if (!k.isEmpty()) localRemoved.add(k);
            }
        }
        List<String> localAliases = localEntry.aliases;
        List<String> winnerAliases = remoteIsNewer ? remoteAliases : localAliases;
        List<String> loserAliases = remoteIsNewer ? localAliases : remoteAliases;
        Set<String> winnerRemoved = remoteIsNewer ? remoteRemoved : localRemoved;
        Set<String> loserRemoved = remoteIsNewer ? localRemoved : remoteRemoved;

        Set<String> winnerAliasKeys = new HashSet<>();
        for (String a : winnerAliases) {
            String k = SyncCrypto.normalizeTermKey(a);
            if (!k.isEmpty()) winnerAliasKeys.add(k);
        }
        Set<String> mergedRemoved = new HashSet<>(winnerRemoved);
        for (String k : loserRemoved) {
            if (!winnerAliasKeys.contains(k)) mergedRemoved.add(k);
        }

        String mergedTerm = remoteIsNewer ? remoteTermStr : localEntry.term;
        String mergedHint = remoteIsNewer ? remoteHint : localEntry.hint;
        String localGroup = normalizeOptionalGroup(localEntry.group);
        String mergedGroup = remoteIsNewer ? remoteGroup : localGroup;
        List<String> combinedAliases = new ArrayList<>(winnerAliases.size() + loserAliases.size());
        combinedAliases.addAll(winnerAliases);
        combinedAliases.addAll(loserAliases);
        List<String> mergedAliases = dedupeAliases(combinedAliases, SyncCrypto.normalizeTermKey(mergedTerm), mergedRemoved);

        Long localLast = localEntry.lastMatchedAtMs > 0 ? localEntry.lastMatchedAtMs : null;
        Long mergedLast = localLast == null ? remoteLastMatched
                : (remoteLastMatched == null ? localLast : Math.max(localLast, remoteLastMatched));

        Long localCreated = localEntry.createdAtMs > 0 ? localEntry.createdAtMs : null;
        Long mergedCreated = localCreated == null ? remoteCreatedAt
                : (remoteCreatedAt == null ? localCreated : Math.min(localCreated, remoteCreatedAt));

        JSONObject localUnknown = localSync.meta.optJSONObject("unknownFields");
        JSONObject mergedUnknown = remoteIsNewer
                ? mergeUnknownFields(remoteUnknown, localUnknown)
                : mergeUnknownFields(localUnknown, remoteUnknown);

        long matchCount = sumDeviceCounts(mergedCounts);
        SyncModels.LexiconRecord mergedEntry = new SyncModels.LexiconRecord(
                localEntry.id, mergedTerm, mergedHint, mergedAliases,
                mergedGroup != null ? mergedGroup : Lexicon.GLOBAL,
                matchCount,
                mergedLast != null ? mergedLast : 0L,
                mergedCreated != null ? mergedCreated : 0L
        );

        boolean sameAsRemote = mergedTerm.equals(remoteTermStr)
                && mergedHint.equals(remoteHint)
                && Objects.equals(mergedGroup, remoteGroup)
                && sameDeviceCounts(mergedCounts, remoteCounts)
                && sameAliases(mergedAliases, remoteAliases)
                && Objects.equals(mergedLast, remoteLastMatched)
                && Objects.equals(mergedCreated, remoteCreatedAt);

        boolean sameAsLocal = mergedTerm.equals(localEntry.term)
                && mergedHint.equals(localEntry.hint)
                && Objects.equals(mergedGroup, localGroup)
                && sameDeviceCounts(mergedCounts, localCounts)
                && sameAliases(mergedAliases, localAliases)
                && Objects.equals(mergedLast, localLast)
                && Objects.equals(mergedCreated, localCreated);

        String maxIntentHlc = intentCmp >= 0 ? remoteIntentHlc : localIntentHlc;

        if (sameAsLocal && cmp <= 0) {
            JSONObject nextMeta = new JSONObject(localSync.meta.toString());
            nextMeta.put("intentHlc", maxIntentHlc);
            return new LexiconOutcome(false, false, localEntry, new SyncModels.SyncEntryRow(
                    localSync.collection, localSync.recordKey, localSync.localId, localSync.versionHlc,
                    localSync.originDeviceId, localSync.deleted, localSync.deletedAtMs, localSync.updatedAtMs, nextMeta
            ), false);
        }

        boolean useRemoteHlc = sameAsRemote && cmp >= 0;
        String versionHlc = useRemoteHlc ? remoteVersionHlc : tickFn.tick();
        String originDeviceId = useRemoteHlc ? remoteOriginDeviceId : localDeviceId;
        long updatedAtMs = useRemoteHlc ? remoteUpdatedAtMs : Math.max(localSync.updatedAtMs, remoteUpdatedAtMs);

        JSONObject meta = new JSONObject();
        meta.put("intentHlc", maxIntentHlc);
        meta.put("deviceCounts", countsToJson(mergedCounts));
        meta.put("removedAliases", sortedStringArray(mergedRemoved));
        if (remoteIsNewer && remotePosHint != null) {
            meta.put("positionHint", remotePosHint.intValue());
        } else if (localSync.meta.has("positionHint")) {
            meta.put("positionHint", localSync.meta.optInt("positionHint"));
        }
        if (mergedUnknown != null) meta.put("unknownFields", mergedUnknown);

        return new LexiconOutcome(!sameAsLocal, false, mergedEntry, new SyncModels.SyncEntryRow(
                SyncModels.COLLECTION_LEXICON, recordKey, localEntry.id, versionHlc, originDeviceId,
                false, null, updatedAtMs, meta
        ), useRemoteHlc);
    }

    static ManuscriptOutcome mergeManuscriptState(
            SyncModels.SyncEntryRow localSync,
            String recordKey,
            JSONObject remotePayload,
            String remoteVersionHlc,
            String remoteOriginDeviceId,
            boolean remoteDeleted,
            long remoteUpdatedAtMs,
            SyncModels.SyncPrunedRow prunedInfo
    ) throws JSONException {
        if (!remoteDeleted && prunedInfo != null) {
            if (prunedInfo.prunedVersionHlc == null
                    || SyncHlc.compareHlc(remoteVersionHlc, prunedInfo.prunedVersionHlc) <= 0) {
                return new ManuscriptOutcome(false, false, null, null, false);
            }
        }
        if (localSync != null && SyncHlc.compareHlc(remoteVersionHlc, localSync.versionHlc) <= 0) {
            return new ManuscriptOutcome(false, localSync.deleted, null, null, false);
        }

        JSONObject unknownFields = extractUnknownFields(remotePayload, KNOWN_MANUSCRIPT_KEYS);
        if (remoteDeleted) {
            JSONObject meta = new JSONObject();
            if (unknownFields != null) meta.put("unknownFields", unknownFields);
            SyncModels.ManuscriptRecord tombstoneRecord = new SyncModels.ManuscriptRecord(
                    recordKey, 0L, "", "", "", "", "", 0.0, false, null, null, Collections.emptyList(), null
            );
            return new ManuscriptOutcome(true, true, tombstoneRecord, new SyncModels.SyncEntryRow(
                    SyncModels.COLLECTION_MANUSCRIPT, recordKey, null, remoteVersionHlc,
                    remoteOriginDeviceId, true, remoteUpdatedAtMs, remoteUpdatedAtMs, meta
            ), prunedInfo != null);
        }

        String id = remotePayload.optString("id", "").trim();
        if (id.isEmpty()) id = recordKey;
        long createdAtMs = parseManuscriptCreatedAtMs(remotePayload, remoteUpdatedAtMs);
        String original = remotePayload.opt("original") instanceof String ? (String) remotePayload.opt("original") : "";
        String text = remotePayload.opt("text") instanceof String ? (String) remotePayload.opt("text") : "";
        boolean isPolished = remotePayload.optBoolean("polished", false);
        String polishedText = isPolished ? text : "";
        if (!isPolished && original.isEmpty() && !text.isEmpty()) {
            original = text;
        }
        double seconds = Math.max(0.0, remotePayload.optDouble("seconds", 0.0));
        if (!Double.isFinite(seconds)) seconds = 0.0;
        String application = remotePayload.opt("application") instanceof String ? (String) remotePayload.opt("application") : "";
        boolean userEdited = remotePayload.optBoolean("user_edited", false);
        String deliveryNote = remotePayload.opt("delivery_note") instanceof String ? (String) remotePayload.opt("delivery_note") : null;
        String audioWarning = remotePayload.opt("audio_warning") instanceof String ? (String) remotePayload.opt("audio_warning") : null;
        List<SyncModels.AsrResult> asrResults = SyncModels.AsrResult.fromJsonArray(remotePayload.optJSONArray("asr_results"));
        String sourceDeviceId = remotePayload.opt("source_device_id") instanceof String && !((String) remotePayload.opt("source_device_id")).isEmpty()
                ? (String) remotePayload.opt("source_device_id") : remoteOriginDeviceId;

        SyncModels.BlobRef audioBlob = SyncModels.BlobRef.fromJson(remotePayload.optJSONObject("audio_blob"));
        SyncModels.BlobRef screenshotBlob = SyncModels.BlobRef.fromJson(remotePayload.optJSONObject("screenshot_blob"));

        JSONObject meta = new JSONObject();
        if (sourceDeviceId != null && !sourceDeviceId.isEmpty()) meta.put("sourceDeviceId", sourceDeviceId);
        if (audioBlob != null) meta.put("audioBlob", audioBlob.toJson());
        if (screenshotBlob != null) meta.put("screenshotBlob", screenshotBlob.toJson());
        if (unknownFields != null) meta.put("unknownFields", unknownFields);

        SyncModels.ManuscriptRecord record = new SyncModels.ManuscriptRecord(
                id, createdAtMs, original, polishedText, "", "", application,
                seconds, userEdited, deliveryNote, audioWarning, asrResults, sourceDeviceId
        );
        return new ManuscriptOutcome(true, false, record, new SyncModels.SyncEntryRow(
                SyncModels.COLLECTION_MANUSCRIPT, recordKey, id, remoteVersionHlc,
                remoteOriginDeviceId, false, null, remoteUpdatedAtMs, meta
        ), prunedInfo != null);
    }

    static long parseManuscriptCreatedAtMs(JSONObject payload, long fallbackMs) {
        Object rawDate = payload.opt("date");
        if (rawDate instanceof Number) {
            double cocoaSec = ((Number) rawDate).doubleValue();
            if (Double.isFinite(cocoaSec)) {
                return cocoaSecondsToUnixMs(cocoaSec);
            }
        }
        String occurred = payload.optString("occurred_at", "").trim();
        if (!occurred.isEmpty()) {
            try {
                return Instant.parse(occurred).toEpochMilli();
            } catch (Exception ignored) {
            }
        }
        return fallbackMs;
    }

    static JSONObject buildOutgoingLexiconPayload(
            SyncModels.SyncEntryRow entry,
            SyncModels.LexiconRecord term,
            String localDeviceId,
            byte[] keyMacKey
    ) throws Exception {
        JSONObject payload = new JSONObject();
        copyUnknownFields(entry.meta.optJSONObject("unknownFields"), payload);
        if (entry.deleted) {
            payload.put("schema_version", 1);
            payload.put("local_id", entry.localId == null ? "" : entry.localId);
            payload.put("term", "");
            payload.put("hint", "");
            payload.put("aliases", new JSONArray());
            payload.put("removed_aliases", new JSONArray());
            payload.put("group", JSONObject.NULL);
            payload.put("device_counts", new JSONObject());
            payload.put("last_matched_at_ms", JSONObject.NULL);
            payload.put("created_at_ms", JSONObject.NULL);
            return payload;
        }
        if (term == null) return null;
        Map<String, Long> deviceCounts = new TreeMap<>(normalizeDeviceCounts(entry.meta.optJSONObject("deviceCounts")));
        if (deviceCounts.isEmpty() && term.matchCount > 0) {
            deviceCounts.put(localDeviceId, term.matchCount);
        }
        JSONArray aliasesArr = new JSONArray();
        for (String a : term.aliases) aliasesArr.put(a);
        JSONArray removedArr = entry.meta.optJSONArray("removedAliases");
        if (removedArr == null) removedArr = new JSONArray();

        payload.put("schema_version", 1);
        payload.put("local_id", term.id);
        payload.put("term", term.term);
        payload.put("hint", term.hint == null ? "" : term.hint);
        payload.put("aliases", aliasesArr);
        payload.put("removed_aliases", removedArr);
        payload.put("group", term.group == null ? JSONObject.NULL : term.group);
        payload.put("device_counts", countsToJson(deviceCounts));
        payload.put("last_matched_at_ms", term.lastMatchedAtMs > 0 ? term.lastMatchedAtMs : JSONObject.NULL);
        payload.put("created_at_ms", term.createdAtMs > 0 ? term.createdAtMs : JSONObject.NULL);
        String intentHlc = entry.meta.optString("intentHlc", "");
        if (!intentHlc.isEmpty()) payload.put("intent_hlc", intentHlc);
        if (entry.meta.has("positionHint")) payload.put("position_hint", entry.meta.optInt("positionHint"));
        return payload;
    }

    static JSONObject buildOutgoingManuscriptPayload(
            SyncModels.SyncEntryRow entry,
            SyncModels.ManuscriptRecord item,
            String localDeviceId
    ) throws JSONException {
        JSONObject payload = new JSONObject();
        copyUnknownFields(entry.meta.optJSONObject("unknownFields"), payload);
        if (entry.deleted) {
            payload.put("schema_version", 1);
            payload.put("id", entry.recordKey);
            return payload;
        }
        if (item == null) return null;
        boolean hasPolished = item.polishedText != null && !item.polishedText.isEmpty();
        String finalText = hasPolished ? item.polishedText : item.original;
        long createdMs = item.createdAtMs > 0 ? item.createdAtMs : entry.updatedAtMs;
        double cocoaDate = unixMsToCocoaSeconds(createdMs);
        String occurredAt = Instant.ofEpochMilli(createdMs).toString();
        String sourceDeviceId = entry.meta.optString("sourceDeviceId", "");
        if (sourceDeviceId.isEmpty()) sourceDeviceId = item.sourceDeviceId != null ? item.sourceDeviceId : entry.originDeviceId;
        if (sourceDeviceId == null || sourceDeviceId.isEmpty()) sourceDeviceId = localDeviceId;

        payload.put("schema_version", 1);
        payload.put("id", item.id);
        payload.put("date", cocoaDate);
        payload.put("occurred_at", occurredAt);
        payload.put("recording_ended_at_ms", JSONObject.NULL);
        payload.put("seconds", item.seconds);
        payload.put("application", item.application);
        payload.put("original", item.original);
        payload.put("asr_results", SyncModels.AsrResult.toJsonArray(item.asrResults));
        payload.put("text", finalText);
        payload.put("polished", hasPolished);
        payload.put("user_edited", item.userEdited);
        payload.put("delivery_note", item.deliveryNote == null ? JSONObject.NULL : item.deliveryNote);
        payload.put("audio_warning", item.audioWarning == null ? JSONObject.NULL : item.audioWarning);
        payload.put("source_device_id", sourceDeviceId);
        JSONObject audioBlob = entry.meta.optJSONObject("audioBlob");
        JSONObject screenshotBlob = entry.meta.optJSONObject("screenshotBlob");
        payload.put("audio_blob", audioBlob == null ? JSONObject.NULL : audioBlob);
        payload.put("screenshot_blob", screenshotBlob == null ? JSONObject.NULL : screenshotBlob);
        return payload;
    }

    private static void copyUnknownFields(JSONObject unknown, JSONObject target) throws JSONException {
        if (unknown == null) return;
        Iterator<String> it = unknown.keys();
        while (it.hasNext()) {
            String k = it.next();
            target.put(k, unknown.get(k));
        }
    }
}
