// Claude Code transcripts: <CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd-slug>/<sessionId>.jsonl
// Subagents: projects/<slug>/<sessionId>/subagents/agent-<id>.jsonl (+ .meta.json).
// Field reference: daaain/claude-code-log models.py, swyxio/claude-compaction-viewer.
// Not verified against live data on the authoring machine.
import fs from 'node:fs';
import path from 'node:path';
import { readSessionText } from '../zstd.mjs';
import { parseJsonl, textOfParts, toMs } from '../util.mjs';
import { SessionBuilder } from '../model.mjs';

export const source = 'claude';

export function sniff(r) { return !!r && typeof r.sessionId === 'string' && /^(user|assistant|system|summary|progress|attachment|ai-title|custom-title|file-history-snapshot|queue-operation)$/.test(r.type || ''); }

export function discover(root, out) {
  const pj = path.join(root, 'projects');
  const base = fs.existsSync(pj) ? pj : root;
  let slugs;
  try { slugs = fs.readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    const dir = path.join(base, s.name);
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.isFile() && /\.jsonl$/.test(e.name)) {
        const p = path.join(dir, e.name);
        const st = fs.statSync(p);
        out.push({ source, id: e.name.replace(/\.jsonl$/, ''), files: [{ path: p, mtime: st.mtimeMs, size: st.size }], root, mtime: st.mtimeMs });
      } else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, 'subagents');
        let sents;
        try { sents = fs.readdirSync(sub, { withFileTypes: true }); } catch { continue; }
        for (const f of sents) {
          if (!f.isFile() || !/\.jsonl$/.test(f.name)) continue;
          const p = path.join(sub, f.name);
          const st = fs.statSync(p);
          out.push({ source, id: f.name.replace(/\.jsonl$/, ''), files: [{ path: p, mtime: st.mtimeMs, size: st.size }], root, mtime: st.mtimeMs, parentHint: e.name, subagent: true });
        }
      }
    }
  }
}

function childrenOf(file) {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
  let ents;
  try { ents = fs.readdirSync(dir); } catch { return []; }
  return ents.filter((n) => /\.jsonl$/.test(n)).map((n) => {
    const id = n.replace(/\.jsonl$/, '');
    let label = '';
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, id + '.meta.json'), 'utf8'));
      label = m.description || m.agentType || m.subagent_type || m.name || '';
    } catch { /* no sidecar */ }
    return { id, label };
  });
}

// Rewinds and message edits leave the old branch in the same file; records form
// a tree through parentUuid (compact boundaries bridge via logicalParentUuid).
// The live conversation is the chain from the last message back to the root.
// Returns null (keep everything) when there is no uuid chain or it is broken.
function activeBranch(recs, isSub) {
  const byUuid = new Map();
  for (const o of recs) if (o.uuid) byUuid.set(o.uuid, o);
  if (!byUuid.size) return null;
  let leaf = null;
  for (let i = recs.length - 1; i >= 0; i--) {
    const o = recs[i];
    if (o.uuid && (o.type === 'user' || o.type === 'assistant') && (isSub || !o.isSidechain)) { leaf = o; break; }
  }
  if (!leaf) return null;
  const active = new Set();
  let o = leaf;
  while (o && !active.has(o.uuid)) {
    active.add(o.uuid);
    const p = o.parentUuid || o.logicalParentUuid;
    if (!p) return active;
    o = byUuid.get(p);
    if (!o) return null;
  }
  return active;
}

const NOTICE_RE = /^\s*(?:<(?:local-command-stdout|local-command-stderr|system-reminder|command-message)>|Caveat: The messages below|\[Request interrupted)/;

function userText(raw) {
  const m = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(raw);
  if (m) return { kind: 'user', text: `${m[1].trim()} ${(m[2] || '').trim()}`.trim() };
  if (NOTICE_RE.test(raw)) return { kind: 'notice', text: raw };
  return { kind: 'user', text: raw };
}

export function parse(entry) {
  const file = entry.files[0].path;
  const { text, truncated } = readSessionText(file);
  const isSub = !!entry.subagent;
  const b = new SessionBuilder({ source, id: entry.id, files: [file], truncated, isSubagent: isSub, parentId: entry.parentHint || '' }, { turnOnUser: true });
  let customTitle = '', aiTitle = '', summary = '';
  let tokens = 0;
  const recs = [...parseJsonl(text)];
  const active = activeBranch(recs, isSub);
  let dropped = 0;
  for (const o of recs) {
    const time = toMs(o.timestamp);
    if (o.cwd && !b.meta.cwd) b.meta.cwd = o.cwd;
    if (time && !b.meta.created) b.meta.created = time;
    if (o.isSidechain && !isSub) { b.extras.sidechainItems++; continue; }
    if (active && o.uuid && !active.has(o.uuid)) {
      if (o.type === 'user' || o.type === 'assistant') dropped++;
      continue;
    }
    switch (o.type) {
      case 'summary': if (o.summary) summary = o.summary; break;
      case 'custom-title': customTitle = o.customTitle || o.title || customTitle; break;
      case 'ai-title': aiTitle = o.aiTitle || o.title || aiTitle; break;
      case 'system':
        if (o.subtype === 'compact_boundary') b.cur.compactBoundary = true;
        else if (o.content) b.add('notice', { text: typeof o.content === 'string' ? o.content : textOfParts(o.content), label: o.subtype || 'system', time });
        break;
      case 'attachment':
        b.add('notice', { text: typeof o.attachment === 'string' ? o.attachment : JSON.stringify(o.attachment ?? o.content ?? ''), label: 'attachment', time });
        break;
      case 'user': {
        const c = o.message?.content;
        if (o.isCompactSummary) { b.add('compact', { text: textOfParts(c), time }); break; }
        if (typeof c === 'string') {
          const u = o.isMeta ? { kind: 'notice', text: c } : userText(c);
          b.add(u.kind, { text: u.text, time });
          break;
        }
        const texts = [];
        for (const p of c || []) {
          if (p.type === 'tool_result') {
            b.add('tool_result', { text: textOfParts(p.content), callId: p.tool_use_id, isError: !!p.is_error, time });
          } else if (p.type === 'text') texts.push(p.text);
          else if (p.type === 'image') texts.push('[图片]');
        }
        if (texts.length) {
          const raw = texts.join('\n');
          const u = o.isMeta ? { kind: 'notice', text: raw } : userText(raw);
          b.add(u.kind, { text: u.text, time });
        }
        break;
      }
      case 'assistant': {
        const m = o.message || {};
        if (m.model && m.model !== '<synthetic>') b.meta.model = m.model;
        if (m.usage) tokens += (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0) + (m.usage.cache_read_input_tokens || 0) + (m.usage.cache_creation_input_tokens || 0);
        const c = m.content;
        if (typeof c === 'string') { if (c) b.add('assistant', { text: c, time }); break; }
        for (const p of c || []) {
          if (p.type === 'text' && p.text) b.add('assistant', { text: p.text, time });
          else if (p.type === 'thinking' && p.thinking) b.add('reasoning', { text: p.thinking, time });
          else if (p.type === 'redacted_thinking') b.add('reasoning', { text: '[推理已加密]', time, encrypted: true });
          else if (p.type === 'tool_use') {
            b.add('tool_call', { name: p.name, args: JSON.stringify(p.input ?? {}), callId: p.id, time });
            if (p.name === 'TodoWrite' && Array.isArray(p.input?.todos)) b.extras.todos = p.input.todos.map((x) => ({ content: x.content, status: x.status }));
          }
        }
        break;
      }
      default: break;
    }
  }
  b.meta.title = customTitle || aiTitle || summary || '';
  if (tokens) b.extras.tokens = tokens;
  if (dropped) b.extras.droppedBranchMsgs = dropped;
  if (!isSub) for (const ch of childrenOf(file)) {
    b.extras.children.push(ch);
  }
  if (!b.meta.updated) b.meta.updated = entry.mtime;
  return b.finish();
}
