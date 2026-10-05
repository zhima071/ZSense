package com.zsense.companion;

import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.HashSet;
import java.util.Set;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/** The Android client of Hub v2 and the desktop Web Bridge / LAN v2 protocols. */
final class DeviceClient {
    private static final String HUB = BuildConfig.HUB_URL;
    private final IdentityStore identity;

    DeviceClient(IdentityStore identity) {
        if (!BuildConfig.DEBUG && !HUB.startsWith("https://")) throw new IllegalStateException("正式版只允许 HTTPS 交换中心。");
        this.identity = identity;
    }

    String deviceId() { return identity.deviceId(); }

    JSONObject register() throws Exception {
        JSONObject registered = signedHub("register", "", "");
        identity.setDeviceId(registered.getString("deviceId"));
        return registered;
    }

    JSONObject sendCode(String email) throws Exception {
        requireRegistered();
        return post(HUB + "/__hub/api/app/code", new JSONObject()
                .put("purpose", "device-bind").put("deviceId", deviceId()).put("email", email), null).getJSONObject("data");
    }

    JSONObject bindEmail(String email, String code) throws Exception {
        requireRegistered();
        JSONObject result = signedHub("account-bind", email.trim().toLowerCase(Locale.ROOT), code.trim());
        identity.setEmail(email.trim().toLowerCase(Locale.ROOT));
        return result;
    }

    JSONArray peers() throws Exception {
        requireRegistered();
        return signedHub("account-peers", "", "").getJSONArray("peers");
    }

    private JSONObject signedHub(String action, String email, String code) throws Exception {
        String publicKey = identity.publicPem();
        JSONObject challenge = post(HUB + "/__hub/challenge", new JSONObject()
                .put("action", action).put("deviceId", deviceId()).put("publicKey", publicKey), null).getJSONObject("data");
        String assigned = challenge.getString("deviceId");
        if (!assigned.matches("[a-z0-9][a-z0-9-]{1,58}") ||
                (deviceId().length() > 0 && !deviceId().equals(assigned)) ||
                System.currentTimeMillis() >= java.time.Instant.parse(challenge.getString("expiresAt")).toEpochMilli())
            throw new IllegalStateException("交换中心返回了无效或已过期的设备挑战。");
        String name = "ZSense Android";
        String fingerprint = hex(MessageDigest.getInstance("SHA-256").digest(identity.publicDer()));
        String canonical = "{\"version\":2,\"action\":" + JSONObject.quote(action) +
                ",\"challengeId\":" + JSONObject.quote(challenge.getString("challengeId")) +
                ",\"nonce\":" + JSONObject.quote(challenge.getString("nonce")) +
                ",\"expiresAt\":" + JSONObject.quote(challenge.getString("expiresAt")) +
                ",\"deviceId\":" + JSONObject.quote(assigned) +
                ",\"publicKeyFingerprint\":" + JSONObject.quote(fingerprint) +
                ",\"name\":" + JSONObject.quote(name) + ",\"upstream\":\"\"}";
        JSONObject request = new JSONObject().put("action", action)
                .put("challengeId", challenge.getString("challengeId"))
                .put("nonce", challenge.getString("nonce"))
                .put("expiresAt", challenge.getString("expiresAt"))
                .put("deviceId", assigned).put("publicKey", publicKey)
                .put("name", name).put("upstream", "")
                .put("signature", identity.sign(canonical));
        if ("account-bind".equals(action)) request.put("email", email).put("code", code);
        String route = switch (action) {
            case "register" -> "/__hub/register";
            case "account-bind" -> "/__hub/account/bind";
            case "account-peers" -> "/__hub/account/peers";
            default -> throw new IllegalArgumentException("不支持的设备操作。");
        };
        return post(HUB + route, request, null).getJSONObject("data");
    }

    String cloudEntry(String targetDeviceId, String pairCode) throws Exception {
        requireRegistered();
        String origin = cloudOrigin(targetDeviceId);
        JSONObject ticket;
        if (pairCode != null && !pairCode.isBlank()) {
            if (!pairCode.matches("[0-9]{6}")) throw new IllegalArgumentException("云端配对码必须是 6 位数字。");
            ticket = post(origin + "/bridge/pair-ticket", new JSONObject()
                    .put("code", pairCode).put("name", "ZSense Android")
                    .put("identityPublicKey", identity.publicPem()), deviceId()).getJSONObject("data");
        } else {
            String nonce = post(origin + "/bridge/trust-challenge", new JSONObject(), deviceId())
                    .getJSONObject("data").getString("nonce");
            if (!nonce.matches("[A-Za-z0-9_-]{24,100}")) throw new IllegalStateException("目标设备身份挑战无效。");
            ticket = post(origin + "/bridge/trust-ticket", new JSONObject(), deviceId(),
                    nonce, identity.sign(targetDeviceId + ":" + nonce)).getJSONObject("data");
        }
        String path = ticket.getString("entryPath");
        if (!path.startsWith("/bridge/enter?ticket=")) throw new IllegalStateException("目标设备返回了无效入场地址。");
        return origin + path;
    }

    String cloudTask(String targetDeviceId, String prompt) throws Exception {
        if (prompt.isBlank() || prompt.length() > 8_000) throw new IllegalArgumentException("任务内容必须在 1–8000 字之间。");
        JSONObject sent = signedBridge(targetDeviceId, "/bridge/agent-task",
                new JSONObject().put("prompt", prompt).put("timeoutMs", 300_000));
        String taskId = sent.getJSONObject("data").getString("taskId");
        if (!taskId.matches("[0-9a-fA-F-]{36}")) throw new IllegalStateException("目标设备未确认收到任务。");
        long deadline = System.currentTimeMillis() + 315_000;
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(2_000);
            JSONObject result = signedBridge(targetDeviceId, "/bridge/agent-task-result", new JSONObject().put("taskId", taskId)).getJSONObject("data");
            switch (result.optString("status")) {
                case "complete": return result.optJSONObject("result") == null ? "任务完成" : result.getJSONObject("result").optString("output", "任务完成");
                case "failed": throw new IllegalStateException(result.optString("error", "远程任务失败。"));
                case "running": break;
                default: throw new IllegalStateException("目标设备返回未知任务状态。");
            }
        }
        throw new IllegalStateException("等待超时。任务可能仍在桌面运行，请先检查运行记录，不要直接重复提交。");
    }

    private JSONObject signedBridge(String target, String route, JSONObject body) throws Exception {
        String origin = cloudOrigin(target);
        String nonce = post(origin + "/bridge/trust-challenge", new JSONObject(), deviceId()).getJSONObject("data").getString("nonce");
        String bodyText = body.toString();
        String payload = "zsense-agent-v1\nPOST\n" + route + "\n" + nonce + "\n" + bodyText;
        String digest = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(payload.getBytes(StandardCharsets.UTF_8)),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        return postRaw(origin + route, bodyText, deviceId(), nonce, identity.sign(target + ":" + digest), null);
    }

    JSONObject pairLan(String ip, int port, String credential) throws Exception {
        requireRegistered();
        if (!privateIpv4(ip) || port < 1 || port > 65535) throw new IllegalArgumentException("请输入局域网 IPv4 地址和有效端口。");
        if (!credential.matches("[0-9]{6}-[0-9A-Fa-f]{16}")) throw new IllegalArgumentException("请输入桌面显示的完整 6 位配对码-16 位身份码。");
        String fingerprintPrefix = credential.substring(7).toUpperCase(Locale.ROOT);
        byte[] random = new byte[32]; new java.security.SecureRandom().nextBytes(random);
        String sharedSecret = Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
        JSONObject descriptor = new JSONObject().put("deviceId", deviceId()).put("remoteDeviceId", deviceId())
                .put("name", "ZSense Android").put("platform", "android").put("port", 39072)
                .put("identityPublicKey", identity.publicPem());
        JSONObject response = postRaw("https://" + ip + ":" + port + "/v1/pair",
                new JSONObject().put("code", credential.substring(0, 6)).put("sharedSecret", sharedSecret)
                        .put("peer", descriptor).toString(), null, null, null, fingerprintPrefix);
        JSONObject peer = response.getJSONObject("device");
        String peerId = peer.getString("deviceId");
        JSONObject saved = new JSONObject().put("ip", ip).put("port", port)
                .put("fingerprint", response.getString("_tlsFingerprint")).put("secret", sharedSecret)
                .put("deviceId", peerId).put("remoteDeviceId", peer.optString("remoteDeviceId"))
                .put("name", peer.optString("name", peerId));
        identity.saveLanPeer(peerId, saved);
        String remoteId = peer.optString("remoteDeviceId");
        if (remoteId.matches("[a-z0-9][a-z0-9-]{1,58}")) identity.saveLanPeer(remoteId, saved);
        return peer;
    }

    JSONArray scanLan() throws Exception {
        JSONArray found = new JSONArray();
        Set<String> seen = new HashSet<>();
        JSONObject probe = new JSONObject().put("protocol", "zsense-device-link").put("version", 2)
                .put("type", "probe").put("deviceId", deviceId()).put("name", "ZSense Android")
                .put("platform", "android").put("port", 39072).put("timestamp", System.currentTimeMillis());
        byte[] bytes = probe.toString().getBytes(StandardCharsets.UTF_8);
        try (DatagramSocket socket = new DatagramSocket()) {
            socket.setBroadcast(true);
            socket.setSoTimeout(300);
            for (String address : new String[]{"239.255.90.71", "255.255.255.255"})
                socket.send(new DatagramPacket(bytes, bytes.length, InetAddress.getByName(address), 39071));
            long deadline = System.currentTimeMillis() + 2_000;
            while (System.currentTimeMillis() < deadline) {
                try {
                    byte[] buffer = new byte[2_048];
                    DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                    socket.receive(reply);
                    String ip = reply.getAddress().getHostAddress();
                    if (!privateIpv4(ip)) continue;
                    JSONObject device = new JSONObject(new String(reply.getData(), reply.getOffset(), reply.getLength(), StandardCharsets.UTF_8));
                    if (!"zsense-device-link".equals(device.optString("protocol")) || device.optInt("version") != 2 ||
                            !device.optString("deviceId").matches("[a-zA-Z0-9-]{2,100}")) continue;
                    String key = device.optString("deviceId");
                    if (seen.add(key)) found.put(new JSONObject().put("ip", ip).put("deviceId", key)
                            .put("name", device.optString("name", key)).put("port", device.optInt("port", 39072)));
                } catch (SocketTimeoutException ignored) { /* continue until scan deadline */ }
            }
        }
        return found;
    }

    String lanTask(String targetDeviceId, String prompt) throws Exception {
        JSONObject peer = identity.lanPeer(targetDeviceId);
        if (peer == null) throw new IllegalStateException("请先使用完整配对码在局域网配对。");
        JSONObject response = postRaw("https://" + peer.getString("ip") + ":" + peer.getInt("port") + "/v1/run",
                new JSONObject().put("deviceId", deviceId()).put("prompt", prompt).put("timeoutMs", 300_000).toString(),
                null, null, null, peer.getString("fingerprint"), peer.getString("secret"));
        return response.optJSONObject("result") == null ? "任务完成" : response.getJSONObject("result").optString("output", "任务完成");
    }

    void lanPing(String targetDeviceId) throws Exception {
        JSONObject peer = identity.lanPeer(targetDeviceId);
        if (peer == null) return;
        postRaw("https://" + peer.getString("ip") + ":" + peer.getInt("port") + "/v1/ping",
                new JSONObject().put("deviceId", deviceId()).toString(), null, null, null,
                peer.getString("fingerprint"), peer.getString("secret"));
    }

    boolean hasLanPeer(String targetDeviceId) throws Exception { return identity.lanPeer(targetDeviceId) != null; }
    JSONArray lanPeers() throws Exception { return identity.lanPeers(); }

    JSONObject lanEntry(String targetDeviceId) throws Exception {
        JSONObject peer = identity.lanPeer(targetDeviceId);
        if (peer == null) throw new IllegalStateException("请先在局域网完成设备配对。");
        String ip = peer.getString("ip");
        JSONObject ping;
        try {
            ping = postRaw("https://" + ip + ":" + peer.getInt("port") + "/v1/ping",
                    new JSONObject().put("deviceId", deviceId()).toString(), null, null, null,
                    peer.getString("fingerprint"), peer.getString("secret"));
        } catch (IllegalStateException denied) {
            if (denied.getMessage() == null || !denied.getMessage().contains("设备授权已失效")) throw denied;
            identity.forgetLanPeer(targetDeviceId);
            throw new IllegalStateException("设备授权已失效，请重新配对。");
        }
        JSONObject bridge = ping.optJSONObject("webBridge");
        if (bridge == null) throw new IllegalStateException("桌面端尚未开启局域网 Web 访问。");
        int port = bridge.getInt("port");
        String fingerprint = bridge.getString("fingerprint").toUpperCase(Locale.ROOT);
        if (port < 1 || port > 65535 || !fingerprint.matches("[0-9A-F]{64}"))
            throw new IllegalStateException("桌面端返回的 Web 身份信息无效。");
        String origin = "https://" + ip + ":" + port;
        String entry = origin + "/";
        try {
            String nonce = postRaw(origin + "/bridge/trust-challenge", "{}", deviceId(), null, null, fingerprint)
                    .getJSONObject("data").getString("nonce");
            if (!nonce.matches("[A-Za-z0-9_-]{24,100}")) throw new IllegalStateException("设备身份挑战无效。");
            String remoteId = ping.getJSONObject("device").optString("remoteDeviceId");
            if (!remoteId.matches("[a-z0-9][a-z0-9-]{1,58}"))
                throw new IllegalStateException("桌面设备尚未登记远程身份。");
            JSONObject ticket = postRaw(origin + "/bridge/trust-ticket", "{}", deviceId(), nonce,
                    identity.sign(remoteId + ":" + nonce), fingerprint).getJSONObject("data");
            String path = ticket.getString("entryPath");
            if (!path.startsWith("/bridge/enter?ticket=")) throw new IllegalStateException("设备返回的入场地址无效。");
            entry = origin + path;
        } catch (IllegalStateException denied) {
            // Paired LAN still supports password/access-code entry when key-based entry is unavailable.
            // The WebView must continue enforcing the same pinned Web certificate.
        }
        return new JSONObject().put("url", entry).put("fingerprint", fingerprint);
    }

    private static String cloudOrigin(String deviceId) {
        if (!deviceId.matches("[a-z0-9][a-z0-9-]{1,58}")) throw new IllegalArgumentException("设备号无效。");
        return "https://" + deviceId + ".zsense.space";
    }

    private void requireRegistered() {
        if (deviceId().isEmpty()) throw new IllegalStateException("请先登记本机设备身份。");
    }

    private static boolean privateIpv4(String input) {
        String[] parts = input.split("\\.", -1);
        if (parts.length != 4) return false;
        int[] numbers = new int[4];
        try { for (int i = 0; i < 4; i++) { numbers[i] = Integer.parseInt(parts[i]); if (numbers[i] < 0 || numbers[i] > 255 || !String.valueOf(numbers[i]).equals(parts[i])) return false; } }
        catch (NumberFormatException error) { return false; }
        return numbers[0] == 10 || (numbers[0] == 172 && numbers[1] >= 16 && numbers[1] <= 31) || (numbers[0] == 192 && numbers[1] == 168);
    }

    private static JSONObject post(String url, JSONObject body, String deviceId) throws Exception {
        return post(url, body, deviceId, null, null);
    }
    private static JSONObject post(String url, JSONObject body, String deviceId, String nonce, String signature) throws Exception {
        return postRaw(url, body.toString(), deviceId, nonce, signature, null);
    }
    private static JSONObject postRaw(String url, String body, String deviceId, String nonce, String signature, String fingerprint) throws Exception {
        return postRaw(url, body, deviceId, nonce, signature, fingerprint, null);
    }
    private static JSONObject postRaw(String url, String body, String deviceId, String nonce, String signature, String fingerprint, String bearer) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        final String[] observedFingerprint = {""};
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(url.endsWith("/v1/run") ? 315_000 : 12_000);
        connection.setRequestMethod("POST");
        connection.setRequestProperty("Content-Type", "application/json");
        if (deviceId != null) connection.setRequestProperty("x-zsense-device", deviceId);
        if (nonce != null) connection.setRequestProperty("x-zsense-nonce", nonce);
        if (signature != null) connection.setRequestProperty("x-zsense-signature", signature);
        if (bearer != null) connection.setRequestProperty("Authorization", "Bearer " + bearer);
        connection.setInstanceFollowRedirects(false);
        if (fingerprint != null) {
            if (!(connection instanceof HttpsURLConnection)) throw new IllegalStateException("局域网配对必须使用 HTTPS。");
            HttpsURLConnection secure = (HttpsURLConnection) connection;
            // The pinned certificate is checked during TLS handshake, before the pair code or task is sent.
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[]{new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                public void checkClientTrusted(X509Certificate[] chain, String authType) { throw new SecurityException("不接受客户端证书。"); }
                public void checkServerTrusted(X509Certificate[] chain, String authType) throws java.security.cert.CertificateException {
                    try {
                        if (chain == null || chain.length == 0) throw new java.security.cert.CertificateException("设备证书缺失。");
                        observedFingerprint[0] = hex(MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())).toUpperCase(Locale.ROOT);
                        if (!observedFingerprint[0].startsWith(fingerprint)) throw new java.security.cert.CertificateException("设备证书身份码不匹配。");
                    } catch (java.security.cert.CertificateException error) { throw error; }
                    catch (Exception error) { throw new java.security.cert.CertificateException(error); }
                }
            }}, new java.security.SecureRandom());
            secure.setSSLSocketFactory(context.getSocketFactory());
            secure.setHostnameVerifier((host, session) -> true); // exact cert pin replaces DNS hostname validation for private IPs
        }
        connection.setDoOutput(true);
        try {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > 64 * 1024) throw new IllegalArgumentException("请求内容过长。");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
            int status = connection.getResponseCode();
            InputStream input = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            if (input != null) try (input) {
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) { data.write(buffer, 0, count); if (data.size() > 2 * 1024 * 1024) throw new IllegalStateException("设备响应过大。"); }
            }
            JSONObject response;
            try { response = new JSONObject(data.toString(StandardCharsets.UTF_8)); }
            catch (JSONException invalidResponse) {
                throw new IllegalStateException(httpError(status));
            }
            if (status < 200 || status >= 300 || !response.optBoolean("ok", false))
                throw new IllegalStateException(response.optString("error", httpError(status)));
            if (fingerprint != null) response.put("_tlsFingerprint", observedFingerprint[0]);
            return response;
        } finally { connection.disconnect(); }
    }

    private static String httpError(int status) {
        if (status >= 200 && status < 300) return "设备返回了无效响应，请检查地址或桌面端版本。";
        return switch (status) {
            case 401, 403 -> "设备未授权或授权已失效，请检查配对状态。";
            case 404 -> "找不到该设备，请检查设备号或确认桌面端已联网。";
            case 429 -> "连接过于频繁，请稍后再试。";
            case 502, 503, 504 -> "桌面设备暂时离线或无法连接，请检查桌面端和网络。";
            default -> status >= 500 ? "连接服务暂时不可用，请稍后重试。" : "设备连接失败（HTTP " + status + "）。";
        };
    }

    private static String hex(byte[] data) {
        StringBuilder result = new StringBuilder(data.length * 2);
        for (byte item : data) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
