# 墨知桌面 · 和 Claude 一起读书

本地 PDF / EPUB 阅读器 + Claude Code 伴读。阅读器跑在浏览器里，Claude 在终端（或 Claude App 的 Remote Control）里陪你读：知道你读到哪、能检索全书、看得到书里的图，会在书页上留批注、写章节笔记。

不经过任何第三方服务：书、进度、批注都存在本机，Claude 通过 Claude Code 自己的订阅运行（MCP 是 Claude Code 主动来读阅读器，不是反向代理）。

## 用法

1. 把书（PDF / EPUB，可以有子文件夹）放进 `E:\cc伴读\书库`。
2. 双击 **`启动阅读器.bat`**，浏览器会打开书库。第一次会在后台解析书、建语义索引（模型约 118MB，下载到 `%USERPROFILE%\.cache\moread-desk`）。
3. 在本目录打开 Claude Code：
   - **普通模式**：`claude`。你在终端说话时，Claude 自动知道你读到哪、选中了什么。
   - **伴读模式（推荐）**：双击 **`和Claude一起读.bat`**。在阅读器里选中文字点「问 Claude」、在侧栏留言、回复批注，Claude 都会实时收到，回答也发回阅读器侧栏，不用切回终端。启动时会有开发者频道的确认提示，选 *I am using this for local development*。
   - 第一次会询问是否启用本项目的 `moread` MCP 服务器，选同意。

## 阅读器

- **选中文字** → 四色划线 / 波浪线 / 问 Claude / 复制
- **点划线** → 查看批注和讨论，可以回复（回复会发给 Claude）
- **侧栏**：目录（✓ 标出已读）、批注（我的 / Claude 的）、笔记、伴读对话
- PDF：连续滚动，A− / A+ 缩放，← → 翻页；EPUB：翻页 / 滚动切换，A− / A+ 字号
- 记录阅读时长：只在页面可见且 3 分钟内有操作时计时

## Claude 的工具（`moread` MCP）

| 工具 | 作用 |
| --- | --- |
| `get_reading_progress` | 当前书、页码、章节、选中文字、今日阅读时长 |
| `list_chapters` / `read_book_section` | 目录（标已读）、读原文 |
| `search_book` | 语义向量 + BM25 词法混合检索（RRF 融合） |
| `grep_book` | 字面 / 正则精确查找 |
| `get_image` | 看 EPUB 里的图（PDF 由 Claude 直接读页面） |
| `list_annotations` / `add_annotation` / `reply_annotation` | 批注与讨论 |
| `list_notes` / `write_note` | 读书笔记 |
| `say` / `get_questions` | 在阅读器侧栏说话 / 取阅读器里发来的消息 |

默认只读你读过的最远位置（防剧透，也让 Claude 跟着你的节奏），可在 `config.json` 里把 `spoilerGuard` 设为 `false`。

## 配置 `config.json`

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `port` | 8848 | 改了要同步改 `.mcp.json` |
| `libraryDir` | `../书库` | 书库目录 |
| `spoilerGuard` | true | 检索 / 读取是否限制在已读范围 |
| `embedding.enabled` | true | 关掉则只用词法检索 |
| `embedding.modelDir` | 用户目录 `.cache` | **必须是纯英文路径**（onnxruntime 在 Windows 上读不了中文路径） |

模型下载中断时可运行 `npm run fetch-model`（支持断点续传；国内网络可先设 `HF_ENDPOINT=https://hf-mirror.com`）。

## 已知限制

- 扫描版 PDF 没有文字层：不能检索、不能划线，但 Claude 仍可以直接看页面图片。
- 「伴读模式」依赖 Claude Code 的 channels（研究预览），需要 claude.ai 账号登录；以后接口可能变化。
- 只监听 `127.0.0.1`，局域网其他设备访问不到。
