package dev.yanmo.ime;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

public final class PolishContract {
    private static int requests;
    private static String sent;
    private static String status = "stop";
    private static String content = "  中文原样保留。\nMixed 中文 and English!\n";
    private static int responseCode = 200;

    public static void main(String[] args) throws Exception {
        URL.setURLStreamHandlerFactory(protocol -> "https".equals(protocol) ? new URLStreamHandler() {
            @Override
            protected URLConnection openConnection(URL url) {
                requests++;
                return new FixtureConnection(url);
            }
        } : null);
        Path output = Path.of(args[0]);
        String original = args[1];
        String app = args[2];
        List<Lexicon.Entry> terms = List.of(
                new Lexicon.Entry("1", "项目晨星", Lexicon.GLOBAL, 0, 0, 0),
                new Lexicon.Entry("2", "ChatGPT", Lexicon.AI_TOOLS, 0, 0, 0));
        EditorContext editor = EditorContext.of("前".repeat(310), "后".repeat(310));
        Polish.PromptAsset prompt = () -> Files.newInputStream(Path.of("engine/polish.txt"));
        expectFailure(() -> Polish.generate(Map.of(), () -> {
            throw new AssertionError("Disabled configuration tried to read the prompt");
        }, original, app, Lexicon.AI_TOOLS, editor, terms));
        check(requests == 0, "Disabled configuration sent a request");

        Map<String, ?> generic = config("https://text.example.test/v1/");
        Map<String, ?> deepseek = config("https://api.deepseek.com/v1");
        check(content.equals(Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms)), "Changed mixed-language response");
        JSONObject genericPayload = new JSONObject(new JSONObject(sent).getJSONArray("messages").getJSONObject(1).getString("content"));
        check(!genericPayload.getJSONObject("AUDIO_CONTEXT").has("lexicon"), "Text API must not receive lexicon entries");
        Files.writeString(output.resolve("generic.json"), sent);
        content = "我想预约周四下午三点。";
        check(content.equals(Polish.generate(deepseek, prompt, original, app, Lexicon.GLOBAL, EditorContext.EMPTY, List.of())), "Changed Chinese response");
        Files.writeString(output.resolve("deepseek.json"), sent);

        status = "length";
        expectFailure(() -> Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms));
        status = "stop";
        content = "   ";
        expectFailure(() -> Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms));
        content = null;
        expectFailure(() -> Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms));
        responseCode = 401;
        expectFailure(() -> Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms));
        responseCode = 302;
        expectFailure(() -> Polish.generate(generic, prompt, original, app, Lexicon.AI_TOOLS, editor, terms));
        check(requests == 7, "Unexpected extra or missing request");

        responseCode = 200;
        content = "[\"沈砚\",\"沈砚\",\"原话\",\"无关\"]";
        List<String> learned = Polish.correctionTerms(generic,
                () -> Files.newInputStream(Path.of("engine/correction-terms.txt")),
                "原话是沈燕", "原话是沈砚", "原话是沈燕");
        check(List.of("沈砚").equals(learned), "Correction candidate validation differs");
        JSONObject request = new JSONObject(sent);
        JSONArray messages = request.getJSONArray("messages");
        check(messages.getJSONObject(0).getString("content").equals(Files.readString(Path.of("engine/correction-terms.txt"))),
                "Correction extraction did not use the shared system prompt");
        JSONObject pair = new JSONObject(messages.getJSONObject(1).getString("content"));
        check(pair.length() == 2 && pair.getString("CORRECTED").equals("原话是沈砚"), "Unexpected correction data");
        check(CorrectionWindow.replacement("跟沈燕开会", "跟沈砚开会").equals("跟沈砚开会"), "replacement was missed");
        check(CorrectionWindow.replacement("跟沈燕开会", "跟沈燕开会。下午继续") == null, "continuation was learned");
        check(CorrectionWindow.replacement("跟沈燕开会", "跟沈燕开会！") == null, "punctuation was learned");
        check(CorrectionWindow.replacement("跟沈燕开会", "跟沈燕") == null, "deletion was learned");
    }

    private static Map<String, ?> config(String endpoint) {
        return Map.of("enabled", true, "endpoint", endpoint, "model", "contract-fixture");
    }

    private interface Call {
        void run() throws Exception;
    }

    private static void expectFailure(Call call) throws Exception {
        try {
            call.run();
            throw new AssertionError("Expected an error with no replacement text");
        } catch (Polish.Failure expected) {
            check(!expected.getMessage().isEmpty(), "Expected readable error");
        }
    }

    private static void check(boolean ok, String message) {
        if (!ok) throw new AssertionError(message);
    }

    private static final class FixtureConnection extends HttpURLConnection {
        private final ByteArrayOutputStream request = new ByteArrayOutputStream();

        FixtureConnection(URL url) {
            super(url);
            check("/v1/chat/completions".equals(url.getPath()), "Wrong completions path");
        }

        @Override public void connect() {}
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public OutputStream getOutputStream() { return request; }

        @Override
        public int getResponseCode() {
            check("POST".equals(getRequestMethod()), "Wrong request method");
            check(!getInstanceFollowRedirects(), "Unexpected redirect behavior");
            check(getRequestProperty("Content-Type").startsWith("application/json"), "Wrong content type");
            sent = request.toString(StandardCharsets.UTF_8);
            return PolishContract.responseCode;
        }

        @Override
        public InputStream getInputStream() throws IOException {
            try {
                JSONObject message = new JSONObject().put("content", content == null ? JSONObject.NULL : content);
                JSONObject choice = new JSONObject().put("finish_reason", status).put("message", message);
                byte[] bytes = new JSONObject().put("choices", new JSONArray().put(choice))
                        .toString().getBytes(StandardCharsets.UTF_8);
                return new ByteArrayInputStream(bytes);
            } catch (Exception failure) {
                throw new IOException(failure);
            }
        }
    }
}
