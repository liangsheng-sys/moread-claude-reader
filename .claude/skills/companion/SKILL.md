---
name: companion
description: 开始伴读模式：监听墨知阅读器，实时接收用户在阅读器里的提问、留言、批注回复和主动陪读任务。用户说「开始伴读」或运行 /companion 时使用。
---

# 开始伴读

1. 用 **Monitor** 工具启动监听（不要用 Bash 后台运行）：
   - command：`node scripts/watch.mjs`
   - description：`墨知阅读器消息`
   - timeout_ms：`3600000`（实际会被限制为 30 分钟）
2. 看到 `[墨知] 已连接阅读器` 后，在终端只回一句「伴读已开始，在阅读器里问我就好」，不要多说。
3. 之后每条通知是一段 `[墨知 kind=... book_id=... section=...]` 加正文：
   - `kind=ask`（选中原文后提问）/ `kind=message`（伴读面板留言）：用户在看书、不在看终端。先 `read_book_section` 看原文，再用 `say` 把回答发到阅读器侧栏。
   - `kind=reply`（回复某条批注，带 `annotation_id`）：用 `reply_annotation` 回在那条批注下。
   - `kind=event`（主动陪读任务，带 `event`、`task_id`）：按正文要求做，`add_annotation` 时传上 `task_id`；按 CLAUDE.md「主动陪读任务」一节的约定。
   - 这些消息已经标记为已读，不用再调用 `get_questions`。
   - 处理完在终端只回一句话说明做了什么。
4. **监听到期（Monitor 报告超时 / 结束）时，立刻用同样的参数重新启动**，不用告诉用户。监听断开期间的消息会留在收件箱，重启后自动补发。
5. 用户在终端直接说话时照常在终端回答。
