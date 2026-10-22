# 言墨首次使用引导提示词

- 日期：2026-10-22。
- 工具：Codex 原生 Image Gen（`codex-imagegen` 脚本），参考图 `main-window-v2.png`、`logo-v2.png`。
- 状态：2026-10-22 用户已确认，已在 Electron 主窗口实现（`desktop/renderer/App.tsx` 的 `Onboarding`）。
- 产出：`onboarding-v1-dictation.png`（第一步）、`onboarding-v1-translation-window.png`（第四步）。样例数据均为虚构。

```text
Use case: ui-mockup. Create TWO polished, implementable, high fidelity macOS desktop application window screenshots, landscape 3:2, straight-on, pixel sharp. One single app window filling the frame. No laptop hardware, no browser, no perspective, no marketing poster, no annotations, no watermark. Save them as onboarding-v1-dictation.png and onboarding-v1-translation-window.png.

App: an open source LOCAL voice dictation app named exactly “言墨” (never “研墨”). The attached reference image main-window-v2.png is the CONFIRMED current main window; match its visual language exactly (xuan paper, ruled hairlines, Song serif headings, Kai captions, cinnabar seal buttons, type-only sidebar). The attached logo-v2.png is the app logo, reuse it only small.

Colour (traditional names, flat, no gradients): 宣纸 paper #F4EFE4 with faint fibre grain, sidebar #ECE5D6; 玄青 ink #23262A; 淡墨 #8A8476; hairlines #D9D1C0; 朱砂 cinnabar #A8402F only for brand seal, current step marker and the single primary action; 石青 #3E6A80 tiny squares for status. No pure white, no blue, no purple, no glass, no shadows except a whisper. Corner radius ≤2px. No ornaments, no dragons, no clouds, no fake calligraphy.

WHAT THIS IS: the FIRST-RUN GUIDE (首次使用引导) shown inside the main window the very first time the app opens. It replaces the main content area (the sidebar stays visible but dimmed to 40% and not interactive). It is a short 4-step guide, like turning pages of a thin stitched book. No modal card, no rounded box: the guide sits directly on the paper, framed only by hairlines.

Shared layout for the guide area:
- Top: small Kai line “初次见面” and on the right a quiet ink text action with thin underline “跳过引导”.
- A step rail: four short labels in Song serif separated by thin hairlines, the current one cinnabar with a 2px cinnabar short vertical brush mark at its left; the others 淡墨: “一 语音输入”, “二 划词翻译”, “三 口述翻译”, “四 翻译弹窗”.
- Left half: large Song serif heading (about 30px, wide letter-spacing), a Kai subtitle, then 2–3 short numbered lines of plain instructions in sans, then a row of hairline keycaps.
- Right half, separated by ONE thin vertical hairline: a small faithful illustration of what the user will see (a miniature drawn in the same flat UI style, no photos, no hands, no laptop).
- Bottom row above a hairline: muted “1 / 4” page count in serif at left; at right a plain ink text action “上一步” and the primary seal-style button (square corners, 1px cinnabar outline, cinnabar serif text, transparent background) “下一步”.
- Very faint 远山 ink-wash mountain only in the empty lower-right corner, never behind text.

IMAGE 1 — onboarding-v1-dictation.png, step 一 语音输入 is current:
- Heading exact “开口，即成文字。” Kai subtitle: “在任何输入框里说话，言墨把它写下来。”
- Instructions: “1  把光标放进任意输入框” “2  按一下 左 Control 开始说话” “3  说完再按一次，文字写入光标处；Esc 取消”. Keycaps: “左 Control”, and muted “或” then “⌃” “Space”.
- Illustration: a miniature generic text editor window (light paper, a couple of grey placeholder lines and a blinking caret) and, floating at its bottom centre, the app's recording capsule: a small 200×36 black-ink pill with a tiny × at left, a dry-brush ink stroke waveform, time “00:04” and a round check button at right. Under the illustration a tiny Kai caption “录音时，底部只出现一枚小墨条”.
- Bottom: “1 / 4”, “上一步” greyed out, primary “下一步”.

IMAGE 2 — onboarding-v1-translation-window.png, step 四 翻译弹窗 is current:
- Heading exact “译文，另起一页。” Kai subtitle: “划词翻译的结果在独立弹窗里，不改动原文。”
- Instructions: “1  在弹窗顶部切换目标语言，或重新翻译” “2  「排版 / 源码」切换 Markdown 显示” “3  复制译文后关闭，译文不会保存”. A small 石青 square with “全程在本机翻译”.
- Illustration: a miniature of the translation popup window in the same style: titlebar, small logo, title “划词翻译”, Kai “读懂另一种表达”, a row with “译为 英语 ▾” and a tiny segmented control “排版 | 源码”, a collapsed line “▸ 原文 32 字”, two short lines of fictional English translation text, and at the bottom a seal-style “复制译文” and plain “关闭”.
- Bottom: “4 / 4”, “上一步”, and the primary seal-style button reads “开始落笔”.

All Chinese text must be exact and crisp. All sample data fictional. Calm, quiet, impeccable alignment to a clear grid.
```
