package dev.yanmo.ime;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

final class Lexicon {
    static final String GLOBAL = "global";
    static final String AI_TOOLS = "ai_tools";

    static final int ASR_LIMIT = 64;
    private static final Set<String> AI_APPS = new HashSet<>(java.util.Arrays.asList(
            "com.openai.chatgpt", "com.anthropic.claude", "com.google.android.apps.bard", "com.deepseek.chat",
            "com.microsoft.copilot", "ai.perplexity.app.android", "ai.x.grok", "com.larus.nova",
            "com.alibaba.tongyi", "com.moonshot.kimichat"));
    private static final Comparator<Entry> RANK = Comparator.comparingLong((Entry entry) -> entry.matchCount)
            .thenComparingLong(entry -> entry.lastMatchedAt).thenComparingLong(entry -> entry.createdAt)
            .reversed().thenComparing(entry -> termKey(entry.term));
    private static final String ENTRIES = "entries";

    private Lexicon() {}

    static final class Entry {
        final String id;
        final String term;
        final String group;

        final long matchCount;
        final long lastMatchedAt;
        final long createdAt;

        Entry(String id, String term, String group, long matchCount, long lastMatchedAt, long createdAt) {
            this.id = id;
            this.term = term;
            this.group = group;
            this.matchCount = matchCount;
            this.lastMatchedAt = lastMatchedAt;
            this.createdAt = createdAt;
        }
    }

    static String groupLabel(String group) {
        return AI_TOOLS.equals(group) ? "AI 工具" : "全局";
    }

    private static SharedPreferences settings(Context context) {
        return context.getSharedPreferences("lexicon", Context.MODE_PRIVATE);
    }

    static List<Entry> list(Context context) throws IOException {
        List<Entry> entries = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(settings(context).getString(ENTRIES, "[]"));
            for (int index = 0; index < saved.length(); index++) {
                JSONObject item = saved.getJSONObject(index);
                entries.add(new Entry(item.getString("id"), item.getString("term"), item.getString("group"),
                        item.optLong("matchCount"), item.optLong("lastMatchedAt"), item.optLong("createdAt")));
            }
        } catch (JSONException | ClassCastException failure) {
            throw new IOException("无法读取词库，请稍后重试。", failure);
        }
        entries.sort(RANK);
        return entries;
    }

    static synchronized void save(Context context, String id, String term, String group) throws IOException {
        String key = termKey(term);
        if (key.isEmpty()) throw new IOException("请输入词条。");
        if (!GLOBAL.equals(group) && !AI_TOOLS.equals(group)) throw new IOException("请选择词条分类。");
        List<Entry> entries = list(context);
        Entry existing = null;
        for (Entry entry : entries) {
            if (entry.id.equals(id)) existing = entry;
            else if (key.equals(termKey(entry.term))) throw new IOException("词库里已有这个词条。");
        }
        if (id != null && existing == null) throw new IOException("这个词条已不存在。");
        entries.removeIf(entry -> entry.id.equals(id));
        boolean sameTerm = existing != null && key.equals(termKey(existing.term));
        entries.add(new Entry(id == null ? UUID.randomUUID().toString() : id, term.trim(), group,
                sameTerm ? existing.matchCount : 0, sameTerm ? existing.lastMatchedAt : 0,
                existing == null ? System.currentTimeMillis() : existing.createdAt));
        write(context, entries);
    }

    static synchronized void remove(Context context, String id) throws IOException {
        List<Entry> entries = list(context);
        if (entries.removeIf(entry -> entry.id.equals(id))) write(context, entries);
    }

    static String applicationGroup(String packageName) {
        return AI_APPS.contains(packageName) ? AI_TOOLS : GLOBAL;
    }

    static List<Entry> scoped(List<Entry> entries, String group) {
        List<Entry> selected = new ArrayList<>();
        if (!GLOBAL.equals(group)) {
            for (Entry entry : entries) if (group.equals(entry.group)) selected.add(entry);
        }
        for (Entry entry : entries) if (GLOBAL.equals(entry.group)) selected.add(entry);
        return selected;
    }

    static List<String> hotwords(List<Entry> entries, String group) {
        List<Entry> selected = scoped(entries, group);
        int global = 0;
        for (Entry entry : selected) if (GLOBAL.equals(entry.group)) global++;
        int groupLimit = 48 + Math.max(0, 16 - global);
        List<String> words = new ArrayList<>();
        for (Entry entry : selected) {
            if (words.size() == ASR_LIMIT) break;
            if (GLOBAL.equals(entry.group) || words.size() < groupLimit) words.add(entry.term);
        }
        return words;
    }

    static synchronized void recordMatches(Context context, List<Entry> eligible, String text) throws IOException {
        String body = termKey(text);
        Set<String> matches = new HashSet<>();
        for (Entry entry : eligible) if (matches(body, termKey(entry.term))) matches.add(entry.id);
        if (matches.isEmpty()) return;
        List<Entry> entries = list(context);
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (int i = 0; i < entries.size(); i++) {
            Entry entry = entries.get(i);
            if (matches.contains(entry.id) && matches(body, termKey(entry.term))) {
                entries.set(i, new Entry(entry.id, entry.term, entry.group, entry.matchCount + 1, now, entry.createdAt));
                changed = true;
            }
        }
        if (changed) write(context, entries);
    }

    private static boolean matches(String body, String term) {
        if (term.isEmpty()) return false;
        return Pattern.compile((latinWordChar(term.charAt(0)) ? "(?<![a-z0-9_])" : "") + Pattern.quote(term)
                + (latinWordChar(term.charAt(term.length() - 1)) ? "(?![a-z0-9_])" : "")).matcher(body).find();
    }

    private static boolean latinWordChar(char c) {
        return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_';
    }

    static synchronized List<String> learn(Context context, List<String> terms, String group) throws IOException {
        if (terms.isEmpty()) return Collections.emptyList();
        List<Entry> entries = list(context);
        Set<String> seen = new HashSet<>();
        for (Entry entry : entries) seen.add(termKey(entry.term));
        List<String> added = new ArrayList<>();
        long now = System.currentTimeMillis();
        for (String term : terms) {
            if (seen.add(termKey(term))) {
                entries.add(new Entry(UUID.randomUUID().toString(), term, group, 0, 0, now));
                added.add(term);
            }
        }
        if (!added.isEmpty()) write(context, entries);
        return added;
    }

    private static String termKey(String term) {
        return Normalizer.normalize(term, Normalizer.Form.NFKC)
                .replaceAll("[\\p{Z}\\s]+", " ").trim().toLowerCase(Locale.ROOT);
    }

    private static void write(Context context, List<Entry> entries) throws IOException {
        JSONArray saved = new JSONArray();
        try {
            for (Entry entry : entries) {
                saved.put(new JSONObject().put("id", entry.id).put("term", entry.term).put("group", entry.group)
                        .put("matchCount", entry.matchCount).put("lastMatchedAt", entry.lastMatchedAt)
                        .put("createdAt", entry.createdAt));
            }
        } catch (JSONException failure) {
            throw new IOException("无法保存词库。", failure);
        }
        if (!settings(context).edit().putString(ENTRIES, saved.toString()).commit()) {
            throw new IOException("无法保存词库。");
        }
    }
}
