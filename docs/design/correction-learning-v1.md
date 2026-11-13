# 手动纠词自动入库 · 已确认并实现

2026-11-02。用户要求：语音写入后持续监控聚焦输入框 10 秒，手动纠正的词自动加入热词，并在底部弹出提醒。

## 已确认交互

- 默认观察 10 秒；仅针对此次语音输入实际写入的文本。切换输入框、应用退出或开始下一次录音即结束。
- 新词加入现有词库，提醒「已加入词库：沈砚」，右侧「撤销」。示例为虚构内容。
- 提醒沿用底部墨色胶囊，自动消失，不抢焦点；撤销仅移除本次新增词，不删除原有词条。不创建永久原词→新词替换规则。
- 连续修改需等待输入稳定，避免收录拼音组合态、半个词；同一处反复修改以最终结果为准。多处纠正分别提取并去重。
- 续写、纯删除、标点/空白调整、整句重写不直接作为新词收录。中文单字纠正应结合原句词边界提取完整新词，不能只存差异字符。

## 实现入口与边界

- `Sources/YanmoBridge/main.swift` 的 insert 当前只返回 attempted_unverified；发送粘贴不是已验证写入。新增观察器在写入时捕获目标元素和选区，并回读确认插入范围后观察；不改变原有粘贴交付状态。
- `Sources/YanmoNative/SystemIntegration.swift` 已有 AX 焦点、文本值、选区读取；已新增同元素身份校验与限时观察能力。不可读取/安全输入框跳过，不能用剪贴板或模拟全选轮询。
- `desktop/controller.ts` 在 dictation 写入后接入观察，复用现有词库存储。仅内存保留观察快照，不把输入框全文写入日志或上传。
- 新增词与原词不建立强制替换映射；现有 key_terms 已送入整理模型。这不是给 Qwen ASR 新增 hotword API。
- 验证覆盖：中文单字/多字纠正、英文词纠正、多处纠正、输入法组合态、继续输入、撤销重做、焦点切换、10秒到期、重复词、不可读输入框、提示撤销与焦点保持。

## 状态

用户于2026-11-02确认样式和10秒时长，已按图实现。设计稿：`correction-learning-v1.png`（底部为位置示意，右上为放大细节）。

## 实现与验证

- Mac `CorrectionObservation` 使用单调时钟计时10秒，每200ms回读同一AX元素；到期时文本及键盘至少稳定800ms才提取。密码框、不可读控件、无法确认插入范围跳过。快照在停止时清除。
- 首版保守识别短词纠正：本地字符差异 + ICU词边界 + 常见中文姓氏辅助；不能保证识别所有新词。末尾800ms仍在编辑时跳过；不延长10秒监控。输入法标记范围取决于目标应用AX支持，拼音排除另有测试，尚未覆盖所有中文输入法。
- 新词进入现有词库供后续整理使用，不改自然整理提示词，不自动创建强制替换规则。提醒显示6秒，可一次撤销本次新词；已存在的词不会重复收录。
- `npm test`：51项通过；`npm run build`：类型、Swift桥接、前端构建通过。
- `npx playwright test desktop/e2e/correction-learning.spec.ts`：新提醒显示、400×48布局、非激活、撤销前后焦点保持、持久化与6秒自动消失通过。
- 常规Mac UI四项通过；需显式真人音频的两项未运行，不作为本功能完成证据。
- `python3 scripts/check-correction-learning.py`：5/5通过；独立NSTextView + 真实AX回读 + 系统合成键盘，正常纠词约10.12秒回传；焦点切换、停止、改后撤销、到期后编辑均不收录。结果见`.local/correction-learning/native-results.json`。
- 原生脚本会操作前台，运行时需避免用户同时切窗；已增加粘贴前临时编辑器身份检查。早期测试因桌面竞争中断，不计通过。
- Windows尚未接入此监控，现有Windows输入流程不变。

## 生成提示词（内置 Image Gen）

Use case: ui-mockup. Create a polished minimal UI design proposal for macOS local dictation app 言墨. Landscape image showing a neutral warm ivory desktop with a very understated generic text editor window. Editor contains fictional example sentence 明天联系沈砚确认方案。 Main focus is a compact floating toast at bottom center of screen, about 400 by 48 points, charcoal ink black capsule, ivory Chinese text reading 已加入词库：沈砚 and a subtle vertical divider and clickable text 撤销 on right in pale warm ivory. Small muted stone green checkmark left. Very subtle shadow, no glow, no gradient. Ink and rice paper design language, generous whitespace, modern readable Chinese system font in capsule. Include an enlarged crisp detail of the same toast in upper right with a small caption 词库提醒, and small footer caption 自动收录纠正后的词 · 可撤销 · 不打断输入. No microphone icon, no audio waves, no monitoring countdown, no extra panels or fake controls. This is a design approval board, not implemented software. Exact Chinese characters legible.

## 本机交付

2026-11-02完整包已安装至`dist-release/mac-arm64/言墨.app`，退出旧进程树后整体替换。用户完成系统认证后重新关联辅助功能，独立启动三键已启用、点击与键盘通过；包内桥接隔离写入/10秒纠词通过，配置、词库文稿及加密密钥哈希不变。记录：`~/Library/Application Support/Yanmo/evaluations/correction-learning-2026-11-02/`，原包为previous.app。
