package com.zsense.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.text.InputType;
import android.util.Log;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.view.Gravity;

import java.util.concurrent.atomic.AtomicBoolean;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;

/** Companion UI: mailbox proof, same-account peers, cloud/LAN entry and remote tasks. */
public final class MainActivity extends Activity {
    private static final String TAG = "ZSenseCompanion";
    private static final int INK = Color.rgb(15, 23, 42);
    private static final int MUTED = Color.rgb(71, 85, 105);
    private static final int BLUE = Color.rgb(37, 99, 235);
    private static final int BORDER = Color.rgb(226, 232, 240);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService taskWorker = Executors.newSingleThreadExecutor();
    private final ExecutorService heartbeatWorker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean operationBusy = new AtomicBoolean();
    private final AtomicBoolean taskBusy = new AtomicBoolean();
    private final Handler heartbeat = new Handler(Looper.getMainLooper());
    private final Handler notices = new Handler(Looper.getMainLooper());
    private final Runnable heartbeatAction = new Runnable() {
        @Override public void run() {
            // Remote Agent calls can run for minutes; keep LAN presence independent of that queue.
            if (client != null && target != null) heartbeatWorker.execute(() -> {
                try { client.lanPing(value(target)); } catch (Exception ignored) { /* normal when peer is cloud-only or offline */ }
            });
            heartbeat.postDelayed(this, 15_000);
        }
    };
    private DeviceClient client;
    private IdentityStore identity;
    private JSONArray cachedCloudPeers = new JSONArray();
    private TextView status;
    private TextView notice;
    private final Runnable hideNotice = () -> { if (notice != null) notice.setVisibility(View.GONE); };
    private TextView deviceLabel;
    private TextView deviceCount;
    private LinearLayout deviceList;
    private LinearLayout accountCard;
    private LinearLayout lanCard;
    private LinearLayout advancedCard;
    private TextView advancedToggle;
    private TextView emailOptionStatus;
    private EditText email;
    private EditText code;
    private EditText target;
    private EditText pairCode;
    private EditText lanIp;
    private EditText lanPort;
    private EditText lanCredential;
    private EditText task;
    private TextView result;
    private ScrollView scroller;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        scroller = new ScrollView(this);
        scroller.setFillViewport(true);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(18);
        content.setPadding(pad, dp(14), pad, dp(28));
        content.setBackgroundColor(Color.WHITE);
        scroller.addView(content);
        FrameLayout root = new FrameLayout(this);
        root.addView(scroller, new FrameLayout.LayoutParams(-1, -1));
        notice = text("", 13, Color.WHITE, false);
        notice.setPadding(dp(16), dp(12), dp(16), dp(12));
        notice.setBackground(round(Color.rgb(22, 43, 77), 10, 0));
        notice.setVisibility(View.GONE);
        notice.setElevation(dp(8));
        notice.setOnClickListener(view -> notice.setVisibility(View.GONE));
        FrameLayout.LayoutParams noticeParams = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        noticeParams.setMargins(dp(18), 0, dp(18), dp(18));
        root.addView(notice, noticeParams);
        setContentView(root);
        scroller.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            int keyboardBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
            // Keep the scrolling viewport below system bars. Padding the child instead lets
            // its content slide behind the status bar as soon as a connection form opens.
            scroller.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboardBottom));
            FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) notice.getLayoutParams();
            params.bottomMargin = Math.max(bars.bottom, keyboardBottom) + dp(18);
            notice.setLayoutParams(params);
            if (keyboardBottom > 0) scroller.post(() -> {
                View focused = getCurrentFocus();
                if (focused == null) return;
                android.view.ViewParent parent = focused.getParent();
                while (parent != null && parent != scroller) parent = parent.getParent();
                if (parent != scroller) return;
                Rect area = new Rect();
                focused.getDrawingRect(area);
                scroller.offsetDescendantRectToMyCoords(focused, area);
                int visibleBottom = scroller.getHeight() - keyboardBottom - dp(12);
                if (area.bottom > visibleBottom) scroller.smoothScrollBy(0, area.bottom - visibleBottom);
            });
            return insets;
        });
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getInsetsController().setSystemBarsAppearance(
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS |
                        android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.mipmap.zsense_launcher);
        header.addView(logo, new LinearLayout.LayoutParams(dp(42), dp(42)));
        LinearLayout headerCopy = new LinearLayout(this);
        headerCopy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1);
        copyParams.leftMargin = dp(11);
        header.addView(headerCopy, copyParams);
        TextView brand = text("ZSense", 20, INK, true);
        headerCopy.addView(brand);
        headerCopy.addView(text("设备互联", 12, MUTED, false));
        TextView headerAction = text("刷新  ↻", 12, BLUE, true);
        headerAction.setPadding(dp(10), dp(8), dp(10), dp(8));
        headerAction.setBackground(round(Color.rgb(239, 246, 255), 9, 0));
        headerAction.setOnClickListener(view -> perform("正在查询设备…", this::refreshPeers));
        headerAction.setContentDescription("刷新设备列表");
        header.addView(headerAction);
        content.addView(header);

        FrameLayout hero = new FrameLayout(this);
        GradientDrawable heroBackground = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR,
                new int[]{Color.rgb(13, 27, 60), Color.rgb(23, 58, 119), Color.rgb(28, 86, 184)});
        heroBackground.setCornerRadius(dp(18));
        hero.setBackground(heroBackground);
        hero.setClipToOutline(true);
        int baseHeroHeight = getResources().getConfiguration().screenWidthDp <= 320 ? 190 : 210;
        int heroHeight = Math.max(baseHeroHeight, Math.round(baseHeroHeight * getResources().getConfiguration().fontScale));
        LinearLayout.LayoutParams heroParams = new LinearLayout.LayoutParams(-1, dp(heroHeight));
        heroParams.topMargin = dp(22);
        content.addView(hero, heroParams);
        hero.addView(new NetworkArtView(this), new FrameLayout.LayoutParams(-1, -1));
        LinearLayout heroCopy = new LinearLayout(this);
        heroCopy.setOrientation(LinearLayout.VERTICAL);
        heroCopy.setPadding(dp(21), dp(20), dp(21), dp(17));
        hero.addView(heroCopy, new FrameLayout.LayoutParams(-1, -1));
        TextView eyebrow = text("ZSENSE · REMOTE", 10, Color.rgb(172, 203, 255), true);
        eyebrow.setLetterSpacing(.15f);
        heroCopy.addView(eyebrow);
        TextView title = text("桌面工作区\n随身可达", 24, Color.WHITE, true);
        title.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(10);
        heroCopy.addView(title, titleParams);
        TextView intro = text("安全连接 · 即开即用", 12, Color.rgb(213, 227, 255), false);
        LinearLayout.LayoutParams introParams = new LinearLayout.LayoutParams(-1, -2);
        introParams.topMargin = dp(6);
        heroCopy.addView(intro, introParams);
        View spacer = new View(this);
        heroCopy.addView(spacer, new LinearLayout.LayoutParams(1, 0, 1));
        LinearLayout statusPill = new LinearLayout(this);
        statusPill.setOrientation(LinearLayout.HORIZONTAL);
        statusPill.setGravity(android.view.Gravity.CENTER_VERTICAL);
        statusPill.setPadding(dp(10), dp(8), dp(11), dp(8));
        statusPill.setBackground(round(Color.argb(53, 255, 255, 255), 8, 0));
        TextView statusDot = text("●", 8, Color.rgb(117, 219, 255), true);
        LinearLayout.LayoutParams dotParams = new LinearLayout.LayoutParams(-2, -2);
        dotParams.rightMargin = dp(7);
        statusPill.addView(statusDot, dotParams);
        status = text("正在准备连接…", 11, Color.rgb(220, 234, 255), false);
        status.setMaxLines(2);
        status.setEllipsize(android.text.TextUtils.TruncateAt.END);
        statusPill.addView(status);
        heroCopy.addView(statusPill);

        LinearLayout peersCard = card(content);
        LinearLayout deviceHeading = new LinearLayout(this);
        deviceHeading.setOrientation(LinearLayout.HORIZONTAL);
        deviceHeading.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView devicesTitle = text("我的设备", 18, INK, true);
        deviceHeading.addView(devicesTitle, new LinearLayout.LayoutParams(0, -2, 1));
        deviceCount = text("0 台", 12, MUTED, false);
        deviceHeading.addView(deviceCount);
        peersCard.addView(deviceHeading);
        deviceList = new LinearLayout(this);
        deviceList.setOrientation(LinearLayout.VERTICAL);
        deviceList.addView(text("正在读取设备…", 12, MUTED, false));
        LinearLayout.LayoutParams listParams = new LinearLayout.LayoutParams(-1, -2);
        listParams.topMargin = dp(12);
        peersCard.addView(deviceList, listParams);

        LinearLayout connectHeading = new LinearLayout(this);
        connectHeading.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams connectHeadingParams = new LinearLayout.LayoutParams(-1, -2);
        connectHeadingParams.topMargin = dp(24);
        content.addView(connectHeading, connectHeadingParams);
        connectHeading.addView(text("添加设备", 18, INK, true));
        TextView connectHint = text("选择一种方式，连接你的桌面工作区", 12, MUTED, false);
        LinearLayout.LayoutParams connectHintParams = new LinearLayout.LayoutParams(-1, -2);
        connectHintParams.topMargin = dp(4);
        connectHeading.addView(connectHint, connectHintParams);
        LinearLayout methods = new LinearLayout(this);
        methods.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams methodsParams = new LinearLayout.LayoutParams(-1, -2);
        methodsParams.topMargin = dp(11);
        content.addView(methods, methodsParams);
        emailOptionStatus = text("验证邮箱后自动发现", 11, MUTED, false);
        connectionTile(methods, "@", "邮箱发现", emailOptionStatus, () -> {
            accountCard.setVisibility(View.VISIBLE);
            lanCard.setVisibility(View.GONE);
            selectConnectionTile(methods, 0);
            scroller.post(() -> scroller.smoothScrollTo(0, accountCard.getTop()));
        }, true);
        connectionTile(methods, "⌁", "局域网配对", text("附近设备直接连接", 11, MUTED, false), () -> {
            lanCard.setVisibility(View.VISIBLE);
            accountCard.setVisibility(View.GONE);
            selectConnectionTile(methods, 1);
            scroller.post(() -> scroller.smoothScrollTo(0, lanCard.getTop()));
        }, false);

        accountCard = card(content);
        accountCard.setVisibility(View.GONE);
        section(accountCard, "邮箱发现");
        accountCard.addView(text("同邮箱设备会出现在首页；首次访问仍需设备配对。", 12, MUTED, false));
        email = field(accountCard, "邮箱地址", false);
        email.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        code = field(accountCard, "邮箱验证码", false);
        code.setInputType(InputType.TYPE_CLASS_NUMBER);
        addButton(accountCard, "发送验证码", () -> {
            if (!validEmail(email)) return;
            String requestedEmail = value(email);
            perform("正在发送验证码…", () -> {
                JSONObject data = client.sendCode(requestedEmail);
                show("验证码已发送至 " + data.optString("masked") + "。请查看邮箱。");
            });
        });
        addButton(accountCard, "验证并绑定邮箱", () -> {
            if (!validEmail(email) || !requireField(code, "请输入邮箱验证码。")) return;
            String requestedEmail = value(email), requestedCode = value(code);
            perform("正在验证邮箱…", () -> {
                client.bindEmail(requestedEmail, requestedCode);
                cachedCloudPeers = new JSONArray();
                show("邮箱验证成功。现在可查看同账号设备。");
                runOnUiThread(() -> {
                    accountCard.setVisibility(View.GONE);
                    emailOptionStatus.setText("已绑定 " + identity.email());
                    scroller.smoothScrollTo(0, 0);
                });
                refreshPeers();
            });
        });

        lanCard = card(content);
        lanCard.setVisibility(View.GONE);
        section(lanCard, "局域网配对");
        lanCard.addView(text("确保手机和桌面在同一网络，再输入桌面显示的完整配对码。", 12, MUTED, false));

        LinearLayout advanced = card(content);
        advancedCard = advanced;
        advanced.setVisibility(View.GONE);
        TextView more = text("手动连接、远程任务与本机设置  →", 12, MUTED, false);
        advancedToggle = more;
        more.setPadding(dp(4), dp(19), dp(4), dp(8));
        more.setOnClickListener(view -> {
            boolean expand = advanced.getVisibility() != View.VISIBLE;
            advanced.setVisibility(expand ? View.VISIBLE : View.GONE);
            more.setText(expand ? "收起手动连接与设置  ↑" : "手动连接、远程任务与本机设置  →");
            more.setContentDescription(expand ? "收起手动连接、远程任务与本机设置" : "展开手动连接、远程任务与本机设置");
            if (expand) scroller.post(() -> scroller.smoothScrollTo(0, advanced.getTop()));
        });
        more.setFocusable(true);
        more.setContentDescription("展开手动连接、远程任务与本机设置");
        content.addView(more);
        content.removeView(advanced);
        content.addView(advanced);
        section(advanced, "本机设备");
        deviceLabel = text("设备号：准备中", 12, MUTED, false);
        advanced.addView(deviceLabel);
        addButton(advanced, "重新登记设备身份", () -> perform("正在向交换中心登记…", () -> {
            JSONObject data = client.register();
            show("本机设备号：" + data.getString("deviceId"));
            runOnUiThread(() -> deviceLabel.setText("设备号：" + client.deviceId()));
        }));
        addButton(advanced, "更换绑定邮箱", () -> {
            accountCard.setVisibility(View.VISIBLE);
            scroller.post(() -> scroller.smoothScrollTo(0, accountCard.getTop()));
        });
        section(advanced, "手动连接");
        target = field(advanced, "设备号", false);
        pairCode = field(advanced, "不同邮箱首次云端配对：6 位配对码；同邮箱留空", false);
        addButton(advanced, "云端打开桌面", () -> {
            if (!requireField(target, "请输入目标设备号。")) return;
            openRemote(value(target), value(pairCode), false);
        });
        lanIp = field(lanCard, "局域网 IPv4 地址（例 192.168.1.10）", false);
        lanIp.setInputType(InputType.TYPE_CLASS_PHONE);
        TextView portLabel = text("连接端口", 12, MUTED, false);
        LinearLayout.LayoutParams portLabelParams = new LinearLayout.LayoutParams(-1, -2);
        portLabelParams.topMargin = dp(10);
        lanCard.addView(portLabel, portLabelParams);
        lanPort = field(lanCard, "连接端口", false);
        lanPort.setInputType(InputType.TYPE_CLASS_NUMBER);
        lanPort.setText("39072");
        lanCredential = field(lanCard, "完整配对码：123456-0123456789ABCDEF", false);
        LinearLayout lanList = new LinearLayout(this);
        lanList.setOrientation(LinearLayout.VERTICAL);
        addButton(lanCard, "扫描局域网设备", () -> perform("正在扫描局域网…", () -> {
            JSONArray devices = client.scanLan();
            runOnUiThread(() -> {
                lanList.removeAllViews();
                if (devices.length() == 0) lanList.addView(label("未发现设备，可手动输入桌面的局域网 IP。", 14));
                for (int i = 0; i < devices.length(); i++) {
                    JSONObject item = devices.optJSONObject(i);
                    if (item == null) continue;
                    String ip = item.optString("ip");
                    int port = item.optInt("port", 39072);
                    addButton(lanList, item.optString("name") + " · " + ip + ":" + port, () -> {
                        lanIp.setText(ip);
                        lanPort.setText(String.valueOf(port));
                        show("已选局域网设备。请输入桌面显示的完整配对码后连接。");
                    });
                }
            });
            show(devices.length() == 0 ? "未发现局域网设备，可手动输入桌面的局域网 IP。" :
                    "局域网发现 " + devices.length() + " 台设备。选择后输入完整配对码。");
        }));
        lanCard.addView(lanList);
        addButton(lanCard, "完成局域网配对", () -> {
            if (!requireField(lanIp, "请输入或扫描选择局域网 IP。") ||
                    !requireField(lanCredential, "请输入完整的局域网安全码。")) return;
            String selectedIp = value(lanIp);
            int selectedPort;
            try { selectedPort = Integer.parseInt(value(lanPort)); }
            catch (NumberFormatException invalidPort) {
                lanPort.setError("端口必须是 1–65535 的数字。");
                show("局域网端口无效，请检查扫描结果或手动输入。");
                return;
            }
            if (selectedPort < 1 || selectedPort > 65535) {
                lanPort.setError("端口必须在 1–65535 之间。");
                show("局域网端口必须在 1–65535 之间。");
                return;
            }
            String selectedCredential = value(lanCredential);
            perform("正在核验局域网设备证书…", () -> {
                JSONObject peer = client.pairLan(selectedIp, selectedPort, selectedCredential);
                runOnUiThread(() -> {
                    String peerId = peer.optString("remoteDeviceId", peer.optString("deviceId"));
                    target.setText(peerId);
                });
                refreshPeers();
                show("局域网配对成功：" + peer.optString("name") + "。现在可点击设备进入桌面界面。");
            });
        });

        section(advanced, "远程任务");
        task = field(advanced, "给选中设备的任务", true);
        addButton(advanced, "发送远程任务（自动选择连接）", () -> {
            if (!requireField(target, "请先填写目标设备号。") || !requireField(task, "请输入任务内容。")) return;
            String selectedDevice = value(target), prompt = value(task);
            String trustedKey = "";
            for (int index = 0; index < cachedCloudPeers.length(); index++) {
                JSONObject peer = cachedCloudPeers.optJSONObject(index);
                if (peer != null && selectedDevice.equals(peer.optString("deviceId"))) { trustedKey = peer.optString("identityPublicKey"); break; }
            }
            String peerKey = trustedKey;
            performTask("正在安全连接设备并发送任务…", () ->
                    showTaskResult("远程任务结果：\n" + client.cloudTask(selectedDevice, prompt, peerKey), true));
        });
        addButton(advanced, "通过局域网发送任务", () -> {
            if (!requireField(target, "请先填写目标设备号。") || !requireField(task, "请输入任务内容。")) return;
            String selectedDevice = value(target), prompt = value(task);
            performTask("局域网任务执行中…", () ->
                    showTaskResult("局域网任务结果：\n" + client.lanTask(selectedDevice, prompt), true));
        });
        result = text("", 13, INK, false);
        result.setTextIsSelectable(true);
        result.setPadding(dp(12), dp(12), dp(12), dp(12));
        result.setBackground(round(Color.rgb(248, 250, 252), 8, BORDER));
        result.setVisibility(View.GONE);
        LinearLayout.LayoutParams resultParams = new LinearLayout.LayoutParams(-1, -2);
        resultParams.topMargin = dp(10);
        advanced.addView(result, resultParams);

        worker.execute(() -> {
            try {
                identity = new IdentityStore(this);
                client = new DeviceClient(identity);
                runOnUiThread(() -> {
                    email.setText(identity.email());
                    emailOptionStatus.setText(identity.email().isEmpty() ? "验证邮箱后自动发现" : "已绑定 " + identity.email());
                    deviceLabel.setText("设备号：" + (identity.deviceId().isEmpty() ? "尚未登记" : identity.deviceId()));
                    status.setText(identity.deviceId().isEmpty() ? "请登记本机设备身份。" : "已就绪。邮箱验证后可显示同账号设备。");
                });
                if (identity.deviceId().isEmpty()) {
                    client.register();
                    runOnUiThread(() -> { deviceLabel.setText("设备号：" + identity.deviceId()); status.setText("设备身份已登记，请验证邮箱。"); });
                    refreshPeers();
                } else refreshPeers();
            } catch (Exception error) {
                Log.e(TAG, identity == null ? "Device identity initialization failed" : "Device registration failed", error);
                if (client != null) try { refreshPeers(); } catch (Exception ignored) { /* preserve the original error */ }
                show((identity == null ? "设备身份初始化失败：" : "设备身份已建立，联网登记暂未完成：") + error.getMessage());
            }
        });
    }

    private void refreshPeers() throws Exception {
        JSONArray peers = new JSONArray();
        String cloudError = "";
        if (!identity.email().isEmpty()) {
            try { peers = client.peers(); cachedCloudPeers = peers; }
            catch (Exception error) { peers = cachedCloudPeers; cloudError = error.getMessage(); }
        }
        JSONArray lanPeers = client.lanPeers();
        JSONArray cloudPeers = peers;
        String refreshError = cloudError;
        runOnUiThread(() -> {
            deviceList.removeAllViews();
            java.util.HashSet<String> shown = new java.util.HashSet<>();
            for (int i = 0; i < lanPeers.length(); i++) {
                JSONObject peer = lanPeers.optJSONObject(i);
                if (peer == null) continue;
                String id = peer.optString("remoteDeviceId", peer.optString("deviceId"));
                if (id.isEmpty() || !shown.add(id)) continue;
                String name = peer.optString("name", id);
                addDeviceRow(name, "局域网已配对", true, id);
            }
            for (int i = 0; i < cloudPeers.length(); i++) {
                JSONObject peer = cloudPeers.optJSONObject(i);
                if (peer == null) continue;
                String id = peer.optString("deviceId");
                if (id.isEmpty() || !shown.add(id)) continue;
                String name = peer.optString("name", id);
                boolean online = peer.optBoolean("online");
                addDeviceRow(name, !refreshError.isEmpty() ? "云端状态待确认" : online ? "云端在线" : "当前离线",
                        refreshError.isEmpty() && online, id);
            }
            if (shown.isEmpty()) {
                LinearLayout empty = new LinearLayout(this);
                empty.setOrientation(LinearLayout.HORIZONTAL);
                empty.setGravity(android.view.Gravity.CENTER_VERTICAL);
                empty.setPadding(dp(14), dp(16), dp(14), dp(16));
                empty.setBackground(round(Color.rgb(248, 250, 252), 10, 0));
                TextView emptyIcon = text("⌁", 23, BLUE, true);
                emptyIcon.setGravity(android.view.Gravity.CENTER);
                emptyIcon.setBackground(round(Color.WHITE, 10, BORDER));
                empty.addView(emptyIcon, new LinearLayout.LayoutParams(dp(45), dp(45)));
                LinearLayout copy = new LinearLayout(this);
                copy.setOrientation(LinearLayout.VERTICAL);
                LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1);
                copyParams.leftMargin = dp(12);
                empty.addView(copy, copyParams);
                copy.addView(text("还没有连接的设备", 13, INK, true));
                TextView help = text("从下方选择一种连接方式", 11, MUTED, false);
                LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(-1, -2);
                helpParams.topMargin = dp(4);
                copy.addView(help, helpParams);
                deviceList.addView(empty);
            }
            deviceCount.setText(shown.size() + " 台" + (refreshError.isEmpty() ? "" : " · 上次发现"));
            status.setText(refreshError.isEmpty() ? (shown.isEmpty() ? "等待连接 · 添加设备后即可开始" : "已发现 " + shown.size() + " 台设备 · 点击进入") :
                    "云端刷新失败，已保留局域网设备：" + friendlyMessage(refreshError));
        });
    }

    private void openDevice(String id, String name) {
        target.setText(id);
        // Device-list entries are already discovered/paired identities. A stale manual code
        // must never turn this into a fresh pair-ticket request for another device.
        openRemote(id, "", true);
    }

    private void openRemote(String id, String code, boolean preferLan) {
        if (client == null || id == null || !id.matches("[a-z0-9][a-z0-9-]{1,58}")) {
            show("设备身份尚未就绪或设备号无效。");
            return;
        }
        Intent intent = new Intent(this, RemoteActivity.class);
        intent.putExtra("device-id", id);
        intent.putExtra("connect", true);
        intent.putExtra("prefer-lan", preferLan);
        for (int index = 0; index < cachedCloudPeers.length(); index++) {
            JSONObject peer = cachedCloudPeers.optJSONObject(index);
            if (peer != null && id.equals(peer.optString("deviceId"))) {
                intent.putExtra("identity-public-key", peer.optString("identityPublicKey"));
                break;
            }
        }
        if (code != null && !code.isBlank()) intent.putExtra("pair-code", code);
        startActivity(intent);
    }

    private interface Work { void run() throws Exception; }
    private void perform(String progress, Work action) {
        if (client == null) { show("设备身份尚未就绪，请稍后再试。"); return; }
        if (!operationBusy.compareAndSet(false, true)) { show("当前操作尚未完成，请稍候。"); return; }
        status.setText(progress);
        showNotice(progress);
        worker.execute(() -> {
            try { action.run(); }
            catch (Exception error) { show("操作失败：" + error.getMessage()); }
            finally { operationBusy.set(false); }
        });
    }

    private void performTask(String progress, Work action) {
        if (client == null) { show("设备身份尚未就绪，请稍后再试。"); return; }
        if (!taskBusy.compareAndSet(false, true)) { show("已有远程任务在执行，请等待结果，避免重复提交。"); return; }
        result.setText("");
        result.setVisibility(View.GONE);
        show(progress);
        taskWorker.execute(() -> {
            try { action.run(); }
            catch (Exception error) { showTaskResult("远程任务未完成：" + friendlyMessage(error.getMessage()), false); }
            finally { taskBusy.set(false); }
        });
    }

    private void show(String message) {
        runOnUiThread(() -> {
            if (status != null) status.setText(friendlyMessage(message));
            showNotice(friendlyMessage(message));
        });
    }

    private void showTaskResult(String message, boolean success) {
        show(success ? "任务完成，结果见下方；长按结果可复制。" : "远程任务未完成，详情见下方。");
        runOnUiThread(() -> {
            if (result != null) {
                advancedCard.setVisibility(View.VISIBLE);
                advancedToggle.setText("收起手动连接与设置  ↑");
                advancedToggle.setContentDescription("收起手动连接、远程任务与本机设置");
                result.setText(message);
                result.setVisibility(View.VISIBLE);
                scroller.post(() -> {
                    Rect area = new Rect();
                    result.getDrawingRect(area);
                    scroller.offsetDescendantRectToMyCoords(result, area);
                    scroller.smoothScrollTo(0, Math.max(0, area.top - dp(24)));
                });
            }
        });
    }

    private void showNotice(String message) {
        if (notice == null) return;
        notices.removeCallbacks(hideNotice);
        notice.setText(message);
        notice.setVisibility(View.VISIBLE);
        notices.postDelayed(hideNotice, 6_000);
    }

    private boolean requireField(EditText field, String error) {
        if (!value(field).isEmpty()) return true;
        field.setError(error);
        field.requestFocus();
        show(error);
        return false;
    }

    private boolean validEmail(EditText field) {
        if (android.util.Patterns.EMAIL_ADDRESS.matcher(value(field)).matches()) return true;
        field.setError("请输入有效的邮箱地址。");
        field.requestFocus();
        show("请输入有效的邮箱地址。");
        return false;
    }

    private String friendlyMessage(String message) {
        if (message == null) return "操作暂不可用。";
        if (message.contains("Unable to resolve host") || message.contains("No address associated with hostname"))
            return "当前无法连接交换中心；已配对的局域网设备仍可使用。请检查手机网络。";
        return message;
    }

    private String value(EditText field) {
        if (Looper.myLooper() == Looper.getMainLooper()) return field.getText().toString().trim();
        FutureTask<String> read = new FutureTask<>(() -> field.getText().toString().trim());
        runOnUiThread(read);
        try { return read.get(); } catch (Exception error) { throw new IllegalStateException("无法读取输入内容。", error); }
    }
    private int dp(int value) { return Math.round(getResources().getDisplayMetrics().density * value); }
    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }
    private GradientDrawable round(int fill, int radius, int stroke) {
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(fill);
        shape.setCornerRadius(dp(radius));
        if (stroke != 0) shape.setStroke(dp(1), stroke);
        return shape;
    }
    private void connectionTile(LinearLayout parent, String symbol, String title, TextView subtitle, Runnable click, boolean first) {
        LinearLayout tile = new LinearLayout(this);
        tile.setOrientation(LinearLayout.VERTICAL);
        tile.setPadding(dp(14), dp(13), dp(12), dp(12));
        tile.setBackground(round(Color.WHITE, 12, BORDER));
        LinearLayout.LayoutParams tileParams = new LinearLayout.LayoutParams(0, -2, 1);
        if (!first) tileParams.leftMargin = dp(10);
        parent.addView(tile, tileParams);
        tile.setMinimumHeight(dp(116));
        TextView icon = text(symbol, 17, BLUE, true);
        icon.setGravity(android.view.Gravity.CENTER);
        icon.setBackground(round(Color.rgb(239, 246, 255), 8, 0));
        tile.addView(icon, new LinearLayout.LayoutParams(dp(29), dp(29)));
        TextView titleView = text(title + "  ↗", 14, INK, true);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(8);
        tile.addView(titleView, titleParams);
        subtitle.setMaxLines(2);
        subtitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
        tile.addView(subtitle);
        tile.setOnClickListener(view -> click.run());
        tile.setFocusable(true);
        tile.setContentDescription(title + "，" + subtitle.getText());
    }
    private void selectConnectionTile(LinearLayout parent, int selected) {
        for (int i = 0; i < parent.getChildCount(); i++) {
            View tile = parent.getChildAt(i);
            tile.setBackground(round(i == selected ? Color.rgb(239, 246, 255) : Color.WHITE, 12,
                    i == selected ? BLUE : BORDER));
            tile.setSelected(i == selected);
        }
    }
    private void addDeviceRow(String name, String route, boolean online, String id) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(12), dp(12), dp(12));
        row.setBackground(round(Color.WHITE, 10, BORDER));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.bottomMargin = dp(8);
        deviceList.addView(row, rowParams);
        TextView icon = text("▣", 19, BLUE, true);
        icon.setGravity(android.view.Gravity.CENTER);
        icon.setBackground(round(Color.rgb(239, 246, 255), 9, 0));
        row.addView(icon, new LinearLayout.LayoutParams(dp(38), dp(38)));
        LinearLayout copy = new LinearLayout(this);
        copy.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, -2, 1);
        copyParams.leftMargin = dp(11);
        row.addView(copy, copyParams);
        copy.addView(text(name, 14, INK, true));
        TextView subtitle = text(route, 11, online ? Color.rgb(46, 118, 80) : MUTED, false);
        LinearLayout.LayoutParams subtitleParams = new LinearLayout.LayoutParams(-1, -2);
        subtitleParams.topMargin = dp(3);
        copy.addView(subtitle, subtitleParams);
        if (online) {
            row.addView(text("›", 24, MUTED, false));
            row.setOnClickListener(view -> openDevice(id, name));
            row.setContentDescription("打开设备 " + name + "，" + route);
            row.setFocusable(true);
        } else {
            row.setAlpha(.65f);
            row.setContentDescription("设备 " + name + "，当前离线");
        }
    }
    private TextView label(String value, int size) { TextView text = new TextView(this); text.setText(value); text.setTextSize(size); text.setPadding(0, dp(7), 0, dp(7)); return text; }
    private void section(LinearLayout parent, String title) {
        TextView label = label(title, 18);
        label.setTextColor(INK);
        label.setPadding(0, dp(4), 0, dp(8));
        parent.addView(label);
    }
    private LinearLayout card(LinearLayout parent) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(15), dp(16), dp(15));
        panel.setBackground(round(Color.WHITE, 12, BORDER));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(14);
        parent.addView(panel, params);
        return panel;
    }
    private EditText field(LinearLayout parent, String hint, boolean multiline) {
        EditText input = new EditText(this);
        input.setHint(hint);
        input.setTextSize(15);
        input.setTextColor(INK);
        input.setHintTextColor(Color.rgb(100, 116, 139));
        input.setSingleLine(!multiline);
        if (multiline) input.setMinLines(3);
        input.setPadding(dp(12), dp(10), dp(12), dp(10));
        input.setBackground(round(Color.WHITE, 8, BORDER));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, -2);
        inputParams.topMargin = dp(10);
        parent.addView(input, inputParams);
        return input;
    }
    private void addButton(LinearLayout parent, String title, Runnable click) {
        Button button = new Button(this);
        button.setText(title);
        button.setAllCaps(false);
        button.setTextSize(14);
        boolean primary = "验证并绑定邮箱".equals(title) || "云端打开桌面".equals(title);
        button.setTextColor(primary ? Color.WHITE : BLUE);
        button.setBackground(round(primary ? BLUE : Color.rgb(239, 246, 255), 8, 0));
        button.setStateListAnimator(null);
        button.setElevation(0);
        button.setOnClickListener(view -> click.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(46));
        params.topMargin = dp(8);
        parent.addView(button, params);
    }
    @Override public void onResume() {
        super.onResume();
        heartbeat.postDelayed(heartbeatAction, 15_000);
        if (client != null) worker.execute(() -> { try { refreshPeers(); } catch (Exception ignored) { /* keep cached list when offline */ } });
    }
    @Override public void onPause() { heartbeat.removeCallbacks(heartbeatAction); super.onPause(); }
    @Override public void onDestroy() { notices.removeCallbacksAndMessages(null); worker.shutdownNow(); taskWorker.shutdownNow(); heartbeatWorker.shutdownNow(); super.onDestroy(); }
}
