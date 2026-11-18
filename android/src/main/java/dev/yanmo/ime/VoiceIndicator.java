package dev.yanmo.ime;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;
import android.view.View;

import java.util.Locale;

/** A touch-transparent recording status inside the existing candidate row. */
final class VoiceIndicator extends Drawable {
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Runnable tick = this::refresh;
    private View host;
    private int state = VoiceSession.IDLE;
    private long started;

    void attach(View keyboard) {
        if (host != null) {
            host.removeCallbacks(tick);
            host.getOverlay().remove(this);
        }
        host = keyboard;
        refresh();
    }

    void show(int next) {
        if (next == VoiceSession.RECORDING && state != next) started = SystemClock.elapsedRealtime();
        state = next;
        if (host == null) return;
        host.removeCallbacks(tick);
        host.getOverlay().remove(this);
        if (state != VoiceSession.IDLE) {
            host.announceForAccessibility(state == VoiceSession.RECORDING ? "正在听写，松手结束" : "正在处理听写");
        }
        refresh();
    }

    private void refresh() {
        if (host == null || state == VoiceSession.IDLE) return;
        float dp = host.getResources().getDisplayMetrics().density;
        int w = Math.min(host.getWidth(), Math.round(156 * dp));
        int h = Math.round(32 * dp);
        int x = (host.getWidth() - w) / 2;
        int y = Math.round(4 * dp);
        setBounds(x, y, x + w, y + h);
        host.getOverlay().add(this);
        invalidateSelf();
        if (state == VoiceSession.RECORDING) host.postDelayed(tick, 250);
    }

    void close() { show(VoiceSession.IDLE); host = null; }

    @Override public void draw(Canvas canvas) {
        float dp = host.getResources().getDisplayMetrics().density;
        float x = getBounds().exactCenterX(), y = getBounds().exactCenterY();
        long seconds = Math.max(0L, (SystemClock.elapsedRealtime() - started) / 1000);
        String label = state == VoiceSession.RECORDING
                ? String.format(Locale.ROOT, "正在录音 · %d:%02d", seconds / 60, seconds % 60)
                : "正在处理听写…";
        paint.setColor(0xff29251f);
        float radius = getBounds().height() / 2f;
        canvas.drawRoundRect(getBounds().left, getBounds().top, getBounds().right, getBounds().bottom, radius, radius, paint);
        paint.setColor(0xfff8f5ec);
        paint.setTextSize(13 * dp);
        paint.setTextAlign(Paint.Align.CENTER);
        canvas.drawText(label, x + 6 * dp, y - (paint.ascent() + paint.descent()) / 2, paint);
        paint.setColor(0xffc47562);
        canvas.drawCircle(x - paint.measureText(label) / 2 - 4 * dp, y, 3 * dp, paint);
    }

    @Override public void setAlpha(int alpha) { paint.setAlpha(alpha); }
    @Override public void setColorFilter(ColorFilter filter) { paint.setColorFilter(filter); }
    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
