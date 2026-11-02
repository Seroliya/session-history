// OpenAI Codex rollouts: <CODEX_HOME>/{sessions/YYYY/MM/DD, archived_sessions}/rollout-<ts>-<thread>[_<page>].jsonl[.zst]
// A thread may be split into a base file plus page files. Each page's
// session_meta.history_base.end_ordinal_exclusive says where it continues; a
// page that restarts below the previous end replaces the tail (message edit /
// rollback), so records are merged by ordinal in page order.
import fs from 'node:fs';
import path from 'node:path';
import { readSessionText } from '../zstd.mjs';
import { parseJsonl, textOfParts, toMs } from '../util.mjs';
import { SessionBuilder, tryJson } from '../model.mjs';

export const source = 'codex';
const NAME_RE = /^rollout-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f-]{36}))?\.jsonl(?:\.zst)?$/i;

export function sniff(r) { return !!r && (r.type === 'session_meta' || (r.type === 'response_item' && r.payload) || (!r.type && r.id && 'instructions' in r)); }

export function discover(root, out) {
  const dirs = [];
  for (const sub of ['sessions', 'archived_sessions']) {
    const d = path.join(root, sub);
    if (fs.existsSync(d)) dirs.push([d, sub === 'archived_sessions']);
  }
  if (!dirs.length) dirs.push([root, false]);
  const byId = new Map();
  for (const [d, archived] of dirs) walk(d, 0, archived);
  function walk(dir, depth, archived) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1, archived); continue; }
      const m = NAME_RE.exec(e.name);
      if (!m) continue;
      const st = fs.statSync(p);
      const id = m[2].toLowerCase();
      let g = byId.get(id);
      if (!g) { g = { source, id, files: [], root, mtime: 0, archived: false, titles: null }; byId.set(id, g); }
      g.files.push({ path: p, mtime: st.mtimeMs, size: st.size, ts: m[1], page: m[3] || '' });
      if (archived) g.archived = true;
      if (st.mtimeMs > g.mtime) g.mtime = st.mtimeMs;
    }
  }
  const titles = loadIndex(root);
  for (const g of byId.values()) {
    // A plain .jsonl and a .jsonl.zst of the same page: keep the newer one.
    const seen = new Map();
    for (const f of g.files) {
      const k = f.ts + '|' + f.page;
      const o = seen.get(k);
      if (!o || f.mtime > o.mtime) seen.set(k, f);
    }
    g.files = [...seen.values()].sort((a, b) => (a.page ? 1 : 0) - (b.page ? 1 : 0) || a.ts.localeCompare(b.ts) || a.mtime - b.mtime);
    g.indexTitle = titles.get(g.id) || '';
    out.push(g);
  }
}

const indexCache = new Map();
function loadIndex(root) {
  if (indexCache.has(root)) return indexCache.get(root);
  const m = new Map();
  try {
    const t = fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8');
    const upd = new Map();
    for (const o of parseJsonl(t)) {
      if (!o.id || !o.thread_name) continue;
      const u = toMs(o.updated_at);
      if (!upd.has(o.id) || u >= upd.get(o.id)) { upd.set(o.id, u); m.set(o.id, o.thread_name); }
    }
  } catch { /* no index */ }
  indexCache.set(root, m);
  return m;
}

function loadRecords(entry) {
  let recs = [];
  let truncated = false;
  for (const f of entry.files) {
    let r;
    try { r = readSessionText(f.path); } catch { truncated = true; continue; }
    if (r.truncated) truncated = true;
    const page = [];
    let base = null;
    let i = 0;
    for (const o of parseJsonl(r.text)) {
      if (o.type === 'session_meta' && o.payload?.history_base && base == null) base = o.payload.history_base.end_ordinal_exclusive;
      page.push({ o, ord: typeof o.ordinal === 'number' ? o.ordinal : null, i: i++ });
    }
    if (base != null) recs = recs.filter((x) => x.ord == null || x.ord < base);
    recs.push(...page);
  }
  if (recs.every((x) => x.ord != null)) {
    const seen = new Set();
    recs = recs.filter((x) => (seen.has(x.ord) ? false : (seen.add(x.ord), true))).sort((a, b) => a.ord - b.ord);
  }
  return { recs: recs.map((x) => x.o), truncated };
}

const NOTICE_TAG = /^(?:<(?:environment_context|user_instructions|recommended_plugins|external_codex_apps_open_page|turn_aborted|permissions[ _]instructions|apps_instructions|collaboration_mode|skills_instructions|user_shell_command|codex_apps_client_time_context|world_state)\b|# AGENTS\.md instructions)/;
const AGENT_TAG = /^<(?:subagent_notification|heartbeat)>/;

function userKind(p, text) {
  const t = text.trimStart();
  if (AGENT_TAG.test(t)) return 'agent';
  const prov = (p.internal_chat_message_metadata_passthrough?.content_item_metadata || []).map((m) => m?.provenance?.type).filter(Boolean);
  if (prov.length) return prov.includes('user') && !NOTICE_TAG.test(t) ? 'user' : 'notice';
  return NOTICE_TAG.test(t) ? 'notice' : 'user';
}

function outputText(out) {
  if (out == null) return '';
  if (typeof out === 'string') {
    const j = out.startsWith('{') ? tryJson(out) : null;
    if (j && typeof j.output === 'string') return j.output;
    return out;
  }
  if (Array.isArray(out)) return textOfParts(out);
  if (typeof out.content === 'string') return out.content;
  if (Array.isArray(out.content)) return textOfParts(out.content);
  return JSON.stringify(out);
}

export function parse(entry) {
  const { recs, truncated } = loadRecords(entry);
  const b = new SessionBuilder({ source, id: entry.id, files: entry.files.map((f) => f.path), truncated, archived: !!entry.archived, title: entry.indexTitle || '' }, { turnOnUser: true });
  let gotMeta = false;
  for (const o of recs) {
    const legacy = !o.type || (!o.payload && /^(message|reasoning|function_call|function_call_output)$/.test(o.type));
    const type = legacy ? 'response_item' : o.type;
    const p = legacy ? o : (o.payload || {});
    const time = toMs(o.timestamp);
    if (legacy && !o.type && o.id && !gotMeta) { gotMeta = true; b.meta.created = toMs(o.timestamp); continue; }
    switch (type) {
      case 'session_meta':
        if (!gotMeta) {
          gotMeta = true;
          b.meta.cwd = p.cwd || '';
          b.meta.created = toMs(p.timestamp) || time;
          if (p.source && typeof p.source === 'object' && p.source.subagent) {
            b.meta.isSubagent = true;
            const sa = p.source.subagent;
            b.meta.label = typeof sa === 'string' ? sa : (sa.other || sa.thread_spawn?.agent_nickname || sa.thread_spawn?.agent_role || Object.keys(sa)[0] || '');
          }
          if (p.thread_source === 'subagent') b.meta.isSubagent = true;
          if (p.parent_thread_id) b.meta.parentId = p.parent_thread_id;
          // A fork references its parent instead of copying the history: its
          // ordinals continue from the fork point in the parent thread.
          if (p.forked_from_id) {
            b.meta.forkedFrom = String(p.forked_from_id).toLowerCase();
            if (typeof p.forked_from_ordinal_exclusive === 'number') b.meta.forkOrdinal = p.forked_from_ordinal_exclusive;
          }
          if (p.agent_nickname) b.meta.label = p.agent_nickname;
        }
        if (typeof p.base_instructions?.text === 'string') b.add('system', { text: p.base_instructions.text, time });
        break;
      case 'turn_context':
        if (p.model) b.meta.model = p.model;
        if (p.cwd) b.meta.cwd = p.cwd;
        break;
      case 'event_msg':
        if (p.type === 'task_started') b.startTurn(time);
        else if (p.type === 'turn_aborted') b.cur.status = '中断';
        else if (p.type === 'thread_goal_updated' && p.goal?.objective) b.extras.goal = { objective: p.goal.objective, status: p.goal.status || '' };
        else if (p.type === 'token_count' && p.info?.total_token_usage) b.extras.tokens = p.info.total_token_usage.total_tokens;
        break;
      case 'compacted': {
        // Newer Codex keeps the summary only as an encrypted `compaction` item
        // inside replacement_history; `message` is then empty.
        if (p.message) { b.add('compact', { text: p.message, time }); break; }
        const rh = Array.isArray(p.replacement_history) ? p.replacement_history : [];
        const kept = rh.filter((r) => r.type === 'message' && r.role === 'user').length;
        b.add('compact', { text: `[compact 摘要已加密，无法读取${kept ? `；压缩后保留了 ${kept} 条原始用户/注入消息` : ''}。需要细节请读压缩前的轮次]`, time, encrypted: true });
        break;
      }
      case 'response_item':
        handleItem(b, p, time);
        break;
      default:
        break;
    }
  }
  if (!b.meta.updated) b.meta.updated = entry.mtime;
  return b.finish();
}

function handleItem(b, p, time) {
  switch (p.type) {
    case 'message': {
      const text = textOfParts(p.content);
      if (p.role === 'user') {
        const k = userKind(p, text);
        b.add(k, { text, time, label: k === 'notice' ? (text.trimStart().match(/^<([\w-]+)>|^# ([^\n]{0,30})/)?.slice(1).find(Boolean) || '') : '' });
      } else if (p.role === 'assistant') {
        if (text) b.add('assistant', { text, time, phase: p.phase || '' });
      } else if (p.role === 'developer' || p.role === 'system') {
        b.add('system', { text, time });
      }
      break;
    }
    case 'reasoning': {
      const sum = (p.summary || []).map((s) => s.text || '').filter(Boolean).join('\n');
      const content = Array.isArray(p.content) ? textOfParts(p.content) : '';
      if (content || sum) b.add('reasoning', { text: content || sum, time, summaryOnly: !content });
      else if (p.encrypted_content) b.add('reasoning', { text: '[推理已加密]', time, encrypted: true });
      break;
    }
    case 'function_call':
      b.add('tool_call', { name: p.name, args: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? ''), callId: p.call_id, time });
      if (p.name === 'update_plan') {
        const a = tryJson(p.arguments);
        if (Array.isArray(a?.plan)) b.extras.todos = a.plan.map((x) => ({ content: x.step, status: x.status }));
      }
      break;
    case 'custom_tool_call':
      b.add('tool_call', { name: p.name, args: typeof p.input === 'string' ? p.input : JSON.stringify(p.input ?? ''), callId: p.call_id, time });
      break;
    case 'local_shell_call':
      b.add('tool_call', { name: 'shell', args: JSON.stringify(p.action?.command ?? p.action ?? ''), callId: p.call_id, time });
      break;
    case 'web_search_call':
      b.add('tool_call', { name: 'web_search', args: JSON.stringify({ query: p.action?.query || p.action?.queries || '' }), callId: p.id, time });
      break;
    case 'tool_search_call':
      b.add('tool_call', { name: 'tool_search', args: JSON.stringify(p.arguments ?? p.query ?? ''), callId: p.call_id || p.id, time });
      break;
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
    case 'tool_search_output': {
      const text = outputText(p.output);
      const isError = p.output?.success === false || /^Exit code: [1-9]|Process exited with code [1-9]/.test(text);
      b.add('tool_result', { text, callId: p.call_id || p.id, isError, time });
      break;
    }
    case 'agent_message': {
      const head = (p.content || []).filter((c) => c.type === 'input_text' || c.type === 'output_text').map((c) => c.text).join('\n');
      const enc = (p.content || []).some((c) => c.type === 'encrypted_content');
      b.add('agent', { text: (head + (enc ? '\n[消息正文已加密]' : '')).trim(), label: p.author || '', time });
      break;
    }
    case 'compaction':
      b.add('compact', { text: '[compact 摘要已加密，无法读取]', time, encrypted: true });
      break;
    default:
      break;
  }
}
