# Control＋空格快捷键修复（2026-10-21）

## 问题与原因

用户在划词翻译中录制 Control＋空格，收到“已存在”。配置检查确认没有该组合，但已有单独左 Control；本机系统快捷键启用了 Control＋空格。

旧录制器仅从 AppKit 的 `keyDown` 获取普通键。如果系统先消费空格，录制器只能看到 Control 按下、释放，就会提交单独 Control 并命中现有绑定。自动化旧版复现为 Control＋空格未保存；用户报告的误判由该事件路径解释。

## 修复

- 在已有辅助功能事件监听中，将普通键事件交给当前聚焦的录制器，先捕获完整组合并取消纯修饰键候选。
- 明确配置的 Control＋空格改用事件监听触发，消耗按下、重复和对应松开事件；不修改系统快捷键设置，移除绑定后不再拦截。
- 其他普通组合继续通过 Carbon 注册；纯修饰键/Fn 行为保留。
- 重复提示明确显示快捷键和占用它的功能。

## 验证

- 新增核心检查在修复前失败：`Control+Space must bypass Carbon/system hotkey interception through the event tap`；修复后9项核心检查全部通过。
- 两项原生录制器检查通过：Control＋空格仅提交一次完整组合，释放 Control 不追加纯修饰键；单独左 Control 仍可录制。
- 普通组合 ⌃⇧D 通过界面录制，对照结束后已移除。
- 修复版构建及签名校验通过。用户完成系统身份验证后，刷新同一路径授权并启动修复版，Fn/左 Control 显示已启用。
- 用户实体按键确认“已出现 ⌃Space”；回读界面显示划词翻译 `⌃Space 已启用`，保存成功。目标语言保持用户设置的简体中文。
- 自动化工具的定向 Control＋空格事件仍未进入录制器，不能替代实体全局按键测试；此次已验证实体录制，未重新实测选区翻译触发。

复跑录制器检查（仅构造进程内 NSEvent，不向系统注入按键）：

```bash
swift run YanmoChecks
YANMO_BIN="$(swift build --show-bin-path)"
swiftc -parse-as-library -I "$YANMO_BIN/Modules" \
  Sources/Yanmo/LocalEngine.swift Sources/Yanmo/Shortcuts.swift \
  Tests/ShortcutCaptureChecks.swift "$YANMO_BIN"/YanmoCore.build/*.o \
  -o "$YANMO_BIN/ShortcutCaptureChecks"
"$YANMO_BIN/ShortcutCaptureChecks"
```
