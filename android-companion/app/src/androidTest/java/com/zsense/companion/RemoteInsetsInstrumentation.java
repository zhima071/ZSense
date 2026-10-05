package com.zsense.companion;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;

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
}
