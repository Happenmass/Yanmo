package dev.yanmo.ime;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Checks, downloads, verifies, and launches verified in-place Android APK updates from GitHub Releases. */
final class YanmoUpdater {
    static final String REPOSITORY = "Happenmass/Yanmo";
    static final String RELEASES_API = "https://api.github.com/repos/" + REPOSITORY + "/releases?per_page=20";
    static final Pattern ANDROID_TAG = Pattern.compile("^android-v(\\d+)\\.(\\d+)\\.(\\d+)-yanmo\\.(\\d+)$");
    static final Pattern INSTALLED_VERSION = Pattern.compile("^(\\d+)\\.(\\d+)\\.(\\d+)-yanmo\\.(\\d+)(?:[-+].*)?$");
    static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    static final String EXPECTED_CERT_SHA256 = "4a4c42dba046be7d84992d4277fde00744884d13dfa3ad6ac439e901824b7a5e";
    static final long AUTO_CHECK_INTERVAL_MS = 12L * 60L * 60L * 1000L;

    private static final String PREFS = "yanmo_updater";
    private static final String KEY_LAST_CHECK_MS = "lastCheckAtMs";
    private static final String KEY_AVAILABLE_VERSION = "availableVersion";
    private static final Pattern SHA256_DIGEST = Pattern.compile("^sha256:([a-f0-9]{64})$");
    private static final Pattern SHA256_HEX = Pattern.compile("^[a-f0-9]{64}$");

    static final class ReleaseInfo {
        final String version;
        final String tagName;
        final String assetName;
        final String downloadUrl;
        final String sha256;
        final String notes;
        final long sizeBytes;

        ReleaseInfo(String version, String tagName, String assetName, String downloadUrl,
                    String sha256, String notes, long sizeBytes) {
            this.version = version;
            this.tagName = tagName;
            this.assetName = assetName;
            this.downloadUrl = downloadUrl;
            this.sha256 = sha256;
            this.notes = notes == null ? "" : notes;
            this.sizeBytes = sizeBytes;
        }
    }

    static final class UpdateException extends IOException {
        UpdateException(String message) {
            super(message);
        }

        UpdateException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    interface ProgressListener {
        void onProgress(int percent);
    }

    interface TextFetcher {
        String fetch(String url) throws IOException;
    }

    private YanmoUpdater() {}

    static String currentVersionName(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info != null && info.versionName != null ? info.versionName : "0.0.0-yanmo.0";
        } catch (PackageManager.NameNotFoundException error) {
            return "0.0.0-yanmo.0";
        }
    }

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static boolean shouldAutoCheck(Context context) {
        long last = prefs(context).getLong(KEY_LAST_CHECK_MS, 0L);
        return System.currentTimeMillis() - last >= AUTO_CHECK_INTERVAL_MS;
    }

    static String cachedAvailableVersion(Context context) {
        String cached = prefs(context).getString(KEY_AVAILABLE_VERSION, "");
        if (cached == null || cached.isEmpty()) return "";
        int[] current = parseVersion(currentVersionName(context), INSTALLED_VERSION);
        int[] available = parseVersion(cached, INSTALLED_VERSION);
        if (current != null && available != null && compareVersions(available, current) > 0) {
            return cached;
        }
        return "";
    }

    static int[] parseVersion(String raw, Pattern pattern) {
        if (raw == null) return null;
        Matcher m = pattern.matcher(raw.trim());
        if (!m.matches()) return null;
        return new int[] {
                Integer.parseInt(m.group(1)),
                Integer.parseInt(m.group(2)),
                Integer.parseInt(m.group(3)),
                Integer.parseInt(m.group(4))
        };
    }

    static int compareVersions(int[] a, int[] b) {
        for (int i = 0; i < 4; i++) {
            int cmp = Integer.compare(a[i], b[i]);
            if (cmp != 0) return cmp;
        }
        return 0;
    }

    static String parseSha256Sums(String sumsText, String targetFileName) {
        if (sumsText == null || targetFileName == null || targetFileName.isEmpty()) return null;
        String[] lines = sumsText.split("\\r?\\n");
        for (String line : lines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;
            int space = -1;
            for (int i = 0; i < trimmed.length(); i++) {
                if (Character.isWhitespace(trimmed.charAt(i))) {
                    space = i;
                    break;
                }
            }
            if (space <= 0) continue;
            String hash = trimmed.substring(0, space).toLowerCase(Locale.ROOT);
            String file = trimmed.substring(space).trim();
            if (file.startsWith("*")) file = file.substring(1);
            if (file.equals(targetFileName) && SHA256_HEX.matcher(hash).matches()) {
                return hash;
            }
        }
        return null;
    }

    static ReleaseInfo findLatestFromJson(String currentVersionName, String releasesJson, TextFetcher textFetcher)
            throws IOException {
        int[] installed = parseVersion(currentVersionName, INSTALLED_VERSION);
        if (installed == null) {
            throw new UpdateException("无法识别当前应用版本。");
        }
        JSONArray releases;
        try {
            releases = new JSONArray(releasesJson);
        } catch (JSONException error) {
            throw new UpdateException("GitHub 返回的版本信息无效。", error);
        }

        JSONObject bestRelease = null;
        int[] bestVersion = null;
        String bestTag = null;
        String bestVersionStr = null;

        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || release.optBoolean("draft") || release.optBoolean("prerelease")) continue;
            String tagName = release.optString("tag_name", "").trim();
            int[] parsed = parseVersion(tagName, ANDROID_TAG);
            if (parsed == null) continue;
            if (compareVersions(parsed, installed) <= 0) continue;
            if (bestVersion == null || compareVersions(parsed, bestVersion) > 0) {
                bestVersion = parsed;
                bestRelease = release;
                bestTag = tagName;
                bestVersionStr = parsed[0] + "." + parsed[1] + "." + parsed[2] + "-yanmo." + parsed[3];
            }
        }

        if (bestRelease == null) {
            return null;
        }

        String expectedAssetName = "Yanmo-Android-" + bestVersionStr + "-arm64-v8a.apk";
        String releaseBase = "https://github.com/" + REPOSITORY + "/releases/download/" + bestTag + "/";
        String expectedUrl = releaseBase + expectedAssetName;

        JSONArray assets = bestRelease.optJSONArray("assets");
        JSONObject apkAsset = null;
        JSONObject sumsAsset = null;
        if (assets != null) {
            for (int i = 0; i < assets.length(); i++) {
                JSONObject asset = assets.optJSONObject(i);
                if (asset == null) continue;
                String name = asset.optString("name", "");
                String state = asset.optString("state", "");
                if (!state.isEmpty() && !"uploaded".equals(state)) continue;
                if (expectedAssetName.equals(name)) {
                    apkAsset = asset;
                } else if ("SHA256SUMS".equals(name)) {
                    sumsAsset = asset;
                }
            }
        }

        if (apkAsset == null) {
            throw new UpdateException("该版本暂时没有可校验的 Android 安装包。");
        }
        String downloadUrl = apkAsset.optString("browser_download_url", "");
        long size = apkAsset.optLong("size", -1L);
        if (!expectedUrl.equals(downloadUrl) || size <= 0 || size > MAX_APK_BYTES) {
            throw new UpdateException("该版本暂时没有可校验的 Android 安装包。");
        }

        String sha256 = null;
        String digest = apkAsset.optString("digest", "").trim().toLowerCase(Locale.ROOT);
        Matcher m = SHA256_DIGEST.matcher(digest);
        if (m.matches()) {
            sha256 = m.group(1);
        } else if (sumsAsset != null && textFetcher != null) {
            String sumsUrl = sumsAsset.optString("browser_download_url", "");
            if (sumsUrl.equals(releaseBase + "SHA256SUMS")) {
                sha256 = parseSha256Sums(textFetcher.fetch(sumsUrl), expectedAssetName);
            }
        }
        if (sha256 == null || !SHA256_HEX.matcher(sha256).matches()) {
            throw new UpdateException("该版本暂时没有可校验的 Android 安装包。");
        }

        String notes = bestRelease.optString("body", "").trim();
        return new ReleaseInfo(bestVersionStr, bestTag, expectedAssetName, downloadUrl, sha256, notes, size);
    }

    static ReleaseInfo checkUpdate(Context context) throws IOException {
        String current = currentVersionName(context);
        String json = fetchText(RELEASES_API, "application/vnd.github+json");
        ReleaseInfo info = findLatestFromJson(current, json, url -> fetchText(url, "text/plain"));
        prefs(context).edit()
                .putLong(KEY_LAST_CHECK_MS, System.currentTimeMillis())
                .putString(KEY_AVAILABLE_VERSION, info == null ? "" : info.version)
                .apply();
        return info;
    }

    static File downloadAndVerify(Context context, ReleaseInfo info, ProgressListener progress) throws IOException {
        File dir = new File(context.getCacheDir(), "updates");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new UpdateException("无法创建更新缓存目录。");
        }
        File[] existing = dir.listFiles();
        if (existing != null) {
            for (File item : existing) {
                if (item.isFile()) item.delete();
            }
        }

        File temp = File.createTempFile("yanmo-update-", ".tmp", dir);
        HttpURLConnection conn = null;
        try {
            conn = openHttps(info.downloadUrl, null);
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new UpdateException("下载安装包失败（HTTP " + code + "），请稍后再试。");
            }
            MessageDigest md;
            try {
                md = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException error) {
                throw new UpdateException("系统不支持 SHA-256 校验。", error);
            }
            byte[] buf = new byte[64 * 1024];
            long received = 0L;
            int lastPercent = -1;
            try (InputStream in = conn.getInputStream();
                 FileOutputStream out = new FileOutputStream(temp)) {
                int read;
                while ((read = in.read(buf)) != -1) {
                    received += read;
                    if (received > info.sizeBytes) {
                        throw new UpdateException("安装包大小不匹配。");
                    }
                    md.update(buf, 0, read);
                    out.write(buf, 0, read);
                    if (progress != null && info.sizeBytes > 0) {
                        int pct = (int) Math.min(100L, (received * 100L) / info.sizeBytes);
                        if (pct != lastPercent) {
                            lastPercent = pct;
                            progress.onProgress(pct);
                        }
                    }
                }
                out.getFD().sync();
            }
            if (received != info.sizeBytes) {
                throw new UpdateException("安装包下载不完整，请重试。");
            }
            String actualSha = hex(md.digest());
            if (!actualSha.equalsIgnoreCase(info.sha256)) {
                throw new UpdateException("安装包 SHA-256 校验失败，已放弃安装。");
            }

            verifyArchivePackageAndSignature(context, temp);

            File dest = new File(dir, info.assetName);
            if (dest.exists() && !dest.delete()) {
                throw new UpdateException("无法准备安装文件。");
            }
            if (!temp.renameTo(dest)) {
                throw new UpdateException("无法保存已校验的安装包。");
            }
            return dest;
        } catch (IOException error) {
            temp.delete();
            throw error;
        } catch (RuntimeException error) {
            temp.delete();
            throw new UpdateException("校验安装包失败，请重试。", error);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static void verifyArchivePackageAndSignature(Context context, File apkFile) throws UpdateException {
        PackageManager pm = context.getPackageManager();
        PackageInfo archive = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_SIGNING_CERTIFICATES);
        if (archive == null || !context.getPackageName().equals(archive.packageName)) {
            throw new UpdateException("安装包应用标识不匹配。");
        }
        String archiveCert = signingCertSha256(archive);
        if (!EXPECTED_CERT_SHA256.equals(archiveCert)) {
            throw new UpdateException("安装包签名证书不一致，已拦截安装。");
        }
        try {
            PackageInfo current = pm.getPackageInfo(context.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            String currentCert = signingCertSha256(current);
            if (currentCert != null && !currentCert.equals(archiveCert)) {
                throw new UpdateException("安装包签名与当前安装版本不一致。");
            }
        } catch (PackageManager.NameNotFoundException ignored) {
            // Package itself is always installed.
        }
    }

    private static String signingCertSha256(PackageInfo info) {
        if (info == null || info.signingInfo == null) return null;
        SigningInfo signingInfo = info.signingInfo;
        Signature[] signers = signingInfo.getApkContentsSigners();
        if (signers == null || signers.length != 1) return null;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return hex(md.digest(signers[0].toByteArray()));
        } catch (NoSuchAlgorithmException error) {
            return null;
        }
    }

    static boolean canInstallPackages(Context context) {
        return context.getPackageManager().canRequestPackageInstalls();
    }

    static Intent unknownSourcesSettingsIntent(Context context) {
        return new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + context.getPackageName()));
    }

    static void launchInstall(Activity activity, File apkFile) throws UpdateException {
        try {
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (RuntimeException error) {
            throw new UpdateException("无法调起系统安装器。", error);
        }
    }

    private static String fetchText(String urlString, String accept) throws IOException {
        HttpURLConnection conn = null;
        try {
            conn = openHttps(urlString, accept);
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) {
                throw new UpdateException("暂时无法检查 GitHub 上的版本（HTTP " + code + "），请稍后再试。");
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            long total = 0L;
            try (InputStream in = conn.getInputStream()) {
                int read;
                while ((read = in.read(buf)) != -1) {
                    total += read;
                    if (total > 2L * 1024L * 1024L) {
                        throw new UpdateException("版本响应体积过大。");
                    }
                    out.write(buf, 0, read);
                }
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static HttpURLConnection openHttps(String urlString, String accept) throws IOException {
        String current = urlString;
        for (int hops = 0; hops < 6; hops++) {
            if (current == null || !current.startsWith("https://")) {
                throw new UpdateException("仅允许通过 HTTPS 获取更新。");
            }
            HttpURLConnection conn = (HttpURLConnection) new URL(current).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(10_000);
            conn.setReadTimeout(20_000);
            conn.setRequestProperty("User-Agent", "Yanmo-Android");
            if (accept != null && !accept.isEmpty()) {
                conn.setRequestProperty("Accept", accept);
            }
            int code = conn.getResponseCode();
            if (code == HttpURLConnection.HTTP_MOVED_PERM || code == HttpURLConnection.HTTP_MOVED_TEMP
                    || code == HttpURLConnection.HTTP_SEE_OTHER || code == 307 || code == 308) {
                String location = conn.getHeaderField("Location");
                conn.disconnect();
                if (location == null || !location.startsWith("https://")) {
                    throw new UpdateException("更新重定向地址不安全。");
                }
                current = location;
                continue;
            }
            return conn;
        }
        throw new UpdateException("更新地址重定向次数过多。");
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(Character.forDigit((b >>> 4) & 0xF, 16));
            sb.append(Character.forDigit(b & 0xF, 16));
        }
        return sb.toString();
    }
}
