import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const IS_WIN = process.platform === 'win32';
export const HOME = os.homedir();

export function configDir() {
  if (process.env.SESSION_HISTORY_CONFIG) return path.dirname(process.env.SESSION_HISTORY_CONFIG);
  if (IS_WIN) return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'session-history');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'session-history');
}

export function configPath() {
  return process.env.SESSION_HISTORY_CONFIG || path.join(configDir(), 'config.json');
}

export function loadConfig() {
  const p = configPath();
  try {
    return { path: p, exists: true, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (e) {
    if (e.code === 'ENOENT') return { path: p, exists: false, data: {} };
    throw new Error(`配置文件解析失败 ${p}: ${e.message}`);
  }
}

export function cacheDir() {
  if (process.env.SESSION_HISTORY_CACHE) return process.env.SESSION_HISTORY_CACHE;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'session-history', 'cache');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Caches', 'session-history');
  return path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'session-history');
}

export function normPath(p) {
  if (!p) return '';
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (IS_WIN || /^[a-zA-Z]:\//.test(s)) s = s.toLowerCase();
  return s;
}

export function isUnder(child, parent) {
  const c = normPath(child), p = normPath(parent);
  return c === p || c.startsWith(p + '/');
}

export function fmtK(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ms, withYear = true) {
  if (!ms) return '?';
  const d = new Date(ms);
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withYear ? `${d.getFullYear()}-${md}` : md;
}

export function parseSince(s) {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(s);
  if (m) {
    const mult = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
    return Date.now() - parseFloat(m[1]) * mult;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${s}（可用 7d / 12h / 2026-10-01）`);
  return t;
}

export function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

export function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// Keep head and tail: errors and conclusions tend to sit at the end.
export function clip(s, n, hint = '') {
  s = String(s || '');
  if (!n || s.length <= n) return s;
  const head = Math.ceil(n * 0.7), tail = n - head;
  const cut = s.length - head - tail;
  return s.slice(0, head) + `\n…[省略 ${cut} 字${hint ? '，' + hint : ''}]…\n` + (tail ? s.slice(-tail) : '');
}

const REDACT_RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '[REDACTED:github]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED:aws]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED:jwt]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 [REDACTED]'],
  // key = value: only when the value looks like a secret, not a variable,
  // command or placeholder (e.g. `TOKEN = Read-Host`, `api_key: $env:KEY`).
  [/((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret|password|passwd)["']?\s*[:=：]\s*["']?)([^\s"'`,;{}<>()]{6,})/gi,
    (m, k, v) => (/^[$%@&|]|^(?:true|false|null|none|undefined|required|optional|string|read-host|get-content|getenv)$/i.test(v) || !(/\d/.test(v) || v.length >= 16) ? m : k + '[REDACTED]')],
];

export function redact(s) {
  let t = String(s);
  for (const [re, rep] of REDACT_RULES) t = t.replace(re, rep);
  return t;
}

// JSONL parser tolerant to a truncated tail and to two records glued on one line.
export function* parseJsonl(text) {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      const parts = line.split(/(?<=\})(?=\{")/);
      if (parts.length < 2) continue;
      for (const p of parts) {
        try { yield JSON.parse(p); } catch { /* drop fragment */ }
      }
    }
  }
}

export function textOfParts(parts) {
  if (parts == null) return '';
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return typeof parts.text === 'string' ? parts.text : '';
  const out = [];
  for (const p of parts) {
    if (p == null) continue;
    if (typeof p === 'string') out.push(p);
    else if (typeof p.text === 'string') out.push(p.text);
    else if (p.type === 'image' || p.type === 'input_image' || p.type === 'image_url') out.push('[图片]');
    else if (p.type === 'encrypted_content') out.push('[加密内容]');
  }
  return out.join('\n');
}
