package dev.yanmo.ime;

import android.content.Context;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;

final class EditorContext {
    static final EditorContext EMPTY = new EditorContext("", "");

    final String before;
    final String after;

    private EditorContext(String before, String after) {
        this.before = before;
        this.after = after;
    }

    static boolean enabled(Context app) {
        return Polish.settings(app).getBoolean("read_context", false);
    }

    static void setEnabled(Context app, boolean enabled) {
        Polish.settings(app).edit().putBoolean("read_context", enabled).apply();
    }

    static boolean privateEditor(EditorInfo info) {
        return (info.imeOptions & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0;
    }

    static EditorContext capture(InputConnection editor) {
        try {
            return of(editor.getTextBeforeCursor(300, 0), editor.getTextAfterCursor(300, 0));
        } catch (RuntimeException inaccessible) {
            return EMPTY;
        }
    }

    static EditorContext of(CharSequence before, CharSequence after) {
        String left = before == null ? "" : before.subSequence(Math.max(0, before.length() - 300), before.length()).toString();
        String right = after == null ? "" : after.subSequence(0, Math.min(300, after.length())).toString();
        if (!left.isEmpty() && Character.isLowSurrogate(left.charAt(0))) left = left.substring(1);
        if (!right.isEmpty() && Character.isHighSurrogate(right.charAt(right.length() - 1))) {
            right = right.substring(0, right.length() - 1);
        }
        return new EditorContext(left, right);
    }
}
