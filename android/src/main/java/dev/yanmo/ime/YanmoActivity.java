package dev.yanmo.ime;

import android.Manifest;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;

import java.io.IOException;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class YanmoActivity extends ComponentActivity {
    private static final String OPEN_SETTINGS = "dev.yanmo.ime.OPEN_SETTINGS";
    private static final String SYSTEM_SETTINGS_ENTRY = "dev.yanmo.ime.SettingsEntry";
    private static final int MIC_REQUEST = 200;
    private static final String MIC_PROMPTED = "microphonePrompted";
    private static final String[] TABS = {"书案", "文稿", "词库", "设置"};
    private static final String[] TERM_GROUPS = {Lexicon.GLOBAL, Lexicon.AI_TOOLS};

    private enum Screen {
        DESK(0), TRIAL(0), HISTORY(1), MANUSCRIPT(1), DICTIONARY(2), TERM(2), SETTINGS(3), API(3);
        final int tab;
        Screen(int tab) { this.tab = tab; }
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService storage = Executors.newSingleThreadExecutor();
    private final Runnable permissionRefresh = this::refreshPermissions;
    private YanmoColors colors;
    private Screen screen;
    private LinearLayout page;
    private Runnable goBack;
    private String manuscriptId;
    private String termId;
    private String trialDraft = "";
    private int trialCursor;
    private String dictionaryQuery = "";
    private String dictionaryGroup;
    private boolean requestEnable;
    private TextView keyboardStatus;
    private Button setupAction;
    private LinearLayout recent;
    private YanmoSettings settingsView;
    private MediaPlayer player;
    private Runnable progress;
    private Button audioButton;
    private SeekBar audioPosition;
    private int audioRequest;

    @Override
    protected void onCreate(Bundle state) {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        setTheme(dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(state);
        colors = new YanmoColors(dark);
        getWindow().setStatusBarColor(colors.paper);
        getWindow().setNavigationBarColor(colors.paper);
        if (Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
                | WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            int appearance = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            View decor = getWindow().getDecorView();
            decor.post(() -> {
                android.view.WindowInsetsController controller = decor.getWindowInsetsController();
                if (controller != null) controller.setSystemBarsAppearance(dark ? 0 : appearance, appearance);
            });
        } else {
            getWindow().getDecorView().setSystemUiVisibility(dark ? 0 : View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }

        // Unsaved dictation and search text survive theme changes in memory only.
        Object retained = getLastCustomNonConfigurationInstance();
        if (retained instanceof Drafts) {
            Drafts drafts = (Drafts) retained;
            trialDraft = drafts.text;
            trialCursor = drafts.cursor;
            dictionaryQuery = drafts.search;
        }
        dictionaryGroup = state == null ? null : state.getString("dictionaryGroup");
        if (state != null) {
            restorePage(state);
        } else if (opensSettings(getIntent())) {
            showSettings();
        } else {
            showHome();
        }
    }

    private void restorePage(Bundle state) {
        Screen saved = Screen.valueOf(state.getString("screen", Screen.DESK.name()));
        switch (saved) {
            case DESK: showHome(); break;
            case TRIAL: showTrial(); break;
            case HISTORY: showHistory(); break;
            case MANUSCRIPT:
                String id = state.getString("manuscriptId");
                if (id == null) showHistory();
                else showEntry(id);
                break;
            case DICTIONARY: showDictionary(); break;
            case TERM: showTerm(state.getString("termId")); break;
            case SETTINGS: showSettings(); break;
            case API: showApiSettings(state.getBoolean("requestEnable")); break;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (opensSettings(intent)) showSettings();
    }

    public static Intent settingsIntent(Context context) {
        return new Intent(context, YanmoActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(OPEN_SETTINGS, true);
    }

    private static boolean opensSettings(Intent intent) {
        ComponentName component = intent.getComponent();
        return intent.getBooleanExtra(OPEN_SETTINGS, false)
                || (component != null && SYSTEM_SETTINGS_ENTRY.equals(component.getClassName()));
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("screen", screen.name());
        state.putString("manuscriptId", manuscriptId);
        state.putString("termId", termId);
        state.putString("dictionaryGroup", dictionaryGroup);
        state.putBoolean("requestEnable", requestEnable);
    }

    @Override
    public Object onRetainCustomNonConfigurationInstance() {
        return new Drafts(trialDraft, trialCursor, dictionaryQuery);
    }

    private static final class Drafts {
        final String text, search;
        final int cursor;

        Drafts(String text, int cursor, String search) {
            this.text = text;
            this.cursor = cursor;
            this.search = search;
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshPermissions();
        if (recent != null && recent.getChildCount() > 0) loadRecent();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) refreshPermissions();
    }

    @Override
    protected void onStop() {
        resetPlayback();
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        releasePlayer();
        storage.shutdown();
        handler.removeCallbacks(permissionRefresh);
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (goBack == null) super.onBackPressed();
        else goBack.run();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == MIC_REQUEST) refreshPermissions();
    }

    private void showHome() {
        openPage(Screen.DESK, "书案", null);
        keyboardStatus = paragraph("正在检查键盘…", colors.secondary);
        setupAction = button("启用言墨键盘", true, null);
        refreshPermissions();

        LinearLayout trialHeading = horizontal(page);
        TextView title = heading(trialHeading, "试写", 22);
        title.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        label(trialHeading, "长按空格说话", 14, colors.secondary);
        trialField(5);
        actionRow(page, "展开试写", "", this::showTrial);
        divider(page);

        LinearLayout recentHeading = horizontal(page);
        TextView recentTitle = heading(recentHeading, "最近文稿", 22);
        recentTitle.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        textAction(recentHeading, "查看全部", this::showHistory);
        recent = vertical();
        page.addView(recent);
        loadRecent();
    }

    private void showTrial() {
        openPage(Screen.TRIAL, "试写", this::showHome);
        paragraph("长按空格说话，松手结束。", colors.secondary);
        trialField(9);
    }

    private void trialField(int rows) {
        EditText trial = field(page, "在这里试写", trialDraft, InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        trial.setGravity(Gravity.TOP | Gravity.START);
        trial.setMinLines(rows);
        trial.setMaxLines(Math.max(rows, 12));
        trial.setPadding(dp(14), dp(12), dp(14), dp(12));
        trial.setBackgroundTintList(null);
        trial.setBackground(frame(colors.rule, false));
        trial.setSelection(Math.min(trialCursor, trial.length()));
        watchText(trial, value -> {
            trialDraft = value;
            trialCursor = Math.max(0, trial.getSelectionEnd());
        });
        trial.setOnFocusChangeListener((view, hasFocus) -> {
            if (!hasFocus) trialCursor = Math.max(0, trial.getSelectionEnd());
        });
    }

    private void loadRecent() {
        LinearLayout destination = recent;
        load(this::readHistory, history -> {
            destination.removeAllViews();
            if (history.retryMigration) {
                addParagraph(destination, "部分旧文稿尚未迁移，可在文稿页重试。", colors.warning);
            }
            if (history.entries.isEmpty()) {
                addParagraph(destination, "录音识别后，文稿会出现在这里。", colors.secondary);
            }
            for (Manuscripts.Summary item : history.entries.subList(0, Math.min(3, history.entries.size()))) {
                manuscriptRow(destination, item, shortDate(item.id));
            }
        }, () -> {
            destination.removeAllViews();
            addParagraph(destination, "无法读取文稿，请打开文稿页重试。", colors.warning);
        });
    }

    private void refreshPermissions() {
        if (settingsView != null) settingsView.refresh();
        if (keyboardStatus == null) return;
        boolean microphone = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        if (!isKeyboardEnabled()) {
            showSetup("请先启用言墨键盘", "去系统设置", this::manageKeyboard);
        } else if (!isKeyboardSelected()) {
            showSetup("言墨键盘已启用", "选用言墨键盘", this::manageKeyboard);
        } else if (!microphone) {
            if (getPreferences(MODE_PRIVATE).getBoolean(MIC_PROMPTED, false)
                    && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
                showSetup("请在应用权限中开启麦克风", "打开应用权限", this::openAppPermissions);
            } else {
                showSetup("请授权麦克风以使用听写", "授权麦克风", this::requestMicrophone);
            }
        } else {
            keyboardStatus.setText("▪  键盘已就绪");
            keyboardStatus.setTextColor(colors.ready);
            setupAction.setVisibility(View.GONE);
        }
    }

    boolean isKeyboardEnabled() {
        InputMethodManager manager = getSystemService(InputMethodManager.class);
        return manager != null && manager.getEnabledInputMethodList().stream()
                .map(InputMethodInfo::getPackageName).anyMatch(getPackageName()::equals);
    }

    boolean isKeyboardSelected() {
        String defaultIme = Settings.Secure.getString(getContentResolver(), Settings.Secure.DEFAULT_INPUT_METHOD);
        ComponentName selected = defaultIme == null ? null : ComponentName.unflattenFromString(defaultIme);
        return selected != null && getPackageName().equals(selected.getPackageName());
    }

    void manageKeyboard() {
        if (!isKeyboardEnabled()) {
            startActivity(new Intent(Settings.ACTION_INPUT_METHOD_SETTINGS));
        } else {
            InputMethodManager manager = getSystemService(InputMethodManager.class);
            if (manager != null) manager.showInputMethodPicker();
        }
    }

    private void showSetup(String message, String action, Runnable next) {
        keyboardStatus.setText(message);
        keyboardStatus.setTextColor(colors.secondary);
        setupAction.setText(action);
        setupAction.setVisibility(View.VISIBLE);
        setupAction.setOnClickListener(view -> next.run());
    }

    private void requestMicrophone() {
        getPreferences(MODE_PRIVATE).edit().putBoolean(MIC_PROMPTED, true).apply();
        requestPermissions(new String[] {Manifest.permission.RECORD_AUDIO}, MIC_REQUEST);
    }

    private void openAppPermissions() {
        startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null)));
    }

    private void showSettings() {
        openPage(Screen.SETTINGS, "", this::showHome);
        settingsView = new YanmoSettings(this, this::manageMicrophone, this::changeScreenshot, this::showApiSettings);
        page.addView(settingsView.getView(), new LinearLayout.LayoutParams(-1, -1));
    }

    private void changeScreenshot(boolean enabled) {
        if (!ScreenCapture.supported()) return;
        if (enabled || !ScreenCapture.disable()) {
            refreshPermissions();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
        } else {
            handler.postDelayed(permissionRefresh, 300);
        }
    }

    private void manageMicrophone() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                || (getPreferences(MODE_PRIVATE).getBoolean(MIC_PROMPTED, false)
                && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO))) {
            openAppPermissions();
        } else {
            requestMicrophone();
        }
    }

    private void showApiSettings(boolean enable) {
        openPage(Screen.API, "", this::showSettings);
        requestEnable = enable;
        page.addView(YanmoSettings.apiPage(this, enable, this::showSettings), new LinearLayout.LayoutParams(-1, -1));
    }

    private static final class History {
        final ArrayList<Manuscripts.Summary> entries;
        final boolean retryMigration;

        History(ArrayList<Manuscripts.Summary> entries, boolean retryMigration) {
            this.entries = entries;
            this.retryMigration = retryMigration;
        }
    }

    private History readHistory() {
        boolean retry = false;
        try {
            Manuscripts.migrate(this);
        } catch (IOException failure) {
            retry = true;
        }
        return new History(Manuscripts.summaries(this), retry);
    }

    private void showHistory() {
        openPage(Screen.HISTORY, "文稿", this::showHome);
        TextView status = paragraph("正在读取文稿…", colors.secondary);
        load(this::readHistory, history -> {
            if (history.retryMigration) {
                status.setText("部分旧文稿尚未迁移，原文件已保留。");
                button("重试迁移", false, this::showHistory);
            } else if (history.entries.isEmpty()) {
                status.setText("录音识别后，文稿会出现在这里。");
            } else {
                page.removeView(status);
            }
            String lastDay = "";
            for (Manuscripts.Summary item : history.entries) {
                String day = day(item.id);
                if (!day.equals(lastDay)) heading(page, day, 20);
                lastDay = day;
                manuscriptRow(page, item, time(item.id));
            }
        }, () -> {
            status.setText("无法读取文稿，请重试。");
            button("重试", false, this::showHistory);
        });
    }

    private void manuscriptRow(LinearLayout parent, Manuscripts.Summary item, String timestamp) {
        TextView preview = actionRow(parent, item.preview, timestamp, () -> showEntry(item.id));
        preview.setMaxLines(2);
        preview.setEllipsize(TextUtils.TruncateAt.END);
    }

    private static final class Entry {
        String error, polished, raw, captureStatus, diagnostics;
        boolean audio, screenshot;
    }

    private void showEntry(String id) {
        openPage(Screen.MANUSCRIPT, "文稿", this::showHistory);
        manuscriptId = id;
        paragraph(shortDate(id), colors.secondary);
        TextView status = paragraph("正在读取文稿…", colors.secondary);
        load(() -> {
            Entry entry = new Entry();
            entry.error = Manuscripts.read(this, id, "error");
            entry.polished = Manuscripts.read(this, id, "polished");
            entry.raw = Manuscripts.read(this, id, "raw");
            entry.audio = Manuscripts.size(this, id, "audio") > 44;
            entry.screenshot = Manuscripts.size(this, id, "screenshot") > 0;
            entry.captureStatus = Manuscripts.read(this, id, "capture-status");
            entry.diagnostics = Manuscripts.diagnostics(this, id);
            return entry;
        }, entry -> {
            page.removeView(status);
            renderEntry(id, entry);
        }, () -> status.setText("无法读取已保存的文稿。"));
    }

    private void renderEntry(String id, Entry entry) {
        if (!entry.error.isEmpty()) paragraph(entry.error, colors.warning);
        String body = entry.polished.isEmpty() ? entry.raw : entry.polished;
        heading(page, "正文", 22);
        selectableText(page, body, "尚无正文");
        if (!body.isEmpty()) button("复制正文", true, () -> copyBody(body));
        disclosure("识别原文", "", panel -> selectableText(panel, entry.raw, "尚无识别原文"), null);
        boolean media = entry.audio || entry.screenshot;
        String mediaLabel = entry.audio && entry.screenshot ? "录音 · 截屏"
                : entry.audio ? "录音" : entry.screenshot ? "截屏" : "";
        if (media || !entry.captureStatus.isEmpty()) {
            disclosure("附件", mediaLabel, panel -> {
                if (entry.audio) showAudio(panel, id);
                if (entry.screenshot) {
                    TextView loading = addParagraph(panel, "正在读取截屏…", colors.secondary);
                    load(() -> decode(Manuscripts.media(this, id, "screenshot"), 420), thumbnail -> {
                        panel.removeView(loading);
                        showScreenshot(panel, id, thumbnail);
                    }, () -> loading.setText("无法读取截屏。"));
                } else if (!entry.captureStatus.isEmpty()) {
                    addParagraph(panel, entry.captureStatus, colors.secondary);
                }
            }, this::resetPlayback);
        }
        if (!entry.diagnostics.isEmpty()) {
            disclosure("听写诊断", "", panel -> selectableText(panel, entry.diagnostics, ""), null);
        }
        if (Manuscripts.active(id)) {
            actionRow(page, "刷新文稿", "", () -> showEntry(id));
        } else {
            actionRow(page, "删除文稿", "", () -> new AlertDialog.Builder(this)
                    .setTitle("删除这篇文稿？")
                    .setMessage("正文、识别原文、录音和截屏会一并删除。")
                    .setNegativeButton("取消", null)
                    .setPositiveButton("删除", (dialog, which) -> {
                        releasePlayer();
                        load(() -> {
                            Manuscripts.delete(this, id);
                            return null;
                        }, ignored -> showHistory(), () -> toast("无法删除文稿，请稍后重试。"));
                    }).show());
        }
    }

    private void copyBody(String body) {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("言墨文稿", body));
        if (Build.VERSION.SDK_INT < 33) toast("已复制正文");
    }

    private void disclosure(String title, String detail, Consumer<LinearLayout> content, Runnable onClose) {
        LinearLayout panel = vertical();
        panel.setVisibility(View.GONE);
        TextView row = actionRow(page, "▸  " + title, detail, null);
        View control = (View) row.getParent();
        control.setContentDescription(detail.isEmpty() ? title : title + "，" + detail);
        if (Build.VERSION.SDK_INT >= 30) control.setStateDescription("已折叠");
        onTap(control, () -> {
            boolean opening = panel.getVisibility() != View.VISIBLE;
            if (opening && panel.getChildCount() == 0) content.accept(panel);
            panel.setVisibility(opening ? View.VISIBLE : View.GONE);
            row.setText((opening ? "▾  " : "▸  ") + title);
            if (Build.VERSION.SDK_INT >= 30) control.setStateDescription(opening ? "已展开" : "已折叠");
            if (!opening && onClose != null) onClose.run();
        });
        page.addView(panel);
    }

    private void showDictionary() {
        openPage(Screen.DICTIONARY, "词库", this::showHome,
                header -> button(header, "添加词条", true, () -> showTerm(null)));
        EditText search = field(page, "搜索词条", dictionaryQuery, InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        LinearLayout filters = horizontal(page);
        LinearLayout results = vertical();
        page.addView(results);
        paragraph("词条按听写命中次数和最近命中排序，用于本地识别。启用文字整理时，相关词条也会发送到你配置的文字 API。", colors.secondary);
        addParagraph(results, "正在读取词库…", colors.secondary);
        load(() -> Lexicon.list(this), entries -> {
            dictionaryQuery = search.getText().toString();
            Consumer<String> select = group -> {
                dictionaryGroup = group;
                renderFilters(filters);
                renderTerms(results, entries);
            };
            addFilter(filters, "全部", null, select);
            for (String group : TERM_GROUPS) addFilter(filters, Lexicon.groupLabel(group), group, select);
            renderFilters(filters);
            renderTerms(results, entries);
            watchText(search, query -> {
                dictionaryQuery = query;
                renderTerms(results, entries);
            });
        }, () -> {
            results.removeAllViews();
            addParagraph(results, "无法读取词库，请重试。", colors.warning);
            textAction(results, "重试", this::showDictionary);
        });
    }

    private void addFilter(LinearLayout filters, String label, String group, Consumer<String> select) {
        TextView filter = textAction(filters, label, () -> select.accept(group));
        filter.setTag(group);
    }

    private void renderFilters(LinearLayout filters) {
        for (int i = 0; i < filters.getChildCount(); i++) {
            TextView filter = (TextView) filters.getChildAt(i);
            boolean selected = TextUtils.equals(dictionaryGroup, (String) filter.getTag());
            filter.setSelected(selected);
            filter.setTextColor(selected ? colors.accent : colors.secondary);
        }
    }

    private void renderTerms(LinearLayout results, List<Lexicon.Entry> entries) {
        results.removeAllViews();
        String needle = dictionaryQuery.trim().toLowerCase(Locale.ROOT);
        for (Lexicon.Entry term : entries) {
            if (dictionaryGroup != null && !dictionaryGroup.equals(term.group)) continue;
            if (!term.term.toLowerCase(Locale.ROOT).contains(needle)) continue;
            actionRow(results, term.term, Lexicon.groupLabel(term.group) + " · " + term.matchCount + " 次命中",
                    () -> showTerm(term.id));
        }
        if (results.getChildCount() == 0) {
            addParagraph(results, entries.isEmpty() ? "添加常用专名，帮助整理识别结果。" : "没有符合条件的词条。", colors.secondary);
        }
    }

    private void showTerm(String id) {
        openPage(Screen.TERM, id == null ? "添加词条" : "编辑词条", this::showDictionary);
        termId = id;
        if (id == null) {
            renderTerm(null);
            return;
        }
        TextView status = paragraph("正在读取词条…", colors.secondary);
        load(() -> {
            for (Lexicon.Entry term : Lexicon.list(this)) if (id.equals(term.id)) return term;
            return null;
        }, entry -> {
            if (entry == null) status.setText("该词条已移除。");
            else {
                page.removeView(status);
                renderTerm(entry);
            }
        }, () -> status.setText("无法读取该词条。"));
    }

    private void renderTerm(Lexicon.Entry entry) {
        EditText term = editable("词条", "例如：云杉工作室", entry == null ? "" : entry.term,
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        heading(page, "分类", 20);
        RadioGroup groups = add(new RadioGroup(this));
        groups.setOrientation(LinearLayout.VERTICAL);
        for (String group : TERM_GROUPS) {
            RadioButton selection = new RadioButton(this);
            selection.setId(View.generateViewId());
            selection.setTag(group);
            selection.setText(Lexicon.groupLabel(group));
            selection.setTextColor(colors.ink);
            selection.setMinHeight(dp(48));
            selection.setButtonTintList(colors.toggleTint());
            groups.addView(selection);
            String current = entry == null ? dictionaryGroup : entry.group;
            if (group.equals(current == null ? Lexicon.GLOBAL : current)) groups.check(selection.getId());
        }
        TextView error = paragraph("", colors.warning);
        error.setVisibility(View.GONE);
        Button save = button("保存词条", true, null);
        save.setOnClickListener(view -> {
            String value = term.getText().toString();
            String group = (String) groups.findViewById(groups.getCheckedRadioButtonId()).getTag();
            String id = entry == null ? null : entry.id;
            save.setEnabled(false);
            load(() -> {
                try {
                    Lexicon.save(this, id, value, group);
                    return "";
                } catch (IOException failure) {
                    return failure.getMessage() == null ? "无法保存词条。" : failure.getMessage();
                }
            }, warning -> {
                if (warning.isEmpty()) showDictionary();
                else showTermError(error, save, warning);
            }, () -> showTermError(error, save, "无法保存词条，请重试。"));
        });
        if (entry != null) actionRow(page, "删除词条", "", () -> new AlertDialog.Builder(this)
                .setTitle("删除这个词条？")
                .setNegativeButton("取消", null)
                .setPositiveButton("删除", (dialog, which) -> load(() -> {
                    Lexicon.remove(this, entry.id);
                    return null;
                }, ignored -> showDictionary(), () -> toast("无法删除词条，请稍后重试。")))
                .show());
    }

    private static void showTermError(TextView error, Button save, String message) {
        error.setText(message);
        error.setVisibility(View.VISIBLE);
        save.setEnabled(true);
    }

    private <T> void load(Callable<T> work, Consumer<T> loaded, Runnable failed) {
        LinearLayout destination = page;
        storage.execute(() -> {
            try {
                T value = work.call();
                handler.post(() -> {
                    if (page == destination && !isDestroyed() && !isFinishing()) loaded.accept(value);
                    else if (value instanceof Manuscripts.AudioSource) ((Manuscripts.AudioSource) value).close();
                });
            } catch (Exception failure) {
                handler.post(() -> {
                    if (page == destination && !isDestroyed() && !isFinishing()) failed.run();
                });
            }
        });
    }

    private void selectableText(LinearLayout parent, String value, String empty) {
        TextView text = addParagraph(parent, value.isEmpty() ? empty : value,
                value.isEmpty() ? colors.secondary : colors.ink);
        text.setTextIsSelectable(!value.isEmpty());
    }

    private void showAudio(LinearLayout panel, String id) {
        TextView error = addParagraph(panel, "", colors.warning);
        error.setVisibility(View.GONE);
        SeekBar position = new SeekBar(this);
        position.setProgressTintList(ColorStateList.valueOf(colors.accent));
        position.setThumbTintList(ColorStateList.valueOf(colors.accent));
        panel.addView(position);
        audioPosition = position;
        position.setContentDescription("录音播放进度");
        position.setEnabled(false);
        Button play = button(panel, "播放录音", false, null);
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

    private void showScreenshot(LinearLayout panel, String id, Bitmap thumbnail) {
        if (thumbnail == null) {
            addParagraph(panel, "无法预览截屏，文件可能已损坏。", colors.warning);
            return;
        }
        ImageView preview = new ImageView(this);
        panel.addView(preview);
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

    private void openPage(Screen next, String title, Runnable back) {
        openPage(next, title, back, null);
    }

    private void openPage(Screen next, String title, Runnable back, Consumer<LinearLayout> headerAction) {
        View focused = getCurrentFocus();
        if (focused instanceof EditText || (screen == Screen.API && focused != null)) {
            InputMethodManager keyboard = getSystemService(InputMethodManager.class);
            if (keyboard != null) keyboard.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
        releasePlayer();
        audioButton = null;
        audioPosition = null;
        keyboardStatus = null;
        setupAction = null;
        settingsView = null;
        recent = null;
        manuscriptId = null;
        termId = null;
        requestEnable = false;
        screen = next;
        goBack = back;

        LinearLayout root = vertical();
        root.setBackgroundColor(colors.paper);
        if (Build.VERSION.SDK_INT >= 29) root.setForceDarkAllowed(false);
        LinearLayout brand = horizontal(root);
        brand.setPadding(dp(20), 0, dp(20), 0);
        brand.setMinimumHeight(dp(52));
        ImageView logo = new ImageView(this);
        logo.setImageDrawable(getApplicationInfo().loadIcon(getPackageManager()));
        logo.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        LinearLayout.LayoutParams mark = new LinearLayout.LayoutParams(dp(29), dp(29));
        mark.setMarginEnd(dp(10));
        brand.addView(logo, mark);
        TextView name = label(brand, "言墨", 21, colors.ink);
        name.setTypeface(Typeface.SERIF);
        TextView caption = label(brand, "语音输入", 14, colors.secondary);
        caption.setPadding(dp(12), 0, 0, 0);
        rule(root);

        page = vertical();
        page.setFocusableInTouchMode(true);
        if (next == Screen.SETTINGS || next == Screen.API) {
            root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
        } else {
            ScrollView scroll = new ScrollView(this);
            root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
            scroll.setFillViewport(true);
            page.setPadding(dp(22), dp(14), dp(22), dp(24));
            scroll.addView(page, new ScrollView.LayoutParams(-1, -2));
            if (next == Screen.TRIAL || next == Screen.MANUSCRIPT || next == Screen.TERM) {
                textAction(page, "‹  返回", back);
            }
            LinearLayout header = horizontal(page);
            TextView heading = heading(header, title, 32);
            heading.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
            if (headerAction != null) headerAction.accept(header);
            divider(page);
        }

        LinearLayout navigation = vertical();
        root.addView(navigation, new LinearLayout.LayoutParams(-1, -2));
        rule(navigation);
        LinearLayout tabs = horizontal(navigation);
        tabs.setBaselineAligned(false);
        for (int tab = 0; tab < TABS.length; tab++) {
            final int index = tab;
            boolean selected = tab == screen.tab;
            LinearLayout item = new LinearLayout(this);
            item.setGravity(Gravity.CENTER);
            item.setMinimumHeight(dp(54));
            tabs.addView(item, new LinearLayout.LayoutParams(0, -2, 1));
            if (selected) {
                View stroke = new View(this);
                stroke.setBackgroundColor(colors.accent);
                LinearLayout.LayoutParams indicator = new LinearLayout.LayoutParams(dp(2), dp(16));
                indicator.setMarginEnd(dp(6));
                item.addView(stroke, indicator);
            }
            TextView label = label(item, TABS[tab], 17, selected ? colors.accent : colors.ink);
            label.setTypeface(Typeface.SERIF);
            item.setSelected(selected);
            item.setContentDescription(TABS[tab]);
            label.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            onTap(item, () -> showTab(index));
        }
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets padding = insets.getInsets(WindowInsets.Type.systemBars()
                        | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(padding.left, padding.top, padding.right, padding.bottom);
                int furniture = insets.isVisible(WindowInsets.Type.ime()) ? View.GONE : View.VISIBLE;
                if (navigation.getVisibility() != furniture) navigation.setVisibility(furniture);
                return WindowInsets.CONSUMED;
            });
        }
        setContentView(root);
        page.requestFocus();
    }

    private void showTab(int tab) {
        switch (tab) {
            case 0: showHome(); break;
            case 1: showHistory(); break;
            case 2: showDictionary(); break;
            case 3: showSettings(); break;
        }
    }

    private void resetPlayback() {
        releasePlayer();
        if (audioButton == null) return;
        audioButton.setText("播放录音");
        audioButton.setEnabled(true);
        audioPosition.setProgress(0);
        audioPosition.setEnabled(false);
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
        return button(page, title, primary, action);
    }

    private Button button(LinearLayout parent, String title, boolean primary, Runnable action) {
        Button button = new Button(this);
        button.setText(title);
        button.setTextColor(primary ? colors.accent : colors.ink);
        button.setTextSize(16);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinimumHeight(dp(48));
        button.setMinHeight(dp(48));
        button.setElevation(0);
        button.setStateListAnimator(null);
        button.setBackground(frame(primary ? colors.accent : colors.rule, true));
        button.setPadding(dp(16), dp(6), dp(16), dp(6));
        LinearLayout.LayoutParams row = new LinearLayout.LayoutParams(-2, -2);
        row.topMargin = dp(4);
        row.bottomMargin = dp(8);
        parent.addView(button, row);
        if (action != null) button.setOnClickListener(view -> action.run());
        return button;
    }

    private RippleDrawable frame(int border, boolean pressable) {
        GradientDrawable outline = new GradientDrawable();
        outline.setColor(colors.paper);
        outline.setStroke(dp(1), border);
        return new RippleDrawable(ColorStateList.valueOf(pressable ? colors.pressed : 0), outline, null);
    }

    private TextView heading(LinearLayout parent, String title, int size) {
        TextView heading = label(parent, title, size, colors.ink);
        heading.setTypeface(Typeface.SERIF);
        heading.setPadding(0, dp(10), 0, dp(8));
        heading.setAccessibilityHeading(true);
        return heading;
    }

    private TextView paragraph(String text, int color) {
        return addParagraph(page, text, color);
    }

    private TextView addParagraph(LinearLayout parent, String text, int color) {
        TextView view = label(parent, text, 16, color);
        view.setLineSpacing(dp(4), 1f);
        view.setPadding(0, dp(6), 0, dp(10));
        return view;
    }

    private TextView label(LinearLayout parent, String text, int size, int color) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(color);
        view.setTextSize(size);
        parent.addView(view, new LinearLayout.LayoutParams(-2, -2));
        return view;
    }

    private TextView textAction(LinearLayout parent, String text, Runnable action) {
        TextView view = label(parent, text, 15, colors.accent);
        view.setMinHeight(dp(48));
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setPadding(dp(8), 0, dp(8), 0);
        onTap(view, action);
        return view;
    }

    private void onTap(View view, Runnable action) {
        view.setFocusable(true);
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(colors.pressed), null, mask()));
        view.setOnClickListener(ignored -> action.run());
    }

    private android.graphics.drawable.Drawable mask() {
        return new android.graphics.drawable.ColorDrawable(android.graphics.Color.WHITE);
    }

    private TextView actionRow(LinearLayout parent, String title, String detail, Runnable action) {
        LinearLayout row = horizontal(parent);
        row.setMinimumHeight(dp(49));
        row.setPadding(0, dp(7), 0, dp(7));
        TextView name = label(row, title, 16, colors.ink);
        name.setLayoutParams(new LinearLayout.LayoutParams(0, -2, 1));
        if (!detail.isEmpty()) {
            TextView value = label(row, detail, 14, colors.secondary);
            value.setPadding(dp(10), 0, 0, 0);
        }
        if (action != null) {
            TextView chevron = label(row, "›", 20, colors.secondary);
            chevron.setPadding(dp(8), 0, 0, 0);
            chevron.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            onTap(row, action);
        }
        rule(parent);
        return name;
    }

    private EditText editable(String title, String hint, String value, int inputType) {
        TextView name = paragraph(title, colors.ink);
        EditText field = field(page, hint, value, inputType);
        field.setId(View.generateViewId());
        name.setLabelFor(field.getId());
        return field;
    }

    private EditText field(LinearLayout parent, String hint, String value, int inputType) {
        EditText field = new EditText(this);
        boolean multiLine = (inputType & InputType.TYPE_TEXT_FLAG_MULTI_LINE) != 0;
        field.setSingleLine(!multiLine);
        field.setInputType(InputType.TYPE_CLASS_TEXT | inputType);
        field.setTextColor(colors.ink);
        field.setHintTextColor(colors.secondary);
        field.setBackgroundTintList(colors.fieldTint());
        field.setTextSize(17);
        field.setHint(hint);
        field.setText(value);
        field.setSaveEnabled(false);
        field.setMinHeight(dp(48));
        parent.addView(field, new LinearLayout.LayoutParams(-1, -2));
        return field;
    }

    private static void watchText(EditText field, Consumer<String> changed) {
        field.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {}
            @Override public void afterTextChanged(Editable text) { changed.accept(text.toString()); }
        });
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout horizontal(LinearLayout parent) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        parent.addView(row, new LinearLayout.LayoutParams(-1, -2));
        return row;
    }

    private void divider(LinearLayout parent) {
        View line = new View(this);
        line.setBackgroundColor(colors.rule);
        LinearLayout.LayoutParams space = new LinearLayout.LayoutParams(-1, dp(1));
        space.topMargin = dp(8);
        space.bottomMargin = dp(8);
        parent.addView(line, space);
    }

    private void rule(LinearLayout parent) {
        View line = new View(this);
        line.setBackgroundColor(colors.rule);
        parent.addView(line, new LinearLayout.LayoutParams(-1, dp(1)));
    }

    private <T extends View> T add(T view) {
        page.addView(view);
        return view;
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private String shortDate(String id) {
        return day(id) + " · " + time(id);
    }

    private static String day(String id) {
        Date created = createdAt(id);
        return created == null ? "未知日期" : DateFormat.getDateInstance(DateFormat.MEDIUM).format(created);
    }

    private String time(String id) {
        Date created = createdAt(id);
        return created == null ? "" : android.text.format.DateFormat.getTimeFormat(this).format(created);
    }

    private static Date createdAt(String id) {
        int separator = id.indexOf('-');
        if (separator <= 0) return null;
        try {
            return new Date(Long.parseLong(id.substring(0, separator)));
        } catch (NumberFormatException invalid) {
            return null;
        }
    }
}
