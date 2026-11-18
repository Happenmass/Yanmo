# 言墨 Android 原型

言墨 Android 的应用 ID 是 `dev.yanmo.ime`。键盘使用 CyIME 1.15.94 的九键与 26 键布局、候选栏、Rime JNI 和雾凇词库。切换布局时点工具栏左侧第二个键盘图标，再选九键或 26 键。短按空格照常输入。长按空格开始听写，松手结束，向上滑动后松手取消。原型复用桌面端的 `engine/polish.txt`。

[音频、截屏与文稿架构图](../docs/architecture/android-ime-media.svg) · [可编辑的 draw.io 图](../docs/architecture/android-ime-media.drawio)

## 录音和文稿存储

长按空格时，输入法只创建文稿 ID 和空记录，麦克风 PCM 留在进程内存。松手后补齐 WAV 头，先把完整音频保存到 SQLite，再分成最长 24 秒的窗口识别。每个有文字的窗口都会更新原文。文字 API 返回后先保存整理稿，再向仍有效的原输入框写入一次。截屏与识别并行：已授权时取松手后的一帧，在内存编码 PNG 后写入同一篇文稿。若录音期间进程终止，尚在内存的音频会丢失。达到根据堆余量计算的录音容量时，输入法会自动结束并提示。

私有库位于 `no_backup/manuscripts.sqlite3`。`manuscript` 表保存文本和状态，`attachment` 表按文稿 ID、媒体类型和顺序保存 256 KiB 的 BLOB 分块。回放时按播放位置读取，最多缓存一个音频分块。历史页也可从库中查看大图、删除文稿及附件。升级后首次打开历史页会在后台逐篇迁移旧目录，事务成功后清理该篇的旧文件。

Sound Software 的同签名 Binder 接口读取有明确长度的 WAV 描述符。言墨通过 Android 的 `StorageManager.openProxyFileDescriptor` 从内存响应读请求。若系统无法创建有效代理，才使用单窗口临时 WAV，打开后先移除目录项再写入。SDK 内部仍会将收到的音频暂存为自己的 WAV，调用结束后清理。音频和截屏都在设备内处理，文字 API 只接收文字请求。

## 构建试用 APK

需要 Python 3.11 或更高版本、JDK 17 或更高版本、Android SDK Platform 36、Build-Tools 36.1.0。

```sh
./android/build-apk.sh
```

脚本核验原版 APK 的 SHA-256，保留它的 Android 资源 ID、原始布局和 Rime 原生库。脚本为原始输入法服务解除继承限制，接入言墨的输入法服务和应用入口，调整奶油主题的浅色配色。词库、键盘资源和 JNI 文件沿用原版，另从 full 版提取对应版本的九键词组模型和 Rime 资产清单。语音 SDK 以独立应用运行。原版 full APK 缓存于 `~/.cache/codex/yanmo-android`，未写入 Git。

- 默认产物为 `android/build/Yanmo-Android-Prototype-arm64-v8a.apk`
- 以 `YANMO_SPEECH_PACKAGE=dev.androidagent.sample.fixture` 构建时，产物名附加服务应用 ID
- 默认用 `~/.android/debug.keystore` 签名。语音 SDK 应用须与言墨签名一致才能取得签名级语音权限
- 自定义签名可用 `YANMO_ANDROID_KEYSTORE`、`YANMO_ANDROID_KEY_ALIAS`、`YANMO_ANDROID_STORE_PASSWORD` 与 `YANMO_ANDROID_KEY_PASSWORD`
- 如无需九键词组模型，可显式设置 `YANMO_LIGHT_KEYBOARD=1` 构建轻量包

试用包面向 arm64-v8a，最低 Android 9。CyIME 的签名检查会把这份言墨开发签名识别为非官方 CyIME 安装包，启动时可能显示 CyIME 提示。请先安装配套的语音 SDK，在言墨首页授予麦克风权限，启用并切换到言墨键盘。选择九键或全键，在普通编辑框长按空格开始听写。文字 API 和截屏授权在言墨首页配置。

## 源码与许可

CyIME 及本 Android 键盘派生部分使用 GNU GPL v3。上游代码、子模块地址和资源来源固定在 CyIME 1.15.94（`6f97a555ced063c0bcad73c600fe420f5e4b2536`）。原 APK 中的第三方许可证和资源声明随试用包保留，CyIME 许可证在本目录另有副本。正式对外分发 APK 时须同时提供相应源码。

以下命令准备可从源码构建的 Android 工程。该路径在 CyIME 原有空格回调直接接入听写，使用与试用包相同的言墨 Java 源码。

```sh
cyime_checkout="$HOME/.cache/codex/yanmo-android/cyime-source-1.15.94"
git clone --depth 1 --filter=blob:none --no-checkout --branch 1.15.94 https://github.com/Cyletix/CyIME.git "$cyime_checkout"
git -C "$cyime_checkout" sparse-checkout set --no-cone '/*' '!*.onnx' '!*.ort' '!*.safetensors' '!*.tflite' '!*.gguf'
git -C "$cyime_checkout" checkout --detach 6f97a555ced063c0bcad73c600fe420f5e4b2536
git -C "$cyime_checkout" submodule update --init --depth 1 --jobs 6
./android/tools/prepare_source.py "$cyime_checkout" \
  --keyboard-assets "$HOME/.cache/codex/yanmo-android/CyIME-1.15.94-full-arm64-v8a.apk"
(cd "$cyime_checkout" && ./gradlew -I scripts/phone-release-abi.gradle :app:assembleDebug)
```

源码构建还需要 Android NDK 29.0.14206865、CMake 3.22.1、仓库的 Gradle 包装器及上游任务依赖。源代码准备工具接受 `--speech-package`。上游编译任务生成 Rime 资产清单。

## 原型验收（2026-11-18）

- Android 17 ARM64 模拟器按键实测。九键输入 `64426`、26 键输入 `nihao`，两种布局首选均为「你好」。短按空格选词，再次短按输入空格；长按开始录音，松手后文稿可回放 WAV。通过系统屏幕共享授权后，松手时的真实截图能在文稿中放大。两种布局的空格均已触发实际 SDK 请求。
- 存储改版已在 Android 17 ARM64 模拟器验证。真实键盘长按期间没有音频附件，松手后 SQLite 可读出 WAV 和系统授权截屏。升级旧包的 6 篇文稿共 18 个文件逐项核对 SHA-256 一致。独立仪器测试还覆盖超过 5 MiB 的音频、超过 3 MiB 的图片、删除和迁移重试。
- 同签名 SDK 的说话人接口和 ASR 共用服务端的读音频方法。模拟器上经该接口验证了服务完整读取内存代理提供的 64,044 字节 WAV。ASR 自身在读取前先检查 HTP。
- 本次模拟器没有高通 HTP。真实 Binder 调用返回 `UNSUPPORTED_DEVICE`，录音与截屏仍可查阅。独立探针让超过 24 秒的合成音频经过生产切窗与 Binder 调用。隔离进程核对两窗的 WAV 头及全部 PCM，返回固定识别结果。受控 HTTPS 响应随后走实际整理、SQLite 保存及原输入框写入流程；另覆盖切换输入框、取消和禁用 API。执行 `ANDROID_SERIAL=<模拟器> ./android/tools/test_voice.sh -e checkBinder true` 可在已安装同签名 SDK fixture 的模拟器复验。执行 `./android/check-polish.sh` 可核对文字 API 请求与桌面端的一致性。
- 真机试用包 `android/build/Yanmo-Android-Prototype-phone-arm64-v8a.apk` 另用录音豆正式证书签名，目标服务为 `dev.androidagent.sample`。已比对本次 APK 与留存的正式版 AI SDK 0.1.0 安装包证书，并通过 16 KiB ZIP 对齐检查。言墨在兼容高通手机上的真实口述、正式文字 API 请求和落字仍待联测。

本机源码路径已验证到 Gradle 的原生和词库依赖准备阶段。完整 Gradle 编译仍依赖上游 Maven 的 OpenCV 4.12.0 等 AAR。试用包使用上面的已验证打包入口。

本次可安装 APK 通过固定上游发布产物与本分支源码构建。独立的上游全源码 Gradle 验证到达 `:app:preDebugBuild`；该次离线编译在解析 OpenCV / ONNX Runtime 的 Maven AAR 时停止，尚未产出全源码 APK。
