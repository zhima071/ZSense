package com.zsense.companion;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.WebView;
import android.widget.TextView;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Emulator-only layout check; never exported by the release application. */
public final class RemoteInsetsInstrumentation extends Instrumentation {
    private Bundle arguments;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        this.arguments = arguments;
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            if ("true".equals(arguments.getString("protocol-only", "false"))) {
                String digest = DeviceClient.fastTrustDigest("phone123", 1791468800000L,
                        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
                if (!"yUuDqKAusWtdo4vor_-FcRGJDINrZGKLXxf_dugrT0Y".equals(digest))
                    throw new AssertionError("Android and desktop fast-trust digests differ");
                result.putString("fastTrust", "ok");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("device-state-only", "false"))) {
                IdentityStore identity = new IdentityStore(getTargetContext());
                result.putString("deviceId", identity.deviceId());
                result.putBoolean("emailBound", !identity.email().isEmpty());
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("cloud-peer-store-only", "false"))) {
                IdentityStore identity = new IdentityStore(getTargetContext());
                String temporary = "test-cloud-shortcut";
                try {
                    identity.saveCloudPeer(temporary, "测试云端设备");
                    boolean saved = false;
                    org.json.JSONArray peers = identity.cloudPeers();
                    for (int index = 0; index < peers.length(); index++)
                        if (temporary.equals(peers.getJSONObject(index).optString("deviceId"))) saved = true;
                    if (!saved) throw new AssertionError("云端设备未保存");
                } finally { identity.forgetCloudPeer(temporary); }
                for (int index = 0; index < identity.cloudPeers().length(); index++)
                    if (temporary.equals(identity.cloudPeers().getJSONObject(index).optString("deviceId")))
                        throw new AssertionError("云端设备移除后仍存在");
                result.putString("cloudPeerStore", "saved-and-removed");
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("cloud-probe-only", "false"))) {
                String targetId = arguments.getString("target-id", "");
                if (!targetId.matches("[a-z0-9][a-z0-9-]{1,58}")) throw new IllegalArgumentException("目标设备号无效");
                DeviceClient client = new DeviceClient(new IdentityStore(getTargetContext()));
                long startMs = android.os.SystemClock.elapsedRealtime();
                try {
                    client.cloudEntryWithDirect(targetId, "", null);
                    result.putString("cloudProbe", "trusted");
                } catch (IllegalStateException notTrusted) {
                    if (notTrusted.getMessage() == null || !notTrusted.getMessage().contains("尚未完成密钥配对")) throw notTrusted;
                    result.putString("cloudProbe", "rejected-by-target");
                }
                result.putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - startMs);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("pair-cloud-only", "false"))) {
                String targetId = arguments.getString("target-id", "");
                String code = arguments.getString("pair-code", "");
                if (!targetId.matches("[a-z0-9][a-z0-9-]{1,58}") || !code.matches("[0-9]{6}"))
                    throw new IllegalArgumentException("目标设备号或云端配对码无效");
                long started = android.os.SystemClock.elapsedRealtime();
                org.json.JSONObject entry = new DeviceClient(new IdentityStore(getTargetContext()))
                        .cloudEntryWithDirect(targetId, code, null);
                result.putString("entryHost", android.net.Uri.parse(entry.getString("url")).getHost());
                result.putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - started);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("cloud-entry-only", "false"))) {
                Intent intent = new Intent(getTargetContext(), MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                Activity activity = startActivitySync(intent);
                waitForIdleSync();
                View root = activity.findViewById(android.R.id.content);
                TextView entry = findText(root, "连接其他账号的设备");
                if (entry == null || !entry.isShown()) throw new AssertionError("首页缺少可见的跨账号云端连接入口");
                runOnMainSync(entry::performClick);
                waitForIdleSync();
                TextView heading = findText(root, "云端连接其他设备");
                TextView submit = findText(root, "云端打开桌面");
                if (heading == null || !heading.isShown() || submit == null || !submit.isShown())
                    throw new AssertionError("点击入口后未显示设备号与配对码表单");
                result.putString("cloudEntry", "visible-and-opened");
                long holdMs = Math.max(0, Math.min(15_000, Long.parseLong(arguments.getString("hold-ms", "0"))));
                if (holdMs > 0) Thread.sleep(holdMs);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("pair-lan-only", "false"))) {
                String ip = arguments.getString("ip", "");
                String credential = arguments.getString("credential", "");
                long started = android.os.SystemClock.elapsedRealtime();
                DeviceClient client = new DeviceClient(new IdentityStore(getTargetContext()));
                org.json.JSONObject peer = client.pairLan(ip, Integer.parseInt(arguments.getString("port", "39072")), credential);
                result.putString("pairedDeviceId", peer.getString("remoteDeviceId"));
                result.putString("peerDeviceId", peer.getString("deviceId"));
                result.putString("savedPeers", lanPeerIds(client));
                result.putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - started);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("lan-entry-only", "false"))) {
                String targetId = arguments.getString("target-id", "");
                long started = android.os.SystemClock.elapsedRealtime();
                DeviceClient client = new DeviceClient(new IdentityStore(getTargetContext()));
                result.putString("savedPeers", lanPeerIds(client));
                org.json.JSONObject entry = client.lanEntry(targetId);
                result.putString("entryHost", android.net.Uri.parse(entry.getString("url")).getHost());
                result.putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - started);
                finish(Activity.RESULT_OK, result);
                return;
            }
            if ("true".equals(arguments.getString("remote-revoke-self-only", "false"))) {
                String targetId = arguments.getString("target-id", "");
                String localId = new IdentityStore(getTargetContext()).deviceId();
                if (!targetId.matches("[a-z0-9][a-z0-9-]{1,58}") || localId.isEmpty())
                    throw new IllegalArgumentException("设备号无效");
                Intent intent = new Intent(getTargetContext(), RemoteActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.putExtra("device-id", targetId);
                intent.putExtra("connect", true);
                intent.putExtra("connection-mode", "cloud");
                Activity activity = startActivitySync(intent);
                WebView web = findWebView(activity.findViewById(android.R.id.content));
                if (web == null) throw new AssertionError("远程页面未创建 WebView");
                long started = android.os.SystemClock.elapsedRealtime();
                while (android.os.SystemClock.elapsedRealtime() - started < 70_000) {
                    String state = evaluate(web, "Boolean(document.body && document.body.innerText.includes('BOT WORKSPACE'))", 1_500);
                    if ("true".equals(state)) break;
                    Thread.sleep(250);
                }
                String script = "window.__zsenseRevoke='pending';(async()=>{const r=await window.zsenseDesktop.deviceLink.status();" +
                        "if(!r?.ok)return 'status-error';" +
                        "const matches=(r.data?.trustedPeers||[]).filter(p=>p.remoteDeviceId===" + org.json.JSONObject.quote(localId) +
                        "||p.deviceId===" + org.json.JSONObject.quote(localId) + ");" +
                        "if(matches.length!==1)return 'match-count:'+matches.length;" +
                        "if(matches[0].access?.allowTasks)return 'unexpected-task-permission';" +
                        "const result=await window.zsenseDesktop.deviceLink.unpair(matches[0].deviceId);" +
                        "return result?.ok?'revoked':'revoke-error';})().then(v=>window.__zsenseRevoke=v).catch(e=>window.__zsenseRevoke='exception');'started'";
                evaluate(web, script, 2_000);
                String outcome = "pending";
                long revokeStarted = android.os.SystemClock.elapsedRealtime();
                while ("pending".equals(outcome) && android.os.SystemClock.elapsedRealtime() - revokeStarted < 20_000) {
                    outcome = evaluate(web, "window.__zsenseRevoke || 'pending'", 2_000);
                    if ("pending".equals(outcome)) Thread.sleep(200);
                }
                result.putString("revokeResult", outcome);
                if (!"revoked".equals(outcome)) throw new AssertionError("未确认撤销模拟器授权");
                finish(Activity.RESULT_OK, result);
                return;
            }
            boolean timedCloud = "true".equals(arguments.getString("timed-cloud-open", "false"));
            boolean timedLan = "true".equals(arguments.getString("timed-lan-open", "false"));
            if (timedCloud || timedLan) {
                String targetId = arguments.getString("target-id", "");
                if (!targetId.matches("[a-z0-9][a-z0-9-]{1,58}")) throw new IllegalArgumentException("目标设备号无效");
                long started = android.os.SystemClock.elapsedRealtime();
                Intent intent = new Intent(getTargetContext(), RemoteActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                intent.putExtra("device-id", targetId);
                intent.putExtra("connect", true);
                intent.putExtra("connection-mode", timedLan ? "lan" : "cloud");
                Activity activity = startActivitySync(intent);
                waitForIdleSync();
                WebView web = findWebView(activity.findViewById(android.R.id.content));
                if (web == null) throw new AssertionError("远程页面未创建 WebView");
                boolean ready = false;
                String observedHost = "";
                String observedUrl = "";
                String observedValue = "";
                long entryMs = -1;
                long pageMs = -1;
                while (android.os.SystemClock.elapsedRealtime() - started < 75_000) {
                    CountDownLatch response = new CountDownLatch(1);
                    AtomicReference<String> value = new AtomicReference<>("false");
                    AtomicReference<String> url = new AtomicReference<>("");
                    int[] webVisibility = {View.INVISIBLE};
                    runOnMainSync(() -> {
                        url.set(web.getUrl() == null ? "" : web.getUrl());
                        webVisibility[0] = web.getVisibility();
                        web.evaluateJavascript("Boolean(document.body && document.body.innerText.includes('BOT WORKSPACE'))",
                                answer -> { value.set(answer); response.countDown(); });
                    });
                    response.await(750, TimeUnit.MILLISECONDS);
                    observedUrl = url.get();
                    observedValue = value.get();
                    if (entryMs < 0 && observedUrl.startsWith("https://")) entryMs = android.os.SystemClock.elapsedRealtime() - started;
                    if (pageMs < 0 && webVisibility[0] == View.VISIBLE) pageMs = android.os.SystemClock.elapsedRealtime() - started;
                    android.view.accessibility.AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
                    boolean visible = root != null && !root.findAccessibilityNodeInfosByText("BOT WORKSPACE").isEmpty();
                    if ("true".equals(observedValue) || visible) {
                        ready = true;
                        observedHost = android.net.Uri.parse(observedUrl).getHost();
                        break;
                    }
                    Thread.sleep(200);
                }
                result.putLong("elapsedMs", android.os.SystemClock.elapsedRealtime() - started);
                result.putLong("entryMs", entryMs);
                result.putLong("pageMs", pageMs);
                result.putString("host", observedHost);
                result.putString("lastUrl", observedUrl.replaceFirst("\\?.*$", ""));
                result.putString("lastDomValue", observedValue);
                if (!ready) result.putString("visibleText", allText(activity.findViewById(android.R.id.content)));
                String expectedHost = timedLan ? arguments.getString("ip", "") : targetId + ".zsense.space";
                if (!ready || !expectedHost.equals(observedHost))
                    throw new AssertionError("工作区未在 75 秒内完成，或连接地址与指定通道不符");
                result.putString(timedLan ? "lanWorkspace" : "cloudWorkspace", "interactive");
                finish(Activity.RESULT_OK, result);
                return;
            }
            String url = arguments.getString("url", "");
            String pin = arguments.getString("pin", "");
            if (url.isEmpty() || pin.isEmpty()) throw new IllegalArgumentException("缺少预览网址或证书指纹。");
            Intent intent = new Intent(getTargetContext(), RemoteActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.putExtra("device-id", "preview-device");
            intent.putExtra("url", url);
            intent.putExtra("tls-fingerprint", pin);
            Activity activity = startActivitySync(intent);
            waitForIdleSync();
            View frame = activity.findViewById(android.R.id.content);
            View preview = frame instanceof android.view.ViewGroup ? ((android.view.ViewGroup) frame).getChildAt(0) : null;
            WindowInsets insets = preview == null ? null : preview.getRootWindowInsets();
            int systemTop = insets == null ? 0 : insets.getInsets(WindowInsets.Type.statusBars()).top;
            int appliedTop = preview == null ? 0 : preview.getPaddingTop();
            result.putInt("statusBarTop", systemTop);
            result.putInt("webContentTop", appliedTop);
            if (systemTop <= 0 || appliedTop < systemTop) throw new AssertionError("远程页面仍被状态栏覆盖。");
            // Keep the preview available for manual button/keyboard checks when requested.
            long holdMs = Math.max(1_000, Math.min(120_000, Long.parseLong(arguments.getString("hold-ms", "25000"))));
            Thread.sleep(holdMs);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("error", error.toString());
            finish(Activity.RESULT_CANCELED, result);
        }
    }

    private static TextView findText(View root, String text) {
        if (root instanceof TextView label && label.getText().toString().contains(text)) return label;
        if (root instanceof ViewGroup group) for (int index = 0; index < group.getChildCount(); index++) {
            TextView found = findText(group.getChildAt(index), text);
            if (found != null) return found;
        }
        return null;
    }

    private static WebView findWebView(View root) {
        if (root instanceof WebView web) return web;
        if (root instanceof ViewGroup group) for (int index = 0; index < group.getChildCount(); index++) {
            WebView found = findWebView(group.getChildAt(index));
            if (found != null) return found;
        }
        return null;
    }

    private static String allText(View root) {
        StringBuilder result = new StringBuilder();
        collectText(root, result);
        return result.toString();
    }

    private static void collectText(View root, StringBuilder result) {
        if (root instanceof TextView label && label.isShown()) result.append(label.getText()).append(" | ");
        if (root instanceof ViewGroup group) for (int index = 0; index < group.getChildCount(); index++)
            collectText(group.getChildAt(index), result);
    }

    private static String lanPeerIds(DeviceClient client) throws Exception {
        org.json.JSONArray peers = client.lanPeers();
        StringBuilder ids = new StringBuilder();
        for (int index = 0; index < peers.length(); index++) {
            if (index > 0) ids.append(',');
            ids.append(peers.getJSONObject(index).optString("remoteDeviceId"));
        }
        return ids.toString();
    }

    private String evaluate(WebView web, String script, long timeoutMs) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>("");
        runOnMainSync(() -> web.evaluateJavascript(script, answer -> {
            value.set(answer);
            latch.countDown();
        }));
        if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) throw new AssertionError("远程页面调用超时");
        String raw = value.get();
        if (raw == null || "null".equals(raw)) return "";
        return new org.json.JSONArray("[" + raw + "]").optString(0, "");
    }
}
