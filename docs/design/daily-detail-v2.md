# 书案 · 当日详情 v2

2026-11-17 · 待确认

- 顶部展示所选日期的发送字数，以及截至该日期（含当日）的近 7 日曲线。选中日用朱砂点标记，悬停或键盘聚焦各点可查看日期与字数。统计启用前的日期留空，已开始记录且无发送的日期显示 0。日环比仅在两天数据均完整且前一天字数大于 0 时展示。
- 中部以系统应用图标、名称、相对长度横条和字数呈现应用排名。以发送总量降序，相对横条以榜首为基准，保留「已确认」「未验证」两列。Mac 版按目标应用的 Bundle ID 获取本机系统图标，未取得图标时使用通用图标。
- 底部列出已知 LLM token 总量和三项用途。存在未返回用量的调用时，在该区追加简短状态说明。
- 设计稿用虚构数值描绘有完整数据的一天。统计口径沿用已确认的 SQLite v3 方案。

## Image Gen 提示词

以日详情 v1 为编辑底图，以用户提供的输入法截图为信息层级参考。

```text
Create one revised, high-fidelity macOS UI mockup of 言墨 daily detail. Image 1 is the existing 言墨 draft and is the canvas to edit. Image 2 is a competitor screenshot used solely as inspiration for eye path: the viewer notices a big number, a seven-day plot, and app names with small recognizable colored app icons and bars. Do not import the competitor's branding, UI chrome, dark theme, decorative elements or assets. Use the input image 1 aspect ratio of 7:5, full-window straight-on view, existing xuan paper palette, sparse warm gray hairlines, dark ink typography, Song serif headings, restrained cinnabar, precise native desktop app typography. Keep image 1's exact outer chrome, sidebar, top breadcrumb, main hero “言语之间，自有笔墨。” and subtitle, narrow right ‘随处落笔’ area and bottom status area. Redesign only the central section below the slogan, between the left sidebar and the far right quick-actions column (x≈325–1117, y≈260–950 in image 1).

Design goal: strong first glance, real visual data hierarchy. Divide the center content into clear horizontal layers with open space. Prioritize DAY'S SENT CHARACTERS, never let the token total visually compete with the principal metric. In the date line show a small understated “‹ 返回日历” and “11月16日 · 周一” with the date close to it, and compact “‹ 前一天” and “后一天 ›” at far right. Use exactly one date line.

Below that date line, make a prominent single row with distinct left and right areas, each fitting its content:
- Left 30%: label “当日发送” small, numeral “2,320” in very large crisp serif (the largest single number in the panel), a small “字” beside it. Below a single understated comparison “较前一天 +25.4%”.
- Right 70%: a proper area/line chart on the paper (more than 400px wide), title “近 7 日发送字数”. Exactly seven equally spaced day marks “10日  11日  12日  13日  14日  15日  16日” beneath the chart. Plot seven matching points with values [860,1210,980,1720,1350,1850,2320]; y scale from 0 to 2500, first point at about 1/3 of height, second higher, third lower than second, fourth higher, fifth lower than fourth, sixth higher, seventh highest. Dark ink hairline with very light wash fill, subtle horizontal reference lines, and only the final point picked in cinnabar. Make the endpoint clearly distinct. Show sparse Y-axis guides 0, 1,250, 2,500 if they fit gracefully. Do not show numbers on every point. The chart is a compact but highly legible desktop chart. All chart data and labels align gracefully.

Middle layer underneath an understated hairline: “各应用发送字数” as a clear section title. Form three clean compact rows with small recognizable 22px icon mockups, app label, short horizontal bars on a light paper-tone track, then a right-aligned amount and two aligned secondary numeric columns. Icons can be stylized representations of macOS Notes (yellow header with white lined paper), WeChat (two white bubbles on green), and Safari (blue compass with small needle), drawn fresh for this mockup; they must match the adjacent app names and stay small. Keep the bar track lengths identical. Bars colored muted stone-blue #3E6A80, filled proportionately relative to the top value: first full, second about 61%, third about 26%. Use the following exact values with no variations. Column headings at the right above the last three number columns “发送总量 ↓” “已确认” “未验证”. Rows from top to bottom:
“备忘录”   “1,240”    “980”    “260”
“微信”       “760”      “0”    “760”
“Safari”     “320”      “320”  “0”
Do not turn the chart and list into a grid of cards, and do not put grid boxes around the rows. Use an understated separator line above and below the group.

Bottom layer: a visually lighter LLM section. In one row show “LLM 用量” followed by a medium sized “32,480” and tiny “token”. Beneath it in a single muted row with aligned groups, each label followed by its value: “文本润色 24,600” “热词提取 3,180” “翻译 4,700”. Leave enough room before the existing bottom chrome. This is a separate layer with space around it. No additional explanatory labels, copy, colors, shadows, outlines, rounded-card backgrounds, tooltips, or duplicate metrics. Ensure all supplied Chinese labels and numerals are crisp, spelled exactly as supplied, readable at the screenshot scale, and do not overlap. Return one image.
```
