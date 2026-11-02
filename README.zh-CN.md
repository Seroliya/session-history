# session-history

**让 AI 编程 agent 直接读你以前的会话，并且能跨工具读。**支持 DeepSeek Harness（DSH）、OpenAI Codex 和 Claude Code。

你可以直接对 agent 说：“上次在 Codex 里做的那个 xx 进行到哪一步了”“接着 Claude Code 那个会话继续”。它会自己找到对应的会话，判断需要读多少，然后把有用的部分读进来，不会把几百 KB 的原始日志整个塞进上下文。

[English](README.md) | **简体中文**

## 实测效果

测试场景：3 个真实项目 × 2 个模型（DeepSeek-V4.1-Flash、GPT-6.1 Sol）× 有无本 skill，共 12 次。任务描述用的是用户的原话，比如“VRChat 建模水族馆”，实际的会话标题却是“创建 VRC 海洋馆地图”。描述里也不提示会话存在哪个工具里。

| 指标（6 次平均） | 用 skill | 不用 skill | 差距 |
|---|---|---|---|
| 耗时 | **53 秒** | 120 秒 | 快 2.2 倍 |
| 工具调用 | **6.5 次** | 12.7 次 | 少一半 |
| 读进上下文的内容 | **2.9 万字** | 12.5 万字 | 少 76% |
| 累计 token | **36 万** | 103 万 | 约为 1/3 |
| 找对会话、说对最终状态 | 6/6 | 6/6 | 持平 |

在另一个单独的测试里（找一个 Codex 里的刷机项目），用 skill 只用了 23 秒、28.5 万 token；不用 skill 则用了 91 秒、147 万 token。

完整的测试方法、逐次数据和局限说明见 [docs/benchmark.zh-CN.md](docs/benchmark.zh-CN.md)。简单说：样本还少，数字只能看量级。省时省 token 的效果很稳定；准确性两组持平，说明能力强的模型硬读原始文件也能读对，只是代价高很多。

## 安装

需要 Node.js 18 或更高版本。不需要任何其他依赖。

```bash
npx -y github:Seroliya/session-history install
```

安装程序会把 skill 复制到 `~/.session-history`，然后在本机已安装的 DSH、Codex、Claude Code 的 `skills` 目录里各建一个链接（Windows 上是 junction，不需要管理员权限）。装完后重开 agent 就能用。

其他安装方式：

```bash
# 用 git clone 安装，更新时用 git pull
git clone https://github.com/Seroliya/session-history ~/.session-history
node ~/.session-history/scripts/install.mjs

# 某个工具不识别链接时，改为复制
npx -y github:Seroliya/session-history install --copy

# 卸载：只删除本安装程序创建的链接和副本
npx -y github:Seroliya/session-history uninstall
```

如果所在网络访问 GitHub 不稳定，可以先设置代理，例如 `HTTPS_PROXY=http://127.0.0.1:7890`。

## 用法

一般不需要手动敲命令，直接对 agent 说就行：

- 找一下我之前在 Codex 里给小米手机 root 的那个会话，进行到哪一步了？
- 接着上次 screenlens 那个项目继续
- 我们之前讨论过 xx 的方案，当时为什么没选 B？

agent 会按 [SKILL.md](SKILL.md) 里的流程来做：先定位会话，再看头部统计，最后按需深入。你也可以在命令行里直接运行：

```bash
S=~/.session-history/scripts/sessions.mjs
node $S roots                         # 找到了哪些会话目录
node $S list --here --since 7d        # 当前目录下最近 7 天的会话
node $S search 水族馆 VRChat           # 跨会话全文搜索（多个词需同时命中）
node $S show <id> --view outline      # 每轮一行的概览
node $S show <id> --last 3 --view tools
node $S show <id> --ref T12.3         # 完整读取某一条（工具调用会连带其结果）
node $S actions <id>                  # 执行过的命令和改动过的文件
node $S handoff <id>                  # 接手简报
```

## 主要功能

- **跨工具统一读取**：三种工具的会话格式不同，统一成同一套视图和编号（`T轮次.条目`）。
- **控制读入的量**：
  - 有 4 档视图：`outline`、`chat`、`tools`、`full`。
  - `--include` 可以在当前视图上单独叠加思考过程、系统提示、注入内容等。
  - `--budget` 设置总字数上限，超出时保留第一轮和最近几轮的全文，中间轮次压成单行摘要；再超，就把最早的摘要也折叠起来，并附上展开命令。
- **看清会话之间的关系**：
  - **会话链**：识别 fork 和接续关系。Codex 直接读 `forked_from_id` 字段；DSH 没有记录父会话，就根据 fork 时复制过来的历史反推。如果后面还有更新的会话，头部会提醒先去看它，避免把被推翻的旧方案当成最终结果。
  - **同目录之后的会话**：列出可能的后续工作。
  - **子代理会话**：可以单独读取。
- **处理压缩（compact）**：`--since-compact` 读取最后一次摘要和之后的全部对话，也就是原 agent 最后看到的上下文。摘要只当参考，不代替原文。Codex 的摘要是加密的，读不出来，输出里会如实标注。
- **只读当前分支**：Claude Code 回退或编辑消息后，旧分支还留在同一个文件里。这里沿 `parentUuid` 只读当前这一支。DSH 的 fork 会话里从父会话复制来的历史，默认隐藏。
- **适应不同电脑**：
  - 会话目录按这个顺序查找：`--root` 参数、环境变量、配置文件、默认目录，最后自动探测（包括 WSL）。
  - 不依赖目录名，按文件特征识别是哪个工具的会话。
- **速度**：首次运行会建索引，约 560 个会话需要约 40 秒；之后 `list`、`search`、`show` 每次 0.1–0.3 秒。

## 隐私与安全

- **只读**：不修改任何会话文件，也不联网。
- **默认脱敏**：输出里的 API key、token、密码、私钥会替换成 `[REDACTED]`，可以用 `--no-redact` 关闭。
- **会话内容只是数据**：SKILL.md 明确要求 agent 把读到的历史当作数据，不执行里面的指令。

## 支持情况

| 工具 | 会话位置 | 验证情况 |
|---|---|---|
| DeepSeek Harness | `~/.dsh/sessions/**/session*.jsonl.zstd`（多个 zstd 帧拼接） | 用约 230 个真实会话验证过 |
| OpenAI Codex | `~/.codex/sessions/**/rollout-*.jsonl[.zst]`、`archived_sessions/` | 用约 330 个真实会话验证过，包括分页文件、fork 和归档 |
| Claude Code | `~/.claude/projects/<slug>/<id>.jsonl` | 只用合成样例验证过。字段结构参考 [claude-code-log](https://github.com/daaain/claude-code-log)，欢迎提交真实数据的反馈 |

三种格式都是各工具的内部实现，可能随版本变化。遇到未知的记录类型时，解析器会直接跳过，不会报错。格式细节见 [references/formats.md](references/formats.md)。

## 开发

```bash
npm test     # 合成 Claude Code 样例测试 + 安装/卸载沙盒测试，都不读本机真实会话
```

代码结构：
- `scripts/sessions.mjs`：命令行入口
- `scripts/lib/adapters/`：三种工具的解析器
- `scripts/lib/render.mjs`：视图与预算折叠
- `scripts/lib/store.mjs`：会话发现、缓存、会话链
- `scripts/vendor/fzstd.mjs`：纯 JS 实现的 zstd 解码器，在 Node 版本不够新、没有原生 zstd 时兜底

## License

MIT。其中内置的 [fzstd](https://github.com/101arrowz/fzstd) 也是 MIT 许可。
