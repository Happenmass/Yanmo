package dev.yanmo.ime;

import android.content.SharedPreferences;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import com.kingzcheung.xime.service.XimeInputMethodService;

/** Uses CyIME's keyboard surfaces and dispatches held space gestures to Yanmo dictation. */
public final class YanmoInputMethodService extends XimeInputMethodService {
    private final VoiceIndicator indicator = new VoiceIndicator();
    private VoiceSession voice;
    private SpaceHoldGesture gesture;

    @Override public void onCreate() {
        SharedPreferences prefs = getSharedPreferences("kime_settings", MODE_PRIVATE);
        prefs.edit().putBoolean("stt_enabled", false)
                .putString("keyboard_theme", "cream_beige").putInt("dark_mode", 0)
                .putString("space_hold_action", "VOICE_TOGGLE")
                .putString("cursor_gesture_mode", "NONE")
                .putFloat("cursor_hold_seconds", PrototypeBuild.SOURCE_HOOK ? 0.4f : 0.6f)
                .putBoolean("voice_swipe_cancel", true)
                .apply();
        super.onCreate();
        voice = new VoiceSession(this, PrototypeBuild.SPEECH_PACKAGE, indicator::show);
    }

    @Override public View onCreateInputView() {
        View keyboard = super.onCreateInputView();
        indicator.attach(keyboard);
        if (!PrototypeBuild.SOURCE_HOOK) {
            if (gesture != null) gesture.detach();
            gesture = new SpaceHoldGesture(keyboard, getWindow().getWindow(), voice);
        }
        return keyboard;
    }

    @Override public void onStartInput(EditorInfo attribute, boolean restarting) {
        endEditorSession();
        super.onStartInput(attribute, restarting);
    }

    @Override public void onFinishInputView(boolean finishingInput) {
        endEditorSession();
        super.onFinishInputView(finishingInput);
    }

    @Override public void onFinishInput() {
        endEditorSession();
        super.onFinishInput();
    }

    @Override public void onDestroy() {
        endEditorSession();
        if (voice != null) voice.destroy();
        if (gesture != null) gesture.detach();
        gesture = null;
        indicator.close();
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

    private void endEditorSession() {
        if (gesture != null) gesture.cancelActiveGesture();
        if (voice != null) voice.editorEnded();
    }
}
