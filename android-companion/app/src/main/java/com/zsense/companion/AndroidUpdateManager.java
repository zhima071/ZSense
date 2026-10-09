package com.zsense.companion;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Official GitHub APK updater. The APK is never trusted until its release SHA-256 is verified. */
final class AndroidUpdateManager {
    static final class State {
        final String phase, version, message;
        final long received, total, bytesPerSecond;
        State(String phase, String version, long received, long total, long bytesPerSecond, String message) {
            this.phase = phase; this.version = version; this.received = received;
            this.total = total; this.bytesPerSecond = bytesPerSecond; this.message = message;
        }
    }
    interface Listener {
        void onState(State state);
        void onInstallReady(File apk);
    }
    private static final String RELEASE_API = "https://api.github.com/repos/zhima071/ZSense/releases/latest";
    private static final Pattern APK_NAME = Pattern.compile("ZSense-(\\d+\\.\\d+\\.\\d+)-android13-release\\.apk");
    private static final long MAX_APK_BYTES = 500L * 1024 * 1024;
    private static final int MAX_FEED_BYTES = 256 * 1024;
    private final Context context;
    private final Listener listener;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean downloading = new AtomicBoolean();
    private volatile HttpURLConnection activeConnection;
    private volatile String stopIntent = "";
    private volatile State state = new State("idle", "", 0, 0, 0, "当前版本 " + BuildConfig.VERSION_NAME);
    private Release latest;

    private static final class Release {
        final String version, name, url, sha256;
        final long size;
        Release(String version, String name, String url, String sha256, long size) {
            this.version = version; this.name = name; this.url = url; this.sha256 = sha256; this.size = size;
        }
    }

    AndroidUpdateManager(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        publish(state);
    }

    private void publish(State next) {
        state = next;
        ui.post(() -> listener.onState(next));
    }

    State state() { return state; }

    void check() {
        if (downloading.get()) return;
        publish(new State("checking", "", 0, 0, 0, "正在检查官方版本…"));
        worker.execute(() -> {
            try {
                JSONObject feed = new JSONObject(readLimited(open(RELEASE_API, null, false), MAX_FEED_BYTES));
                String tag = feed.optString("tag_name");
                if (!tag.matches("v\\d+\\.\\d+\\.\\d+")) throw new IllegalStateException("官方发布版本号无效。");
                JSONArray assets = feed.optJSONArray("assets");
                Release found = null;
                if (assets != null) for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.optJSONObject(i);
                    if (asset == null) continue;
                    String name = asset.optString("name");
                    Matcher matcher = APK_NAME.matcher(name);
                    if (!matcher.matches()) continue;
                    String url = asset.optString("browser_download_url");
                    String expectedUrl = "https://github.com/zhima071/ZSense/releases/download/" + tag + "/" + name;
                    long size = asset.optLong("size", 0);
                    String sha = checksum(feed.optString("body"), name);
                    if (!expectedUrl.equals(url) || size <= 0 || size > MAX_APK_BYTES || sha.isEmpty())
                        throw new IllegalStateException("官方 APK 缺少可验证的地址、大小或 SHA-256，不能在应用内安装。");
                    found = new Release(matcher.group(1), name, url, sha, size);
                    break;
                }
                if (found == null) throw new IllegalStateException("最新发布中没有 Android 安装包。");
                latest = found;
                if (compareVersion(found.version, BuildConfig.VERSION_NAME) <= 0) {
                    publish(new State("current", found.version, 0, found.size, 0, "已是最新版本 " + BuildConfig.VERSION_NAME));
                    return;
                }
                File finalApk = finalFile(found);
                if (finalApk.isFile() && verify(finalApk, found)) {
                    publish(new State("ready", found.version, found.size, found.size, 0, "新版本 " + found.version + " 已下载并校验，可安装。"));
                    return;
                }
                File partial = partialFile(found);
                long cached = partial.isFile() ? partial.length() : 0;
                if (cached > found.size) { Files.deleteIfExists(partial.toPath()); cached = 0; }
                publish(new State(cached > 0 ? "paused" : "available", found.version, cached, found.size, 0,
                        "发现 Android 新版本 " + found.version + (cached > 0 ? "，可继续下载。" : "。")));
            } catch (Exception error) {
                publish(new State("error", "", 0, 0, 0, "检查更新失败：" + error.getMessage()));
            }
        });
    }

    void download() {
        Release release = latest;
        if (release == null || compareVersion(release.version, BuildConfig.VERSION_NAME) <= 0 ||
                !downloading.compareAndSet(false, true)) return;
        stopIntent = "";
        publish(new State("downloading", release.version, state.received, release.size, 0, "正在下载…"));
        worker.execute(() -> downloadOnWorker(release));
    }

    private void downloadOnWorker(Release release) {
        File partial = partialFile(release);
        try {
            File directory = updatesDirectory();
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("无法创建更新缓存目录。");
            long offset = partial.isFile() ? partial.length() : 0;
            if (offset > release.size) { Files.deleteIfExists(partial.toPath()); offset = 0; }
            if (offset == release.size && verify(partial, release)) { finishDownload(partial, release); return; }
            if (offset == release.size) { Files.deleteIfExists(partial.toPath()); offset = 0; }
            if (!stopIntent.isEmpty()) throw new InterruptedException("下载已暂停或取消。");
            HttpURLConnection connection = open(release.url, offset > 0 ? "bytes=" + offset + "-" : null, true);
            int status = connection.getResponseCode();
            if (offset > 0 && status == 206) {
                String expectedRange = "bytes " + offset + "-";
                String range = connection.getHeaderField("Content-Range");
                if (range == null || !range.startsWith(expectedRange) || !range.endsWith("/" + release.size))
                    throw new IllegalStateException("服务器返回的续传范围不正确，缓存已保留。");
            } else if (status == 200) offset = 0; // Server ignored Range: overwrite, never append.
            else throw new IllegalStateException("下载服务器返回 HTTP " + status + "。");
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            if (offset > 0) hashFile(partial, digest);
            long received = offset;
            long lastReport = System.currentTimeMillis(), speedAt = lastReport, speedBytes = received;
            byte[] buffer = new byte[64 * 1024];
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial, offset > 0)) {
                int length;
                while ((length = input.read(buffer)) != -1) {
                    if (!stopIntent.isEmpty()) throw new InterruptedException("下载已暂停或取消。");
                    received += length;
                    if (received > release.size || received > MAX_APK_BYTES) throw new IllegalStateException("APK 大小超过官方发布记录。");
                    output.write(buffer, 0, length);
                    digest.update(buffer, 0, length);
                    long now = System.currentTimeMillis();
                    if (now - lastReport >= 200) {
                        long speed = now > speedAt ? Math.max(0, (received - speedBytes) * 1000 / (now - speedAt)) : 0;
                        publish(new State("downloading", release.version, received, release.size, speed, "正在下载…"));
                        lastReport = now;
                        if (now - speedAt >= 1000) { speedAt = now; speedBytes = received; }
                    }
                }
                output.getFD().sync();
            }
            if (!stopIntent.isEmpty()) throw new InterruptedException("下载已暂停或取消。");
            if (received != release.size || !hex(digest.digest()).equals(release.sha256)) {
                Files.deleteIfExists(partial.toPath());
                throw new IllegalStateException("APK 大小或 SHA-256 校验失败，已清理损坏缓存。");
            }
            finishDownload(partial, release);
        } catch (Exception error) {
            if ("cancel".equals(stopIntent)) {
                try { Files.deleteIfExists(partial.toPath()); } catch (Exception ignored) { /* show canceled */ }
                publish(new State("canceled", release.version, 0, release.size, 0, "已取消下载并清理缓存。"));
            } else if ("pause".equals(stopIntent)) {
                publish(new State("paused", release.version, partial.isFile() ? partial.length() : 0, release.size, 0, "已暂停，可稍后继续下载。"));
            } else {
                publish(new State("error", release.version, partial.isFile() ? partial.length() : 0, release.size, 0,
                        "下载失败：" + error.getMessage() + "。可重试或取消清理缓存。"));
            }
        } finally {
            if (activeConnection != null) activeConnection.disconnect();
            activeConnection = null;
            stopIntent = "";
            downloading.set(false);
        }
    }

    private void finishDownload(File partial, Release release) throws Exception {
        Files.move(partial.toPath(), finalFile(release).toPath(), StandardCopyOption.REPLACE_EXISTING);
        publish(new State("ready", release.version, release.size, release.size, 0, "新版本 " + release.version + " 已下载并校验，可安装。"));
    }

    void pause() {
        if (!downloading.get()) return;
        stopIntent = "pause";
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
    }

    void cancel() {
        stopIntent = "cancel";
        HttpURLConnection connection = activeConnection;
        if (connection != null) connection.disconnect();
        if (!downloading.get()) worker.execute(() -> {
            try {
                if (latest != null) Files.deleteIfExists(partialFile(latest).toPath());
                publish(new State("canceled", latest == null ? "" : latest.version, 0,
                        latest == null ? 0 : latest.size, 0, "已取消下载并清理缓存。"));
            } catch (Exception error) { publish(new State("error", "", 0, 0, 0, "清理缓存失败：" + error.getMessage())); }
            finally { stopIntent = ""; }
        });
    }

    void install() {
        Release release = latest;
        if (release == null || !"ready".equals(state.phase)) return;
        publish(new State("verifying", release.version, release.size, release.size, 0, "正在重新校验安装包…"));
        worker.execute(() -> {
            try {
                File apk = finalFile(release);
                if (!verify(apk, release)) throw new IllegalStateException("安装包校验失败，请重新下载。");
                ui.post(() -> listener.onInstallReady(apk));
                publish(new State("ready", release.version, release.size, release.size, 0, "安装包已校验，等待系统安装确认。"));
            } catch (Exception error) {
                publish(new State("error", release.version, 0, release.size, 0, error.getMessage()));
            }
        });
    }

    private File updatesDirectory() { return new File(context.getFilesDir(), "updates"); }
    private File finalFile(Release release) { return new File(updatesDirectory(), release.name); }
    private File partialFile(Release release) { return new File(updatesDirectory(), release.name + ".part"); }

    private static String checksum(String body, String name) {
        Pattern pattern = Pattern.compile("(?m)^\\s*-\\s*" + Pattern.quote(name) + ":\\s*([a-fA-F0-9]{64})\\s*$");
        Matcher match = pattern.matcher(body);
        return match.find() ? match.group(1).toLowerCase(Locale.ROOT) : "";
    }

    private static int compareVersion(String left, String right) {
        String[] a = left.split("\\."), b = right.split("\\.");
        for (int i = 0; i < 3; i++) {
            int x = i < a.length ? Integer.parseInt(a[i]) : 0;
            int y = i < b.length ? Integer.parseInt(b[i]) : 0;
            if (x != y) return Integer.compare(x, y);
        }
        return 0;
    }

    private HttpURLConnection open(String url, String range, boolean download) throws Exception {
        URL current = new URL(url);
        for (int redirects = 0; redirects < 6; redirects++) {
            if (download && !stopIntent.isEmpty()) throw new InterruptedException("下载已暂停或取消。");
            if (!"https".equals(current.getProtocol()) || !allowedHost(current.getHost()))
                throw new IllegalStateException("更新地址不是允许的 GitHub HTTPS 地址。");
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            if (download) activeConnection = connection;
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(20_000);
            connection.setRequestProperty("User-Agent", "ZSense-Android-Updater/" + BuildConfig.VERSION_NAME);
            // GitHub's JSON API returns HTTP 415 when asked for an octet stream.
            // Release assets use a separate download request and may redirect to its CDN.
            connection.setRequestProperty("Accept", download ? "application/octet-stream" : "application/vnd.github+json");
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (range != null) connection.setRequestProperty("Range", range);
            int status = connection.getResponseCode();
            if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                String location = connection.getHeaderField("Location");
                if (location == null) throw new IllegalStateException("下载服务器未提供重定向地址。");
                current = new URL(current, location);
                connection.disconnect();
                if (download) activeConnection = null;
                continue;
            }
            if (status < 200 || status >= 300) {
                connection.disconnect();
                throw new IllegalStateException("更新源返回 HTTP " + status + "。");
            }
            return connection;
        }
        throw new IllegalStateException("更新下载重定向过多。");
    }

    private static boolean allowedHost(String host) {
        String value = host.toLowerCase(Locale.ROOT);
        return value.equals("api.github.com") || value.equals("github.com") ||
                value.endsWith(".githubusercontent.com");
    }

    private static String readLimited(HttpURLConnection connection, int limit) throws Exception {
        try (InputStream input = connection.getInputStream()) {
            byte[] buffer = new byte[8192];
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > limit) throw new IllegalStateException("更新清单过大。");
                output.write(buffer, 0, count);
            }
            return output.toString(java.nio.charset.StandardCharsets.UTF_8);
        } finally { connection.disconnect(); }
    }

    private static void hashFile(File file, MessageDigest digest) throws Exception {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
    }

    private static boolean verify(File file, Release release) throws Exception {
        if (!file.isFile() || file.length() != release.size) return false;
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        hashFile(file, digest);
        return hex(digest.digest()).equals(release.sha256);
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }
}
