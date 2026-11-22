package dev.yanmo.ime;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** A bounded app-private history independent of manuscript and audio retention. */
final class VoiceFailureHistory {
    private static final int LIMIT = 30;

    static final class Entry {
        final long atMs;
        final long elapsedMs;
        final String stage;
        final String code;
        final String detail;

        Entry(long atMs, long elapsedMs, String stage, String code, String detail) {
            this.atMs = atMs;
            this.elapsedMs = elapsedMs;
            this.stage = stage;
            this.code = code;
            this.detail = detail;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("voice_failure_history", Context.MODE_PRIVATE);
    }

    static synchronized void record(Context context, long elapsedMs, String stage, String code, String detail) {
        SharedPreferences history = prefs(context);
        JSONArray previous = read(history);
        try {
            JSONObject entry = new JSONObject().put("atMs", System.currentTimeMillis())
                    .put("elapsedMs", elapsedMs).put("stage", stage).put("code", code).put("detail", detail);
            JSONArray updated = new JSONArray().put(entry);
            for (int index = 0; index < Math.min(previous.length(), LIMIT - 1); index++) {
                updated.put(previous.get(index));
            }
            if (!history.edit().putString("recent", updated.toString()).commit()) {
                Log.w("YanmoVoice", "Unable to persist failure history");
            }
        } catch (JSONException failure) {
            Log.w("YanmoVoice", "Unable to write failure history");
        }
    }

    static List<Entry> recent(Context context) {
        JSONArray records = read(prefs(context));
        List<Entry> entries = new ArrayList<>();
        for (int i = 0; i < Math.min(records.length(), LIMIT); i++) {
            JSONObject record = records.optJSONObject(i);
            if (record != null) entries.add(new Entry(record.optLong("atMs"), record.optLong("elapsedMs"),
                    record.optString("stage"), record.optString("code"), record.optString("detail")));
        }
        return entries;
    }

    private static JSONArray read(SharedPreferences history) {
        try {
            return new JSONArray(history.getString("recent", "[]"));
        } catch (JSONException malformed) {
            return new JSONArray();
        }
    }
}
