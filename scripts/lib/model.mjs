// Normalized session model shared by all adapters.
//
// A session is a list of turns; each turn holds items in original order.
// Item kinds:
//   user        real human input
//   agent       input from another agent / automation (subagent result, heartbeat)
//   assistant   model text (phase 'commentary' or final)
//   reasoning   model thinking (plaintext only; encrypted is reported, not shown)
//   tool_call   {name, args}  args is the raw string as recorded
//   tool_result {name, isError}
//   system      system / developer prompt (deduplicated)
//   notice      harness-injected context (runtime context, skill catalog, AGENTS.md, job notices...)
//   compact     a compaction summary; context AFTER it continues normally
//   subagent    link to a child session {childId, label}
// Refs are "T<turn>.<index>", index 1-based within the turn, assigned over ALL
// items so they are stable regardless of view.

export const CATEGORY = {
  user: 'chat', agent: 'chat', assistant: 'chat', subagent: 'chat',
  tool_call: 'tools', tool_result: 'results', reasoning: 'reasoning',
  system: 'system', notice: 'notice', compact: 'compact',
};

export class SessionBuilder {
  constructor(meta, { turnOnUser = false } = {}) {
    this.meta = {
      source: '', id: '', title: '', cwd: '', created: 0, updated: 0, model: '',
      isSubagent: false, parentId: '', label: '', files: [], truncated: false, archived: false,
      ...meta,
    };
    this.turnOnUser = turnOnUser;
    this.turns = [{ n: 0, time: 0, status: '', items: [] }];
    this.cur = this.turns[0];
    this.extras = { todos: null, goal: null, deliverables: [], children: [], sidechainItems: 0 };
    this._sys = new Set();
    this._callNames = new Map();
    // While true, added items are history copied from a parent session (fork/seed).
    this.inheriting = false;
  }

  startTurn(time) {
    // Reuse an empty turn instead of leaving holes (e.g. a turn marker with no content).
    if (this.cur.n > 0 && this.cur.items.length === 0) { this.cur.time = time || this.cur.time; return this.cur; }
    this.cur = { n: this.turns.length, time: time || 0, status: '', items: [] };
    this.turns.push(this.cur);
    return this.cur;
  }

  add(kind, fields = {}) {
    const text = fields.text == null ? '' : String(fields.text);
    if (kind === 'system') {
      const key = text.length + ':' + text.slice(0, 200) + text.slice(-200);
      if (this._sys.has(key)) return null;
      this._sys.add(key);
    }
    if (kind === 'user' && this.turnOnUser) {
      const hasConv = this.cur.items.some((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'tool_call');
      if (this.cur.n === 0 || hasConv) this.startTurn(fields.time);
    }
    if (kind === 'tool_call' && fields.callId) this._callNames.set(fields.callId, fields.name);
    if (kind === 'tool_result' && !fields.name && fields.callId) fields.name = this._callNames.get(fields.callId) || '';
    const item = { kind, ...fields, text };
    if (this.inheriting) item.inherited = true;
    if (!this.cur.time && fields.time) this.cur.time = fields.time;
    this.cur.items.push(item);
    if (fields.time && fields.time > this.meta.updated) this.meta.updated = fields.time;
    return item;
  }

  finish() {
    const turns = this.turns.filter((t) => t.n === 0 ? t.items.length > 0 : true);
    // Renumber so turn numbers are contiguous after dropping empties.
    let n = 0;
    const out = [];
    for (const t of turns) {
      if (t.n !== 0 && t.items.length === 0) continue;
      const tn = t.n === 0 ? 0 : ++n;
      t.n = tn;
      t.items.forEach((it, i) => { it.ref = `T${tn}.${i + 1}`; });
      out.push(t);
    }
    const s = { meta: this.meta, turns: out, extras: this.extras };
    s.stats = computeStats(s);
    if (!s.meta.title) {
      const fu = firstUserText(s);
      s.meta.title = fu ? fu.replace(/\s+/g, ' ').trim().slice(0, 40) : '(无标题)';
    }
    return s;
  }
}

export function computeStats(s) {
  const chars = { chat: 0, tools: 0, results: 0, reasoning: 0, system: 0, notice: 0, compact: 0 };
  const compacts = [];
  let userMsgs = 0, toolCalls = 0, encryptedReasoning = 0, inheritedTurns = 0, encryptedCompacts = 0;
  for (const t of s.turns) {
    if (t.n > 0 && t.items.length && t.items.every((i) => i.inherited)) inheritedTurns++;
    for (const it of t.items) {
      if (it.inherited) continue;
      const cat = CATEGORY[it.kind] || 'system';
      chars[cat] += (it.text || '').length + (it.args ? it.args.length : 0);
      if (it.kind === 'user') userMsgs++;
      if (it.kind === 'tool_call') toolCalls++;
      if (it.kind === 'compact') { compacts.push(it.ref); if (it.encrypted) encryptedCompacts++; }
      if (it.kind === 'reasoning' && it.encrypted) encryptedReasoning++;
    }
  }
  return { chars, compacts, encryptedCompacts, userMsgs, toolCalls, encryptedReasoning, inheritedTurns, turns: s.turns.filter((t) => t.n > 0).length };
}

export function firstUserText(s) {
  for (const t of s.turns) for (const it of t.items) if (it.kind === 'user' && !it.inherited && it.text.trim()) return it.text;
  for (const t of s.turns) for (const it of t.items) if (it.kind === 'user' && it.text.trim()) return it.text;
  return '';
}

export function lastOf(s, kind, pred = () => true) {
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const items = s.turns[i].items;
    for (let j = items.length - 1; j >= 0; j--) if (items[j].kind === kind && pred(items[j])) return items[j];
  }
  return null;
}

export function tryJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}
