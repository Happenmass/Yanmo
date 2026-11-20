package dev.yanmo.ime;

import android.content.SharedPreferences;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import com.kingzcheung.xime.service.XimeInputMethodService;

/** Uses CyIME's keyboard surfaces and dispatches held space gestures to Yanmo dictation. */
public final class YanmoInputMethodService extends XimeInputMethodService {
    private VoiceSession voice;

    @Override public void onCreate() {
        SharedPreferences prefs = getSharedPreferences("kime_settings", MODE_PRIVATE);
        prefs.edit().putString("keyboard_theme", "cream_beige").putInt("dark_mode", 2)
                .putString("space_hold_action", "VOICE_TOGGLE")
                .putString("cursor_gesture_mode", "NONE")
                .putFloat("cursor_hold_seconds", 0.4f)
                .putBoolean("t9_merge_zero_enter", true)
                .putBoolean("language_key_ime_picker", false)
                .putBoolean("voice_swipe_cancel", true)
                .apply();
        super.onCreate();
        voice = new VoiceSession(this, PrototypeBuild.SPEECH_PACKAGE,
                this::updateYanmoDictationStage, this::yanmoComposing);
    }

    @Override public void onStartInput(EditorInfo attribute, boolean restarting) {
        endEditorSession("onStartInput; restarting=" + restarting);
        super.onStartInput(attribute, restarting);
    }

    @Override public void onFinishInputView(boolean finishingInput) {
        endEditorSession("onFinishInputView; finishingInput=" + finishingInput);
        super.onFinishInputView(finishingInput);
    }

    @Override public void onFinishInput() {
        endEditorSession("onFinishInput");
        super.onFinishInput();
    }

    @Override public void onDestroy() {
        endEditorSession("onDestroy");
        if (voice != null) voice.destroy();
        super.onDestroy();
    }

    public void onDictationHoldStart() {
        voice.start();
    }

    public void onDictationHoldEnd() {
        voice.stop();
    }

    public void onDictationHoldCancel() {
        voice.cancel();
    }

    @Override protected void onYanmoManualCommit(InputConnection editor, String text) {
        if (voice != null) voice.manualCommit(editor, text);
    }

    @Override public void onYanmoEditorAction(InputConnection editor) {
        if (voice != null) voice.submitCorrection(editor);
    }

    private void endEditorSession(String event) {
        if (voice != null) voice.editorEnded(event);
    }
}
