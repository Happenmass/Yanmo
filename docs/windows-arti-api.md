# 言墨 Windows arti 定制版

分支 `codex/arti-windows-api`。此分支的 Windows 软件仅通过局域网 API 处理；Mac 默认流程保持原样。

## Windows 打包

构建机器安装 Node.js 22 或以上（含 npm）、Python 3.12 x64（含 `py` 启动器）和 .NET SDK 8 或以上。最终用户无需安装这些工具，也无需 GPU、CUDA、Python 或模型。

```powershell
git fetch origin
git switch codex/arti-windows-api
npm ci
npm run package:win:arti
```

安装包输出：`dist-electron/Yanmo-Arti-Setup-0.4.4-win-x64.exe`。

脚本下载并核对官方 Python 3.12.10 嵌入版 SHA-256，按哈希锁安装轻量 API 运行库，编译自带 .NET 运行时的 Windows 系统桥接，再生成 NSIS 安装程序。模型不进入安装包，构建不需要连接 GPU 主机。默认每用户安装，无需管理员权限。软件未签名。

## 默认接口

| 功能 | Base URL | 模型 |
| --- | --- | --- |
| 语音识别 | `https://arti.local/v1` | `Qwen/Qwen3-ASR-1.7B` |
| 自然整理、口述翻译、划词翻译 | `https://arti.local/v1` | `Qwen/Qwen3.6-35B-A3B` |

无需 API Key。局域网 API 等待上限为 1 小时，以容纳同一 LLM 槽位上的长请求排队；桌面任务传输预留 61 分钟。ASR 调用 `POST /audio/transcriptions`，文字调用 `POST /chat/completions`。服务地址和模型可在设置修改；定制版不能关闭 API 后回退本地模型。证书随包提供，仅用公开 CA 校验 arti.local，保留 HTTPS 验证；不依赖系统证书导入、不修改全局信任或代理。

录音和文字默认发送到该局域网主机，界面会说明。输入框上下文默认关闭；开启后最多发送光标前后各 300 字。文稿、词库及设置保存在 `%APPDATA%/Yanmo-Arti/electron`，不覆盖其他言墨版本。临时录音结束处理后删除。

## Windows 实机验收

1. 安装、首启及托盘退出后再启动；确认界面显示 arti.local，无模型/CUDA 下载流程。
2. 在设置确认服务与两项模型；服务器关闭、网络断开时应有可读错误，重新连接可继续。
3. 在记事本按 **Control + Alt + 空格**，口述后再按结束；确认写入一次。录音途中切换输入框，结果应粘贴到结束处理时的焦点。
4. **Control + Shift + 空格** 口述翻译；**Control + Alt + T** 划词翻译。按 **Esc** 取消；确认取消后没有迟到的粘贴。
5. 改快捷键、选择麦克风、导入 WAV/MP3/FLAC/OGG；检查原始转写、整理正文和文稿历史。
6. 关闭主窗口后快捷键继续有效；完全退出后进程与录音临时文件清理。开始菜单/桌面快捷方式重新启动。

Windows 选区与可选上下文通过 UI Automation 读取；不提供选区的控件会提示先选中。密码控件不读取或写入；Windows 权限限制下无法向以管理员权限运行的程序注入粘贴，正文仍保留在文稿中。构建/单测/交叉打包不能代替上述原生验收。

验收安装包后再放到 arti.local 软件下载区域。门户已预留固定文件名 `Yanmo-Arti-Setup-win-x64.exe` 和 `Yanmo-Arti-SHA256SUMS.txt`，未提供经 Windows 验收的安装包前不展示下载按钮。
