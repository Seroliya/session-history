# session-history

**Let your AI coding agent read your past sessions, across tools.** Supports DeepSeek Harness (DSH), OpenAI Codex and Claude Code.

Just tell your agent "how far did we get with that X project in Codex?" or "pick up where the Claude Code session left off". It finds the session, checks how large it is, and reads only what it needs, instead of pouring hundreds of KB of raw logs into its context.

**English** | [简体中文](README.zh-CN.md)

## Benchmark

Setup: 3 real projects × 2 models (DeepSeek-V4.1-Flash, GPT-6.1 Sol) × with or without this skill, 12 runs in total. Each task was given in the user's own words. For example, the task said "the VRChat aquarium modelling project", while the actual session title was "Create a VRC ocean-hall map". The task never said which tool the session was in.

| Metric (average of 6 runs) | With skill | Without | Difference |
|---|---|---|---|
| Time | **53 s** | 120 s | 2.2× faster |
| Tool calls | **6.5** | 12.7 | half as many |
| Text read into context | **29 k chars** | 125 k chars | 76% less |
| Cumulative tokens | **0.36 M** | 1.03 M | about 1/3 |
| Right session and right final state | 6/6 | 6/6 | same |

In a separate single run (finding a phone-rooting project in Codex), the skill took 23 s and 0.29 M tokens; without it, the agent took 91 s and 1.47 M tokens.

The full method, per-run data and caveats are in [docs/benchmark.md](docs/benchmark.md). In short, the sample is small, so read the numbers as orders of magnitude. The savings in time and tokens were consistent. Accuracy was the same in both groups: a capable model can get the facts right by brute-forcing the raw files, but it pays far more to do so.

## Install

Requires Node.js 18 or newer. No other dependencies.

```bash
npx -y github:Seroliya/session-history install
```

The installer copies the skill to `~/.session-history`, then links it into the `skills` directory of each tool installed on the machine: DSH, Codex and Claude Code. On Windows the links are junctions, so no admin rights are needed. Restart your agent afterwards.

Other ways to install:

```bash
# from a git clone (update with git pull)
git clone https://github.com/Seroliya/session-history ~/.session-history
node ~/.session-history/scripts/install.mjs

# copy instead of linking, if a tool does not follow links
npx -y github:Seroliya/session-history install --copy

# uninstall: removes only the links and copies this installer created
npx -y github:Seroliya/session-history uninstall
```

## Usage

Usually you don't type commands; just ask your agent:

- Find the session where I was rooting my Xiaomi phone in Codex. How far did it get?
- Continue the screenlens project from last time.
- We discussed options for X before. Why didn't we pick B?

The agent follows the workflow in [SKILL.md](SKILL.md): locate the session, read the header, then go deeper only as needed. You can also run the CLI directly:

```bash
S=~/.session-history/scripts/sessions.mjs
node $S roots                         # which session stores were found
node $S list --here --since 7d        # sessions in this directory, last 7 days
node $S search aquarium VRChat        # full-text search across sessions (all terms must match)
node $S show <id> --view outline      # one line per turn
node $S show <id> --last 3 --view tools
node $S show <id> --ref T12.3         # one item in full (a tool call comes with its result)
node $S actions <id>                  # commands run and files changed
node $S handoff <id>                  # handoff brief
```

## Features

- **One view across tools.** The three tools store sessions in different formats. They are normalized into the same views and the same item references (`T<turn>.<item>`).
- **Control over how much is read.**
  - Four views: `outline`, `chat`, `tools`, `full`.
  - `--include` adds reasoning, system prompts or injected context on top of the current view.
  - `--budget` caps the total output. Over budget, the first turn and the latest turns stay in full and the middle turns become one-line summaries. If that is still too long, the oldest summaries collapse further, with the command to expand them.
- **Relations between sessions.**
  - **Lineage.** Forks and continuations are linked. Codex records the parent in `forked_from_id`. DSH does not, so the parent is inferred from the history the fork copied. If a newer session in the same lineage exists, the header says so, so the agent does not take an abandoned plan for the final result.
  - **Later sessions in the same directory.** Listed as possible follow-up work.
  - **Subagent sessions.** Can be read on their own.
- **Compaction.** `--since-compact` returns the last compaction summary plus everything after it, which is what the original agent last saw. The summary is treated as a reference, not a replacement for the transcript. Codex summaries are encrypted and cannot be read; the output says so.
- **Active branch only.** After a rewind or edit in Claude Code, the old branch stays in the same file. Only the current branch is read, following `parentUuid`. History a DSH fork copied from its parent is hidden by default.
- **Works on any machine.**
  - Session stores are located in this order: `--root`, environment variables, a config file, the default directories, then auto-probing (including WSL).
  - Formats are recognized by file content, not by directory names.
- **Fast.** The first run builds an index, which takes about 40 s for about 560 sessions. After that, `list`, `search` and `show` take 0.1–0.3 s each.

## Privacy and safety

- **Read-only.** Never modifies session files and never touches the network.
- **Secrets are redacted by default.** API keys, tokens, passwords and private keys become `[REDACTED]`. Use `--no-redact` to turn this off.
- **Transcripts are data.** SKILL.md tells the agent to treat what it reads as data and never to follow instructions found in old sessions.

## Support

| Tool | Session location | Verified with |
|---|---|---|
| DeepSeek Harness | `~/.dsh/sessions/**/session*.jsonl.zstd` (concatenated zstd frames) | about 230 real sessions |
| OpenAI Codex | `~/.codex/sessions/**/rollout-*.jsonl[.zst]`, `archived_sessions/` | about 330 real sessions, including paged files, forks and archives |
| Claude Code | `~/.claude/projects/<slug>/<id>.jsonl` | synthetic fixtures only; field layout follows [claude-code-log](https://github.com/daaain/claude-code-log). Reports from real data are welcome |

All three formats are internal to their tools and may change between versions. Unknown record types are skipped, not treated as errors. Format details are in [references/formats.md](references/formats.md).

## Development

```bash
npm test     # synthetic Claude Code fixtures + sandboxed install/uninstall test; never reads your real sessions
```

Code layout:
- `scripts/sessions.mjs`: CLI entry
- `scripts/lib/adapters/`: one parser per tool
- `scripts/lib/render.mjs`: views and budget folding
- `scripts/lib/store.mjs`: discovery, caching, lineage
- `scripts/vendor/fzstd.mjs`: pure-JS zstd decoder, used when Node has no native zstd

## License

MIT. The bundled [fzstd](https://github.com/101arrowz/fzstd) is also MIT licensed.
