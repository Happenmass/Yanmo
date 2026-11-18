package dev.yanmo.ime;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;

/** A user-authorized projection. The virtual display only receives a surface for a requested frame. */
public final class ScreenCapture extends Service {
    private static final int REQUEST = 7160;
    private static final String CHANNEL = "yanmo-screenshots";
    private static final String STOP = "dev.yanmo.ime.STOP_CAPTURE";
    private static volatile ScreenCapture active;
    private Handler worker;
    private HandlerThread thread;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private String pendingId;
    private int width, height, dpi;
    private boolean closing;

    public static void request(Activity activity) {
        MediaProjectionManager manager = activity.getSystemService(MediaProjectionManager.class);
        if (manager != null) activity.startActivityForResult(manager.createScreenCaptureIntent(), REQUEST);
    }

    public static void onActivityResult(Activity activity, int code, int result, Intent data) {
        if (code != REQUEST || result != Activity.RESULT_OK || data == null) return;
        Intent start = new Intent(activity, ScreenCapture.class);
        start.putExtra("consent", data);
        activity.startForegroundService(start);
    }

    public static boolean active() { return active != null; }
    public static void stop(Context context) { context.stopService(new Intent(context, ScreenCapture.class)); }

    public static void capture(Context context, String id) {
        ScreenCapture service = active;
        if (service == null || !service.worker.post(() -> service.nextFrame(id))) {
            Manuscripts.captureStatus(context, id, "本次口述未开启截屏");
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        thread = new HandlerThread("YanmoScreenshot");
        thread.start();
        worker = new Handler(thread.getLooper());
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Intent consent = intent.getParcelableExtra("consent");
        if (consent == null) { stopSelf(); return START_NOT_STICKY; }
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, "口述截屏", NotificationManager.IMPORTANCE_LOW));
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, ScreenCapture.class).setAction(STOP),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notice = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_camera).setContentTitle("言墨 · 口述截屏")
                .setContentText("结束录音时保存一帧").setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "停止截屏", stop).build()).build();
        if (Build.VERSION.SDK_INT >= 29)
            startForeground(7160, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7160, notice);
        worker.post(() -> startProjection(consent));
        return START_NOT_STICKY;
    }

    private void startProjection(Intent consent) {
        if (closing || projection != null) return;
        try {
            projection = getSystemService(MediaProjectionManager.class)
                    .getMediaProjection(Activity.RESULT_OK, consent);
            if (projection == null) throw new IllegalStateException("屏幕共享已结束");
            DisplayMetrics metrics = new DisplayMetrics();
            getSystemService(WindowManager.class).getDefaultDisplay().getRealMetrics(metrics);
            dpi = metrics.densityDpi;
            size(metrics.widthPixels, metrics.heightPixels);
            projection.registerCallback(new MediaProjection.Callback() {
                @Override public void onStop() { release(); stopSelf(); }
                @Override public void onCapturedContentResize(int w, int h) {
                    if (display != null && w > 0 && h > 0) {
                        int oldWidth = width, oldHeight = height;
                        size(w, h);
                        if (width == oldWidth && height == oldHeight) return;
                        abandon("截屏时屏幕大小改变");
                        display.resize(width, height, dpi);
                    }
                }
            }, worker);
            display = projection.createVirtualDisplay("言墨口述截屏", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, null, null, worker);
            if (display == null) throw new IllegalStateException("无法创建屏幕共享");
            active = this;
        } catch (RuntimeException ex) {
            new Handler(getMainLooper()).post(() -> Toast.makeText(this, "截屏授权已失效，请重新开启", Toast.LENGTH_SHORT).show());
            release();
            stopSelf();
        }
    }

    private void size(int w, int h) {
        double scale = Math.min(1.0, 1440.0 / Math.max(w, h));
        width = Math.max(1, (int) Math.round(w * scale));
        height = Math.max(1, (int) Math.round(h * scale));
    }

    private void nextFrame(String id) {
        if (closing || display == null || reader != null) {
            Manuscripts.captureStatus(this, id, "截屏会话当前不可用");
            return;
        }
        pendingId = id;
        try {
            ImageReader opened = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
            reader = opened;
            opened.setOnImageAvailableListener(source -> {
                if (source != reader) return;
                try (Image frame = source.acquireLatestImage()) {
                    if (frame == null) return;
                    Manuscripts.saveScreenshot(this, id, encode(frame));
                    pendingId = null;
                    clearSurface();
                } catch (IOException | RuntimeException ignored) {
                    abandon("截屏保存失败");
                }
            }, worker);
            display.setSurface(opened.getSurface());
            worker.postDelayed(() -> { if (reader == opened) abandon("授权画面未及时返回"); }, 1000);
        } catch (RuntimeException ex) { abandon("截屏会话已失效"); }
    }

    private static byte[] encode(Image frame) throws IOException {
        Image.Plane plane = frame.getPlanes()[0];
        int w = frame.getWidth(), h = frame.getHeight();
        ByteBuffer source = plane.getBuffer();
        int origin = source.position();
        ByteBuffer pixels = ByteBuffer.allocateDirect(w * h * 4);
        for (int y = 0; y < h; y++) {
            ByteBuffer row = source.duplicate();
            row.position(origin + y * plane.getRowStride());
            row.limit(row.position() + w * 4);
            pixels.put(row);
        }
        pixels.flip();
        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        try {
            bitmap.copyPixelsFromBuffer(pixels);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)) throw new IOException("截屏编码失败");
            return out.toByteArray();
        } finally {
            bitmap.recycle();
        }
    }

    private void abandon(String reason) {
        if (pendingId != null) {
            Manuscripts.captureStatus(this, pendingId, reason);
            pendingId = null;
        }
        clearSurface();
    }

    private void clearSurface() {
        if (reader == null) return;
        try { if (display != null) display.setSurface(null); } catch (RuntimeException ignored) {}
        reader.close();
        reader = null;
    }

    private void release() {
        closing = true;
        if (active == this) active = null;
        abandon("屏幕共享已结束");
        if (display != null) { display.release(); display = null; }
        if (projection != null) { MediaProjection current = projection; projection = null; current.stop(); }
    }

    @Override public void onDestroy() {
        if (active == this) active = null;
        worker.post(() -> { release(); thread.quitSafely(); });
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
