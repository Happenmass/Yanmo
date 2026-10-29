"""No compute libraries or model fallback in the Windows API distribution."""
class APIOnlyProvider:
    def unload(self):
        pass

    def load_asr(self, *args, **kwargs):
        raise ValueError("此定制版需要配置语音识别 API。")

    def load_llm(self, *args, **kwargs):
        raise ValueError("此定制版需要配置文字处理 API。")
