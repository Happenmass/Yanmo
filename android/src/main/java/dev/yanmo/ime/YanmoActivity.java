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

import java.io.File;
import java.io.IOException;
import java.text.DateFormat;
import java.util.Date;

public final class YanmoActivity extends Activity {
    private static final int PAPER = Color.rgb(248, 245, 236);
    private static final int INK = Color.rgb(43, 37, 31);
    private static final int LIGHT_INK = Color.rgb(99, 88, 74);
    private static final int BORDER = Color.rgb(214, 206, 191);
    private static final int CINNABAR = Color.rgb(156, 49, 37);
    private static final int OCHRE = Color.rgb(123, 76, 31);
    private static final int MIC_REQUEST = 200;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private LinearLayout page;
    private TextView keyboardStatus;
    private Button microphone;
    private Button screenCapture;
    private MediaPlayer player;
    private Runnable progress;
    private Runnable goBack;
    private Button audioButton;
    private SeekBar audioPosition;
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
        String[] ids = Manuscripts.history(this);
        if (ids.length == 0) {
            paragraph("录音识别后，文稿会出现在这里。", LIGHT_INK);
            return;
        }
        for (String id : ids) {
            TextView title = paragraph(date(id), LIGHT_INK);
            TextView preview = paragraph(preview(id), INK);
            preview.setMaxLines(2);
            preview.setEllipsize(TextUtils.TruncateAt.END);
            title.setOnClickListener(view -> showEntry(id));
            preview.setOnClickListener(view -> showEntry(id));
            divider();
        }
        paragraph("文稿保存在设备上，可在详情中删除。", LIGHT_INK);
    }

    private String preview(String id) {
        try {
            String text = Manuscripts.read(this, id, "polished");
            if (!text.isEmpty()) return text;
            text = Manuscripts.read(this, id, "raw");
            if (!text.isEmpty()) return text;
            String error = Manuscripts.read(this, id, "error");
            if (!error.isEmpty()) return error;
            if (Manuscripts.audio(this, id).length() > 44) return "录音";
            return "录音未完成";
        } catch (IOException failure) {
            return "无法读取文稿";
        }
    }

    private void showEntry(String id) {
        openPage("文稿", this::showHistory);
        paragraph(date(id), LIGHT_INK);
        try {
            String error = Manuscripts.read(this, id, "error");
            if (!error.isEmpty()) paragraph(error, OCHRE);
            entryText("整理稿", Manuscripts.read(this, id, "polished"), "尚无整理稿");
            entryText("识别原文", Manuscripts.read(this, id, "raw"), "尚无识别原文");
        } catch (IOException failure) {
            paragraph("无法读取已保存的文稿。", OCHRE);
        }
        File audio = Manuscripts.audio(this, id);
        File screenshot = Manuscripts.screenshot(this, id);
        String captureStatus = "";
        if (screenshot.length() == 0) {
            try {
                captureStatus = Manuscripts.read(this, id, "capture-status");
            } catch (IOException failure) {
                captureStatus = "无法读取截屏状态。";
            }
        }
        if (audio.length() > 44 || screenshot.length() > 0 || !captureStatus.isEmpty()) {
            divider();
            heading("附件", 22);
        }
        if (audio.length() > 44) showAudio(audio);
        if (screenshot.length() > 0) showScreenshot(screenshot);
        if (!captureStatus.isEmpty()) paragraph(captureStatus, LIGHT_INK);
        if (!Manuscripts.active(id)) {
            divider();
            button("删除文稿", false, () -> new AlertDialog.Builder(this)
                    .setTitle("删除这篇文稿？")
                    .setMessage("整理稿、识别原文、录音和截屏会一并删除。")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("删除", (dialog, which) -> {
                        releasePlayer();
                        try {
                            Manuscripts.delete(this, id);
                            showHistory();
                        } catch (IOException failure) {
                            new AlertDialog.Builder(this).setMessage(failure.getMessage())
                                    .setPositiveButton("关闭", null).show();
                        }
                    }).show());
        } else {
            button("刷新文稿", false, () -> showEntry(id));
        }
    }

    private void entryText(String title, String value, String empty) {
        divider();
        heading(title, 22);
        TextView text = paragraph(value.isEmpty() ? empty : value, value.isEmpty() ? LIGHT_INK : INK);
        text.setTextIsSelectable(!value.isEmpty());
    }

    private void showAudio(File audio) {
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
                    player = new MediaPlayer();
                    player.setDataSource(audio.getAbsolutePath());
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
                    player.setOnCompletionListener(ignored -> {
                        if (player != null) player.seekTo(0);
                        play.setText("播放录音");
                        position.setProgress(0);
                        handler.removeCallbacks(progress);
                    });
                    player.setOnErrorListener((ignored, what, extra) -> {
                        audioError(error, position, play);
                        return true;
                    });
                    player.prepareAsync();
                } else if (player.isPlaying()) {
                    player.pause();
                    play.setText("继续播放");
                    handler.removeCallbacks(progress);
                } else {
                    startPlayback(play, position);
                }
            } catch (IOException | RuntimeException failure) {
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

    private void showScreenshot(File file) {
        Bitmap thumbnail = decode(file, 420);
        if (thumbnail == null) {
            paragraph("无法预览截屏，文件可能已损坏。", OCHRE);
            return;
        }
        ImageView preview = add(new ImageView(this));
        preview.setLayoutParams(new LinearLayout.LayoutParams(-1, dp(180)));
        preview.setImageBitmap(thumbnail);
        preview.setContentDescription("放大录音时截屏");
        preview.setOnClickListener(view -> {
            Bitmap image = decode(file, 1600);
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
        });
    }

    private static Bitmap decode(File file, int maxDimension) {
        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(file.getAbsolutePath(), options);
        options.inSampleSize = 1;
        while (Math.max(options.outWidth, options.outHeight) / options.inSampleSize > maxDimension) {
            options.inSampleSize *= 2;
        }
        options.inJustDecodeBounds = false;
        return BitmapFactory.decodeFile(file.getAbsolutePath(), options);
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
