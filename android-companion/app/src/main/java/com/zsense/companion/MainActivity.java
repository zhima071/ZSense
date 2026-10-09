package com.zsense.companion;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import android.provider.Settings;
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
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.view.Gravity;

import java.util.concurrent.atomic.AtomicBoolean;
import java.io.File;

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
    private TextView cloudDeviceCount;
    private TextView lanDeviceCount;
    private LinearLayout cloudDeviceList;
    private LinearLayout lanDeviceList;
    private LinearLayout cloudCard;
    private LinearLayout accountCard;
    private LinearLayout lanCard;
    private LinearLayout advancedCard;
    private TextView advancedToggle;
    private TextView emailOptionStatus;
    private EditText email;
    private EditText code;
    private EditText target;
    private EditText pairCode;
    private EditText taskTarget;
    private EditText lanIp;
    private EditText lanPort;
    private EditText lanCredential;
    private EditText task;
    private TextView result;
    private ScrollView scroller;
    private AndroidUpdateManager updater;
    private LinearLayout updateCard;
    private TextView updateStatus;
    private ProgressBar updateProgress;
    private LinearLayout updateActions;
    private File pendingInstallApk;

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
        TextView updateAction = text("更新", 12, BLUE, true);
        updateAction.setPadding(dp(10), dp(8), dp(10), dp(8));
        updateAction.setBackground(round(Color.rgb(239, 246, 255), 9, 0));
        LinearLayout.LayoutParams updateActionParams = new LinearLayout.LayoutParams(-2, -2);
        updateActionParams.leftMargin = dp(6);
        header.addView(updateAction, updateActionParams);
        updateAction.setContentDescription("检查应用更新");
        updateAction.setOnClickListener(view -> {
            updateCard.setVisibility(View.VISIBLE);
            updater.check();
        });
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

        updateCard = card(content);
        updateCard.setVisibility(View.GONE);
        LinearLayout updateHeading = new LinearLayout(this);
        updateHeading.setGravity(Gravity.CENTER_VERTICAL);
        updateCard.addView(updateHeading);
        updateHeading.addView(text("应用更新", 16, INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        TextView currentVersion = text("当前 " + BuildConfig.VERSION_NAME, 11, MUTED, false);
        updateHeading.addView(currentVersion);
        updateStatus = text("检查官方发布的新版本。", 12, MUTED, false);
        LinearLayout.LayoutParams updateStatusParams = new LinearLayout.LayoutParams(-1, -2);
        updateStatusParams.topMargin = dp(9);
        updateCard.addView(updateStatus, updateStatusParams);
        updateProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        updateProgress.setMax(1000);
        updateProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams updateProgressParams = new LinearLayout.LayoutParams(-1, dp(5));
        updateProgressParams.topMargin = dp(10);
        updateCard.addView(updateProgress, updateProgressParams);
        updateActions = new LinearLayout(this);
        updateActions.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams updateActionsParams = new LinearLayout.LayoutParams(-1, -2);
        updateActionsParams.topMargin = dp(10);
        updateCard.addView(updateActions, updateActionsParams);
        updater = new AndroidUpdateManager(this, new AndroidUpdateManager.Listener() {
            @Override public void onState(AndroidUpdateManager.State next) { renderUpdate(next); }
            @Override public void onInstallReady(File apk) { requestInstall(apk); }
        });

        LinearLayout peersCard = card(content);
        LinearLayout deviceHeading = new LinearLayout(this);
        deviceHeading.setOrientation(LinearLayout.HORIZONTAL);
        deviceHeading.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView devicesTitle = text("我的设备", 18, INK, true);
        deviceHeading.addView(devicesTitle, new LinearLayout.LayoutParams(0, -2, 1));
        deviceCount = text("0 台", 12, MUTED, false);
        deviceHeading.addView(deviceCount);
        peersCard.addView(deviceHeading);
        TextView cloudTitle = text("云端连接", 14, INK, true);
        LinearLayout.LayoutParams cloudTitleParams = new LinearLayout.LayoutParams(-1, -2);
        cloudTitleParams.topMargin = dp(18);
        peersCard.addView(cloudTitle, cloudTitleParams);
        cloudDeviceCount = text("正在读取…", 11, MUTED, false);
        peersCard.addView(cloudDeviceCount);
        cloudDeviceList = new LinearLayout(this);
        cloudDeviceList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams cloudListParams = new LinearLayout.LayoutParams(-1, -2);
        cloudListParams.topMargin = dp(8);
        peersCard.addView(cloudDeviceList, cloudListParams);
        TextView connectOtherAccount = text("连接其他账号的设备  →", 12, BLUE, true);
        connectOtherAccount.setGravity(Gravity.CENTER_VERTICAL);
        connectOtherAccount.setMinHeight(dp(48));
        connectOtherAccount.setFocusable(true);
        connectOtherAccount.setContentDescription("通过云端连接其他账号的设备，输入设备号和配对码");
        peersCard.addView(connectOtherAccount);

        TextView lanTitle = text("局域网连接", 14, INK, true);
        LinearLayout.LayoutParams lanTitleParams = new LinearLayout.LayoutParams(-1, -2);
        lanTitleParams.topMargin = dp(18);
        peersCard.addView(lanTitle, lanTitleParams);
        lanDeviceCount = text("正在查找附近设备…", 11, MUTED, false);
        peersCard.addView(lanDeviceCount);
        lanDeviceList = new LinearLayout(this);
        lanDeviceList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lanListParams = new LinearLayout.LayoutParams(-1, -2);
        lanListParams.topMargin = dp(8);
        peersCard.addView(lanDeviceList, lanListParams);

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
        connectionTile(methods, "◎", "云端连接", text("跨网络连接其他设备", 11, MUTED, false), () -> {
            cloudCard.setVisibility(View.VISIBLE);
            lanCard.setVisibility(View.GONE);
            accountCard.setVisibility(View.GONE);
            selectConnectionTile(methods, 0);
            scroller.post(() -> scroller.smoothScrollTo(0, cloudCard.getTop()));
        }, true);
        connectionTile(methods, "⌁", "局域网连接", text("附近设备直接连接", 11, MUTED, false), () -> {
            lanCard.setVisibility(View.VISIBLE);
            cloudCard.setVisibility(View.GONE);
            accountCard.setVisibility(View.GONE);
            selectConnectionTile(methods, 1);
            scroller.post(() -> scroller.smoothScrollTo(0, lanCard.getTop()));
        }, false);

        cloudCard = card(content);
        cloudCard.setVisibility(View.GONE);
        section(cloudCard, "云端连接其他设备");
        cloudCard.addView(text("跨网络或不同邮箱连接：输入桌面设备号与 6 位配对码。已配对设备可留空配对码。", 12, MUTED, false));
        TextView cloudIdLabel = text("桌面设备号", 12, INK, true);
        LinearLayout.LayoutParams cloudIdLabelParams = new LinearLayout.LayoutParams(-1, -2);
        cloudIdLabelParams.topMargin = dp(12);
        cloudCard.addView(cloudIdLabel, cloudIdLabelParams);
        target = field(cloudCard, "桌面设备号", false);
        target.setId(View.generateViewId());
        cloudIdLabel.setLabelFor(target.getId());
        TextView cloudCodeLabel = text("6 位配对码 · 首次连接时填写", 12, INK, true);
        LinearLayout.LayoutParams cloudCodeLabelParams = new LinearLayout.LayoutParams(-1, -2);
        cloudCodeLabelParams.topMargin = dp(12);
        cloudCard.addView(cloudCodeLabel, cloudCodeLabelParams);
        pairCode = field(cloudCard, "6 位配对码（首次连接时填写）", false);
        pairCode.setId(View.generateViewId());
        cloudCodeLabel.setLabelFor(pairCode.getId());
        pairCode.setInputType(InputType.TYPE_CLASS_NUMBER);
        pairCode.setFilters(new android.text.InputFilter[]{new android.text.InputFilter.LengthFilter(6)});
        addButton(cloudCard, "云端打开桌面", () -> {
            if (!requireField(target, "请输入目标设备号。")) return;
            String codeText = value(pairCode);
            if (!codeText.isEmpty() && !codeText.matches("[0-9]{6}")) {
                pairCode.setError("配对码必须是 6 位数字。");
                show("配对码必须是 6 位数字。");
                return;
            }
            openRemote(value(target), codeText, "cloud");
        });
        emailOptionStatus = text("同邮箱设备自动发现 · 验证或更换邮箱  →", 12, BLUE, true);
        emailOptionStatus.setGravity(Gravity.CENTER_VERTICAL);
        emailOptionStatus.setMinHeight(dp(48));
        emailOptionStatus.setFocusable(true);
        emailOptionStatus.setContentDescription("验证或更换邮箱，自动发现同邮箱设备");
        emailOptionStatus.setOnClickListener(view -> {
            accountCard.setVisibility(View.VISIBLE);
            scroller.post(() -> scroller.smoothScrollTo(0, accountCard.getTop()));
        });
        cloudCard.addView(emailOptionStatus);
        connectOtherAccount.setOnClickListener(view -> {
            cloudCard.setVisibility(View.VISIBLE);
            lanCard.setVisibility(View.GONE);
            accountCard.setVisibility(View.GONE);
            selectConnectionTile(methods, 0);
            scroller.post(() -> scroller.smoothScrollTo(0, cloudCard.getTop()));
        });

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
                    emailOptionStatus.setText("同邮箱设备自动发现 · 已绑定邮箱  →");
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
        TextView more = text("远程任务与本机设置  →", 12, MUTED, false);
        advancedToggle = more;
        more.setPadding(dp(4), dp(19), dp(4), dp(8));
        more.setOnClickListener(view -> {
            boolean expand = advanced.getVisibility() != View.VISIBLE;
            advanced.setVisibility(expand ? View.VISIBLE : View.GONE);
            more.setText(expand ? "收起远程任务与设置  ↑" : "远程任务与本机设置  →");
            more.setContentDescription(expand ? "收起远程任务与本机设置" : "展开远程任务与本机设置");
            if (expand) scroller.post(() -> scroller.smoothScrollTo(0, advanced.getTop()));
        });
        more.setFocusable(true);
        more.setContentDescription("展开远程任务与本机设置");
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
                    taskTarget.setText(peerId);
                });
                refreshPeers();
                show("局域网配对成功：" + peer.optString("name") + "。现在可点击设备进入桌面界面。");
            });
        });

        section(advanced, "远程任务");
        taskTarget = field(advanced, "任务目标设备号", false);
        task = field(advanced, "给选中设备的任务", true);
        addButton(advanced, "发送远程任务（自动选择连接）", () -> {
            if (!requireField(taskTarget, "请先填写目标设备号。") || !requireField(task, "请输入任务内容。")) return;
            String selectedDevice = value(taskTarget), prompt = value(task);
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
            if (!requireField(taskTarget, "请先填写目标设备号。") || !requireField(task, "请输入任务内容。")) return;
            String selectedDevice = value(taskTarget), prompt = value(task);
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
                    emailOptionStatus.setText(identity.email().isEmpty() ? "同邮箱设备自动发现 · 验证邮箱  →" : "同邮箱设备自动发现 · 已绑定邮箱  →");
                    deviceLabel.setText("设备号：" + (identity.deviceId().isEmpty() ? "尚未登记" : identity.deviceId()));
                    status.setText(identity.deviceId().isEmpty() ? "请登记本机设备身份。" : "设备已就绪，可云端连接或验证邮箱自动发现。");
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
        JSONArray savedCloudPeers = client.savedCloudPeers();
        JSONArray nearby = new JSONArray();
        if (peers.length() > 0) {
            try { nearby = client.scanLanNearby(); }
            catch (Exception ignored) { /* LAN discovery is optional; saved peers remain visible. */ }
        }
        JSONArray cloudPeers = peers;
        JSONArray rememberedCloudPeers = savedCloudPeers;
        JSONArray nearbyPeers = nearby;
        String refreshError = cloudError;
        runOnUiThread(() -> {
            cloudDeviceList.removeAllViews();
            lanDeviceList.removeAllViews();
            java.util.HashSet<String> allIds = new java.util.HashSet<>();
            java.util.HashSet<String> lanIds = new java.util.HashSet<>();
            java.util.HashSet<String> trustedCloudIds = new java.util.HashSet<>();
            int cloudShown = 0;
            int lanShown = 0;
            for (int i = 0; i < cloudPeers.length(); i++) {
                JSONObject peer = cloudPeers.optJSONObject(i);
                if (peer == null) continue;
                String id = peer.optString("deviceId");
                if (id.isEmpty() || !trustedCloudIds.add(id)) continue;
                allIds.add(id);
                String name = peer.optString("name", id);
                boolean online = peer.optBoolean("online");
                addDeviceRow(cloudDeviceList, name, !refreshError.isEmpty() ? "云端状态待确认" : online ? "云端在线 · 点按连接" : "云端离线",
                        refreshError.isEmpty() && online, id, "cloud");
                cloudShown++;
            }
            for (int i = 0; i < rememberedCloudPeers.length(); i++) {
                JSONObject peer = rememberedCloudPeers.optJSONObject(i);
                if (peer == null) continue;
                String id = peer.optString("deviceId");
                if (id.isEmpty() || trustedCloudIds.contains(id)) continue;
                allIds.add(id);
                addDeviceRow(cloudDeviceList, peer.optString("name", id), "已保存 · 连接时验证授权", true, id, "cloud", true);
                cloudShown++;
            }
            for (int i = 0; i < lanPeers.length(); i++) {
                JSONObject peer = lanPeers.optJSONObject(i);
                if (peer == null) continue;
                String id = peer.optString("remoteDeviceId", peer.optString("deviceId"));
                if (id.isEmpty() || !lanIds.add(id)) continue;
                allIds.add(id);
                String name = peer.optString("name", id);
                addDeviceRow(lanDeviceList, name, "已配对 · 点按尝试局域网直连", true, id, "lan");
                lanShown++;
            }
            for (int i = 0; i < nearbyPeers.length(); i++) {
                JSONObject found = nearbyPeers.optJSONObject(i);
                if (found == null) continue;
                String id = found.optString("remoteDeviceId");
                if (id.isEmpty() || !trustedCloudIds.contains(id) || !lanIds.add(id)) continue;
                for (int j = 0; j < cloudPeers.length(); j++) {
                    JSONObject peer = cloudPeers.optJSONObject(j);
                    if (peer == null || !id.equals(peer.optString("deviceId"))) continue;
                    addDeviceRow(lanDeviceList, peer.optString("name", id), "附近已发现 · 点按验证后直连", true, id, "lan");
                    lanShown++;
                    break;
                }
            }
            if (cloudShown == 0) cloudDeviceList.addView(text("同邮箱设备及已连接的其他账号设备会显示在这里；也可用下方入口手动连接。", 12, MUTED, false));
            if (lanShown == 0) lanDeviceList.addView(text("同一局域网内的已配对或同邮箱设备会显示在这里。", 12, MUTED, false));
            cloudDeviceCount.setText(cloudShown + " 台 · 经交换中心连接" + (refreshError.isEmpty() ? "" : " · 状态待确认"));
            lanDeviceCount.setText(lanShown + " 台 · 不经过云端中转");
            deviceCount.setText(allIds.size() + " 台设备");
            status.setText(refreshError.isEmpty() ? (allIds.isEmpty() ? "等待连接 · 添加设备后即可开始" : "已发现 " + allIds.size() + " 台设备 · 选择连接方式") :
                    "云端刷新失败；局域网设备仍可尝试连接：" + friendlyMessage(refreshError));
        });
    }

    private void openDevice(String id, String mode) {
        target.setText(id);
        // Discovered devices never reuse a stale manual pairing code.
        openRemote(id, "", mode);
    }

    private void openRemote(String id, String code, String mode) {
        if (client == null || id == null || !id.matches("[a-z0-9][a-z0-9-]{1,58}")) {
            show("设备身份尚未就绪或设备号无效。");
            return;
        }
        if (taskTarget != null) taskTarget.setText(id);
        Intent intent = new Intent(this, RemoteActivity.class);
        intent.putExtra("device-id", id);
        intent.putExtra("connect", true);
        intent.putExtra("connection-mode", mode);
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
                advancedToggle.setText("收起远程任务与设置  ↑");
                advancedToggle.setContentDescription("收起远程任务与本机设置");
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

    private void renderUpdate(AndroidUpdateManager.State next) {
        if (updateStatus == null || updateActions == null) return;
        String detail = next.message;
        if (next.total > 0 && ("downloading".equals(next.phase) || "paused".equals(next.phase) || "ready".equals(next.phase))) {
            detail += "\n" + formatSize(next.received) + " / " + formatSize(next.total);
            if ("downloading".equals(next.phase)) detail += " · " + formatSize(next.bytesPerSecond) + "/秒";
        }
        updateStatus.setText(detail);
        updateProgress.setVisibility(next.total > 0 && ("downloading".equals(next.phase) || "paused".equals(next.phase) || "ready".equals(next.phase)) ? View.VISIBLE : View.GONE);
        if (next.total > 0) updateProgress.setProgress((int) Math.min(1000, next.received * 1000 / next.total));
        updateActions.removeAllViews();
        switch (next.phase) {
            case "downloading":
                updateButton("暂停下载", false, updater::pause);
                updateButton("取消下载", false, updater::cancel);
                break;
            case "paused":
                updateButton("继续下载", true, updater::download);
                updateButton("取消下载", false, updater::cancel);
                break;
            case "available": case "canceled":
                updateButton("下载更新", true, updater::download);
                break;
            case "ready":
                updateButton("安装更新", true, updater::install);
                break;
            case "error":
                updateButton(next.version.isEmpty() ? "重试检查" : "重试下载", true,
                        next.version.isEmpty() ? updater::check : updater::download);
                if (next.received > 0) updateButton("取消并清理", false, updater::cancel);
                break;
            case "current":
                updateButton("再次检查", false, updater::check);
                break;
            default: break;
        }
    }

    private void updateButton(String title, boolean primary, Runnable action) {
        TextView button = text(title, 12, primary ? Color.WHITE : BLUE, true);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(dp(42));
        button.setPadding(dp(8), dp(8), dp(8), dp(8));
        button.setBackground(round(primary ? BLUE : Color.rgb(239, 246, 255), 9, 0));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, -2, 1);
        if (updateActions.getChildCount() > 0) params.leftMargin = dp(8);
        updateActions.addView(button, params);
        button.setOnClickListener(view -> action.run());
        button.setFocusable(true);
        button.setContentDescription(title);
    }

    private static String formatSize(long bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return String.format(java.util.Locale.CHINA, "%.1f KB", bytes / 1024d);
        return String.format(java.util.Locale.CHINA, "%.1f MB", bytes / (1024d * 1024d));
    }

    private void requestInstall(File apk) {
        if (!getPackageManager().canRequestPackageInstalls()) {
            pendingInstallApk = apk;
            show("请在系统设置中允许 ZSense 安装应用，然后返回继续安装。");
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (Exception error) { show("无法打开安装权限设置：" + error.getMessage()); }
            return;
        }
        pendingInstallApk = null;
        Uri uri = new Uri.Builder().scheme("content").authority(getPackageName() + ".updates")
                .appendPath(apk.getName()).build();
        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(uri, "application/vnd.android.package-archive");
        install.setClipData(ClipData.newRawUri("ZSense APK", uri));
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try { startActivity(install); }
        catch (Exception error) { show("无法启动系统安装器：" + error.getMessage()); }
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
    private void addDeviceRow(LinearLayout list, String name, String route, boolean online, String id, String mode) {
        addDeviceRow(list, name, route, online, id, mode, false);
    }
    private void addDeviceRow(LinearLayout list, String name, String route, boolean online, String id, String mode, boolean removableCloud) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(android.view.Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(12), dp(12), dp(12));
        row.setBackground(round(Color.WHITE, 10, BORDER));
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(-1, -2);
        rowParams.bottomMargin = dp(8);
        list.addView(row, rowParams);
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
            if (removableCloud) {
                TextView remove = text("移除", 11, MUTED, false);
                remove.setGravity(android.view.Gravity.CENTER);
                remove.setMinHeight(dp(48));
                remove.setPadding(dp(7), 0, 0, 0);
                remove.setContentDescription("从本机列表移除 " + name + "，不撤销桌面端授权");
                remove.setOnClickListener(view -> {
                    client.forgetCloudPeer(id);
                    worker.execute(() -> { try { refreshPeers(); } catch (Exception error) { show("刷新设备列表失败：" + error.getMessage()); } });
                });
                row.addView(remove);
            }
            row.setOnClickListener(view -> openDevice(id, mode));
            row.setContentDescription("通过" + ("cloud".equals(mode) ? "云端" : "局域网") + "打开设备 " + name + "，" + route);
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
        if (pendingInstallApk != null && getPackageManager().canRequestPackageInstalls()) requestInstall(pendingInstallApk);
        heartbeat.postDelayed(heartbeatAction, 15_000);
        if (client != null) worker.execute(() -> { try { refreshPeers(); } catch (Exception ignored) { /* keep cached list when offline */ } });
    }
    @Override public void onPause() { heartbeat.removeCallbacks(heartbeatAction); super.onPause(); }
    @Override public void onDestroy() { notices.removeCallbacksAndMessages(null); worker.shutdownNow(); taskWorker.shutdownNow(); heartbeatWorker.shutdownNow(); super.onDestroy(); }
}
