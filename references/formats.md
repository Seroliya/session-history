# 存储格式与目录发现

这些格式都是各工具的内部实现，可能随版本变化。解析器遇到未知的记录类型会直接跳过，不会报错。

## 目录发现（`roots` 命令显示结果）

每个来源按以下优先级查找：

1. 命令行参数 `--root <src>=<路径>`：会覆盖该来源的其他所有设置。省略 `<src>` 时按目录内容自动识别。
2. 环境变量 `SESSION_HISTORY_ROOTS`：多个值用分号分隔，如 `dsh=D:\a;codex=/x/.codex;/some/dir`（没有前缀的条目会自动识别来源）。
3. 各工具自己的环境变量：`DSH_HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`。
4. 配置文件：Windows 为 `%APPDATA%\session-history\config.json`，其他系统为 `~/.config/session-history/config.json`。也可以用 `SESSION_HISTORY_CONFIG` 指定路径。格式如下：
   ```json
   {"roots": {"codex": ["D:/backup/.codex"]}, "extraRoots": ["/mnt/c/Users/me/.dsh"]}
   ```
5. 默认位置：`~/.dsh`、`~/.codex`、`~/.claude`。
6. 以上都找不到时，依次探测 `XDG_DATA_HOME`、`%APPDATA%`，以及 WSL 下的 `/mnt/c/Users/*`。

缓存目录：Windows 为 `%LOCALAPPDATA%\session-history\cache`，Linux 为 `~/.cache/session-history`，macOS 为 `~/Library/Caches/session-history`。可以用 `SESSION_HISTORY_CACHE` 覆盖，`--no-cache` 则完全不使用缓存。缓存按“文件路径 + 修改时间 + 大小”判断是否失效，会话有变化会自动重建。

当前会话的识别依据是环境变量 `SESSION_HISTORY_CURRENT`、`DSH_SESSION_ID`、`CODEX_THREAD_ID` 或 `CLAUDE_SESSION_ID`。

## DSH

- 路径：`<DSH_HOME>/sessions/<cwd-slug>/<id>/session.v4.jsonl.zstd`。旧版文件名为 `session.jsonl.zstd`。
- 文件由多个 zstd 帧拼接而成，每次追加写入一帧。会话运行中时，最后一帧可能不完整。代码先按帧头切分，再逐帧解码；优先使用 Node ≥ 22.15 自带的 zlib，否则回退到内置的 fzstd。
- 第一条记录是 `{"type":"session", cwd, isSeeded, delegationDepth}`，其余是 `{type, seq, time, data}` 形式的事件。
- 用到的事件类型：
  - 轮次边界：`turn/start`、`turn/end`（`reason.kind=aborted` 表示中断）
  - 消息：`user/message`（`data.source.kind` 区分来源：`user` 是真人；`agent-message` 和 `subagent-settled` 是代理消息；`compact-checkpoint` 是压缩摘要；其余是注入内容）、`assistant/message`（内容块类型为 text、reasoning、tool-call）、`tool/result`
  - 提示词：`system/message`、`request/header.system`
  - 压缩：`compaction/summary`
  - 子代理：`subagent/catalog`（父会话记录子会话 id）、`subagent/descriptor`（子会话自身的描述）
  - 其他：`todo/write`、`goal/change`、`deliverables/presented`、`session/title`
- fork 会话：`isSeeded=true`，第一条 `session/end-seed` 之前的内容是从父会话复制来的，标记为 inherited，默认隐藏。

## Codex

- 路径：`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<时间>-<threadId>[_<pageId>].jsonl[.zst]`，以及 `archived_sessions/` 下的归档。会话标题来自 `session_index.jsonl`。
- 一个线程可能分成一个基础文件和多个分页文件。分页文件里的 `session_meta.history_base.end_ordinal_exclusive` 标明它从哪里接续。如果某个分页从更早的 ordinal 重新开始（回滚或编辑），会替换掉之前的尾部。合并时按 ordinal 去重并排序。
- 记录形式为 `{timestamp, ordinal, type, payload}`，`type` 的取值有 `session_meta`、`turn_context`、`response_item`、`event_msg`、`compacted` 等。
- 用户消息：根据 `internal_chat_message_metadata_passthrough.content_item_metadata[].provenance.type` 区分，`user` 是真人，`harness`、`agents_md` 等是注入内容。旧版文件没有这个字段，改为按开头的标签判断。
- reasoning 和 `response_item.compaction` 通常是加密的，`agent_message` 的正文也是加密的。这些内容无法读取，只做标注。
- `event_msg.task_started` 表示新的一轮开始，`turn_aborted` 表示中断。
- 子代理：子线程的 `session_meta.source.subagent` 和 `parent_thread_id` 记录了父子关系。

## Claude Code

- 路径：`<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd-slug>/<sessionId>.jsonl`。子代理在 `<sessionId>/subagents/agent-<id>.jsonl`，同目录下有一个 `.meta.json` 描述文件。
- 记录类型：`user`、`assistant`、`system`、`summary`、`ai-title`、`custom-title`、`attachment` 等。`message.content` 里的块类型有 text、tool_use、tool_result、thinking、redacted_thinking、image。
- 分支：回退或编辑消息后，旧分支仍留在文件中。代码从最后一条 user/assistant 记录出发，沿 `parentUuid` 往回走，重建当前分支；遇到 compact 边界时，改用 `logicalParentUuid` 跨过去。如果链条断开，就保留文件里的全部记录。
- compact：`system` 记录的 `subtype` 为 `compact_boundary`，之后紧跟一条 `isCompactSummary:true` 的 user 记录。
- `isSidechain:true` 的记录不属于主线，在主会话中会被跳过；`isMeta:true` 的记录视为注入内容。
- 本机上没有真实的 Claude Code 数据。字段依据来自 daaain/claude-code-log（models.py、dag.py）和 swyxio/claude-compaction-viewer，并用 `tests/run.mjs` 中的合成样例验证。
