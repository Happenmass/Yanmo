# 言墨视觉方案 v2 提示词

- 日期：2026-10-22。
- 工具：Codex 原生 Image Gen（`codex-imagegen` 脚本），参考图仅 `logo-v2.png`（只借用侧栏 Logo）。
- 状态：2026-10-22 用户已确认，侧栏以书案稿为准，已在 Electron 界面实现。
- 产出：`main-window-v2.png`（书案）、`manuscripts-v2.png`（文稿）。两页提示词 = 公共部分 + 各页部分。
- 样例数据均为虚构，不含真实口述。

## 公共部分

```text
Use case: ui-mockup. Create ONE polished, implementable, high fidelity macOS desktop application window screenshot, landscape 3:2, straight-on, pixel sharp. One single app window filling the frame. No laptop hardware, no browser, no perspective, no marketing poster, no annotations, no watermark.

App: an open source LOCAL voice dictation app named exactly “言墨” (never “研墨”). The attached reference image is the confirmed app logo: an ink brush character “言” on xuan paper with a tiny cinnabar seal. Reuse ONLY that logo, small, in the sidebar. Do not copy any other style from it.

Design direction v2 — extreme, restrained Chinese literati aesthetic, like a well-typeset Song dynasty book printed on xuan paper, translated into a precise modern tool. The Chinese feeling must come from typography, ruled lines, proportion, whitespace and seal red, NOT from ornaments: no dragons, bamboo, clouds, lanterns, frames, tassels, gold, fake calligraphy, landscape paintings in content areas.

Colour (traditional names, flat, no gradients):
- 宣纸 paper #F4EFE4 with a very faint visible fibre grain; sidebar a touch deeper #ECE5D6.
- 玄青 ink #23262A for text; 淡墨 secondary #8A8476; hairlines #D9D1C0.
- 朱砂 cinnabar #A8402F used sparingly: brand seal, current page marker, the single primary action.
- 石青 #3E6A80 tiny squares for "ready" status (NOT green dots).
- No pure white, no blue, no purple, no neon, no glass, no shadows except a whisper on the window itself.

Components (this is the key change from v1):
- Almost NO rounded cards or filled boxes. Content is separated by 乌丝栏-style thin vertical and horizontal hairlines (like ruled manuscript paper) and generous margins. Corner radius at most 2px anywhere inside the window.
- Buttons: the primary action looks like a 朱文印 seal: square corners, thin 1px cinnabar outline, cinnabar serif text, transparent background. Secondary actions are plain ink text with a short thin underline. No filled red pill buttons.
- No geometric line icons in navigation. Sidebar navigation is TYPE ONLY, in serif, generously spaced.
- Inputs are a single bottom hairline, no box.
- Keycaps are small square-cornered hairline boxes with serif-free monospaced labels.

Typography: headings in an elegant Chinese Song serif (思源宋体 / Noto Serif SC style), wide letter-spacing; secondary captions and taglines in a gentle Kai script typeface (霞鹜文楷 style); controls and body copy a clean readable sans. Minimum text size comfortable (no tiny 8px text). Chinese punctuation set tightly, small space between Chinese and Latin text. Numbers in serif.

Window chrome: normal macOS titlebar area with three small traffic lights top-left, merged into the sidebar.

Sidebar (about 200px wide, deeper paper):
- Top: small logo image from the reference, beside it “言墨” in large spaced Song serif, under it small “YANMO” letter-spaced, and a Kai-script line “语音输入”.
- Navigation, text only, Song serif, about 18px, vertical rhythm of 44px: “书案”, “文稿”, “词库”, “设置”. The selected item is cinnabar with a short 2px vertical cinnabar brush mark at its left; no filled highlight block.
- Bottom: a hairline, then a tiny 石青 square and “本地运行”, under it Kai script “开源 · 私密 · 离线”.

Top bar of the main area: breadcrumb using a middle dot, e.g. “书案 · 语音输入”, in small serif; far right a quiet hairline badge “所有处理留在本机” with a tiny lock.

Bottom status line of the main area, above a hairline: “▪ 语音识别 · 本地就绪”, “▪ 文字整理 · 本地就绪” with tiny 石青 squares; far right a keycap “左 Control” and “语音输入”.

All Chinese text must be exact and crisp. All sample data is fictional. Calm, quiet, expensive-looking, impeccable alignment to a clear grid.
```

## 书案页

```text
PAGE: “书案” (home) is selected in the sidebar. Save the image as main-window-v2.png.

Main area content, aligned to a strict grid with wide margins:
- Large Song serif heading exact “言语之间，自有笔墨。”, about 34px, wide letter-spacing. Under it in Kai script, muted: “让表达回到自然，让文字留有余地。”
- Below, two columns separated by ONE thin vertical hairline (no cards):
  Left column (wider), small serif section title “表达概览”. A row of four statistics separated by thin vertical hairlines, each a large serif number with a small unit and a muted label under it: “12,480 字 / 累计落笔”, “96 分钟 / 音频时长”, “138 字 / 分钟 / 平均口述速度”, “27 天 / 活跃天数”.
  Under that, a thin hairline, then a subtitle “落笔日历” with right-aligned muted “近 20 周”: a calendar of 20 week-columns × 7 days drawn as small SQUARE ink cells in five ink densities from 清水 to 焦墨, like ink washes on paper, with weekday labels “一 三 五 日”. A tiny legend “淡 ▫▫▪▪■ 浓”.
  Right column (narrow), section title “随处落笔”, Kai text “在任意输入框按下快捷键，说完后再按一次。”, keycap “左 Control”; then muted “语音翻译” with keycaps “左 Control” “Space”; then “划词翻译” with keycaps “⌥” “D”; a short hairline; a secondary text action with thin underline “导入一段录音”.
- Full-width hairline, then section title “最近文稿” with right secondary text action “查看全部 →”. Three rows like a ruled ledger, each separated by a hairline: one line of fictional text truncated with ellipsis on the left, muted time on the right:
  “下周例会把发布节奏和验收标准一起过一遍，提前把…” — “今天 10:42”
  “这一段改成更口语一点，别用太多书面词，读起来…” — “今天 09:15”
  “晚上回家前记得去取快递，顺便买点水果和牛奶。” — “昨天 18:30”
- Very bottom right of the main area, behind content, an extremely faint 远山 ink-wash mountain silhouette occupying only the empty corner, never behind text.
```

## 文稿页

```text
PAGE: “文稿” (manuscripts) is selected in the sidebar. Breadcrumb reads “文稿 · 每一次表达，都有迹可循”. Save the image as manuscripts-v2.png.

Main area content:
- Large Song serif heading exact “每一笔，都在这里。”; far right of the same line the single primary seal-style action (square corners, thin cinnabar outline, cinnabar serif text) “导入音频”.
- Below, two panes divided by ONE thin vertical hairline, like a ruled manuscript book (no cards, no boxes):
  LEFT pane, about 240px: a search field that is only a bottom hairline with muted placeholder “搜索文稿”. Then a ledger list; entries separated by hairlines, each with two lines of fictional text and a muted meta line with Chinese date and character count. The selected entry is marked by a short 2px cinnabar vertical brush mark at its left edge and slightly deeper ink text, no filled block. Entries:
    selected: “下周例会把发布节奏和验收标准一起过一遍，提前把问题列出来。” — “十月廿二 · 10:42” — “46 字”
    “这一段改成更口语一点，别用太多书面词。” — “十月廿二 · 09:15” — “19 字”
    “晚上回家前记得去取快递，顺便买点水果和牛奶。” — “十月廿一 · 18:30” — “22 字”
    “新版说明里补一句：所有处理都在本机完成。” — “十月廿一 · 14:06” — “20 字”
  RIGHT pane: small serif title “文稿正文” with muted “46 字” at right. Then the text body set directly on the paper like 稿纸 manuscript paper: faint 乌丝栏 ruled horizontal lines under each text line, comfortable 16px body text, line-height 1.9, fictional content:
    “下周例会把发布节奏和验收标准一起过一遍，提前把问题列出来。会前每个人先看一遍上次的记录，有分歧的地方当场定下来，不再拖到群里讨论。”
  Below the text, a muted disclosure “▸ 识别原文 · 两路对照”.
  A quiet notice line in 赭石 ochre colour (NOT red), with a tiny ochre square: “未确认写入：目标应用未返回可核验的结果，文稿已保留。” — no box, no red.
  Action row: primary seal-style action “复制正文” (square, thin cinnabar outline), secondary plain text action with thin underline “本地整理”, far right a muted text action “导出”.
- A barely visible 远山 ink-wash mountain silhouette only in the empty lower-right corner, never behind text.
```
