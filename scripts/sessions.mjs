#!/usr/bin/env node
// session-history: read DSH / Codex / Claude Code session transcripts across sessions.
// Read-only. Run `node sessions.mjs help` for usage.
import fs from 'node:fs';
import path from 'node:path';
import { Store, cwdMatch } from './lib/store.mjs';
import { SOURCES } from './lib/roots.mjs';
import { zstdBackend } from './lib/zstd.mjs';
import { makeOpts, layout, header, fmtItem, findItem, parseRef, visible, relationLines, VIEWS, INCLUDABLE } from './lib/render.mjs';
import { extractActions } from './lib/actions.mjs';
import { lastOf } from './lib/model.mjs';
import { redact, oneLine, fmtTime, fmtK, parseSince, clip, cacheDir } from './lib/util.mjs';

const HELP = `session-history — 跨会话读取 DSH / Codex / Claude Code 的历史记录（只读）

用法: node sessions.mjs <命令> [参数]

命令:
  roots                       显示找到的会话目录、会话数、配置与缓存位置
  list                        列出会话（按更新时间倒序）
  search <关键词...>           跨会话全文搜索（多个词需同时命中）
  show <id|last>              读取一个会话（先输出头部统计，再按视图输出正文）
  actions <id|last>           只列出执行过的命令和改动过的文件
  handoff <id|last>           生成接手简报（规则提取，可能遗漏，细节用 show 核实）

通用参数:
  --source dsh,codex,claude   限定来源（默认全部）
  --here | --cwd <路径>       只看当前目录 / 指定目录（含子目录）的会话
  --since 7d|12h|2026-10-01   时间下限
  --root <src>=<路径>         临时指定会话目录（可重复；src 省略则自动识别）
  --out <文件>                输出写入文件（UTF-8），终端只打印摘要
  --no-redact                 关闭脱敏（默认把 API key / token / 密码替换为 [REDACTED]）
  --no-cache                  不读写缓存
  --json                      list / search 输出 JSON

list:   --limit 20  --grep <词>(标题/首条消息)  --subagents(包含子代理会话)  --all(不限数量)
search: --in user,assistant,agent,compact,tools,results,reasoning,system,notice|all (默认 user,assistant,agent,compact)
        --limit 10(会话数)  --per 3(每会话命中数)  --regex  --include-current  --subagents
show:   --view outline|chat|tools|full (默认 chat)
        --include tools,results,reasoning,system,notice,inherited  在视图之上叠加类别
        --turns 3-7 | --last 5 | --after T12.3 | --since-compact   选择范围
        --ref T5.3[,T6.1]   完整读取指定条目（工具调用会连带其结果）
        --grep <词>  只看命中的轮次（--context 1 前后各带几轮）
        --budget 20000 总字数上限（0=不限）  --max-msg N 单条上限
actions: --all(全部命令，默认最近 60 条)  --full(命令不截断)
handoff: --budget 8000

id 可写前缀（≥4 位），也可写 dsh:xxxx 限定来源；last = 最近一个非当前、非子代理会话。`;

// ---------- argv ----------
const BOOL = new Set(['here', 'no-redact', 'no-cache', 'json', 'subagents', 'all', 'regex', 'include-current', 'since-compact', 'full', 'help']);
function parseArgs(argv) {
  const a = { _: [], root: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      let [k, v] = t.slice(2).split(/=(.*)/s);
      if (BOOL.has(k)) { a[k] = v === undefined ? true : v !== 'false'; continue; }
      if (v === undefined) v = argv[++i];
      if (v === undefined) throw new Error(`参数 --${k} 缺少值`);
      if (k === 'root') a.root.push(v); else a[k] = v;
    } else a._.push(t);
  }
  return a;
}
const list = (v) => (v ? String(v).split(',').map((x) => x.trim()).filter(Boolean) : []);
const int = (v, d) => (v === undefined || v === true ? d : (Number.isFinite(+v) ? +v : d));

function sourcesOf(a) {
  const s = list(a.source);
  for (const x of s) if (!SOURCES.includes(x)) throw new Error(`未知来源 ${x}（可选 ${SOURCES.join(', ')}）`);
  return s.length ? s : SOURCES;
}
function cwdOf(a) { return a.here ? process.cwd() : a.cwd ? path.resolve(a.cwd) : ''; }

// ---------- output ----------
function emit(text, a) {
  const out = a['no-redact'] ? text : redact(text);
  if (a.out) {
    const p = path.resolve(a.out);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, out, 'utf8');
    process.stdout.write(`已写入 ${p}（${fmtK(out.length)} 字，${out.split('\n').length} 行）。用 read 工具分段读取。\n`);
  } else {
    process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  }
}

function resolveOne(store, a) {
  const q = a._[1];
  if (!q) throw new Error('缺少会话 id（可用 list / search 查找，或用 last）');
  const r = store.find(q, { sources: sourcesOf(a), cwd: cwdOf(a) });
  if (r.error) {
    let msg = r.error;
    if (r.candidates) msg += '\n' + r.candidates.slice(0, 10).map((e) => `  ${e.source} ${e.id}  ${fmtTime(e.mtime)}`).join('\n');
    throw new Error(msg);
  }
  return r.entry;
}

// ---------- commands ----------
function cmdRoots(store) {
  const { roots, notes, configPath: cp, configExists } = store.rootInfo;
  store.entries();
  const L = ['# 会话目录'];
  for (const src of SOURCES) {
    const rs = roots[src];
    if (!rs.length) { L.push(`${src}: 未找到（可用 --root ${src}=<路径>、环境变量或配置文件指定）`); continue; }
    for (const r of rs) L.push(`${src}: ${r.path}  [来源 ${r.via}]  ${r.exists ? `${r.count ?? 0} 个会话` : '不存在'}${r.error ? '  错误: ' + r.error : ''}`);
  }
  if (notes.length) L.push('', '提示:', ...notes.map((n) => '  ' + n));
  L.push('', `配置文件: ${cp}${configExists ? '' : '（不存在，可选）'}`,
    `缓存目录: ${cacheDir()}`, `zstd 解码: ${zstdBackend}`, `Node: ${process.version}`,
    `当前会话: ${store.current || '(未识别)'}`);
  return L.join('\n');
}

function filterSummaries(store, a, { defaultLimit }) {
  const since = parseSince(a.since);
  const cwd = cwdOf(a);
  let rows = store.summaries(store.entries(sourcesOf(a)));
  rows = rows.filter((r) => {
    const m = r.meta;
    if (!a.subagents && m.isSubagent) return false;
    if (!a.all && !r.error && !(r.stats?.userMsgs || r.stats?.turns)) return false; // empty session
    if (since && (m.updated || 0) < since) return false;
    if (cwd && !(m.cwd && cwdMatch(m.cwd, cwd))) return false;
    return true;
  });
  if (a.grep) {
    const g = String(a.grep).toLowerCase();
    rows = rows.filter((r) => `${r.meta.title}\n${r.firstUser}\n${r.meta.cwd}`.toLowerCase().includes(g));
  }
  rows.sort((x, y) => (y.meta.updated || 0) - (x.meta.updated || 0));
  const total = rows.length;
  const limit = a.all ? Infinity : int(a.limit, defaultLimit);
  return { rows: rows.slice(0, limit), total };
}

function cmdList(store, a) {
  const { rows, total } = filterSummaries(store, a, { defaultLimit: 20 });
  if (a.json) return JSON.stringify(rows.map((r) => ({ ...r.meta, turns: r.stats?.turns, chars: r.stats?.chars, firstUser: r.firstUser, lastAssistant: r.lastAssistant })), null, 1);
  const L = [`# 会话列表（${rows.length}/${total}，按更新时间倒序）`];
  for (const r of rows) {
    const m = r.meta, st = r.stats || { turns: 0, chars: {} };
    const flags = [m.current && '当前', m.isSubagent && '子代理', m.archived && '已归档', m.seeded && 'fork', r.error && '解析失败', r.lastStatus && r.lastStatus, r.todosOpen && `待办未完${r.todosOpen}`].filter(Boolean);
    L.push(`${fmtTime(m.updated)}  ${m.source.padEnd(6)} ${m.shortId}  ${st.turns}轮 ${fmtK(st.chars.chat || 0)}字  ${oneLine(m.title, 50)}${flags.length ? '  [' + flags.join(',') + ']' : ''}`);
    const extra = [m.cwd && `cwd ${m.cwd}`, r.firstUser && r.firstUser !== m.title && `首条: ${oneLine(r.firstUser, 90)}`].filter(Boolean);
    if (extra.length) L.push('    ' + extra.join(' · '));
  }
  if (total > rows.length) L.push(`… 还有 ${total - rows.length} 个（--limit N / --all / --since / --grep 过滤）`);
  L.push('', '下一步: show <id> 读取；search <词> 搜内容。');
  return L.join('\n');
}

const SEARCH_KINDS = { user: ['user'], agent: ['agent'], assistant: ['assistant'], compact: ['compact'], tools: ['tool_call'], results: ['tool_result'], reasoning: ['reasoning'], system: ['system'], notice: ['notice'], subagent: ['subagent'] };
const DIGEST_KINDS = new Set(['user', 'agent', 'assistant', 'compact', 'tool_call', 'tool_result', 'subagent']);

function cmdSearch(store, a) {
  const terms = a._.slice(1);
  if (!terms.length) throw new Error('缺少搜索词');
  const inList = list(a.in || 'user,assistant,agent,compact');
  const kinds = new Set((inList.includes('all') ? Object.keys(SEARCH_KINDS) : inList).flatMap((k) => {
    if (!SEARCH_KINDS[k]) throw new Error(`--in 不支持 ${k}`);
    return SEARCH_KINDS[k];
  }));
  const needFull = [...kinds].some((k) => !DIGEST_KINDS.has(k));
  let match;
  if (a.regex) { const re = new RegExp(terms.join(' '), 'i'); match = (t) => { const m = re.exec(t); return m ? m.index : -1; }; }
  else {
    const ts = terms.map((t) => t.toLowerCase());
    match = (t) => { const l = t.toLowerCase(); let first = -1; for (const x of ts) { const i = l.indexOf(x); if (i < 0) return -1; if (first < 0) first = i; } return first; };
  }
  const { rows } = filterSummaries(store, { ...a, all: true }, { defaultLimit: Infinity });
  const per = int(a.per, 3), limit = int(a.limit, 10);
  const results = [];
  for (const r of rows) {
    if (r.meta.current && !a['include-current']) continue;
    let items;
    if (needFull) {
      const s = store.parse(r.entry);
      items = s.turns.flatMap((t) => t.items.map((it) => [it.ref, it.kind, it.kind === 'tool_call' ? `${it.name} ${it.args}` : it.text, it.inherited ? 1 : 0, it.name || it.label || '']));
    } else items = store.digest(r.entry).items;
    const hits = [];
    for (const [ref, kind, text, inh, name] of items) {
      if (!kinds.has(kind) || inh) continue;
      const i = match(text);
      if (i < 0) continue;
      hits.push({ ref, kind, name, snippet: snippet(text, i, terms[0].length) });
    }
    if (hits.length) results.push({ r, hits });
    if (results.length >= limit) break;
  }
  if (a.json) return JSON.stringify(results.map(({ r, hits }) => ({ ...r.meta, hitCount: hits.length, hits: hits.slice(0, per) })), null, 1);
  const L = [`# 搜索「${terms.join(' ')}」 范围 ${inList.join(',')}：${results.length} 个会话命中${results.length >= limit ? '（已达 --limit，可能还有更多）' : ''}`];
  if (needFull) L.push('（搜索 reasoning/system/notice 需要完整解析，较慢）');
  for (const { r, hits } of results) {
    const m = r.meta;
    L.push('', `## ${m.source} ${m.shortId} · ${oneLine(m.title, 50)} · ${fmtTime(m.updated)}${m.cwd ? ' · ' + m.cwd : ''} · ${hits.length} 处`);
    const rel = store.relations(r.entry);
    const i = rel.chain.findIndex((x) => x.self);
    const newer = rel.chain.slice(i + 1).filter((x) => !x.current);
    if (newer.length) L.push(`⚠ 链上有更新的接续会话 ${newer.map((x) => x.shortId).join(', ')}（最新进展可能在那里）`);
    else if (rel.later.length) L.push(`（同目录之后还有 ${rel.later.length} 个会话，如 ${rel.later.slice(0, 2).map((x) => `${x.shortId}「${oneLine(x.title, 16)}」`).join('、')}）`);
    for (const h of hits.slice(0, per)) L.push(`${h.ref} ${KIND_LABEL[h.kind] || h.kind}${h.name && h.kind.startsWith('tool') ? '(' + h.name.split('__').pop() + ')' : ''}: ${h.snippet}`);
    if (hits.length > per) L.push(`… 另 ${hits.length - per} 处（show ${m.shortId} --grep "${terms[0]}"）`);
  }
  if (!results.length) L.push('没有命中。可换同义词、用 --in all 扩大范围，或 --since 放宽时间。');
  else L.push('', '下一步: show <id> --ref <Tn.m> 看原文，或 show <id> --grep <词> 看所在轮次。');
  return L.join('\n');
}
const KIND_LABEL = { user: '用户', agent: '代理消息', assistant: '助手', compact: 'compact', tool_call: '工具调用', tool_result: '工具结果', reasoning: '思考', system: '系统', notice: '注入', subagent: '子代理' };
function snippet(text, i, len) {
  const a = Math.max(0, i - 80), b = Math.min(text.length, i + len + 120);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}

function cmdShow(store, a) {
  const e = resolveOne(store, a);
  const s = store.parse(e);
  const children = e.source === 'codex' ? (store.summaries(store.entries(['codex'])), store.childrenFromIndex(e.id)) : [];
  const view = a.view || 'chat';
  if (!VIEWS[view]) throw new Error(`未知视图 ${view}（outline/chat/tools/full）`);
  const include = list(a.include);
  for (const x of include) if (!INCLUDABLE.includes(x)) throw new Error(`--include 不支持 ${x}（可选 ${INCLUDABLE.join(',')}）`);
  const o = makeOpts({ view, include, maxMsg: a['max-msg'] !== undefined ? int(a['max-msg'], null) : null });
  const L = [header(s, { children, relations: store.relations(e) })];
  const id = s.meta.shortId;

  // --ref: exact items, uncapped (budget still applies to the whole output).
  if (a.ref) {
    const budget = int(a.budget, 60000);
    const out = [];
    const seen = new Set();
    const callIdx = new Map();
    for (const t of s.turns) for (const it of t.items) if (it.callId) (callIdx.get(it.callId) || callIdx.set(it.callId, []).get(it.callId)).push(it);
    for (const ref of list(a.ref)) {
      const it = findItem(s, ref);
      if (!it) { out.push(`${ref}: 不存在`); continue; }
      const group = it.callId ? callIdx.get(it.callId) : [it];
      for (const g of group) if (!seen.has(g.ref)) { seen.add(g.ref); out.push(fmtItem(g, { msg: 0, compact: 0, args: 0, result: 0, reasoning: 0, system: 0 })); }
    }
    let body = out.join('\n\n');
    if (budget && body.length > budget) body = clip(body, budget, '超出 --budget，用 --budget 0 读取全部或 --out 写入文件');
    L.push('', body);
    return L.join('\n');
  }

  // Range selection.
  let turns = s.turns;
  const notes = [];
  let start = null;
  if (a['since-compact']) {
    const c = lastOf(s, 'compact', (i) => !i.inherited && !i.encrypted);
    if (c) start = { ref: c.ref, inclusive: true };
    else notes.push(lastOf(s, 'compact') ? '（compact 摘要是加密的，无法使用 --since-compact，已改为读取全文）' : '（该会话没有 compact，已读取全文）');
  }
  if (a.after) start = { ref: a.after, inclusive: false };
  if (start) {
    const r = parseRef(start.ref);
    if (!r) throw new Error(`无效的引用 ${start.ref}（格式 T12 或 T12.3）`);
    const from = r.idx ? (start.inclusive ? r.idx - 1 : r.idx) : (start.inclusive ? 0 : Infinity);
    turns = turns.filter((t) => t.n >= r.turn).map((t) => (t.n === r.turn ? { ...t, items: t.items.slice(from) } : t)).filter((t) => t.items.length);
  }
  if (a.turns) {
    const m = /^(\d*)\s*-\s*(\d*)$|^(\d+)$/.exec(String(a.turns));
    if (!m) throw new Error('--turns 格式：3-7 / 5 / 10- / -4');
    const lo = m[3] ? +m[3] : m[1] ? +m[1] : 0, hi = m[3] ? +m[3] : m[2] ? +m[2] : Infinity;
    turns = turns.filter((t) => t.n >= lo && t.n <= hi);
  }
  if (a.last) {
    const k = int(a.last, 3);
    const real = turns.filter((t) => t.n > 0 && t.items.some((i) => visible(i, o) || i.kind === 'user'));
    turns = real.slice(-k);
  }
  // Without explicit selection, the T0 preamble is only harness setup.
  if (!a.turns && !start) turns = turns.filter((t) => t.n > 0 || t.items.some((i) => i.kind === 'user' || i.kind === 'assistant'));

  let mark = null;
  if (a.grep) {
    const g = String(a.grep).toLowerCase();
    const ctx = int(a.context, 1);
    mark = new Set();
    const hitIdx = [];
    turns.forEach((t, i) => {
      let hit = false;
      for (const it of t.items) if (visible(it, o) && `${it.text}\n${it.args || ''}`.toLowerCase().includes(g)) { mark.add(it.ref); hit = true; }
      if (hit) hitIdx.push(i);
    });
    const keep = new Set();
    for (const i of hitIdx) for (let j = i - ctx; j <= i + ctx; j++) if (j >= 0 && j < turns.length) keep.add(j);
    notes.push(`（--grep 命中 ${hitIdx.length} 轮${hitIdx.length ? '，命中条目以 » 标出' : '；当前视图不含工具输出时可加 --view tools 或 --include results 再试'}）`);
    turns = turns.filter((_, i) => keep.has(i));
  }

  let budget = a.budget !== undefined ? int(a.budget, 20000) : 20000;
  // --since-compact: the summary is the point, so it is printed on its own
  // (up to 40% of the budget) instead of being folded with its turn.
  let compactBlock = '';
  if (start && a['since-compact'] && !a.after && turns.length && turns[0].items[0]?.kind === 'compact') {
    const c = turns[0].items[0];
    const cap = budget ? Math.max(Math.floor(budget * 0.4), 2000) : 0;
    compactBlock = fmtItem(c, { ...o.caps, compact: cap });
    turns = [{ ...turns[0], items: turns[0].items.slice(1) }, ...turns.slice(1)].filter((t) => t.items.length);
    if (budget) budget = Math.max(budget - compactBlock.length, 2000);
  }
  const { text, counts } = layout(turns, o, budget, mark);
  if (notes.length) L.push(notes.join('\n'));
  if (compactBlock) L.push('', compactBlock, '', '（以下为摘要之后的对话）');
  L.push('', text || '（所选范围在当前视图下没有内容，可换 --view tools / full 或 --include）');
  const shown = turns.filter((t) => t.n > 0);
  const range = shown.length ? `T${shown[0].n}–T${shown[shown.length - 1].n}` : '无';
  const tips = [];
  if (counts.out || counts.hidden) tips.push(`--turns a-b 读取折叠的轮次`);
  if (view !== 'full') tips.push(view === 'chat' ? '--view tools 看工具调用' : '--view full 看全部');
  tips.push('--ref Tn.m 看某条完整内容');
  if (s.stats.compacts.length > s.stats.encryptedCompacts && !a['since-compact']) tips.push('--since-compact');
  tips.push(`actions ${id} 看命令与改动文件`);
  L.push('', '---', `视图 ${view}${include.length ? '+' + include.join('+') : ''} · 范围 ${range} · 完整 ${counts.full} 轮 / 单行摘要 ${counts.out} 轮 / 折叠 ${counts.hidden} 轮 · 输出约 ${fmtK(text.length)} 字（预算 ${budget ? fmtK(budget) : '不限'}）`,
    `继续: show ${id} ` + tips.join(' | '));
  return L.join('\n');
}

function cmdActions(store, a) {
  const e = resolveOne(store, a);
  const s = store.parse(e);
  const { commands, files } = extractActions(s, { includeInherited: list(a.include).includes('inherited') });
  const L = [`# 动作清单 · ${s.meta.title} · ${s.meta.source} ${s.meta.id}`, `cwd: ${s.meta.cwd || '?'}`, '', `## 改动过的文件（${files.length}）`];
  for (const f of files.sort((x, y) => (x.path > y.path ? 1 : -1))) {
    L.push(`${f.path}  ×${f.count} [${f.ops.join(',')}]${f.failed ? ` 失败${f.failed}` : ''}  ${f.firstRef === f.lastRef ? f.lastRef : f.firstRef + '…' + f.lastRef}`);
  }
  if (!files.length) L.push('（无。注意：通过 shell 命令写文件的改动不会出现在这里，请看下面的命令）');
  const show = a.all ? commands : commands.slice(-60);
  L.push('', `## 执行过的命令（共 ${commands.length}${show.length < commands.length ? `，显示最近 ${show.length} 条，--all 全部` : ''}）`);
  for (const c of show) L.push(`${c.ref}${c.isError ? ' [错误]' : ''} $ ${a.full ? c.cmd : oneLine(c.cmd, 220)}`);
  L.push('', `下一步: show ${s.meta.shortId} --ref <Tn.m> 看某条命令及输出`);
  return L.join('\n');
}

function cmdHandoff(store, a) {
  const e = resolveOne(store, a);
  const s = store.parse(e);
  const m = s.meta, x = s.extras;
  const own = (i) => !i.inherited;
  const users = s.turns.flatMap((t) => t.items.filter((i) => i.kind === 'user' && own(i) && i.text.trim()));
  const { commands, files } = extractActions(s);
  // "Last state" = the latest substantial reply. A trailing short reply (a test
  // message, "好的", "1") would hide the real progress summary before it.
  const finals = s.turns.flatMap((t) => t.items.filter((i) => i.kind === 'assistant' && own(i) && i.phase !== 'commentary'));
  const lastReply = finals[finals.length - 1] || lastOf(s, 'assistant', own);
  const SUBSTANTIAL = 200;
  let lastA = lastReply;
  if (lastReply && lastReply.text.trim().length < SUBSTANTIAL) {
    for (let i = finals.length - 1; i >= 0; i--) if (finals[i].text.trim().length >= SUBSTANTIAL) { lastA = finals[i]; break; }
  }
  const lastTurn = s.turns[s.turns.length - 1];
  const L = [`# 接手简报 · ${m.title}`,
    `来源 ${m.source} · id ${m.id} · cwd ${m.cwd || '?'}`,
    `时间 ${fmtTime(m.created)} → ${fmtTime(m.updated)} · ${s.stats.turns} 轮 · 用户消息 ${users.length}${s.stats.compacts.length ? ` · compact ${s.stats.compacts.length} 次` : ''}`,
    '⚠ 本简报由规则提取，不含推理判断，可能遗漏关键细节；做决定前用 show 核实。'];
  const rel = relationLines(store.relations(e));
  if (rel.length) L.push('', '## 相关会话', ...rel);
  L.push('', '## 最初请求', users[0] ? `${users[0].ref} ${clip(users[0].text, 1500, `完整：show ${m.shortId} --ref ${users[0].ref}`)}` : '（无）');
  if (users.length > 1) {
    const rest = users.slice(1);
    const showN = rest.slice(-15);
    L.push('', `## 之后的用户指令（${rest.length} 条${showN.length < rest.length ? `，显示最近 ${showN.length} 条` : ''}；纠正和偏好通常在这里）`);
    for (const u of showN) L.push(`${u.ref} ${oneLine(u.text, 300)}`);
  }
  if (x.goal) L.push('', `## 目标（${x.goal.status || '?'}${x.goal.inherited ? '，继承自父会话，可能已过时' : ''}）`, x.goal.objective);
  if (x.todos && x.todos.length) {
    L.push('', `## 待办（最后状态${x.todosInherited ? '；继承自父会话，本会话未更新，可能与当前任务无关' : ''}）`);
    for (const t of x.todos) L.push(`[${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`);
  }
  L.push('', `## 最后状态${lastTurn?.status ? `（最后一轮：${lastTurn.status}）` : ''}`, lastA ? `${lastA.ref} 助手: ${clip(lastA.text, 2500, `完整：show ${m.shortId} --ref ${lastA.ref}`)}` : '（没有助手回复）');
  if (lastA && lastReply && lastA !== lastReply) {
    const after = finals.filter((i) => parseRef(i.ref).turn > parseRef(lastA.ref).turn);
    L.push(`（这是最后一条实质性回复；之后还有 ${after.length} 条简短回复，最后一条 ${lastReply.ref}: ${oneLine(lastReply.text, 80)}。对应的用户消息见上方指令列表）`);
  }
  const lastU = users[users.length - 1];
  if (lastU && lastReply && parseRef(lastU.ref).turn > parseRef(lastReply.ref).turn) L.push(`⚠ 最后一条用户消息（${lastU.ref}）之后没有助手回复，任务可能未完成。`);
  if (files.length) {
    L.push('', `## 改动过的文件（${files.length}）`);
    for (const f of files.slice(0, 40)) L.push(`${f.path} [${f.ops.join(',')}] ×${f.count}${f.failed ? ` 失败${f.failed}` : ''} 最后 ${f.lastRef}`);
  }
  if (x.deliverables.length) L.push('', '## 交付文件', ...[...new Set(x.deliverables)].slice(-15));
  if (commands.length) {
    L.push('', `## 最近的命令（共 ${commands.length}）`);
    for (const c of commands.slice(-12)) L.push(`${c.ref}${c.isError ? ' [错误]' : ''} $ ${oneLine(c.cmd, 200)}`);
  }
  const recentErr = commands.filter((c) => c.isError && c.turn >= (lastTurn?.n || 0) - 2);
  if (recentErr.length) L.push('', `⚠ 最近 3 轮有 ${recentErr.length} 条命令失败：${recentErr.slice(-5).map((c) => c.ref).join(', ')}`);
  const kids = [...x.children, ...(e.source === 'codex' ? store.childrenFromIndex(e.id) : [])];
  if (kids.length) L.push('', `## 子会话（${kids.length}）`, ...kids.slice(0, 10).map((k) => `${k.id} 「${oneLine(k.label || k.title || '', 40)}」`));
  L.push('', '## 建议的下一步读取',
    s.stats.compacts.length > s.stats.encryptedCompacts ? `show ${m.shortId} --since-compact   （最后一次摘要 + 之后全部 = 原 agent 最后的上下文）` : `show ${m.shortId} --last 3 --view tools   （最近 3 轮含工具调用）`,
    `actions ${m.shortId}   （全部命令与改动文件）`);
  let text = L.join('\n');
  const budget = int(a.budget, 8000);
  if (budget && text.length > budget) text = clip(text, budget, '超出 --budget');
  return text;
}

// ---------- main ----------
function main() {
  let a;
  try { a = parseArgs(process.argv.slice(2)); } catch (err) { process.stderr.write(err.message + '\n'); process.exit(2); }
  const cmd = a._[0];
  if (!cmd || a.help || cmd === 'help') { process.stdout.write(HELP + '\n'); return; }
  const store = new Store({ roots: a.root, noCache: a['no-cache'] });
  const run = { roots: () => cmdRoots(store), list: () => cmdList(store, a), search: () => cmdSearch(store, a), show: () => cmdShow(store, a), actions: () => cmdActions(store, a), handoff: () => cmdHandoff(store, a) }[cmd];
  if (!run) { process.stderr.write(`未知命令 ${cmd}\n\n${HELP}\n`); process.exit(2); }
  try {
    emit(run(), a);
  } catch (err) {
    process.stderr.write(`错误: ${err.message}\n`);
    if (process.env.SESSION_HISTORY_DEBUG) process.stderr.write(err.stack + '\n');
    process.exit(1);
  } finally {
    store.save();
  }
}

main();
