package dev.yanmo.ime;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Android Keystore-backed secret store and SharedPreferences-backed KnownHub store.
 */
final class SyncStorage {
    private static final String KEY_ALIAS = "yanmo-sync-secrets";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String PREF_SECRETS = "yanmo_sync_secrets";
    private static final String KEY_ENVELOPE = "envelope";
    private static final String PREF_HUBS = "yanmo_sync_hubs";
    private static final String KEY_HUBS = "hubs";
    private static final String KEY_AUTO_CACHE_BLOBS = "auto_cache_blobs";
    private static final String KEY_DAILY_HOUR = "daily_sync_hour";
    private static final String KEY_DAILY_MINUTE = "daily_sync_minute";
    private static final String KEY_SYNC_ENABLED_HINT = "sync_enabled_hint";

    private SyncStorage() {}

    static String defaultDeviceName() {
        String manufacturer = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER.trim();
        String model = Build.MODEL == null ? "" : Build.MODEL.trim();
        if (model.isEmpty()) return "Android 设备";
        if (!manufacturer.isEmpty() && !model.toLowerCase().startsWith(manufacturer.toLowerCase())) {
            return manufacturer + " " + model;
        }
        return model;
    }

    static boolean autoCacheBlobs(Context context) {
        return context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .getBoolean(KEY_AUTO_CACHE_BLOBS, true);
    }

    static void setAutoCacheBlobs(Context context, boolean enabled) {
        context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_AUTO_CACHE_BLOBS, enabled)
                .apply();
    }

    static int dailySyncHour(Context context) {
        int raw = context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .getInt(KEY_DAILY_HOUR, SyncPolicy.DEFAULT_DAILY_HOUR);
        return SyncPolicy.clampHour(raw);
    }

    static int dailySyncMinute(Context context) {
        int raw = context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .getInt(KEY_DAILY_MINUTE, SyncPolicy.DEFAULT_DAILY_MINUTE);
        return SyncPolicy.clampMinute(raw);
    }

    static void setDailySyncTime(Context context, int hour, int minute) {
        context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .edit()
                .putInt(KEY_DAILY_HOUR, SyncPolicy.clampHour(hour))
                .putInt(KEY_DAILY_MINUTE, SyncPolicy.clampMinute(minute))
                .apply();
    }

    static int changeThreshold(Context context) {
        return SyncPolicy.DEFAULT_CHANGE_THRESHOLD;
    }

    static Boolean syncEnabledHint(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE);
        if (!prefs.contains(KEY_SYNC_ENABLED_HINT)) return null;
        return prefs.getBoolean(KEY_SYNC_ENABLED_HINT, false);
    }

    static void setSyncEnabledHint(Context context, boolean enabled) {
        context.getApplicationContext()
                .getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_SYNC_ENABLED_HINT, enabled)
                .apply();
    }

    static final class KeystoreSyncSecretStore implements SyncPairing.SyncSecretStore {
        private final Context app;
        private boolean loaded;
        private SyncModels.SyncSecrets cached;

        KeystoreSyncSecretStore(Context context) {
            this.app = context.getApplicationContext();
        }

        @Override
        public synchronized SyncModels.SyncSecrets load() throws IOException {
            if (loaded) return cached;
            SharedPreferences prefs = app.getSharedPreferences(PREF_SECRETS, Context.MODE_PRIVATE);
            String packed = prefs.getString(KEY_ENVELOPE, null);
            if (packed == null || packed.isEmpty()) {
                cached = null;
                loaded = true;
                SyncStorage.setSyncEnabledHint(app, false);
                return null;
            }
            try {
                String json = decrypt(packed);
                JSONObject obj = new JSONObject(json);
                String deviceId = obj.optString("deviceId", "");
                String privB64 = obj.optString("devicePrivateSeedB64", "");
                String rootB64 = obj.optString("rootSeedB64", "");
                SyncModels.SyncSecrets result = (deviceId.isEmpty() || privB64.isEmpty())
                        ? null
                        : new SyncModels.SyncSecrets(deviceId, privB64, rootB64.isEmpty() ? null : rootB64);
                cached = result;
                loaded = true;
                SyncStorage.setSyncEnabledHint(app, result != null && result.rootSeedB64 != null && !result.rootSeedB64.isEmpty());
                return result;
            } catch (Exception failure) {
                throw new IOException("无法读取本机同步密钥，请重试或重新配对。", failure);
            }
        }

        @Override
        public synchronized void save(SyncModels.SyncSecrets secrets) throws IOException {
            try {
                JSONObject obj = new JSONObject();
                obj.put("deviceId", secrets.deviceId);
                obj.put("devicePrivateSeedB64", secrets.devicePrivateSeedB64);
                if (secrets.rootSeedB64 != null && !secrets.rootSeedB64.isEmpty()) {
                    obj.put("rootSeedB64", secrets.rootSeedB64);
                }
                String encrypted = encrypt(obj.toString());
                boolean ok = app.getSharedPreferences(PREF_SECRETS, Context.MODE_PRIVATE)
                        .edit()
                        .putString(KEY_ENVELOPE, encrypted)
                        .commit();
                if (!ok) throw new IOException("无法写入同步密钥存储。");
                cached = secrets;
                loaded = true;
                SyncStorage.setSyncEnabledHint(app, secrets != null && secrets.rootSeedB64 != null && !secrets.rootSeedB64.isEmpty());
            } catch (IOException io) {
                throw io;
            } catch (Exception failure) {
                throw new IOException("无法安全加密同步密钥。", failure);
            }
        }

        private static SecretKey secretKey(boolean create) throws Exception {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            SecretKey key = (SecretKey) store.getKey(KEY_ALIAS, null);
            if (key != null) return key;
            if (!create) throw new GeneralSecurityException("Sync Keystore key unavailable");
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build());
            return generator.generateKey();
        }

        private static String encrypt(String value) throws Exception {
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, secretKey(true));
            byte[] iv = cipher.getIV();
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] packed = Arrays.copyOf(iv, iv.length + ciphertext.length);
            System.arraycopy(ciphertext, 0, packed, iv.length, ciphertext.length);
            return Base64.encodeToString(packed, Base64.NO_WRAP);
        }

        private static String decrypt(String value) throws Exception {
            byte[] packed = Base64.decode(value, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.DECRYPT_MODE, secretKey(false), new GCMParameterSpec(128, packed, 0, 12));
            return new String(cipher.doFinal(packed, 12, packed.length - 12), StandardCharsets.UTF_8);
        }
    }

    static final class PrefsKnownHubStore implements SyncPairing.KnownHubStore {
        private final Context app;

        PrefsKnownHubStore(Context context) {
            this.app = context.getApplicationContext();
        }

        @Override
        public synchronized List<SyncModels.KnownHub> load() {
            String raw = app.getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE).getString(KEY_HUBS, "[]");
            List<SyncModels.KnownHub> list = new ArrayList<>();
            try {
                JSONArray arr = new JSONArray(raw);
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject obj = arr.optJSONObject(i);
                    if (obj == null) continue;
                    SyncModels.KnownHub hub = SyncModels.KnownHub.fromJson(obj);
                    if (hub != null) list.add(hub);
                }
            } catch (JSONException ignored) {
            }
            return list;
        }

        @Override
        public synchronized void save(List<SyncModels.KnownHub> hubs) throws IOException {
            JSONArray arr = new JSONArray();
            try {
                for (SyncModels.KnownHub h : hubs) arr.put(h.toJson());
            } catch (JSONException bad) {
                throw new IOException("无法序列化已配对节点。", bad);
            }
            boolean ok = app.getSharedPreferences(PREF_HUBS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_HUBS, arr.toString())
                    .commit();
            if (!ok) throw new IOException("无法保存已配对节点列表。");
        }
    }
}
