package dev.yanmo.ime;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Pure-Java cross-device pairing, QR parsing, recovery code restoration, and hub matching
 * matching {@code desktop/sync-pairing.ts} and {@code desktop/sync-discovery.ts}.
 */
final class SyncPairing {
    interface SyncSecretStore {
        SyncModels.SyncSecrets load() throws IOException;
        void save(SyncModels.SyncSecrets secrets) throws IOException;
    }

    interface KnownHubStore {
        List<SyncModels.KnownHub> load();
        void save(List<SyncModels.KnownHub> hubs) throws IOException;
    }

    static final class SpaceSwitchRequiredException extends IOException {
        final String currentVaultId;
        final String nextVaultId;

        SpaceSwitchRequiredException(String currentVaultId, String nextVaultId) {
            super("本机已加入另一个个人同步空间；若确认切换，请先确认替换现有空间。");
            this.currentVaultId = currentVaultId;
            this.nextVaultId = nextVaultId;
        }
    }

    static final class MatchResult {
        final List<MatchedHub> matched = new ArrayList<>();
        final List<MatchedHub> spoofed = new ArrayList<>();
        final List<SyncModels.DiscoveredHub> unknown = new ArrayList<>();
    }

    static final class MatchedHub {
        final SyncModels.KnownHub known;
        final SyncModels.DiscoveredHub discovered;

        MatchedHub(SyncModels.KnownHub known, SyncModels.DiscoveredHub discovered) {
            this.known = known;
            this.discovered = discovered;
        }
    }

    static final class DiscoveryReport {
        final List<SyncModels.KnownHub> verifiedHubs = new ArrayList<>();
        final List<String> spoofedHubIds = new ArrayList<>();
        int unknownCount;
    }

    private final SyncSecretStore secretStore;
    private final KnownHubStore hubStore;

    SyncPairing(SyncSecretStore secretStore, KnownHubStore hubStore) {
        this.secretStore = secretStore;
        this.hubStore = hubStore;
    }

    synchronized SyncCrypto.DeviceIdentity ensureDeviceIdentity() throws IOException {
        SyncModels.SyncSecrets existing = secretStore.load();
        if (existing != null && existing.deviceId != null && !existing.deviceId.isEmpty()
                && existing.devicePrivateSeedB64 != null && !existing.devicePrivateSeedB64.isEmpty()) {
            byte[] seed = SyncCrypto.base64UrlDecode(existing.devicePrivateSeedB64);
            return SyncCrypto.deviceIdentityFromSeed(existing.deviceId, seed);
        }
        SyncCrypto.DeviceIdentity created = SyncCrypto.generateDeviceIdentity();
        secretStore.save(new SyncModels.SyncSecrets(
                created.deviceId,
                SyncCrypto.base64UrlEncode(created.privateSeed),
                existing != null ? existing.rootSeedB64 : null
        ));
        return created;
    }

    synchronized byte[] getRootSeed() throws IOException {
        SyncModels.SyncSecrets stored = secretStore.load();
        if (stored == null || stored.rootSeedB64 == null || stored.rootSeedB64.isEmpty()) return null;
        byte[] buf = SyncCrypto.base64UrlDecode(stored.rootSeedB64);
        return buf.length == 32 ? buf : null;
    }

    private synchronized void saveRootSeed(byte[] rootSeed) throws IOException {
        SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
        secretStore.save(new SyncModels.SyncSecrets(
                dev.deviceId,
                SyncCrypto.base64UrlEncode(dev.privateSeed),
                SyncCrypto.base64UrlEncode(rootSeed)
        ));
    }

    private byte[] requireRootSeed() throws IOException {
        byte[] seed = getRootSeed();
        if (seed == null) throw new IOException("尚未启用或加入个人同步空间。");
        return seed;
    }

    SyncModels.SyncStateSummary getStatus() throws IOException {
        SyncModels.SyncSecrets stored = secretStore.load();
        String vaultId = null;
        if (stored != null && stored.rootSeedB64 != null && !stored.rootSeedB64.isEmpty()) {
            try {
                byte[] seed = SyncCrypto.base64UrlDecode(stored.rootSeedB64);
                if (seed.length == 32) {
                    vaultId = SyncCrypto.deriveSpaceKeys(seed).vaultId;
                }
            } catch (Exception ignored) {
            }
        }
        return new SyncModels.SyncStateSummary(
                vaultId != null,
                vaultId,
                stored != null && stored.deviceId != null ? stored.deviceId : "",
                hubStore.load()
        );
    }

    String exportRecoveryCode() throws IOException {
        return SyncCrypto.encodeRecoveryCode(requireRootSeed());
    }

    synchronized SyncModels.SyncStateSummary disableSync() throws IOException {
        SyncModels.SyncSecrets stored = secretStore.load();
        if (stored != null) {
            secretStore.save(new SyncModels.SyncSecrets(stored.deviceId, stored.devicePrivateSeedB64, null));
        }
        hubStore.save(new ArrayList<>());
        return getStatus();
    }

    synchronized SyncModels.SyncStateSummary setHubManualUrl(String hubId, String manualRemoteUrl) throws IOException {
        String cleanId = hubId == null ? "" : hubId.trim();
        if (cleanId.isEmpty()) throw new IOException("缺少同步节点 ID。");
        String cleanUrl = manualRemoteUrl == null ? "" : manualRemoteUrl.trim().replaceAll("/+$", "");
        if (!cleanUrl.isEmpty()) {
            cleanUrl = AcpmSyncClient.normalizeAndCheckUrl(cleanUrl);
        }
        List<SyncModels.KnownHub> list = new ArrayList<>(hubStore.load());
        int idx = -1;
        for (int i = 0; i < list.size(); i++) {
            if (cleanId.equals(list.get(i).hubInstanceId)) {
                idx = i;
                break;
            }
        }
        if (idx < 0) throw new IOException("未找到指定的同步节点。");
        list.set(idx, list.get(idx).withManualUrl(cleanUrl.isEmpty() ? null : cleanUrl));
        hubStore.save(list);
        return getStatus();
    }

    private boolean assertSpaceSwitchAllowed(String nextVaultId, boolean allowReplaceSpace) throws IOException {
        byte[] existingSeed = getRootSeed();
        if (existingSeed == null) return false;
        try {
            String currentVaultId = SyncCrypto.deriveSpaceKeys(existingSeed).vaultId;
            if (currentVaultId.equals(nextVaultId)) return false;
            if (!allowReplaceSpace) {
                throw new SpaceSwitchRequiredException(currentVaultId, nextVaultId);
            }
            return true;
        } catch (SpaceSwitchRequiredException e) {
            throw e;
        } catch (Exception e) {
            throw new IOException(e);
        }
    }

    private synchronized void upsertKnownHub(SyncModels.KnownHub hub) throws IOException {
        List<SyncModels.KnownHub> list = new ArrayList<>(hubStore.load());
        int idx = -1;
        for (int i = 0; i < list.size(); i++) {
            if (hub.hubInstanceId.equals(list.get(i).hubInstanceId)) {
                idx = i;
                break;
            }
        }
        if (idx >= 0) {
            SyncModels.KnownHub prev = list.get(idx);
            list.set(idx, new SyncModels.KnownHub(
                    hub.hubInstanceId,
                    hub.hubName,
                    hub.serverPubkey,
                    hub.serverPubkeyFp,
                    hub.lastKnownUrl != null ? hub.lastKnownUrl : prev.lastKnownUrl,
                    hub.manualRemoteUrl != null ? hub.manualRemoteUrl : prev.manualRemoteUrl,
                    prev.pairedAtMs > 0 ? prev.pairedAtMs : hub.pairedAtMs,
                    hub.lastSeenAtMs > 0 ? hub.lastSeenAtMs : prev.lastSeenAtMs
            ));
        } else {
            list.add(hub);
        }
        hubStore.save(list);
    }

    static SyncModels.PairingQrPayload parsePairingQr(String input) throws IOException {
        String trimmed = input == null ? "" : input.trim();
        String jsonText = trimmed;
        if (trimmed.startsWith("yanmo-pair://")) {
            URI uri;
            try {
                uri = URI.create(trimmed);
            } catch (IllegalArgumentException badUri) {
                throw new IOException("配对二维码链接格式无效。");
            }
            String encoded = queryParam(uri.getRawQuery(), "data");
            if (encoded == null || encoded.isEmpty()) {
                throw new IOException("配对二维码缺少数据载荷。");
            }
            jsonText = new String(SyncCrypto.base64UrlDecode(encoded), StandardCharsets.UTF_8);
        }
        JSONObject raw;
        try {
            raw = new JSONObject(jsonText);
        } catch (JSONException badJson) {
            throw new IOException("配对二维码无法解析。");
        }
        if (raw.optInt("v", 0) != 1) {
            throw new IOException("不支持的配对二维码版本。");
        }
        String hubId = raw.optString("hub_id", "").trim();
        String fp = raw.optString("fp", "").trim().toLowerCase(Locale.ROOT);
        JSONArray addrsArr = raw.optJSONArray("addrs");
        int port = raw.optInt("port", -1);
        String sid = raw.optString("sid", "").trim();
        String code = raw.optString("code", "").trim();
        if (hubId.isEmpty() || !fp.matches("^[0-9a-f]{16}$") || addrsArr == null || addrsArr.length() == 0
                || port <= 0 || port > 65535 || sid.isEmpty() || code.isEmpty()) {
            throw new IOException("配对二维码缺少必要字段。");
        }
        List<String> addrs = new ArrayList<>();
        for (int i = 0; i < addrsArr.length(); i++) {
            String a = addrsArr.optString(i, "").trim();
            if (a.isEmpty()) throw new IOException("配对二维码包含空地址。");
            addrs.add(a);
        }
        String mode = raw.optString("mode", "");
        if ("invite".equals(mode)) {
            String sec = raw.optString("sec", "").trim();
            if (sec.isEmpty()) throw new IOException("邀请二维码缺少传输密钥。");
            return new SyncModels.PairingQrPayload("invite", hubId, fp, addrs, port, sid, code, sec, null);
        }
        if ("join_wait".equals(mode)) {
            String epk = raw.optString("epk", "").trim();
            if (epk.isEmpty()) throw new IOException("待加入二维码缺少临时公钥。");
            return new SyncModels.PairingQrPayload("join_wait", hubId, fp, addrs, port, sid, code, null, epk);
        }
        throw new IOException("未知的配对二维码模式。");
    }

    static String encodePairingQrUri(SyncModels.PairingQrPayload payload) throws JSONException {
        JSONObject obj = new JSONObject();
        obj.put("v", 1);
        obj.put("mode", payload.mode);
        obj.put("hub_id", payload.hubId);
        obj.put("fp", payload.fp);
        JSONArray arr = new JSONArray();
        for (String a : payload.addrs) arr.put(a);
        obj.put("addrs", arr);
        obj.put("port", payload.port);
        obj.put("sid", payload.sid);
        obj.put("code", payload.code);
        if ("invite".equals(payload.mode)) obj.put("sec", payload.sec);
        else if ("join_wait".equals(payload.mode)) obj.put("epk", payload.epk);
        return "yanmo-pair://v1?data=" + SyncCrypto.base64UrlEncode(obj.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String queryParam(String rawQuery, String name) {
        if (rawQuery == null || rawQuery.isEmpty()) return null;
        try {
            String utf8 = StandardCharsets.UTF_8.name();
            for (String pair : rawQuery.split("&")) {
                int eq = pair.indexOf('=');
                String key = eq >= 0 ? pair.substring(0, eq) : pair;
                if (name.equals(URLDecoder.decode(key, utf8))) {
                    return eq >= 0 ? URLDecoder.decode(pair.substring(eq + 1), utf8) : "";
                }
            }
        } catch (IOException ignored) {
        }
        return null;
    }

    private static final class ConnectedHub {
        final String baseUrl;
        final SyncModels.HubIdentityResponse identity;

        ConnectedHub(String baseUrl, SyncModels.HubIdentityResponse identity) {
            this.baseUrl = baseUrl;
            this.identity = identity;
        }
    }

    private ConnectedHub connectCandidateHub(
            List<String> addrs,
            int port,
            String expectedHubId,
            String expectedFp,
            SyncCrypto.DeviceIdentity dev
    ) throws IOException {
        IOException lastError = null;
        for (String addr : addrs) {
            String candidateUrl;
            if (addr.startsWith("http://") || addr.startsWith("https://")) {
                candidateUrl = addr.replaceAll("/+$", "");
            } else {
                String host = addr.contains(":") && !addr.startsWith("[") ? "[" + addr + "]" : addr;
                candidateUrl = "http://" + host + ":" + port;
            }
            try {
                AcpmSyncClient client = new AcpmSyncClient(
                        candidateUrl,
                        new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed, expectedFp, null)
                );
                SyncModels.HubIdentityResponse identity = client.hubIdentity(null);
                if (!expectedHubId.equals(identity.hubInstanceId)) {
                    throw new IOException("AcpmRuntime 节点 ID 与二维码不一致。");
                }
                return new ConnectedHub(candidateUrl, identity);
            } catch (IOException failure) {
                lastError = failure;
            } catch (IllegalArgumentException badUrl) {
                lastError = new IOException(badUrl.getMessage(), badUrl);
            }
        }
        throw lastError != null ? lastError : new IOException("无法连接到二维码指定的 AcpmRuntime 节点。");
    }

    SyncModels.SyncStateSummary redeemInvitePairing(
            String qrInput,
            String deviceName,
            boolean allowReplaceSpace
    ) throws IOException {
        SyncModels.PairingQrPayload qr = parsePairingQr(qrInput);
        if (!"invite".equals(qr.mode)) {
            throw new IOException("此二维码不是邀请配对码。");
        }
        SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
        ConnectedHub connected = connectCandidateHub(qr.addrs, qr.port, qr.hubId, qr.fp, dev);
        AcpmSyncClient.PopAuth auth = new AcpmSyncClient.PopAuth(
                dev.deviceId, dev.privateSeed, qr.fp, connected.identity.serverPubkey
        );
        AcpmSyncClient client = new AcpmSyncClient(connected.baseUrl, auth);
        SyncModels.RedeemPairingResponse redeemed = client.redeemPairingSession(
                qr.sid, qr.code, dev.deviceId, dev.publicKeyB64, deviceName, SyncModels.PLATFORM_ANDROID, null, null
        );
        if (redeemed.encryptedSeedBox != null) {
            try {
                byte[] pairSecret = SyncCrypto.base64UrlDecode(qr.sec);
                JSONObject box = SyncCrypto.openPairingSeedBox(
                        pairSecret,
                        redeemed.encryptedSeedBox,
                        "yanmo-pair-invite-v1|" + connected.identity.hubInstanceId
                );
                byte[] rootSeed = SyncCrypto.base64UrlDecode(box.getString("root_seed_b64"));
                SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
                if (!space.vaultId.equals(box.getString("vault_id"))
                        || !space.ownerPublicKeyB64.equals(box.getString("owner_pubkey"))) {
                    throw new IOException("个人空间密钥校验失败。");
                }
                boolean replaced = assertSpaceSwitchAllowed(space.vaultId, allowReplaceSpace);
                saveRootSeed(rootSeed);
                if (replaced) hubStore.save(new ArrayList<>());

                JSONObject cert = SyncCrypto.signMembershipCert(
                        space.ownerSignSeed, space.vaultId, dev.deviceId, dev.publicKeyB64,
                        SyncModels.PLATFORM_ANDROID, System.currentTimeMillis()
                );
                client.registerVault(
                        space.vaultId, space.ownerPublicKeyB64, dev.deviceId, dev.publicKeyB64,
                        deviceName, SyncModels.PLATFORM_ANDROID, cert
                );
            } catch (IOException io) {
                throw io;
            } catch (Exception cryptoFailure) {
                throw new IOException("个人空间密钥解密或注册失败。", cryptoFailure);
            }
        }
        long now = System.currentTimeMillis();
        upsertKnownHub(new SyncModels.KnownHub(
                connected.identity.hubInstanceId,
                qr.addrs.get(0),
                connected.identity.serverPubkey,
                connected.identity.serverPubkeyFp,
                connected.baseUrl,
                null,
                now,
                now
        ));
        return getStatus();
    }

    SyncModels.SyncStateSummary fulfillJoinWaitAsExistingDevice(String qrInput, String deviceName) throws IOException {
        SyncModels.PairingQrPayload qr = parsePairingQr(qrInput);
        if (!"join_wait".equals(qr.mode)) {
            throw new IOException("此二维码不是待加入配对码。");
        }
        byte[] rootSeed = requireRootSeed();
        SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
        ConnectedHub connected = connectCandidateHub(qr.addrs, qr.port, qr.hubId, qr.fp, dev);
        AcpmSyncClient.PopAuth auth = new AcpmSyncClient.PopAuth(
                dev.deviceId, dev.privateSeed, qr.fp, connected.identity.serverPubkey
        );
        AcpmSyncClient client = new AcpmSyncClient(connected.baseUrl, auth);
        SyncModels.PairingSessionResponse session = client.getPairingSession(qr.sid, qr.code);
        String joinerEphPub = session.joinerEphPubkey != null ? session.joinerEphPubkey : qr.epk;
        if (!qr.epk.equals(joinerEphPub)) {
            throw new IOException("待加入节点的临时公钥校验不一致。");
        }

        try {
            SyncCrypto.SpaceKeys space = SyncCrypto.deriveSpaceKeys(rootSeed);
            SyncCrypto.X25519Keypair senderEph = SyncCrypto.generateX25519Keypair();
            byte[] pairKey = SyncCrypto.deriveJoinPairKey(senderEph.privateKeyRaw, joinerEphPub, qr.sid);
            JSONObject box = new JSONObject();
            box.put("root_seed_b64", SyncCrypto.base64UrlEncode(rootSeed));
            box.put("vault_id", space.vaultId);
            box.put("owner_pubkey", space.ownerPublicKeyB64);
            String encryptedSeedBox = SyncCrypto.sealPairingSeedBox(
                    pairKey, box, "yanmo-pair-join-v1|" + qr.sid
            );

            client.redeemPairingSession(
                    qr.sid, qr.code, dev.deviceId, dev.publicKeyB64, deviceName,
                    SyncModels.PLATFORM_ANDROID, senderEph.publicKeyB64, encryptedSeedBox
            );
            JSONObject cert = SyncCrypto.signMembershipCert(
                    space.ownerSignSeed, space.vaultId, dev.deviceId, dev.publicKeyB64,
                    SyncModels.PLATFORM_ANDROID, System.currentTimeMillis()
            );
            client.registerVault(
                    space.vaultId, space.ownerPublicKeyB64, dev.deviceId, dev.publicKeyB64,
                    deviceName, SyncModels.PLATFORM_ANDROID, cert
            );
        } catch (IOException io) {
            throw io;
        } catch (Exception cryptoFailure) {
            throw new IOException("无法完成待加入设备授权。", cryptoFailure);
        }

        long now = System.currentTimeMillis();
        upsertKnownHub(new SyncModels.KnownHub(
                connected.identity.hubInstanceId,
                qr.addrs.get(0),
                connected.identity.serverPubkey,
                connected.identity.serverPubkeyFp,
                connected.baseUrl,
                null,
                now,
                now
        ));
        return getStatus();
    }

    SyncModels.SyncStateSummary restoreFromRecoveryCode(
            String recoveryCode,
            String hubBaseUrl,
            String deviceName,
            boolean allowReplaceSpace
    ) throws IOException {
        byte[] seed;
        SyncCrypto.SpaceKeys space;
        try {
            seed = SyncCrypto.decodeRecoveryCode(recoveryCode);
            space = SyncCrypto.deriveSpaceKeys(seed);
        } catch (Exception invalid) {
            throw new IOException(invalid.getMessage(), invalid);
        }
        boolean replaced = assertSpaceSwitchAllowed(space.vaultId, allowReplaceSpace);
        saveRootSeed(seed);
        if (replaced) hubStore.save(new ArrayList<>());

        String cleanHubUrl = hubBaseUrl == null ? "" : hubBaseUrl.trim().replaceAll("/+$", "");
        if (!cleanHubUrl.isEmpty()) {
            SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
            AcpmSyncClient probe = new AcpmSyncClient(
                    cleanHubUrl,
                    new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed, null, null)
            );
            SyncModels.HubIdentityResponse identity = probe.hubIdentity(null);
            AcpmSyncClient authed = new AcpmSyncClient(
                    cleanHubUrl,
                    new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed,
                            identity.serverPubkeyFp, identity.serverPubkey)
            );
            try {
                JSONObject cert = SyncCrypto.signMembershipCert(
                        space.ownerSignSeed, space.vaultId, dev.deviceId, dev.publicKeyB64,
                        SyncModels.PLATFORM_ANDROID, System.currentTimeMillis()
                );
                authed.registerVault(
                        space.vaultId, space.ownerPublicKeyB64, dev.deviceId, dev.publicKeyB64,
                        deviceName, SyncModels.PLATFORM_ANDROID, cert
                );
            } catch (IOException regFailure) {
                throw new IOException("已恢复个人密钥，但向该同步节点注册设备失败（若该节点尚未配对过本设备，请先用已配对设备扫码配对）。", regFailure);
            } catch (JSONException badJson) {
                throw new IOException("无法生成成员证书。", badJson);
            }
            long now = System.currentTimeMillis();
            upsertKnownHub(new SyncModels.KnownHub(
                    identity.hubInstanceId,
                    URI.create(cleanHubUrl).getHost(),
                    identity.serverPubkey,
                    identity.serverPubkeyFp,
                    cleanHubUrl,
                    cleanHubUrl,
                    now,
                    now
            ));
        }
        return getStatus();
    }

    static MatchResult matchKnownHubs(List<SyncModels.DiscoveredHub> discovered, List<SyncModels.KnownHub> knownHubs) {
        Map<String, SyncModels.KnownHub> byId = new HashMap<>();
        for (SyncModels.KnownHub h : knownHubs) byId.put(h.hubInstanceId, h);
        MatchResult result = new MatchResult();
        for (SyncModels.DiscoveredHub item : discovered) {
            SyncModels.KnownHub known = byId.get(item.hubInstanceId);
            if (known == null) {
                result.unknown.add(item);
            } else if (known.serverPubkeyFp.equalsIgnoreCase(item.serverPubkeyFp)) {
                result.matched.add(new MatchedHub(known, item));
            } else {
                result.spoofed.add(new MatchedHub(known, item));
            }
        }
        return result;
    }

    static String resolveHubBaseUrl(SyncModels.KnownHub known, SyncModels.DiscoveredHub discovered) {
        if (discovered != null && known.hubInstanceId.equals(discovered.hubInstanceId)
                && known.serverPubkeyFp.equalsIgnoreCase(discovered.serverPubkeyFp)) {
            String rawHost = !discovered.addresses.isEmpty() ? discovered.addresses.get(0) : discovered.host;
            if (rawHost != null && !rawHost.isEmpty() && discovered.port > 0) {
                String hostOrIp = rawHost.contains(":") && !rawHost.startsWith("[") ? "[" + rawHost + "]" : rawHost;
                String candidate = "http://" + hostOrIp + ":" + discovered.port;
                AcpmSyncClient.normalizeAndCheckUrl(candidate);
                return candidate;
            }
        }
        if (known.manualRemoteUrl != null && !known.manualRemoteUrl.trim().isEmpty()) {
            return AcpmSyncClient.normalizeAndCheckUrl(known.manualRemoteUrl);
        }
        if (known.lastKnownUrl != null && !known.lastKnownUrl.trim().isEmpty()) {
            return AcpmSyncClient.normalizeAndCheckUrl(known.lastKnownUrl);
        }
        return null;
    }

    DiscoveryReport verifyDiscoveredHubs(List<SyncModels.DiscoveredHub> discovered) throws IOException {
        SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
        List<SyncModels.KnownHub> known = hubStore.load();
        MatchResult match = matchKnownHubs(discovered, known);
        DiscoveryReport report = new DiscoveryReport();
        report.unknownCount = match.unknown.size();
        for (MatchedHub s : match.spoofed) {
            report.spoofedHubIds.add(s.discovered.hubInstanceId);
        }
        for (MatchedHub item : match.matched) {
            String url = resolveHubBaseUrl(item.known, item.discovered);
            if (url == null) continue;
            try {
                AcpmSyncClient client = new AcpmSyncClient(
                        url,
                        new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed,
                                item.known.serverPubkeyFp, item.known.serverPubkey)
                );
                SyncModels.HubIdentityResponse id = client.hubIdentity(null);
                if (item.known.hubInstanceId.equals(id.hubInstanceId)) {
                    SyncModels.KnownHub updated = item.known.withUpdatedUrl(url, System.currentTimeMillis());
                    upsertKnownHub(updated);
                    report.verifiedHubs.add(updated);
                }
            } catch (IOException ignored) {
                // Skip unreachable discovery candidate.
            }
        }
        return report;
    }

    AcpmSyncClient createClientForHub(SyncModels.KnownHub hub, SyncModels.DiscoveredHub discovered) throws IOException {
        SyncCrypto.DeviceIdentity dev = ensureDeviceIdentity();
        String url = resolveHubBaseUrl(hub, discovered);
        if (url == null) {
            throw new IOException("节点 " + hub.hubName + " 暂无可用同步地址。");
        }
        return new AcpmSyncClient(
                url,
                new AcpmSyncClient.PopAuth(dev.deviceId, dev.privateSeed, hub.serverPubkeyFp, hub.serverPubkey)
        );
    }

    List<SyncModels.PairedDeviceDTO> listDevices(String hubId) throws IOException {
        SyncModels.KnownHub target = findHub(hubId);
        return createClientForHub(target, null).listDevices();
    }

    void revokeDevice(String deviceId, String hubId) throws IOException {
        if (hubId != null && !hubId.isEmpty()) {
            createClientForHub(findHub(hubId), null).revokeDevice(deviceId);
            return;
        }
        List<SyncModels.KnownHub> known = hubStore.load();
        if (known.isEmpty()) throw new IOException("未找到已配对的 AcpmRuntime 节点。");
        IOException lastError = null;
        boolean succeeded = false;
        Set<String> tried = new LinkedHashSet<>();
        for (SyncModels.KnownHub hub : known) {
            if (!tried.add(hub.hubInstanceId)) continue;
            try {
                createClientForHub(hub, null).revokeDevice(deviceId);
                succeeded = true;
            } catch (AcpmSyncClient.AcpmException e) {
                if (e.httpStatus != 404) lastError = e;
            } catch (IOException e) {
                lastError = e;
            }
        }
        if (lastError != null) throw lastError;
        if (!succeeded) throw new IOException("未在任何已配对节点上找到该设备。");
    }

    private SyncModels.KnownHub findHub(String hubId) throws IOException {
        List<SyncModels.KnownHub> known = hubStore.load();
        if (hubId != null && !hubId.isEmpty()) {
            for (SyncModels.KnownHub h : known) {
                if (hubId.equals(h.hubInstanceId)) return h;
            }
            throw new IOException("未找到指定的 AcpmRuntime 节点。");
        }
        if (known.isEmpty()) throw new IOException("未找到已配对的 AcpmRuntime 节点。");
        return known.get(0);
    }
}
