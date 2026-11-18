package dev.yanmo.ime;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.InputType;
import android.text.TextUtils;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import java.io.IOException;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class YanmoActivity extends Activity {
    private static final int PAPER = Color.rgb(248, 245, 236);
    private static final int INK = Color.rgb(43, 37, 31);
    private static final int LIGHT_INK = Color.rgb(99, 88, 74);
    private static final int BORDER = Color.rgb(214, 206, 191);
    private static final int CINNABAR = Color.rgb(156, 49, 37);
    private static final int OCHRE = Color.rgb(123, 76, 31);
    private static final int MIC_REQUEST = 200;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private LinearLayout page;
    private TextView keyboardStatus;
    private Button microphone;
    private Button screenCapture;
    private MediaPlayer player;
    private Runnable progress;
    private Runnable goBack;
    private Button audioButton;
    private SeekBar audioPosition;
    private int audioRequest;
    private boolean onHome;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(PAPER);
        getWindow().setNavigationBarColor(PAPER);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        showHome();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (onHome) refreshPermissions();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) refreshPermissions();
    }

    @Override
    protected void onStop() {
        releasePlayer();
        if (audioButton != null) {
            audioButton.setText("播放录音");
            audioButton.setEnabled(true);
            audioPosition.setProgress(0);
            audioPosition.setEnabled(false);
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        storage.shutdownNow();
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (goBack == null) super.onBackPressed();
        else goBack.run();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        ScreenCapture.onActivityResult(this, requestCode, resultCode, data);
        handler.postDelayed(this::refreshPermissions, 400);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == MIC_REQUEST && onHome) refreshPermissions();
    }

    private void showHome() {
        openPage("言墨", null);
        onHome = true;
        heading("试写", 22);
        EditText trial = add(new EditText(this));
        trial.setTextColor(INK);
        trial.setHintTextColor(LIGHT_INK);
        trial.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        trial.setMinLines(3);
        trial.setHint("在此试用言墨输入法");
        paragraph("长按空格说话，松手整理。", INK);
        divider();
        button("文稿", false, this::showHistory);
        button("文字 API 设置", false, this::showSettings);
        divider();
        heading("启用输入法", 22);
        keyboardStatus = paragraph("", LIGHT_INK);
        button("打开系统输入法设置", false,
                () -> startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)));
        button("切换输入法", false, () -> getSystemService(InputMethodManager.class).showInputMethodPicker());
        microphone = button("授权麦克风", false, this::requestMicrophone);
        screenCapture = button("开启录音时截屏", false, () -> {
            if (ScreenCapture.active()) {
                ScreenCapture.stop(this);
                handler.postDelayed(this::refreshPermissions, 300);
            } else {
                ScreenCapture.request(this);
            }
        });
        paragraph("截屏需经系统授权。开启后，随文稿保存录音结束时的屏幕画面。", LIGHT_INK);
        divider();
        refreshPermissions();
    }

    private void refreshPermissions() {
        if (!onHome) return;
        boolean enabled = false;
        for (InputMethodInfo item : getSystemService(InputMethodManager.class).getEnabledInputMethodList()) {
            if (getPackageName().equals(item.getPackageName())) {
                enabled = true;
                break;
            }
        }
        keyboardStatus.setText(enabled ? "系统已启用言墨输入法" : "请先在系统设置中启用言墨");
        boolean microphoneReady = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        microphone.setText(microphoneReady ? "麦克风已授权" : "授权麦克风");
        microphone.setEnabled(!microphoneReady);
        screenCapture.setText(ScreenCapture.active() ? "停止录音时截屏" : "开启录音时截屏");
    }

    private void requestMicrophone() {
        requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, MIC_REQUEST);
    }

    private void showSettings() {
        openPage("文字 API", this::showHome);
        SharedPreferences settings = Polish.settings(this);
        paragraph("启用后，言墨将识别原文发送到你配置的服务以生成整理稿。", LIGHT_INK);
        CheckBox enabled = add(new CheckBox(this));
        enabled.setText("启用自然整理");
        enabled.setTextColor(INK);
        enabled.setChecked(settings.getBoolean("enabled", false));
        EditText endpoint = editable("服务根地址", "https://api.deepseek.com/v1",
                settings.getString("endpoint", ""), InputType.TYPE_TEXT_VARIATION_URI);
        EditText model = editable("模型 ID", "", settings.getString("model", ""), InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        boolean hasKey = settings.contains("credential");
        EditText key = editable("API Key", hasKey ? "已保存，留空则继续使用" : "服务免密时可以留空", "",
                InputType.TYPE_TEXT_VARIATION_PASSWORD);
        key.setSaveEnabled(false);
        key.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        CheckBox clear = add(new CheckBox(this));
        clear.setTextColor(INK);
        clear.setText("移除已保存的 API Key");
        clear.setVisibility(hasKey ? View.VISIBLE : View.GONE);
        TextView error = paragraph("", OCHRE);
        error.setVisibility(View.GONE);
        button("保存设置", true, () -> {
            try {
                Polish.save(this, enabled.isChecked(), endpoint.getText().toString().trim(),
                        model.getText().toString().trim(), key.getText().toString().trim(), clear.isChecked());
                showHome();
            } catch (Exception failure) {
                error.setText(failure instanceof IOException ? failure.getMessage() : "无法安全保存 API Key，请稍后重试。");
                error.setVisibility(View.VISIBLE);
            }
        });
    }

    private void showHistory() {
        openPage("语稿历史", this::showHome);
        TextView status = paragraph("正在读取文稿…", LIGHT_INK);
        load(() -> {
            boolean retry = false;
            try {
                Manuscripts.migrate(this);
            } catch (IOException failure) {
                retry = true;
            }
            return new History(Manuscripts.summaries(this), retry);
        }, history -> {
            if (history.retryMigration) {
                status.setText("部分旧文稿尚未迁移，原文件已保留。");
                button("重试迁移", false, this::showHistory);
            } else if (history.entries.isEmpty()) {
                status.setText("录音识别后，文稿会出现在这里。");
                return;
            } else {
                page.removeView(status);
            }
            for (Manuscripts.Summary item : history.entries) {
                TextView title = paragraph(date(item.id), LIGHT_INK);
                TextView preview = paragraph(item.preview, INK);
                preview.setMaxLines(2);
                preview.setEllipsize(TextUtils.TruncateAt.END);
                title.setOnClickListener(view -> showEntry(item.id));
                preview.setOnClickListener(view -> showEntry(item.id));
                divider();
            }
            paragraph("文稿保存在设备上，可在详情中删除。", LIGHT_INK);
        }, () -> {
            status.setText("无法读取或迁移文稿，请重试。");
            button("重试", false, this::showHistory);
        });
    }

    private static final class History {
        final ArrayList<Manuscripts.Summary> entries;
        final boolean retryMigration;

        History(ArrayList<Manuscripts.Summary> entries, boolean retryMigration) {
            this.entries = entries;
            this.retryMigration = retryMigration;
        }
    }

    private static final class Entry {
        String error;
        String polished;
        String raw;
        String captureStatus;
        boolean audio;
        boolean screenshot;
        Bitmap thumbnail;
    }

    private void showEntry(String id) {
        openPage("文稿", this::showHistory);
        paragraph(date(id), LIGHT_INK);
        TextView status = paragraph("正在读取文稿…", LIGHT_INK);
        load(() -> {
            Entry entry = new Entry();
            entry.error = Manuscripts.read(this, id, "error");
            entry.polished = Manuscripts.read(this, id, "polished");
            entry.raw = Manuscripts.read(this, id, "raw");
            entry.audio = Manuscripts.size(this, id, "audio") > 44;
            entry.screenshot = Manuscripts.size(this, id, "screenshot") > 0;
            entry.captureStatus = Manuscripts.read(this, id, "capture-status");
            if (entry.screenshot) entry.thumbnail = decode(Manuscripts.media(this, id, "screenshot"), 420);
            return entry;
        }, entry -> {
            page.removeView(status);
            renderEntry(id, entry);
        }, () -> status.setText("无法读取已保存的文稿。"));
    }

    private void renderEntry(String id, Entry entry) {
        if (!entry.error.isEmpty()) paragraph(entry.error, OCHRE);
        entryText("整理稿", entry.polished, "尚无整理稿");
        entryText("识别原文", entry.raw, "尚无识别原文");
        if (entry.audio || entry.screenshot || !entry.captureStatus.isEmpty()) {
            divider();
            heading("附件", 22);
        }
        if (entry.audio) showAudio(id);
        if (entry.screenshot) showScreenshot(id, entry.thumbnail);
        else if (!entry.captureStatus.isEmpty()) paragraph(entry.captureStatus, LIGHT_INK);
        if (!Manuscripts.active(id)) {
            divider();
            button("删除文稿", false, () -> new AlertDialog.Builder(this)
                    .setTitle("删除这篇文稿？")
                    .setMessage("整理稿、识别原文、录音和截屏会一并删除。")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("删除", (dialog, which) -> {
                        releasePlayer();
                        load(() -> {
                            Manuscripts.delete(this, id);
                            return null;
                        }, ignored -> showHistory(),
                                () -> new AlertDialog.Builder(this).setMessage("无法删除文稿，请稍后重试。")
                                        .setPositiveButton("关闭", null).show());
                    }).show());
        } else {
            button("刷新文稿", false, () -> showEntry(id));
        }
    }

    private <T> void load(Callable<T> work, Consumer<T> loaded, Runnable failed) {
        LinearLayout destination = page;
        storage.execute(() -> {
            try {
                T value = work.call();
                handler.post(() -> {
                    if (page == destination && !isDestroyed() && !isFinishing()) loaded.accept(value);
                });
            } catch (Exception failure) {
                handler.post(() -> {
                    if (page == destination && !isDestroyed() && !isFinishing()) failed.run();
                });
            }
        });
    }

    private void entryText(String title, String value, String empty) {
        divider();
        heading(title, 22);
        TextView text = paragraph(value.isEmpty() ? empty : value, value.isEmpty() ? LIGHT_INK : INK);
        text.setTextIsSelectable(!value.isEmpty());
    }

    private void showAudio(String id) {
        TextView error = paragraph("", OCHRE);
        error.setVisibility(View.GONE);
        SeekBar position = add(new SeekBar(this));
        audioPosition = position;
        position.setContentDescription("录音播放进度");
        position.setEnabled(false);
        Button play = button("播放录音", false, () -> {});
        audioButton = play;
        play.setOnClickListener(view -> {
            try {
                if (player == null) {
                    error.setVisibility(View.GONE);
                    play.setEnabled(false);
                    play.setText("载入录音…");
                    int attempt = ++audioRequest;
                    load(() -> Manuscripts.openAudio(this, id), source -> {
                        if (attempt != audioRequest) {
                            if (source != null) source.close();
                            return;
                        }
                        try {
                            if (source == null) throw new IOException("Missing audio");
                            preparePlayback(source, error, play, position);
                        } catch (IOException | RuntimeException failure) {
                            if (source != null) source.close();
                            audioError(error, position, play);
                        }
                    }, () -> {
                        if (attempt == audioRequest) audioError(error, position, play);
                    });
                } else if (player.isPlaying()) {
                    player.pause();
                    play.setText("继续播放");
                    handler.removeCallbacks(progress);
                } else {
                    startPlayback(play, position);
                }
            } catch (RuntimeException failure) {
                audioError(error, position, play);
            }
        });
        position.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar bar, int value, boolean fromUser) {
                if (fromUser && player != null) player.seekTo(value);
            }

            @Override
            public void onStartTrackingTouch(SeekBar bar) {}

            @Override
            public void onStopTrackingTouch(SeekBar bar) {}
        });
    }

    private void preparePlayback(Manuscripts.AudioSource source, TextView error, Button play, SeekBar position)
            throws IOException {
        player = new MediaPlayer();
        player.setDataSource(source);
        player.setOnPreparedListener(ready -> {
            if (player != ready) return;
            try {
                play.setEnabled(true);
                position.setEnabled(true);
                position.setMax(ready.getDuration());
                startPlayback(play, position);
            } catch (RuntimeException failure) {
                audioError(error, position, play);
            }
        });
        player.setOnCompletionListener(ready -> {
            if (player != ready) return;
            ready.seekTo(0);
            play.setText("播放录音");
            position.setProgress(0);
            handler.removeCallbacks(progress);
        });
        player.setOnErrorListener((ready, what, extra) -> {
            if (player == ready) audioError(error, position, play);
            return true;
        });
        player.prepareAsync();
    }

    private void startPlayback(Button play, SeekBar position) {
        player.start();
        play.setText("暂停录音");
        progress = new Runnable() {
            @Override
            public void run() {
                if (player == null) return;
                position.setProgress(player.getCurrentPosition());
                handler.postDelayed(this, 250);
            }
        };
        handler.post(progress);
    }

    private void audioError(TextView error, SeekBar position, Button play) {
        releasePlayer();
        error.setText("无法播放录音，文件可能已损坏。");
        error.setVisibility(View.VISIBLE);
        position.setEnabled(false);
        play.setEnabled(true);
        play.setText("播放录音");
    }

    private void showScreenshot(String id, Bitmap thumbnail) {
        if (thumbnail == null) {
            paragraph("无法预览截屏，文件可能已损坏。", OCHRE);
            return;
        }
        ImageView preview = add(new ImageView(this));
        preview.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(180)));
        preview.setImageBitmap(thumbnail);
        preview.setContentDescription("放大录音时截屏");
        preview.setOnClickListener(view -> load(() -> decode(Manuscripts.media(this, id, "screenshot"), 1600),
                this::showEnlargedScreenshot, () -> showEnlargedScreenshot(null)));
    }

    private void showEnlargedScreenshot(Bitmap image) {
        if (image == null) {
            new AlertDialog.Builder(this).setMessage("无法预览截屏。").setPositiveButton("关闭", null).show();
            return;
        }
        ImageView enlarged = new ImageView(this);
        enlarged.setAdjustViewBounds(true);
        enlarged.setImageBitmap(image);
        enlarged.setContentDescription("录音时截屏");
        new AlertDialog.Builder(this).setTitle("录音时截屏").setView(enlarged)
                .setPositiveButton("关闭", null).show();
    }

    private static Bitmap decode(byte[] data, int maxDimension) {
        if (data == null) return null;
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, options);
        options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > maxDimension) {
            options.inSampleSize *= 2;
        }
        options.inJustDecodeBounds = false;
        return BitmapFactory.decodeByteArray(data, 0, data.length, options);
    }

    private void openPage(String title, Runnable back) {
        onHome = false;
        goBack = back;
        releasePlayer();
        audioButton = null;
        audioPosition = null;
        View focused = getCurrentFocus();
        if (focused instanceof EditText) {
            getSystemService(InputMethodManager.class).hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(PAPER);
        if (Build.VERSION.SDK_INT >= 30) {
            scroll.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(dp(24), dp(16), dp(24), dp(32));
        page.setFocusableInTouchMode(true);
        scroll.addView(page);
        setContentView(scroll);
        if (back != null) button("返回", false, back);
        heading(title, 34);
        divider();
    }

    private void releasePlayer() {
        audioRequest++;
        if (progress != null) handler.removeCallbacks(progress);
        progress = null;
        if (player != null) {
            player.release();
            player = null;
        }
    }

    private Button button(String title, boolean primary, Runnable action) {
        Button button = add(new Button(this));
        button.setText(title);
        button.setTextColor(primary ? CINNABAR : INK);
        button.setAllCaps(false);
        button.setGravity(android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL);
        GradientDrawable frame = new GradientDrawable();
        frame.setColor(PAPER);
        frame.setStroke(dp(1), primary ? CINNABAR : BORDER);
        button.setBackground(new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(0x181c1711), frame, null));
        button.setPadding(dp(14), 0, dp(14), 0);
        LinearLayout.LayoutParams row = new LinearLayout.LayoutParams(-1, dp(48));
        row.bottomMargin = dp(8);
        button.setLayoutParams(row);
        button.setOnClickListener(view -> action.run());
        return button;
    }

    private TextView heading(String title, int size) {
        TextView heading = paragraph(title, INK);
        heading.setTypeface(Typeface.SERIF);
        heading.setTextSize(size);
        if (Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        return heading;
    }

    private TextView paragraph(String text, int color) {
        TextView view = add(new TextView(this));
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(16);
        view.setPadding(0, dp(6), 0, dp(10));
        return view;
    }

    private EditText editable(String label, String hint, String value, int inputType) {
        TextView name = paragraph(label, INK);
        EditText field = add(new EditText(this));
        field.setId(View.generateViewId());
        name.setLabelFor(field.getId());
        field.setTextColor(INK);
        field.setHintTextColor(LIGHT_INK);
        field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | inputType);
        field.setHint(hint);
        field.setText(value);
        return field;
    }

    private void divider() {
        View line = add(new View(this));
        LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, dp(1));
        space.topMargin = dp(8);
        space.bottomMargin = dp(8);
        line.setLayoutParams(space);
        line.setBackgroundColor(BORDER);
    }

    private <T extends View> T add(T view) {
        page.addView(view);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String date(String id) {
        return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                .format(new Date(Long.parseLong(id.substring(0, id.indexOf('-')))));
    }
}
