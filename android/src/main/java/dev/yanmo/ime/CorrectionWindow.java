package dev.yanmo.ime;

import android.view.inputmethod.ExtractedText;
import android.view.inputmethod.ExtractedTextRequest;
import android.view.inputmethod.InputConnection;

final class CorrectionWindow {
    static final long DURATION_MS = 10_000;
    private static final int MAX_FIELD_LENGTH = 8_192;
    private static final int MAX_DICTATION_LENGTH = 2_000;

    final InputConnection editor;
    final String original;
    final String raw;
    final String group;
    final long deadline;
    private final String prefix;
    private final String suffix;
    private boolean typed;

    private CorrectionWindow(InputConnection editor, String original, String raw, String group,
                             String prefix, String suffix, long deadline) {
        this.editor = editor;
        this.original = original;
        this.raw = raw;
        this.group = group;
        this.prefix = prefix;
        this.suffix = suffix;
        this.deadline = deadline;
    }

    static CorrectionWindow beforeWrite(InputConnection editor, String original, String raw, String group,
                                        long now) {
        if (original.length() > MAX_DICTATION_LENGTH) return null;
        ExtractedText field = read(editor);
        if (field == null) return null;
        String text = field.text.toString();
        int start = Math.min(field.selectionStart, field.selectionEnd);
        int end = Math.max(field.selectionStart, field.selectionEnd);
        if (start < 0 || end > text.length()) return null;
        return new CorrectionWindow(editor, original, raw, group, text.substring(0, start), text.substring(end),
                now + DURATION_MS);
    }

    boolean confirmWrite() {
        return original.equals(currentSegment());
    }

    void manualCommit(InputConnection connection, String text, long now) {
        if (connection == editor && now < deadline && text.codePoints().anyMatch(Character::isLetter)) typed = true;
    }

    String corrected() {
        return typed ? replacement(original, currentSegment()) : null;
    }

    private String currentSegment() {
        ExtractedText field = read(editor);
        return field == null ? null : isolate(field.text.toString(), prefix, suffix);
    }

    static String isolate(String field, String prefix, String suffix) {
        int end = field.length() - suffix.length();
        if (end < prefix.length() || !field.startsWith(prefix) || !field.endsWith(suffix)) return null;
        return field.substring(prefix.length(), end);
    }

    static String replacement(String original, String updated) {
        if (updated == null || updated.equals(original) || updated.length() > MAX_DICTATION_LENGTH) return null;
        int start = 0;
        int endBefore = original.length();
        int endAfter = updated.length();
        while (start < endBefore && start < endAfter && original.charAt(start) == updated.charAt(start)) start++;
        while (endBefore > start && endAfter > start && original.charAt(endBefore - 1) == updated.charAt(endAfter - 1)) {
            endBefore--;
            endAfter--;
        }
        if (!original.substring(start, endBefore).codePoints().anyMatch(Character::isLetter) ||
                !updated.substring(start, endAfter).codePoints().anyMatch(Character::isLetter)) return null;
        return updated;
    }

    private static ExtractedText read(InputConnection editor) {
        ExtractedTextRequest request = new ExtractedTextRequest();
        request.hintMaxChars = MAX_FIELD_LENGTH;
        try {
            ExtractedText field = editor.getExtractedText(request, 0);
            if (field != null && field.text != null && field.startOffset == 0 && field.partialStartOffset < 0 &&
                    field.text.length() < MAX_FIELD_LENGTH) return field;
        } catch (RuntimeException inaccessible) {
            // Some editors do not expose a readable snapshot.
        }
        return null;
    }
}
