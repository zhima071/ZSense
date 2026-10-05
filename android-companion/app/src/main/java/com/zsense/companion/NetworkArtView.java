package com.zsense.companion;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/** Quiet, code-native connection motif for the dashboard hero. */
final class NetworkArtView extends View {
    private static final int[] RING_RADII = {39, 67, 96};
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);

    NetworkArtView(Context context) { super(context); }

    private float dp(float value) { return getResources().getDisplayMetrics().density * value; }

    @Override protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float x = getWidth() - dp(69);
        float y = dp(91);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        for (int radius : RING_RADII) {
            paint.setColor(Color.argb(radius == 39 ? 75 : 36, 207, 227, 255));
            canvas.drawCircle(x, y, dp(radius), paint);
        }
        paint.setColor(Color.argb(105, 179, 211, 255));
        paint.setStrokeWidth(dp(1.5f));
        canvas.drawLine(x - dp(35), y + dp(15), x - dp(91), y + dp(55), paint);
        canvas.drawLine(x + dp(25), y - dp(25), x + dp(46), y - dp(67), paint);

        paint.setStyle(Paint.Style.FILL);
        paint.setColor(Color.argb(84, 224, 238, 255));
        canvas.drawCircle(x, y, dp(24), paint);
        paint.setColor(Color.argb(185, 255, 255, 255));
        canvas.drawRoundRect(x - dp(13), y - dp(10), x + dp(13), y + dp(7), dp(3), dp(3), paint);
        canvas.drawRoundRect(x - dp(3), y + dp(9), x + dp(3), y + dp(12), dp(1), dp(1), paint);
        canvas.drawRoundRect(x - dp(9), y + dp(12), x + dp(9), y + dp(14), dp(1), dp(1), paint);

        paint.setColor(Color.argb(180, 159, 213, 255));
        canvas.drawCircle(x - dp(91), y + dp(55), dp(4), paint);
        canvas.drawCircle(x + dp(46), y - dp(67), dp(3), paint);
        canvas.drawCircle(x + dp(66), y + dp(54), dp(2), paint);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(dp(1));
        paint.setColor(Color.argb(68, 221, 237, 255));
        canvas.drawRoundRect(x - dp(110), y + dp(39), x - dp(72), y + dp(74), dp(7), dp(7), paint);
    }
}
