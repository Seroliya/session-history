// Text rendering for a model reader: every item line starts with its ref (T<turn>.<n>)
// so any truncated piece can be fetched exactly with --ref.
import { CATEGORY, tryJson } from './model.mjs';
import { commandOf, filesOf } from './actions.mjs';
import { clip, oneLine, fmtTime, fmtK } from './util.mjs';

// Per-view categories and per-item caps (0 = no cap).
export const VIEWS = {
  outline: { cats: ['chat'] },
  chat: { cats: ['chat', 'compact'], msg: 4000, compact: 2000, args: 300, result: 600, reasoning: 1500, system: 1500 },
  tools: { cats: ['chat', 'compact', 'tools', 'results'], msg: 4000, compact: 2000, args: 300, result: 600, reasoning: 1500, system: 1500 },
  full: { cats: ['chat', 'compact', 'tools', 'results', 'reasoning', 'system'], msg: 0, compact: 0, args: 0, result: 0, reasoning: 0, system: 0 },
};
export const INCLUDABLE = ['tools', 'results', 'reasoning', 'system', 'notice', 'inherited'];

export function makeOpts({ view = 'chat', include = [], maxMsg = null }) {
  const v = VIEWS[view];
  const caps = { msg: v.msg ?? 0, compact: v.compact ?? 0, args: v.args ?? 300, result: v.result ?? 600, reasoning: v.reasoning ?? 0, system: v.system ?? 0 };
  if (maxMsg != null) for (const k of ['msg', 'compact', 'result', 'reasoning', 'system']) caps[k] = maxMsg;
  const inc = new Set(include);
  return { view, caps, inc, cats: new Set([...v.cats, ...[...inc].filter((x) => x !== 'inherited')]) };
}

export function visible(it, o) {
  if (it.inherited && !o.inc.has('inherited')) return false;
  return o.cats.has(CATEGORY[it.kind] || 'notice');
}

const base = (n) => String(n || '').split('__').pop();

function body(text, cap, ref) {
  return cap && text.length > cap ? clip(text, cap, `完整内容：--ref ${ref}`) : text;
}

export function argsSummary(it, cap) {
  const raw = it.args || '';
  const cmd = commandOf(it);
  if (!cap) return cmd ?? raw;
  if (/\*\*\* Begin Patch/.test(raw)) return '[patch] ' + filesOf(it).map((f) => `${f.op} ${f.path}`).join(', ');
  if (cmd) return oneLine(cmd, cap);
  const a = tryJson(raw);
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const KEYS = ['file_path', 'path', 'pattern', 'query', 'queries', 'url', 'description', 'prompt', 'message', 'name', 'old_string', 'content', 'code'];
    const parts = [];
    for (const k of KEYS) if (a[k] != null) parts.push(`${k}=${typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k])}`);
    return oneLine(parts.length ? parts.join(' ') : JSON.stringify(a), cap);
  }
  return oneLine(raw, cap);
}

export function fmtItem(it, caps) {
  const r = it.ref;
  const inh = it.inherited ? '（继承）' : '';
  switch (it.kind) {
    case 'user': return `${r} 用户${inh}: ${body(it.text, caps.msg, r)}`;
    case 'agent': return `${r} [${it.label || 'agent'}]${inh}: ${body(it.text, caps.msg, r)}`;
    case 'assistant': return `${r} 助手${it.phase === 'commentary' ? '(过程)' : ''}${inh}: ${body(it.text, caps.msg, r)}`;
    case 'reasoning': return `${r} 思考${it.summaryOnly ? '(摘要)' : ''}: ${body(it.text, caps.reasoning, r)}`;
    case 'tool_call': return `${r} → ${base(it.name)}: ${argsSummary(it, caps.args)}`;
    case 'tool_result': {
      const t = it.text || '';
      return `${r} ← ${base(it.name)}${it.isError ? ' [错误]' : ''} (${fmtK(t.length)}字): ${body(t, caps.result, r)}`;
    }
    case 'compact':
      return `${r} ==== compact 摘要（当时对更早上下文的压缩，之后对话仍在继续，仅作参考）====\n${body(it.text, caps.compact, r)}\n==== 摘要结束 ====`;
    case 'subagent': return `${r} ⇢ 启动子代理「${it.label || ''}」 id=${it.childId}（show ${it.childId.slice(0, 8)} 查看）`;
    case 'system': return `${r} [系统提示] (${fmtK(it.text.length)}字): ${body(it.text, caps.system, r)}`;
    case 'notice': return `${r} [注入:${it.label || ''}]: ${body(it.text, caps.system, r)}`;
    default: return `${r} ${it.kind}: ${body(it.text, caps.msg, r)}`;
  }
}

export function turnHead(t) {
  const inh = t.items.length && t.items.every((i) => i.inherited) ? ' · 继承自父会话' : '';
  return `## ${t.n === 0 ? 'T0 开场' : 'T' + t.n} · ${fmtTime(t.time)}${t.status ? ' · ' + t.status : ''}${inh}`;
}

export function renderTurn(t, o, mark = null) {
  const lines = [];
  for (const it of t.items) if (visible(it, o)) lines.push((mark && mark.has(it.ref) ? '» ' : '') + fmtItem(it, o.caps));
  return lines.length ? turnHead(t) + '\n' + lines.join('\n') : '';
}

function topNames(calls) {
  const m = new Map();
  for (const c of calls) m.set(base(c.name), (m.get(base(c.name)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => (v > 1 ? `${k}×${v}` : k)).join(', ');
}

export function outlineLine(t, o) {
  const items = t.items.filter((i) => !i.inherited || o.inc.has('inherited'));
  const u = items.find((i) => i.kind === 'user') || items.find((i) => i.kind === 'agent');
  const as = items.filter((i) => i.kind === 'assistant');
  const a = as[as.length - 1];
  const calls = items.filter((i) => i.kind === 'tool_call');
  if (!u && !a && !calls.length && !items.some((i) => i.kind === 'compact')) return '';
  const errs = items.filter((i) => i.kind === 'tool_result' && i.isError).length;
  const chars = items.reduce((n, i) => n + (i.text ? i.text.length : 0) + (i.args ? i.args.length : 0), 0);
  const parts = [u ? `${u.kind === 'user' ? '用户' : '[' + (u.label || 'agent') + ']'}: ${oneLine(u.text, 100)}` : '(无用户消息)'];
  if (a) parts.push(`助手: ${oneLine(a.text, 140)}`);
  const extra = [];
  if (calls.length) extra.push(`工具 ${calls.length}（${topNames(calls)}）`);
  if (errs) extra.push(`错误 ${errs}`);
  if (items.some((i) => i.kind === 'compact')) extra.push('含 compact 摘要');
  const subs = items.filter((i) => i.kind === 'subagent').length;
  if (subs) extra.push(`子代理 ${subs}`);
  extra.push(`${fmtK(chars)}字`);
  const head = t.n === 0 ? 'T0' : 'T' + t.n;
  return `${head} ${fmtTime(t.time, false)}${t.status ? ' [' + t.status + ']' : ''} ${parts.join(' ⇒ ')} · ${extra.join(' · ')}`;
}

// Fit turns into a character budget. Full turns are kept for the first turn
// (the original request) and the most recent turns; the middle degrades to
// outline lines, and the oldest outline lines collapse into a placeholder.
export function layout(turns, o, budget, mark = null) {
  const n = turns.length;
  const out = turns.map((t) => outlineLine(t, o));
  const full = o.view === 'outline' ? out.map(() => '') : turns.map((t) => renderTurn(t, o, mark));
  const cost = (s) => (s ? s.length + 2 : 0);
  const mode = new Array(n).fill('skip');
  const has = (i) => (o.view === 'outline' ? out[i] : full[i] || out[i]);

  if (!budget) {
    for (let i = 0; i < n; i++) if (has(i)) mode[i] = o.view === 'outline' ? 'out' : (full[i] ? 'full' : 'skip');
  } else {
    const totalFull = full.reduce((s, x) => s + cost(x), 0);
    if (o.view !== 'outline' && totalFull <= budget) {
      for (let i = 0; i < n; i++) if (full[i]) mode[i] = 'full';
    } else {
      let total = 0;
      for (let i = 0; i < n; i++) if (out[i]) { mode[i] = 'out'; total += cost(out[i]); }
      // "First" = first turn with visible content (fork-inherited turns render empty).
      let first = 0;
      while (first < n && !out[first] && !full[first]) first++;
      const outCap = o.view === 'outline' ? budget : budget * 0.35;
      // Collapse oldest outline lines (keep the first) until they fit their share.
      for (let i = first + 1; i < n - 1 && total > outCap; i++) {
        if (mode[i] === 'out') { total -= cost(out[i]); mode[i] = 'hidden'; }
      }
      if (o.view !== 'outline') {
        const newest = lastWith(full);
        const order = [first];
        for (let j = n - 1; j > first; j--) order.push(j);
        for (const j of order) {
          if (!full[j]) continue;
          const old = mode[j] === 'out' ? cost(out[j]) : 0;
          const delta = cost(full[j]) - old;
          if (total + delta <= budget) { total += delta; mode[j] = 'full'; continue; }
          if (j === first && j !== newest) continue;
          // The newest turn matters most: show it clipped rather than only as one line.
          if (j === newest) {
            const room = Math.max(budget - total + old, 1500);
            full[j] = clip(full[j], room, `完整：--turns ${turns[j].n} --budget 0`);
            total += cost(full[j]) - old;
            mode[j] = 'full';
          }
          break; // keep the full-text tail contiguous
        }
      }
    }
  }

  const parts = [];
  const counts = { full: 0, out: 0, hidden: 0 };
  let prev = null;
  for (let i = 0; i < n; i++) {
    const m = mode[i];
    if (m === 'skip') continue;
    counts[m]++;
    if (m === 'hidden') {
      let j = i;
      while (j + 1 < n && (mode[j + 1] === 'hidden' || mode[j + 1] === 'skip')) j++;
      const a = turns[i].n, b = turns[j].n;
      const k = turns.slice(i, j + 1).filter((_, x) => mode[i + x] === 'hidden').length;
      counts.hidden += k - 1;
      parts.push(`…[T${a}–T${b} 共 ${k} 轮已折叠；查看：--turns ${a}-${b} --view outline]…`);
      i = j;
      prev = 'hidden';
      continue;
    }
    if (m === 'out' && prev !== 'out' && o.view !== 'outline') parts.push('（以下为单行摘要；完整内容用 --turns N 读取）');
    parts.push(m === 'full' ? full[i] : out[i]);
    prev = m;
  }
  return { text: parts.join(o.view === 'outline' ? '\n' : '\n\n'), counts };
}

function lastWith(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i]) return i;
  return -1;
}

export function parseRef(ref) {
  const m = /^T(\d+)(?:\.(\d+))?$/i.exec(String(ref).trim());
  return m ? { turn: +m[1], idx: m[2] ? +m[2] : 0 } : null;
}

export function findItem(s, ref) {
  const r = parseRef(ref);
  if (!r) return null;
  const t = s.turns.find((x) => x.n === r.turn);
  return t ? t.items[r.idx - 1] || null : null;
}

// Lines describing a session's place among related sessions (see Store.relations).
export function relationLines(rel) {
  const L = [];
  if (!rel) return L;
  const tag = (r) => `${r.shortId}「${oneLine(r.title || '', 24)}」${fmtTime(r.updated, false)}`;
  if (rel.forkedFrom) {
    L.push(`fork 自 ${rel.forkedFrom}${rel.forkOrdinal != null ? `（第 ${rel.forkOrdinal} 条记录处）` : ''}：fork 之前的历史不在本会话文件里，需要时 show ${rel.forkedFrom.slice(0, 13)} 读取${rel.parentMissing ? '（⚠ 父会话不在本机记录中）' : ''}`);
  }
  if (rel.chain.length) {
    L.push('会话链（同一起点的 fork/接续，按创建时间）: ' + rel.chain.map((r) => (r.self ? `▶${r.shortId}（本会话）` : tag(r))).join(' → '));
    const i = rel.chain.findIndex((r) => r.self);
    const after = rel.chain.slice(i + 1).filter((r) => !r.current);
    if (after.length) {
      const last = after[after.length - 1];
      L.push(`⚠ 本会话之后链上还有 ${after.length} 个更新的会话，最新是 ${last.shortId}（更新于 ${fmtTime(last.updated)}）。后续进展或方案变更可能在那里，判断"当前状态"前先看它`);
    }
  }
  if (rel.later.length) {
    L.push(`同目录之后的会话 ${rel.later.length} 个（可能是后续工作，也可能无关）: ` + rel.later.slice(0, 5).map(tag).join('；') + (rel.later.length > 5 ? ' …' : ''));
  }
  return L;
}

export function header(s, ctx = {}) {
  const m = s.meta, st = s.stats, x = s.extras, c = st.chars;
  const L = [`# ${m.title || '(无标题)'}`];
  const tags = [`来源 ${m.source}`, `id ${m.id}`];
  if (m.isSubagent) tags.push(`子代理${m.label ? '「' + m.label + '」' : ''}${m.parentId ? '（父 ' + m.parentId + '）' : ''}`);
  if (m.seeded) tags.push('fork 会话');
  if (m.archived) tags.push('已归档');
  if (m.current) tags.push('⚠ 这是当前会话本身');
  L.push(tags.join(' · '));
  if (m.cwd) L.push(`cwd: ${m.cwd}`);
  L.push(`时间: ${fmtTime(m.created)} → ${fmtTime(m.updated)}${m.model ? ' · 模型 ' + m.model : ''}${x.tokens ? ' · tokens ' + fmtK(x.tokens) : ''}`);
  L.push(`规模: ${st.turns} 轮 · 用户消息 ${st.userMsgs} · 工具调用 ${st.toolCalls} · 字数 对话 ${fmtK(c.chat)} | 工具调用 ${fmtK(c.tools)} | 工具结果 ${fmtK(c.results)} | 思考 ${fmtK(c.reasoning)}${st.encryptedReasoning ? '（另 ' + st.encryptedReasoning + ' 段加密）' : ''} | 系统提示 ${fmtK(c.system)} | 注入 ${fmtK(c.notice)}`);
  if (st.compacts.length) {
    const allEnc = st.encryptedCompacts === st.compacts.length;
    L.push(`compact: ${st.compacts.length} 次（${st.compacts.slice(-5).join(', ')}）${st.encryptedCompacts ? `，其中 ${st.encryptedCompacts} 次摘要已加密无法读取` : ''}。摘要只压缩了当时更早的上下文，之后对话仍在继续；` +
      (allEnc ? '原文仍完整保留在记录中，直接按轮次读取即可' : '--since-compact = 最后一次可读摘要 + 之后全部（即原 agent 最后看到的上下文）'));
  }
  if (st.inheritedTurns) L.push(`fork 继承: 有 ${st.inheritedTurns} 轮复制自父会话，默认隐藏且不计入统计（--include inherited 显示）`);
  if (x.droppedBranchMsgs) L.push(`分支: 已忽略 ${x.droppedBranchMsgs} 条被回退/编辑替换的旧分支消息`);
  const kids = [...x.children, ...(ctx.children || [])];
  L.push(...relationLines(ctx.relations));
  if (kids.length) L.push(`子会话 ${kids.length} 个: ` + kids.slice(0, 8).map((k) => `${k.id.slice(0, 8)}「${oneLine(k.label || k.title || '', 30)}」`).join('；') + (kids.length > 8 ? ' …' : '') + '（show <id> 查看）');
  if (x.goal) L.push(`目标(${x.goal.status || '?'}${x.goal.inherited ? '，继承自父会话' : ''}): ${oneLine(x.goal.objective, 300)}`);
  if (x.todos && x.todos.length) {
    const open = x.todos.filter((t) => t.status !== 'completed');
    L.push(`待办${x.todosInherited ? '(继承自父会话)' : ''}: 完成 ${x.todos.length - open.length}/${x.todos.length}` + (open.length ? '；未完成：' + open.slice(0, 5).map((t) => oneLine(t.content, 60)).join('；') : ''));
  }
  const lt = s.turns[s.turns.length - 1];
  if (lt && lt.status) L.push(`最后一轮状态: ${lt.status}`);
  if (m.truncated) L.push('⚠ 文件末尾不完整（会话可能仍在写入），已读到最后一个完整记录');
  L.push(`文件: ${m.files[0]}${m.files.length > 1 ? `（另 ${m.files.length - 1} 个分页文件）` : ''}`);
  return L.join('\n');
}
