# 墨知桌面 · 和 Claude 一起读书

> 本地 PDF / EPUB 阅读器 + Claude Code 伴读。不只是"选中一段问 AI"——Claude 知道你读到哪、看得到书里的图，会在书页边上留批注、读完一章写笔记、你卡住时问一句，像一个陪你读完整本书的朋友。

<!-- TODO 截图：书库 / 阅读页（带 Claude 的波浪线批注）/ 伴读侧栏 / 足迹页 -->

## 和"AI 问答式阅读"有什么不一样

- **Claude 会主动开口**。伴读模式下，阅读器在合适的时机给 Claude 派任务：读完一章留几条段评、整理术语，同一页停太久问一句卡在哪，隔了几天回来打个招呼。每天有额度，可以逐项关掉。
- **Claude 在书上留痕**。批注直接画在书页上（金句高亮 / 知识点下划线 / 值得追问的波浪线），你可以回复，形成一段围绕原文的讨论。
- **Claude 记得你**。每本书一份学习进度摘要，外加跨书的长期记忆：你在哪卡过、对什么感兴趣、喜欢什么类比。
- **跟着你的节奏，不剧透**。默认只让 Claude 读你读过的最远位置。
- **用你自己的 Claude Code 订阅**，不需要 API Key，不经过任何第三方服务。书、进度、批注全在本机。

## 工作原理

```
 浏览器里的阅读器  ──HTTP──  本地服务 (127.0.0.1:8848)  ──MCP──  Claude Code
   选中 / 提问 / 翻页            存进度、批注、消息              读原文、看图、写批注、say
        ▲                            │
        └──── 侧栏实时显示回答 ◄──────┘
                                     │ 有新消息 / 主动陪读任务
                                     ▼
                       scripts/watch.mjs（Claude 用 Monitor 工具挂着）
                                     │ 输出一行通知 → 唤醒 Claude
```

- **Claude → 阅读器**：Claude 通过 `moread` MCP 工具读书、留批注、往侧栏发话。
- **阅读器 → Claude**：你在阅读器里点「问 Claude」、在侧栏留言、回复批注时，消息存进本地服务；Claude 用 Claude Code 的 Monitor 工具运行一个监听脚本，有新消息就被唤醒处理，回答再发回侧栏。**你不用切回终端**。
- 在终端里直接和 Claude 说话也可以：`UserPromptSubmit` hook 会自动附上你正在读哪本书、第几页、选中了什么。

## 环境要求

- **Windows**（目前只在 Windows 10/11 上测试过；启动脚本是 `.bat`，见[已知限制](#已知限制)）
- [Node.js](https://nodejs.org/) 18 或更高
- [Claude Code](https://docs.claude.com/claude-code)，已登录且版本支持 Monitor 工具
- 一个现代浏览器（Chrome / Edge）
- 可选：Python 3 + `pip install rapidocr onnxruntime pypdfium2`（扫描版 PDF 文字识别）

## 安装

```bash
git clone https://github.com/<你的用户名>/<仓库名>.git
cd <仓库名>
npm install
```

第一次启动会下载语义检索模型（约 118MB，存到 `%USERPROFILE%\.cache\moread-desk`）。下载中断可运行 `npm run fetch-model` 续传；国内网络可先设 `HF_ENDPOINT=https://hf-mirror.com`。

## 使用

1. 把 PDF / EPUB 放进仓库里的 `书库` 文件夹（可以有子文件夹，子文件夹就是分类）。里面自带一本示例书《Git 图解入门》（PDF 和 EPUB 各一份，内容是生成的示例文字），可以先拿它试试。想把书库放在别处，见[配置](#配置)。
2. 双击 **`启动阅读器.bat`**，浏览器会打开书库。第一次会在后台解析书、建索引。
3. 打开 Claude：
   - **伴读模式（推荐）**：双击 **`和Claude一起读.bat`**。它会以 `/companion` 启动 Claude Code，Claude 挂上监听后，阅读器里的提问和主动陪读任务都会实时到达，回答显示在阅读器侧栏。
   - **普通模式**：在本目录运行 `claude`。Claude 只在你在终端说话时响应，但同样知道你读到哪。
   - 第一次会询问是否启用本项目的 `moread` MCP 服务器、是否允许运行 `node scripts/watch.mjs`，都选允许。
4. 监听意外停了，在终端输入 `/companion` 即可恢复，期间的消息不会丢。

也可以用 Claude App 的 Remote Control 连上这个会话，在手机上看 Claude 的回复。

## 功能

### 阅读器

- **划线与批注**：四色划线（可加自选颜色）/ 波浪线；点划线查看批注和讨论，回复会发给 Claude
- **侧栏**：目录（标出已读，另有大纲 / 术语 / 书签）、批注（我的 / Claude 的）、笔记、伴读对话、查找（精确 + 按意思）
- **PDF**：连续滚动、缩放；**EPUB**：翻页 / 滚动切换、字号调节
- **阅读时长**：只在窗口有焦点、3 分钟内有操作时计时
- **读完判定**：读到正文结尾（不用翻完参考文献、索引）自动标记读完，也可以手动标记
- **目录坏了**（比如扫描版 PDF 每页一个页码书签）：一键请 Claude 根据书里印的目录页重建，原目录保留
- **导出**：单本书的摘要、大纲、术语、划线、笔记、对话导出为一个 Markdown 文件

### 扫描版 PDF：本机文字识别

用 [RapidOCR](https://github.com/RapidAI/RapidOCR) 在本机识别，**不联网、不上传**。从你读到的那页往后先识别，识别完的页马上能选中、划线、检索；在后台低优先级运行，可以暂停，下次接着识别。结果单独存放，不改原 PDF。

### 书库与其他页面

- **书库**：按阅读状态（在读 / 未读 / 读完 / 搁置）、分类、标签筛选
- **书单**：有顺序的读书计划，可以列还没下载的书；可以请 Claude 推荐、排序
- **回顾**：跨书浏览所有划线和笔记，勾选几条发给 Claude 串讲或出题
- **足迹**：认识 Claude 第几天、交流轮数、一起读的书、常聊时段，以及时长、连续天数、热力图等阅读统计
- **设置**：主动陪读的开关与额度、防剧透、主题、查看和删除 Claude 的长期记忆

### 主动陪读

只在伴读模式下生效。默认设置：

| 行为 | 默认 | 说明 |
| --- | --- | --- |
| 随读段评 | 开，读完一章后 | Claude 读这一章、在书页上留批注。可按章节或按页数分段，每天有上限；也可改成进入章节时 |
| 整理术语 | 开 | 读完一章时把新概念记进术语表 |
| 章节大纲 | 关 | 读完一章时写要点大纲，每个要点附原文依据 |
| 卡住时问一句 | 开，8 分钟 | 同一页停留太久 |
| 回来时打招呼 | 开，隔 6 小时 | 简短回顾上次读到哪 |
| 记录学习进度 | 开，读满 15 分钟 | 一段阅读结束后静默更新学习摘要与长期记忆 |
| 休息提醒 | 关 | |

「读完一章」= 翻到下一章，且这一章至少认真读了 3 分钟。所有主动行为每天合计最多 20 次。这些都占用你的 Claude 订阅用量；觉得打扰或用量紧张，在设置页关掉即可。

### Claude 的工具（`moread` MCP）

| 工具 | 作用 |
| --- | --- |
| `get_reading_progress` | 当前书、页码、章节、选中文字、今日阅读时长、所在书单 |
| `list_books` / `set_book_tags` | 书库（按状态、标签筛选）/ 打标签 |
| `list_reading_lists` / `save_reading_list` | 书单 |
| `list_chapters` / `read_book_section` | 目录（标已读）、读原文 |
| `search_book` | 语义向量 + BM25 混合检索（RRF 融合） |
| `grep_book` | 字面 / 正则精确查找 |
| `view_page` | 把 PDF 某页渲染成图片给 Claude 看，可只看一块（放大小图、公式） |
| `get_image` | 看 EPUB 里的图 |
| `list_annotations` / `add_annotation` / `reply_annotation` | 批注与讨论 |
| `list_notes` / `write_note` | 读书笔记 |
| `say` / `get_questions` | 在阅读器侧栏说话 / 取阅读器发来的消息 |
| `save_chapter_outline` / `list_outlines` | 章节大纲 |
| `save_term` / `list_terms` | 术语表 |
| `save_book_summary` | 每本书的学习进度摘要 |
| `save_toc` | 根据书里印的目录页重建目录 |
| `save_memory` / `recall_memory` | 跨书的长期记忆 |

Claude 怎么用这些工具（什么时候看图、批注写什么、语气），写在 [`CLAUDE.md`](CLAUDE.md) 和 [`.claude/skills/companion`](.claude/skills/companion) 里。想加自己的要求又不想改动仓库文件，可以新建 `CLAUDE.local.md`（不会被提交），Claude Code 会和 CLAUDE.md 一起读。

## 配置

`config.json` 是默认配置。想改哪项，就在同一目录新建 `config.local.json`，只写要改的那几项，它不会被提交，`git pull` 更新时也不会冲突。例如把书库放到别处：

```json
{ "libraryDir": "D:/我的书" }
```

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 8848 | 改了要同步改 `.mcp.json` |
| `libraryDir` | `./书库` | 书库目录，相对路径以仓库根目录为准 |
| `spoilerGuard` | true | 防剧透的初始值（之后以设置页为准） |
| `embedding.enabled` | true | 关掉则只用词法检索，不下载模型 |
| `embedding.modelDir` | 用户目录 `.cache` | **必须是纯英文路径**（onnxruntime 在 Windows 上读不了中文路径） |
| `ocr.python` | `python` | Python 不在 PATH 上时填完整路径 |

## 数据与隐私

- 所有数据在 `data/`（已被 `.gitignore` 忽略）：每本书一个文件夹（进度、批注、笔记、对话、大纲、术语、书签），以及全局的足迹、长期记忆和设置。**备份就复制这个文件夹。**
- 本地服务只监听 `127.0.0.1`。除了第一次下载检索模型，阅读器本身不联网；和 Claude 的对话走你自己的 Claude Code。
- 防剧透默认开启：工具只返回你读过的范围，除非你同意。

## 已知限制

- **目前只支持 Windows**：启动脚本是 `.bat`，打开浏览器用的是 Windows 命令。macOS / Linux 理论上可以手动运行 `node scripts/launch.mjs` 和 `claude "/companion"`，但没有测试过，欢迎 PR。
- 伴读模式下 Claude 每 30 分钟重启一次监听（Monitor 的时长上限），会占用极少量用量。
- 扫描版 PDF 识别之前不能检索、划线，但 Claude 仍可以用 `view_page` 看页面图片。
- 只支持无 DRM 的 PDF / EPUB。
- `server/channel.js` 是基于 Claude Code channels（研究预览）的旧方案，目前不使用。

## 致谢与参考

### 设计参考

- **[MoRead · 墨知](https://github.com/ovo066/MoRead)**（Android，GPL-3.0）：本项目的前身与灵感来源。名字、陪伴类功能的设计都参考了它，包括主动陪读（随读段评、卡住时问一句、回来时打招呼）、三种批注样式、陪伴足迹与"有效交流轮数"的统计口径、长期记忆、章节大纲与术语、回顾页、阅读状态（`BookReadState`：读完由进度推出、可手动覆盖）、标签与分组（`ShelfEntities`，这里简化为文件夹分类 + 字符串标签）。本项目没有复制 MoRead 的代码，是参考设计后用 JavaScript 重新实现，并针对 PDF 和 Claude Code 做了调整。

### 使用的开源代码与模型

| 项目 | 用途 | 许可 |
| --- | --- | --- |
| [foliate-js](https://github.com/johnfactotum/foliate-js) | EPUB 渲染（以源码形式随附在 `vendor/`） | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) | PDF 渲染、文字提取、页面截图 | Apache-2.0 |
| [Transformers.js](https://github.com/huggingface/transformers.js) | 本机运行向量模型 | Apache-2.0 |
| [multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)（[Xenova 转换版](https://huggingface.co/Xenova/multilingual-e5-small)） | 语义检索 | MIT |
| [RapidOCR](https://github.com/RapidAI/RapidOCR) · [ONNX Runtime](https://github.com/microsoft/onnxruntime) · [pypdfium2](https://github.com/pypdfium2-team/pypdfium2) | 扫描版 PDF 本机文字识别（可选） | Apache-2.0 / MIT / Apache-2.0 或 BSD-3 |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | `moread` MCP 服务器 | MIT |
| [Express](https://expressjs.com/) · [marked](https://github.com/markedjs/marked) · [fflate](https://github.com/101arrowz/fflate) · [node-html-parser](https://github.com/taoqf/node-html-parser) · [Zod](https://github.com/colinhacks/zod) | 本地服务、Markdown、解压、HTML 解析、参数校验 | MIT |

各 npm 依赖的完整许可见 `node_modules/<包名>/LICENSE`。

### 同类项目

如果这个项目不合你的需要，下面这些也许合适：

- [Albert-ycc/reading-companion](https://github.com/Albert-ycc/reading-companion)：macOS 上边读 PDF 边问 Claude Code 的桌面应用
- [JasonBates/claude-reader](https://github.com/JasonBates/claude-reader)：EPUB / PDF 阅读器 + MCP，Claude 可以在书页上实时高亮（Claude Desktop）
- [idleprocesscc/co-reading-mcp](https://github.com/idleprocesscc/co-reading-mcp)：共读 MCP，带阅读进度和页边批注
- [cynicalight/NeoRead](https://github.com/cynicalight/NeoRead)：本地 EPUB / PDF 阅读器，支持 Claude Code / Codex / Kimi CLI 助读

## 许可证

<!-- TODO 待定，见下方说明 -->
