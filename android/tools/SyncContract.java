package dev.yanmo.ime;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Host-JVM cross-platform interoperability & contract verifier for Android sync components.
 */
public final class SyncContract {
    private static final class MemorySecretStore implements SyncPairing.SyncSecretStore {
        SyncModels.SyncSecrets data;
        @Override public SyncModels.SyncSecrets load() { return data; }
        @Override public void save(SyncModels.SyncSecrets secrets) { this.data = secrets; }
    }

    private static final class MemoryHubStore implements SyncPairing.KnownHubStore {
        List<SyncModels.KnownHub> hubs = new ArrayList<>();
        @Override public List<SyncModels.KnownHub> load() { return new ArrayList<>(hubs); }
        @Override public void save(List<SyncModels.KnownHub> hubs) { this.hubs = new ArrayList<>(hubs); }
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("Usage: SyncContract <input-fixture.json> <output.json>");
            System.exit(2);
        }
        JSONObject input = new JSONObject(Files.readString(Path.of(args[0]), StandardCharsets.UTF_8));
        JSONObject output = new JSONObject();

        // 1. Recovery code + HKDF SpaceKeys + FP + recordKey + blobId parity
        String recoveryCode = input.getString("recovery_code");
        byte[] decodedSeed = SyncCrypto.decodeRecoveryCode(recoveryCode);
        String reencodedCode = SyncCrypto.encodeRecoveryCode(decodedSeed);
        assertTrue(recoveryCode.equals(reencodedCode), "recovery code roundtrip mismatch");

        SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(decodedSeed);
        assertTrue(input.getString("vault_id").equals(space.vaultId), "vault_id mismatch");
        assertTrue(input.getString("owner_pubkey").equals(space.ownerPublicKeyB64), "owner_pubkey mismatch");
        assertTrue(input.getString("owner_fp").equals(SyncCrypto.computePubkeyFingerprint(space.ownerPublicKeyRaw)), "owner_fp mismatch");
        assertTrue(input.getString("recovery_code").equals(SyncCrypto.encodeRecoveryCode(decodedSeed)), "reencode");

        String rk = SyncCrypto.computeLexiconRecordKey(
                space.keyMacKey, input.getString("sample_term"), input.getString("sample_group"));
        assertTrue(input.getString("lexicon_record_key").equals(rk), "lexicon record_key mismatch");

        byte[] sampleBlobPlain = SyncCrypto.base64UrlDecode(input.getString("sample_blob_plain_b64"));
        String blobId = SyncCrypto.computeBlobId(space.keyMacKey, SyncCrypto.sha256Hex(sampleBlobPlain));
        assertTrue(input.getString("blob_id").equals(blobId), "blob_id mismatch");

        // 2. Verify Desktop-signed membership cert & create Android-signed cert
        JSONObject desktopCert = input.getJSONObject("desktop_cert");
        assertTrue(SyncCrypto.verifyMembershipCert(space.ownerPublicKeyRaw, desktopCert), "desktop cert verify failed");
        SyncCrypto.DeviceIdentity androidDev = SyncCrypto.generateDeviceIdentity();
        JSONObject androidCert = SyncCrypto.signMembershipCert(
                space.ownerSignSeed, space.vaultId, androidDev.deviceId, androidDev.publicKeyB64,
                "android", 1764000000123L
        );
        assertTrue(SyncCrypto.verifyMembershipCert(space.ownerPublicKeyRaw, androidCert), "android cert self-verify");

        // 3. Decrypt Desktop compressed lexicon & manuscript envelopes + binary blob
        JSONObject deskLexChange = input.getJSONObject("desktop_lexicon_change");
        SyncModels.SyncChangeItem lexItem = new SyncModels.SyncChangeItem(
                1L, "lexicon", deskLexChange.getString("record_key"),
                deskLexChange.getString("version_hlc"), deskLexChange.getString("origin_device_id"),
                false, deskLexChange.getString("ciphertext"), 1764000001000L
        );
        JSONObject decryptedLex = SyncMerge.decryptSyncRecord(space.dataEncKey, space.vaultId, lexItem);
        assertTrue(input.getString("sample_term").equals(decryptedLex.getString("term")), "decrypted lexicon term");

        JSONObject deskMsChange = input.getJSONObject("desktop_manuscript_change");
        SyncModels.SyncChangeItem msItem = new SyncModels.SyncChangeItem(
                2L, "manuscript", deskMsChange.getString("record_key"),
                deskMsChange.getString("version_hlc"), deskMsChange.getString("origin_device_id"),
                false, deskMsChange.getString("ciphertext"), 1764000002000L
        );
        JSONObject decryptedMs = SyncMerge.decryptSyncRecord(space.dataEncKey, space.vaultId, msItem);
        SyncMerge.ManuscriptOutcome msOutcome = SyncMerge.mergeManuscriptState(
                null, msItem.recordKey, decryptedMs, msItem.versionHlc, msItem.originDeviceId, false, 1764000002000L, null
        );
        assertTrue(msOutcome.applied && !msOutcome.deleted && msOutcome.manuscript != null, "manuscript merge");
        assertTrue(Math.abs(msOutcome.manuscript.createdAtMs - input.getLong("manuscript_unix_ms")) <= 1L,
                "cocoa->unix ms mismatch: " + msOutcome.manuscript.createdAtMs);

        byte[] decryptedBlob = SyncMerge.decryptSyncBlob(
                space.dataEncKey, space.vaultId, blobId,
                SyncCrypto.base64UrlDecode(input.getString("encrypted_blob_b64"))
        );
        assertTrue(Arrays.equals(sampleBlobPlain, decryptedBlob), "decrypted blob bytes mismatch");

        // 4. Semantic Lexicon Merge tests (CRDT device_counts, removed_aliases, intent_hlc delete/resurrect)
        SyncHlc.Clock clock = new SyncHlc.Clock(androidDev.deviceId, 1764000003000L, 0, () -> 1764000003000L);
        String localHlc = clock.tick();
        JSONObject localMeta = new JSONObject()
                .put("intentHlc", "001764000003000-0000-devA")
                .put("deviceCounts", new JSONObject().put(androidDev.deviceId, 3L).put("mac-1", 2L))
                .put("removedAliases", new JSONArray(Collections.singletonList("readded_alias")))
                .put("unknownFields", new JSONObject().put("future_flag", true));
        SyncModels.SyncEntryRow localSync = new SyncModels.SyncEntryRow(
                "lexicon", rk, "loc-1", localHlc, androidDev.deviceId, false, null, 1764000003000L, localMeta
        );
        SyncModels.LexiconRecord localRec = new SyncModels.LexiconRecord(
                "loc-1", "Antigravity", "local-hint", Arrays.asList("AGY", "loser_alias"), "global",
                5L, 1764000003000L, 1764000000000L
        );
        JSONObject remotePayload = new JSONObject()
                .put("schema_version", 1)
                .put("local_id", "rem-1")
                .put("term", "Antigravity")
                .put("hint", "remote-newer-hint")
                .put("aliases", new JSONArray(Arrays.asList("AGY", "Antigravity IDE", "readded_alias")))
                .put("removed_aliases", new JSONArray(Collections.singletonList("loser_alias")))
                .put("group", "ai_tools")
                .put("device_counts", new JSONObject().put(androidDev.deviceId, 1L).put("mac-1", 9L).put("mac-2", 4L))
                .put("last_matched_at_ms", 1764000005000L)
                .put("created_at_ms", 1763999999000L)
                .put("intent_hlc", "001764000009000-0000-mac-1");
        SyncMerge.LexiconOutcome lexMerged = SyncMerge.mergeLexiconState(
                localRec, localSync, rk, remotePayload, "001764000009000-0001-mac-1", "mac-1",
                false, 1764000009000L, androidDev.deviceId, clock::tick
        );
        assertTrue(lexMerged.changed && !lexMerged.deleted, "merged active lexicon");
        // device_counts = max(android=3,1) + max(mac-1=2,9) + mac-2=4 = 16
        assertTrue(lexMerged.entry.matchCount == 16L, "CRDT device_counts sum expected 16 got " + lexMerged.entry.matchCount);
        assertTrue("remote-newer-hint".equals(lexMerged.entry.hint), "newer intent_hlc hint");
        assertTrue("ai_tools".equals(lexMerged.entry.group), "newer intent_hlc group");
        assertTrue(!lexMerged.entry.aliases.contains("loser_alias"), "winner removed_alias suppressed");
        assertTrue(lexMerged.entry.aliases.contains("readded_alias"), "winner readded alias preserved");
        assertTrue(lexMerged.entry.aliases.contains("Antigravity IDE"), "new alias preserved");
        assertTrue(lexMerged.entry.createdAtMs == 1763999999000L, "createdAt min preserved");

        // 5. Invite & JoinWait QR + E2E HTTP AcpmSyncClient / SyncPairing loopback verification
        byte[] serverSeed = SyncCrypto.generateRootSeed();
        String serverPubB64 = SyncCrypto.base64UrlEncode(SyncCrypto.ed25519PublicFromSeed(serverSeed));
        String serverFp = SyncCrypto.computePubkeyFingerprint(serverPubB64);
        String hubId = "test-hub-android-1";

        SyncPairing.SyncSecretStore memSecret = new MemorySecretStore();
        SyncPairing.KnownHubStore memHubs = new MemoryHubStore();
        SyncPairing pairing = new SyncPairing(memSecret, memHubs);

        // Encrypt return manuscript + lexicon + blob from Android for Desktop TS to decrypt
        SyncModels.ManuscriptRecord androidMs = new SyncModels.ManuscriptRecord(
                "1764000010000-11111111-2222-4333-8444-555555555555",
                1764000010500L,
                "安卓原话",
                "安卓整理正文。",
                "", "", "com.tencent.mm", 3.25, false, null, null,
                Collections.singletonList(new SyncModels.AsrResult("SpeechWire", "安卓原话")),
                androidDev.deviceId
        );
        SyncModels.SyncEntryRow msOutEntry = new SyncModels.SyncEntryRow(
                "manuscript", androidMs.id, androidMs.id, "001764000010500-0000-" + androidDev.deviceId,
                androidDev.deviceId, false, null, 1764000010500L, new JSONObject()
        );
        JSONObject msOutPayload = SyncMerge.buildOutgoingManuscriptPayload(msOutEntry, androidMs, androidDev.deviceId);
        String msOutCipher = SyncMerge.encryptSyncRecord(
                space.dataEncKey, space.vaultId, "manuscript", androidMs.id,
                msOutEntry.versionHlc, false, msOutPayload, androidDev.deviceId
        );

        byte[] androidBlobPlain = "android-wav-payload-bytes".getBytes(StandardCharsets.UTF_8);
        String androidBlobId = SyncCrypto.computeBlobId(space.keyMacKey, SyncCrypto.sha256Hex(androidBlobPlain));
        byte[] androidBlobEncrypted = SyncMerge.encryptSyncBlob(space.dataEncKey, space.vaultId, androidBlobId, androidBlobPlain);

        // PoP signature + HTTP mock roundtrip test
        Map<String, String> popHeaders = SyncCrypto.signPopHeaders(
                androidDev.deviceId, androidDev.privateSeed,
                "POST", "/v1/sync/vaults/" + space.vaultId + "/changes",
                "{\"hello\":1}".getBytes(StandardCharsets.UTF_8),
                1764000012000L, "nonce-android-1"
        );
        verifyHttpLoopback(pairing, space, serverSeed, serverPubB64, serverFp, hubId, msOutEntry, msOutCipher, androidBlobId, androidBlobEncrypted);

        // JoinWait X25519 QR test: parse invite QR from Desktop + encrypt JoinWait box for Desktop
        SyncModels.PairingQrPayload inviteParsed = SyncPairing.parsePairingQr(input.getString("invite_qr_uri"));
        assertTrue("invite".equals(inviteParsed.mode) && inviteParsed.sec.length() > 10, "invite QR parse");
        byte[] joinSeedBox = SyncCrypto.openPairingSeedBox(
                SyncCrypto.base64UrlDecode(inviteParsed.sec),
                input.getString("invite_seed_box"),
                "yanmo-pair-invite-v1|" + input.getString("invite_hub_id")
        ).toString().getBytes(StandardCharsets.UTF_8);
        assertTrue(new String(joinSeedBox, StandardCharsets.UTF_8).contains(space.vaultId), "invite seed box open");

        SyncCrypto.X25519Keypair androidEph = SyncCrypto.generateX25519Keypair();
        String joinSessionId = input.getString("join_wait_session_id");
        byte[] pairKey = SyncCrypto.deriveJoinPairKey(androidEph.privateKeyRaw, input.getString("desktop_eph_pubkey"), joinSessionId);
        JSONObject returnBox = new JSONObject()
                .put("root_seed_b64", SyncCrypto.base64UrlEncode(decodedSeed))
                .put("vault_id", space.vaultId)
                .put("owner_pubkey", space.ownerPublicKeyB64);
        String returnBoxB64 = SyncCrypto.sealPairingSeedBox(pairKey, returnBox, "yanmo-pair-join-v1|" + joinSessionId);

        // 6. Verify sparse SyncPolicy & daily scheduling rules
        java.time.ZoneId shanghai = java.time.ZoneId.of("Asia/Shanghai");
        long t2100 = java.time.ZonedDateTime.of(2026, 11, 26, 21, 0, 0, 0, shanghai).toInstant().toEpochMilli();
        long t2205 = java.time.ZonedDateTime.of(2026, 11, 26, 22, 5, 0, 0, shanghai).toInstant().toEpochMilli();
        long t2230 = java.time.ZonedDateTime.of(2026, 11, 26, 22, 30, 0, 0, shanghai).toInstant().toEpochMilli();
        long tPrevDay = t2205 - (25L * 60L * 60L * 1000L);

        assertTrue(!SyncPolicy.isDailyFullSyncDue(t2100, t2100 - 3_600_000L, 22, 0, shanghai), "not due before 22:00");
        assertTrue(SyncPolicy.isDailyFullSyncDue(t2205, t2100, 22, 0, shanghai), "due at 22:05 when last sync was 21:00");
        assertTrue(!SyncPolicy.isDailyFullSyncDue(t2230, t2205, 22, 0, shanghai), "not due again at 22:30 after 22:05 sync");
        assertTrue(SyncPolicy.isDailyFullSyncDue(t2205, tPrevDay, 22, 0, shanghai), "catch-up due when >24h");
        assertTrue(SyncPolicy.nextDailyTriggerDelayMs(t2100, t2100 - 3_600_000L, 22, 0, shanghai) == 3_600_000L, "delay to 22:00");
        assertTrue(SyncPolicy.nextDailyTriggerDelayMs(t2230, t2205, 22, 0, shanghai) > 20L * 3_600_000L, "delay to tomorrow 22:00");

        SyncPolicy.Decision dQuiet = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.APP_RESUME, true, true, true, false, false,
                3, 10, t2230, t2205, 0L, 22, 0, shanghai);
        assertTrue(!dQuiet.shouldRun, "quiet on app resume when synced today and <10 changes");

        SyncPolicy.Decision dImeActive = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.IME_IDLE, true, true, true, false, true,
                12, 10, t2230, t2205, 0L, 22, 0, shanghai);
        assertTrue(!dImeActive.shouldRun, "suppressed while IME active");

        SyncPolicy.Decision dThreshold = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.IME_IDLE, true, true, true, false, false,
                10, 10, t2230, t2205, 0L, 22, 0, shanghai);
        assertTrue(dThreshold.shouldRun && !dThreshold.fullSync, "threshold triggers incremental sync on idle wifi");

        SyncPolicy.Decision dCellular = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.IME_IDLE, true, true, false, false, false,
                15, 10, t2230, tPrevDay, 0L, 22, 0, shanghai);
        assertTrue(!dCellular.shouldRun, "cellular without manual hub skips auto sync");

        SyncPolicy.Decision dDaily = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.DAILY_JOB, true, true, true, false, false,
                0, 10, t2205, t2100, 0L, 22, 0, shanghai);
        assertTrue(dDaily.shouldRun && dDaily.fullSync, "daily job runs full sync");

        SyncPolicy.Decision dCooldown = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.IME_IDLE, true, true, true, false, false,
                10, 10, t2230, t2205, t2230 - 60_000L, 22, 0, shanghai);
        assertTrue(!dCooldown.shouldRun, "cooldown suppresses repeat failure");

        SyncPolicy.Decision dWifiReset = SyncPolicy.evaluateAutoSync(
                SyncPolicy.AutoTrigger.NETWORK_AVAILABLE, true, true, true, false, false,
                10, 10, t2230, t2205, t2230 - 60_000L, 22, 0, shanghai);
        assertTrue(dWifiReset.shouldRun, "network switch bypasses cooldown");

        // 7. Verify lexicon deletion tombstone propagation & non-resurrection
        SyncMerge.LexiconOutcome delFromActive = SyncMerge.mergeLexiconState(
                lexMerged.entry, lexMerged.syncEntry, rk,
                new JSONObject().put("schema_version", 1).put("term", ""),
                "001764000020000-0000-mac-1", "mac-1", true, 1764000020000L,
                androidDev.deviceId, clock::tick
        );
        assertTrue(delFromActive.changed && delFromActive.deleted && delFromActive.syncEntry.deleted,
                "remote lexicon delete tombstone deletes active local entry");

        SyncMerge.LexiconOutcome delFresh = SyncMerge.mergeLexiconState(
                null, null, rk,
                new JSONObject().put("schema_version", 1).put("term", ""),
                "001764000020000-0000-mac-1", "mac-1", true, 1764000020000L,
                androidDev.deviceId, clock::tick
        );
        assertTrue(delFresh.changed && delFresh.deleted && delFresh.syncEntry.deleted,
                "remote lexicon delete tombstone stored even without local entry");

        SyncMerge.LexiconOutcome staleMatch = SyncMerge.mergeLexiconState(
                null, delFromActive.syncEntry, rk,
                new JSONObject().put("schema_version", 1).put("term", "Antigravity").put("intent_hlc", "001764000009000-0000-mac-1"),
                "001764000025000-0000-win-1", "win-1", false, 1764000025000L,
                androidDev.deviceId, clock::tick
        );
        assertTrue(!staleMatch.changed && staleMatch.deleted,
                "older intent_hlc match update must not resurrect deleted lexicon term");

        SyncMerge.LexiconOutcome revivedTerm = SyncMerge.mergeLexiconState(
                null, delFromActive.syncEntry, rk,
                new JSONObject().put("schema_version", 1).put("term", "Antigravity").put("intent_hlc", "001764000030000-0000-win-1"),
                "001764000030000-0000-win-1", "win-1", false, 1764000030000L,
                androidDev.deviceId, clock::tick
        );
        assertTrue(revivedTerm.changed && !revivedTerm.deleted && revivedTerm.entry != null,
                "newer intent_hlc re-addition resurrects deleted lexicon term");

        // 8. Verify Android AdaptiveVad (Balanced Tier) & transcript/context parity with Mac
        AdaptiveVad vadShort = new AdaptiveVad();
        int bytePos = 0;
        for (int i = 0; i < 4; i++) {
            assertTrue(vadShort.feedRms(0.003, bytePos, bytePos + AdaptiveVad.FRAME_PCM_BYTES) == null, "vad calib");
            bytePos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 50; i++) { // 1.0s speech
            assertTrue(vadShort.feedRms(0.08, bytePos, bytePos + AdaptiveVad.FRAME_PCM_BYTES) == null, "vad speech");
            bytePos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 45; i++) { // 900ms silence < 1200ms
            assertTrue(vadShort.feedRms(0.003, bytePos, bytePos + AdaptiveVad.FRAME_PCM_BYTES) == null, "vad short wait");
            bytePos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        AdaptiveVad.Segment shortEmitted = null;
        for (int i = 0; i < 20; i++) {
            AdaptiveVad.Segment s = vadShort.feedRms(0.003, bytePos, bytePos + AdaptiveVad.FRAME_PCM_BYTES);
            if (s != null) shortEmitted = s;
            bytePos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        assertTrue(shortEmitted != null && shortEmitted.speechMs == 1000, "short utterance splits at 1200ms");

        AdaptiveVad vadCap = new AdaptiveVad();
        int capPos = 0;
        for (int i = 0; i < 4; i++) {
            vadCap.feedRms(0.003, capPos, capPos + AdaptiveVad.FRAME_PCM_BYTES);
            capPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        AdaptiveVad.Segment capped = null;
        for (int i = 0; i < 1250; i++) {
            AdaptiveVad.Segment s = vadCap.feedRms(0.08, capPos, capPos + AdaptiveVad.FRAME_PCM_BYTES);
            if (s != null) capped = s;
            capPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        assertTrue(capped != null && (capped.endByte - capped.startByte) == 24 * 16_000 * 2, "24s hard cap");

        AdaptiveVad vadQuiet = new AdaptiveVad();
        vadQuiet.feedRms(0.002, 0, AdaptiveVad.FRAME_PCM_BYTES);
        AdaptiveVad.Segment fallbackSeg = vadQuiet.finish(AdaptiveVad.FRAME_PCM_BYTES);
        assertTrue(fallbackSeg != null && fallbackSeg.startByte == 0 && fallbackSeg.endByte == AdaptiveVad.FRAME_PCM_BYTES,
                "quiet fallback emits full clip when nothing emitted");

        assertTrue("世界".equals(AdaptiveVad.joinDelta("你好", "世界")), "cjk join delta");
        assertTrue(" world".equals(AdaptiveVad.joinDelta("Hello.", "world")), "ascii join delta");
        assertTrue("打开Hello world".equals(AdaptiveVad.combineBeforeContext("打开", "Hello world", 300)),
                "combined context");

        AdaptiveVad vadLowMic = new AdaptiveVad();
        int lowPos = 0;
        for (int i = 0; i < 5; i++) {
            assertTrue(vadLowMic.feedRms(0.0008, lowPos, lowPos + AdaptiveVad.FRAME_PCM_BYTES) == null, "low noise");
            lowPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 40; i++) {
            assertTrue(vadLowMic.feedRms(0.0045, lowPos, lowPos + AdaptiveVad.FRAME_PCM_BYTES) == null, "low speech");
            lowPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 30; i++) {
            assertTrue(vadLowMic.feedRms(0.0030, lowPos, lowPos + AdaptiveVad.FRAME_PCM_BYTES) == null, "soft taper");
            lowPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        AdaptiveVad.Segment lowTail = vadLowMic.finish(lowPos);
        assertTrue(lowTail != null && lowTail.startByte == 0 && lowTail.endByte == lowPos, "low speech whole clip intact");

        AdaptiveVad vadContig = new AdaptiveVad();
        int contigPos = 0;
        java.util.List<AdaptiveVad.Segment> contigSegs = new java.util.ArrayList<>();
        for (int i = 0; i < 10; i++) {
            vadContig.feedRms(0.0008, contigPos, contigPos + AdaptiveVad.FRAME_PCM_BYTES);
            contigPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 50; i++) {
            vadContig.feedRms(0.005, contigPos, contigPos + AdaptiveVad.FRAME_PCM_BYTES);
            contigPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 65; i++) {
            AdaptiveVad.Segment s = vadContig.feedRms(0.0008, contigPos, contigPos + AdaptiveVad.FRAME_PCM_BYTES);
            if (s != null) contigSegs.add(s);
            contigPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        for (int i = 0; i < 6; i++) { // 120ms soft short tail (<260ms)
            vadContig.feedRms(0.005, contigPos, contigPos + AdaptiveVad.FRAME_PCM_BYTES);
            contigPos += AdaptiveVad.FRAME_PCM_BYTES;
        }
        AdaptiveVad.Segment tailSeg = vadContig.finish(contigPos);
        if (tailSeg != null) contigSegs.add(tailSeg);
        assertTrue(contigSegs.size() == 2
                && contigSegs.get(0).startByte == 0
                && contigSegs.get(1).startByte == contigSegs.get(0).endByte
                && contigSegs.get(1).endByte == contigPos,
                "contiguous zero-drop split plus short tail");

        output.put("vault_id", space.vaultId);
        output.put("android_cert", androidCert);
        output.put("android_manuscript_record_key", androidMs.id);
        output.put("android_manuscript_hlc", msOutEntry.versionHlc);
        output.put("android_manuscript_origin", androidDev.deviceId);
        output.put("android_manuscript_ciphertext", msOutCipher);
        output.put("android_manuscript_unix_ms", androidMs.createdAtMs);
        output.put("android_blob_id", androidBlobId);
        output.put("android_blob_plain_b64", SyncCrypto.base64UrlEncode(androidBlobPlain));
        output.put("android_blob_encrypted_b64", SyncCrypto.base64UrlEncode(androidBlobEncrypted));
        output.put("android_device_id", androidDev.deviceId);
        output.put("android_device_pubkey", androidDev.publicKeyB64);
        output.put("pop_headers", new JSONObject(popHeaders));
        output.put("pop_timestamp", 1764000012000L);
        output.put("android_eph_pubkey", androidEph.publicKeyB64);
        output.put("join_wait_seed_box", returnBoxB64);
        Files.writeString(Path.of(args[1]), output.toString(2), StandardCharsets.UTF_8);
        System.out.println("JAVA_CONTRACT_OK");
    }

    private static void verifyHttpLoopback(
            SyncPairing pairing,
            SyncCrypto.SpaceKeys space,
            byte[] serverSeed,
            String serverPubB64,
            String serverFp,
            String hubId,
            SyncModels.SyncEntryRow outEntry,
            String outCipher,
            String blobId,
            byte[] blobEncrypted
    ) throws Exception {
        Map<String, byte[]> blobs = new ConcurrentHashMap<>();
        List<SyncModels.SyncChangeItem> changes = Collections.synchronizedList(new ArrayList<>());
        AtomicLong seq = new AtomicLong(0);

        byte[] inviteSecret = SyncCrypto.randomBytes(32);
        String inviteSid = "sid-loop-1";
        String inviteCode = "123456";
        JSONObject inviteSeedObj = new JSONObject()
                .put("root_seed_b64", SyncCrypto.base64UrlEncode(SyncCrypto.generateRootSeed()));
        // Actually reuse the shared space root seed so deriveSpaceKeys matches!
        byte[] sharedSeed = SyncCrypto.decodeRecoveryCode(SyncCrypto.encodeRecoveryCode(SyncCrypto.randomBytes(32)));
        // Instead let's build invite box directly for the exact `space` passed in via recovery? We don't have raw rootSeed here; use restore?
        // Actually test HTTP endpoints via registered device from SyncPairing.redeemInvitePairing with empty box? No, let's sign cert directly or test client HTTP endpoints!
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        int port = server.getAddress().getPort();
        server.createContext("/", ex -> {
            try {
                handleMockHub(ex, serverSeed, serverPubB64, serverFp, hubId, space.vaultId, changes, blobs, seq);
            } catch (Exception e) {
                ex.sendResponseHeaders(500, -1);
                ex.close();
            }
        });
        server.start();
        try {
            String baseUrl = "http://127.0.0.1:" + port;
            SyncCrypto.DeviceIdentity dev = pairing.ensureDeviceIdentity();
            AcpmSyncClient client = new AcpmSyncClient(
                    baseUrl,
                    new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed, serverFp, serverPubB64)
            );
            SyncModels.HubIdentityResponse idRes = client.hubIdentity(null);
            assertTrue(hubId.equals(idRes.hubInstanceId), "loopback hub identity");

            JSONObject cert = SyncCrypto.signMembershipCert(
                    space.ownerSignSeed, space.vaultId, dev.deviceId, dev.publicKeyB64, "android", System.currentTimeMillis()
            );
            client.registerVault(space.vaultId, space.ownerPublicKeyB64, dev.deviceId, dev.publicKeyB64, "Pixel", "android", cert);

            assertTrue(!client.hasSyncBlob(space.vaultId, blobId), "blob missing initially");
            client.uploadSyncBlob(space.vaultId, blobId, blobEncrypted);
            assertTrue(client.hasSyncBlob(space.vaultId, blobId), "blob present after upload");
            assertTrue(Arrays.equals(blobEncrypted, client.downloadSyncBlob(space.vaultId, blobId)), "blob roundtrip");

            SyncModels.SyncChangeItem pushItem = new SyncModels.SyncChangeItem(
                    null, "manuscript", outEntry.recordKey, outEntry.versionHlc, outEntry.originDeviceId, false, outCipher, null
            );
            SyncModels.PushChangesResponse pushed = client.pushSyncChanges(space.vaultId, Collections.singletonList(pushItem));
            assertTrue(pushed.results.size() == 1 && "applied".equals(pushed.results.get(0).status), "push applied");

            SyncModels.PullChangesResponse pulled = client.pullSyncChanges(space.vaultId, 0, 200);
            assertTrue(pulled.changes.size() == 1 && outCipher.equals(pulled.changes.get(0).ciphertext), "pull match");
        } finally {
            server.stop(0);
        }
    }

    private static void handleMockHub(
            HttpExchange ex,
            byte[] serverSeed,
            String serverPubB64,
            String serverFp,
            String hubId,
            String vaultId,
            List<SyncModels.SyncChangeItem> changes,
            Map<String, byte[]> blobs,
            AtomicLong seqGen
    ) throws Exception {
        String method = ex.getRequestMethod();
        String path = ex.getRequestURI().getPath();
        String query = ex.getRequestURI().getRawQuery();
        String pathAndQuery = query == null ? path : path + "?" + query;
        byte[] reqBody = ex.getRequestBody().readAllBytes();

        String verifyNonce = null;
        if (path.equals("/v1/hub/identity")) {
            for (String p : (query == null ? "" : query).split("&")) {
                if (p.startsWith("nonce=")) verifyNonce = java.net.URLDecoder.decode(p.substring(6), StandardCharsets.UTF_8);
            }
        } else {
            // Verify PoP header signature
            String devPub = null;
            String sigB64 = ex.getRequestHeaders().getFirst("X-Acpm-Signature");
            String ts = ex.getRequestHeaders().getFirst("X-Acpm-Timestamp");
            String nonce = ex.getRequestHeaders().getFirst("X-Acpm-Nonce");
            verifyNonce = nonce;
            assertTrue(sigB64 != null && ts != null && nonce != null, "mock hub expects PoP headers on " + path);
            if ("POST".equals(method) && path.equals("/v1/sync/vaults/register")) {
                JSONObject reg = new JSONObject(new String(reqBody, StandardCharsets.UTF_8));
                devPub = reg.getString("device_pubkey");
                String signStr = SyncCrypto.buildPopSigningString(method, pathAndQuery, reqBody, Long.parseLong(ts), nonce);
                assertTrue(SyncCrypto.ed25519Verify(SyncCrypto.base64UrlDecode(devPub),
                        signStr.getBytes(StandardCharsets.UTF_8), SyncCrypto.base64UrlDecode(sigB64)), "PoP verify");
            }
        }

        byte[] respBytes = new byte[0];
        int status = 200;
        String contentType = "application/json";
        if (path.equals("/v1/hub/identity")) {
            JSONObject obj = new JSONObject()
                    .put("hub_instance_id", hubId)
                    .put("protocol_version", "1")
                    .put("server_pubkey", serverPubB64)
                    .put("server_pubkey_fp", serverFp)
                    .put("capabilities", new JSONArray().put("yanmo.sync"));
            respBytes = obj.toString().getBytes(StandardCharsets.UTF_8);
        } else if (path.equals("/v1/sync/vaults/register")) {
            respBytes = new JSONObject().put("status", "registered").toString().getBytes(StandardCharsets.UTF_8);
        } else if (path.startsWith("/v1/sync/vaults/") && path.endsWith("/changes")) {
            if ("POST".equals(method)) {
                JSONArray arr = new JSONObject(new String(reqBody, StandardCharsets.UTF_8)).getJSONArray("changes");
                JSONArray results = new JSONArray();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject c = arr.getJSONObject(i);
                    long s = seqGen.incrementAndGet();
                    changes.add(new SyncModels.SyncChangeItem(
                            s, c.getString("collection"), c.getString("record_key"),
                            c.getString("version_hlc"), c.getString("origin_device_id"),
                            c.getBoolean("deleted"), c.getString("ciphertext"), System.currentTimeMillis()
                    ));
                    results.put(new JSONObject()
                            .put("collection", c.getString("collection"))
                            .put("record_key", c.getString("record_key"))
                            .put("status", "applied")
                            .put("seq", s));
                }
                respBytes = new JSONObject()
                        .put("vault_id", vaultId)
                        .put("hub_instance_id", hubId)
                        .put("latest_seq", seqGen.get())
                        .put("results", results)
                        .toString().getBytes(StandardCharsets.UTF_8);
            } else {
                JSONArray arr = new JSONArray();
                for (SyncModels.SyncChangeItem c : changes) {
                    arr.put(new JSONObject()
                            .put("seq", c.seq)
                            .put("collection", c.collection)
                            .put("record_key", c.recordKey)
                            .put("version_hlc", c.versionHlc)
                            .put("origin_device_id", c.originDeviceId)
                            .put("deleted", c.deleted)
                            .put("ciphertext", c.ciphertext)
                            .put("updated_at_ms", c.updatedAtMs));
                }
                respBytes = new JSONObject()
                        .put("vault_id", vaultId)
                        .put("hub_instance_id", hubId)
                        .put("since_seq", 0)
                        .put("latest_seq", seqGen.get())
                        .put("has_more", false)
                        .put("changes", arr)
                        .toString().getBytes(StandardCharsets.UTF_8);
            }
        } else if (path.contains("/blobs/")) {
            String bid = path.substring(path.lastIndexOf('/') + 1);
            contentType = "application/octet-stream";
            if ("HEAD".equals(method)) {
                status = blobs.containsKey(bid) ? 200 : 404;
            } else if ("PUT".equals(method)) {
                blobs.put(bid, reqBody);
                respBytes = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
                contentType = "application/json";
            } else if ("GET".equals(method)) {
                if (!blobs.containsKey(bid)) status = 404;
                else respBytes = blobs.get(bid);
            }
        }

        if (status >= 200 && status < 300 && verifyNonce != null && !"HEAD".equals(method)) {
            long tsMs = System.currentTimeMillis();
            String sigStr = SyncCrypto.buildServerResponseSigningString(verifyNonce, Long.toString(tsMs), respBytes);
            String sig = SyncCrypto.base64UrlEncode(SyncCrypto.ed25519Sign(serverSeed, sigStr.getBytes(StandardCharsets.UTF_8)));
            ex.getResponseHeaders().set("X-Acpm-Server-Timestamp", Long.toString(tsMs));
            ex.getResponseHeaders().set("X-Acpm-Server-Signature", sig);
        }
        ex.getResponseHeaders().set("Content-Type", contentType);
        ex.sendResponseHeaders(status, "HEAD".equals(method) ? -1 : respBytes.length);
        if (!"HEAD".equals(method) && respBytes.length > 0) {
            try (OutputStream out = ex.getResponseBody()) {
                out.write(respBytes);
            }
        }
        ex.close();
    }

    private static void assertTrue(boolean cond, String message) {
        if (!cond) throw new AssertionError("SyncContract assertion failed: " + message);
    }
}
