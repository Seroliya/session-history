// DeepSeek Harness sessions: <root>/sessions/<cwd-slug>/<id>/session[.vN].jsonl.zstd
// Each file is a stream of concatenated zstd frames holding an event log.
// Subagent sessions live beside their parent (directory name without the
// "session-" prefix) and start with a subagent/descriptor record.
import fs from 'node:fs';
import path from 'node:path';
import { readSessionText } from '../zstd.mjs';
import { parseJsonl, textOfParts } from '../util.mjs';
import { SessionBuilder } from '../model.mjs';

const FILE_RE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd?)?$/;

export const source = 'dsh';

export function sessionsDir(root) {
  const s = path.join(root, 'sessions');
  return fs.existsSync(s) ? s : root;
}

export function discover(root, out) {
  const base = sessionsDir(root);
  walk(base, 0);
  function walk(dir, depth) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    // Prefer the newest format when a directory holds several generations.
    const files = ents.filter((e) => e.isFile() && FILE_RE.test(e.name)).map((e) => e.name)
      .sort((a, b) => version(b) - version(a));
    if (files.length) {
      const f = path.join(dir, files[0]);
      const st = fs.statSync(f);
      out.push({ source, id: normId(path.basename(dir)), files: [{ path: f, mtime: st.mtimeMs, size: st.size }], root, mtime: st.mtimeMs });
      return;
    }
    if (depth >= 3) return;
    for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  }
}

function version(name) { const m = /\.v(\d+)\./.exec(name); return m ? +m[1] : 0; }
export function normId(id) { return String(id).replace(/^session-/, ''); }

// Sniff: first record is {"type":"session","version":N,...}
export function sniff(firstRecord) { return firstRecord && firstRecord.type === 'session' && 'version' in firstRecord && 'cwd' in firstRecord; }

const AGENT_SOURCES = new Set(['agent-message', 'subagent-settled']);

export function parse(entry) {
  const file = entry.files[0].path;
  const { text, truncated } = readSessionText(file);
  const b = new SessionBuilder({ source, id: entry.id, files: [file], truncated });
  let pendingCompact = false;
  for (const o of parseJsonl(text)) {
    const d = o.data || {};
    const time = o.time || 0;
    switch (o.type) {
      case 'session':
        b.meta.cwd = o.cwd || b.meta.cwd;
        b.meta.created = o.createdAt || 0;
        b.meta.rawId = o.id;
        if (o.delegationDepth > 0) b.meta.isSubagent = true;
        // A seeded (forked) session starts with a copy of the parent's history,
        // terminated by the first session/end-seed record.
        if (o.isSeeded) { b.meta.seeded = true; b.inheriting = true; }
        break;
      case 'session/end-seed':
        b.inheriting = false;
        break;
      case 'subagent/descriptor':
        b.meta.isSubagent = true;
        b.meta.label = d.label || '';
        if (d.agentModel) b.meta.model = (d.agentProvider ? d.agentProvider + '/' : '') + d.agentModel;
        break;
      case 'session/title':
        if (d.title) b.meta.title = d.title;
        break;
      case 'request/header':
        if (d.header?.config?.model) b.meta.model = d.header.config.model;
        if (typeof d.header?.system === 'string' && d.header.system) b.add('system', { text: d.header.system, time });
        break;
      case 'model/selection':
        if (d.model) b.meta.model = d.model;
        break;
      case 'working-directory/change':
        if (d.to || d.cwd) b.meta.cwd = d.to || d.cwd;
        break;
      case 'turn/start':
        b.startTurn(time);
        break;
      case 'turn/end':
        if (d.reason?.kind && d.reason.kind !== 'completed') b.cur.status = d.reason.kind === 'aborted' ? '中断' : d.reason.kind;
        break;
      case 'system/message':
        b.add('system', { text: textOfParts(d.message?.content), time });
        break;
      case 'developer/message': {
        const parts = d.message?.content || [];
        const t = parts.map((p) => p.type === 'tool-addition' ? `[工具加入] ${p.toolName}` : p.type === 'tool-removal' ? `[工具移除] ${p.toolName}` : (p.text || '')).join('\n');
        if (t) b.add('notice', { text: t, label: 'developer', time });
        break;
      }
      case 'user/message': {
        const kind = d.source?.kind || 'user';
        const label = kind === 'plugin' ? d.source.plugin : kind;
        const t = textOfParts(d.content);
        if (kind === 'compact-checkpoint') {
          if (!pendingCompact) b.add('compact', { text: t, time });
          pendingCompact = false;
        } else if (kind === 'user') b.add('user', { text: t, time });
        else if (AGENT_SOURCES.has(kind)) b.add('agent', { text: t, label, time });
        else b.add('notice', { text: t, label, time });
        break;
      }
      case 'assistant/message': {
        if (d.usage?.totalTokens) b.extras.tokens = (b.extras.tokens || 0) + d.usage.totalTokens;
        for (const p of d.message?.content || []) {
          if (p.type === 'text' && p.text) b.add('assistant', { text: p.text, time });
          else if (p.type === 'reasoning' && p.text) b.add('reasoning', { text: p.text, time });
          else if (p.type === 'tool-call') b.add('tool_call', { name: p.name, args: typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? ''), callId: p.id, time });
        }
        break;
      }
      case 'tool/result': {
        const m = d.message || {};
        let callId = m.toolCallId || m.source?.callId;
        let isError = !!m.isError;
        const texts = [];
        for (const p of m.content || []) {
          if (p.type === 'tool-result') {
            callId = callId || p.toolCallId;
            if (p.isError) isError = true;
            texts.push(textOfParts(p.content));
          } else if (p.type === 'text') texts.push(p.text);
          else if (p.type === 'image') texts.push('[图片]');
        }
        const out = texts.join('\n');
        if (/\[exit code: [1-9]\d*\]\s*$/.test(out)) isError = true;
        b.add('tool_result', { text: out, callId, isError, time });
        break;
      }
      case 'compaction/summary':
        b.add('compact', { text: textOfParts(d.summary), time });
        pendingCompact = true;
        break;
      case 'subagent/catalog':
        if (d.childId) {
          b.extras.children.push({ id: normId(d.childId), label: d.label || '' });
          b.add('subagent', { childId: normId(d.childId), label: d.label || '', text: d.label || '', time });
        }
        break;
      case 'todo/write':
        if (Array.isArray(d.todos)) {
          b.extras.todos = d.todos.map((x) => ({ content: x.content, status: x.status }));
          b.extras.todosInherited = b.inheriting;
        }
        break;
      case 'goal/change':
        if (d.goal?.objective) b.extras.goal = { objective: d.goal.objective, status: d.goal.phase || d.operation || '', inherited: b.inheriting };
        break;
      case 'deliverables/presented':
        for (const f of d.files || []) if (f.path) b.extras.deliverables.push(f.path);
        break;
      default:
        break;
    }
    if (time > b.meta.updated) b.meta.updated = time;
  }
  if (!b.meta.updated) b.meta.updated = entry.files[0].mtime;
  return b.finish();
}
