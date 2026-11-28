package dev.yanmo.ime;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONStringer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class Polish {
    private static final String KEY_ALIAS = "yanmo-text-api";
    private static final String CIPHER = "AES/GCM/NoPadding";

    private Polish() {}

    static final class Failure extends IOException {
        Failure(String message) {
            super(message);
        }
    }

    static SharedPreferences settings(Context context) {
        return context.getSharedPreferences("text-api", Context.MODE_PRIVATE);
    }

    static boolean enabled(Context context) {
        return settings(context).getBoolean("enabled", false);
    }

    static synchronized void save(Context context, boolean enabled, String endpoint,
                                  String model, String key, boolean clearKey) throws Exception {
        URI base = enabled || !endpoint.isEmpty() ? endpointUri(endpoint) : null;
        if (enabled && model.isEmpty()) throw new IOException("请输入模型 ID。");
        SharedPreferences preferences = settings(context);
        if (preferences.contains("credential") && key.isEmpty() && !clearKey) {
            URI former = endpointUri(preferences.getString("endpoint", ""));
            if (base == null || !Objects.equals(former.getAuthority(), base.getAuthority())) {
                throw new IOException("服务主机已更改，请重新输入 API Key 或移除原有密钥。");
            }
        }
        if (clearKey && !key.isEmpty()) throw new IOException("请选择保存新密钥或移除原有密钥。");
        SharedPreferences.Editor editor = preferences.edit()
                .putBoolean("enabled", enabled).putString("endpoint", endpoint).putString("model", model);
        if (clearKey) editor.remove("credential");
        if (!key.isEmpty()) editor.putString("credential", encrypt(key));
        if (!editor.commit()) throw new IOException("无法保存文字 API 设置。");
    }

    static String generate(Context app, String original) throws Exception {
        return generate(app, original, "言墨", Lexicon.GLOBAL, EditorContext.EMPTY, Collections.emptyList());
    }

    static String generate(Context app, String original, String application, String group,
                           EditorContext editor, List<Lexicon.Entry> terms) throws Exception {
        return generate(settings(app).getAll(), () -> app.getAssets().open("polish.txt"),
                original, application, group, editor, terms);
    }

    interface PromptAsset {
        InputStream open() throws IOException;
    }

    static String generate(Map<String, ?> preferences, PromptAsset asset, String original, String application,
                           String group, EditorContext editor, List<Lexicon.Entry> lexicon) throws Exception {
        String payload = new JSONStringer().object()
                .key("INSTRUCTION").value("")
                .key("AUDIO_CONTEXT").object()
                    .key("application").object()
                        .key("categories").array().value(Lexicon.GLOBAL.equals(group) ? "general" : group).endArray()
                        .key("name").value(application)
                    .endObject()
                    .key("background_screen_text").array().endArray()
                .endObject()
                .key("context").object()
                    .key("text_before_cursor").value(editor.before)
                    .key("text_after_cursor").value(editor.after)
                .endObject()
                .key("ASR_RESULTS").array().object()
                    .key("engine_name").value("ASR 1")
                    .key("transcript").value(original)
                .endObject().endArray()
                .endObject().toString();
        return request(preferences, asset, payload, 4096, false);
    }

    static List<String> correctionTerms(Context app, String original, String corrected, String raw) throws Exception {
        return correctionTerms(settings(app).getAll(), () -> app.getAssets().open("correction-terms.txt"),
                original, corrected, raw);
    }

    static List<String> correctionTerms(Map<String, ?> preferences, PromptAsset asset,
                                        String original, String corrected, String raw) throws Exception {
        if (original.equals(corrected) || corrected.trim().isEmpty()) return Collections.emptyList();
        JSONObject payload = new JSONObject().put("ORIGINAL", original).put("CORRECTED", corrected);
        if (raw != null && !raw.equals(original)) payload.put("ASR", raw);
        JSONArray output = new JSONArray(request(preferences, asset, payload.toString(), 512, true));
        if (output.length() > 10) return Collections.emptyList();
        LinkedHashSet<String> terms = new LinkedHashSet<>();
        for (int i = 0; i < output.length(); i++) {
            Object item = output.get(i);
            if (!(item instanceof String)) return Collections.emptyList();
            String term = ((String) item).trim();
            if (!term.isEmpty() && term.length() <= 64 && !term.matches("(?s).*\\R.*")
                    && corrected.contains(term) && !original.contains(term)) terms.add(term);
        }
        return new ArrayList<>(terms);
    }

    private static String request(Map<String, ?> preferences, PromptAsset asset, String payload, int maxTokens,
                                  boolean extraction) throws Exception {
        if (!Boolean.TRUE.equals(preferences.get("enabled"))) {
            throw new Failure("请先在言墨设置中配置并启用文字处理 API。");
        }
        URI base = endpointUri((String) preferences.get("endpoint"));
        String model = (String) preferences.get("model");
        String key;
        try {
            key = decrypt((String) preferences.get("credential"));
        } catch (Exception failure) {
            throw new Failure("无法读取 API Key，请在言墨设置中重新保存。");
        }
        String prompt;
        try (InputStream input = asset.open()) {
            prompt = read(input);
        }
        JSONArray messages = new JSONArray()
                .put(new JSONObject().put("role", "system").put("content", prompt))
                .put(new JSONObject().put("role", "user").put("content", payload));
        JSONObject body = new JSONObject().put("model", model).put("messages", messages)
                .put("temperature", 0).put("max_tokens", maxTokens);
        if ("api.deepseek.com".equalsIgnoreCase(base.getHost())) {
            body.put("thinking", new JSONObject().put("type", extraction ? "disabled" : "enabled"));
            if (!extraction) body.put("reasoning_effort", "low");
        }
        return post(base, key, body);
    }

    private static URI endpointUri(String endpoint) throws IOException {
        try {
            URI base = URI.create(endpoint == null ? "" : endpoint.replaceAll("/+$", ""));
            if ("https".equalsIgnoreCase(base.getScheme()) && base.getHost() != null
                    && base.getUserInfo() == null && base.getQuery() == null && base.getFragment() == null) {
                return base;
            }
        } catch (IllegalArgumentException ignored) {
            // Show the same validation message for malformed and incomplete addresses.
        }
        throw new Failure("请输入 HTTPS 服务根地址，例如 https://api.deepseek.com/v1。");
    }

    private static String post(URI base, String key, JSONObject body) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) URI.create(base + "/chat/completions")
                .toURL().openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(120000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        if (!key.isEmpty()) connection.setRequestProperty("Authorization", "Bearer " + key);
        connection.setDoOutput(true);
        int status;
        String response = "";
        try {
            try (java.io.OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                try (InputStream input = connection.getInputStream()) {
                    response = read(input);
                }
            }
        } catch (IOException | IllegalArgumentException failure) {
            throw new Failure("无法连接文字 API，请检查网络与服务地址。");
        } finally {
            connection.disconnect();
        }

        if (status == 401 || status == 403) throw new Failure("文字 API 拒绝了凭据，请检查 API Key。");
        if (status == 404) throw new Failure("找不到文字 API 接口或模型，请检查服务地址与模型 ID。");
        if (status == 429) throw new Failure("文字 API 请求过多或额度不足，请稍后重试。");
        if (status < 200 || status >= 300) throw new Failure("文字 API 返回错误（HTTP " + status + "）。");
        try {
            JSONObject choice = new JSONObject(response).getJSONArray("choices").getJSONObject(0);
            if (!"stop".equals(choice.optString("finish_reason"))) {
                throw new Failure("文字 API 未完成本次整理，请尝试分段录入。");
            }
            Object content = choice.getJSONObject("message").get("content");
            if (content instanceof String && !((String) content).trim().isEmpty()) return (String) content;
        } catch (JSONException failure) {
            throw new Failure("文字 API 返回了无法识别的结果。");
        }
        throw new Failure("文字 API 没有返回整理正文。");
    }

    private static String read(InputStream input) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int length;
        while ((length = input.read(buffer)) != -1) bytes.write(buffer, 0, length);
        return bytes.toString(StandardCharsets.UTF_8.name());
    }

    private static SecretKey credentialKey(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        SecretKey key = (SecretKey) store.getKey(KEY_ALIAS, null);
        if (key != null) return key;
        if (!create) throw new GeneralSecurityException("Credential key unavailable");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, credentialKey(true));
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] packed = Arrays.copyOf(iv, iv.length + ciphertext.length);
        System.arraycopy(ciphertext, 0, packed, iv.length, ciphertext.length);
        return Base64.encodeToString(packed, Base64.NO_WRAP);
    }

    private static String decrypt(String value) throws Exception {
        if (value == null || value.isEmpty()) return "";
        byte[] packed = Base64.decode(value, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.DECRYPT_MODE, credentialKey(false), new GCMParameterSpec(128, packed, 0, 12));
        return new String(cipher.doFinal(packed, 12, packed.length - 12), StandardCharsets.UTF_8);
    }
}
