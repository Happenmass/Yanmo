# 书案 · 当日详情 v1

2026-11-17 · 待确认

- 点击落笔日历中的日期，在书案中央打开当日详情。顶部提供返回日历及前后日入口。
- LLM 用量展示已收到的 token 总量及文本润色、热词提取、翻译分类。存在未返回用量的请求时，提示次数。
- 应用按发送总量降序，分别显示已确认和未验证字数。截图使用虚构数值。
- SQLite v3 将调用与发送事件存入本机。关闭文稿保存后继续记录统计，统计独立于文稿保留期限。启用前的日期显示「未开始记录」。

## Image Gen 提示词

参考图为用户提供的书案截图，含指向日历的红箭头。

```text
Edit the attached real Yanmo (言墨) macOS main-window screenshot into one high-fidelity UI design draft for the selected day's daily details. Treat the attachment as the exact desktop UI shell and keep its 7:5 widescreen framing, straight-on orientation, traffic lights, near-exact positions and scale, sidebar logo and navigation typography, warm muted xuan paper, elegant Chinese Song serif, restrained cinnabar, right column, and bottom status bar. Keep the big brand line “言语之间，自有笔墨。” and its subtitle at their original positions; they are outside the region being replaced. Keep the right “随处落笔” quick actions and import section visually the same. Remove the red arrow annotation. At the top change breadcrumb only to “书案 · 当日详情”. Do not add any new outer frame, depth, presentation annotations, title outside the app, buttons in the sidebar, or style elements. Exact typography, no rounded cards, hairline rules, ample reading space, no heavy decorative artwork. The sidebar still selects “书案” in cinnabar.

Replace ONLY the middle-left main content section formerly occupied by “表达概览” and the calendar, from x≈490 to 1676 and y≈390 to 1300 on the 2240×1600 reference (21.9%–74.8% horizontally and 24.4%–81.2% vertically); the new content should occupy this width, flush at the old left edge. This region is a clear, fully legible page within the existing layout; do not display the calendar in it. Use the following exact text and sample values once, with all rows in view:

1. Small quiet cinnabar underlined back action “‹ 返回落笔日历” at upper left of this section. Below it, a concise large Song serif heading “2026年11月16日”, small subdued “星期一” immediately beside the date. On the far right of that date row, compact separated date navigation “‹ 前一天” and “后一天 ›”. Subtle full-width horizontal rule separates the date header and report.
2. First group: title “LLM 用量” left. Display total “32,480” in large serif with small “token”, right-aligned on the same group heading row for fast comparison. Below, three evenly spaced text columns aligned to grid, separated with vertical hairline rules, each label with its value on the line below, no cards: “文本润色” with “24,600”, “热词提取” with “3,180”, “翻译” with “4,700”. Add a muted small status line under the columns that reads exactly “另有 1 次调用未返回用量”. One full-width horizontal divider between the groups.
3. Second group: title “各应用发送字数”. A plain airy table on the paper with four columns. Left align app names and right align numeric columns. Small muted headers “应用”, “发送总量 ↓”, “已确认”, “未验证”. Four lines total including headers and exactly three data rows, separated only by fine warm-gray rules. Text only, no app icons or bars. Numbers: “Codex” | “1,240” | “980” | “260”; “微信” | “760” | “0” | “760”; “文本编辑” | “320” | “320” | “0”. Sorted largest first. Add a single quiet footnote under the table “未验证：已发送粘贴，目标应用未确认接收。” Use readable small text and place it above the bottom status divider. Do not repeat the table title or add other explanatory copy.

Emphasize the total token amount and date visually, keep the typography and precise alignment crisp and native. Do not put annotation boxes, colored fill cards or red overlays on the UI. Chinese labels must reproduce the exact supplied Chinese characters, no lorem ipsum. The fictional values illustrate design only. Return one image.
```
