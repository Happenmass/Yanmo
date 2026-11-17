# 书案 · 当日详情 v3

2026-11-17 · 按用户确认的 v2 布局修订并实现于 Electron

- 点击落笔日历的日期，中央区域打开当日详情。顶部可返回日历或切换前后日期。
- 顶部以发送字数为主，符合条件时旁列环比。用户确认当日详情聚焦单日，移除 v2 的近 7 日折线图。两天数据均完整且上一日字数大于 0 时展示环比。
- 应用榜单展示系统图标、相对发送量横条和字数，按发送总量降序，「已确认」「未验证」分列。
- 底部展示已知 LLM token 总量及文本润色、热词提取、翻译分类。有调用未返回用量时显示次数。
- 图中数字为虚构示例。统计独立于文稿保存与保留期限，启用前的日期显示「未开始记录」。

## Image Gen 提示词

参考图为当前目录的当日详情 v2。

```text
Edit the attached Yanmo (言墨) macOS app design draft in place. This is a narrow revision to the daily detail screen: delete the entire "近 7 日发送字数" chart on the right of the "当日发送" summary, including its title, plot, axes, line, points, labels, shading and the short vertical divider between chart and count. Keep only the selected date's metrics. Preserve the resolution and exact framing, paper background, macOS controls, sidebar, typography, red "书案" navigation selection, header, taglines, right "随处落笔" panel, bottom status bar, original icons, and color palette. Preserve the top date row, its date text, and the back/previous/next controls.

The only changes to the central daily details content are:
- Make the "当日发送" summary a compact full-width paper strip between the date row and the app ranking, without a card or border box. Keep the existing prominent "2,320 字" very large at left with "当日发送" stacked above and "较前一天 +25.4%" in smaller text at its right on the same numeral baseline. Let the rest of the strip breathe on plain warm ivory paper. Keep the red accent on "+25.4%". Omit all charts except the existing horizontal proportional bars in the app table.
- Because the new summary strip is shorter than the old chart and summary row, move the unchanged "各应用发送字数" table and the "LLM 用量" group together slightly higher (roughly 60–80 pixels in a 1484×1060 image). Keep the generous plain area beneath. Do not recenter the main content or change any internal spacing, typography, columns, proportions, or information of these two groups. Maintain table icons (yellow Notes, green WeChat, blue Safari), labels and exact numbers: "备忘录" 1,240 / 980 / 260, "微信" 760 / 0 / 760, "Safari" 320 / 320 / 0. "发送总量 ↓", "已确认", "未验证" remain. Keep "LLM 用量" with "32,480 token" and the line "文本润色 24,600" · "热词提取 3,180" · "翻译 4,700".

Do not introduce any new UI components, panels, labels, date ranges, trend visuals, annotations or decorative elements. Keep the resulting screen a sharp and accurate native desktop app mockup with all Chinese characters exact. Output a single image.
```
