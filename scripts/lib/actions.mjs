// Extract shell commands and file changes from tool calls, across tool vocabularies
// (DSH pwsh/write/edit, Codex exec_command/shell/apply_patch, Claude Bash/Edit/Write).
import { tryJson } from './model.mjs';

const SHELL = /^(pwsh|powershell|bash|sh|zsh|cmd|shell|shell_command|exec|exec_command|local_shell|run_command|run_shell_command|terminal|execute_command)$/i;
const EDIT = /^(edit|write|multiedit|notebookedit|str_replace_editor|str_replace_based_edit_tool|create_file|write_file|edit_file|replace|apply_patch|patch)$/i;
const ERR_RE = /\[exit code: [1-9]\d*\]\s*$|Process exited with code [1-9]|^Exit code: [1-9]/m;

function baseName(name) {
  // mcp__server__tool -> tool
  return String(name || '').split('__').pop();
}

export function commandOf(it) {
  const n = baseName(it.name);
  const a = tryJson(it.args);
  if (!SHELL.test(n) && !(a && typeof a.command === 'string' && /shell|bash|cmd|exec/i.test(n))) return null;
  if (!a) return typeof it.args === 'string' ? it.args : null;
  let c = a.command ?? a.cmd ?? a.script ?? a.input;
  if (Array.isArray(c)) {
    // ["powershell.exe","-Command","..."] / ["bash","-lc","..."]: keep the script.
    const i = c.findIndex((x) => /^-(?:lc|c|Command)$/i.test(x));
    c = i >= 0 && c[i + 1] ? c[i + 1] : c.join(' ');
  }
  return typeof c === 'string' ? c : null;
}

export function filesOf(it) {
  const n = baseName(it.name);
  const raw = typeof it.args === 'string' ? it.args : '';
  const out = [];
  if (/\*\*\* (?:Add|Update|Delete) File:/.test(raw)) {
    // apply_patch may arrive raw or JSON-wrapped; unescape newlines either way.
    const txt = raw.includes('\\n') && !raw.includes('\n') ? raw.replace(/\\n/g, '\n') : raw;
    const re = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$|^\*\*\* Move to: (.+?)\s*$/gm;
    let m;
    while ((m = re.exec(txt))) {
      if (m[3]) out.push({ path: m[3].replace(/\\\\/g, '\\'), op: 'move' });
      else out.push({ path: m[2].replace(/\\\\/g, '\\').replace(/["},]+$/, ''), op: m[1].toLowerCase() === 'add' ? 'add' : m[1].toLowerCase() === 'delete' ? 'delete' : 'edit' });
    }
    return out;
  }
  if (!EDIT.test(n)) return out;
  const a = tryJson(it.args) || {};
  const p = a.file_path ?? a.path ?? a.notebook_path ?? a.filePath ?? a.target_file;
  if (typeof p === 'string') out.push({ path: p, op: /write|create/i.test(n) || a.command === 'create' ? 'write' : 'edit' });
  return out;
}

// Returns {commands:[{ref, turn, cmd, isError}], files:[{path, ops, count, firstRef, lastRef, failed}]}
export function extractActions(session, { includeInherited = false } = {}) {
  const results = new Map();
  for (const t of session.turns) for (const it of t.items) {
    if (it.kind === 'tool_result' && it.callId) results.set(it.callId, it);
  }
  const commands = [];
  const files = new Map();
  for (const t of session.turns) {
    for (const it of t.items) {
      if (it.kind !== 'tool_call' || (it.inherited && !includeInherited)) continue;
      const r = it.callId ? results.get(it.callId) : null;
      const isError = !!(r && (r.isError || ERR_RE.test((r.text || '').slice(-400))));
      const cmd = commandOf(it);
      if (cmd) commands.push({ ref: it.ref, turn: t.n, cmd, isError });
      for (const f of filesOf(it)) {
        const k = f.path.replace(/\\/g, '/').toLowerCase();
        let e = files.get(k);
        if (!e) { e = { path: f.path, ops: new Set(), count: 0, firstRef: it.ref, lastRef: it.ref, failed: 0 }; files.set(k, e); }
        e.ops.add(f.op);
        e.count++;
        e.lastRef = it.ref;
        if (isError) e.failed++;
      }
    }
  }
  return {
    commands,
    files: [...files.values()].map((f) => ({ ...f, ops: [...f.ops] })),
  };
}
