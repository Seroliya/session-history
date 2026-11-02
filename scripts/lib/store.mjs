// Session discovery, lookup and caching.
//
// Two caches live under cacheDir(), both keyed by a signature of the session's
// files (path|mtime|size), so a changed or growing session is re-read:
//   index.json                      lightweight summary per session (for list)
//   digests/<source>/<id>.json.gz   searchable text per session (for search)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as dsh from './adapters/dsh.mjs';
import * as codex from './adapters/codex.mjs';
import * as claude from './adapters/claude.mjs';
import { resolveRoots, SOURCES } from './roots.mjs';
import { cacheDir, oneLine, isUnder, normPath } from './util.mjs';
import { firstUserText, lastOf } from './model.mjs';

export const ADAPTERS = { dsh, codex, claude };
const CACHE_VERSION = 7;
// A lineage key shorter than this ("你好", "继续") would group unrelated sessions.
const MIN_LINEAGE_KEY = 15;
// Digest text caps: enough to find a session, not to replace show.
const DIGEST_CAP = { user: 0, agent: 4000, assistant: 0, compact: 0, subagent: 0, tool_call: 1500, tool_result: 1500 };

export function currentSessionId() {
  const v = process.env.SESSION_HISTORY_CURRENT || process.env.DSH_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || '';
  return v.replace(/^session-/, '').toLowerCase();
}

export function shortId(e) {
  return e.source === 'codex' ? e.id.slice(0, 13) : e.id.slice(0, 8);
}

const sig = (e) => e.files.map((f) => `${f.path}|${Math.round(f.mtime)}|${f.size}`).join(';');
const keyOf = (e) => `${e.source}:${e.id}`;

export class Store {
  constructor({ roots = [], noCache = false, quiet = false } = {}) {
    this.rootInfo = resolveRoots(roots);
    this.noCache = noCache;
    this.quiet = quiet;
    this.dir = cacheDir();
    this.current = currentSessionId();
    this._entries = null;
    this._index = null;
    this._dirty = false;
    this._parsed = new Map();
  }

  entries(sources = SOURCES) {
    if (!this._entries) {
      const out = [];
      for (const src of SOURCES) {
        for (const r of this.rootInfo.roots[src]) {
          if (!r.exists) continue;
          const before = out.length;
          try { ADAPTERS[src].discover(r.path, out); } catch (e) { r.error = e.message; }
          r.count = out.length - before;
        }
      }
      const byKey = new Map();
      for (const e of out) {
        const k = keyOf(e);
        const o = byKey.get(k);
        if (!o || e.mtime > o.mtime) byKey.set(k, e);
      }
      this._entries = [...byKey.values()];
    }
    return this._entries.filter((e) => sources.includes(e.source));
  }

  isCurrent(e) { return !!this.current && e.id.toLowerCase() === this.current; }

  // ---- full parse (memoized for the life of the process) ----
  parse(e) {
    const k = keyOf(e);
    if (!this._parsed.has(k)) {
      const s = ADAPTERS[e.source].parse(e);
      s.meta.shortId = shortId(e);
      s.meta.current = this.isCurrent(e);
      this._parsed.clear();
      this._parsed.set(k, s);
    }
    return this._parsed.get(k);
  }

  // ---- summaries (index cache) ----
  _loadIndex() {
    if (this._index) return this._index;
    let idx = { version: CACHE_VERSION, items: {} };
    if (!this.noCache) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8'));
        if (j.version === CACHE_VERSION && j.items) idx = j;
      } catch { /* cold cache */ }
    }
    this._index = idx;
    return idx;
  }

  save() {
    if (this.noCache || !this._dirty) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = path.join(this.dir, 'index.json');
      fs.writeFileSync(f + '.tmp', JSON.stringify(this._index));
      fs.renameSync(f + '.tmp', f);
      this._dirty = false;
    } catch (err) {
      if (!this.quiet) process.stderr.write(`[session-history] 缓存写入失败：${err.message}\n`);
    }
  }

  summaries(entries) {
    const idx = this._loadIndex();
    const stale = entries.filter((e) => idx.items[keyOf(e)]?.sig !== sig(e));
    let done = 0;
    const t0 = Date.now();
    for (const e of stale) {
      try {
        const s = ADAPTERS[e.source].parse(e);
        idx.items[keyOf(e)] = { sig: sig(e), ...summarize(e, s) };
        this._writeDigest(e, s);
      } catch (err) {
        idx.items[keyOf(e)] = { sig: sig(e), error: err.message, meta: { source: e.source, id: e.id, title: '(解析失败)', updated: e.mtime } };
      }
      this._dirty = true;
      done++;
      if (!this.quiet && stale.length > 20 && (done % 50 === 0 || done === stale.length)) {
        process.stderr.write(`[session-history] 建立索引 ${done}/${stale.length}（${((Date.now() - t0) / 1000).toFixed(0)}s，只在首次或会话变化时发生）\n`);
      }
    }
    this.save();
    return entries.map((e) => {
      const it = idx.items[keyOf(e)];
      return { entry: e, ...it, meta: { ...it.meta, shortId: shortId(e), current: this.isCurrent(e) } };
    });
  }

  // ---- digests (search cache) ----
  _digestPath(e) {
    return path.join(this.dir, 'digests', e.source, e.id.replace(/[^\w.-]/g, '_') + '.json.gz');
  }

  _writeDigest(e, s) {
    const d = buildDigest(e, s);
    if (this.noCache) return d;
    try {
      const p = this._digestPath(e);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, zlib.gzipSync(JSON.stringify(d)));
    } catch { /* cache is best-effort */ }
    return d;
  }

  digest(e) {
    if (!this.noCache) {
      try {
        const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(this._digestPath(e))).toString('utf8'));
        if (d.sig === sig(e) && d.version === CACHE_VERSION) return d;
      } catch { /* rebuild */ }
    }
    return this._writeDigest(e, ADAPTERS[e.source].parse(e));
  }

  // ---- lookup ----
  // query: id prefix (with or without "session-"), "source:prefix", or "last".
  find(query, { sources = SOURCES, cwd = '', includeSub = true } = {}) {
    let q = String(query || '').trim().toLowerCase();
    let srcs = sources;
    const m = /^(dsh|codex|claude):(.*)$/.exec(q);
    if (m) { srcs = [m[1]]; q = m[2]; }
    q = q.replace(/^session-/, '');
    const all = this.entries(srcs);
    if (q === 'last' || q === 'latest') {
      let cands = this.summaries(all).filter((s) => !s.meta.current && !s.meta.isSubagent && !s.error);
      if (cwd) cands = cands.filter((s) => s.meta.cwd && cwdMatch(s.meta.cwd, cwd));
      cands.sort((a, b) => (b.meta.updated || 0) - (a.meta.updated || 0));
      return cands.length ? { entry: cands[0].entry } : { error: '没有符合条件的会话' };
    }
    if (q.length < 4) return { error: `id 前缀太短：「${query}」（至少 4 位）` };
    const hits = all.filter((e) => e.id.toLowerCase().startsWith(q) || (includeSub && e.id.toLowerCase().replace(/^agent-/, '').startsWith(q)));
    if (hits.length === 1) return { entry: hits[0] };
    if (!hits.length) return { error: `找不到 id 以「${query}」开头的会话（可先用 list 或 search 查找）` };
    return { error: `id 前缀「${query}」匹配到 ${hits.length} 个会话，请写长一些`, candidates: hits };
  }

  // Relations to other sessions, from the summary index:
  //   chain  sessions sharing the same origin message, oldest first. A fork
  //          copies its parent's history, so its first inherited user message
  //          equals the root's first message; the predecessor in the chain is
  //          the parent. Works without a recorded parent id.
  //   later  sessions created afterwards in the same working directory
  //          (possible follow-up work, possibly unrelated).
  relations(entry) {
    const rows = this.summaries(this.entries()).filter((r) => !r.error && !r.meta.isSubagent);
    const me = rows.find((r) => r.entry.source === entry.source && r.entry.id === entry.id);
    if (!me) return { chain: [], later: [] };
    let chain = this._forkTree(rows, me);
    if (chain.length < 2) {
      // No recorded fork link (DSH): group by the shared origin message.
      const origin = (r) => (r.seedFirstUser || r.firstUser || '').trim();
      const k = origin(me);
      chain = k.length >= MIN_LINEAGE_KEY ? rows.filter((r) => origin(r) === k) : [];
    }
    if (chain.length < 2) chain = [];
    chain.sort((a, b) => (a.meta.created || 0) - (b.meta.created || 0));
    const inChain = new Set(chain.map((r) => r.entry));
    const cwd = me.meta.cwd ? normPath(me.meta.cwd) : '';
    const later = cwd ? rows.filter((r) => r !== me && !inChain.has(r.entry) && !r.meta.current
      && r.meta.cwd && normPath(r.meta.cwd) === cwd
      && (r.meta.created || 0) > (me.meta.created || 0) && (r.stats?.userMsgs || 0) > 0)
      .sort((a, b) => (a.meta.created || 0) - (b.meta.created || 0)) : [];
    const brief = (r) => ({ id: r.meta.id, shortId: r.meta.shortId, source: r.meta.source, title: r.meta.title, created: r.meta.created, updated: r.meta.updated, self: r === me, current: r.meta.current });
    const parentMissing = me.meta.forkedFrom && !rows.some((r) => r.meta.source === me.meta.source && r.meta.id.toLowerCase() === me.meta.forkedFrom) ? me.meta.forkedFrom : '';
    return { chain: chain.map(brief), later: later.map(brief), forkedFrom: me.meta.forkedFrom || '', forkOrdinal: me.meta.forkOrdinal ?? null, parentMissing };
  }

  // Sessions connected to `me` through recorded fork links (Codex forked_from_id):
  // walk up to the root, then collect every descendant of that root.
  _forkTree(rows, me) {
    if (!rows.some((r) => r.meta.forkedFrom)) return [];
    const byId = new Map(rows.map((r) => [`${r.meta.source}:${r.meta.id.toLowerCase()}`, r]));
    const parentOf = (r) => (r.meta.forkedFrom ? byId.get(`${r.meta.source}:${r.meta.forkedFrom}`) : null);
    let root = me;
    const seen = new Set([me]);
    for (let p = parentOf(root); p && !seen.has(p); p = parentOf(root)) { seen.add(p); root = p; }
    const kids = new Map();
    for (const r of rows) { const p = parentOf(r); if (p) (kids.get(p) || kids.set(p, []).get(p)).push(r); }
    const out = [];
    const stack = [root];
    while (stack.length) { const r = stack.pop(); if (out.includes(r)) continue; out.push(r); stack.push(...(kids.get(r) || [])); }
    return out;
  }

  // Codex records the parent on the child; collect children for a parent id.
  childrenFromIndex(parentId) {
    const idx = this._loadIndex();
    const out = [];
    for (const it of Object.values(idx.items)) {
      if (it.meta?.parentId && it.meta.parentId.toLowerCase() === parentId.toLowerCase()) out.push({ id: it.meta.id, label: it.meta.label || '', title: it.meta.title });
    }
    return out;
  }
}

export function cwdMatch(sessionCwd, want) {
  return isUnder(sessionCwd, want) || normPath(sessionCwd) === normPath(want);
}

export function summarize(e, s) {
  const lastA = lastOf(s, 'assistant', (i) => !i.inherited);
  const lastT = s.turns[s.turns.length - 1];
  const todos = s.extras.todos || [];
  return {
    meta: {
      source: e.source, id: e.id, title: s.meta.title, cwd: s.meta.cwd, created: s.meta.created || 0,
      updated: s.meta.updated || e.mtime, model: s.meta.model, isSubagent: !!(s.meta.isSubagent || e.subagent),
      parentId: s.meta.parentId || '', label: s.meta.label || '', archived: !!s.meta.archived,
      seeded: !!s.meta.seeded, truncated: !!s.meta.truncated,
      forkedFrom: s.meta.forkedFrom || '', forkOrdinal: s.meta.forkOrdinal ?? null,
    },
    stats: s.stats,
    firstUser: oneLine(firstUserText(s), 200),
    seedFirstUser: oneLine(firstInheritedUser(s), 200),
    lastAssistant: oneLine(lastA?.text || '', 200),
    lastStatus: lastT?.status || '',
    children: s.extras.children.length,
    todosOpen: todos.filter((t) => t.status !== 'completed').length,
    todosTotal: todos.length,
    goal: s.extras.goal?.objective ? oneLine(s.extras.goal.objective, 200) : '',
    tokens: s.extras.tokens || 0,
  };
}

function firstInheritedUser(s) {
  for (const t of s.turns) for (const it of t.items) if (it.kind === 'user' && it.inherited && it.text.trim()) return it.text;
  return '';
}

function buildDigest(e, s) {
  const items = [];
  for (const t of s.turns) {
    for (const it of t.items) {
      if (!(it.kind in DIGEST_CAP)) continue;
      let text = it.kind === 'tool_call' ? `${it.name} ${it.args || ''}` : it.text;
      const cap = DIGEST_CAP[it.kind];
      if (cap && text.length > cap) text = text.slice(0, cap);
      if (!text) continue;
      items.push([it.ref, it.kind, text, it.inherited ? 1 : 0, it.name || it.label || '']);
    }
  }
  return { version: CACHE_VERSION, sig: sig(e), items };
}
