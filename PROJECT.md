# PROJECT.md — session-history

面向维护者和接手开发的 agent。说明项目为什么这样设计、怎么验证、哪些地方还没把握。用户文档在 README，模型使用说明在 SKILL.md，存储格式细节在 references/formats.md。

## 背景与目标

AI 编程 agent（DSH、Codex、Claude Code）的会话记录各自存在本机，格式不同，而且大多经过压缩。用户常问“上次在另一个工具里做的 xx 进行到哪一步了”。如果没有工具，agent 只能直接去翻原始文件，代价高，也容易读错。

目标是让模型**一次读到位、读得准、不浪费上下文**。读者是模型，不是人，所以：
- 不做图形界面。
- 输出要分级、可截断，并且带上引用编号，方便按需深入。
- 不做 LLM 摘要。读取方本身就是模型，自己总结即可，也不用把会话内容发到外部服务。

成功标准有三条：
- 找对会话
- 说对当前状态（包括识别出后来被推翻的方案）
- 与直接读原始文件相比，时间和 token 明显更少（测试方法见 docs/benchmark.md）

## 代码结构

```
SKILL.md                    模型看到的使用说明（触发描述、推荐流程、注意事项）
scripts/cli.mjs             npm bin 入口：install / uninstall 交给 install.mjs，其他命令转给 sessions.mjs
scripts/sessions.mjs        命令行：roots / list / search / show / actions / handoff
scripts/install.mjs         安装器：npx 运行时先复制到 ~/.session-history，再给各工具的 skills 目录建链接
scripts/lib/zstd.mjs        按帧头切分多帧 zstd 并逐帧解码；有 Node 原生 zlib 就用它，否则用 fzstd
scripts/lib/model.mjs       统一的会话模型 SessionBuilder：turns、items、引用编号 T<轮>.<序号>、统计
scripts/lib/adapters/*.mjs  dsh / codex / claude 三个解析器，各自实现 discover() 和 parse()
scripts/lib/roots.mjs       查找会话目录：--root > SESSION_HISTORY_ROOTS > 各工具环境变量 > 配置文件 > 默认目录 > 自动探测
scripts/lib/store.mjs       会话发现、两级缓存（index.json + 每个会话的 digest）、id 查找、会话链 relations()
scripts/lib/render.mjs      视图、预算折叠 layout()、头部、会话链提示
scripts/lib/actions.mjs     从工具调用里提取执行过的命令和改动过的文件
scripts/lib/util.mjs        路径、时间、脱敏、能容错的 JSONL 解析
tests/run.mjs               合成 Claude Code 样例的端到端测试，完全隔离，不读本机真实数据
tests/install-test.mjs      安装 / 卸载沙盒测试，模拟 npx 运行
docs/benchmark*.md          有无 skill 的对比测试（中英文）
```

## 运行流程

1. `Store` 按 roots 找到各工具的会话目录，适配器的 `discover()` 列出所有会话及其文件。
2. `summaries()`：按“路径|修改时间|大小”生成签名，命中缓存就直接用，不命中才解析，并同时写好搜索用的 digest。
3. `show`：完整解析会话 → 按 `--since-compact`、`--after`、`--turns`、`--last`、`--grep` 选出范围 → `layout()` 在预算内排版 → 输出头部、正文和底部的继续命令 → 统一脱敏。
4. `search` 只查 digest，速度很快；只有搜索思考过程、系统提示、注入内容时才需要完整解析。

## 设计决策

- **用 Node 而不是 Python**：Python 3.13 没有内置 zstd，Node 22.15+ 有。另外内置了 fzstd，所以 Node 18 也能用，整个项目零依赖。
- **DSH 自己切 zstd 帧**：DSH 每次追加写入一帧。Node 的 `zstdDecompressSync` 只解第一帧，流式解码遇到会话运行中、末尾还没写完的帧会报错。
- **会话模型统一为“轮 + 条目”**：引用编号覆盖所有条目，和当前视图无关，所以同一个 `--ref` 在任何视图下都指向同一条。
- **预算折叠的顺序**：第一轮（最初的请求）和最近几轮保留全文，中间轮次降为单行摘要，再超就把最早的摘要也折叠掉。最新一轮哪怕超长，也会截断后显示，而不是只留一行。
- **compact 摘要只当参考**：它只压缩了当时更早的上下文，之后对话还在继续，所以不能代替原文。`--since-compact` 会把摘要单独显示，最多占预算的 40%。Codex 的摘要多数是加密的，这时标为 encrypted，也不再推荐 `--since-compact`。
- **会话链**：
  - Codex 直接读 `forked_from_id` 字段。
  - DSH 没有记录父会话 id。但 fork 会把父会话的历史复制过来，所以复制部分的第一条用户消息就是整条链的起点。起点相同的会话归为一条链，起点消息至少 15 个字，避免“你好”“继续”这类开头把无关会话串到一起。
  - 这个功能来自测试中的一次实际错误：模型读了一个旧会话，把后来被推翻的方案当成了最终结果。
- **fork 继承的内容默认隐藏**：DSH 在第一条 `session/end-seed` 之前的内容是从父会话复制来的，标为 inherited，不计入统计，也不进搜索，避免重复命中。从父会话继承来的待办和目标会注明来源。
- **Claude Code 只读当前分支**：从最后一条消息沿 `parentUuid` 往回走，遇到 compact 边界时改用 `logicalParentUuid` 跨过去。链条断了就保留全部内容，宁可多读也不丢内容。
- **handoff 的“最后状态”**：取最后一条 200 字以上的回复，跳过“1”“好的”这类简短收尾，并注明后面还有几条简短回复。
- **脱敏**：“key = value”形式的规则只在值像真实密钥时才替换，也就是含数字或长度在 16 以上，并且不是变量、命令或占位符。代价是不含数字的短密码会漏掉。
- **安装器只动自己创建的东西**：只替换链接或带 `.installed-copy` 标记的副本；普通目录可能是别人的源码仓库，不碰。删除链接时只删链接本身，因为在 Windows 上递归删除 junction 可能删到目标目录里的真实文件。
- **仓库统一用 LF 换行**（`.gitattributes`）：CRLF 会让 bin 脚本的 shebang 在 macOS 和 Linux 上失效。
- **测试必须隔离**：三个来源都用 `--root` 指向临时目录，不能只换其中一个。曾经因为只换了 Claude，每次跑测试都要把本机几百个真实会话全部重新解析。

## 已知局限与待办

- Claude Code 只用合成样例验证过，字段结构依据 claude-code-log 的源码。有真实数据后，应先跑一遍 `show` 和 `search` 核对。
- Codex 和 Claude Code 能否通过链接加载 skill 还没实测。如果不能，就用 `install --copy`。
- 会话链只覆盖 fork 关系，在别的目录新开的后续会话只能靠搜索找到。
- Codex 的 fork 不复制父会话历史，目前只在头部提示去读父会话，没有把父会话的内容合并进来。
- v1.1 新增的会话链提示还没重新跑测试验证效果。
- 首次建索引大约每百个会话 7 秒。

## 验收与发布

1. `npm test`：两套测试必须全部通过。
2. 改了解析器或缓存结构时，要把 `store.mjs` 里的 `CACHE_VERSION` 加一，否则旧缓存不会失效。
3. 用本机真实数据抽查：
   - `roots`
   - `list`
   - `show <有 compact 的会话> --since-compact`
   - `show <fork 会话>`
   - `search <词>`
4. 推送前扫描仓库，不能出现本机用户名、绝对路径或真实密钥。
5. 版本号要同时改 `package.json` 和 SKILL.md 的 `metadata.version`。用户通过 `npx -y github:Seroliya/session-history install` 安装时，拉取的是 main 分支的最新版本。

## 对比测试方法（复跑时沿用）

- **任务描述**：用用户的原话，不说明会话在哪个工具里，也不给真实标题。
- **对照组**：用 skill 的子代理 vs 禁止使用本 skill、只能直接读原始文件的子代理。成对同时启动，同一批内的耗时才能比较。
- **隔离**：禁止读取测试当天更新的会话，因为测试自身产生的会话里已经包含答案。
- **度量**：测试结束后，用本 skill 读回每个子代理的会话，统计耗时、工具调用次数、工具结果字数和累计 token。不要采信子代理自己报告的次数，它们常常少报。
- **评分**：先读原始记录定好标准答案，并记下易错点，比如被推翻的方案、后续会话、fork 起点。
