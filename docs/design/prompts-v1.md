# 言墨视觉方案 v1 提示词

- 日期：2026-10-21。
- 工具：内置 Image Gen，未使用 CLI。
- 状态：2026-10-21 用户已确认，按这版实现。
- 主窗口：`main-window-v1.png`。
- Fn 浮层：`fn-overlay-v1.png`，以用户提供的紧凑胶囊截图和主窗口稿作为参考。

## 主窗口

```text
Use case: ui-mockup.
Create a polished, implementable high fidelity macOS desktop application UI screenshot for an open source LOCAL voice dictation app named exactly “言墨”, English name Yanmo. This is the MAIN APPLICATION HOME WINDOW design, one single app window, straight-on pixel sharp, landscape around 1600x1050. No phone, no browser, no perspective, no laptop hardware, no marketing poster, no surrounding annotations.

Design direction: contemporary Chinese classical scholarly studio, calm and beautifully restrained. Warm ivory xuan-paper background #F6F3EB with barely perceptible paper grain, near-black warm ink #292A27, pale warm dividers, small cinnabar #A44335 accents, subtle jade status dots. Elegant Songti / Chinese serif large display headings, highly readable modern Chinese sans serif for controls. Generous whitespace, delicate hairline rules, subtle rounded corners 10-14px, essentially flat editorial UI. The classical feeling should come from typography, spacing, paper and a small seal, not landscape paintings, dragons, bamboo, antique frames, tassels or ornament. This is a precise modern productivity tool, not a fantasy game.

Window composition:
- Normal subtle macOS titlebar with three small traffic lights at top left.
- Narrow left sidebar about 215px, slightly darker paper. At top a tiny square cinnabar seal logo with 白色“言”, next to clear brand “言墨” and tiny spaced YANMO. Four vertically spaced simple thin-line-icon navigation items, Chinese exact labels “书案”, “文稿”, “词库”, “设置”. “书案” selected with pale warm fill, small cinnabar indicator. Beneath brand a tiny “语音输入”. Bottom of sidebar shows small green dot “本地运行” and discreet “开源 · 私密 · 离线”.
- Large main area with comfortable 54px insets. Small eyebrow “书案 / 语音输入”. Top right tiny unobtrusive badge “所有处理留在本机”.
- Main hero heading exact “言语之间，自有笔墨。” big elegant black Chinese serif, 45px equivalent; subheading exact “说出所想，余下的交给言墨。”
- Below a large exceptionally composed open recording area bordered with a hairline and warm white fill, plenty of whitespace. Small label “开始一段新的表达”. In center a small tasteful minimalist circular ink-stroke ring around microphone icon, NOT oversized. Under it exact “按下 Fn，开始说话” with a tiny tactile Fn keycap. Supporting text “再次按下结束，文字落在光标处”. Small primary cinnabar button “开始录音” and secondary text button with upload icon “导入音频”. All buttons actual readable clickable dimensions.
- Under recording area, one thin horizontal row of three lightweight stats separated by vertical hairlines: “今日落笔” “0 字”; “累计口述” “0 分钟”; “常用词” “0 个”. No fake data, no bar charts.
- Lower main area a subtle section header “最近文稿” aligned with right action “查看全部 →”, then clean empty state with a delicate page icon and text “第一段文字，从开口开始。”
- Bottom baseline shows two tiny model status items with small jade dots “语音识别 · 本地” and “文字整理 · 本地”; far right “Fn 语音输入”.
Keep all Chinese text exactly legible. Strong visual hierarchy, exceptional spacing, quiet visual rhythm. Use natural modern Chinese in all UI, classical aesthetics only. No purple, bright blue, neon, glossy glass, strong shadows, stock images, decorative fake calligraphy, gradients or dense dashboard cards.
```

## Fn 浮层

```text
Use case: ui-mockup.
Create one high fidelity interaction design image for the Fn voice dictation floating panel of the macOS app “言墨” (Yanmo).

Input references:
Image 1 (small screenshot): BEHAVIOR AND PROPORTION reference only. It shows a very compact pill with left X cancel, center sound activity, right checkmark to finish. Retain that simple interaction hierarchy and compact footprint. Do not copy third-party code or brand.
Image 2 (large ivory main app): VISUAL SYSTEM reference. Match its refined warm paper, black ink, cinnabar and understated Chinese scholarly aesthetic. The overlay may be ink-black for legibility above any app.

Design: modern restrained Chinese classical productivity UI, not ornamented period art. Exact Chinese “言墨”, never “研墨”. No dragons, bamboo, traditional frames, gold trim, fancy fake brush text, blue or purple neon, glass glows.

Composition: A beautiful clean landscape design sheet around 1600x1100. Warm ivory background. At top left small “言墨” with square cinnabar seal, elegant heading exact “开口有声，落笔成文。” and very small subtitle “Fn 语音输入浮层”.
Middle top: a large cropped generic desktop document window with a few paragraphs of fictional gray Chinese writing about a quiet afternoon, readable but understated. The document takes about 65% width, with generous margin. Near the BOTTOM CENTER of that document window, show the actual tiny operational floating capsule at realistic size, width about 290px and height about 58px equivalent. A line of sample text at the document cursor says “把刚才的想法，写下来。” There is no large modal and no dimmed background. The floating pill looks like a slim inkstone in daily use; dark warm black #292A27, subtle warm border, soft small shadow, rounded endcaps. Left a neutral dark circular cancel X, middle a small cinnabar recording dot followed by delicate animated ivory waveform bars and tiny elapsed “00:12”, right an ivory circular button with a clean dark checkmark. Maintain clear 32-36px equivalent clickable circular buttons. No transcription paragraph inside the floating pill.
Under the document, make a horizontal hairline divider and present THREE enlarged, pixel-sharp pill states side by side with generous whitespace. Each on warm paper and visually consistent, labels above:
“01  正在聆听” — X on left, cinnabar dot, ivory real-looking audio waveform, timer “00:12”, large ivory check on right.
“02  正在整理” — X on left, subtle ivory loading indicator, short clear centered text “正在落笔…”, no active confirm button; preserve same pill dimensions.
“03  已经写入” — jade small check left, centered ivory “文字已写入”, no interactive buttons; same pill dimensions.
Beneath the three states a small quiet helper row of actual keycaps “Fn” and “再次按下，结束录音”, “Esc” and “取消”.
All states are DARK INK pills against PAPER UI, visually compatible with Image 2, compact and functional. Chinese labels must be crisp and exact, headings Songti serif but control text modern sans serif. Outstanding whitespace and hierarchy. The main display must show the floating input bar as a small tool, not a huge chat dialog. No marketing badges, no code, no extraneous commentary, no macOS hardware.
```
