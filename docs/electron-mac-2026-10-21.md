# Electron + MLX Mac 实现

更新：2026-10-23；版本0.4.0。本文描述当前Mac实现，Windows进展见架构文档。

## 桌面与系统交互

`dist-electron/mac-arm64/言墨.app` 包含Electron、Swift系统桥接、Python 3.12及锁定的MLX依赖，不含模型权重。发布仍需稳定签名、公证和干净机器验收。

主窗口沿用已确认的v2「乌丝栏」、宣纸/墨色/朱砂、水墨Logo及动效。菜单栏使用单色笔锋template图标。录音胶囊可见尺寸200×36，20px上浮淡入，不抢焦点；尊重减弱动态设置。划词窗口使用普通窗口层级，顶部空白可拖动。

2026-10-22更新默认快捷键：语音输入为`FN`，口述翻译为`FN + Shift`，划词翻译为`FN + 空格`，每项仅一组。首页、首次教学、设置与快捷键录制统一显示FN、Control、Option、Command、Shift等完整键名。已有自定义配置保留，设置中的「恢复默认」使用新三组配置。

FN参与的组合均经事件监听处理：FN与Shift不分左右及按下/松开先后，全部松开后只触发一次；FN + 空格在空格按下时触发，抑制长按重复和松开事件，并使本次纯FN手势失效。只以物理FN按键事件判定按住状态，避免普通F键/方向键附带的function标志被误判为FN。

该改动通过20项桌面单测、13项核心检查及`swift run YanmoShortcutChecks`的真实监听函数进程内检查；后者不向系统发送输入，覆盖Shift两侧/八种顺序、FN + 空格重复与松开、录制完整组合及原有自定义快捷键。打包引导回归通过，覆盖四步文案、完整键名、自定义设置及三项恢复默认后持久保存；该检查不替代实体键盘口述验收。资源与deep/strict签名通过，证据在本机`~/Library/Application Support/Yanmo/evaluations/fn-shortcuts-2026-10-22-174943/`。

新包已正常启动到原数据目录，用户完成系统身份验证后已重新关联原有辅助功能授权。实际设置页确认左Control、左Shift + 左Control、Control + 空格均已启用，辅助功能已授权、两类本地模型就绪；原设置值与文稿库哈希一致，仅当前新版主进程运行，deep/strict签名仍有效。已有自定义绑定保留，新FN配置用于首次安装和恢复默认。

首次使用教学已于2026-10-22重打包：无settings.json且无待迁移旧文稿时，显示语音输入、划词翻译、口述翻译、翻译弹窗四步；前三步有真实试写区。已有用户可在设置「启动」节重新查看。打包引导回归、资源一致性及deep/strict签名通过。

首次启动实测使用YANMO_DATA_DIR指向独立空白配置，从第1/4步开始，文稿与词库为空、快捷键为首次安装默认值，沿用全局模型缓存及原系统授权。2026-10-22用户表示测试结束后，已退出测试进程，正常重开应用回到`~/Library/Application Support/Yanmo/electron/`；原有设置字段和快捷键保持一致，原文稿库哈希未变，新增onboarded标志由现有用户迁移自动补齐。界面核对左Control、左Shift+左Control及Control+空格均已启用，本地模型就绪。

测试配置和恢复状态见本机`~/Library/Application Support/Yanmo/evaluations/first-launch-current.json`；其中record指向证据目录，目录内保留launch-test.py与restoration.json。测试配置独立保留，当前应用使用原数据目录；用户未提供四步试用的逐项结论。

2026-10-22修复侧栏导航焦点框：全宽按钮的外描边被窗口裁剪后，会在「书案」上下留下两条横线；改为仅在导航文字周围显示键盘焦点框。聚焦后隐藏/重开窗口的同一场景修复前失败、源码与打包版修复后通过；首次显示及实际主窗口截图已检查，构建、包内CSS一致性与deep/strict签名通过，原3组快捷键授权已恢复。证据位于本机`~/Library/Application Support/Yanmo/evaluations/startup-nav-focus-2026-10-22/`。

关闭主窗口后后台运行并隐藏Dock，仅保留菜单栏和快捷键；菜单栏图标左键只打开主窗口，右键单独弹出操作菜单，重新打开主窗口时按showDock偏好恢复。Command-Q或菜单退出会完整停止自有进程。自动化默认使用隔离数据目录并隐藏Dock，显隐专项另行启用。

2026-10-22已删除旧SwiftUI 0.3应用包`dist/言墨.app`并注销其Launch Services登记；旧构建脚本也改为调用新版打包，避免再次生成同名原型。当前唯一应用包为`dist-electron/mac-arm64/言墨.app`，启动和桌面工具按该完整路径定位。当前包的ICNS和系统缓存均为已确认的水墨Logo v2。

录音不依赖输入框是否公开辅助功能属性。可读正文只作为上下文，空框的占位提示不作为正文。生成完成后向当时前台的当前焦点粘贴一次，允许期间切换应用、窗口和光标。文稿保留结果；导入音频只生成文稿。

## 模块边界

| 入口 | 当前责任 |
|---|---|
| `desktop/controller.ts` | 录音任务、配置快照、取消、原文/文稿/词库、翻译和一次写入 |
| `desktop/main.ts` / `preload.ts` | 窗口、托盘、窄IPC、权限入口、导入导出和模型准备 |
| `desktop/renderer/` | React界面、Markdown渲染与受限链接 |
| `desktop/processes.ts` | helper协议、认证后端、动态端口、SSE、空闲卸载与进程监督 |
| `Sources/YanmoNative/` / `YanmoBridge/` | 快捷键、AVAudioEngine、AX上下文与选区、当前焦点粘贴、临时音频清理 |
| `backend/server.py` / `pipeline.py` | 认证HTTP/SSE、串行推理、原始转写优先发布、取消与错误 |
| `engine/worker.py` / `fusion.py` | 任务提示词、候选与上下文输入、最终正文交付、划词Markdown代码保护 |
| `engine/language_hint.py` | 离线源语言提示，供转录提示词参考 |
| `engine/mlx_provider.py` / `online_provider.py` | 独立模型调用与明确启用的API适配 |
| `engine/model_cache.py` | 全局缓存定位、完整性检查及显式模型准备 |
| `scripts/bundle-runtime.py` | 构建可重定位Python运行时，按哈希锁定依赖 |

推理后端仅监听127.0.0.1动态端口，以每次启动的随机密钥认证；renderer不持有密钥或音频路径。Python只处理推理任务，不操作输入框。后端及模型准备进程以`-B`启动，避免向已签名的应用资源写入字节码。

## 模型与正文

默认Qwen3-ASR-1.7B-8bit识别；实际检测为中文/英文时，SenseVoice Small按zh/en再次识别，其他或未知语言跳过。SenseVoice共用一份多语言权重，按30秒分块限制内存；已加载模型复用，空闲卸载一并释放。

两路候选由Qwen3-4B-Instruct-2507-4bit结合完整语义与上下文生成最终正文。模型只返回普通文本或Markdown，程序原样采用。转录逐段保留原语言；只有翻译改变语言。数字按实际语义自然书写。手动修订通过USER_TEXT优先于历史识别，原始两路转写仍可对照。

语气整理关闭时使用verbatim任务，保留填充词和改口；口述翻译直接识别→翻译，不额外先整理。划词翻译只处理显式选区，保留Markdown及代码原样，不替换原选区、不保存历史。当前提示词与质量评测见[双路识别与正文生成](asr-fusion.md)。

仅空输出、生成截断、取消及运行失败按技术错误处理；识别原文保留供查看与重试。连续空闲一小时退出自有推理进程，录音开始后后台预加载，活跃任务保护进程。

## 缓存、数据与权限

下载默认ModelScope，新缓存位于用户级`~/.cache/codex/models/modelscope/`；复用SDK及Hugging Face完整缓存。日常推理只查本地缓存，设置页「准备模型」才允许下载；不在项目和安装包内存放权重。ASR与文字API分别配置、明确启用，默认仍本地MLX；真实在线服务待验收。

Electron数据位于`~/Library/Application Support/Yanmo/electron/`。首次启动从旧library.json复制并备份，导入白名单UserDefaults，保留原源文件；损坏数据暂停覆盖。诊断不保存用户口述正文或上下文。自动化使用YANMO_DATA_DIR隔离文稿与配置。

麦克风与辅助功能由macOS授权。开发签名更新可能使既有登记失效，此时移除旧言墨条目、添加当前应用，再在设置页重新检查。无需改动用户原快捷键配置。

### 本机应用更新

先在独立位置准备并校验完整应用。替换目标应用包之前，完整退出其Electron主进程、YanmoBridge和Python后端，并按完整包路径核对无残留；不要在旧进程存活时替换任何签名覆盖的文件或重签。保留可恢复的原包及用户配置/文稿校验值，再整体安装。

安装后完整启动新进程，检查实际辅助功能授权和原快捷键，验证鼠标点击、键盘输入及一次写入。ad-hoc签名的cdhash会随资源变更而改变，原授权可能需要由用户重新关联；更新前旧进程显示“已授权”和`codesign --verify --deep --strict`通过，都不能证明更新后进程仍有输入权限。权限不足时先退出旧监听进程，再处理系统授权。

2026-10-23输入故障：运行中更新引擎及签名封套后，旧桥接仍保持全局事件监听；系统在故障窗口记录8,068次`Sender is prohibited from synthesizing events`。监听掩码包含键盘与鼠标按下，不包含鼠标移动，与“能移动但不能点击/输入”一致。退出言墨后用户确认恢复；新签名完整启动显示待授权，恢复原签名完整启动后原授权与三组快捷键恢复，点击/Tab导航正常，随后90秒无同类错误。现场主进程与桥接均空闲，未见CPU或内存压力耗尽证据。这是签名更新与运行时权限不一致导致的输入链路故障，不能归因于整理模型计算。

故障恢复时先回滚本机包的三处更新文件，保留源码中的整理提示词与评测；配置和文稿哈希不变，最近输入已保存。此次未主动重现会锁住桌面的热更新；事件掩码解释属于结合日志与签名前后对照的机制判断。原始诊断只存本机`~/Library/Application Support/Yanmo/diagnostics/input-freeze-2026-10-23/`，不将口述正文或上下文写入仓库。

同日完成重新交付：在独立目录构建完整包，每次安装前核对主进程、YanmoBridge及Python后端全部退出，再整体替换`dist-electron/mac-arm64/言墨.app`。首次实体试写发现短句数词口吃仍漏清，修订`polish`的数字提示并重复完整安装流程。最终包内worker、fusion及prompt与源码哈希一致；构建、31项引擎、16项后端、27项桌面检查及原生快捷键5组检查通过，实际包内HTTP/SSE推理4/4，推理后deep/strict签名有效。

用户完成系统身份验证后重新关联新包，授权后再完整退出并启动，运行时显示辅助功能已授权、原三组快捷键启用、本地模型就绪。鼠标点击与键盘输入正常；用户实体测试确认左Control整理输出“预算两三千元”，左Shift＋左Control口述翻译输出“Deliverable on Friday.”，Control＋空格划词弹窗正常。最后一轮10分钟监测无`Sender is prohibited from synthesizing events`，未触发保护退出。配置逐字节不变，原文稿完整保留，仅新增4条本次试写记录；在线识别与文字开关仍关闭。

当前合成口吃对照28/32，原30条由24/30提高到26/30，无新增失败；语言18/18、范围与上下文50/50、受控双路21/22（原中文金额改口仍失败）。少数犹豫声、字词口吃、强调和不确定表达仍需改进，不能以本次短句通过推导所有数词组合均已解决。原文与诊断仅留本机`~/Library/Application Support/Yanmo/evaluations/clean-reinstall-2026-10-23/`；最终验收入口为`report.md`与`verification.json`，未发布新版本。

### Control＋空格与设置同时失效（2026-10-23）

现场运行包为`dist-release/mac-arm64/言墨.app`。实体Control＋空格已送入桥接并产生`selectionTranslation`，但`selection`请求一直没有回复；桌面停在`preparing`，整块设置因忙碌状态禁用。后端未开始翻译，重新授权不能解决。

桥接采样定位到`InputDestination.selectedText → SelectionMarkdown.fromHTML → nodesForXPath → XQuery → fileno → flockfile`。另一条命令线程正阻塞于Swift的`readLine()`；该函数等下一条stdin消息时持有C标准输入的FILE锁，Foundation解析内存HTML时也会获取这把锁，因此互相等待。

命令读取现归入`Sources/YanmoNative/BridgeInput.swift`，用`FileHandle.standardInput.availableData`直接读取管道、缓存不完整的UTF-8行并逐条交给原JSON协议。取消对stdin的C标准输入锁依赖；选区HTML转换和转写/整理协议保持原实现。

新增`swift run YanmoBridgeInputChecks`：子进程始终保持stdin打开，命令线程等待下一行时转换合成富文本。旧实现稳定在3秒时限内失败，修复后debug/release均通过；另覆盖中文字符跨分片、多命令同批和EOF前无换行的最后一条命令。原13项核心、5组快捷键与23项输入上下文检查均通过。该检查覆盖桥接真实的长连接条件，避免仅测试孤立HTML转换而漏掉锁竞争。

首轮交付以现场完整包为基础，只更新桥接后在独立位置签名校验，再完整退出主进程、桥接和后端后整体安装；当时`app.asar`与原包一致。用户实体确认翻译与设置均恢复，两次`selection`回复耗时61/57ms，任务正常回到idle。此轮调试进程的授权继承不能代替应用独立启动的权限检查。

用户随后要求重新编译，已按当前工作区完整执行构建、运行库核验与electron-builder打包，再整体替换`dist-release/mac-arm64/言墨.app`。桌面30项、后端18项、引擎34项及打包界面6项通过，4项需显式开启的采集/Dock专项跳过。包内main/preload、pipeline、worker及prompt与当前构建一致，deep/strict签名通过。用户完成系统触控ID后，已移除旧签名条目、按该完整路径重新添加原辅助功能授权；正常独立启动确认辅助功能已授权、三组原快捷键已启用、模型就绪，设置点击与Tab导航正常。原288篇文稿逐条保留，另有用户新增1篇；设置与词库未变。

无选区正文的现场请求、线程采样、原包备份和验收记录位于本机`~/Library/Application Support/Yanmo/diagnostics/shortcuts-2026-10-23/`；`verification.json`区分首轮实体检查与完整重编译后的独立启动验收。

## 验证入口

- 单元回归：`npm test`、`npm run typecheck`；`python -m unittest discover -s engine`及`backend`。
- 原生回归：`swift run YanmoChecks`、`swift run YanmoInputChecks`、`swift run YanmoLifecycleChecks`、`swift run YanmoShortcutChecks`、`swift run YanmoBridgeInputChecks`。
- 模型评测：`scripts/evaluate-fusion.py`、`check-transcription-language.py`、`check-translation-output.py`及`evaluate-voice-pipeline.py`，使用合成数据及本地真实模型。
- 打包回归：`desktop/e2e/transcription-language.spec.ts`及`translation-window.spec.ts`；语言用例在真实推理后检查deep/strict签名。
- 菜单栏事件回归：构建后运行`npx playwright test desktop/e2e/tray-clicks.spec.ts`，观察真实Tray的菜单绑定并触发注册的左右键事件；不替代打包版的系统鼠标点击验收。
- 包体检查：源码与资源一致、无模型权重和包外链接，进程退出无QA残留。

用户已确认Codex占位提示不再混入、微信可录音并写入当前焦点、Claude Code可用原快捷键写入。当前版本的微信/Claude口述翻译与日语实体输入仍需用户复测，合成音频不替代该项验收。

本轮清理回归：引擎31项、后端15项、桌面17项及类型/构建通过；原生核心13项、上下文23项、生命周期4项通过。真实本地模型的结果与剩余效果问题见[当前融合评测](asr-fusion.md)。

最终应用的3项打包回归通过，2项Dock专项按默认跳过；真实日语音频推理后的deep/strict签名有效。包内引擎与桌面构建资源一致，未发现废弃模块、权重或包外链接。旧SwiftUI对照包已于2026-10-22删除。

2026-10-22采用已评估的范围/残句提示词并重新打包；包内提示词SHA-256为`b0cc511af6cfe17d606858a76fe04d6c69d97ac2233f4000fa68ad82ef34eb4e`，与通过专项50/50的候选逐字一致。引擎31项、后端15项、桌面17项和构建通过。

包内引擎的当前口述边界、英文残句和翻译金额消歧3项复测通过；两项翻译窗口检查及真实日语音频检查通过，推理后deep/strict签名有效。日语检查按“午後3時/午後三時”的含义断言，保留模型选择的自然数字写法；程序不改写正文。

PermissionFlow资源已随新包携带，首次未授权环境的拖拽流程仍待专项验收。本次正式配置的新包已启动，用户完成macOS身份验证后，已重新关联同一应用的辅助功能授权；左Control、左Shift+左Control与Control+空格均显示已启用，本地模型就绪，原配置和文稿逐字节保留，主窗口已收回菜单栏。真实口述效果待用户复测。

2026-10-22删除旧0.3包后修复菜单栏点击：保留左键reveal，以right-click显式popUpContextMenu代替setContextMenu，避免macOS自动在左键弹出菜单。事件回归先在旧实现失败、修复后通过；17项桌面单测、类型/构建、2项打包窗口检查及deep/strict签名通过，2项Dock专项未开启。该事件检查观察真实Electron API并派发已注册的事件，未执行系统实体鼠标点击。旧build.sh入口已实跑并只生成0.4包；新包启动后原3组快捷键授权已恢复，配置与文稿哈希一致，旧包及测试进程无残留。记录位于本机`~/Library/Application Support/Yanmo/evaluations/tray-left-right-2026-10-22/`。

### 输入失败诊断日志（2026-10-27）

运行日志位于Electron数据目录的`diagnostics/`：`inference.jsonl`记录任务ID、阶段、耗时、API状态码、异常类型、生成结束原因与输出字符数；`desktop.jsonl`记录SSE事件、最后阶段、流异常与后端退出。分别按2MB轮转（推理保留2份备份，桌面1份），默认文件仅当前用户读写，日志写入失败不影响输入。诊断不记录请求/响应正文、上下文、音频、URL参数、认证头或异常原文。

可通过同一task_id关联两份日志；ReadTimeout/ConnectTimeout用于区分网络等待，api_response用于定位HTTP错误，api_generation的length用于定位生成截断，task_transport_error用于定位SSE中断。失败不自动回退或改写正文。历史失败无法由新增日志追溯。

### DeepSeek短输入无正文（2026-10-27）

15:21:06真实任务b2ce47d5的API返回200，finish_reason=length、output_chars=0、max_tokens=512，本机双路识别均成功；15:21:28下一次输入stop成功。DeepSeek官方thinking_mode文档声明默认启用思考，旧调用未显式关闭；推断思考消耗短输入预算，旧日志不含推理用量，不能还原具体消耗。

对api.deepseek.com的文字生成显式发送thinking.type=disabled，其他兼容服务不带该扩展。保留截断拒写与原文保留；诊断增加thinking_disabled、completion_tokens和reasoning_tokens计数，不记录推理正文。test_online_provider模拟默认思考用尽512预算，旧调用稳定失败、修复通过；官方依据https://api-docs.deepseek.com/guides/thinking_mode/。

修复交付验收：37项引擎用例（含新增3项）、20项后端、30项桌面及类型检查通过。包内真实DeepSeek三条合成中英文输入均200/stop，thinking_disabled=true、completion_tokens为8/7/9，API耗时645/730/902ms，均沿用512预算。整体安装前已完整退出，更新后重新关联辅助功能，并再次独立启动确认三键启用、点击与搜索键盘输入正常；配置及文稿哈希不变。证据位于本机diagnostics/deepseek-thinking-2026-10-27/verification.json，未记录凭证/正文。

### 0.4.4 发布候选（2026-10-27）

在线自然整理新增废弃起句清理，统一任务、风格及末尾语言提示；保留完整并列请求、独立残句、强调和保留原话模式。DeepSeek实际配置deepseek-flash，14个纯合成案例由旧提示词9/14提升到14/14，报告见`false-start-evaluation-2026-10-27.json`。扩展提示词对本地4B出现范围/语言退步，因此离线沿用原提示词，专项仍9/14；未宣称离线改善。

本轮桌面30、引擎38、后端20及类型检查通过；原生桥接长连接及5组快捷键检查通过，打包界面6项通过、5项需显式启用的采集/Dock/事件专项跳过。离线语言检查18/18通过。包内引擎与源码一致，deep/strict签名有效。替换前主进程、桥接及推理后端已全部退出，旧包移至本机diagnostics/release-044-2026-10-27/previous.app。独立启动正在完成系统钥匙串与辅助功能运行时验收。
