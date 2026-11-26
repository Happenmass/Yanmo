package dev.yanmo.ime;

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters;
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters;
import org.bouncycastle.crypto.params.X25519PublicKeyParameters;
import org.bouncycastle.crypto.signers.Ed25519Signer;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Wire-compatible cryptography and encoding primitives matching {@code desktop/sync-crypto.ts}.
 * Uses BouncyCastle lightweight classes directly without registering a global JCA provider.
 */
final class SyncCrypto {
    static final String SYNC_SALT = "yanmo-sync-v1";
    private static final byte[] SYNC_SALT_BYTES = SYNC_SALT.getBytes(StandardCharsets.UTF_8);
    private static final String BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    private static final int[] BASE32_LOOKUP = new int[128];
    private static final byte ENVELOPE_VERSION = 0x01;
    private static final byte FLAG_COMPRESSED = 0x01;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BYTES = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    static {
        Arrays.fill(BASE32_LOOKUP, -1);
        for (int i = 0; i < BASE32_ALPHABET.length(); i++) {
            BASE32_LOOKUP[BASE32_ALPHABET.charAt(i)] = i;
        }
    }

    private SyncCrypto() {}

    static byte[] randomBytes(int length) {
        byte[] out = new byte[length];
        RANDOM.nextBytes(out);
        return out;
    }

    static String base64UrlEncode(byte[] data) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(data);
    }

    static byte[] base64UrlDecode(String encoded) {
        if (encoded == null) throw new IllegalArgumentException("Base64URL 字符串为空。");
        return Base64.getUrlDecoder().decode(encoded.trim());
    }

    static String base32Encode(byte[] data, boolean lower) {
        StringBuilder out = new StringBuilder((data.length * 8 + 4) / 5);
        int bits = 0;
        int value = 0;
        for (byte b : data) {
            value = (value << 8) | (b & 0xff);
            bits += 8;
            while (bits >= 5) {
                out.append(BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31));
                bits -= 5;
            }
        }
        if (bits > 0) {
            out.append(BASE32_ALPHABET.charAt((value << (5 - bits)) & 31));
        }
        String result = out.toString();
        return lower ? result.toLowerCase(Locale.ROOT) : result;
    }

    static byte[] base32Decode(String encoded) {
        String clean = encoded == null ? "" : encoded.trim().toUpperCase(Locale.ROOT);
        if (clean.isEmpty()) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream((clean.length() * 5) / 8);
        int bits = 0;
        int value = 0;
        for (int i = 0; i < clean.length(); i++) {
            char ch = clean.charAt(i);
            int idx = ch < BASE32_LOOKUP.length ? BASE32_LOOKUP[ch] : -1;
            if (idx < 0) {
                throw new IllegalArgumentException("Base32 字符串包含无效字符。");
            }
            value = (value << 5) | idx;
            bits += 5;
            if (bits >= 8) {
                out.write((value >>> (bits - 8)) & 0xff);
                bits -= 8;
            }
        }
        if (bits >= 5 || (value & ((1 << bits) - 1)) != 0) {
            throw new IllegalArgumentException("Base32 字符串长度或填充位无效。");
        }
        return out.toByteArray();
    }

    static int crc16CcittFalse(byte[] data, int offset, int length) {
        int crc = 0xffff;
        for (int i = offset; i < offset + length; i++) {
            crc ^= (data[i] & 0xff) << 8;
            for (int bit = 0; bit < 8; bit++) {
                crc = (crc & 0x8000) != 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
            }
        }
        return crc;
    }

    static String encodeRecoveryCode(byte[] rootSeed) {
        if (rootSeed == null || rootSeed.length != 32) {
            throw new IllegalArgumentException("root_seed 必须为 32 字节。");
        }
        int crc = crc16CcittFalse(rootSeed, 0, 32);
        byte[] payload = new byte[34];
        System.arraycopy(rootSeed, 0, payload, 0, 32);
        payload[32] = (byte) ((crc >>> 8) & 0xff);
        payload[33] = (byte) (crc & 0xff);
        String b32 = base32Encode(payload, false);
        StringBuilder sb = new StringBuilder("YM1");
        for (int i = 0; i < b32.length(); i += 4) {
            sb.append('-').append(b32, i, Math.min(i + 4, b32.length()));
        }
        return sb.toString();
    }

    static byte[] decodeRecoveryCode(String code) {
        String normalized = (code == null ? "" : code).trim().toUpperCase(Locale.ROOT).replaceAll("[\\s-]+", "");
        if (!normalized.startsWith("YM1") || normalized.length() < 4) {
            throw new IllegalArgumentException("恢复码格式无效，需以 YM1- 开头。");
        }
        byte[] payload = base32Decode(normalized.substring(3));
        if (payload.length != 34) {
            throw new IllegalArgumentException("恢复码长度无效。");
        }
        int expectedCrc = ((payload[32] & 0xff) << 8) | (payload[33] & 0xff);
        if (crc16CcittFalse(payload, 0, 32) != expectedCrc) {
            throw new IllegalArgumentException("恢复码校验失败，请检查是否有字符输入错误。");
        }
        return Arrays.copyOf(payload, 32);
    }

    static byte[] sha256(byte[] input) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(input == null ? new byte[0] : input);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static String sha256Hex(byte[] input) {
        return hexLower(sha256(input));
    }

    static String hexLower(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0x0f, 16));
            sb.append(Character.forDigit(b & 0x0f, 16));
        }
        return sb.toString();
    }

    static byte[] hmacSha256(byte[] key, byte[] message) throws GeneralSecurityException {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(message);
    }

    static byte[] hkdfSha256(byte[] ikm, byte[] salt, byte[] info, int outLen) throws GeneralSecurityException {
        byte[] effectiveSalt = (salt == null || salt.length == 0) ? new byte[32] : salt;
        byte[] prk = hmacSha256(effectiveSalt, ikm);
        byte[] okm = new byte[outLen];
        byte[] t = new byte[0];
        int offset = 0;
        int counter = 1;
        while (offset < outLen) {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(prk, "HmacSHA256"));
            mac.update(t);
            if (info != null) mac.update(info);
            mac.update((byte) counter);
            t = mac.doFinal();
            int copy = Math.min(t.length, outLen - offset);
            System.arraycopy(t, 0, okm, offset, copy);
            offset += copy;
            counter++;
        }
        return okm;
    }

    static byte[] hkdfSync(byte[] ikm, String info, int outLen) throws GeneralSecurityException {
        return hkdfSha256(ikm, SYNC_SALT_BYTES, info.getBytes(StandardCharsets.UTF_8), outLen);
    }

    static final class SpaceKeys {
        final String vaultId;
        final byte[] ownerSignSeed;
        final byte[] ownerPublicKeyRaw;
        final String ownerPublicKeyB64;
        final byte[] dataEncKey;
        final byte[] keyMacKey;

        SpaceKeys(String vaultId, byte[] ownerSignSeed, byte[] ownerPublicKeyRaw,
                  String ownerPublicKeyB64, byte[] dataEncKey, byte[] keyMacKey) {
            this.vaultId = vaultId;
            this.ownerSignSeed = ownerSignSeed;
            this.ownerPublicKeyRaw = ownerPublicKeyRaw;
            this.ownerPublicKeyB64 = ownerPublicKeyB64;
            this.dataEncKey = dataEncKey;
            this.keyMacKey = keyMacKey;
        }
    }

    static final class DeviceIdentity {
        final String deviceId;
        final byte[] privateSeed;
        final byte[] publicKeyRaw;
        final String publicKeyB64;

        DeviceIdentity(String deviceId, byte[] privateSeed, byte[] publicKeyRaw, String publicKeyB64) {
            this.deviceId = deviceId;
            this.privateSeed = privateSeed;
            this.publicKeyRaw = publicKeyRaw;
            this.publicKeyB64 = publicKeyB64;
        }
    }

    static final class X25519Keypair {
        final byte[] privateKeyRaw;
        final byte[] publicKeyRaw;
        final String publicKeyB64;

        X25519Keypair(byte[] privateKeyRaw, byte[] publicKeyRaw, String publicKeyB64) {
            this.privateKeyRaw = privateKeyRaw;
            this.publicKeyRaw = publicKeyRaw;
            this.publicKeyB64 = publicKeyB64;
        }
    }

    static byte[] ed25519PublicFromSeed(byte[] seed32) {
        byte[] raw = toRaw32(seed32, "Ed25519 私钥种子");
        return new Ed25519PrivateKeyParameters(raw, 0).generatePublicKey().getEncoded();
    }

    static byte[] ed25519Sign(byte[] seed32, byte[] message) {
        byte[] raw = toRaw32(seed32, "Ed25519 私钥种子");
        Ed25519Signer signer = new Ed25519Signer();
        signer.init(true, new Ed25519PrivateKeyParameters(raw, 0));
        signer.update(message, 0, message.length);
        return signer.generateSignature();
    }

    static boolean ed25519Verify(byte[] pubRaw32, byte[] message, byte[] signature64) {
        if (pubRaw32 == null || pubRaw32.length != 32 || signature64 == null || signature64.length != 64) {
            return false;
        }
        Ed25519Signer verifier = new Ed25519Signer();
        verifier.init(false, new Ed25519PublicKeyParameters(pubRaw32, 0));
        verifier.update(message, 0, message.length);
        return verifier.verifySignature(signature64);
    }

    static X25519Keypair generateX25519Keypair() {
        X25519PrivateKeyParameters priv = new X25519PrivateKeyParameters(RANDOM);
        byte[] pub = priv.generatePublicKey().getEncoded();
        return new X25519Keypair(priv.getEncoded(), pub, base64UrlEncode(pub));
    }

    static byte[] deriveJoinPairKey(byte[] myPrivRaw, String peerPubB64, String sessionId) throws GeneralSecurityException {
        return deriveJoinPairKey(myPrivRaw, base64UrlDecode(peerPubB64), sessionId);
    }

    static byte[] deriveJoinPairKey(byte[] myPrivRaw, byte[] peerPubRaw, String sessionId) throws GeneralSecurityException {
        byte[] priv32 = toRaw32(myPrivRaw, "X25519 私钥");
        byte[] pub32 = toRaw32(peerPubRaw, "X25519 公钥");
        byte[] shared = new byte[32];
        new X25519PrivateKeyParameters(priv32, 0)
                .generateSecret(new X25519PublicKeyParameters(pub32, 0), shared, 0);
        boolean allZero = true;
        for (byte b : shared) {
            if (b != 0) {
                allZero = false;
                break;
            }
        }
        if (allZero) {
            throw new GeneralSecurityException("无效的 X25519 共享密钥。");
        }
        try {
            return hkdfSync(shared, "pair-join|" + sessionId, 32);
        } finally {
            Arrays.fill(shared, (byte) 0);
        }
    }

    static String computePubkeyFingerprint(String pubB64) {
        return computePubkeyFingerprint(base64UrlDecode(pubB64));
    }

    static String computePubkeyFingerprint(byte[] raw32) {
        byte[] pub = toRaw32(raw32, "Ed25519 公钥");
        byte[] digest = sha256(pub);
        return hexLower(Arrays.copyOf(digest, 8));
    }

    static byte[] generateRootSeed() {
        return randomBytes(32);
    }

    static SpaceKeys deriveSpaceKeys(byte[] rootSeed) throws GeneralSecurityException {
        byte[] seed = toRaw32(rootSeed, "root_seed");
        byte[] vaultBytes = hkdfSync(seed, "vault-id", 16);
        String vaultId = base32Encode(vaultBytes, true);
        byte[] ownerSignSeed = hkdfSync(seed, "owner-sign-ed25519", 32);
        byte[] dataEncKey = hkdfSync(seed, "data-enc-aes256gcm", 32);
        byte[] keyMacKey = hkdfSync(seed, "record-key-hmac", 32);
        byte[] ownerPub = ed25519PublicFromSeed(ownerSignSeed);
        return new SpaceKeys(vaultId, ownerSignSeed, ownerPub, base64UrlEncode(ownerPub), dataEncKey, keyMacKey);
    }

    static DeviceIdentity generateDeviceIdentity() {
        String deviceId = UUID.randomUUID().toString();
        byte[] privateSeed = randomBytes(32);
        byte[] pub = ed25519PublicFromSeed(privateSeed);
        return new DeviceIdentity(deviceId, privateSeed, pub, base64UrlEncode(pub));
    }

    static DeviceIdentity deviceIdentityFromSeed(String deviceId, byte[] seed32) {
        byte[] pub = ed25519PublicFromSeed(seed32);
        return new DeviceIdentity(deviceId, toRaw32(seed32, "设备私钥种子"), pub, base64UrlEncode(pub));
    }

    static String normalizeTermKey(String term) {
        if (term == null) return "";
        return Normalizer.normalize(term, Normalizer.Form.NFKC)
                .replaceAll("[\\p{Z}\\s]+", " ").trim().toLowerCase(Locale.ROOT);
    }

    static String normalizeTermGroup(String group) {
        return "ai_tools".equals(group) ? "ai_tools" : "global";
    }

    static String computeLexiconRecordKey(byte[] keyMacKey, String term, String group) throws GeneralSecurityException {
        String normalized = normalizeTermKey(term);
        if (normalized.isEmpty()) {
            throw new IllegalArgumentException("词条规范键不能为空。");
        }
        String normalizedGroup = normalizeTermGroup(group);
        byte[] mac = hmacSha256(keyMacKey, ("term:" + normalizedGroup + ":" + normalized).getBytes(StandardCharsets.UTF_8));
        return hexLower(mac);
    }

    static String computeBlobId(byte[] keyMacKey, String plaintextSha256Hex) throws GeneralSecurityException {
        String cleanHash = plaintextSha256Hex == null ? "" : plaintextSha256Hex.trim().toLowerCase(Locale.ROOT);
        if (!cleanHash.matches("^[0-9a-f]{64}$")) {
            throw new IllegalArgumentException("附件 SHA-256 哈希格式无效。");
        }
        byte[] mac = hmacSha256(keyMacKey, ("blob:" + cleanHash).getBytes(StandardCharsets.UTF_8));
        return hexLower(mac);
    }

    static String canonicalJson(Object value) throws JSONException {
        if (value == null || value == JSONObject.NULL) {
            return "null";
        }
        if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
            return value.toString();
        }
        if (value instanceof Number) {
            double d = ((Number) value).doubleValue();
            if (!Double.isFinite(d)) {
                throw new JSONException("规范 JSON 不支持非有限数字。");
            }
            return JSONObject.numberToString((Number) value);
        }
        if (value instanceof String) {
            return quoteJsonString((String) value);
        }
        if (value instanceof JSONArray) {
            JSONArray arr = (JSONArray) value;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < arr.length(); i++) {
                if (i > 0) sb.append(',');
                sb.append(canonicalJson(arr.get(i)));
            }
            return sb.append(']').toString();
        }
        if (value instanceof JSONObject) {
            JSONObject obj = (JSONObject) value;
            List<String> keys = new ArrayList<>();
            Iterator<String> it = obj.keys();
            while (it.hasNext()) keys.add(it.next());
            Collections.sort(keys);
            StringBuilder sb = new StringBuilder("{");
            for (int i = 0; i < keys.size(); i++) {
                if (i > 0) sb.append(',');
                String k = keys.get(i);
                sb.append(quoteJsonString(k)).append(':').append(canonicalJson(obj.get(k)));
            }
            return sb.append('}').toString();
        }
        throw new JSONException("规范 JSON 不支持的类型: " + value.getClass().getName());
    }

    private static String quoteJsonString(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        return sb.append('"').toString();
    }

    static JSONObject signMembershipCert(
            byte[] ownerPrivateSeed,
            String vaultId,
            String deviceId,
            String devicePubkeyB64,
            String platform,
            long issuedAtMs
    ) throws JSONException {
        JSONObject payload = new JSONObject();
        payload.put("version", 1);
        payload.put("vault_id", vaultId);
        payload.put("device_id", deviceId);
        payload.put("device_pubkey", devicePubkeyB64);
        payload.put("platform", platform);
        payload.put("issued_at_ms", issuedAtMs);
        byte[] bytes = canonicalJson(payload).getBytes(StandardCharsets.UTF_8);
        byte[] sig = ed25519Sign(ownerPrivateSeed, bytes);
        payload.put("owner_signature", base64UrlEncode(sig));
        return payload;
    }

    static boolean verifyMembershipCert(byte[] ownerPubkeyRaw, JSONObject cert) {
        if (cert == null || cert.optInt("version", 0) != 1 || !cert.has("owner_signature")) {
            return false;
        }
        try {
            String sigB64 = cert.getString("owner_signature");
            JSONObject payload = new JSONObject();
            payload.put("version", cert.getInt("version"));
            payload.put("vault_id", cert.getString("vault_id"));
            payload.put("device_id", cert.getString("device_id"));
            payload.put("device_pubkey", cert.getString("device_pubkey"));
            payload.put("platform", cert.getString("platform"));
            payload.put("issued_at_ms", cert.getLong("issued_at_ms"));
            byte[] bytes = canonicalJson(payload).getBytes(StandardCharsets.UTF_8);
            byte[] sig = base64UrlDecode(sigB64);
            return ed25519Verify(toRaw32(ownerPubkeyRaw, "Ed25519 公钥"), bytes, sig);
        } catch (Exception failure) {
            return false;
        }
    }

    static byte[] recordAad(
            String vaultId,
            String collection,
            String recordKey,
            String versionHlc,
            boolean deleted,
            String originDeviceId
    ) {
        String s = "yanmo-sync-v1|" + vaultId + "|" + collection + "|" + recordKey + "|"
                + versionHlc + "|" + (deleted ? 1 : 0) + "|" + (originDeviceId == null ? "" : originDeviceId);
        return s.getBytes(StandardCharsets.UTF_8);
    }

    static byte[] blobAad(String vaultId, String blobId) {
        return ("yanmo-blob-v1|" + vaultId + "|" + blobId).getBytes(StandardCharsets.UTF_8);
    }

    static byte[] sealEnvelope(byte[] key32, byte[] plaintext, byte[] aad, boolean compress)
            throws GeneralSecurityException, IOException {
        byte[] key = toRaw32(key32, "AES-256-GCM 密钥");
        byte[] payload = compress ? gzipCompress(plaintext) : plaintext;
        byte flags = compress ? FLAG_COMPRESSED : 0x00;
        byte[] nonce = randomBytes(NONCE_BYTES);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(TAG_BYTES * 8, nonce));
        if (aad != null && aad.length > 0) cipher.updateAAD(aad);
        byte[] encryptedWithTag = cipher.doFinal(payload);
        byte[] out = new byte[2 + NONCE_BYTES + encryptedWithTag.length];
        out[0] = ENVELOPE_VERSION;
        out[1] = flags;
        System.arraycopy(nonce, 0, out, 2, NONCE_BYTES);
        System.arraycopy(encryptedWithTag, 0, out, 2 + NONCE_BYTES, encryptedWithTag.length);
        return out;
    }

    static byte[] openEnvelope(byte[] key32, byte[] envelope, byte[] aad)
            throws GeneralSecurityException, IOException {
        byte[] key = toRaw32(key32, "AES-256-GCM 密钥");
        if (envelope == null || envelope.length < 2 + NONCE_BYTES + TAG_BYTES) {
            throw new GeneralSecurityException("密文信封长度无效。");
        }
        if (envelope[0] != ENVELOPE_VERSION) {
            throw new GeneralSecurityException("不支持的密文信封版本: " + (envelope[0] & 0xff));
        }
        byte flags = envelope[1];
        if ((flags & ~FLAG_COMPRESSED) != 0) {
            throw new GeneralSecurityException("不支持的密文信封标记位: " + (flags & 0xff));
        }
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_BYTES * 8, envelope, 2, NONCE_BYTES));
        if (aad != null && aad.length > 0) cipher.updateAAD(aad);
        byte[] decrypted = cipher.doFinal(envelope, 2 + NONCE_BYTES, envelope.length - 2 - NONCE_BYTES);
        return (flags & FLAG_COMPRESSED) != 0 ? gzipDecompress(decrypted) : decrypted;
    }

    static String sealPairingSeedBox(byte[] key32, JSONObject payload, String aad)
            throws GeneralSecurityException, IOException {
        byte[] jsonBytes = payload.toString().getBytes(StandardCharsets.UTF_8);
        return base64UrlEncode(sealEnvelope(key32, jsonBytes, aad.getBytes(StandardCharsets.UTF_8), false));
    }

    static JSONObject openPairingSeedBox(byte[] key32, String boxB64, String aad)
            throws GeneralSecurityException, IOException, JSONException {
        byte[] envelope = base64UrlDecode(boxB64);
        byte[] plain = openEnvelope(key32, envelope, aad.getBytes(StandardCharsets.UTF_8));
        return new JSONObject(new String(plain, StandardCharsets.UTF_8));
    }

    static String buildPopSigningString(
            String method,
            String pathAndQuery,
            byte[] bodyBytes,
            long timestampMs,
            String nonce
    ) {
        String bodyHash = sha256Hex(bodyBytes == null ? new byte[0] : bodyBytes);
        return method.toUpperCase(Locale.ROOT) + "\n" + pathAndQuery + "\n" + bodyHash + "\n"
                + timestampMs + "\n" + nonce;
    }

    static Map<String, String> signPopHeaders(
            String deviceId,
            byte[] devicePrivateSeed,
            String method,
            String pathAndQuery,
            byte[] bodyBytes,
            long timestampMs,
            String nonce
    ) {
        String signingString = buildPopSigningString(method, pathAndQuery, bodyBytes, timestampMs, nonce);
        byte[] sig = ed25519Sign(devicePrivateSeed, signingString.getBytes(StandardCharsets.UTF_8));
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Acpm-Device", deviceId);
        headers.put("X-Acpm-Timestamp", Long.toString(timestampMs));
        headers.put("X-Acpm-Nonce", nonce);
        headers.put("X-Acpm-Signature", base64UrlEncode(sig));
        return headers;
    }

    static Map<String, String> signPopHeaders(
            String deviceId,
            byte[] devicePrivateSeed,
            String method,
            String pathAndQuery,
            byte[] bodyBytes
    ) {
        return signPopHeaders(deviceId, devicePrivateSeed, method, pathAndQuery, bodyBytes,
                System.currentTimeMillis(), base64UrlEncode(randomBytes(16)));
    }

    static String buildServerResponseSigningString(
            String clientNonceOrReqId,
            String serverTimestampMs,
            byte[] responseBodyBytes
    ) {
        String bodyHash = sha256Hex(responseBodyBytes == null ? new byte[0] : responseBodyBytes);
        return clientNonceOrReqId + "\n" + serverTimestampMs + "\n" + bodyHash;
    }

    static boolean verifyServerResponse(
            String serverPubkeyB64,
            String clientNonceOrReqId,
            String serverTimestampMs,
            byte[] responseBodyBytes,
            String signatureB64
    ) {
        if (serverPubkeyB64 == null || serverTimestampMs == null || signatureB64 == null) return false;
        try {
            byte[] pubRaw = toRaw32(base64UrlDecode(serverPubkeyB64), "服务端 Ed25519 公钥");
            byte[] sig = base64UrlDecode(signatureB64);
            String signingString = buildServerResponseSigningString(clientNonceOrReqId, serverTimestampMs, responseBodyBytes);
            return ed25519Verify(pubRaw, signingString.getBytes(StandardCharsets.UTF_8), sig);
        } catch (Exception failure) {
            return false;
        }
    }

    private static byte[] toRaw32(byte[] input, String label) {
        if (input == null || input.length != 32) {
            throw new IllegalArgumentException(label + " 必须为 32 字节。");
        }
        return input;
    }

    private static byte[] gzipCompress(byte[] input) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(baos)) {
            gzip.write(input);
        }
        return baos.toByteArray();
    }

    private static byte[] gzipDecompress(byte[] input) throws IOException {
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(input));
             ByteArrayOutputStream baos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = gzip.read(buf)) != -1) {
                baos.write(buf, 0, n);
            }
            return baos.toByteArray();
        }
    }
}
