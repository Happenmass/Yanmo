package dev.yanmo.ime;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * HTTP + Ed25519 Proof-of-Possession client for AcpmRuntime cross-device sync.
 */
final class AcpmSyncClient {
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int LAN_CONNECT_TIMEOUT_MS = 2_500;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final int BLOB_READ_TIMEOUT_MS = 8_000;
    private static final long MAX_SERVER_SKEW_MS = 120_000L;

    static final class AcpmException extends IOException {
        final String code;
        final String requestId;
        final String stage;
        final String detail;
        final boolean retryable;
        final int httpStatus;

        AcpmException(String code, String message, String requestId, String stage,
                      String detail, boolean retryable, int httpStatus) {
            super(message);
            this.code = code;
            this.requestId = requestId;
            this.stage = stage;
            this.detail = detail;
            this.retryable = retryable;
            this.httpStatus = httpStatus;
        }
    }

    static final class PopAuth {
        final String deviceId;
        final byte[] privateSeed;
        final String expectedServerPubkeyFp;
        final String serverPubkey;

        PopAuth(String deviceId, byte[] privateSeed, String expectedServerPubkeyFp, String serverPubkey) {
            this.deviceId = deviceId;
            this.privateSeed = privateSeed;
            this.expectedServerPubkeyFp = expectedServerPubkeyFp;
            this.serverPubkey = serverPubkey;
        }
    }

    private final String baseUrl;
    private final PopAuth popAuth;
    private final String caller;

    AcpmSyncClient(String baseUrl, PopAuth popAuth) {
        this(baseUrl, popAuth, "yanmo-android-sync");
    }

    AcpmSyncClient(String baseUrl, PopAuth popAuth, String caller) {
        this.baseUrl = normalizeAndCheckUrl(baseUrl);
        this.popAuth = popAuth;
        this.caller = caller;
    }

    static String normalizeAndCheckUrl(String value) {
        String clean = value == null ? "" : value.trim().replaceAll("/+$", "");
        URI uri;
        try {
            uri = URI.create(clean);
        } catch (IllegalArgumentException invalid) {
            throw new IllegalArgumentException("AcpmRuntime 服务地址无效。");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty()) {
            throw new IllegalArgumentException("AcpmRuntime 服务地址无效。");
        }
        if (uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new IllegalArgumentException("服务地址不要包含账号、密钥或参数。");
        }
        String bareHost = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
        boolean allowedHttp = "localhost".equals(bareHost)
                || "127.0.0.1".equals(bareHost)
                || "::1".equals(bareHost)
                || bareHost.endsWith(".local")
                || isPrivateIPv4(bareHost);
        if (!"https".equals(scheme) && !("http".equals(scheme) && allowedHttp)) {
            throw new IllegalArgumentException("远程 AcpmRuntime 服务需使用 https，或局域网 / mDNS (.local) / 本机 http 地址。");
        }
        return clean;
    }

    static boolean isLanUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        try {
            URI uri = URI.create(url.trim());
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ("http".equals(scheme)) return true;
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            String bareHost = host.startsWith("[") && host.endsWith("]") ? host.substring(1, host.length() - 1) : host;
            return "localhost".equals(bareHost)
                    || "::1".equals(bareHost)
                    || bareHost.endsWith(".local")
                    || isPrivateIPv4(bareHost);
        } catch (IllegalArgumentException ignored) {
            return false;
        }
    }

    static boolean isPrivateIPv4(String host) {
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("\\d{1,3}")) return false;
            int n = Integer.parseInt(parts[i]);
            if (n < 0 || n > 255) return false;
            octets[i] = n;
        }
        return octets[0] == 127
                || octets[0] == 10
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 169 && octets[1] == 254)
                || (octets[0] == 100 && octets[1] >= 64 && octets[1] <= 127);
    }

    private static final class ResponseData {
        final int status;
        final byte[] body;
        final String serverSig;
        final String serverTs;

        ResponseData(int status, byte[] body, String serverSig, String serverTs) {
            this.status = status;
            this.body = body;
            this.serverSig = serverSig;
            this.serverTs = serverTs;
        }
    }

    private ResponseData execute(
            String method,
            String pathAndQuery,
            byte[] bodyBytes,
            String contentType,
            Map<String, String> extraHeaders,
            boolean authenticated,
            boolean expectJson,
            String serverVerifyNonce,
            int readTimeoutMs
    ) throws IOException {
        boolean retried = false;
        while (true) {
            String requestId = UUID.randomUUID().toString();
            HttpURLConnection conn = (HttpURLConnection) URI.create(baseUrl + pathAndQuery).toURL().openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(isLanUrl(baseUrl) ? LAN_CONNECT_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(readTimeoutMs);
            conn.setRequestMethod(method);
            conn.setRequestProperty("X-AI-Priority", "normal");
            conn.setRequestProperty("X-AI-Caller", caller);
            conn.setRequestProperty("X-AI-Request-Id", requestId);
            if (extraHeaders != null) {
                for (Map.Entry<String, String> e : extraHeaders.entrySet()) {
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            if (contentType != null) {
                conn.setRequestProperty("Content-Type", contentType);
            }

            String popNonce = null;
            if (authenticated) {
                if (popAuth == null) {
                    throw new IOException("缺少本机同步设备 PoP 凭据。");
                }
                Map<String, String> popHeaders = SyncCrypto.signPopHeaders(
                        popAuth.deviceId, popAuth.privateSeed, method, pathAndQuery, bodyBytes
                );
                for (Map.Entry<String, String> e : popHeaders.entrySet()) {
                    conn.setRequestProperty(e.getKey(), e.getValue());
                }
                popNonce = popHeaders.get("X-Acpm-Nonce");
            }

            int status;
            byte[] respBytes;
            String serverSig;
            String serverTs;
            try {
                if (bodyBytes != null) {
                    conn.setDoOutput(true);
                    try (OutputStream out = conn.getOutputStream()) {
                        out.write(bodyBytes);
                    }
                }
                status = conn.getResponseCode();
                serverSig = conn.getHeaderField("X-Acpm-Server-Signature");
                serverTs = conn.getHeaderField("X-Acpm-Server-Timestamp");
                if ("HEAD".equalsIgnoreCase(method)) {
                    respBytes = new byte[0];
                } else {
                    InputStream stream = status >= 200 && status < 300 ? conn.getInputStream() : conn.getErrorStream();
                    respBytes = stream != null ? readAll(stream) : new byte[0];
                }
            } finally {
                conn.disconnect();
            }

            if (status >= 200 && status < 300) {
                if (popAuth != null && popAuth.serverPubkey != null
                        && (serverSig != null || (authenticated && expectJson && !"HEAD".equalsIgnoreCase(method)))) {
                    long tsNum;
                    try {
                        tsNum = serverTs == null ? Long.MIN_VALUE : Long.parseLong(serverTs.trim());
                    } catch (NumberFormatException badTs) {
                        tsNum = Long.MIN_VALUE;
                    }
                    boolean tsFresh = tsNum != Long.MIN_VALUE && Math.abs(System.currentTimeMillis() - tsNum) <= MAX_SERVER_SKEW_MS;
                    String verifyNonce = serverVerifyNonce != null ? serverVerifyNonce : (popNonce != null ? popNonce : requestId);
                    boolean valid = serverSig != null && serverTs != null && tsFresh
                            && SyncCrypto.verifyServerResponse(popAuth.serverPubkey, verifyNonce, serverTs, respBytes, serverSig);
                    if (!valid) {
                        throw new AcpmException("FORBIDDEN", "AcpmRuntime 服务端响应签名缺失、已过期或校验失败。",
                                requestId, "RESPONSE_VERIFY", serverSig != null ? "INVALID_SERVER_SIGNATURE" : "MISSING_SERVER_SIGNATURE",
                                false, 403);
                    }
                }
                return new ResponseData(status, respBytes, serverSig, serverTs);
            }

            AcpmException error = parseError(status, respBytes);
            if (error.retryable && !retried) {
                retried = true;
                try {
                    Thread.sleep(300L);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw error;
                }
                continue;
            }
            throw error;
        }
    }

    private JSONObject requestJson(
            String method,
            String pathAndQuery,
            JSONObject body,
            Map<String, String> extraHeaders,
            boolean authenticated
    ) throws IOException {
        byte[] bodyBytes = body == null ? null : body.toString().getBytes(StandardCharsets.UTF_8);
        String contentType = body == null ? null : "application/json; charset=utf-8";
        ResponseData res = execute(method, pathAndQuery, bodyBytes, contentType, extraHeaders,
                authenticated, true, null, READ_TIMEOUT_MS);
        String text = res.body.length == 0 ? "{}" : new String(res.body, StandardCharsets.UTF_8);
        try {
            return new JSONObject(text);
        } catch (JSONException badJson) {
            throw new IOException("AcpmRuntime 返回了无效 JSON 响应。", badJson);
        }
    }

    SyncModels.HubIdentityResponse hubIdentity(String nonce) throws IOException {
        String clientNonce = (nonce == null || nonce.isEmpty())
                ? SyncCrypto.base64UrlEncode(SyncCrypto.randomBytes(16))
                : nonce;
        String path = "/v1/hub/identity?nonce=" + URLEncoder.encode(clientNonce, StandardCharsets.UTF_8.name());
        ResponseData res = execute("GET", path, null, null, null, false, true, clientNonce, READ_TIMEOUT_MS);
        String rawText = new String(res.body, StandardCharsets.UTF_8);
        JSONObject obj;
        try {
            obj = new JSONObject(rawText);
        } catch (JSONException badJson) {
            throw new IOException("节点身份响应格式无效。", badJson);
        }
        String hubId = obj.optString("hub_instance_id", "");
        String proto = obj.optString("protocol_version", "1");
        String serverPubkey = obj.optString("server_pubkey", "");
        String serverPubkeyFp = obj.optString("server_pubkey_fp", "").toLowerCase(Locale.ROOT);
        String derivedFp = SyncCrypto.computePubkeyFingerprint(serverPubkey);
        if (!derivedFp.equals(serverPubkeyFp)) {
            throw new AcpmException("FORBIDDEN", "AcpmRuntime 节点公钥与指纹不匹配。",
                    "unknown", "HUB_IDENTITY", "FINGERPRINT_MISMATCH", false, 403);
        }
        if (popAuth != null && popAuth.expectedServerPubkeyFp != null
                && !derivedFp.equals(popAuth.expectedServerPubkeyFp.toLowerCase(Locale.ROOT))) {
            throw new AcpmException("FORBIDDEN", "AcpmRuntime 节点指纹与已保存节点不一致。",
                    "unknown", "HUB_IDENTITY", "EXPECTED_FP_MISMATCH", false, 403);
        }
        long tsNum;
        try {
            tsNum = res.serverTs == null ? Long.MIN_VALUE : Long.parseLong(res.serverTs.trim());
        } catch (NumberFormatException badTs) {
            tsNum = Long.MIN_VALUE;
        }
        boolean tsFresh = tsNum != Long.MIN_VALUE && Math.abs(System.currentTimeMillis() - tsNum) <= MAX_SERVER_SKEW_MS;
        if (res.serverSig == null || res.serverTs == null || !tsFresh
                || !SyncCrypto.verifyServerResponse(serverPubkey, clientNonce, res.serverTs, res.body, res.serverSig)) {
            throw new AcpmException("FORBIDDEN", "AcpmRuntime 节点身份签名验证失败或已过期。",
                    "unknown", "HUB_IDENTITY", "INVALID_SERVER_SIGNATURE", false, 403);
        }
        List<String> caps = new ArrayList<>();
        JSONArray capsArr = obj.optJSONArray("capabilities");
        if (capsArr != null) {
            for (int i = 0; i < capsArr.length(); i++) caps.add(capsArr.optString(i, ""));
        }
        return new SyncModels.HubIdentityResponse(hubId, proto, serverPubkey, serverPubkeyFp, caps);
    }

    void registerVault(
            String vaultId,
            String ownerPubkeyB64,
            String deviceId,
            String devicePubkeyB64,
            String deviceName,
            String platform,
            JSONObject membershipCert
    ) throws IOException {
        try {
            JSONObject payload = new JSONObject();
            payload.put("vault_id", vaultId);
            payload.put("owner_pubkey", ownerPubkeyB64);
            payload.put("device_id", deviceId);
            payload.put("device_pubkey", devicePubkeyB64);
            payload.put("device_name", deviceName);
            payload.put("platform", platform);
            payload.put("membership_cert", membershipCert);
            requestJson("POST", "/v1/sync/vaults/register", payload, null, true);
        } catch (JSONException impossible) {
            throw new IOException(impossible);
        }
    }

    SyncModels.PairingSessionResponse getPairingSession(String sessionId, String pairCode) throws IOException {
        String encodedId = URLEncoder.encode(sessionId, StandardCharsets.UTF_8.name());
        String path = "/v1/pairing/sessions/" + encodedId;
        JSONObject obj;
        if (pairCode != null && !pairCode.isEmpty()) {
            obj = requestJson("GET", path, null, java.util.Collections.singletonMap("X-Acpm-Pair-Code", pairCode), false);
        } else {
            obj = requestJson("GET", path, null, null, true);
        }
        return new SyncModels.PairingSessionResponse(
                obj.optString("session_id", sessionId),
                obj.optString("mode", ""),
                obj.optString("status", ""),
                obj.optLong("expires_at_ms", 0L),
                obj.optString("joiner_eph_pubkey", ""),
                obj.optString("sender_eph_pubkey", ""),
                obj.optString("encrypted_seed_box", "")
        );
    }

    SyncModels.RedeemPairingResponse redeemPairingSession(
            String sessionId,
            String pairCode,
            String deviceId,
            String devicePubkeyB64,
            String deviceName,
            String platform,
            String senderEphPubkey,
            String encryptedSeedBox
    ) throws IOException {
        try {
            JSONObject payload = new JSONObject();
            payload.put("session_id", sessionId);
            payload.put("acpm_pair_code", pairCode);
            payload.put("device_id", deviceId);
            payload.put("device_pubkey", devicePubkeyB64);
            payload.put("device_name", deviceName);
            payload.put("platform", platform);
            if (senderEphPubkey != null) payload.put("sender_eph_pubkey", senderEphPubkey);
            if (encryptedSeedBox != null) payload.put("encrypted_seed_box", encryptedSeedBox);
            JSONObject obj = requestJson("POST", "/v1/pairing/redeem", payload, null, false);
            return new SyncModels.RedeemPairingResponse(
                    obj.optString("session_id", sessionId),
                    obj.optString("mode", ""),
                    obj.optString("status", ""),
                    obj.optString("vault_id", ""),
                    obj.optString("encrypted_seed_box", "")
            );
        } catch (JSONException impossible) {
            throw new IOException(impossible);
        }
    }

    List<SyncModels.PairedDeviceDTO> listDevices() throws IOException {
        JSONObject res = requestJson("GET", "/v1/devices", null, null, true);
        JSONArray arr = res.optJSONArray("devices");
        List<SyncModels.PairedDeviceDTO> out = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject d = arr.optJSONObject(i);
                if (d == null) continue;
                List<String> scopes = new ArrayList<>();
                JSONArray sa = d.optJSONArray("scopes");
                if (sa != null) {
                    for (int j = 0; j < sa.length(); j++) scopes.add(sa.optString(j, ""));
                }
                Long revokedAt = d.isNull("revoked_at_ms") ? null : d.optLong("revoked_at_ms", 0L);
                out.add(new SyncModels.PairedDeviceDTO(
                        d.optString("device_id", ""),
                        d.optString("device_name", ""),
                        d.optString("platform", ""),
                        d.optString("device_pubkey", ""),
                        scopes,
                        d.optLong("paired_at_ms", 0L),
                        d.optLong("last_seen_at_ms", 0L),
                        revokedAt
                ));
            }
        }
        return out;
    }

    void revokeDevice(String deviceId) throws IOException {
        String encoded = URLEncoder.encode(deviceId, StandardCharsets.UTF_8.name());
        requestJson("DELETE", "/v1/devices/" + encoded, null, null, true);
    }

    SyncModels.PullChangesResponse pullSyncChanges(String vaultId, long sinceSeq, int limit) throws IOException {
        long cleanSince = Math.max(0L, sinceSeq);
        int cleanLimit = Math.max(1, Math.min(500, limit));
        String encodedVault = URLEncoder.encode(vaultId, StandardCharsets.UTF_8.name());
        String path = "/v1/sync/vaults/" + encodedVault + "/changes?since_seq=" + cleanSince + "&limit=" + cleanLimit;
        JSONObject obj = requestJson("GET", path, null, null, true);
        JSONArray arr = obj.optJSONArray("changes");
        List<SyncModels.SyncChangeItem> changes = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) {
                JSONObject c = arr.optJSONObject(i);
                if (c == null) continue;
                changes.add(new SyncModels.SyncChangeItem(
                        c.has("seq") && !c.isNull("seq") ? c.optLong("seq") : null,
                        c.optString("collection", ""),
                        c.optString("record_key", ""),
                        c.optString("version_hlc", ""),
                        c.optString("origin_device_id", ""),
                        c.optBoolean("deleted", false),
                        c.optString("ciphertext", ""),
                        c.has("updated_at_ms") && !c.isNull("updated_at_ms") ? c.optLong("updated_at_ms") : null
                ));
            }
        }
        return new SyncModels.PullChangesResponse(
                obj.optString("vault_id", vaultId),
                obj.optString("hub_instance_id", ""),
                obj.optLong("since_seq", cleanSince),
                obj.optLong("latest_seq", cleanSince),
                obj.optBoolean("has_more", false),
                changes
        );
    }

    SyncModels.PushChangesResponse pushSyncChanges(String vaultId, List<SyncModels.SyncChangeItem> changes) throws IOException {
        try {
            JSONArray arr = new JSONArray();
            for (SyncModels.SyncChangeItem item : changes) arr.put(item.toJson());
            JSONObject body = new JSONObject();
            body.put("changes", arr);
            String encodedVault = URLEncoder.encode(vaultId, StandardCharsets.UTF_8.name());
            JSONObject res = requestJson("POST", "/v1/sync/vaults/" + encodedVault + "/changes", body, null, true);
            JSONArray resultsArr = res.optJSONArray("results");
            List<SyncModels.PushChangeResult> results = new ArrayList<>();
            if (resultsArr != null) {
                for (int i = 0; i < resultsArr.length(); i++) {
                    JSONObject r = resultsArr.optJSONObject(i);
                    if (r == null) continue;
                    results.add(new SyncModels.PushChangeResult(
                            r.optString("collection", ""),
                            r.optString("record_key", ""),
                            r.optString("status", ""),
                            r.optLong("seq", 0L)
                    ));
                }
            }
            return new SyncModels.PushChangesResponse(
                    res.optString("vault_id", vaultId),
                    res.optString("hub_instance_id", ""),
                    res.optLong("latest_seq", 0L),
                    results
            );
        } catch (JSONException impossible) {
            throw new IOException(impossible);
        }
    }

    boolean hasSyncBlob(String vaultId, String blobId) throws IOException {
        String path = "/v1/sync/vaults/" + URLEncoder.encode(vaultId, StandardCharsets.UTF_8.name())
                + "/blobs/" + URLEncoder.encode(blobId, StandardCharsets.UTF_8.name());
        try {
            execute("HEAD", path, null, null, null, true, false, null, BLOB_READ_TIMEOUT_MS);
            return true;
        } catch (AcpmException notFound) {
            if (notFound.httpStatus == 404) return false;
            throw notFound;
        }
    }

    void uploadSyncBlob(String vaultId, String blobId, byte[] encryptedBytes) throws IOException {
        String path = "/v1/sync/vaults/" + URLEncoder.encode(vaultId, StandardCharsets.UTF_8.name())
                + "/blobs/" + URLEncoder.encode(blobId, StandardCharsets.UTF_8.name());
        execute("PUT", path, encryptedBytes, "application/octet-stream", null, true, false, null, READ_TIMEOUT_MS);
    }

    byte[] downloadSyncBlob(String vaultId, String blobId) throws IOException {
        String path = "/v1/sync/vaults/" + URLEncoder.encode(vaultId, StandardCharsets.UTF_8.name())
                + "/blobs/" + URLEncoder.encode(blobId, StandardCharsets.UTF_8.name());
        return execute("GET", path, null, null, null, true, false, null, BLOB_READ_TIMEOUT_MS).body;
    }

    private static AcpmException parseError(int status, byte[] body) {
        String raw = new String(body, StandardCharsets.UTF_8);
        try {
            JSONObject err = new JSONObject(raw).optJSONObject("error");
            if (err != null && err.has("code")) {
                return new AcpmException(
                        err.optString("code", "INFERENCE_FAILED"),
                        err.optString("message", "HTTP " + status),
                        err.optString("request_id", "unknown"),
                        err.optString("stage", "HTTP_ADMISSION"),
                        err.optString("detail", "HTTP_" + status),
                        err.optBoolean("retryable", false),
                        status
                );
            }
        } catch (JSONException ignored) {
        }
        String code = status == 401 ? "UNAUTHORIZED" : status == 403 ? "FORBIDDEN"
                : status == 404 ? "NOT_FOUND" : "INFERENCE_FAILED";
        return new AcpmException(code, raw.isEmpty() ? "HTTP " + status : raw,
                "unknown", "HTTP_ADMISSION", "HTTP_" + status, false, status);
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
