package dev.yanmo.ime;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.concurrent.ForkJoinPool;

/** System-enabled service with access to the one-shot screenshot API. */
public final class ScreenCapture extends AccessibilityService {
    private static ScreenCapture connected;

    static boolean supported() { return Build.VERSION.SDK_INT >= 30; }

    static boolean enabled(Context context) {
        if (!supported()) return false;
        AccessibilityManager manager = context.getSystemService(AccessibilityManager.class);
        if (manager == null) return false;
        for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(
                AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
            if (ScreenCapture.class.getName().equals(info.getResolveInfo().serviceInfo.name)
                    && context.getPackageName().equals(info.getResolveInfo().serviceInfo.packageName)) return true;
        }
        return false;
    }

    static boolean disable() {
        if (connected == null) return false;
        connected.disableSelf();
        return true;
    }

    // Called on the IME main thread. Android delivers and encodes the frame off that thread.
    static void capture(Context context, String id) {
        ScreenCapture service = connected;
        if (!supported() || service == null) {
            Manuscripts.captureStatus(context, id, "本次口述未开启截屏");
            return;
        }
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, ForkJoinPool.commonPool(), new TakeScreenshotCallback() {
                @Override public void onSuccess(ScreenshotResult screenshot) {
                    try {
                        Manuscripts.saveScreenshot(context, id, encode(screenshot));
                    } catch (IOException | RuntimeException error) {
                        Manuscripts.captureStatus(context, id, "截屏保存失败");
                    }
                }

                @Override public void onFailure(int errorCode) {
                    Manuscripts.captureStatus(context, id, "本次截屏未成功");
                }
            });
        } catch (RuntimeException error) {
            Manuscripts.captureStatus(context, id, "本次截屏未成功");
        }
    }

    private static byte[] encode(ScreenshotResult screenshot) throws IOException {
        Bitmap frame;
        try (HardwareBuffer buffer = screenshot.getHardwareBuffer()) {
            frame = Bitmap.wrapHardwareBuffer(buffer, screenshot.getColorSpace());
        }
        if (frame == null) throw new IOException("Missing screenshot pixels");
        Bitmap scaled = frame;
        try {
            int width = frame.getWidth();
            int height = frame.getHeight();
            double scale = 1440.0 / Math.max(width, height);
            if (scale < 1) {
                scaled = Bitmap.createScaledBitmap(frame, Math.max(1, (int) Math.round(width * scale)),
                        Math.max(1, (int) Math.round(height * scale)), true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new IOException("截屏编码失败");
            return out.toByteArray();
        } finally {
            if (scaled != frame) scaled.recycle();
            frame.recycle();
        }
    }

    @Override protected void onServiceConnected() { connected = this; }

    @Override public void onDestroy() {
        if (connected == this) connected = null;
        super.onDestroy();
    }

    @Override public void onAccessibilityEvent(AccessibilityEvent event) {}
    @Override public void onInterrupt() {}
}
