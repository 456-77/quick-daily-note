# Quick Daily Note

A daily-journal and todo companion plugin for Obsidian: one-click daily notes, a calendar panel with per-day todos, scheduled reminders, and paste/rendering enhancements.

## Features

### 📝 Daily Notes
- Click the calendar icon in the ribbon, or run the command "New daily note (enter name)" to create a note titled "date + name" — the folder and date format are configurable. If a note with the same name exists, it opens directly.
- In the sidebar calendar panel, double-click a date to open or create that day's note.

### ✅ Calendar & Todos
- The calendar panel manages todos per day: add with the input box (Enter), check off, double-click to edit text, ✎ to modify, × to delete.
- When yesterday has unfinished todos, a "Carry over to today" banner appears at the top — one click moves them to today, marked as "carried over".
- Below the calendar: stats for this month's diary days, consecutive diary days, and today's word count.

### ⏰ Reminders
- Scheduled prompts to add a todo, or to check the day's unfinished todos; clicking the notification opens the calendar panel.

### 📊 Weekly Review
- The command "Generate weekly review" summarizes the week's diaries (days, word count, titles) and completed/uncompleted todos into Markdown, inserted at the cursor.

### ⌨️ Paste Enhancements
- Auto-detect the language of pasted code (30+ languages, zero dependencies) and wrap it in a fenced code block; plain text, single-line weak matches, and pastes inside code blocks are left alone.
- Optionally save pasted images into a configurable folder (vault-relative path; empty = vault root) and insert the link at the cursor (off by default).

### 🖼️ Image Enhancements
- Images fit the note width automatically; overly tall images are height-limited.
- Hover a rendered image for a toolbar: crop, zoom, copy, rename, delete (deleting also removes the references in notes and moves the file to the system trash).
- Click an image to view it enlarged, with crop and other actions in the modal toolbar.

### 📈 Mermaid Enhancements
- Diagrams fit the container width (or render at original size), with a configurable height limit for tall diagrams.
- Toolbar on the diagram: zoom in/out, reset, download as SVG or PNG (export scale configurable).
- Diagrams adapt to the page width when printing or exporting to PDF — never clipped.

### 🌤️ Weather Recording
- When enabled, the current day's weather is fetched and written below the note title after creating a daily note (data from Open-Meteo, no API key; failures never block note creation).

## Screenshots

![Main view](image.png)
![Settings](image-1.png)
![Commands](image-2.png)

## Installation

### Community Plugin Browser (once listed)
Settings → Community plugins → Browse, then search for **Quick Daily Note**.

### BRAT (before listing)
1. Install the [BRAT](obsidian://show-plugin?id=obsidian42-brat) plugin.
2. Run the command `BRAT: Add a beta plugin for testing` and enter `456-77/quick-daily-note`.
3. Enable Quick Daily Note.

### Manual Install
Download the latest release from GitHub, and copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/quick-daily-note/`, then enable the plugin in Settings.

## Usage

### Commands

| Command | Description |
| --- | --- |
| New daily note (enter name) | Create a note titled "date + name"; opens the existing note if present |
| Open calendar & todo panel | Open the calendar and todo panel |
| Set heading level for selection | Normalize headings in the selected text block (toggleable in settings) |
| Generate weekly review | Summarize the week's diaries and todos at the cursor |

### Image Toolbar Buttons

| Button | Action |
| --- | --- |
| ✂ | Crop |
| ⛶ | Zoom in |
| ⧉ | Copy |
| ✎ | Rename |
| 🗑 | Delete (removes note references; file goes to the trash) |

## Settings

### Daily Notes

| Setting | Description |
| --- | --- |
| Storage folder | Folder for diary files; empty = vault root |
| Date format | moment format, e.g. `YYYY-MM-DD` |

### Feature Toggles

| Setting | Description |
| --- | --- |
| Auto-detect code language on paste | On by default |
| Set heading level for selection | On by default |
| Save pasted images to a folder | Off by default |
| Image storage folder | Defaults to `attachments` |
| Image rendering enhancements | On by default |
| Max image height | Percentage of viewport; 0 = unlimited; 70% by default |

### Mermaid Diagrams

| Setting | Description |
| --- | --- |
| Initial display mode | Fit width / original size; fit width by default |
| PNG export scale | 1x / 2x / 3x; 2x by default |
| Max diagram height | Percentage of viewport; 0 = unlimited; 60% by default |

### Weather

| Setting | Description |
| --- | --- |
| Record weather when creating daily notes | Off by default |
| City | e.g. Beijing, Shanghai |

### Reminders

| Setting | Description |
| --- | --- |
| Add-todo reminder | Off by default; 08:00 by default |
| Unfinished-todo check | Off by default; 21:00 by default |

## Data & Privacy

- All data is stored in your vault's `data.json`; nothing is uploaded to any server.
- The only network request is weather data from [open-meteo.com](https://open-meteo.com) when weather recording is enabled (public API, no key, off by default).

## Compatibility

- Requires Obsidian v1.7.2 or later.
- Works on desktop and mobile.

## Development

```bash
npm install
npm run build   # tsc type check + esbuild bundle
```

Build output: `main.js`, `manifest.json`, `styles.css`.

## Support & Feedback

Issues and suggestions are welcome at [GitHub Issues](https://github.com/456-77/quick-daily-note/issues).

## License

[MIT](./LICENSE)

---

# 中文文档

## 功能特性

### 📝 快捷日记
- 点击左侧功能区日历图标，或运行命令「新建日记（输入名字）」，即可创建标题为「日期 + 名字」的日记，日期格式与存放文件夹可自定义，同名日记直接打开。
- 右侧边栏日历面板：双击日期可直接打开或创建该日日记。

### ✅ 日历与待办
- 日历面板按日期管理待办：底部输入框回车添加，勾选完成，双击文字编辑，✎ 修改，× 删除。
- 昨天有未完成待办时，面板顶部显示「顺延到今天」横幅，一键将未完成项移到今天并标记「昨日遗留」。
- 日历下方显示本月日记天数、连续写日记天数、今日字数统计。

### ⏰ 定时提醒
- 每天到点提醒添加待办，或检查当天未完成待办；点击通知可直接打开日历面板。

### 📊 周回顾
- 命令「生成本周回顾」将本周日记（天数、字数、篇目）与完成/未完成待办汇总为 Markdown，插入到当前笔记光标处。

### ⌨️ 粘贴增强
- 粘贴代码自动识别编程语言（支持 30+ 种，零依赖），自动生成带围栏的代码块；普通文字、单行弱特征、代码块内粘贴均不干预。
- 粘贴图片自动保存到指定目录（vault 内相对路径，留空为库根目录），并在光标处插入图片链接（默认关闭）。

### 🖼️ 图片渲染增强
- 图片自动适应宽度，超高图按设置限制高度。
- 悬停图片出现悬浮工具栏：裁剪、放大、复制、重命名、删除（删除会同步清理笔记中的引用，文件进入系统回收站）。
- 点击图片放大查看，弹窗工具栏支持裁剪等操作。

### 📈 Mermaid 图表增强
- 图表自动适应宽度（或按原始大小显示），超高图按设置限制高度。
- 图表右上角工具栏：放大/缩小、重置、下载 SVG 或 PNG（导出倍率可调）。
- 打印或导出 PDF 时图表自动适配页面宽度，不会被裁剪。

### 🌤️ 天气记录
- 创建日记时自动获取当天天气并写入标题下方（数据来自 Open-Meteo，无需 API key，默认关闭，失败不影响创建）。

## 安装

### 社区插件市场（审核通过后）
设置 → 第三方插件 → 浏览，搜索 **Quick Daily Note** 即可安装。

### BRAT（上架前体验）
1. 安装 [BRAT](obsidian://show-plugin?id=obsidian42-brat) 插件。
2. 运行命令 `BRAT: Add a beta plugin for testing`，输入仓库地址 `456-77/quick-daily-note`。
3. 启用 Quick Daily Note。

### 手动安装
从 GitHub Releases 下载最新版本，将 `main.js`、`manifest.json`、`styles.css` 放入 `<库>/.obsidian/plugins/quick-daily-note/`，然后在设置中启用。

## 使用

### 命令

| 命令 | 说明 |
| --- | --- |
| 新建日记（输入名字） | 创建标题为「日期+名字」的日记，同名直接打开 |
| 打开日历与待办面板 | 打开日历与待办面板 |
| 选中文本设置标题等级 | 将选中文本块内的标题统一调整到指定等级（可在设置中关闭） |
| 生成本周回顾 | 汇总本周日记与待办并插入光标处 |

### 图片工具栏按钮

| 按钮 | 功能 |
| --- | --- |
| ✂ | 裁剪 |
| ⛶ | 放大 |
| ⧉ | 复制 |
| ✎ | 重命名 |
| 🗑 | 删除（同步清理笔记引用，文件进入回收站） |

## 设置

### 快捷日记

| 设置项 | 说明 |
| --- | --- |
| 存放位置 | 日记文件存放文件夹，留空为库根目录 |
| 日期格式 | moment 日期格式，如 `YYYY-MM-DD` |

### 功能开关

| 设置项 | 说明 |
| --- | --- |
| 粘贴代码自动识别语言 | 默认开启 |
| 选中文本设置标题等级 | 默认开启 |
| 粘贴图片保存到指定目录 | 默认关闭 |
| 图片保存目录 | 默认 `attachments` |
| 图片渲染增强 | 默认开启 |
| 图片最大高度 | 视口百分比，0 不限制，默认 70% |

### Mermaid 图表

| 设置项 | 说明 |
| --- | --- |
| 初始显示方式 | 适应宽度 / 原始大小，默认适应宽度 |
| PNG 导出倍率 | 1x / 2x / 3x，默认 2x |
| 图表最大高度 | 视口百分比，0 不限制，默认 60% |

### 天气记录

| 设置项 | 说明 |
| --- | --- |
| 创建日记时自动记录天气 | 默认关闭 |
| 城市 | 天气查询城市名，如：北京、上海 |

### 定时提醒

| 设置项 | 说明 |
| --- | --- |
| 添加待办提醒 | 默认关闭，默认时间 08:00 |
| 未完成待办检查 | 默认关闭，默认时间 21:00 |

## 数据与隐私

- 所有数据仅保存在当前库的 `data.json` 中，不会上传到任何服务器。
- 唯一的网络请求：开启天气记录后访问 [open-meteo.com](https://open-meteo.com)（公开天气接口，无需 API key）。

## 兼容性

- 要求 Obsidian v1.7.2 及以上
- 支持桌面端与移动端

## 开发

```bash
npm install
npm run build   # tsc 类型检查 + esbuild 打包
```

构建产物：`main.js`、`manifest.json`、`styles.css`。

## 支持与反馈

遇到问题或想提建议，欢迎提交 [GitHub Issues](https://github.com/456-77/quick-daily-note/issues)。
