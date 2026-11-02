# Benchmark: finding past sessions with and without session-history

**English** | [简体中文](benchmark.zh-CN.md)

Run on 2026-11-02, on a machine with about 560 past sessions (about 230 DSH and 330 Codex, about 660 MB compressed).

## Method

- **Task.** Describe a past project in the user's own words, and ask the agent to find the related sessions and report how far the project got. The task never says which tool the session lives in and never gives the real title.
- **Groups.**
  - With skill: the agent runs `sessions.mjs`.
  - Without: the agent may not read or run this skill. It can only read raw files with shell, grep and read; the zstd CLI and Node are available.
- **Isolation.** Sessions updated on the test day were off limits, because the test's own sessions contain the answers. All agents were read-only.
- **Metrics.** Each subagent's own session was read back with this skill, which gives:
  - time between its first and last record
  - number of tool calls
  - total characters of tool results, i.e. text read into context
  - cumulative tokens: input plus output summed over every step, mostly cache hits
- **Scoring.** Ground truth was established from the raw transcripts beforehand, and each answer was scored against it.

## Test 1: find the "root my Xiaomi phone" Codex session (DeepSeek-V4.1-Flash)

| | With skill | Without |
|---|---|---|
| Time | 22.9 s | 91.0 s |
| Tool calls | 6 | 20 |
| Tool-result text read | 15 k chars | 122 k chars |
| Cumulative tokens | 0.29 M | 1.47 M |
| Result | correct | correct |

## Test 2: 3 projects × 2 models × with/without, 12 runs

Each project as the user put it, and where it actually was:

| User's words | Where it really is | What makes it hard |
|---|---|---|
| "developing screenlens-mcp" | DSH, spread over 5 sessions and 2 directories, 2 of them forks | a later session reversed an earlier plan |
| "the VRChat aquarium modelling project" | Codex, titled "Create a VRC ocean-hall map" (in Chinese) | the user's words don't match the title; searching "aquarium" finds nothing |
| "collecting October 2026 embodied-AI news" | DSH, titled "Embodied robots October timeline video" (in Chinese) | 4 follow-up sessions in the same directory afterwards |

### Summary (average of 6 runs each)

| Metric | With skill | Without | Difference |
|---|---|---|---|
| Time | 53 s | 120 s | 2.2× faster |
| Tool calls | 6.5 | 12.7 | half as many |
| Tool-result text read | 29 k chars | 125 k chars | 76% less |
| Cumulative tokens | 0.36 M | 1.03 M | about 1/3 |
| Right session and right final state | 6/6 | 6/6 | same |

### By model

| Model | Group | Time | Tool calls | Tokens |
|---|---|---|---|---|
| DeepSeek-V4.1-Flash | with skill | 31 s | 8.3 | 0.42 M |
| DeepSeek-V4.1-Flash | without | 87 s | 14.7 | 1.28 M |
| GPT-6.1 Sol | with skill | 76 s | 4.7 | 0.29 M |
| GPT-6.1 Sol | without | 152 s | 10.7 | 0.78 M |

### Every run

| Project | Model | Group | Time | Tool calls | Text read | Tokens | Score |
|---|---|---|---|---|---|---|---|
| screenlens | DeepSeek | with skill | 31.4 s | 8 | 43 k | 0.44 M | ⚠ reported a reverted plan as done |
| screenlens | DeepSeek | without | 68.6 s | 16 | 134 k | 1.40 M | ✓ (took a fork for the project's origin) |
| screenlens | Sol | with skill | 115.8 s | 5 | 34 k | 0.31 M | ✓ most precise |
| screenlens | Sol | without | 145.5 s | 11 | 125 k | 0.83 M | ✓ (took a fork for the project's origin) |
| VRChat | DeepSeek | with skill | 28.5 s | 7 | 18 k | 0.40 M | ✓ |
| VRChat | DeepSeek | without | 124.8 s | 16 | 37 k | 1.09 M | ✓ (did not find the title) |
| VRChat | Sol | with skill | 59.2 s | 5 | 23 k | 0.29 M | ✓ |
| VRChat | Sol | without | 158.5 s | 8 | 99 k | 0.56 M | ✓ |
| embodied news | DeepSeek | with skill | 33.4 s | 10 | 29 k | 0.43 M | ✓ (missed the follow-up sessions) |
| embodied news | DeepSeek | without | 66.7 s | 12 | 166 k | 1.34 M | ✓ incl. follow-ups |
| embodied news | Sol | with skill | 51.9 s | 4 | 29 k | 0.26 M | ✓ incl. follow-ups |
| embodied news | Sol | without | 153.3 s | 13 | 187 k | 0.94 M | ✓ incl. follow-ups |

## Observations

- **Why the runs without the skill were slower and more expensive.**
  - 4 of the 6 began by recursively listing `.codex` or `.dsh`. A single listing hit the 50 k-character output cap.
  - Reading raw JSONL spends most of the tokens on encrypted reasoning, tool definitions and other noise.
  - One run decoded DSH files with `zstdDecompressSync`, which only decodes the first zstd frame. It worked this time only because the target was in Codex; had it been in DSH, most of the transcript would have been missed.
- **Accuracy did not separate the groups.** There was one real mistake in 12 runs, by DeepSeek with the skill: it read an older session whose plan a later session had reversed, and reported the reverted plan as done. Version 1.1 added lineage warnings and "later sessions in the same directory" hints for exactly this case (see the README). **These have not been re-benchmarked yet.**

## Caveats

- **Small sample.** One run per combination, so single runs can vary a lot. For example, Sol with the skill took 116 s on screenlens.
- **Two batches under different load.** At most 8 subagents could run at once, so the third project ran in a later batch. Compare times only within a batch.
- **Warm index.** The skill's index had already been built. On a new machine the first call spends about 40 s indexing; after that, each query takes 0.1–0.3 s.
- **Cumulative tokens are summed over steps,** including cache hits. Compare the ratios rather than the absolute numbers.
