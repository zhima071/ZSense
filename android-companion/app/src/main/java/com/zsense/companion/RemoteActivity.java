package com.zsense.companion;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.graphics.Color;
import android.graphics.Insets;
import android.view.WindowInsets;
import android.webkit.SslErrorHandler;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Button;
import android.widget.Toast;
import android.view.View;
import android.view.WindowManager;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.SocketTimeoutException;
import java.security.MessageDigest;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Displays only the authenticated desktop Web Bridge origin. */
public final class RemoteActivity extends Activity {
    private static final int FILE_PICKER_REQUEST = 4107;
    private final ExecutorService connector = Executors.newSingleThreadExecutor();
    private final ExecutorService heartbeatWorker = Executors.newSingleThreadExecutor();
    private final Handler heartbeat = new Handler(Looper.getMainLooper());
    private final Runnable heartbeatAction = new Runnable() {
        @Override public void run() {
            DeviceClient active = deviceClient;
            String id = getIntent().getStringExtra("device-id");
            if (active != null && id != null && !destroyed) heartbeatWorker.execute(() -> {
                try { active.lanPing(id); } catch (Exception ignored) { /* cloud-only and offline peers are expected */ }
            });
            heartbeat.postDelayed(this, 15_000);
        }
    };
    private volatile DeviceClient deviceClient;
    private FrameLayout frame;
    private WebView web;
    private LinearLayout loading;
    private TextView message;
    private Button retry;
    private ProgressBar spinner;
    private String trustedHost;
    private int trustedPort;
    private String pin;
    private boolean lan;
    private boolean destroyed;
    private boolean pageLoadFailed;
    private ValueCallback<Uri[]> pendingFiles;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.WHITE);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            // Android 15 edge-to-edge requires applying IME insets ourselves: otherwise
            // the WebView composer stays behind the on-screen keyboard.
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsets.Type.ime());
            frame.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            return WindowInsets.CONSUMED;
        });
        web = new WebView(this);
        web.setVisibility(View.INVISIBLE);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setSupportMultipleWindows(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                if (!isUserGesture) return false;
                WebView popup = new WebView(RemoteActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public void onPageStarted(WebView child, String url, android.graphics.Bitmap favicon) {
                        if ("about:blank".equals(url)) return;
                        Uri uri = Uri.parse(url);
                        if ("https".equals(uri.getScheme()) && trustedHost != null &&
                                trustedHost.equals(uri.getHost()) && trustedPort == uri.getPort()) web.loadUrl(url);
                        else if ("https".equals(uri.getScheme())) {
                            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                            catch (ActivityNotFoundException error) {
                                Toast.makeText(RemoteActivity.this, "没有可打开此链接的浏览器。", Toast.LENGTH_LONG).show();
                            }
                        }
                        child.post(() -> { child.stopLoading(); child.destroy(); });
                    }
                });
                ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingFiles != null) pendingFiles.onReceiveValue(null);
                pendingFiles = callback;
                try {
                    Intent picker = params.createIntent();
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(picker, FILE_PICKER_REQUEST);
                } catch (ActivityNotFoundException | SecurityException error) {
                    pendingFiles = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(RemoteActivity.this, "无法打开系统文件选择器。", Toast.LENGTH_LONG).show();
                }
                return true;
            }
        });
        web.addOnLayoutChangeListener((view, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (bottom - top != oldBottom - oldTop) updateWebViewportHeight();
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onPageFinished(WebView view, String url) {
                Uri finished = Uri.parse(url);
                if (!pageLoadFailed && "https".equals(finished.getScheme()) && trustedHost != null &&
                        trustedHost.equals(finished.getHost()) && trustedPort == finished.getPort()) {
                    updateWebViewportHeight();
                    web.setVisibility(View.VISIBLE);
                    loading.setVisibility(View.GONE);
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showFailure("远程页面加载失败，请检查连接后重试。", true);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && trustedHost != null && trustedHost.equals(uri.getHost()) && uri.getPort() == trustedPort) return false;
                if (request.isForMainFrame() && "https".equals(uri.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
                    catch (ActivityNotFoundException error) {
                        Toast.makeText(RemoteActivity.this, "没有可打开此链接的浏览器。", Toast.LENGTH_LONG).show();
                    }
                }
                return true;
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                Uri failedUri = error.getUrl() == null ? null : Uri.parse(error.getUrl());
                if (!lan || failedUri == null || !"https".equals(failedUri.getScheme()) ||
                        trustedHost == null || !trustedHost.equals(failedUri.getHost()) || failedUri.getPort() != trustedPort) {
                    handler.cancel();
                    if (failedUri != null && trustedHost != null && trustedHost.equals(failedUri.getHost()))
                        showFailure("设备证书验证失败。", true);
                    return;
                }
                try {
                    byte[] der = SslCertificate.saveState(error.getCertificate()).getByteArray("x509-certificate");
                    if (der == null) throw new IllegalStateException("缺少证书数据");
                    X509Certificate certificate = (X509Certificate) CertificateFactory.getInstance("X.509")
                            .generateCertificate(new ByteArrayInputStream(der));
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(certificate.getEncoded());
                    StringBuilder actual = new StringBuilder(64);
                    for (byte item : digest) actual.append(String.format(Locale.ROOT, "%02X", item & 0xff));
                    if (pin.equals(actual.toString())) { handler.proceed(); return; }
                } catch (Exception ignored) { /* fail closed */ }
                handler.cancel(); showFailure("设备证书与已配对身份不一致。", true);
            }
        });
        frame.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new LinearLayout(this);
        loading.setOrientation(LinearLayout.VERTICAL);
        loading.setGravity(android.view.Gravity.CENTER);
        loading.setPadding(dp(24), dp(24), dp(24), dp(24));
        loading.setBackgroundColor(Color.WHITE);
        spinner = new ProgressBar(this);
        loading.addView(spinner, new LinearLayout.LayoutParams(dp(32), dp(32)));
        message = new TextView(this);
        message.setText("正在安全连接设备…");
        message.setTextColor(Color.rgb(30, 41, 59));
        message.setTextSize(16);
        message.setGravity(android.view.Gravity.CENTER);
        LinearLayout.LayoutParams messageParams = new LinearLayout.LayoutParams(-1, -2);
        messageParams.topMargin = dp(18);
        loading.addView(message, messageParams);
        retry = new Button(this);
        retry.setText("重试连接");
        retry.setBackgroundTintList(ColorStateList.valueOf(Color.rgb(37, 99, 235)));
        retry.setTextColor(Color.WHITE);
        retry.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        retry.setOnClickListener(view -> connect());
        LinearLayout.LayoutParams retryParams = new LinearLayout.LayoutParams(-2, -2);
        retryParams.topMargin = dp(14);
        loading.addView(retry, retryParams);
        frame.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        setContentView(frame);
        getWindow().getInsetsController().setSystemBarsAppearance(
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        frame.requestApplyInsets();
        connect();
    }

    private void connect() {
        retry.setVisibility(View.GONE);
        spinner.setVisibility(View.VISIBLE);
        loading.setVisibility(View.VISIBLE);
        web.setVisibility(View.INVISIBLE);
        pageLoadFailed = false;
        message.setText("正在安全连接设备…");
        String id = getIntent().getStringExtra("device-id");
        if (getIntent().getBooleanExtra("connect", false)) {
            connector.execute(() -> {
                try {
                    DeviceClient client = new DeviceClient(new IdentityStore(getApplicationContext()));
                    deviceClient = client;
                    String entry;
                    String fingerprint = null;
                    String trustedKey = getIntent().getStringExtra("identity-public-key");
                    String mode = getIntent().getStringExtra("connection-mode");
                    if ("lan".equals(mode)) {
                        runOnUiThread(() -> message.setText("正在验证局域网设备…"));
                        JSONObject direct = null;
                        if (client.hasLanPeer(id)) {
                            try { direct = client.lanEntry(id); }
                            catch (ConnectException | NoRouteToHostException | SocketTimeoutException unavailable) {
                                // A saved address can be stale; try fresh LAN discovery only.
                                if (trustedKey == null || trustedKey.isEmpty()) throw unavailable;
                            }
                        }
                        if (direct == null && trustedKey != null && !trustedKey.isEmpty())
                            direct = client.sameAccountLanEntry(id, trustedKey);
                        if (direct == null) throw new IllegalStateException("未找到可验证的局域网连接。请确认两台设备在同一网络，或返回选择云端连接。");
                        entry = direct.getString("url");
                        fingerprint = direct.getString("fingerprint");
                    } else if ("cloud".equals(mode)) {
                        runOnUiThread(() -> message.setText("正在验证云端设备…"));
                        // Explicit cloud choice must not silently switch to LAN/P2P.
                        JSONObject cloud = client.cloudEntryWithDirect(id, getIntent().getStringExtra("pair-code"), null);
                        entry = cloud.getString("url");
                    } else throw new IllegalArgumentException("请选择云端或局域网连接方式。");
                    String finalEntry = entry;
                    String finalFingerprint = fingerprint;
                    runOnUiThread(() -> { if (!destroyed) loadEntry(id, finalEntry, finalFingerprint); });
                } catch (Exception error) {
                    runOnUiThread(() -> { if (!destroyed) showFailure(error.getMessage(), true); });
                }
            });
        } else loadEntry(id, getIntent().getStringExtra("url"), getIntent().getStringExtra("tls-fingerprint"));
    }

    private void loadEntry(String id, String entry, String certificatePin) {
        Uri entryUri = entry == null ? null : Uri.parse(entry);
        boolean cloud = id != null && id.matches("[a-z0-9][a-z0-9-]{1,58}") && entryUri != null &&
                (id + ".zsense.space").equals(entryUri.getHost()) && certificatePin == null;
        boolean isPinnedDirect = id != null && id.matches("[a-z0-9][a-z0-9-]{1,58}") && entryUri != null &&
                (privateIpv4(entryUri.getHost()) || DeviceClient.globalIpv6(entryUri.getHost())) &&
                entryUri.getPort() > 0 && certificatePin != null && certificatePin.matches("[0-9A-F]{64}");
        boolean ticketEntry = entryUri != null && "/bridge/enter".equals(entryUri.getPath()) && entryUri.getQueryParameterNames().contains("ticket");
        if ((!cloud && !isPinnedDirect) || entryUri == null || !"https".equals(entryUri.getScheme()) ||
                !(ticketEntry || (isPinnedDirect && "/".equals(entryUri.getPath())))) {
            showFailure("设备返回的远程地址无效。", true); return;
        }
        trustedHost = entryUri.getHost();
        trustedPort = entryUri.getPort();
        pin = certificatePin;
        lan = isPinnedDirect;
        message.setText("正在加载远程工作区…");
        web.loadUrl(entry);
    }

    private void showFailure(String error, boolean canRetry) {
        pageLoadFailed = true;
        spinner.setVisibility(View.GONE);
        web.setVisibility(View.INVISIBLE);
        loading.setVisibility(View.VISIBLE);
        message.setText(error == null || error.isBlank() ? "无法连接设备，请稍后重试。" : error);
        retry.setVisibility(canRetry ? View.VISIBLE : View.GONE);
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != FILE_PICKER_REQUEST || pendingFiles == null) return;
        ValueCallback<Uri[]> callback = pendingFiles;
        pendingFiles = null;
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
    }

    @Override public void onBackPressed() {
        android.webkit.WebBackForwardList history = web.copyBackForwardList();
        android.webkit.WebHistoryItem previousItem = history.getCurrentIndex() > 0 ? history.getItemAtIndex(history.getCurrentIndex() - 1) : null;
        String previous = previousItem == null ? "" : previousItem.getUrl();
        Uri previousUri = previous.isEmpty() ? null : Uri.parse(previous);
        if (loading.getVisibility() != View.VISIBLE && web.canGoBack() && previousUri != null &&
                "https".equals(previousUri.getScheme()) && trustedHost != null &&
                trustedHost.equals(previousUri.getHost()) && trustedPort == previousUri.getPort() &&
                !"/bridge/enter".equals(previousUri.getPath())) web.goBack();
        else super.onBackPressed();
    }

    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }

    private void updateWebViewportHeight() {
        if (web.getHeight() <= 0 || destroyed) return;
        float cssPixels = web.getHeight() / getResources().getDisplayMetrics().density;
        web.evaluateJavascript("document.documentElement.style.setProperty('--zsense-remote-viewport-height','" + cssPixels + "px')", null);
    }

    @Override protected void onDestroy() {
        destroyed = true;
        heartbeat.removeCallbacks(heartbeatAction);
        heartbeatWorker.shutdownNow();
        connector.shutdownNow();
        if (pendingFiles != null) { pendingFiles.onReceiveValue(null); pendingFiles = null; }
        web.destroy();
        super.onDestroy();
    }

    @Override protected void onResume() {
        super.onResume();
        heartbeat.removeCallbacks(heartbeatAction);
        heartbeat.postDelayed(heartbeatAction, 15_000);
    }

    @Override protected void onPause() {
        heartbeat.removeCallbacks(heartbeatAction);
        super.onPause();
    }

    private static boolean privateIpv4(String ip) {
        if (ip == null || !ip.matches("[0-9]{1,3}(\\.[0-9]{1,3}){3}")) return false;
        String[] parts = ip.split("\\.");
        int a = Integer.parseInt(parts[0]), b = Integer.parseInt(parts[1]);
        for (String part : parts) if (Integer.parseInt(part) > 255) return false;
        return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168);
    }
}
