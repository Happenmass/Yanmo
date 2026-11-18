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
        Polish.PromptAsset prompt = () -> Files.newInputStream(Path.of("engine/polish.txt"));
        expectFailure(() -> Polish.generate(Map.of(), () -> {
            throw new AssertionError("Disabled configuration tried to read the prompt");
        }, original, app));
        check(requests == 0, "Disabled configuration sent a request");

        Map<String, ?> generic = config("https://text.example.test/v1/");
        Map<String, ?> deepseek = config("https://api.deepseek.com/v1");
        check(content.equals(Polish.generate(generic, prompt, original, app)), "Changed mixed-language response");
        Files.writeString(output.resolve("generic.json"), sent);
        content = "我想预约周四下午三点。";
        check(content.equals(Polish.generate(deepseek, prompt, original, app)), "Changed Chinese response");
        Files.writeString(output.resolve("deepseek.json"), sent);

        status = "length";
        expectFailure(() -> Polish.generate(generic, prompt, original, app));
        status = "stop";
        content = "   ";
        expectFailure(() -> Polish.generate(generic, prompt, original, app));
        content = null;
        expectFailure(() -> Polish.generate(generic, prompt, original, app));
        responseCode = 401;
        expectFailure(() -> Polish.generate(generic, prompt, original, app));
        responseCode = 302;
        expectFailure(() -> Polish.generate(generic, prompt, original, app));
        check(requests == 7, "Unexpected extra or missing request");
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
